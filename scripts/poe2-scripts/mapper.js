/**
 * Mapper Plugin - Automated Map Running
 *
 * State machine that walks to Temple (Vaal Beacon), clears it,
 * then walks to and kills the map boss.
 *
 * Relies on:
 * - entity_actions.js for auto-attack
 * - pickit.js for auto-loot
 * - opener.js for auto-chest/shrine
 * - movement.js for movement packets
 * - poe2.findPath() for A* pathfinding
 * - poe2.getTgtLocations() for Temple/Boss TGT positions
 *
 * PERFORMANCE OPTIMIZED: Uses shared POE2Cache for per-frame caching
 * NOTE: Do NOT call POE2Cache.beginFrame() here - it's called once in main.js
 */

import { POE2Cache, poe2 } from './poe2_cache.js';
import { Settings } from './Settings.js';
import { sendMoveRaw, moveAngle, stopMovement } from './movement.js';

// Boss scan timer - expensive non-lightweight query, done infrequently
let lastBossScanTime = 0;
const BOSS_SCAN_INTERVAL_MS = 1000; // only scan for boss stats every 1 second

// ============================================================================
// CONSTANTS
// ============================================================================

const PLUGIN_NAME = 'mapper';

// State machine states
const STATE = {
  IDLE: 'IDLE',
  FINDING_TEMPLE: 'FINDING_TEMPLE',
  WALKING_TO_TEMPLE: 'WALKING_TO_TEMPLE',
  CLEARING_TEMPLE: 'CLEARING_TEMPLE',
  FINDING_BOSS: 'FINDING_BOSS',
  WALKING_TO_BOSS: 'WALKING_TO_BOSS',
  FIGHTING_BOSS: 'FIGHTING_BOSS',
  MAP_COMPLETE: 'MAP_COMPLETE',
};

// Stat IDs from game_stats.json for map boss identification
const STAT_MAP_BOSS_DIFFICULTY_SCALING = 7682;  // monster_uses_map_boss_difficulty_scaling
const STAT_MAP_BOSS_UNDERLING = 11156;          // is_map_boss_underling_monster

// Grid-to-world conversion ratio
const GRID_TO_WORLD = 250.0 / 23.0; // ~10.87

// TGT patterns for temple (Vaal Beacon)
const TEMPLE_TGT_PATTERN = 'waygatedevice';

// TGT patterns for boss beacons (case-insensitive partial match on TGT name)
// These are from important_tgts.h kAreaPathTargets - ONLY specific patterns
// DO NOT add broad patterns like 'arena' or 'boss' - they match too many TGTs
const BOSS_TGT_PATTERNS = [
  'pinnacle',          // MapAlpineRidge
  'beacon_',           // MapBluff (NOT "waygatedevice" beacon)
  'tower_beacon',      // MapLostTowers, MapSwampTower
  'pillararena',       // MapLostTowers
  'peak',              // MapMesa
  'arenatransition',   // Generic boss stronghold (Azmeri)
];

// Default settings
const DEFAULT_SETTINGS = {
  enabled: false,
  hotkey: ImGui.Key.F7,
  hotkeyCtrl: false,
  hotkeyShift: false,
  hotkeyAlt: false,
  // Path walker
  moveIntervalMs: 200,        // ms between movement packets
  repathIntervalMs: 3000,     // ms between re-pathing
  waypointThreshold: 8,       // grid units to consider waypoint reached
  arrivalThreshold: 20,       // grid units to consider target reached
  stuckTimeoutMs: 3000,       // ms before stuck detection triggers
  stuckMoveDistance: 50,      // random move distance when stuck
  maxMoveDistance: 400,       // max distance per movement packet
  // Temple clearing
  templeClearRadius: 60,      // grid units to check for hostiles around temple
  templeClearTimeMs: 3000,    // ms with no hostiles = temple cleared
  // Boss
  bossSearchRadius: 60,       // grid units around boss TGT to look for boss
  bossFightRadius: 80,        // grid units to consider "near boss" for fighting
};

// ============================================================================
// STATE
// ============================================================================

let currentSettings = { ...DEFAULT_SETTINGS };
let currentPlayerName = null;
let settingsLoaded = false;

// ImGui MutableVariables
const enabled = new ImGui.MutableVariable(DEFAULT_SETTINGS.enabled);

// State machine
let currentState = STATE.IDLE;
let stateStartTime = 0;
let statusMessage = '';

// Path walker state
let currentPath = [];           // Array of {x, y} grid waypoints
let currentWaypointIndex = 0;
let lastMoveTime = 0;
let lastRepathTime = 0;
let lastEntityScanTime = 0;
let lastBossTgtSearchTime = 0; // Cooldown for expensive findBossTgt() calls
let lastBossEntityScanTime = 0; // Cooldown for entity scans in FINDING_BOSS
let lastPlayerGridX = 0;
let lastPlayerGridY = 0;
let lastPositionChangeTime = 0;
let stuckCount = 0;

// Target state
let targetGridX = 0;
let targetGridY = 0;
let targetName = '';
let targetPathType = '';  // 'temple' or 'boss' - used to match radar paths by name

// Temple state
let templeGridX = 0;
let templeGridY = 0;
let templeFound = false;
let templeClearStartTime = 0;    // time when area first appeared clear
let templeCleared = false;
let templeStuckTime = 0;         // when we started being stuck walking to temple
let usingBossFallback = false;   // true = walking toward boss to find path to temple

// Boss state
let bossGridX = 0;
let bossGridY = 0;
let bossTgtFound = false;
let bossEntityId = 0;
let bossFound = false;
let bossDead = false;
let checkpointReached = false;  // true = we've arrived at boss checkpoint, stop re-scanning for it
let abandonedBossTargets = [];  // grid positions we've abandoned (unreachable), skip them next time

// Area tracking
let lastAreaChangeCount = 0;

// Debug / stats
let debugLog = [];
let pathComputeCount = 0;
let lastMoveDebug = null; // stores last movement computation details

// ============================================================================
// SETTINGS
// ============================================================================

/** Check if a grid position was previously abandoned as unreachable */
function isAbandonedTarget(x, y) {
  for (const t of abandonedBossTargets) {
    const dx = x - t.x;
    const dy = y - t.y;
    if (dx * dx + dy * dy < 50 * 50) return true; // within 50 units = same target
  }
  return false;
}

function loadPlayerSettings() {
  const player = POE2Cache.getLocalPlayer();
  if (!player || !player.playerName) return false;

  if (currentPlayerName !== player.playerName) {
    currentPlayerName = player.playerName;
    currentSettings = Settings.get(PLUGIN_NAME, DEFAULT_SETTINGS);
    enabled.value = currentSettings.enabled;
    console.log(`[Mapper] Loaded settings for player: ${player.playerName}`);
    settingsLoaded = true;
    return true;
  }
  return false;
}

function saveSetting(key, value) {
  currentSettings[key] = value;
  Settings.set(PLUGIN_NAME, key, value);
}

// ============================================================================
// DEBUG LOGGING
// ============================================================================

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  const entry = `[${ts}] ${msg}`;
  debugLog.push(entry);
  if (debugLog.length > 50) debugLog.shift();
  console.log(`[Mapper] ${msg}`);
}

// ============================================================================
// PATH WALKER
// ============================================================================

/**
 * Compute a path from player to target grid position.
 * Strategy:
 * 1) Try A* full path (generous iterations)
 * 2) If that fails, try A* to walkable intermediate points in MULTIPLE directions
 * 3) If all A* fails, direct movement is used as last resort
 */
/**
 * Get all radar paths (cached briefly to avoid calling C++ every tick).
 */
let radarPathsCache = null;
let radarPathsCacheTime = 0;
function getCachedRadarPaths() {
  const now = Date.now();
  if (radarPathsCache && now - radarPathsCacheTime < 500) return radarPathsCache;
  try {
    radarPathsCache = poe2.getRadarPaths();
    radarPathsCacheTime = now;
  } catch (err) {
    radarPathsCache = null;
  }
  return radarPathsCache;
}

/**
 * Try to get the radar's pre-computed path to a target.
 * Matching strategy:
 *   1) Match by NAME if pathType is given ('temple' -> "Temple", 'boss' -> "Boss Beacon")
 *   2) Match by coordinates (closest radar target within 50 grid units)
 * 
 * The radar draws yellow/red lines using BFS-based pathfinding that ALWAYS works.
 * Returns { path: [{x,y}...], targetX, targetY } or null.
 */
function getRadarPathTo(targetGX, targetGY, pathType) {
  const radarPaths = getCachedRadarPaths();
  if (!radarPaths || radarPaths.length === 0) return null;

  // --- Match by NAME first (most reliable when target type is known) ---
  if (pathType) {
    const namePatterns = {
      'temple': ['temple'],
      'boss': ['boss beacon', 'boss'],
    };
    const patterns = namePatterns[pathType] || [];
    for (const pattern of patterns) {
      for (const rp of radarPaths) {
        if (!rp.valid || !rp.path || rp.path.length < 2) continue;
        if (rp.name && rp.name.toLowerCase().includes(pattern)) {
          return { path: rp.path, targetX: rp.targetX, targetY: rp.targetY };
        }
      }
    }
  }

  // --- Fallback: match by coordinates (closest target within 50 grid units) ---
  let bestResult = null;
  let bestDist = Infinity;

  for (const rp of radarPaths) {
    if (!rp.valid || !rp.path || rp.path.length < 2) continue;
    const dx = rp.targetX - targetGX;
    const dy = rp.targetY - targetGY;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestDist) {
      bestDist = d;
      bestResult = { path: rp.path, targetX: rp.targetX, targetY: rp.targetY };
    }
  }

  if (bestResult && bestDist < 50) {
    return bestResult;
  }
  return null;
}

/**
 * Get the radar's "Boss Beacon" target coordinates.
 * Returns {x, y} or null. This uses the RADAR's computed boss location
 * which is often better than our own TGT-based finding.
 */
function getRadarBossTarget() {
  const radarPaths = getCachedRadarPaths();
  if (!radarPaths || radarPaths.length === 0) return null;

  for (const rp of radarPaths) {
    if (!rp.valid) continue;
    const name = (rp.name || '').toLowerCase();
    if (name.includes('boss')) {
      return { x: rp.targetX, y: rp.targetY };
    }
  }
  return null;
}

function computePath(playerGX, playerGY, targetGX, targetGY) {
  // ALWAYS update repath timer to prevent calling findPath every frame
  lastRepathTime = Date.now();

  const fromX = Math.floor(playerGX);
  const fromY = Math.floor(playerGY);
  let toX = Math.floor(targetGX);
  let toY = Math.floor(targetGY);

  const totalDist = Math.sqrt((toX - fromX) ** 2 + (toY - fromY) ** 2);

  // =====================================================================
  // 1) TRY RADAR PATH - match by NAME first, then by coordinates
  //    The radar draws yellow/red lines using BFS pathfinding that ALWAYS works.
  //    Using the radar path means we follow the exact same line drawn on screen.
  // =====================================================================
  const radarResult = getRadarPathTo(toX, toY, targetPathType);
  if (radarResult && radarResult.path && radarResult.path.length >= 2) {
    const radarPath = radarResult.path;

    // If the radar's target is different from ours, UPDATE our target
    // This fixes the case where mapper picked wrong TGT but radar knows correct boss location
    if (Math.abs(radarResult.targetX - toX) > 30 || Math.abs(radarResult.targetY - toY) > 30) {
      log(`Radar target override: (${toX},${toY}) -> (${radarResult.targetX},${radarResult.targetY})`);
      toX = Math.floor(radarResult.targetX);
      toY = Math.floor(radarResult.targetY);
      targetGridX = radarResult.targetX;
      targetGridY = radarResult.targetY;
    }

    // Filter out any undefined/null entries (sparse array from C++ downsampling)
    const validPath = radarPath.filter(p => p && p.x !== undefined && p.y !== undefined);
    if (validPath.length >= 2) {
      // Find the waypoint closest to the player (start from there)
      let startIdx = 0;
      let minPlayerDist = Infinity;
      for (let i = 0; i < validPath.length; i++) {
        const dx = validPath[i].x - fromX;
        const dy = validPath[i].y - fromY;
        const d = dx * dx + dy * dy;
        if (d < minPlayerDist) {
          minPlayerDist = d;
          startIdx = i;
        }
      }

      // Use the path from the closest point onward
      const trimmed = validPath.slice(startIdx);
      if (trimmed.length >= 2) {
        currentPath = trimmed;
        currentWaypointIndex = 0;
        pathComputeCount++;
        log(`Radar path (${targetPathType || 'coord'}): ${trimmed.length} wp (from idx ${startIdx}/${validPath.length})`);
        return true;
      }
    }
  }

  // =====================================================================
  // 2) BFS PATH - same pathfinder as the radar, but for ANY target
  //    Uses the radar's pre-built walkable grid + BFS distance field.
  //    Distance field is built once per target and cached, so subsequent
  //    calls for the same target are O(path_length). Works for ANY distance.
  // =====================================================================
  try {
    const path = poe2.findPathBFS(fromX, fromY, toX, toY);
    if (path && path.length > 0) {
      currentPath = path;
      currentWaypointIndex = 0;
      pathComputeCount++;
      log(`BFS path: ${path.length} wp`);
      return true;
    }
  } catch (err) {
    // findPathBFS not available yet (needs C++ rebuild) - fall back to A*
    log(`BFS not available: ${err}`);
  }

  // =====================================================================
  // 3) A* fallback (only used if BFS not available / pre-rebuild)
  // =====================================================================
  const fullIters = Math.min(200000, Math.max(80000, Math.floor(totalDist * 300)));
  try {
    const path = poe2.findPath(fromX, fromY, toX, toY, fullIters);
    if (path && path.length > 0) {
      currentPath = path;
      currentWaypointIndex = 0;
      pathComputeCount++;
      log(`A* path: ${path.length} wp`);
      return true;
    }
  } catch (err) {
    log(`A* error: ${err}`);
  }

  log(`No path found. dist=${totalDist.toFixed(0)}`);
  currentPath = [];
  currentWaypointIndex = 0;
  return false;
}

/**
 * Move toward a grid position by sending a raw movement packet.
 * Uses isometric formula from entity_actions.js / movement.js.
 * Simple direct movement - pathfinding handles obstacle avoidance via waypoints.
 */
function moveTowardGridPos(playerGX, playerGY, targetGX, targetGY) {
  const gridDX = targetGX - playerGX;
  const gridDY = targetGY - playerGY;
  const gridDist = Math.sqrt(gridDX * gridDX + gridDY * gridDY);

  if (gridDist < 1) return false;

  // Convert grid delta to screen using entity_actions.js isometric formula
  const screenX = gridDX - gridDY;
  const screenY = (gridDX + gridDY) / 2;
  const screenAngleDeg = Math.atan2(screenY, screenX) * 180 / Math.PI;

  // Calculate move distance (in world/packet units)
  const worldDist = gridDist * GRID_TO_WORLD;
  const moveDist = Math.min(currentSettings.maxMoveDistance, worldDist);

  // Store debug info
  lastMoveDebug = {
    gridDX: gridDX.toFixed(1),
    gridDY: gridDY.toFixed(1),
    angle: screenAngleDeg.toFixed(1),
    dist: moveDist.toFixed(0),
    nav: 'direct',
  };

  return moveAngle(screenAngleDeg, Math.round(moveDist));
}

/**
 * Step the path walker forward one tick.
 * Returns: 'walking' | 'arrived' | 'no_path' | 'stuck'
 */
function stepPathWalker() {
  const now = Date.now();
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) return 'no_path';

  const pgx = player.gridX;
  const pgy = player.gridY;

  // Check if position changed (stuck detection)
  const posDelta = Math.sqrt(
    (pgx - lastPlayerGridX) ** 2 + (pgy - lastPlayerGridY) ** 2
  );
  if (posDelta > 2) {
    lastPlayerGridX = pgx;
    lastPlayerGridY = pgy;
    lastPositionChangeTime = now;
    stuckCount = 0;
  }

  // Stuck detection
  if (now - lastPositionChangeTime > currentSettings.stuckTimeoutMs && lastPositionChangeTime > 0) {
    stuckCount++;
    lastPositionChangeTime = now; // reset timer

    if (stuckCount > 5) {
      log('Stuck too many times, giving up on current path');
      currentPath = [];
      return 'stuck';
    }

    // Try BFS re-path first (smarter than random move)
    let rerouted = false;
    try {
      const bfsPath = poe2.findPathBFS(Math.floor(pgx), Math.floor(pgy), Math.floor(targetGridX), Math.floor(targetGridY));
      if (bfsPath && bfsPath.length > 0) {
        currentPath = bfsPath;
        currentWaypointIndex = 0;
        pathComputeCount++;
        lastRepathTime = now;
        rerouted = true;
        log(`Stuck! BFS re-route: ${bfsPath.length} wp`);
      }
    } catch (e) { /* BFS unavailable */ }

    if (!rerouted) {
      // BFS failed too - try random move to break free
      const randomAngle = Math.random() * 360;
      moveAngle(randomAngle, currentSettings.stuckMoveDistance);
      log(`Stuck! Random move at angle ${randomAngle.toFixed(0)}`);
      currentPath = [];
      lastRepathTime = 0; // force immediate repath next tick
    }

    return 'walking';
  }

  // Check arrival at final target
  const distToTarget = Math.sqrt(
    (pgx - targetGridX) ** 2 + (pgy - targetGridY) ** 2
  );
  if (distToTarget < currentSettings.arrivalThreshold) {
    stopMovement();
    return 'arrived';
  }

  // Re-path periodically
  // Short paths (baby steps/BFS) need FAST recompute to chain segments
  // Long full paths can wait longer
  let repathInterval = currentSettings.repathIntervalMs; // default 3s
  if (currentPath.length === 0) {
    repathInterval = 800; // no path at all: retry quickly
  } else if (currentPath.length <= 3) {
    repathInterval = 1000; // greedy BFS / very short baby step: chain fast
  } else if (currentPath.length > 50) {
    repathInterval = 5000; // full path found: don't re-compute often
  }

  if (now - lastRepathTime > repathInterval) {
    computePath(pgx, pgy, targetGridX, targetGridY);
  }

  // If we have a path, follow waypoints
  if (currentPath.length > 0) {
    // Advance through waypoints that we've already passed
    while (currentWaypointIndex < currentPath.length) {
      const wp = currentPath[currentWaypointIndex];
      const distToWp = Math.sqrt((pgx - wp.x) ** 2 + (pgy - wp.y) ** 2);

      if (distToWp < currentSettings.waypointThreshold) {
        currentWaypointIndex++;
      } else {
        break;
      }
    }

    // If we've passed all waypoints, clear path and immediately repath
    if (currentWaypointIndex >= currentPath.length) {
      currentPath = [];
      lastRepathTime = 0; // force immediate repath next tick
      return 'walking';
    }

    // Move toward current waypoint (rate-limited)
    if (now - lastMoveTime >= currentSettings.moveIntervalMs) {
      const wp = currentPath[currentWaypointIndex];
      moveTowardGridPos(pgx, pgy, wp.x, wp.y);
      lastMoveTime = now;
    }
  } else {
    // No path available - use direct movement toward target (rate-limited)
    // This is the last resort fallback
    if (now - lastMoveTime >= currentSettings.moveIntervalMs) {
      moveTowardGridPos(pgx, pgy, targetGridX, targetGridY);
      lastMoveTime = now;
    }
  }

  return 'walking';
}

/**
 * Start walking to a grid position.
 */
function startWalkingTo(gx, gy, name, pathType) {
  targetGridX = gx;
  targetGridY = gy;
  targetName = name;
  targetPathType = pathType || '';  // 'temple' or 'boss'
  currentPath = [];
  currentWaypointIndex = 0;
  lastRepathTime = 0;
  lastPositionChangeTime = Date.now();
  stuckCount = 0;
  log(`Walking to ${name} at (${gx.toFixed(0)}, ${gy.toFixed(0)}) [pathType=${pathType || 'none'}]`);
}

// ============================================================================
// TGT LOCATION HELPERS
// ============================================================================

/**
 * Find temple (WaygateDevice) TGT location.
 * Returns {x, y} grid position or null.
 */
function findTempleTgt() {
  const tgt = poe2.getTgtLocations();
  if (!tgt || !tgt.isValid) return null;

  const allLocations = [];

  for (const [name, positions] of Object.entries(tgt.locations)) {
    if (name.toLowerCase().includes(TEMPLE_TGT_PATTERN)) {
      for (const pos of positions) {
        allLocations.push({ x: pos.x + 11.5, y: pos.y + 11.5 });
      }
    }
  }

  if (allLocations.length === 0) return null;

  // Cluster nearby locations (same as radar: within 100 grid units)
  const clustered = clusterPositions(allLocations, 100);
  return clustered[0] || null;
}

/**
 * Find boss beacon TGT location for current area.
 * Strategy:
 * 1) Match known boss TGT patterns
 * 2) If no match, find the farthest TGT from the temple (boss is usually at map's end)
 * 3) Log all TGT names for debugging
 * Returns {x, y} grid position or null.
 */
function findBossTgt() {
  const tgt = poe2.getTgtLocations();
  if (!tgt || !tgt.isValid) return null;

  const allBossLocations = [];
  const allTgtNames = [];
  const allNonTempleLocations = []; // all TGTs that aren't temple, for fallback

  for (const [name, positions] of Object.entries(tgt.locations)) {
    const nameLower = name.toLowerCase();

    // Extract short name for logging (just the filename part)
    const shortName = name.split('/').pop() || name;
    allTgtNames.push(shortName);

    // Skip temple TGTs
    if (nameLower.includes(TEMPLE_TGT_PATTERN)) continue;

    // Collect all non-temple locations for fallback
    for (const pos of positions) {
      allNonTempleLocations.push({ x: pos.x + 11.5, y: pos.y + 11.5, name: shortName });
    }

    // Check against known boss patterns
    for (const pattern of BOSS_TGT_PATTERNS) {
      if (nameLower.includes(pattern)) {
        for (const pos of positions) {
          allBossLocations.push({ x: pos.x + 11.5, y: pos.y + 11.5 });
        }
        break;
      }
    }
  }

  // 1) Found by pattern match
  if (allBossLocations.length > 0) {
    const clustered = clusterPositions(allBossLocations, 100);
    log(`Boss TGT found by pattern: ${allBossLocations.length} locations`);
    return clustered[0] || null;
  }

  // Log all TGT names for debugging when no pattern match
  if (allTgtNames.length > 0) {
    const unique = [...new Set(allTgtNames)];
    log(`No boss TGT pattern match. TGTs: ${unique.slice(0, 15).join(', ')}`);
  }

  // 2) Fallback: look for TGTs with meaningful names (arena, boss, checkpoint)
  //    These are likely boss areas even if not in our specific pattern list
  const MEANINGFUL_PATTERNS = ['arena', 'boss', 'checkpoint', 'endgame', 'bossroom', 'bossarena',
    'stronghold', 'lair', 'sanctum', 'throne'];
  // Terrain/architecture/environment junk to EXCLUDE
  const JUNK_PATTERNS = ['wall', 'roof', 'shadow', 'floor', 'ground', 'pillar', 'stair',
    'door', 'fence', 'bridge', 'ramp', 'ledge', 'cliff', 'rock', 'tree', 'bush',
    'torch', 'lamp', 'banner', 'chain', 'gate', 'column', 'rail', 'crack',
    'rubble', 'debris', 'vase', 'pot', 'barrel', 'crate', 'plank', 'beam',
    'tile', 'brick', 'cobble', 'grate', 'pipe', 'vent', 'mine', 'cart',
    // Environmental / visual effect junk
    'water', 'overlay', 'lava', 'fog', 'mist', 'smoke', 'fire', 'ember',
    'particle', 'effect', 'light', 'glow', 'decal', 'splat', 'puddle',
    'snow', 'rain', 'wind', 'cloud', 'sky', 'ambient', 'sound', 'audio',
    'fill', 'spline', 'terrain', 'doodad', 'prop', 'clutter', 'foliage',
    'grass', 'vine', 'moss', 'coral', 'fungus', 'mushroom', 'crystal',
    'spawn', 'trigger', 'volume', 'blocker', 'navmesh', 'collision',
    'camera', 'cutscene', 'cinematic',
    // League-specific junk (not the map boss)
    'delirium', 'precursor', 'ritual', 'expedition', 'harvest', 'breach',
    'abyss', 'legion', 'blight', 'essence', 'shrine', 'strongbox'];

  if (allNonTempleLocations.length > 0) {
    const player = POE2Cache.getLocalPlayer();
    const refX = templeFound ? templeGridX : (player ? player.gridX : 0);
    const refY = templeFound ? templeGridY : (player ? player.gridY : 0);

    // First try: find arena/boss-like TGTs (farthest from temple)
    let bestMeaningful = null;
    let bestMeaningfulDistSq = 0;

    for (const loc of allNonTempleLocations) {
      const nameLower = loc.name.toLowerCase();
      const isMeaningful = MEANINGFUL_PATTERNS.some(p => nameLower.includes(p));
      if (!isMeaningful) continue;

      const dx = loc.x - refX;
      const dy = loc.y - refY;
      const distSq = dx * dx + dy * dy;
      if (distSq > bestMeaningfulDistSq) {
        bestMeaningfulDistSq = distSq;
        bestMeaningful = loc;
      }
    }

    if (bestMeaningful && bestMeaningfulDistSq > 50 * 50 && !isAbandonedTarget(bestMeaningful.x, bestMeaningful.y)) {
      // Verify the position is walkable (BFS can reach it)
      const mfx = Math.floor(bestMeaningful.x);
      const mfy = Math.floor(bestMeaningful.y);
      try {
        const testPath = poe2.findPathBFS(Math.floor(refX), Math.floor(refY), mfx, mfy);
        if (testPath && testPath.length > 0) {
          log(`Boss TGT (meaningful): "${bestMeaningful.name}" at dist=${Math.sqrt(bestMeaningfulDistSq).toFixed(0)}, path=${testPath.length}wp`);
          return { x: bestMeaningful.x, y: bestMeaningful.y };
        } else {
          log(`Boss TGT (meaningful) "${bestMeaningful.name}" is UNREACHABLE, skipping`);
        }
      } catch (e) {
        // BFS not available, accept it anyway
        log(`Boss TGT (meaningful): "${bestMeaningful.name}" at dist=${Math.sqrt(bestMeaningfulDistSq).toFixed(0)} (no BFS check)`);
        return { x: bestMeaningful.x, y: bestMeaningful.y };
      }
    }

    // Second try: farthest non-junk TGT from temple
    // Sort by distance (farthest first) so we can try multiple candidates
    const candidates = [];

    for (const loc of allNonTempleLocations) {
      const nameLower = loc.name.toLowerCase();
      const isJunk = JUNK_PATTERNS.some(p => nameLower.includes(p));
      if (isJunk) continue;
      if (isAbandonedTarget(loc.x, loc.y)) continue; // skip previously failed targets

      const dx = loc.x - refX;
      const dy = loc.y - refY;
      const distSq = dx * dx + dy * dy;
      if (distSq > 100 * 100) {
        candidates.push({ loc, distSq });
      }
    }

    // Sort farthest first, try up to 5 candidates
    candidates.sort((a, b) => b.distSq - a.distSq);
    const tryCount = Math.min(candidates.length, 5);
    let unreachableCount = 0;
    for (let i = 0; i < tryCount; i++) {
      const { loc, distSq } = candidates[i];
      const fx = Math.floor(loc.x);
      const fy = Math.floor(loc.y);
      try {
        const testPath = poe2.findPathBFS(Math.floor(refX), Math.floor(refY), fx, fy);
        if (testPath && testPath.length > 0) {
          log(`Boss TGT fallback: "${loc.name}" at dist=${Math.sqrt(distSq).toFixed(0)}, path=${testPath.length}wp`);
          return { x: loc.x, y: loc.y };
        } else {
          unreachableCount++;
        }
      } catch (e) {
        // BFS not available, accept it anyway
        log(`Boss TGT fallback: "${loc.name}" at dist=${Math.sqrt(distSq).toFixed(0)} (no BFS check)`);
        return { x: loc.x, y: loc.y };
      }
    }

    if (unreachableCount > 0) {
      log(`Tried ${tryCount}/${candidates.length} TGT candidates, all unreachable. Will retry in 15s.`);
    }
  }

  return null;
}

/**
 * Cluster nearby positions (greedy, same algorithm as radar).
 */
function clusterPositions(positions, radius) {
  const radiusSq = radius * radius;
  const clustered = [];

  for (const pos of positions) {
    let merged = false;
    for (let i = 0; i < clustered.length; i++) {
      const cdx = pos.x - clustered[i].x;
      const cdy = pos.y - clustered[i].y;
      if (cdx * cdx + cdy * cdy < radiusSq) {
        clustered[i].x = (clustered[i].x + pos.x) / 2;
        clustered[i].y = (clustered[i].y + pos.y) / 2;
        merged = true;
        break;
      }
    }
    if (!merged) {
      clustered.push({ x: pos.x, y: pos.y });
    }
  }

  return clustered;
}

// ============================================================================
// ENTITY HELPERS
// ============================================================================

/**
 * Check if an entity has a specific stat key in statsFromItems or statsFromBuffs.
 */
function entityHasStat(entity, statKey) {
  if (entity.statsFromItems) {
    for (const s of entity.statsFromItems) {
      if (s.key === statKey) return true;
    }
  }
  if (entity.statsFromBuffs) {
    for (const s of entity.statsFromBuffs) {
      if (s.key === statKey) return true;
    }
  }
  return false;
}

/**
 * Check if entity is a valid hostile target (not friendly, not hidden, alive).
 */
function isHostileAlive(entity) {
  if (!entity || !entity.isAlive) return false;
  if (entity.entitySubtype === 'MonsterFriendly') return false;
  if (entity.isHiddenMonster) return false;
  if (entity.cannotBeDamaged) return false;
  if (entity.hiddenFromPlayer) return false;
  if (entity.hasGroundEffect) return false;
  return true;
}

/**
 * Find the map boss entity from a list of entities.
 * Uses stat 7682 (monster_uses_map_boss_difficulty_scaling) for definitive ID.
 * Falls back to MonsterUnique near boss TGT.
 */
function findMapBoss(entities) {
  let bestCandidate = null;
  let bestScore = -1;

  for (const entity of entities) {
    if (!isHostileAlive(entity)) continue;
    if (entity.entityType !== 'Monster') continue;

    let score = 0;

    // Definitive: has map boss stat
    if (entityHasStat(entity, STAT_MAP_BOSS_DIFFICULTY_SCALING)) {
      score += 100;
    }

    // Strong signal: MonsterUnique subtype
    if (entity.entitySubtype === 'MonsterUnique') {
      score += 10;
    }

    // Signal: path contains MapBoss
    if (entity.name && entity.name.includes('MapBoss')) {
      score += 20;
    }

    // Signal: path contains Boss (but not just any "Boss" prefix)
    if (entity.name && entity.name.includes('/Boss')) {
      score += 5;
    }

    // Proximity to boss TGT
    if (bossTgtFound && entity.gridX !== undefined) {
      const dist = Math.sqrt(
        (entity.gridX - bossGridX) ** 2 + (entity.gridY - bossGridY) ** 2
      );
      if (dist < currentSettings.bossSearchRadius) {
        score += 15;
      }
    }

    // Skip if no signal at all
    if (score === 0) continue;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = entity;
    }
  }

  return bestCandidate;
}

/**
 * Count alive hostile monsters near a position.
 */
function countHostilesNear(entities, gx, gy, radius) {
  let count = 0;
  const radiusSq = radius * radius;

  for (const entity of entities) {
    if (!isHostileAlive(entity)) continue;
    if (entity.entityType !== 'Monster') continue;
    if (!entity.gridX) continue;

    const dx = entity.gridX - gx;
    const dy = entity.gridY - gy;
    if (dx * dx + dy * dy < radiusSq) {
      count++;
    }
  }

  return count;
}

/**
 * Find the nearest alive hostile monster to a position.
 * Returns { gridX, gridY, dist } or null.
 */
function findNearestHostile(entities, gx, gy, maxRadius) {
  let nearest = null;
  let nearestDistSq = maxRadius * maxRadius;

  for (const entity of entities) {
    if (!isHostileAlive(entity)) continue;
    if (entity.entityType !== 'Monster') continue;
    if (!entity.gridX) continue;

    const dx = entity.gridX - gx;
    const dy = entity.gridY - gy;
    const distSq = dx * dx + dy * dy;
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq;
      nearest = { gridX: entity.gridX, gridY: entity.gridY, dist: Math.sqrt(distSq) };
    }
  }

  return nearest;
}

// ============================================================================
// STATE MACHINE
// ============================================================================

function setState(newState) {
  if (currentState === newState) return;
  log(`State: ${currentState} -> ${newState}`);
  currentState = newState;
  stateStartTime = Date.now();
}

function resetMapper() {
  currentState = STATE.IDLE;
  stateStartTime = Date.now();
  currentPath = [];
  currentWaypointIndex = 0;
  templeFound = false;
  templeCleared = false;
  templeClearStartTime = 0;
  templeStuckTime = 0;
  usingBossFallback = false;
  bossTgtFound = false;
  bossFound = false;
  bossDead = false;
  checkpointReached = false;
  bossEntityId = 0;
  statusMessage = 'Idle';
  stuckCount = 0;
  lastBossScanTime = 0;
  lastBossTgtSearchTime = 0;
  lastBossEntityScanTime = 0;
  abandonedBossTargets = [];
}

function processMapper() {
  if (!enabled.value) {
    if (currentState !== STATE.IDLE) {
      resetMapper();
    }
    return;
  }

  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) return;

  // Detect area change -> reset
  const areaChangeCount = POE2Cache.getAreaChangeCount();
  if (areaChangeCount !== lastAreaChangeCount) {
    lastAreaChangeCount = areaChangeCount;
    if (currentState !== STATE.IDLE) {
      log('Area changed, resetting mapper');
      resetMapper();
    }
  }

  const now = Date.now();

  // =====================================================================
  // MOVEMENT LOCK: Yield to opener/pickit when they need to interact.
  // The game auto-walks to pick up items / open chests. We must NOT
  // send our own movement commands during that time or we'll fight it.
  // =====================================================================
  const moveLock = POE2Cache.isMovementLocked();
  if (moveLock.locked) {
    statusMessage = `Yielding to ${moveLock.source}... (${(moveLock.remainingMs / 1000).toFixed(1)}s)`;
    // Reset stuck detection so we don't think we're stuck during the yield
    lastPositionChangeTime = now;
    return; // Skip ALL movement logic this frame
  }

  switch (currentState) {
    case STATE.IDLE:
      // Start the mapping sequence
      setState(STATE.FINDING_TEMPLE);
      break;

    case STATE.FINDING_TEMPLE: {
      const templeLoc = findTempleTgt();
      if (templeLoc) {
        templeGridX = templeLoc.x;
        templeGridY = templeLoc.y;
        templeFound = true;
        templeCleared = false;
        templeClearStartTime = 0;
        log(`Temple found at (${templeGridX.toFixed(0)}, ${templeGridY.toFixed(0)})`);

        // Quick check: is the temple already cleared? (e.g. script restart mid-map)
        let alreadyClear = false;

        // Check 1: Look for opened Vaal Chest (LeagueIncursion/EncounterChest)
        // If the Vaal Chest exists and is opened, the beacon is definitely done
        if (!alreadyClear) {
          const vaalChests = poe2.getEntities({
            nameContains: 'LeagueIncursion/EncounterChest',
            lightweight: true,
          });
          if (vaalChests && vaalChests.length > 0) {
            // Check if any of them are opened (chest component sets isAlive=false when opened)
            for (const chest of vaalChests) {
              // Opened chests have isAlive === false
              if (!chest.isAlive) {
                alreadyClear = true;
                log(`Vaal Chest already opened, beacon is cleared - skipping to boss`);
                break;
              }
            }
          }
        }

        // Check 2: Beacon buff on player
        if (!alreadyClear) {
          const lp = POE2Cache.getLocalPlayer();
          if (lp && lp.buffs) {
            for (const buff of lp.buffs) {
              if (!buff.name) continue;
              const bn = buff.name.toLowerCase();
              if (bn.includes('beacon') || bn.includes('energi') || bn.includes('waygate_activated') ||
                  bn.includes('vaal_beacon') || bn.includes('map_beacon') || bn.includes('incursion_complete')) {
                alreadyClear = true;
                log(`Beacon already active (buff: "${buff.name}"), skipping to boss`);
                break;
              }
            }
          }
        }

        // Check 3: If no hostiles near the temple at all, it's probably already done
        if (!alreadyClear) {
          const nearbyMonsters = POE2Cache.getEntities({
            type: 'Monster',
            aliveOnly: true,
            lightweight: true,
            maxDistance: currentSettings.templeClearRadius * 2
          });
          const hostiles = countHostilesNear(nearbyMonsters, templeGridX, templeGridY, currentSettings.templeClearRadius * 2);
          const distToTemple = Math.sqrt(
            (player.gridX - templeGridX) ** 2 + (player.gridY - templeGridY) ** 2
          );
          if (distToTemple < currentSettings.templeClearRadius * 3 && hostiles === 0) {
            alreadyClear = true;
            log(`Temple area already clear (0 hostiles within range), skipping to boss`);
          }
        }

        if (alreadyClear) {
          templeCleared = true;
          setState(STATE.FINDING_BOSS);
        } else {
          startWalkingTo(templeGridX, templeGridY, 'Temple', 'temple');
          setState(STATE.WALKING_TO_TEMPLE);
        }
      } else {
        log('No temple in this area, skipping to boss');
        templeFound = false;
        setState(STATE.FINDING_BOSS);
      }
      break;
    }

    case STATE.WALKING_TO_TEMPLE: {
      const result = stepPathWalker();
      const distToTemple = Math.sqrt(
        (player.gridX - templeGridX) ** 2 + (player.gridY - templeGridY) ** 2
      );

      // If using boss fallback, check if we can now path to temple
      if (usingBossFallback) {
        statusMessage = `Routing to Temple via boss... ${distToTemple.toFixed(0)} to temple`;

        // Every 3 seconds, try to switch back to temple target
        if (now - lastEntityScanTime > 3000) {
          lastEntityScanTime = now;
          try {
            const testPath = poe2.findPath(
              Math.floor(player.gridX), Math.floor(player.gridY),
              Math.floor(templeGridX), Math.floor(templeGridY),
              150000
            );
            if (testPath && testPath.length > 0) {
              log(`Found path to temple! (${testPath.length} wp) Switching back`);
              usingBossFallback = false;
              templeStuckTime = 0;
              startWalkingTo(templeGridX, templeGridY, 'Temple', 'temple');
              break;
            }
          } catch (err) { /* still no path */ }
        }

        // If we somehow ended up very close to temple, just go directly
        if (distToTemple < 60) {
          log('Close enough to temple, switching back');
          usingBossFallback = false;
          templeStuckTime = 0;
          startWalkingTo(templeGridX, templeGridY, 'Temple', 'temple');
          break;
        }
      } else {
        statusMessage = `Walking to Temple... ${distToTemple.toFixed(0)} units`;
      }

      if (result === 'arrived') {
        if (usingBossFallback) {
          // Arrived at boss fallback point - try temple again
          log('Reached boss fallback point, retrying temple path');
          usingBossFallback = false;
          templeStuckTime = 0;
          startWalkingTo(templeGridX, templeGridY, 'Temple', 'temple');
        } else {
          log('Arrived at temple');
          templeStuckTime = 0;
          setState(STATE.CLEARING_TEMPLE);
        }
      } else if (result === 'stuck' || (result === 'walking' && currentPath.length === 0)) {
        // Track how long we've been stuck (no A* path)
        if (templeStuckTime === 0) {
          templeStuckTime = now;
        }

        const stuckDuration = now - templeStuckTime;

        // After 8 seconds stuck, try boss-direction fallback
        if (stuckDuration > 8000 && !usingBossFallback) {
          // Find a boss-direction target to walk toward
          let fallbackX = 0, fallbackY = 0;
          let hasFallback = false;

          // Try radar's boss target first (most reliable)
          const radarBoss = getRadarBossTarget();
          if (radarBoss) {
            fallbackX = radarBoss.x;
            fallbackY = radarBoss.y;
            hasFallback = true;
          }

          // Try checkpoint entity
          if (!hasFallback) {
            const checkpoints = poe2.getEntities({
              nameContains: 'Checkpoint_Endgame_Boss',
              lightweight: true,
            });
            if (checkpoints && checkpoints.length > 0) {
              fallbackX = checkpoints[0].gridX;
              fallbackY = checkpoints[0].gridY;
              hasFallback = true;
            }
          }

          // Try boss TGT
          if (!hasFallback) {
            const bossTgt = findBossTgt();
            if (bossTgt) {
              fallbackX = bossTgt.x;
              fallbackY = bossTgt.y;
              hasFallback = true;
            }
          }

          if (hasFallback) {
            // Walk toward a point BETWEEN current position and boss (not all the way to boss)
            // Use a point ~200 units toward boss direction to avoid overshooting temple
            const dxBoss = fallbackX - player.gridX;
            const dyBoss = fallbackY - player.gridY;
            const distBoss = Math.sqrt(dxBoss * dxBoss + dyBoss * dyBoss);
            const stepToward = Math.min(200, distBoss * 0.5);
            const intX = player.gridX + (dxBoss / distBoss) * stepToward;
            const intY = player.gridY + (dyBoss / distBoss) * stepToward;

            usingBossFallback = true;
            log(`Stuck ${(stuckDuration / 1000).toFixed(0)}s, fallback: walking toward boss (${stepToward.toFixed(0)} units)`);
            startWalkingTo(intX, intY, 'Boss Fallback', 'boss');
          } else {
            // No boss info available - try random exploration
            const angle = Math.random() * Math.PI * 2;
            const exploreX = player.gridX + Math.cos(angle) * 100;
            const exploreY = player.gridY + Math.sin(angle) * 100;
            log(`Stuck ${(stuckDuration / 1000).toFixed(0)}s, exploring randomly`);
            startWalkingTo(exploreX, exploreY, 'Explore', '');
            templeStuckTime = now; // reset to retry after exploration
          }
        }

        if (result === 'stuck' && !usingBossFallback) {
          startWalkingTo(templeGridX, templeGridY, 'Temple', 'temple');
        }
      } else if (result === 'walking' && currentPath.length > 0) {
        // Making progress - reset stuck timer
        templeStuckTime = 0;
      }
      break;
    }

    case STATE.CLEARING_TEMPLE: {
      // Active clearing: kill mobs, then WALK TO TEMPLE CENTER to activate beacon
      const clearScanRadius = currentSettings.templeClearRadius * 3; // ~180 grid units
      const monsters = POE2Cache.getEntities({
        type: 'Monster',
        aliveOnly: true,
        lightweight: true,
        maxDistance: clearScanRadius
      });

      const hostileCount = countHostilesNear(
        monsters, templeGridX, templeGridY, clearScanRadius
      );

      const timeInState = now - stateStartTime;

      // Distance from player to temple CENTER
      const distFromTemple = Math.sqrt(
        (player.gridX - templeGridX) ** 2 + (player.gridY - templeGridY) ** 2
      );

      // Check for beacon activation via multiple methods
      let beaconActivated = false;

      // Method 1: Check for opened Vaal Chest (most reliable)
      if (!beaconActivated) {
        const vaalChests = poe2.getEntities({
          nameContains: 'LeagueIncursion/EncounterChest',
          lightweight: true,
        });
        if (vaalChests && vaalChests.length > 0) {
          for (const chest of vaalChests) {
            if (!chest.isAlive) {
              beaconActivated = true;
              log(`Vaal Chest opened - beacon is cleared`);
              break;
            }
          }
        }
      }

      // Method 2: Check player buffs
      if (!beaconActivated) {
        const localPlayer = POE2Cache.getLocalPlayer();
        if (localPlayer && localPlayer.buffs) {
          for (const buff of localPlayer.buffs) {
            if (!buff.name) continue;
            const bn = buff.name.toLowerCase();
            if (bn.includes('beacon') || bn.includes('energi') || bn.includes('waygate_activated') ||
                bn.includes('vaal_beacon') || bn.includes('map_beacon') || bn.includes('incursion_complete')) {
              beaconActivated = true;
              log(`Beacon buff detected: "${buff.name}"`);
              break;
            }
          }
        }
      }

      statusMessage = `Clearing Beacon... ${hostileCount} hostiles, ${distFromTemple.toFixed(0)} from center (${(timeInState / 1000).toFixed(0)}s)${beaconActivated ? ' [ENERGISED]' : ''}`;

      // Beacon activated detection - move on immediately
      if (beaconActivated) {
        log('Beacon energised, moving to boss');
        templeCleared = true;
        setState(STATE.FINDING_BOSS);
        break;
      }

      // Safety timeout: if we've been clearing for 60+ seconds, move on
      if (timeInState > 60000) {
        log('Temple clear timeout (60s), moving to boss');
        templeCleared = true;
        setState(STATE.FINDING_BOSS);
        break;
      }

      if (hostileCount > 0) {
        // PHASE 1: Kill mobs - walk toward nearest hostile
        templeClearStartTime = 0; // Reset no-hostile timer

        const nearest = findNearestHostile(monsters, player.gridX, player.gridY, clearScanRadius);
        if (nearest && nearest.dist > 15) {
          if (now - lastMoveTime >= currentSettings.moveIntervalMs) {
            moveTowardGridPos(player.gridX, player.gridY, nearest.gridX, nearest.gridY);
            lastMoveTime = now;
          }
        }

        // If drifted too far from temple, walk back instead
        if (distFromTemple > clearScanRadius) {
          startWalkingTo(templeGridX, templeGridY, 'Temple (returning)', 'temple');
          stepPathWalker();
        }
      } else {
        // PHASE 2: No hostiles - WALK TO TEMPLE CENTER to activate beacon!
        // The beacon only activates when the player is physically at the center.
        // Do NOT skip to boss until we've actually gone to the center and
        // either detected the Vaal Chest opened or waited a reasonable time there.

        if (distFromTemple > 15) {
          // Not at center yet - walk there using BFS pathfinding
          const targetChanged = Math.abs(templeGridX - targetGridX) > 10 || Math.abs(templeGridY - targetGridY) > 10;
          if (!currentPath || currentPath.length === 0 || targetChanged) {
            startWalkingTo(templeGridX, templeGridY, 'Temple Center', 'temple');
          }
          stepPathWalker();
          statusMessage = `Walking to beacon center... ${distFromTemple.toFixed(0)} units`;
          // Don't start the clear timer until we're actually AT the center
          templeClearStartTime = 0;
        } else {
          // AT the center - start/continue waiting for beacon to activate
          if (templeClearStartTime === 0) {
            templeClearStartTime = now;
            log(`At temple center, waiting for beacon activation...`);
          }

          const waitTime = now - templeClearStartTime;

          // Give the beacon 8 seconds to activate while standing at center
          if (waitTime >= 8000) {
            log('Beacon did not activate after 8s at center, moving to boss anyway');
            templeCleared = true;
            setState(STATE.FINDING_BOSS);
          }
          statusMessage = `At beacon center, waiting... (${(waitTime / 1000).toFixed(1)}s)`;
        }
      }
      break;
    }

    case STATE.FINDING_BOSS: {
      const timeSinceStart = now - stateStartTime;
      statusMessage = 'Searching for boss...';

      // Throttle all expensive scans - only run every 3 seconds
      const shouldScanEntities = (now - lastBossEntityScanTime > 3000);

      // =================================================================
      // STRATEGY 1 (HIGHEST PRIORITY): Find "Checkpoint_Endgame_Boss" entity
      // =================================================================
      if (shouldScanEntities) {
        lastBossEntityScanTime = now;

        const checkpoints = poe2.getEntities({
          nameContains: 'Checkpoint_Endgame_Boss',
          lightweight: true,
        });
        if (checkpoints && checkpoints.length > 0) {
          const cp = checkpoints[0];
          if (!bossTgtFound || Math.abs(cp.gridX - bossGridX) > 30 || Math.abs(cp.gridY - bossGridY) > 30) {
            log(`Boss checkpoint entity at (${cp.gridX.toFixed(0)}, ${cp.gridY.toFixed(0)})`);
          }
          bossGridX = cp.gridX;
          bossGridY = cp.gridY;
          bossTgtFound = true;
        }
      }

      // =================================================================
      // STRATEGY 0: Use the RADAR's boss target (cheap, can run often)
      // =================================================================
      if (!bossTgtFound) {
        const radarBoss = getRadarBossTarget();
        if (radarBoss) {
          bossGridX = radarBoss.x;
          bossGridY = radarBoss.y;
          bossTgtFound = true;
          log(`Boss location from RADAR at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
        }
      }

      // =================================================================
      // STRATEGY 2: Find MonsterUnique entity (throttled with entity scan)
      // =================================================================
      let nearestBoss = null;
      let nearestBossDist = Infinity;
      const refX = bossTgtFound ? bossGridX : player.gridX;
      const refY = bossTgtFound ? bossGridY : player.gridY;

      if (shouldScanEntities) {
        const uniqueMonsters = poe2.getEntities({
          type: 'Monster',
          subtype: 'MonsterUnique',
          aliveOnly: true,
          lightweight: true,
        });
        if (uniqueMonsters && uniqueMonsters.length > 0) {
          for (const e of uniqueMonsters) {
            if (!isHostileAlive(e)) continue;
            const dx = e.gridX - refX;
            const dy = e.gridY - refY;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < nearestBossDist) {
              nearestBossDist = d;
              nearestBoss = e;
            }
          }
        }
      }

      // =================================================================
      // DECIDE: Walk to boss entity > checkpoint/radar target > TGT fallback
      // =================================================================
      if (nearestBoss) {
        bossGridX = nearestBoss.gridX;
        bossGridY = nearestBoss.gridY;
        bossFound = true;
        log(`Boss entity: "${nearestBoss.name || 'unknown'}" subtype=${nearestBoss.entitySubtype} at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)}) dist=${nearestBossDist.toFixed(0)}`);
        startWalkingTo(bossGridX, bossGridY, 'Boss', 'boss');
        setState(STATE.WALKING_TO_BOSS);
        break;
      }

      if (bossTgtFound) {
        // Sanity check: reject if target is too close to the temple (it's probably the temple, not the boss)
        if (templeFound) {
          const dxTemple = bossGridX - templeGridX;
          const dyTemple = bossGridY - templeGridY;
          const distToTemple = Math.sqrt(dxTemple * dxTemple + dyTemple * dyTemple);
          if (distToTemple < 80) {
            log(`Boss target (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)}) is ${distToTemple.toFixed(0)} units from temple - REJECTED (too close to temple)`);
            bossTgtFound = false;
            // Don't break - fall through to TGT/radar fallbacks
          }
        }
      }

      if (bossTgtFound) {
        log(`Walking to boss target at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
        startWalkingTo(bossGridX, bossGridY, 'Boss', 'boss');
        setState(STATE.WALKING_TO_BOSS);
        break;
      }

      // STRATEGY 3: TGT-based fallback (EXPENSIVE - BFS calls)
      // Only run every 15 seconds to avoid lag from iterating hundreds of TGTs
      if (timeSinceStart > 500 && (now - lastBossTgtSearchTime > 15000)) {
        lastBossTgtSearchTime = now;
        const bossTgt = findBossTgt();
        if (bossTgt) {
          bossGridX = bossTgt.x;
          bossGridY = bossTgt.y;
          bossTgtFound = true;
          log(`Boss TGT fallback at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
          startWalkingTo(bossGridX, bossGridY, 'Boss (TGT)', 'boss');
          setState(STATE.WALKING_TO_BOSS);
          break;
        }
      }

      // STRATEGY 4.5: Use ANY radar path endpoint (farthest from player)
      // If we can't find anything, the radar might have a non-boss path that leads
      // toward the boss area. Use the farthest radar endpoint as exploration target.
      // IMPORTANT: Skip temple/waygate paths - those are NOT the boss!
      if (timeSinceStart > 5000) {
        const radarPaths = getCachedRadarPaths();
        if (radarPaths && radarPaths.length > 0) {
          let farthestDist = 0;
          let farthestTarget = null;
          for (const rp of radarPaths) {
            if (!rp.valid || !rp.targetX || !rp.targetY) continue;
            // Skip temple/waygate radar paths - we already handled temple separately
            const rpName = (rp.name || '').toLowerCase();
            if (rpName.includes('temple') || rpName.includes('waygate') || rpName.includes('vaal') || rpName.includes('beacon')) continue;
            const dx = rp.targetX - player.gridX;
            const dy = rp.targetY - player.gridY;
            const d = dx * dx + dy * dy;
            if (d > farthestDist) {
              farthestDist = d;
              farthestTarget = rp;
            }
          }
          if (farthestTarget && farthestDist > 100 * 100) {
            bossGridX = farthestTarget.targetX;
            bossGridY = farthestTarget.targetY;
            bossTgtFound = true;
            log(`Boss fallback: farthest radar path "${farthestTarget.name}" at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
            startWalkingTo(bossGridX, bossGridY, 'Boss (radar far)', 'boss');
            setState(STATE.WALKING_TO_BOSS);
            break;
          }
        }
      }

      // STRATEGY 5: Explore away from temple while searching
      if (timeSinceStart > 3000 && templeFound) {
        statusMessage = `Exploring for boss... (${(timeSinceStart / 1000).toFixed(0)}s)`;
        if (now - lastMoveTime >= currentSettings.moveIntervalMs) {
          const dxFromTemple = player.gridX - templeGridX;
          const dyFromTemple = player.gridY - templeGridY;
          const fromTempleDist = Math.sqrt(dxFromTemple * dxFromTemple + dyFromTemple * dyFromTemple);
          if (fromTempleDist > 10) {
            const exploreX = player.gridX + (dxFromTemple / fromTempleDist) * 100;
            const exploreY = player.gridY + (dyFromTemple / fromTempleDist) * 100;
            moveTowardGridPos(player.gridX, player.gridY, exploreX, exploreY);
          } else {
            const angle = Math.random() * Math.PI * 2;
            moveTowardGridPos(player.gridX, player.gridY, player.gridX + Math.cos(angle) * 100, player.gridY + Math.sin(angle) * 100);
          }
          lastMoveTime = now;
        }
      } else {
        statusMessage = `No boss found yet (${(timeSinceStart / 1000).toFixed(0)}s)`;
      }
      break;
    }

    case STATE.WALKING_TO_BOSS: {
      const result = stepPathWalker();
      const dist = Math.sqrt(
        (player.gridX - bossGridX) ** 2 + (player.gridY - bossGridY) ** 2
      );
      statusMessage = `Walking to Boss... ${dist.toFixed(0)} units`;

      // After passing the checkpoint, scan for the ACTUAL BOSS (MonsterUnique).
      // ONLY enter FIGHTING_BOSS when the boss is targetable and within ~40 units.
      // Do NOT trigger on random trash mobs.
      if (checkpointReached && now - lastEntityScanTime > 1000) {
        lastEntityScanTime = now;
        const nearbyUniques = poe2.getEntities({
          type: 'Monster', subtype: 'MonsterUnique', aliveOnly: true, lightweight: true
        });
        if (nearbyUniques && nearbyUniques.length > 0) {
          for (const e of nearbyUniques) {
            if (!isHostileAlive(e)) continue;
            const dx = e.gridX - player.gridX;
            const dy = e.gridY - player.gridY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 40 && e.isTargetable) {
              bossGridX = e.gridX;
              bossGridY = e.gridY;
              bossEntityId = e.id || 0;
              const bossName = (e.renderName || e.name || 'Unknown').split('/').pop();
              log(`Boss "${bossName}" targetable at ${dist.toFixed(0)} units - entering fight`);
              setState(STATE.FIGHTING_BOSS);
              break;
            }
          }
        }
        if (state === STATE.FIGHTING_BOSS) break;
      }

      // While walking, only re-scan for the checkpoint entity (not random mobs!)
      // Don't chase random rares/uniques along the way - just get to the checkpoint.
      if (!checkpointReached && now - lastEntityScanTime > 3000) {
        lastEntityScanTime = now;

        const checkpoints = poe2.getEntities({
          nameContains: 'Checkpoint_Endgame_Boss',
          lightweight: true,
        });
        if (checkpoints && checkpoints.length > 0) {
          const cp = checkpoints[0];
          if (Math.abs(cp.gridX - bossGridX) > 30 || Math.abs(cp.gridY - bossGridY) > 30) {
            log(`Boss checkpoint found while walking at (${cp.gridX.toFixed(0)}, ${cp.gridY.toFixed(0)})`);
            bossGridX = cp.gridX;
            bossGridY = cp.gridY;
            bossTgtFound = true;
            startWalkingTo(bossGridX, bossGridY, 'Boss Checkpoint', 'boss');
          }
        }
      }

      if (result === 'arrived') {
        templeClearStartTime = 0;

        // Check for the ACTUAL BOSS (MonsterUnique, targetable, within 40 units)
        let bossNearby = false;
        const nearbyUniques = poe2.getEntities({
          type: 'Monster', subtype: 'MonsterUnique', aliveOnly: true, lightweight: true
        });
        if (nearbyUniques && nearbyUniques.length > 0) {
          for (const e of nearbyUniques) {
            if (!isHostileAlive(e)) continue;
            const dx = e.gridX - player.gridX;
            const dy = e.gridY - player.gridY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 40 && e.isTargetable) {
              bossGridX = e.gridX;
              bossGridY = e.gridY;
              bossEntityId = e.id || 0;
              const bossName = (e.renderName || e.name || 'Unknown').split('/').pop();
              log(`Boss "${bossName}" found at ${dist.toFixed(0)} units on arrival - fighting`);
              checkpointReached = true;
              setState(STATE.FIGHTING_BOSS);
              bossNearby = true;
              break;
            }
          }
        }

        if (!bossNearby) {
          if (!checkpointReached) {
            // FIRST arrival (checkpoint) - push DEEPER into boss room
            checkpointReached = true;
            log('Checkpoint reached, pushing deeper to find boss');

            // Use radar path if available (yellow line goes to boss), else push forward
            const radarBoss = getRadarBossTarget();
            if (radarBoss && (Math.abs(radarBoss.x - bossGridX) > 20 || Math.abs(radarBoss.y - bossGridY) > 20)) {
              bossGridX = radarBoss.x;
              bossGridY = radarBoss.y;
              log(`Radar shows boss deeper at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
              startWalkingTo(bossGridX, bossGridY, 'Boss (radar)', 'boss');
            } else {
              // No radar path - push 120 units past checkpoint in the direction we were heading
              const savedBossX = bossGridX;
              const savedBossY = bossGridY;
              const dirX = bossGridX - (templeFound ? templeGridX : player.gridX);
              const dirY = bossGridY - (templeFound ? templeGridY : player.gridY);
              const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
              if (dirLen > 1) {
                bossGridX = savedBossX + (dirX / dirLen) * 120;
                bossGridY = savedBossY + (dirY / dirLen) * 120;
                log(`Pushing 120 past checkpoint to (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
              }
              startWalkingTo(bossGridX, bossGridY, 'Boss room', 'boss');
            }
          } else {
            // Already pushed past checkpoint, arrived at pushed target, no boss yet.
            // Push EVEN FURTHER in the same direction.
            const dirX = bossGridX - (templeFound ? templeGridX : player.gridX);
            const dirY = bossGridY - (templeFound ? templeGridY : player.gridY);
            const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
            if (dirLen > 1) {
              bossGridX = player.gridX + (dirX / dirLen) * 100;
              bossGridY = player.gridY + (dirY / dirLen) * 100;
              log(`No boss yet, pushing further to (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
              startWalkingTo(bossGridX, bossGridY, 'Boss room (deeper)', 'boss');
            } else {
              // Can't determine direction - move toward any nearby MonsterUnique at any distance
              if (nearbyUniques && nearbyUniques.length > 0) {
                const e = nearbyUniques[0];
                bossGridX = e.gridX;
                bossGridY = e.gridY;
                log(`Walking toward distant unique at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
                startWalkingTo(bossGridX, bossGridY, 'Boss (unique)', 'boss');
              }
            }
          }
        }
      } else if (result === 'stuck') {
        const timeInWalk = now - stateStartTime;
        if (timeInWalk > 20000) {
          log(`Boss target unreachable after ${(timeInWalk / 1000).toFixed(0)}s, abandoning (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
          abandonedBossTargets.push({ x: bossGridX, y: bossGridY });
          bossTgtFound = false;
          bossFound = false;
          setState(STATE.FINDING_BOSS);
        } else {
          startWalkingTo(bossGridX, bossGridY, 'Boss', 'boss');
        }
      } else if (currentPath.length === 0 && now - stateStartTime > 30000) {
        log(`No path to boss for 30s, abandoning (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
        abandonedBossTargets.push({ x: bossGridX, y: bossGridY });
        bossTgtFound = false;
        bossFound = false;
        setState(STATE.FINDING_BOSS);
      }
      break;
    }

    case STATE.FIGHTING_BOSS: {
      // =================================================================
      // BOSS FIGHT
      // 1) Track the MonsterUnique boss entity by ID
      // 2) Orbit around it to dodge melee swings
      // 3) Detect boss death (HP=0 / isAlive=false) → map complete
      // 4) Fallback: no hostiles for 8s after combat → map complete
      // =================================================================
      const fightScanRadius = currentSettings.bossFightRadius * 3; // 240 grid units

      // Query ALL monsters (including dead) so we can detect boss death
      const allMonstersNearby = POE2Cache.getEntities({
        type: 'Monster',
        lightweight: true,
        maxDistance: fightScanRadius
      });

      // Also get alive-only for hostile counting
      const bossMonsters = allMonstersNearby ? allMonstersNearby.filter(e => isHostileAlive(e)) : [];

      // Count hostiles near boss area AND near player
      const hostileCount = countHostilesNear(
        bossMonsters, bossGridX, bossGridY, fightScanRadius
      );
      const hostileCountNearPlayer = countHostilesNear(
        bossMonsters, player.gridX, player.gridY, currentSettings.bossFightRadius * 2
      );
      const totalHostiles = Math.max(hostileCount, hostileCountNearPlayer);
      const timeInFight = now - stateStartTime;

      // =================================================================
      // BOSS ENTITY TRACKING
      // Find and track the MonsterUnique - this is the map boss.
      // Once we have its ID, we can detect its death instantly.
      // =================================================================
      if (bossEntityId === 0 && allMonstersNearby) {
        for (const e of allMonstersNearby) {
          if (e.entitySubtype === 'MonsterUnique' && e.id && e.id !== 0) {
            bossEntityId = e.id;
            bossFound = true;
            const bossName = (e.renderName || e.name || 'Unknown').split('/').pop();
            log(`Boss identified: "${bossName}" (ID: ${bossEntityId})`);
            break;
          }
        }
      }

      // =================================================================
      // BOSS DEATH CHECK (instant detection via entity HP/alive status)
      // =================================================================
      if (bossEntityId !== 0 && allMonstersNearby) {
        for (const e of allMonstersNearby) {
          if (e.id === bossEntityId) {
            // Found the tracked boss entity - check if dead
            if (!e.isAlive || e.healthCurrent === 0) {
              const bossName = (e.renderName || e.name || 'Unknown').split('/').pop();
              log(`Boss DEAD: "${bossName}" (HP: ${e.healthCurrent || 0}/${e.healthMax || 0}) - Map complete!`);
              bossDead = true;
              stopMovement();
              setState(STATE.MAP_COMPLETE);
              break;
            }
          }
        }
        if (bossDead) break; // Exit the case immediately
      }

      // Track if we've EVER seen hostiles in this fight (prevents premature exit)
      if (totalHostiles > 0) {
        bossFound = true; // We're in combat at the boss area - that's good enough
        templeClearStartTime = 0; // Reset no-hostile timer
      }

      statusMessage = bossEntityId !== 0
        ? `Fighting Boss (ID:${bossEntityId})... ${totalHostiles} hostiles`
        : `Fighting Boss... ${totalHostiles} hostiles`;

      // =================================================================
      // MOVEMENT TARGET
      // First: how far are we from the boss area (bossGridX/Y)?
      // If far, ALWAYS walk toward boss area. Don't get distracted by trash.
      // If close, find the best nearby hostile to zig-zag around.
      // =================================================================
      const dxBoss = bossGridX - player.gridX;
      const dyBoss = bossGridY - player.gridY;
      const distToBossArea = Math.sqrt(dxBoss * dxBoss + dyBoss * dyBoss);

      let moveTargetX, moveTargetY, distToTarget;

      if (distToBossArea > 60) {
        // FAR from boss area - walk straight there, ignore trash mobs
        moveTargetX = bossGridX;
        moveTargetY = bossGridY;
        distToTarget = distToBossArea;
      } else {
        // CLOSE to boss area - find the best hostile to orbit
        moveTargetX = bossGridX;
        moveTargetY = bossGridY;
        if (bossMonsters && bossMonsters.length > 0) {
          let bestPriority = -1;
          for (const e of bossMonsters) {
            if (!isHostileAlive(e)) continue;
            let priority = 0;
            if (e.entitySubtype === 'MonsterUnique') priority = 3;
            else if (e.entitySubtype === 'MonsterRare') priority = 2;
            else if (e.entityType === 'Monster') priority = 1;
            if (priority > bestPriority) {
              bestPriority = priority;
              moveTargetX = e.gridX;
              moveTargetY = e.gridY;
            }
          }
        }
        const dx = moveTargetX - player.gridX;
        const dy = moveTargetY - player.gridY;
        distToTarget = Math.sqrt(dx * dx + dy * dy);
      }

      const dxTarget = moveTargetX - player.gridX;
      const dyTarget = moveTargetY - player.gridY;

      if (now - lastMoveTime >= currentSettings.moveIntervalMs) {
        if (distToTarget > 40) {
          // Walk straight toward target
          moveTowardGridPos(player.gridX, player.gridY, moveTargetX, moveTargetY);
          lastMoveTime = now;
          statusMessage = `Walking to Boss... ${distToTarget.toFixed(0)} units`;
        } else {
          // =============================================================
          // CIRCULAR ORBITING around boss - stay at range, never run
          // straight toward or away (avoids melee swings).
          // We orbit at ORBIT_RADIUS, always moving tangentially.
          // Periodically reverse orbit direction for unpredictability.
          // =============================================================
          const ORBIT_RADIUS = 32;  // ideal orbit distance (outside melee range)
          const ORBIT_SPEED = 28;   // how far we move per step
          const REVERSE_MS = 2500;  // reverse orbit direction every 2.5s

          const angleToBoss = Math.atan2(dyTarget, dxTarget);

          // Orbit direction: +1 = counter-clockwise, -1 = clockwise
          // Reverse periodically to be unpredictable
          const orbitDir = (Math.floor(timeInFight / REVERSE_MS) % 2 === 0) ? 1 : -1;

          // Tangent angle (perpendicular to boss direction)
          const tangentAngle = angleToBoss + (Math.PI / 2) * orbitDir;

          // Radial correction: gently push in/out to maintain orbit distance
          let radialCorrection = 0;
          if (distToTarget < ORBIT_RADIUS - 5) {
            // Too close - push outward while orbiting
            radialCorrection = -8; // negative = away from boss
          } else if (distToTarget > ORBIT_RADIUS + 5) {
            // Too far - pull inward while orbiting
            radialCorrection = 8; // positive = toward boss
          }

          // Combine: mostly tangential movement + small radial correction
          const moveGX = player.gridX
            + Math.cos(tangentAngle) * ORBIT_SPEED
            + Math.cos(angleToBoss) * radialCorrection;
          const moveGY = player.gridY
            + Math.sin(tangentAngle) * ORBIT_SPEED
            + Math.sin(angleToBoss) * radialCorrection;

          moveTowardGridPos(player.gridX, player.gridY, moveGX, moveGY);
          lastMoveTime = now;
          statusMessage = `Orbiting Boss... ${distToTarget.toFixed(0)} units, ${totalHostiles} hostiles`;
        }
      }

      // =================================================================
      // COMPLETION CHECK
      // =================================================================
      if (totalHostiles === 0) {
        if (templeClearStartTime === 0) {
          templeClearStartTime = now;
        }
        const clearDuration = now - templeClearStartTime;

        if (bossFound && clearDuration >= 8000) {
          // We fought hostiles and now they're all dead - map complete!
          log('Boss area clear after combat, map complete!');
          bossDead = true;
          setState(STATE.MAP_COMPLETE);
        } else if (!bossFound && clearDuration >= 10000) {
          // Arrived at checkpoint but never saw hostiles - wrong spot or already cleared
          log('No hostiles seen at boss area for 10s, map may be complete');
          bossDead = true;
          setState(STATE.MAP_COMPLETE);
        }
        statusMessage = `Boss area clearing... (${(clearDuration / 1000).toFixed(0)}s)`;
      }
      break;
    }

    case STATE.MAP_COMPLETE: {
      const completeTime = now - stateStartTime;
      statusMessage = `Map complete! Looting... (${(completeTime / 1000).toFixed(0)}s)`;
      // Stay in this state - opener and pickit will handle chests/loot.
      // Mapper stops all movement so opener/pickit have full control.
      // Player stays put to pick up boss drops and open any chests.
      break;
    }
  }
}

// ============================================================================
// UI
// ============================================================================

function drawUI() {
  // Always try to load settings
  if (!settingsLoaded) {
    loadPlayerSettings();
  }

  // Check hotkey
  const ctrlDown = ImGui.isKeyDown(ImGui.Key.LeftCtrl) || ImGui.isKeyDown(ImGui.Key.RightCtrl);
  const shiftDown = ImGui.isKeyDown(ImGui.Key.LeftShift) || ImGui.isKeyDown(ImGui.Key.RightShift);
  const altDown = ImGui.isKeyDown(ImGui.Key.LeftAlt) || ImGui.isKeyDown(ImGui.Key.RightAlt);
  const ctrlOk = !currentSettings.hotkeyCtrl || ctrlDown;
  const shiftOk = !currentSettings.hotkeyShift || shiftDown;
  const altOk = !currentSettings.hotkeyAlt || altDown;

  if (ctrlOk && shiftOk && altOk && ImGui.isKeyPressed(currentSettings.hotkey, false)) {
    enabled.value = !enabled.value;
    saveSetting('enabled', enabled.value);
    if (!enabled.value) {
      resetMapper();
      stopMovement();
    }
    log(`Mapper ${enabled.value ? 'ENABLED' : 'DISABLED'}`);
  }

  // Run mapper logic
  processMapper();

  // Only draw UI when plugin window is visible
  if (!Plugins.isUiVisible()) return;

  // Main toggle
  if (ImGui.checkbox("Enable Mapper", enabled)) {
    saveSetting('enabled', enabled.value);
    if (!enabled.value) {
      resetMapper();
      stopMovement();
    }
  }

  ImGui.sameLine();
  ImGui.textColored(
    enabled.value ? [0, 1, 0, 1] : [1, 0.3, 0.3, 1],
    enabled.value ? '[ACTIVE]' : '[OFF]'
  );

  ImGui.separator();

  // State display
  ImGui.text(`State: ${currentState}`);
  ImGui.text(`Status: ${statusMessage}`);

  const player = POE2Cache.getLocalPlayer();
  if (player && player.gridX !== undefined) {
    ImGui.text(`Player: (${player.gridX.toFixed(0)}, ${player.gridY.toFixed(0)})`);
  }

  if (targetGridX || targetGridY) {
    ImGui.text(`Target: ${targetName} (${targetGridX.toFixed(0)}, ${targetGridY.toFixed(0)})`);
    if (player && player.gridX !== undefined) {
      const dist = Math.sqrt(
        (player.gridX - targetGridX) ** 2 + (player.gridY - targetGridY) ** 2
      );
      ImGui.text(`Distance: ${dist.toFixed(0)} grid units`);
    }
  }

  // Manual skip buttons - useful when temple is already done or stuck
  if (enabled.value && currentState !== STATE.IDLE && currentState !== STATE.MAP_COMPLETE) {
    if (currentState !== STATE.FINDING_BOSS && currentState !== STATE.WALKING_TO_BOSS && currentState !== STATE.FIGHTING_BOSS) {
      if (ImGui.button("Skip to Boss >>")) {
        log('Manual skip to boss');
        templeCleared = true;
        templeFound = true;
        // If we don't have temple coords yet, use player position as reference
        if (!templeGridX && !templeGridY && player) {
          templeGridX = player.gridX;
          templeGridY = player.gridY;
        }
        setState(STATE.FINDING_BOSS);
      }
    }
    ImGui.sameLine();
    if (ImGui.button("Reset")) {
      log('Manual reset');
      resetMapper();
    }
  }

  ImGui.separator();

  // Info
  ImGui.text(`Temple: ${templeFound ? (templeCleared ? 'Cleared' : 'Found') : 'Not found'}`);
  ImGui.text(`Boss TGT: ${bossTgtFound ? 'Found' : 'Not found'}`);
  ImGui.text(`Boss: ${bossFound ? (bossDead ? 'Dead' : `Alive (id=${bossEntityId})`) : 'Not found'}`);
  ImGui.text(`Path: ${currentPath.length} waypoints (wp ${currentWaypointIndex}) [${targetPathType || '-'}]`);
  ImGui.text(`Paths computed: ${pathComputeCount}`);
  ImGui.text(`Stuck count: ${stuckCount}`);

  // Radar path debug
  const radarPaths = getCachedRadarPaths();
  if (radarPaths && radarPaths.length > 0) {
    const names = radarPaths.filter(r => r.valid).map(r => `${r.name}(${r.path ? r.path.length : 0}wp)`).join(', ');
    ImGui.text(`Radar paths: ${names}`);
  } else {
    ImGui.text(`Radar paths: none`);
  }

  // Area info
  const areaInfo = poe2.getAreaInfo();
  if (areaInfo && areaInfo.isValid) {
    ImGui.text(`Area: ${areaInfo.areaName || areaInfo.areaId || 'unknown'}`);
  }

  // Walkability debug (only check when UI is visible, not every frame)
  if (player && player.gridX !== undefined) {
    const px = Math.floor(player.gridX);
    const py = Math.floor(player.gridY);
    const playerWalkable = poe2.isWalkable(px, py);
    ImGui.text(`Player walkable: ${playerWalkable} at (${px}, ${py})`);

    if (targetGridX || targetGridY) {
      const tx = Math.floor(targetGridX);
      const ty = Math.floor(targetGridY);
      const targetWalkable = poe2.isWalkable(tx, ty);
      ImGui.text(`Target walkable: ${targetWalkable} at (${tx}, ${ty})`);
    }
  }

  ImGui.separator();

  // Movement debug
  if (ImGui.treeNode("Movement Debug")) {
    if (lastMoveDebug) {
      ImGui.text(`Grid delta: dX=${lastMoveDebug.gridDX}, dY=${lastMoveDebug.gridDY}`);
      ImGui.text(`Angle: ${lastMoveDebug.angle} deg, Dist: ${lastMoveDebug.dist}`);
      ImGui.textColored(
        lastMoveDebug.nav === 'wall-avoid' ? [1, 0.5, 0, 1] : [0, 1, 0, 1],
        `Nav: ${lastMoveDebug.nav}`
      );

      // Compute expected direction name from screen angle
      const a = parseFloat(lastMoveDebug.angle);
      let dirName = '';
      if (a >= -22.5 && a < 22.5) dirName = 'E (right)';
      else if (a >= 22.5 && a < 67.5) dirName = 'NE (upper-right)';
      else if (a >= 67.5 && a < 112.5) dirName = 'N (up)';
      else if (a >= 112.5 && a < 157.5) dirName = 'NW (upper-left)';
      else if (a >= 157.5 || a < -157.5) dirName = 'W (left)';
      else if (a >= -157.5 && a < -112.5) dirName = 'SW (lower-left)';
      else if (a >= -112.5 && a < -67.5) dirName = 'S (down)';
      else if (a >= -67.5 && a < -22.5) dirName = 'SE (lower-right)';
      ImGui.textColored(
        [1, 1, 0, 1],
        `Screen dir: ${dirName}`
      );
    } else {
      ImGui.text('No movement yet');
    }

    // Terrain info for debugging grid dimensions
    const terrainInfo = poe2.getTerrainInfo();
    if (terrainInfo && terrainInfo.isValid) {
      ImGui.text(`Grid: ${terrainInfo.width}x${terrainInfo.height}`);
    }

    ImGui.separator();
    ImGui.text('Manual test buttons (200 units):');
    if (ImGui.button("N##map")) { moveAngle(90, 200); }
    ImGui.sameLine();
    if (ImGui.button("S##map")) { moveAngle(270, 200); }
    ImGui.sameLine();
    if (ImGui.button("E##map")) { moveAngle(0, 200); }
    ImGui.sameLine();
    if (ImGui.button("W##map")) { moveAngle(180, 200); }
    if (ImGui.button("NE##map")) { moveAngle(45, 200); }
    ImGui.sameLine();
    if (ImGui.button("NW##map")) { moveAngle(135, 200); }
    ImGui.sameLine();
    if (ImGui.button("SE##map")) { moveAngle(315, 200); }
    ImGui.sameLine();
    if (ImGui.button("SW##map")) { moveAngle(225, 200); }

    ImGui.treePop();
  }

  ImGui.separator();

  // TGT Debug - show all TGT names in current area
  if (ImGui.treeNode("TGT Debug")) {
    const tgt = poe2.getTgtLocations();
    if (tgt && tgt.isValid) {
      for (const [name, positions] of Object.entries(tgt.locations)) {
        const shortName = name.split('/').pop() || name;
        const isBoss = BOSS_TGT_PATTERNS.some(p => shortName.toLowerCase().includes(p));
        const isTemple = shortName.toLowerCase().includes(TEMPLE_TGT_PATTERN);
        const color = isBoss ? [1, 0.3, 0.3, 1] : isTemple ? [1, 0.85, 0, 1] : [0.7, 0.7, 0.7, 1];
        ImGui.textColored(color, `${shortName} (${positions.length} pts)${isBoss ? ' [BOSS]' : ''}${isTemple ? ' [TEMPLE]' : ''}`);
      }
    } else {
      ImGui.text('No TGT data');
    }
    ImGui.treePop();
  }

  ImGui.separator();

  // Buff Debug - show all player buff names (to identify beacon buff)
  if (ImGui.treeNode("Buff Debug")) {
    const lp = POE2Cache.getLocalPlayer();
    if (lp && lp.buffs && lp.buffs.length > 0) {
      ImGui.text(`${lp.buffs.length} buffs:`);
      for (const buff of lp.buffs) {
        const bn = buff.name || '(unnamed)';
        const isBeacon = bn.toLowerCase().includes('beacon') ||
                         bn.toLowerCase().includes('energi') ||
                         bn.toLowerCase().includes('waygate') ||
                         bn.toLowerCase().includes('vaal');
        const color = isBeacon ? [0, 1, 0, 1] : [0.6, 0.6, 0.6, 1];
        let label = bn;
        if (buff.timeLeft > 0) label += ` (${buff.timeLeft.toFixed(1)}s)`;
        if (buff.charges > 0) label += ` x${buff.charges}`;
        ImGui.textColored(color, label);
      }
    } else {
      ImGui.text('No buffs');
    }
    ImGui.treePop();
  }

  ImGui.separator();

  // Debug log
  if (ImGui.treeNode("Debug Log")) {
    for (let i = debugLog.length - 1; i >= Math.max(0, debugLog.length - 20); i--) {
      ImGui.textWrapped(debugLog[i]);
    }
    ImGui.treePop();
  }
}

// ============================================================================
// PLUGIN EXPORT
// ============================================================================

function onDraw() {
  drawUI();
}

export const mapperPlugin = { onDraw };

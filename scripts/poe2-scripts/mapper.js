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
import { executeChanneledSkill, angleToDeltas } from './rotation_builder.js';
import { getOpenableCandidatesForMapper, getOpenerCooldownMs } from './opener.js';
import { getLootCandidatesForMapper, getPickitCooldownMs } from './pickit.js';

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
  WALKING_TO_UTILITY: 'WALKING_TO_UTILITY',
  WALKING_TO_BOSS_CHECKPOINT: 'WALKING_TO_BOSS_CHECKPOINT',
  WALKING_TO_BOSS_MELEE: 'WALKING_TO_BOSS_MELEE',
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

// Boss-room object anchors used when Checkpoint_Endgame_Boss is hidden/unavailable.
// Keep this list strict to avoid pulling random map objects.
const BOSS_ROOM_OBJECT_PATTERNS = [
  'BossArenaBlocker',
  'BossForceFieldDoorVisuals',
  'BossArenaLocker',
];

// Default settings
const DEFAULT_SETTINGS = {
  enabled: false,
  hotkey: ImGui.Key.F7,
  hotkeyCtrl: false,
  hotkeyShift: false,
  hotkeyAlt: false,
  // Path walker
  moveIntervalMs: 240,        // ms between movement packets (slightly safer vs action-rate kick)
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
  fightEntityScanIntervalMs: 360, // throttle heavy monster scans during boss fight
  fightUseWideOrbit: false,   // performance mode: disable expensive wide-clearance orbit scoring
  // Optional boss-fight dodge roll (channeled skill)
  bossDodgeRollEnabled: false,
  bossDodgeRollIntervalMs: 800,
  bossDodgeRollDistance: 46,
  // Keep dodge mostly behind boss (small angular spread, not sideways).
  bossDodgeBehindMinDeg: 6,
  bossDodgeBehindMaxDeg: 20,
  // Utility targeting layer
  walkToOpenablesEnabled: true,
  walkToLootEnabled: true,
  walkToNormalChestsEnabled: false,
  openableWalkRadius: 200,
  lootWalkRadius: 200,
  utilityNoPathBlacklistThreshold: 3,
  utilityBlacklistMergeRadius: 38,
  // Disabled placeholders for future providers
  walkToBreachTargetsEnabled: false,
  walkToAbyssTargetsEnabled: false,
  walkToFutureMechanicsEnabled: false,
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
let lastBossCheckpointScanTime = 0;
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
let templeCenterApproachStartTime = 0; // time spent trying to reach temple center with no hostiles
let templeNoHostilesSince = 0;   // sustained no-hostiles timer around temple room
let templeCenterSeenAt = 0;      // timestamp when we were close to temple center
let templePedestalSeenAt = 0;    // last time pedestal object was visible
let templeCleared = false;
let templeStuckTime = 0;         // when we started being stuck walking to temple
let usingBossFallback = false;   // true = walking toward boss to find path to temple
let templeExploreDirX = 0;
let templeExploreDirY = 0;
let templeExploreAnchorX = 0;
let templeExploreAnchorY = 0;
let templeExploreNoPathCount = 0;

// Boss state
let bossGridX = 0;
let bossGridY = 0;
let bossTgtFound = false;
let bossEntityId = 0;
let bossFound = false;
let bossDead = false;
let checkpointReached = false;  // true = we've arrived at boss checkpoint, stop re-scanning for it
let abandonedBossTargets = [];  // grid positions we've abandoned (unreachable), skip them next time
let bossCandidateId = 0;        // candidate unique seen while approaching activation range
let bossTargetSource = '';      // 'checkpoint' | 'arena_object'
let bossOrbitDir = 1;           // locked orbit direction: 1=CCW, -1=CW
let bossOrbitBlockedCount = 0;  // consecutive blocked orbit attempts
let bossOrbitReverseUntil = 0;  // temporary reverse window end timestamp (ms)
let bossMeleeHoldStartTime = 0; // when we started holding near boss waiting for engagement
let bossMeleeStaticLocked = false; // true once we lock a static melee stand position
let bossMeleeStaticX = 0;
let bossMeleeStaticY = 0;
let bossMeleeStaticEntityId = 0;
let bossMeleeLastRetargetTime = 0;
let bossMeleeFullScanTime = 0;
let bossMeleeFullScanCache = [];
let resumeTempleAfterBoss = false; // if boss is killed mid-temple-route, return to temple objective
let earlyBossHintLogged = false;    // one-time log when boss signal is seen early
let bossExploreDirX = 0;
let bossExploreDirY = 0;
let bossExploreLastTargetX = 0;
let bossExploreLastTargetY = 0;
let bossExploreLastPickTime = 0;
let bossExploreNoPathCount = 0;
let bossFightOrbitWaypointX = 0;
let bossFightOrbitWaypointY = 0;
let bossFightOrbitLastAssignTime = 0;
let bossFightRecentOrbitSectors = []; // small ring-buffer of recent sectors to avoid repeats
let bossFightStuckCount = 0;
let bossNoPathCount = 0;
let bossDetourLastPickTime = 0;
let bossRecentDetours = []; // [{x,y}] recent detour anchors to avoid loops
let bossCheckpointLastDist = Infinity;
let bossCheckpointLastImprovementTime = 0;

// Area tracking
let lastAreaChangeCount = 0;

// Debug / stats
let debugLog = [];
let pathComputeCount = 0;
let lastMoveDebug = null; // stores last movement computation details
let lastMovePacketTime = 0; // hard packet throttle across all moveAngle calls
let lastStopPacketTime = 0; // hard packet throttle for stopMovement calls
let lastBossDodgeRollTime = 0;
let lastBossEmergencyRollTime = 0;
let bossDodgeSide = 1; // alternates left/right around behind arc
let dodgeMoveSuppressUntil = 0; // pause normal move packets briefly after dodge roll
let bossDodgeLandingX = 0;
let bossDodgeLandingY = 0;
let bossDodgeLandingTime = 0;
let bossFightEngagedAt = 0; // timestamp when entering FIGHTING_BOSS
let bossHpSamples = new Map(); // entityId -> { hp, t }
let lastBossEngageProbeTime = 0;
let cachedBossEngageProbe = null; // { entity, reason } | null
let lastBossEngageProbeMaxDistance = 0;
let lastBossEngageDebugKey = '';
let lastBossEngageDebugTime = 0;
let areaGuardBlockedLastFrame = false;
let areaGuardLastName = '';
let fightSnapshotTime = 0;
let fightSnapshotAll = [];
let fightSnapshotAlive = [];
let bossFightLastPosCheckTime = 0;
let bossFightLastPosX = 0;
let bossFightLastPosY = 0;
let lastMapperLogicTime = 0;
let lastNoPathLogTime = 0;
let lastNoPathLogDistBucket = -1;
let lastPathFoundLogTime = 0;
let lastBossRoomAnchorScanTime = 0;
let cachedBossRoomAnchor = null;
let lastExploreMobPickTime = 0;
let cachedExploreMobTarget = null;
let lastStartWalkLogTime = 0;
let lastStartWalkLogName = '';
let lastStartWalkLogPathType = '';
let lastStartWalkLogX = 0;
let lastStartWalkLogY = 0;
let lastLogMsg = '';
let lastLogTime = 0;
let lastTempleUnreachableLogTime = 0;
let utilityLogTimes = new Map();

// Utility target state (per-map)
let ignoredUtilityTargets = new Set();
let utilityActiveTarget = null;
let utilityNoPathCount = 0;
let utilityArrivalWaitStart = 0;
let utilityDetourUntil = 0;
let utilityLastSelectedKey = '';
let utilityResumeState = STATE.IDLE;
let utilityStats = {
  openableCandidates: 0,
  lootCandidates: 0,
  futureCandidates: 0,
  totalCandidates: 0,
  blacklistedCount: 0,
};

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
  const now = Date.now();
  if (msg === lastLogMsg && now - lastLogTime < 1200) return;
  lastLogMsg = msg;
  lastLogTime = now;
  const ts = new Date().toLocaleTimeString();
  const entry = `[${ts}] ${msg}`;
  debugLog.push(entry);
  if (debugLog.length > 50) debugLog.shift();
  console.log(`[Mapper] ${msg}`);
}

function logUtility(msg, key = msg, minGapMs = 1600) {
  const now = Date.now();
  const last = utilityLogTimes.get(key) || 0;
  if (now - last < minGapMs) return;
  utilityLogTimes.set(key, now);
  log(msg);
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
function getRadarBossTarget(preferX = null, preferY = null) {
  const radarPaths = getCachedRadarPaths();
  if (!radarPaths || radarPaths.length === 0) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const rp of radarPaths) {
    if (!rp.valid) continue;
    const name = (rp.name || '').toLowerCase();
    if (!name.includes('boss')) continue;
    if (rp.targetX === undefined || rp.targetY === undefined) continue;

    // Avoid temple-like false positives when names are noisy.
    if (templeFound) {
      const dxT = rp.targetX - templeGridX;
      const dyT = rp.targetY - templeGridY;
      const dTemple = Math.sqrt(dxT * dxT + dyT * dyT);
      if (dTemple < 70) continue;
    }

    let score = 0;
    if (rp.path && rp.path.length > 0) score += Math.min(rp.path.length, 400) * 0.2;

    const px = preferX !== null ? preferX : (bossMeleeStaticLocked ? bossMeleeStaticX : (bossGridX || null));
    const py = preferY !== null ? preferY : (bossMeleeStaticLocked ? bossMeleeStaticY : (bossGridY || null));
    if (px !== null && py !== null) {
      const dxP = rp.targetX - px;
      const dyP = rp.targetY - py;
      const dPref = Math.sqrt(dxP * dxP + dyP * dyP);
      score -= dPref * 1.4; // strong stability preference
    }

    if (score > bestScore) {
      bestScore = score;
      best = { x: rp.targetX, y: rp.targetY };
    }
  }
  return best;
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
        const now = Date.now();
        if (now - lastPathFoundLogTime > 1200) {
          log(`Radar path (${targetPathType || 'coord'}): ${trimmed.length} wp (from idx ${startIdx}/${validPath.length})`);
          lastPathFoundLogTime = now;
        }
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
      const now = Date.now();
      if (now - lastPathFoundLogTime > 1200) {
        log(`BFS path: ${path.length} wp`);
        lastPathFoundLogTime = now;
      }
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
      const now = Date.now();
      if (now - lastPathFoundLogTime > 1200) {
        log(`A* path: ${path.length} wp`);
        lastPathFoundLogTime = now;
      }
      return true;
    }
  } catch (err) {
    log(`A* error: ${err}`);
  }

  const now = Date.now();
  const distBucket = Math.floor(totalDist / 80);
  if (now - lastNoPathLogTime > 1500 || distBucket !== lastNoPathLogDistBucket) {
    log(`No path found. dist=${totalDist.toFixed(0)}`);
    lastNoPathLogTime = now;
    lastNoPathLogDistBucket = distBucket;
  }
  currentPath = [];
  currentWaypointIndex = 0;
  return false;
}

/**
 * Move toward a grid position by sending a raw movement packet.
 * Uses isometric formula from entity_actions.js / movement.js.
 * Simple direct movement - pathfinding handles obstacle avoidance via waypoints.
 */
function sendMoveAngleLimited(angleDeg, dist, force = false) {
  const now = Date.now();
  const minGap = Math.max(120, currentSettings.moveIntervalMs || 200);
  if (!force && now < dodgeMoveSuppressUntil) return false;
  if (!force && now - lastMovePacketTime < minGap) return false;
  if (!force && now - lastStopPacketTime < 120) return false; // avoid move/stop spam toggling
  const sent = moveAngle(angleDeg, dist);
  if (sent) lastMovePacketTime = now;
  return sent;
}

function sendStopMovementLimited(force = false) {
  const now = Date.now();
  if (!force && now - lastStopPacketTime < 300) return false;
  const sent = stopMovement();
  if (sent !== false) lastStopPacketTime = now;
  return sent;
}

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

  return sendMoveAngleLimited(screenAngleDeg, Math.round(moveDist));
}

function gridVectorToScreenAngleDeg(dx, dy) {
  const screenX = dx - dy;
  const screenY = (dx + dy) / 2;
  return Math.atan2(screenY, screenX) * 180 / Math.PI;
}

function quickClearanceScore(gx, gy) {
  const step = 8;
  let free = 0;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      if (ox === 0 && oy === 0) continue;
      if (poe2.isWalkable(Math.floor(gx + ox * step), Math.floor(gy + oy * step))) free++;
    }
  }
  return free;
}

function getBossApproachWalkablePoint(playerGX, playerGY, bossGX, bossGY, desiredRange) {
  const desired = Math.max(16, Math.min(65, desiredRange || 40));
  if (poe2.isWalkable(Math.floor(bossGX), Math.floor(bossGY))) {
    return { x: bossGX, y: bossGY };
  }

  // Prefer points on the ring around boss that are walkable and closer to player heading.
  const toPlayerA = Math.atan2(playerGY - bossGY, playerGX - bossGX);
  const radii = [desired, Math.max(14, desired - 8), desired + 10, desired + 18];
  const angleOffsets = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, Math.PI];
  let best = null;
  let bestScore = -Infinity;
  for (const r of radii) {
    for (const off of angleOffsets) {
      const a = toPlayerA + off;
      const tx = bossGX + Math.cos(a) * r;
      const ty = bossGY + Math.sin(a) * r;
      if (!poe2.isWalkable(Math.floor(tx), Math.floor(ty))) continue;
      const dp = Math.hypot(tx - playerGX, ty - playerGY);
      const clear = quickClearanceScore(tx, ty);
      const score = clear * 7 - dp * 0.2 - Math.abs(r - desired) * 0.9;
      if (score > bestScore) {
        bestScore = score;
        best = { x: tx, y: ty };
      }
    }
  }
  return best;
}

function getWalkableDirectionalTarget(playerGX, playerGY, dirX, dirY) {
  const len = Math.hypot(dirX, dirY);
  if (len < 1e-3) return null;
  const ux = dirX / len;
  const uy = dirY / len;
  const baseA = Math.atan2(uy, ux);
  const offsets = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05];
  const dists = [125, 96, 72];

  for (const d of dists) {
    for (const off of offsets) {
      const a = baseA + off;
      const tx = playerGX + Math.cos(a) * d;
      const ty = playerGY + Math.sin(a) * d;
      if (poe2.isWalkable(Math.floor(tx), Math.floor(ty))) return { x: tx, y: ty };
    }
  }
  return null;
}

function normalizeRad(a) {
  while (a <= -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
}

function getEntityFacingRad(entity) {
  // Prefer XY direction vector if available; often more stable than raw Z for monsters.
  // Fallback: infer from XY rotation vector if available.
  if (entity && Number.isFinite(entity.rotationX) && Number.isFinite(entity.rotationY)) {
    const mag = Math.hypot(entity.rotationX, entity.rotationY);
    if (mag > 1e-3) return Math.atan2(entity.rotationY, entity.rotationX);
  }
  // rotationZ is used elsewhere as yaw-like rotation.
  if (entity && Number.isFinite(entity.rotationZ)) return entity.rotationZ;
  return null;
}

function tryBossDodgeRollBehind(player, bossEntity, now) {
  if (!currentSettings.bossDodgeRollEnabled) return false;
  if (!bossEntity) return false;
  // Let the fight settle briefly before first dodge roll.
  if (bossFightEngagedAt > 0 && now - bossFightEngagedAt < 500) return false;
  if (now - lastBossDodgeRollTime < Math.max(500, currentSettings.bossDodgeRollIntervalMs || 800)) return false;

  let facingRad = getEntityFacingRad(bossEntity);
  // If explicit rotation isn't available, approximate facing as "toward player".
  if (facingRad === null) {
    facingRad = Math.atan2(player.gridY - bossEntity.gridY, player.gridX - bossEntity.gridX);
  }

  const minDeg = Math.max(0, Math.min(45, currentSettings.bossDodgeBehindMinDeg || 6));
  const maxDeg = Math.max(minDeg, Math.min(70, currentSettings.bossDodgeBehindMaxDeg || 20));
  const distToBoss = Math.hypot(player.gridX - bossEntity.gridX, player.gridY - bossEntity.gridY);
  let baseRadius = Math.max(20, Math.min(85, currentSettings.bossDodgeRollDistance || 46));
  const localClear = quickClearanceScore(player.gridX, player.gridY);
  // Adaptive radius: reduce dodge distance in cramped areas to avoid wall-hugging.
  if (localClear <= 3) baseRadius = Math.min(baseRadius, 34);
  else if (localClear <= 5) baseRadius = Math.min(baseRadius, 40);

  const faceX = Math.cos(facingRad);
  const faceY = Math.sin(facingRad);
  const behindRad = normalizeRad(facingRad + Math.PI);
  const offsetsDeg = [0, minDeg, -minDeg, maxDeg, -maxDeg, 26, -26];
  const radii = [baseRadius, Math.max(22, baseRadius - 8), Math.min(85, baseRadius + 8)];

  function sideBiasScore(sideSign) {
    // Compare free space on each side behind the boss.
    // sideSign > 0: right side arc, sideSign < 0: left side arc.
    const probeA = behindRad + sideSign * (28 * Math.PI / 180);
    const probeB = behindRad + sideSign * (44 * Math.PI / 180);
    const ax = bossEntity.gridX + Math.cos(probeA) * (baseRadius * 0.9);
    const ay = bossEntity.gridY + Math.sin(probeA) * (baseRadius * 0.9);
    const bx = bossEntity.gridX + Math.cos(probeB) * (baseRadius * 1.05);
    const by = bossEntity.gridY + Math.sin(probeB) * (baseRadius * 1.05);
    return quickClearanceScore(ax, ay) + quickClearanceScore(bx, by);
  }

  const leftSideScore = sideBiasScore(-1);
  const rightSideScore = sideBiasScore(1);
  const preferredSide = leftSideScore >= rightSideScore ? -1 : 1;

  // Far-from-boss mode: roll AROUND the boss first (side arc), then behind logic resumes.
  if (distToBoss > 80) {
    const aroundBase = Math.atan2(player.gridY - bossEntity.gridY, player.gridX - bossEntity.gridX);
    const aroundOffsetsDeg = [55, 70, 85];
    const aroundRadii = [Math.max(34, Math.min(62, distToBoss * 0.78)), Math.max(30, Math.min(56, distToBoss * 0.66))];

    let bestAround = null;
    let bestAroundScore = -Infinity;
    const sideOrder = [preferredSide, -preferredSide];
    for (const side of sideOrder) {
      for (const off of aroundOffsetsDeg) {
        const ang = normalizeRad(aroundBase + side * (off * Math.PI / 180));
        for (const r of aroundRadii) {
          const lx = bossEntity.gridX + Math.cos(ang) * r;
          const ly = bossEntity.gridY + Math.sin(ang) * r;
          if (!poe2.isWalkable(Math.floor(lx), Math.floor(ly))) continue;
          const clearance = quickClearanceScore(lx, ly);
          if (clearance < 4) continue;
          const travel = Math.hypot(lx - player.gridX, ly - player.gridY);
          const score = clearance * 11 - travel * 0.18 + (side === preferredSide ? 10 : 0);
          if (score > bestAroundScore) {
            bestAroundScore = score;
            bestAround = { x: lx, y: ly, sideSign: side };
          }
        }
      }
    }

    if (bestAround) {
      const toLandingX = bestAround.x - player.gridX;
      const toLandingY = bestAround.y - player.gridY;
      const screenAngle = gridVectorToScreenAngleDeg(toLandingX, toLandingY);
      const deltas = angleToDeltas(screenAngle, Math.max(18, Math.min(90, Math.hypot(toLandingX, toLandingY))));
      if (Number.isFinite(deltas.dx) && Number.isFinite(deltas.dy)) {
        const dodgeRollPacketBytes = [128, 0, 0, 64];
        const ok = executeChanneledSkill(dodgeRollPacketBytes, deltas.dx, deltas.dy, 1);
        if (ok) {
          bossOrbitDir = bestAround.sideSign >= 0 ? 1 : -1;
          lastBossDodgeRollTime = now;
          bossDodgeLandingX = bestAround.x;
          bossDodgeLandingY = bestAround.y;
          bossDodgeLandingTime = now;
          dodgeMoveSuppressUntil = now + 520;
          lastMovePacketTime = now;
          lastStopPacketTime = now;
          return true;
        }
      }
    }
  }

  let bestLanding = null;
  let bestScore = -Infinity;
  for (const offDeg of offsetsDeg) {
    const ang = normalizeRad(facingRad + Math.PI + offDeg * Math.PI / 180);
    const sideSign = offDeg >= 0 ? 1 : -1;
    for (const r of radii) {
      const lx = bossEntity.gridX + Math.cos(ang) * r;
      const ly = bossEntity.gridY + Math.sin(ang) * r;
      if (!poe2.isWalkable(Math.floor(lx), Math.floor(ly))) continue;

      // Keep landing behind boss: boss->landing should be opposite facing (dot < 0).
      const bossToLX = lx - bossEntity.gridX;
      const bossToLY = ly - bossEntity.gridY;
      const bossToLLen = Math.hypot(bossToLX, bossToLY) || 1;
      const bossToLDotFace = (bossToLX / bossToLLen) * faceX + (bossToLY / bossToLLen) * faceY;
      if (bossToLDotFace > -0.12) continue; // reject front/side-ish spots

      // Prefer roll vector away from boss-facing attack direction.
      const rollVX = lx - player.gridX;
      const rollVY = ly - player.gridY;
      const rollVLen = Math.hypot(rollVX, rollVY) || 1;
      const rollDotFace = (rollVX / rollVLen) * faceX + (rollVY / rollVLen) * faceY; // want more negative

      const clearance = quickClearanceScore(lx, ly);
      // Extra wall-hug penalty around landing.
      const wallPenalty = Math.max(0, 6 - clearance) * 6;
      const rollDist = Math.hypot(rollVX, rollVY);
      const distPenalty = Math.abs(rollDist - baseRadius) * 0.12;
      const sideBonus = sideSign === preferredSide ? 14 : -14;
      const score =
        clearance * 12 +
        (-bossToLDotFace) * 22 +
        (-rollDotFace) * 35 +
        sideBonus -
        wallPenalty -
        distPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestLanding = { x: lx, y: ly, sideSign };
      }
    }
  }

  if (!bestLanding) return false;

  const toLandingX = bestLanding.x - player.gridX;
  const toLandingY = bestLanding.y - player.gridY;
  const screenAngle = gridVectorToScreenAngleDeg(toLandingX, toLandingY);
  const deltas = angleToDeltas(screenAngle, Math.max(18, Math.min(90, Math.hypot(toLandingX, toLandingY))));
  if (!Number.isFinite(deltas.dx) || !Number.isFinite(deltas.dy)) return false;

  // Skill bytes from Rotation Builder export for DodgeRollPlayer:
  // [marker, slot, typeHi, typeLo] == [0x80, 0x00, 0x00, 0x40]
  const dodgeRollPacketBytes = [128, 0, 0, 64];
  const ok = executeChanneledSkill(dodgeRollPacketBytes, deltas.dx, deltas.dy, 1);
  if (ok) {
    // Keep orbit direction consistent with chosen dodge side
    // so we don't immediately cut back across boss front.
    bossOrbitDir = bestLanding.sideSign >= 0 ? 1 : -1;
    lastBossDodgeRollTime = now;
    bossDodgeLandingX = bestLanding.x;
    bossDodgeLandingY = bestLanding.y;
    bossDodgeLandingTime = now;
    // Keep mapper from immediately sending move packets into/after the channel sequence.
    dodgeMoveSuppressUntil = now + 520;
    lastMovePacketTime = now;
    lastStopPacketTime = now;
    return true;
  }
  return false;
}

function tryBossEmergencyRollOut(player, bossEntity, now) {
  if (!currentSettings.bossDodgeRollEnabled) return false;
  if (!bossEntity) return false;
  if (now - lastBossEmergencyRollTime < 120) return false;
  if (now - lastBossDodgeRollTime < 120) return false;

  const awayAngle = Math.atan2(player.gridY - bossEntity.gridY, player.gridX - bossEntity.gridX);
  const offsetsDeg = [0, 30, -30, 55, -55, 80, -80];
  const radii = [96, 82, 68];
  let best = null;
  let bestScore = -Infinity;
  for (const off of offsetsDeg) {
    const a = awayAngle + (off * Math.PI / 180);
    for (const r of radii) {
      const tx = player.gridX + Math.cos(a) * r;
      const ty = player.gridY + Math.sin(a) * r;
      if (!poe2.isWalkable(Math.floor(tx), Math.floor(ty))) continue;

      const awayDot = ((tx - player.gridX) * Math.cos(awayAngle) + (ty - player.gridY) * Math.sin(awayAngle)) / (Math.hypot(tx - player.gridX, ty - player.gridY) || 1);
      if (awayDot < 0.4) continue;
      const clear = quickClearanceScore(tx, ty);
      const score = clear * 12 + r * 0.5 + awayDot * 30;
      if (score > bestScore) {
        bestScore = score;
        best = { x: tx, y: ty };
      }
    }
  }
  if (!best) return false;

  const toX = best.x - player.gridX;
  const toY = best.y - player.gridY;
  const screenAngle = gridVectorToScreenAngleDeg(toX, toY);
  const deltas = angleToDeltas(screenAngle, Math.max(24, Math.min(120, Math.hypot(toX, toY))));
  if (!Number.isFinite(deltas.dx) || !Number.isFinite(deltas.dy)) return false;

  const dodgeRollPacketBytes = [128, 0, 0, 64];
  const ok = executeChanneledSkill(dodgeRollPacketBytes, deltas.dx, deltas.dy, 1);
  if (!ok) return false;
  lastBossEmergencyRollTime = now;
  lastBossDodgeRollTime = now;
  dodgeMoveSuppressUntil = now + 140;
  lastMovePacketTime = now;
  lastStopPacketTime = now;
  return true;
}

function isNonMapArea(areaInfo) {
  if (!areaInfo || !areaInfo.isValid) return false;
  const areaName = `${areaInfo.areaName || ''}`.toLowerCase();
  const areaId = `${areaInfo.areaId || ''}`.toLowerCase();
  const key = `${areaName} ${areaId}`;

  // Conservative block-list for known non-map hubs.
  // (Hideouts/towns are where mapper should never run.)
  return key.includes('hideout') || key.includes('town') || key.includes('encampment');
}

function getFightMonsterSnapshot(now, fightScanRadius) {
  const interval = Math.max(120, currentSettings.fightEntityScanIntervalMs || 220);
  if (now - fightSnapshotTime < interval && fightSnapshotAll && fightSnapshotAll.length > 0) {
    return { all: fightSnapshotAll, alive: fightSnapshotAlive };
  }

  const all = POE2Cache.getEntities({
    type: 'Monster',
    lightweight: true,
    maxDistance: fightScanRadius
  }) || [];
  const alive = all.filter(e => isHostileAlive(e));

  fightSnapshotTime = now;
  fightSnapshotAll = all;
  fightSnapshotAlive = alive;
  return { all, alive };
}

function stepFightDirectMove(player, tx, ty, now, arrivalDist = 12) {
  const dx = tx - player.gridX;
  const dy = ty - player.gridY;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= arrivalDist) return 'arrived';
  if (now - lastMoveTime >= currentSettings.moveIntervalMs) {
    moveTowardGridPos(player.gridX, player.gridY, tx, ty);
    lastMoveTime = now;
  }
  return 'walking';
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
      sendMoveAngleLimited(randomAngle, currentSettings.stuckMoveDistance);
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
    sendStopMovementLimited();
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
  // Combat waypoints can thrash path solver/logging if retried too fast.
  if (targetName && targetName.includes('Boss Kite Waypoint')) {
    repathInterval = Math.max(repathInterval, 1600);
  } else if (targetName && targetName.includes('Boss Reposition')) {
    repathInterval = Math.max(repathInterval, 1200);
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
  const now = Date.now();
  const nextPathType = pathType || '';
  const sameTarget =
    targetName === name &&
    targetPathType === nextPathType &&
    Math.abs(targetGridX - gx) < 8 &&
    Math.abs(targetGridY - gy) < 8;

  // Avoid resetting path every tick when repeatedly asking for the same run target.
  if (sameTarget && currentPath.length > 0 && now - lastRepathTime < 260) {
    return;
  }

  targetGridX = gx;
  targetGridY = gy;
  targetName = name;
  targetPathType = nextPathType;  // 'temple' or 'boss'
  currentPath = [];
  currentWaypointIndex = 0;
  lastRepathTime = 0;
  lastPositionChangeTime = now;
  stuckCount = 0;

  const noisyFightMove =
    name === 'Boss Kite Waypoint' || name === 'Boss Reposition';

  const sameLogTarget =
    lastStartWalkLogName === name &&
    lastStartWalkLogPathType === nextPathType &&
    Math.abs(lastStartWalkLogX - gx) < 10 &&
    Math.abs(lastStartWalkLogY - gy) < 10;
  const minLogGap = noisyFightMove ? 4500 : 1400;
  if (!sameLogTarget || now - lastStartWalkLogTime > minLogGap) {
    log(`Walking to ${name} at (${gx.toFixed(0)}, ${gy.toFixed(0)}) [pathType=${nextPathType || 'none'}]`);
    lastStartWalkLogTime = now;
    lastStartWalkLogName = name;
    lastStartWalkLogPathType = nextPathType;
    lastStartWalkLogX = gx;
    lastStartWalkLogY = gy;
  }
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

function getUtilityTargetKey(candidate) {
  if (!candidate) return '';
  if (candidate.id && candidate.id !== 0) {
    return `${candidate.type || 'utility'}:id:${candidate.id}`;
  }
  const q = Math.max(10, Math.floor(currentSettings.utilityBlacklistMergeRadius || 38));
  const qx = Math.floor((candidate.x || 0) / q);
  const qy = Math.floor((candidate.y || 0) / q);
  const label = `${candidate.type || 'utility'}:${candidate.source || ''}:${candidate.meta?.name || ''}`;
  return `${label}:${qx}:${qy}`;
}

function isUtilityTargetIgnored(candidate) {
  const key = getUtilityTargetKey(candidate);
  if (!key) return false;
  return ignoredUtilityTargets.has(key);
}

function addIgnoredUtilityTarget(candidate, reason) {
  const key = getUtilityTargetKey(candidate);
  if (!key || ignoredUtilityTargets.has(key)) return;
  ignoredUtilityTargets.add(key);
  utilityStats.blacklistedCount = ignoredUtilityTargets.size;
  const name = candidate?.meta?.name || candidate?.type || 'target';
  logUtility(`Utility blacklist add (${reason}): ${name}`, `utility:blacklist:${key}`, 1200);
}

function selectBestUtilityCandidate(candidates) {
  if (!candidates || candidates.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    if (!c) continue;
    // During checkpoint approach, prefer nearby utility to ensure we actually divert.
    const distWeight = currentState === STATE.WALKING_TO_BOSS_CHECKPOINT ? 0.42 : 0.35;
    const score = (c.priority || 0) - (c.distance || 0) * distWeight;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function pickUtilityDetour(playerGX, playerGY, tx, ty) {
  const toTargetX = tx - playerGX;
  const toTargetY = ty - playerGY;
  const toTargetLen = Math.hypot(toTargetX, toTargetY);
  if (toTargetLen < 1) return null;
  const ux = toTargetX / toTargetLen;
  const uy = toTargetY / toTargetLen;
  const baseAngle = Math.atan2(toTargetY, toTargetX);
  const angleOffsets = [Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2];
  const radii = [75, 110, 145];

  let best = null;
  let bestScore = -Infinity;
  for (const off of angleOffsets) {
    const a = baseAngle + off;
    const dirX = Math.cos(a);
    const dirY = Math.sin(a);
    for (const r of radii) {
      const px = playerGX + dirX * r;
      const py = playerGY + dirY * r;
      if (!poe2.isWalkable(Math.floor(px), Math.floor(py))) continue;
      const toward = dirX * ux + dirY * uy;
      const score = toward * 100 + getWalkableClearanceScore(px, py) * 4 + r * 0.06;
      if (score > bestScore) {
        bestScore = score;
        best = { x: px, y: py };
      }
    }
  }
  return best;
}

function getOpenableUtilityCandidates(player) {
  if (!currentSettings.walkToOpenablesEnabled) return [];
  const maxDist = Math.max(30, currentSettings.openableWalkRadius || 200);
  const openerTargets = getOpenableCandidatesForMapper(maxDist) || [];
  const out = [];
  for (const t of openerTargets) {
    if (!t?.entity) continue;
    const e = t.entity;
    const dist = Math.hypot((e.gridX || 0) - player.gridX, (e.gridY || 0) - player.gridY);
    if (!Number.isFinite(dist) || dist > maxDist) continue;
    if (t.type === 'Chest') {
      const chestRarity = Number.isFinite(e.rarity) ? e.rarity : -1;
      const isMagicOrHigher = chestRarity >= 1 || e.chestIsStrongbox === true;
      if (!currentSettings.walkToNormalChestsEnabled && !isMagicOrHigher) {
        continue;
      }
    }
    const c = {
      type: 'openable',
      id: e.id || 0,
      x: e.gridX,
      y: e.gridY,
      priority: t.type === 'Strongbox' ? 32 : t.type === 'Shrine' ? 26 : 22,
      distance: dist,
      source: 'opener',
      meta: {
        openableType: t.type,
        name: (e.renderName || e.name || '').split('/').pop() || 'Openable'
      }
    };
    if (!isUtilityTargetIgnored(c)) out.push(c);
  }
  return out;
}

function getLootUtilityCandidates(player) {
  if (!currentSettings.walkToLootEnabled) return [];
  const maxDist = Math.max(30, currentSettings.lootWalkRadius || 200);
  const lootTargets = getLootCandidatesForMapper(maxDist) || [];
  const out = [];
  for (const t of lootTargets) {
    if (!t?.entity) continue;
    const e = t.entity;
    const dist = Math.hypot((e.gridX || 0) - player.gridX, (e.gridY || 0) - player.gridY);
    if (!Number.isFinite(dist) || dist > maxDist) continue;
    const itemName = (t.itemData?.uniqueName || t.itemData?.baseName || t.itemData?.path || 'Loot').split('/').pop();
    const c = {
      type: 'loot',
      id: e.id || 0,
      x: e.gridX,
      y: e.gridY,
      priority: 18,
      distance: dist,
      source: 'pickit',
      meta: {
        ruleName: t.ruleName || '',
        name: itemName
      }
    };
    if (!isUtilityTargetIgnored(c)) out.push(c);
  }
  return out;
}

function getFutureUtilityCandidates() {
  // Placeholders for future provider expansion.
  if (currentSettings.walkToBreachTargetsEnabled) return [];
  if (currentSettings.walkToAbyssTargetsEnabled) return [];
  if (currentSettings.walkToFutureMechanicsEnabled) return [];
  return [];
}

function gatherUtilityCandidates(player) {
  const openables = getOpenableUtilityCandidates(player);
  const loot = getLootUtilityCandidates(player);
  const future = getFutureUtilityCandidates(player);
  const all = [...openables, ...loot, ...future];
  utilityStats.openableCandidates = openables.length;
  utilityStats.lootCandidates = loot.length;
  utilityStats.futureCandidates = future.length;
  utilityStats.totalCandidates = all.length;
  utilityStats.blacklistedCount = ignoredUtilityTargets.size;
  return all;
}

function canRunUtilityState() {
  return currentState === STATE.WALKING_TO_UTILITY;
}

function canInterruptForUtility() {
  // Allow utility during search/temple-walk states and checkpoint approach.
  // Keep melee/fight protected from utility interruptions.
  const isAllowedState =
    currentState === STATE.FINDING_TEMPLE ||
    currentState === STATE.FINDING_BOSS ||
    currentState === STATE.WALKING_TO_TEMPLE ||
    currentState === STATE.WALKING_TO_BOSS_CHECKPOINT;
  if (!isAllowedState) return false;

  // During checkpoint approach, allow utility even though boss target is already known.
  // In all other states, a committed boss objective should block utility.
  if (currentState !== STATE.WALKING_TO_BOSS_CHECKPOINT && (bossTgtFound || checkpointReached || bossFound)) return false;
  return true;
}

function reissueResumeStateTarget(resume) {
  if (resume === STATE.WALKING_TO_TEMPLE && Number.isFinite(templeGridX) && Number.isFinite(templeGridY)) {
    startWalkingTo(templeGridX, templeGridY, 'Temple', 'temple');
    return;
  }
  if (resume === STATE.WALKING_TO_BOSS_CHECKPOINT && Number.isFinite(bossGridX) && Number.isFinite(bossGridY)) {
    startWalkingTo(bossGridX, bossGridY, 'Boss Checkpoint', '');
    return;
  }
  if (resume === STATE.WALKING_TO_BOSS_MELEE && Number.isFinite(bossMeleeStaticX) && Number.isFinite(bossMeleeStaticY)) {
    startWalkingTo(bossMeleeStaticX, bossMeleeStaticY, 'Boss Melee (nearest unique)', '');
  }
}

function finishUtilityState() {
  let resume = utilityResumeState || STATE.FINDING_BOSS;
  utilityResumeState = STATE.IDLE;
  // If boss objective became available while doing utility, resume boss flow directly.
  if ((bossTgtFound || checkpointReached) && currentState === STATE.WALKING_TO_UTILITY) {
    resume = STATE.WALKING_TO_BOSS_CHECKPOINT;
  }
  if (currentState === STATE.WALKING_TO_UTILITY) {
    reissueResumeStateTarget(resume);
    setState(resume);
  }
}

function shouldReturnToTempleFromBossFlow() {
  // Do not bounce back to temple after boss objective is already committed.
  // This prevents delayed-engage bosses from resetting objective flow.
  if (checkpointReached || bossTgtFound || bossFound || currentState === STATE.WALKING_TO_BOSS_MELEE || currentState === STATE.FIGHTING_BOSS) {
    return false;
  }
  return !templeCleared;
}

function startUtilityState(selected) {
  utilityActiveTarget = selected;
  utilityNoPathCount = 0;
  utilityArrivalWaitStart = 0;
  utilityResumeState = currentState;
  setState(STATE.WALKING_TO_UTILITY);
  startWalkingTo(selected.x, selected.y, `Utility ${selected.type}`, '');
}

function tryStartUtilityNavigation(player, now) {
  if (!canInterruptForUtility()) return false;
  if (currentState !== STATE.WALKING_TO_BOSS_CHECKPOINT && (bossTgtFound || checkpointReached || bossFound)) return false;
  if (utilityActiveTarget && !isUtilityTargetIgnored(utilityActiveTarget)) {
    utilityResumeState = currentState;
    setState(STATE.WALKING_TO_UTILITY);
    return true;
  }
  const candidates = gatherUtilityCandidates(player);
  const selected = selectBestUtilityCandidate(candidates);
  if (!selected) return false;
  const key = getUtilityTargetKey(selected);
  if (utilityLastSelectedKey !== key) {
    utilityLastSelectedKey = key;
    logUtility(
      `Utility select: ${selected.type} (${selected.meta?.name || 'unknown'}) d=${selected.distance.toFixed(0)}`,
      `utility:select:${selected.type}`,
      900
    );
  }
  startUtilityState(selected);
  return true;
}

function runUtilityNavigationStep(player, now) {
  if (!canRunUtilityState()) return false;
  const threshold = Math.max(2, Math.floor(currentSettings.utilityNoPathBlacklistThreshold || 3));

  if (!utilityActiveTarget || isUtilityTargetIgnored(utilityActiveTarget)) {
    utilityActiveTarget = null;
    utilityNoPathCount = 0;
    utilityArrivalWaitStart = 0;
    finishUtilityState();
    return false;
  }

  if (!utilityActiveTarget) return false;

  const dx = utilityActiveTarget.x - player.gridX;
  const dy = utilityActiveTarget.y - player.gridY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const arriveDist = Math.max(currentSettings.arrivalThreshold, 20);
  if (dist <= arriveDist) {
    sendStopMovementLimited();
    if (utilityArrivalWaitStart === 0) utilityArrivalWaitStart = now;
    const lock = POE2Cache.isMovementLocked();
    const gotYield = lock.locked && (lock.source === 'opener' || lock.source === 'pickit');
    const waitMs = now - utilityArrivalWaitStart;
    const isOpenable = utilityActiveTarget?.type === 'openable';
    const sourceCooldown = isOpenable ? getOpenerCooldownMs() : getPickitCooldownMs();
    const maxWait = Math.max(700, sourceCooldown + 500);
    if (gotYield || waitMs > maxWait) {
      addIgnoredUtilityTarget(utilityActiveTarget, gotYield ? `handled:${lock.source}` : 'handled:arrived');
      utilityActiveTarget = null;
      utilityNoPathCount = 0;
      utilityArrivalWaitStart = 0;
      finishUtilityState();
    }
    statusMessage = `Utility wait: ${utilityActiveTarget?.type || 'target'} (${dist.toFixed(0)}u)`;
    return true;
  }

  if (targetName !== `Utility ${utilityActiveTarget.type}` && now > utilityDetourUntil) {
    startWalkingTo(utilityActiveTarget.x, utilityActiveTarget.y, `Utility ${utilityActiveTarget.type}`, '');
  }

  const result = stepPathWalker();
  statusMessage = `Utility move: ${utilityActiveTarget.type} (${dist.toFixed(0)}u)`;
  const noPath = result === 'stuck' || (result === 'walking' && currentPath.length === 0);
  if (!noPath) {
    utilityNoPathCount = 0;
    return true;
  }

  utilityNoPathCount++;
  if (utilityNoPathCount >= threshold) {
    addIgnoredUtilityTarget(utilityActiveTarget, 'failed:no-path');
    utilityActiveTarget = null;
    utilityNoPathCount = 0;
    utilityArrivalWaitStart = 0;
    finishUtilityState();
    return true;
  }

  const detour = pickUtilityDetour(player.gridX, player.gridY, utilityActiveTarget.x, utilityActiveTarget.y);
  if (detour) {
    utilityDetourUntil = now + 1200;
    startWalkingTo(detour.x, detour.y, 'Utility Detour', '');
  }
  return true;
}

function getMobExplorePriority(entity) {
  const subtype = (entity.entitySubtype || '').toLowerCase();
  if (subtype.includes('rare')) return 3;
  if (subtype.includes('magic')) return 2;
  return 1; // normal/other
}

/**
 * Pick a forward exploration mob target.
 * Priority: Rare -> Magic -> Normal, then forward progression, then distance.
 */
function pickBossExploreMobTarget(playerGX, playerGY, forwardX, forwardY) {
  const now = Date.now();
  if (cachedExploreMobTarget && now - lastExploreMobPickTime < 180) {
    return cachedExploreMobTarget;
  }

  const mobs = POE2Cache.getEntities({
    type: 'Monster',
    aliveOnly: true,
    lightweight: true,
    maxDistance: 260
  });
  if (!mobs || mobs.length === 0) {
    cachedExploreMobTarget = null;
    lastExploreMobPickTime = now;
    return null;
  }

  const fLen = Math.sqrt(forwardX * forwardX + forwardY * forwardY);
  const fx = fLen > 0.01 ? forwardX / fLen : 0;
  const fy = fLen > 0.01 ? forwardY / fLen : 0;

  let best = null;
  let bestScore = -Infinity;
  let bestAny = null;
  let bestAnyScore = -Infinity;

  for (const e of mobs) {
    if (!isHostileAlive(e)) continue;
    if (!e.isTargetable) continue; // explore by chasing targetable monsters only
    if (e.gridX === undefined || e.gridY === undefined) continue;
    if (isAbandonedTarget(e.gridX, e.gridY)) continue;

    const dx = e.gridX - playerGX;
    const dy = e.gridY - playerGY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 14 || dist > 260) continue;

    const priority = getMobExplorePriority(e);
    const dirScore = (fx === 0 && fy === 0) ? 0 : ((dx * fx + dy * fy) / dist); // [-1..1]
    const recentlyUsed =
      bossExploreLastTargetX !== 0 &&
      ((e.gridX - bossExploreLastTargetX) ** 2 + (e.gridY - bossExploreLastTargetY) ** 2) < 45 * 45;

    let score = priority * 1000 + dirScore * 160 + Math.min(dist, 220) * 0.35;
    if (recentlyUsed) score -= 600;
    if (templeFound) {
      const dtX = e.gridX - templeGridX;
      const dtY = e.gridY - templeGridY;
      score += Math.sqrt(dtX * dtX + dtY * dtY) * 0.05;
    }

    if (score > bestAnyScore) {
      bestAnyScore = score;
      bestAny = e;
    }

    // Prefer forward candidates; allow slight side movement, avoid going backward.
    if (dirScore < -0.15) continue;
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }

  const picked = best || bestAny;
  cachedExploreMobTarget = picked || null;
  lastExploreMobPickTime = now;
  return picked;
}

function isEndgameBossCheckpointEntity(entity) {
  const name = `${entity?.name || ''} ${entity?.renderName || ''}`.toLowerCase();
  return name.includes('checkpoint_endgame_boss');
}

function isBossApproachCandidate(entity) {
  if (!entity || !entity.isAlive) return false;
  if (entity.entityType !== 'Monster') return false;
  if (entity.entitySubtype !== 'MonsterUnique') return false;
  if (entity.entitySubtype === 'MonsterFriendly') return false;
  const path = `${entity.name || ''}`.toLowerCase();
  if (!path.includes('/monsters/')) return false;
  if (path.includes('checkpoint')) return false;
  if (path.includes('renderable')) return false;
  // Intentionally allow cannotBeDamaged / hidden flags here.
  // Bosses often spawn immune/hidden before engagement.
  return true;
}

function logBossMeleeTargetSelection(entity, playerGX, playerGY, reason = 'selected') {
  if (!entity) {
    logUtility(`Boss melee target (${reason}): none (using edge fallback)`, 'boss-melee-target:none', 900);
    return;
  }
  const dist = Math.hypot(entity.gridX - playerGX, entity.gridY - playerGY);
  const shortName = (entity.renderName || entity.name || 'Unknown').split('/').pop();
  const path = `${entity.name || ''}`;
  const t = `${entity.entityType || '?'}/${entity.entitySubtype || '?'}`;
  logUtility(
    `Boss melee target (${reason}): "${shortName}" id=${entity.id || 0} dist=${dist.toFixed(0)} type=${t} immune=${!!entity.cannotBeDamaged} hidden=${!!entity.isHiddenMonster} path=${path}`,
    `boss-melee-target:${entity.id || shortName}`,
    700
  );
}

function isLikelyMapBossEntity(entity, radarBoss = null) {
  if (!entity || entity.entityType !== 'Monster' || entity.entitySubtype !== 'MonsterUnique') return false;
  let score = 0;

  if (entityHasStat(entity, STAT_MAP_BOSS_DIFFICULTY_SCALING)) score += 6;
  if (entityHasStat(entity, STAT_MAP_BOSS_UNDERLING)) score -= 4;
  const n = (entity.name || '').toLowerCase();
  if (n.includes('mapboss') || n.includes('endgame_boss')) score += 4;
  if (entity.cannotBeDamaged || entity.isHiddenMonster) score += 1;

  if (radarBoss && entity.gridX !== undefined && entity.gridY !== undefined) {
    const dx = entity.gridX - radarBoss.x;
    const dy = entity.gridY - radarBoss.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 120) score += 4;
    else if (d < 220) score += 2;
  }

  return score >= 5;
}

function isUniqueNearBossArena(entity, radarBoss = null, anchorRadius = 240) {
  if (!entity || entity.entityType !== 'Monster' || entity.entitySubtype !== 'MonsterUnique') return false;
  if (entity.gridX === undefined || entity.gridY === undefined) return false;

  if (radarBoss) {
    const dr = Math.hypot(entity.gridX - radarBoss.x, entity.gridY - radarBoss.y);
    if (dr <= 190) return true;
  }
  if (Number.isFinite(bossGridX) && Number.isFinite(bossGridY) && (bossTgtFound || checkpointReached || bossTargetSource === 'arena_object')) {
    const da = Math.hypot(entity.gridX - bossGridX, entity.gridY - bossGridY);
    if (da <= anchorRadius) return true;
  }
  return false;
}

function getBossFullEntityCandidates(playerGX, playerGY, anchorX = null, anchorY = null, anchorRadius = 280) {
  const now = Date.now();
  if (now - bossMeleeFullScanTime < 260 && bossMeleeFullScanCache && bossMeleeFullScanCache.length > 0) {
    return bossMeleeFullScanCache;
  }

  const entities = poe2.getEntities({
    type: 'Monster',
    lightweight: false,
    maxDistance: 450
  }) || [];

  const candidates = [];
  for (const e of entities) {
    if (!e || e.entityType !== 'Monster') continue;
    if (e.entitySubtype === 'MonsterFriendly') continue;
    if (e.gridX === undefined || e.gridY === undefined) continue;
    const path = `${e.name || ''}`.toLowerCase();
    if (path.includes('checkpoint') || path.includes('renderable')) continue;

    const isUnique = e.entitySubtype === 'MonsterUnique';
    const isBossStat = entityHasStat(e, STAT_MAP_BOSS_DIFFICULTY_SCALING);
    const hasBossSignals = isUnique || isBossStat || !!e.cannotBeDamaged || !!e.isHiddenMonster;
    if (!hasBossSignals) continue;

    if (anchorX !== null && anchorY !== null) {
      const da = Math.hypot(e.gridX - anchorX, e.gridY - anchorY);
      if (da > anchorRadius) continue;
    }

    const distPlayer = Math.hypot(e.gridX - playerGX, e.gridY - playerGY);
    let score = 0;
    if (isBossStat) score += 85;
    if (isUnique) score += 60;
    if (e.cannotBeDamaged) score += 40;
    if (e.isHiddenMonster) score += 24;
    if (anchorX !== null && anchorY !== null) {
      const da = Math.hypot(e.gridX - anchorX, e.gridY - anchorY);
      score -= da * 1.2;
    }
    score -= distPlayer * 0.1;
    candidates.push({ entity: e, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  bossMeleeFullScanTime = now;
  bossMeleeFullScanCache = candidates;
  return candidates;
}

/**
 * Choose best boss checkpoint from candidates.
 * Prefers checkpoint aligned with radar boss endpoint and away from temple.
 */
function selectBestBossCheckpoint(checkpoints, radarBoss, playerGX, playerGY) {
  if (!checkpoints || checkpoints.length === 0) return null;

  let best = null;
  let bestScore = -Infinity;

  for (const cp of checkpoints) {
    if (!cp || cp.gridX === undefined || cp.gridY === undefined) continue;
    if (!isEndgameBossCheckpointEntity(cp)) continue; // strict filter: endgame boss checkpoint only
    if (isAbandonedTarget(cp.gridX, cp.gridY)) continue;

    const dxP = cp.gridX - playerGX;
    const dyP = cp.gridY - playerGY;
    const distPlayer = Math.sqrt(dxP * dxP + dyP * dyP);

    let score = 0;

    // Prefer farther checkpoints so we don't retarget to nearby wrong nodes.
    score += distPlayer * 0.1;

    if (templeFound) {
      const dxT = cp.gridX - templeGridX;
      const dyT = cp.gridY - templeGridY;
      const distTemple = Math.sqrt(dxT * dxT + dyT * dyT);
      score += distTemple * 0.15;
    }

    // Strong preference: checkpoint close to radar boss endpoint.
    if (radarBoss) {
      const dxR = cp.gridX - radarBoss.x;
      const dyR = cp.gridY - radarBoss.y;
      const distRadar = Math.sqrt(dxR * dxR + dyR * dyR);
      score -= distRadar * 1.2;
    }

    if (score > bestScore) {
      bestScore = score;
      best = cp;
    }
  }

  return best;
}

/**
 * Find best nearby unique boss candidate while approaching boss room.
 * Prefers existing candidate ID for stability, then nearest unique.
 */
function findBossCandidateUnique(playerGX, playerGY, maxDist, anchorX = null, anchorY = null, anchorRadius = Infinity) {
  const uniques = poe2.getEntities({
    type: 'Monster',
    subtype: 'MonsterUnique',
    aliveOnly: true,
    lightweight: false,
    maxDistance: maxDist,
  });
  if (!uniques || uniques.length === 0) return null;

  const maxDistSq = maxDist * maxDist;
  const anchorRadiusSq = anchorRadius * anchorRadius;

  // Keep existing candidate when possible to avoid target thrash.
  if (bossCandidateId) {
    for (const e of uniques) {
      if (!isBossApproachCandidate(e)) continue;
      if (e.id !== bossCandidateId) continue;
      const dx = e.gridX - playerGX;
      const dy = e.gridY - playerGY;
      if (anchorX !== null && anchorY !== null) {
        const ax = e.gridX - anchorX;
        const ay = e.gridY - anchorY;
        if (ax * ax + ay * ay > anchorRadiusSq) continue;
      }
      if (dx * dx + dy * dy <= maxDistSq) return e;
    }
  }

  let best = null;
  let bestDistSq = maxDistSq;
  for (const e of uniques) {
    if (!isBossApproachCandidate(e)) continue;
    if (anchorX !== null && anchorY !== null) {
      const ax = e.gridX - anchorX;
      const ay = e.gridY - anchorY;
      if (ax * ax + ay * ay > anchorRadiusSq) continue;
    }
    const dx = e.gridX - playerGX;
    const dy = e.gridY - playerGY;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = e;
    }
  }
  return best;
}

/**
 * Find likely boss-room anchor objects when checkpoint is hidden.
 * Uses strict metadata name patterns and full entity reads for reliable coords.
 */
function findBossRoomObjectAnchor(playerGX, playerGY, radarBoss = null) {
  const now = Date.now();
  if (cachedBossRoomAnchor && now - lastBossRoomAnchorScanTime < 1200) {
    return cachedBossRoomAnchor;
  }

  const candidates = [];

  for (const pattern of BOSS_ROOM_OBJECT_PATTERNS) {
    const ents = poe2.getEntities({
      nameContains: pattern,
      lightweight: false,
    }) || [];
    for (const e of ents) {
      if (!e) continue;

      // Some boss-room objects report component grid as (0,0).
      // Prefer component grid, but fall back to legacy grid when needed.
      let gx = Number.isFinite(e.gridX) ? e.gridX : null;
      let gy = Number.isFinite(e.gridY) ? e.gridY : null;
      const rawLooksInvalid = gx === null || gy === null || (Math.abs(gx) <= 1 && Math.abs(gy) <= 1);
      if (rawLooksInvalid) {
        const lgx = Number.isFinite(e.legacyGridX) ? e.legacyGridX : null;
        const lgy = Number.isFinite(e.legacyGridY) ? e.legacyGridY : null;
        if (lgx !== null && lgy !== null && !(Math.abs(lgx) <= 1 && Math.abs(lgy) <= 1)) {
          gx = lgx;
          gy = lgy;
        }
      }

      // Hard reject invalid origin anchors.
      if (gx === null || gy === null || (Math.abs(gx) <= 1 && Math.abs(gy) <= 1)) continue;
      if (isAbandonedTarget(gx, gy)) continue;
      candidates.push({ ...e, anchorGridX: gx, anchorGridY: gy });
    }
  }

  if (candidates.length === 0) {
    cachedBossRoomAnchor = null;
    lastBossRoomAnchorScanTime = now;
    return null;
  }

  let best = null;
  let bestScore = -Infinity;
  for (const e of candidates) {
    const gx = e.anchorGridX;
    const gy = e.anchorGridY;
    const dxP = gx - playerGX;
    const dyP = gy - playerGY;
    const distPlayer = Math.sqrt(dxP * dxP + dyP * dyP);

    let score = 0;
    const n = (e.name || '').toLowerCase();
    if (n.includes('bossarenablocker')) score += 35;
    if (n.includes('bossforcefielddoorvisuals')) score += 28;
    if (n.includes('bossarenalocker')) score += 22;

    // Prefer anchors that are not right on top of player.
    score += Math.min(distPlayer, 280) * 0.08;

    // Prefer farther from temple to avoid entrance/starting side noise.
    if (templeFound) {
      const dxT = gx - templeGridX;
      const dyT = gy - templeGridY;
      score += Math.sqrt(dxT * dxT + dyT * dyT) * 0.10;
    }

    // If radar boss endpoint exists, anchor near it gets a strong boost.
    if (radarBoss) {
      const dxR = gx - radarBoss.x;
      const dyR = gy - radarBoss.y;
      const distRadar = Math.sqrt(dxR * dxR + dyR * dyR);
      score -= distRadar * 1.0;
    }

    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }

  cachedBossRoomAnchor = best;
  lastBossRoomAnchorScanTime = now;
  return best;
}

/**
 * Detect if boss is already engaged while we are still in approach states.
 * Primary signals:
 *  - HP is not full
 *  - HP changes over time (usually means active combat)
 */
function detectActiveBossEngagement(playerGX, playerGY, nowMs, maxEngageDistance = 58) {
  if (nowMs - lastBossEngageProbeTime < 350 && maxEngageDistance === lastBossEngageProbeMaxDistance) return cachedBossEngageProbe;
  lastBossEngageProbeTime = nowMs;
  lastBossEngageProbeMaxDistance = maxEngageDistance;

  const radarBoss = getRadarBossTarget();
  const uniques = poe2.getEntities({
    type: 'Monster',
    subtype: 'MonsterUnique',
    aliveOnly: true,
    lightweight: false,
    maxDistance: 280,
  }) || [];

  let best = null;
  let bestScore = -Infinity;
  const hpChangeWindowMs = 4000;
  const hpSampleStaleMs = 12000;
  const anchorX = Number.isFinite(bossGridX) ? bossGridX : null;
  const anchorY = Number.isFinite(bossGridY) ? bossGridY : null;
  const anchorRadius = checkpointReached ? 210 : 280;

  for (const e of uniques) {
    if (!isBossApproachCandidate(e)) continue;
    if (e.gridX === undefined || e.gridY === undefined) continue;

    const isLockedCandidate = bossCandidateId && e.id === bossCandidateId;
    let likelyBoss = isLockedCandidate || isLikelyMapBossEntity(e, radarBoss) || isUniqueNearBossArena(e, radarBoss, checkpointReached ? 240 : 280);
    // Fallback for delayed/odd bosses: once checkpoint is reached, allow uniques
    // near radar/anchor region if they show real combat signals.
    if (!likelyBoss && checkpointReached && radarBoss) {
      const dr = Math.hypot(e.gridX - radarBoss.x, e.gridY - radarBoss.y);
      if (dr <= 170) likelyBoss = true;
    }
    if (!likelyBoss) continue;
    if (!isLockedCandidate && anchorX !== null && anchorY !== null) {
      const dax = e.gridX - anchorX;
      const day = e.gridY - anchorY;
      if (dax * dax + day * day > anchorRadius * anchorRadius) continue;
    }

    const hpCur = Number.isFinite(e.healthCurrent) ? e.healthCurrent : null;
    const hpMax = Number.isFinite(e.healthMax) ? e.healthMax : null;
    const hpNotFull = hpCur !== null && hpMax !== null && hpMax > 0 && hpCur < hpMax;

    let hpChanging = false;
    if (hpCur !== null && e.id) {
      const prev = bossHpSamples.get(e.id);
      if (prev && (nowMs - prev.t) <= hpChangeWindowMs && Math.abs(hpCur - prev.hp) >= 1) {
        hpChanging = true;
      }
      bossHpSamples.set(e.id, { hp: hpCur, t: nowMs });
    }

    const distToPlayer = Math.hypot(e.gridX - playerGX, e.gridY - playerGY);
    if (distToPlayer > maxEngageDistance) continue;
    const targetableOpen = !!e.isTargetable && !e.cannotBeDamaged;
    const nearbyCombatSignal = targetableOpen && distToPlayer < 120;
    const engaged = hpNotFull || hpChanging || nearbyCombatSignal;
    if (!engaged) continue;

    let score = 0;
    if (hpChanging) score += 80;
    if (hpNotFull) score += 70;
    if (nearbyCombatSignal) score += 30;
    score -= distToPlayer * 0.2;
    if (isLockedCandidate) score += 30;
    if (isLikelyMapBossEntity(e, radarBoss)) score += 20;

    if (score > bestScore) {
      bestScore = score;
      best = {
        entity: e,
        reason: hpChanging ? 'hp-changing' : (hpNotFull ? 'hp-not-full' : 'targetable'),
      };
    }
  }

  for (const [id, sample] of bossHpSamples.entries()) {
    if (nowMs - sample.t > hpSampleStaleMs) bossHpSamples.delete(id);
  }

  cachedBossEngageProbe = best;

  if (best && best.entity) {
    const e = best.entity;
    const hpCur = Number.isFinite(e.healthCurrent) ? e.healthCurrent : 0;
    const hpMax = Number.isFinite(e.healthMax) ? e.healthMax : 0;
    const dist = Math.hypot(e.gridX - playerGX, e.gridY - playerGY);
    const debugKey = `${e.id || 0}:${best.reason}`;
    if (debugKey !== lastBossEngageDebugKey || nowMs - lastBossEngageDebugTime > 2000) {
      const bossName = (e.renderName || e.name || 'Unknown').split('/').pop();
      log(`Engage detector: ${best.reason} on "${bossName}" id=${e.id || 0} hp=${hpCur}/${hpMax} dist=${dist.toFixed(0)}`);
      lastBossEngageDebugKey = debugKey;
      lastBossEngageDebugTime = nowMs;
    }
  }

  return best;
}

/**
 * Choose wall-aware orbit movement while keeping one dominant direction.
 * Reverse/backtrack is only allowed briefly after repeated forward blocks.
 */
function getWallAwareOrbitStep(playerGX, playerGY, targetGX, targetGY, distToTarget, nowMs) {
  const ORBIT_RADIUS = 32;
  const ORBIT_SPEED = 28;
  const BLOCKS_BEFORE_REVERSE = 3;
  const REVERSE_WINDOW_MS = 1200;

  const angleToTarget = Math.atan2(targetGY - playerGY, targetGX - playerGX);
  const radialOut = angleToTarget + Math.PI;
  const radialIn = angleToTarget;

  const candidates = [];

  function addTangentCandidate(dir, radialCorrection = 0, speed = ORBIT_SPEED, mode = 'forward') {
    const tangentAngle = angleToTarget + (Math.PI / 2) * dir;
    candidates.push({
      x: playerGX + Math.cos(tangentAngle) * speed + Math.cos(angleToTarget) * radialCorrection,
      y: playerGY + Math.sin(tangentAngle) * speed + Math.sin(angleToTarget) * radialCorrection,
      mode,
      dir
    });
  }

  // Radial correction to keep a stable ring around the boss.
  let radialCorrection = 0;
  if (distToTarget < ORBIT_RADIUS - 5) radialCorrection = -10;
  else if (distToTarget > ORBIT_RADIUS + 5) radialCorrection = 10;

  // Forward-only by default.
  addTangentCandidate(bossOrbitDir, radialCorrection, ORBIT_SPEED, 'forward');
  addTangentCandidate(bossOrbitDir, -12, ORBIT_SPEED * 0.9, 'forward');
  addTangentCandidate(bossOrbitDir, 12, ORBIT_SPEED * 0.9, 'forward');

  // If temporarily allowed, add bounded reverse options.
  if (nowMs < bossOrbitReverseUntil) {
    addTangentCandidate(-bossOrbitDir, radialCorrection, ORBIT_SPEED * 0.8, 'reverse');
  }

  // Local recovery (not a long reverse): tiny sidestep and radial nudge.
  candidates.push({
    x: playerGX + Math.cos(angleToTarget + (Math.PI / 2) * bossOrbitDir) * 14,
    y: playerGY + Math.sin(angleToTarget + (Math.PI / 2) * bossOrbitDir) * 14,
    mode: 'recover',
    dir: bossOrbitDir
  });
  candidates.push({
    x: playerGX + Math.cos(radialOut) * 16,
    y: playerGY + Math.sin(radialOut) * 16,
    mode: 'recover',
    dir: bossOrbitDir
  });
  candidates.push({
    x: playerGX + Math.cos(radialIn) * 12,
    y: playerGY + Math.sin(radialIn) * 12,
    mode: 'recover',
    dir: bossOrbitDir
  });

  for (const c of candidates) {
    const tx = Math.floor(c.x);
    const ty = Math.floor(c.y);
    if (!poe2.isWalkable(tx, ty)) continue;

    if (c.mode === 'forward') {
      bossOrbitBlockedCount = 0;
    } else if (c.mode === 'reverse') {
      // Keep reverse bounded; immediately return to forward preference after window.
      bossOrbitBlockedCount = 0;
    }
    return c;
  }

  // All candidates blocked: increment block count and open short reverse contingency window.
  bossOrbitBlockedCount++;
  if (bossOrbitBlockedCount >= BLOCKS_BEFORE_REVERSE) {
    bossOrbitReverseUntil = nowMs + REVERSE_WINDOW_MS;
    bossOrbitBlockedCount = 0;
  }
  return null;
}

function normalizeAngleRad(a) {
  let x = a;
  while (x < 0) x += Math.PI * 2;
  while (x >= Math.PI * 2) x -= Math.PI * 2;
  return x;
}

function markRecentOrbitSector(sector, maxKeep = 4) {
  bossFightRecentOrbitSectors.push(sector);
  if (bossFightRecentOrbitSectors.length > maxKeep) {
    bossFightRecentOrbitSectors.shift();
  }
}

function markRecentBossDetour(x, y, maxKeep = 8) {
  bossRecentDetours.push({ x, y });
  if (bossRecentDetours.length > maxKeep) bossRecentDetours.shift();
}

function isRecentBossDetour(x, y, radius = 55) {
  const r2 = radius * radius;
  for (const d of bossRecentDetours) {
    const dx = x - d.x;
    const dy = y - d.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

/**
 * Pick a reachable detour point that still progresses generally toward boss target.
 * Used when boss checkpoint is known but direct route has no path.
 */
function pickBossCheckpointDetour(playerGX, playerGY, bossGX, bossGY) {
  const toBossX = bossGX - playerGX;
  const toBossY = bossGY - playerGY;
  const toBossLen = Math.hypot(toBossX, toBossY);
  if (toBossLen < 1) return null;
  const ux = toBossX / toBossLen;
  const uy = toBossY / toBossLen;
  const baseAngle = Math.atan2(toBossY, toBossX);

  const angleOffsets = [0, Math.PI / 8, -Math.PI / 8, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, 3 * Math.PI / 4, -3 * Math.PI / 4];
  const radii = [110, 150, 190, 230];

  let best = null;
  let bestScore = -Infinity;
  for (const off of angleOffsets) {
    const a = baseAngle + off;
    const dirX = Math.cos(a);
    const dirY = Math.sin(a);
    for (const r of radii) {
      const tx = playerGX + dirX * r;
      const ty = playerGY + dirY * r;
      if (!poe2.isWalkable(Math.floor(tx), Math.floor(ty))) continue;
      if (isRecentBossDetour(tx, ty)) continue;

      const towardScore = (dirX * ux + dirY * uy); // [-1..1]
      const clearance = getWalkableClearanceScore(tx, ty);
      const score = towardScore * 90 + clearance * 5 + r * 0.08;
      if (score > bestScore) {
        bestScore = score;
        best = { x: tx, y: ty };
      }
    }
  }

  return best;
}

/**
 * When checkpoint path is missing, follow alive mobs that progress toward boss direction.
 * This helps open fog-of-war/connectivity in disconnected layouts.
 */
function pickBossCheckpointMobProgressTarget(playerGX, playerGY, bossGX, bossGY) {
  const mobs = POE2Cache.getEntities({
    type: 'Monster',
    aliveOnly: true,
    lightweight: true,
    maxDistance: 260
  }) || [];
  if (mobs.length === 0) return null;

  const toBossX = bossGX - playerGX;
  const toBossY = bossGY - playerGY;
  const toBossLen = Math.hypot(toBossX, toBossY);
  if (toBossLen < 1) return null;
  const ux = toBossX / toBossLen;
  const uy = toBossY / toBossLen;

  let best = null;
  let bestScore = -Infinity;
  for (const e of mobs) {
    if (!isHostileAlive(e)) continue;
    if (!e.isTargetable) continue;
    if (e.gridX === undefined || e.gridY === undefined) continue;
    if (isRecentBossDetour(e.gridX, e.gridY, 45)) continue;

    const dx = e.gridX - playerGX;
    const dy = e.gridY - playerGY;
    const dist = Math.hypot(dx, dy);
    if (dist < 14 || dist > 260) continue;

    const toward = (dx * ux + dy * uy) / dist; // [-1..1], want forward
    if (toward < -0.1) continue; // avoid explicit backtracking

    let rarityBonus = 0;
    const subtype = (e.entitySubtype || '').toLowerCase();
    if (subtype.includes('rare')) rarityBonus = 22;
    else if (subtype.includes('magic')) rarityBonus = 12;
    else rarityBonus = 6;

    const score = toward * 120 + rarityBonus + Math.min(dist, 220) * 0.18;
    if (score > bestScore) {
      bestScore = score;
      best = { x: e.gridX, y: e.gridY };
    }
  }
  return best;
}

function isRecentOrbitSector(sector) {
  return bossFightRecentOrbitSectors.includes(sector);
}

/**
 * Pick a large-radius orbit waypoint around boss.
 * Uses sector stepping in locked direction and avoids recently used sectors.
 */
function pickLargeOrbitWaypoint(playerGX, playerGY, bossGX, bossGY) {
  const SECTOR_COUNT = 16;
  const BASE_RADIUS = 58;
  const RADIUS_JITTER = 10;

  const dx = playerGX - bossGX;
  const dy = playerGY - bossGY;
  const baseAngle = normalizeAngleRad(Math.atan2(dy, dx));
  const sectorSize = (Math.PI * 2) / SECTOR_COUNT;
  const baseSector = Math.floor(baseAngle / sectorSize);

  const stepOptions = [2, 3, 4, 5];
  const signedSteps = [];
  for (const s of stepOptions) signedSteps.push(s * bossOrbitDir);

  for (const step of signedSteps) {
    for (let jitter = -1; jitter <= 1; jitter++) {
      const sector = ((baseSector + step + jitter) % SECTOR_COUNT + SECTOR_COUNT) % SECTOR_COUNT;
      if (isRecentOrbitSector(sector)) continue;

      const targetAngle = sector * sectorSize + sectorSize * 0.5;
      const radius = BASE_RADIUS + (Math.random() * 2 - 1) * RADIUS_JITTER;
      const tx = bossGX + Math.cos(targetAngle) * radius;
      const ty = bossGY + Math.sin(targetAngle) * radius;
      if (!poe2.isWalkable(Math.floor(tx), Math.floor(ty))) continue;

      markRecentOrbitSector(sector);
      return { x: tx, y: ty, sector };
    }
  }

  // Fallback: keep moving tangentially in locked direction with slight outward bias.
  const tangentAngle = Math.atan2(playerGY - bossGY, playerGX - bossGX) + (Math.PI / 2) * bossOrbitDir;
  const tx = playerGX + Math.cos(tangentAngle) * 38 + Math.cos(tangentAngle - (Math.PI / 2) * bossOrbitDir) * 8;
  const ty = playerGY + Math.sin(tangentAngle) * 38 + Math.sin(tangentAngle - (Math.PI / 2) * bossOrbitDir) * 8;
  return { x: tx, y: ty, sector: -1 };
}

function getWalkableClearanceScore(gx, gy) {
  const samples = [
    [8, 0], [-8, 0], [0, 8], [0, -8],
    [6, 6], [6, -6], [-6, 6], [-6, -6],
    [14, 0], [-14, 0], [0, 14], [0, -14],
  ];
  let score = 0;
  for (const [ox, oy] of samples) {
    if (poe2.isWalkable(Math.floor(gx + ox), Math.floor(gy + oy))) score++;
  }
  return score;
}

function pickWideOrbitWaypoint(playerGX, playerGY, centerGX, centerGY) {
  const STEP_ANGLES = [0.42, 0.62, 0.82, 1.02];
  const RADII = [70, 78, 86, 62, 54];
  const currentAngle = Math.atan2(playerGY - centerGY, playerGX - centerGX);

  let best = null;
  let bestScore = -Infinity;
  for (const step of STEP_ANGLES) {
    const a = currentAngle + step * bossOrbitDir;
    for (const r of RADII) {
      const tx = centerGX + Math.cos(a) * r;
      const ty = centerGY + Math.sin(a) * r;
      if (!poe2.isWalkable(Math.floor(tx), Math.floor(ty))) continue;
      const clearance = getWalkableClearanceScore(tx, ty);
      const score = clearance * 20 + r;
      if (score > bestScore) {
        bestScore = score;
        best = { x: tx, y: ty };
      }
    }
  }
  return best;
}

function pickFenceEscapeWaypoint(playerGX, playerGY, bossGX, bossGY) {
  const currentAngle = Math.atan2(playerGY - bossGY, playerGX - bossGX);
  const stepAngles = [1.0, 1.25, 1.5, 1.8];
  const radii = [88, 98, 108, 76];
  const sideOrder = [bossOrbitDir, -bossOrbitDir];

  let best = null;
  let bestScore = -Infinity;
  for (const side of sideOrder) {
    for (const s of stepAngles) {
      const a = currentAngle + s * side;
      for (const r of radii) {
        const tx = bossGX + Math.cos(a) * r;
        const ty = bossGY + Math.sin(a) * r;
        if (!poe2.isWalkable(Math.floor(tx), Math.floor(ty))) continue;
        const clearance = getWalkableClearanceScore(tx, ty);
        if (clearance < 6) continue;
        const playerTravel = Math.hypot(tx - playerGX, ty - playerGY);
        const score = clearance * 22 + r * 1.6 - playerTravel * 0.12 + (side === bossOrbitDir ? 12 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = { x: tx, y: ty };
        }
      }
    }
  }
  return best;
}

// ============================================================================
// STATE MACHINE
// ============================================================================

function setState(newState) {
  if (currentState === newState) return;
  if (currentState === STATE.WALKING_TO_UTILITY && newState !== STATE.WALKING_TO_UTILITY) {
    utilityResumeState = STATE.IDLE;
  }
  if (
    newState === STATE.WALKING_TO_BOSS_CHECKPOINT ||
    newState === STATE.WALKING_TO_BOSS_MELEE ||
    newState === STATE.FIGHTING_BOSS
  ) {
    utilityActiveTarget = null;
    utilityNoPathCount = 0;
    utilityArrivalWaitStart = 0;
    utilityResumeState = STATE.IDLE;
  }
  log(`State: ${currentState} -> ${newState}`);
  currentState = newState;
  stateStartTime = Date.now();
  if (newState === STATE.FIGHTING_BOSS) {
    utilityActiveTarget = null;
    utilityNoPathCount = 0;
    utilityArrivalWaitStart = 0;
    bossOrbitBlockedCount = 0;
    bossOrbitReverseUntil = 0;
    bossFightOrbitWaypointX = 0;
    bossFightOrbitWaypointY = 0;
    bossFightOrbitLastAssignTime = 0;
    bossFightRecentOrbitSectors = [];
    bossOrbitDir = Math.random() < 0.5 ? 1 : -1;
    bossFightStuckCount = 0;
    lastBossDodgeRollTime = 0;
    lastBossEmergencyRollTime = 0;
    bossDodgeLandingX = 0;
    bossDodgeLandingY = 0;
    bossDodgeLandingTime = 0;
    dodgeMoveSuppressUntil = 0;
    bossFightEngagedAt = Date.now();
    fightSnapshotTime = 0;
    fightSnapshotAll = [];
    fightSnapshotAlive = [];
    bossFightLastPosCheckTime = 0;
    bossFightLastPosX = 0;
    bossFightLastPosY = 0;
  }
  if (newState === STATE.FINDING_BOSS) {
    bossExploreDirX = 0;
    bossExploreDirY = 0;
    bossExploreLastTargetX = 0;
    bossExploreLastTargetY = 0;
    bossExploreLastPickTime = 0;
    bossExploreNoPathCount = 0;
    bossNoPathCount = 0;
    bossDetourLastPickTime = 0;
    bossRecentDetours = [];
    bossCheckpointLastDist = Infinity;
    bossCheckpointLastImprovementTime = 0;
  }
}

function resetMapper() {
  currentState = STATE.IDLE;
  stateStartTime = Date.now();
  currentPath = [];
  currentWaypointIndex = 0;
  templeFound = false;
  templeCleared = false;
  templeClearStartTime = 0;
  templeCenterApproachStartTime = 0;
  templeNoHostilesSince = 0;
  templeCenterSeenAt = 0;
  templePedestalSeenAt = 0;
  templeStuckTime = 0;
  usingBossFallback = false;
  bossTgtFound = false;
  bossFound = false;
  bossDead = false;
  checkpointReached = false;
  bossEntityId = 0;
  bossCandidateId = 0;
  bossTargetSource = '';
  bossOrbitDir = Math.random() < 0.5 ? 1 : -1;
  bossOrbitBlockedCount = 0;
  bossOrbitReverseUntil = 0;
  bossMeleeHoldStartTime = 0;
  bossMeleeStaticLocked = false;
  bossMeleeStaticX = 0;
  bossMeleeStaticY = 0;
  bossMeleeStaticEntityId = 0;
  bossMeleeLastRetargetTime = 0;
  bossMeleeFullScanTime = 0;
  bossMeleeFullScanCache = [];
  resumeTempleAfterBoss = false;
  earlyBossHintLogged = false;
  bossExploreDirX = 0;
  bossExploreDirY = 0;
  bossExploreLastTargetX = 0;
  bossExploreLastTargetY = 0;
  bossExploreLastPickTime = 0;
  bossExploreNoPathCount = 0;
  bossFightOrbitWaypointX = 0;
  bossFightOrbitWaypointY = 0;
  bossFightOrbitLastAssignTime = 0;
  bossFightRecentOrbitSectors = [];
  bossFightStuckCount = 0;
  bossNoPathCount = 0;
  bossDetourLastPickTime = 0;
  bossRecentDetours = [];
  bossCheckpointLastDist = Infinity;
  bossCheckpointLastImprovementTime = 0;
  statusMessage = 'Idle';
  stuckCount = 0;
  lastBossScanTime = 0;
  lastBossTgtSearchTime = 0;
  lastBossEntityScanTime = 0;
  lastBossCheckpointScanTime = 0;
  abandonedBossTargets = [];
  lastMovePacketTime = 0;
  lastStopPacketTime = 0;
  lastBossDodgeRollTime = 0;
  lastBossEmergencyRollTime = 0;
  bossDodgeLandingX = 0;
  bossDodgeLandingY = 0;
  bossDodgeLandingTime = 0;
  dodgeMoveSuppressUntil = 0;
  bossDodgeSide = 1;
  bossFightEngagedAt = 0;
  bossHpSamples.clear();
  lastBossEngageProbeTime = 0;
  cachedBossEngageProbe = null;
  lastBossEngageProbeMaxDistance = 0;
  lastBossEngageDebugKey = '';
  lastBossEngageDebugTime = 0;
  areaGuardBlockedLastFrame = false;
  areaGuardLastName = '';
  fightSnapshotTime = 0;
  fightSnapshotAll = [];
  fightSnapshotAlive = [];
  bossFightLastPosCheckTime = 0;
  bossFightLastPosX = 0;
  bossFightLastPosY = 0;
  lastMapperLogicTime = 0;
  lastNoPathLogTime = 0;
  lastNoPathLogDistBucket = -1;
  lastPathFoundLogTime = 0;
  lastBossRoomAnchorScanTime = 0;
  cachedBossRoomAnchor = null;
  lastExploreMobPickTime = 0;
  cachedExploreMobTarget = null;
  lastStartWalkLogTime = 0;
  lastStartWalkLogName = '';
  lastStartWalkLogPathType = '';
  lastStartWalkLogX = 0;
  lastStartWalkLogY = 0;
  lastLogMsg = '';
  lastLogTime = 0;
  lastTempleUnreachableLogTime = 0;
  utilityLogTimes = new Map();
  ignoredUtilityTargets = new Set();
  utilityActiveTarget = null;
  utilityNoPathCount = 0;
  utilityArrivalWaitStart = 0;
  utilityDetourUntil = 0;
  utilityLastSelectedKey = '';
  utilityResumeState = STATE.IDLE;
  utilityStats = {
    openableCandidates: 0,
    lootCandidates: 0,
    futureCandidates: 0,
    totalCandidates: 0,
    blacklistedCount: 0,
  };
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

  // Area guard: do not run mapper logic in non-map areas (hideout/town).
  const areaInfo = poe2.getAreaInfo();
  if (isNonMapArea(areaInfo)) {
    const areaLabel = areaInfo?.areaName || areaInfo?.areaId || 'unknown';
    statusMessage = `Outside map (${areaLabel}) - waiting`;
    if (!areaGuardBlockedLastFrame || areaGuardLastName !== areaLabel) {
      log(`Area guard: mapper paused in non-map area "${areaLabel}"`);
      areaGuardBlockedLastFrame = true;
      areaGuardLastName = areaLabel;
    }
    if (currentState !== STATE.IDLE) {
      resetMapper();
      sendStopMovementLimited(true);
    }
    return;
  } else if (areaGuardBlockedLastFrame) {
    const areaLabel = areaInfo?.areaName || areaInfo?.areaId || 'unknown';
    log(`Area guard: map area detected "${areaLabel}", mapper resumed`);
    areaGuardBlockedLastFrame = false;
    areaGuardLastName = areaLabel;
  }

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

  // Keep non-fight states fully responsive; throttle only boss fight logic.
  const logicInterval = currentState === STATE.FIGHTING_BOSS ? 150 : 0;
  if (now - lastMapperLogicTime < logicInterval) return;
  lastMapperLogicTime = now;

  // Priority order:
  // 1) movement lock (handled above)
  // 2) core mapper state machine
  // 3) utility walk state

  if (tryStartUtilityNavigation(player, now)) {
    // Utility state can start from any non-critical mapping state.
  }

  switch (currentState) {
    case STATE.IDLE:
      // Start the mapping sequence
      setState(STATE.FINDING_TEMPLE);
      break;

    case STATE.FINDING_TEMPLE: {
      // Early boss pre-scan (just in case boss path/signal is already known).
      const earlyBoss = getRadarBossTarget();
      if (earlyBoss && !earlyBossHintLogged) {
        earlyBossHintLogged = true;
        log(`Early boss signal detected at (${earlyBoss.x.toFixed(0)}, ${earlyBoss.y.toFixed(0)})`);
      }

      const templeLoc = findTempleTgt();
      if (templeLoc) {
        templeGridX = templeLoc.x;
        templeGridY = templeLoc.y;
        templeFound = true;
        templeCleared = false;
        templeClearStartTime = 0;
        templeNoHostilesSince = 0;
        templeCenterSeenAt = 0;
        templePedestalSeenAt = 0;
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

        // NOTE: Do NOT auto-skip temple based only on nearby hostiles count.
        // Some maps can look "quiet" before beacon/pedestal sequence is actually completed.
        // We only skip by explicit beacon/chest/buff signals above.

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
      // Rare case: map boss is in the way to temple.
      // If likely boss is nearby, kill boss first then resume temple objective.
      const nearbyBossSignal = getRadarBossTarget();
      const nearbyBossCandidate = findBossCandidateUnique(
        player.gridX, player.gridY,
        130,
        nearbyBossSignal ? nearbyBossSignal.x : null,
        nearbyBossSignal ? nearbyBossSignal.y : null,
        nearbyBossSignal ? 260 : Infinity
      );
      if (nearbyBossCandidate && isLikelyMapBossEntity(nearbyBossCandidate, nearbyBossSignal)) {
        resumeTempleAfterBoss = true;
        checkpointReached = true; // skip checkpoint requirement; boss is already nearby
        bossGridX = nearbyBossCandidate.gridX;
        bossGridY = nearbyBossCandidate.gridY;
        bossCandidateId = nearbyBossCandidate.id || 0;
        bossMeleeStaticLocked = false;
        bossMeleeStaticX = 0;
        bossMeleeStaticY = 0;
        bossMeleeLastRetargetTime = 0;
        log(`Boss encountered en route to temple at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)}), switching to kill boss then resume temple`);
        setState(STATE.WALKING_TO_BOSS_MELEE);
        break;
      }

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

        // If temple route is dead for several seconds, stop forcing that stale target
        // and switch back to forward temple exploration mode.
        if (stuckDuration > 5000 && !usingBossFallback) {
          if (now - lastTempleUnreachableLogTime > 1800) {
            log(`Temple path unreachable for ${(stuckDuration / 1000).toFixed(0)}s, switching to temple exploration`);
            lastTempleUnreachableLogTime = now;
          }
          templeFound = false;
          templeGridX = 0;
          templeGridY = 0;
          templeExploreAnchorX = player.gridX;
          templeExploreAnchorY = player.gridY;
          templeExploreNoPathCount = 0;

          const dx = targetGridX - player.gridX;
          const dy = targetGridY - player.gridY;
          const len = Math.hypot(dx, dy);
          if (len > 2) {
            templeExploreDirX = dx / len;
            templeExploreDirY = dy / len;
          } else {
            const a = Math.random() * Math.PI * 2;
            templeExploreDirX = Math.cos(a);
            templeExploreDirY = Math.sin(a);
          }

          startWalkingTo(
            player.gridX + templeExploreDirX * 160,
            player.gridY + templeExploreDirY * 160,
            'Temple Explore',
            ''
          );
          templeStuckTime = 0;
          break;
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
      const clearScanRadius = Math.max(100, currentSettings.templeClearRadius * 2); // tighter room scan; avoid far unrelated packs
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
      if (distFromTemple <= 45) {
        templeCenterSeenAt = now;
      }

      // Optional pedestal signal (can disappear after activation on some maps).
      const pedestals = poe2.getEntities({
        nameContains: 'IncursionPedestalEncounter',
        lightweight: true
      }) || [];
      if (pedestals.length > 0) {
        templePedestalSeenAt = now;
      }

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
        templeCenterApproachStartTime = 0;
        if (bossDead) {
          log('Boss already dead, map complete after temple');
          setState(STATE.MAP_COMPLETE);
        } else {
          setState(STATE.FINDING_BOSS);
        }
        break;
      }

      // Safety timeout: if we've been clearing for 60+ seconds, move on
      if (timeInState > 60000) {
        log('Temple clear timeout (60s), moving to boss');
        templeCleared = true;
        if (bossDead) {
          log('Boss already dead, map complete after temple timeout');
          setState(STATE.MAP_COMPLETE);
        } else {
          setState(STATE.FINDING_BOSS);
        }
        break;
      }

      if (hostileCount > 0) {
        // PHASE 1: Kill mobs - walk toward nearest hostile
        templeClearStartTime = 0; // Reset no-hostile timer
        templeCenterApproachStartTime = 0;
        templeNoHostilesSince = 0;

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
        if (templeNoHostilesSince === 0) templeNoHostilesSince = now;
        const noHostilesMs = now - templeNoHostilesSince;

        // Robust fallback for maps where beacon/chest/pedestal signals are gone:
        // sustained no-hostiles in temple room + we were near center at least once.
        const centerSeenRecently = templeCenterSeenAt > 0 && (now - templeCenterSeenAt) < 90000;
        const pedestalWasSeen = templePedestalSeenAt > 0;
        if (noHostilesMs > 12000 && (centerSeenRecently || pedestalWasSeen || timeInState > 35000)) {
          log(`Temple considered complete by fallback (${(noHostilesMs / 1000).toFixed(0)}s no hostiles)`);
          templeCleared = true;
          templeCenterApproachStartTime = 0;
          if (bossDead) {
            setState(STATE.MAP_COMPLETE);
          } else {
            setState(STATE.FINDING_BOSS);
          }
          break;
        }

        // PHASE 2: No hostiles - WALK TO TEMPLE CENTER to activate beacon!
        // The beacon only activates when the player is physically at the center.
        // Do NOT skip to boss until we've actually gone to the center and
        // either detected the Vaal Chest opened or waited a reasonable time there.

        if (distFromTemple > 15) {
          if (templeCenterApproachStartTime === 0) {
            templeCenterApproachStartTime = now;
          }
          const centerApproachMs = now - templeCenterApproachStartTime;

          // Not at center yet - walk there using BFS pathfinding
          const targetChanged = Math.abs(templeGridX - targetGridX) > 10 || Math.abs(templeGridY - targetGridY) > 10;
          if (!currentPath || currentPath.length === 0 || targetChanged) {
            startWalkingTo(templeGridX, templeGridY, 'Temple Center', 'temple');
          }
          stepPathWalker();
          statusMessage = `Walking to beacon center... ${distFromTemple.toFixed(0)} units`;
          // Keep a no-hostiles timer running even while approaching center.
          // Some layouts can make exact center unreachable after beacon phase.

          // If center cannot be reached for a while after room is already clear, proceed.
          if (centerApproachMs > 14000) {
            log(`Temple center unreachable for ${(centerApproachMs / 1000).toFixed(0)}s after clear, proceeding to boss`);
            templeCleared = true;
            templeCenterApproachStartTime = 0;
            if (bossDead) {
              setState(STATE.MAP_COMPLETE);
            } else {
              setState(STATE.FINDING_BOSS);
            }
            break;
          }
        } else {
          // AT the center - start/continue waiting for beacon to activate
          templeCenterApproachStartTime = 0;
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
      let radarBossTarget = null;
      if (shouldScanEntities) {
        lastBossEntityScanTime = now;
        radarBossTarget = getRadarBossTarget();

        const checkpoints = poe2.getEntities({
          nameContains: 'Checkpoint_Endgame_Boss',
          lightweight: false,
        });
        if (checkpoints && checkpoints.length > 0) {
          const cp = selectBestBossCheckpoint(checkpoints, radarBossTarget, player.gridX, player.gridY);
          if (!cp) {
            // We found checkpoint-like entities, but none match strict endgame boss pattern.
            // Do not pick a fallback checkpoint here.
          } else {
          if (!bossTgtFound || Math.abs(cp.gridX - bossGridX) > 30 || Math.abs(cp.gridY - bossGridY) > 30) {
            log(`Boss checkpoint entity at (${cp.gridX.toFixed(0)}, ${cp.gridY.toFixed(0)})`);
          }
          bossGridX = cp.gridX;
          bossGridY = cp.gridY;
          bossTgtFound = true;
          bossTargetSource = 'checkpoint';
          }
        }
      }

      // STRICT MODE: no generic radar/TGT endpoint fallback.
      // Allowed fallback is strict boss-room object anchors only.
      if (!bossTgtFound) {
        const anchor = findBossRoomObjectAnchor(player.gridX, player.gridY, radarBossTarget);
        if (anchor) {
          bossGridX = anchor.anchorGridX ?? anchor.gridX;
          bossGridY = anchor.anchorGridY ?? anchor.gridY;
          bossTgtFound = true;
          bossTargetSource = 'arena_object';
          const shortName = (anchor.name || 'BossRoomObject').split('/').pop();
          log(`Boss room anchor fallback: "${shortName}" at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
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
      // DECIDE: CHECKPOINT FIRST, then boss approach in melee state
      // Do NOT target unique boss entity directly from FINDING_BOSS.
      // =================================================================
      if (nearestBoss && bossTgtFound && nearestBossDist < 120) {
        bossFound = true;
        log(`Boss entity seen near checkpoint target at dist=${nearestBossDist.toFixed(0)} (will approach AFTER checkpoint)`);
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
        const sourceLabel = bossTargetSource === 'arena_object' ? 'Boss room anchor' : 'Checkpoint_Endgame_Boss';
        log(`Walking to ${sourceLabel} at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
        startWalkingTo(
          bossGridX,
          bossGridY,
          bossTargetSource === 'arena_object' ? 'Boss Room Anchor' : 'Boss Checkpoint',
          ''
        );
        setState(STATE.WALKING_TO_BOSS_CHECKPOINT);
        break;
      }

      // No TGT/radar endpoint fallback for checkpoint selection.
      // If checkpoint isn't visible yet, keep exploring forward until it appears.

      // STRATEGY 5: Exploration fallback (never stand still while searching).
      // If temple is known, bias away from temple. Otherwise, pick/maintain a forward heading.
      if (timeSinceStart > 1200) {
        statusMessage = templeFound
          ? `Exploring for boss... (${(timeSinceStart / 1000).toFixed(0)}s)`
          : `No boss signal, exploring forward... (${(timeSinceStart / 1000).toFixed(0)}s)`;
        const hasTempleAnchor = templeFound && Number.isFinite(templeGridX) && Number.isFinite(templeGridY);
        const dxFromTemple = hasTempleAnchor ? (player.gridX - templeGridX) : 0;
        const dyFromTemple = hasTempleAnchor ? (player.gridY - templeGridY) : 0;
        const fromTempleDist = hasTempleAnchor ? Math.sqrt(dxFromTemple * dxFromTemple + dyFromTemple * dyFromTemple) : 0;

        // Initialize a forward heading.
        if (bossExploreDirX === 0 && bossExploreDirY === 0) {
          if (hasTempleAnchor && fromTempleDist > 2) {
            bossExploreDirX = dxFromTemple / fromTempleDist;
            bossExploreDirY = dyFromTemple / fromTempleDist;
          } else {
            const a = Math.random() * Math.PI * 2;
            bossExploreDirX = Math.cos(a);
            bossExploreDirY = Math.sin(a);
            bossExploreLastPickTime = now;
          }
        }

        const mobTarget = pickBossExploreMobTarget(
          player.gridX, player.gridY, bossExploreDirX, bossExploreDirY
        );

        let exploreX;
        let exploreY;
        let exploreName = 'Boss Search Explore';

        if (mobTarget) {
          exploreX = mobTarget.gridX;
          exploreY = mobTarget.gridY;
          const mdx = exploreX - player.gridX;
          const mdy = exploreY - player.gridY;
          const mlen = Math.sqrt(mdx * mdx + mdy * mdy);
          if (mlen > 1) {
            bossExploreDirX = mdx / mlen;
            bossExploreDirY = mdy / mlen;
          }
          bossExploreLastTargetX = exploreX;
          bossExploreLastTargetY = exploreY;
          bossExploreLastPickTime = now;
          exploreName = 'Boss Search Mob';
        } else {
          // Fallback: continue forward heading, do not backtrack.
          exploreX = player.gridX + bossExploreDirX * 180;
          exploreY = player.gridY + bossExploreDirY * 180;
          // If no mob target for a while, rotate heading slightly to find a new lane.
          if (now - bossExploreLastPickTime > 3000) {
            const rotate = (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 6); // +-30 deg
            const nx = bossExploreDirX * Math.cos(rotate) - bossExploreDirY * Math.sin(rotate);
            const ny = bossExploreDirX * Math.sin(rotate) + bossExploreDirY * Math.cos(rotate);
            bossExploreDirX = nx;
            bossExploreDirY = ny;
          }
        }

        const needNewExploreTarget =
          Math.abs(targetGridX - exploreX) > 26 ||
          Math.abs(targetGridY - exploreY) > 26 ||
          currentPath.length === 0;
        if (needNewExploreTarget && now - lastRepathTime > 900) {
          startWalkingTo(exploreX, exploreY, exploreName, 'boss');
        }
        const exploreStep = stepPathWalker();
        if (exploreStep === 'stuck') {
          // On stuck during exploration, rotate heading and try a new lane.
          bossExploreNoPathCount = 0;
          const rotate = (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 4); // +-45 deg
          const nx = bossExploreDirX * Math.cos(rotate) - bossExploreDirY * Math.sin(rotate);
          const ny = bossExploreDirX * Math.sin(rotate) + bossExploreDirY * Math.cos(rotate);
          bossExploreDirX = nx;
          bossExploreDirY = ny;
        } else if (currentPath.length === 0 && targetName && targetName.includes('Boss Search')) {
          // We have no computed path to current explore target repeatedly -> abandon it.
          bossExploreNoPathCount++;
          if (bossExploreNoPathCount >= 3) {
            abandonedBossTargets.push({ x: targetGridX, y: targetGridY });
            const rotate = (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 3); // +-60 deg
            const nx = bossExploreDirX * Math.cos(rotate) - bossExploreDirY * Math.sin(rotate);
            const ny = bossExploreDirX * Math.sin(rotate) + bossExploreDirY * Math.cos(rotate);
            bossExploreDirX = nx;
            bossExploreDirY = ny;
            bossExploreNoPathCount = 0;
            log(`Explore target unreachable, abandoning (${targetGridX.toFixed(0)}, ${targetGridY.toFixed(0)})`);
          }
        } else {
          bossExploreNoPathCount = 0;
        }
      } else {
        statusMessage = `No boss found yet (${(timeSinceStart / 1000).toFixed(0)}s)`;
      }
      break;
    }

    case STATE.WALKING_TO_UTILITY: {
      runUtilityNavigationStep(player, now);
      break;
    }

    case STATE.WALKING_TO_BOSS_CHECKPOINT: {
      const activeBoss = detectActiveBossEngagement(player.gridX, player.gridY, now, 52);
      if (activeBoss && activeBoss.entity) {
        const e = activeBoss.entity;
        bossEntityId = e.id || bossEntityId;
        bossGridX = e.gridX;
        bossGridY = e.gridY;
        bossFound = true;
        checkpointReached = true;
        log(`Boss already engaged during checkpoint walk (${activeBoss.reason}) -> entering fight`);
        setState(STATE.FIGHTING_BOSS);
        break;
      }

      const result = stepPathWalker();
      const dist = Math.sqrt(
        (player.gridX - bossGridX) ** 2 + (player.gridY - bossGridY) ** 2
      );
      statusMessage = `Walking to Boss Checkpoint... ${dist.toFixed(0)} units`;

      // Anti-stall watchdog: if distance isn't improving for several seconds,
      // force a progress leg instead of waiting on dead/looping paths.
      if (bossCheckpointLastImprovementTime === 0) {
        bossCheckpointLastImprovementTime = now;
        bossCheckpointLastDist = dist;
      } else {
        if (dist < bossCheckpointLastDist - 3) {
          bossCheckpointLastDist = dist;
          bossCheckpointLastImprovementTime = now;
        }
      }

      // Keep checkpoint target fresh while approaching.
      if (now - lastBossCheckpointScanTime > 3000) {
        lastBossCheckpointScanTime = now;
        const checkpoints = poe2.getEntities({
          nameContains: 'Checkpoint_Endgame_Boss',
          lightweight: false,
        });
        if (checkpoints && checkpoints.length > 0) {
          const radarBoss = getRadarBossTarget();
          const cp = selectBestBossCheckpoint(checkpoints, radarBoss, player.gridX, player.gridY);
          if (cp && (Math.abs(cp.gridX - bossGridX) > 20 || Math.abs(cp.gridY - bossGridY) > 20)) {
            log(`Checkpoint retarget -> (${cp.gridX.toFixed(0)}, ${cp.gridY.toFixed(0)})`);
            bossGridX = cp.gridX;
            bossGridY = cp.gridY;
            bossTgtFound = true;
            startWalkingTo(bossGridX, bossGridY, 'Boss Checkpoint', '');
          }
        }
      }

      if (result === 'arrived') {
        if (targetName === 'Boss Checkpoint Detour') {
          // Reached an intermediate lane point; retry direct checkpoint route from here.
          bossNoPathCount = 0;
          startWalkingTo(bossGridX, bossGridY, 'Boss Checkpoint', '');
          break;
        }
        checkpointReached = true;
        bossCandidateId = 0; // drop stale candidate lock from pre-checkpoint scans
        bossMeleeHoldStartTime = 0;
        bossMeleeStaticLocked = false;
        bossMeleeStaticX = 0;
        bossMeleeStaticY = 0;
        bossMeleeStaticEntityId = 0;
        bossMeleeLastRetargetTime = 0;
        log('Boss checkpoint reached -> switching to melee engagement');
        setState(STATE.WALKING_TO_BOSS_MELEE);
      } else if (result === 'stuck' || (result === 'walking' && currentPath.length === 0)) {
        bossNoPathCount++;
        const canTryDetour = (now - bossDetourLastPickTime > 1400);
        if (bossNoPathCount >= 2 && canTryDetour) {
          const mobProgress = pickBossCheckpointMobProgressTarget(player.gridX, player.gridY, bossGridX, bossGridY);
          if (mobProgress) {
            bossDetourLastPickTime = now;
            markRecentBossDetour(mobProgress.x, mobProgress.y);
            log(`Boss checkpoint no-path, following mobs toward boss at (${mobProgress.x.toFixed(0)}, ${mobProgress.y.toFixed(0)})`);
            startWalkingTo(mobProgress.x, mobProgress.y, 'Boss Checkpoint Mob Progress', '');
            break;
          }

          const detour = pickBossCheckpointDetour(player.gridX, player.gridY, bossGridX, bossGridY);
          if (detour) {
            bossDetourLastPickTime = now;
            markRecentBossDetour(detour.x, detour.y);
            log(`Boss checkpoint no-path, taking detour at (${detour.x.toFixed(0)}, ${detour.y.toFixed(0)})`);
            startWalkingTo(detour.x, detour.y, 'Boss Checkpoint Detour', '');
            break;
          }
        }

        const timeInWalk = now - stateStartTime;
        if (timeInWalk > 32000) {
          log(`Boss checkpoint unreachable after ${(timeInWalk / 1000).toFixed(0)}s, re-searching`);
          abandonedBossTargets.push({ x: bossGridX, y: bossGridY });
          bossTgtFound = false;
          bossFound = false;
          bossNoPathCount = 0;
          bossRecentDetours = [];
          setState(STATE.FINDING_BOSS);
        } else {
          // Avoid ping-pong reset while we are already in a progress detour leg.
          if (!targetName.includes('Detour') && !targetName.includes('Mob Progress')) {
            startWalkingTo(bossGridX, bossGridY, 'Boss Checkpoint', '');
          }
        }
      } else {
        bossNoPathCount = 0;
      }

      // If no progress for too long, force a progress leg regardless of path state.
      if (now - bossCheckpointLastImprovementTime > 5000) {
        const mobProgress = pickBossCheckpointMobProgressTarget(player.gridX, player.gridY, bossGridX, bossGridY);
        if (mobProgress) {
          bossDetourLastPickTime = now;
          markRecentBossDetour(mobProgress.x, mobProgress.y);
          log(`Boss checkpoint stalled, forcing mob-progress at (${mobProgress.x.toFixed(0)}, ${mobProgress.y.toFixed(0)})`);
          startWalkingTo(mobProgress.x, mobProgress.y, 'Boss Checkpoint Mob Progress', '');
          bossCheckpointLastImprovementTime = now;
          bossCheckpointLastDist = dist;
          break;
        }

        const detour = pickBossCheckpointDetour(player.gridX, player.gridY, bossGridX, bossGridY);
        if (detour) {
          bossDetourLastPickTime = now;
          markRecentBossDetour(detour.x, detour.y);
          log(`Boss checkpoint stalled, forcing detour at (${detour.x.toFixed(0)}, ${detour.y.toFixed(0)})`);
          startWalkingTo(detour.x, detour.y, 'Boss Checkpoint Detour', '');
          bossCheckpointLastImprovementTime = now;
          bossCheckpointLastDist = dist;
          break;
        }
      }
      break;
    }

    case STATE.WALKING_TO_BOSS_MELEE: {
      const activeBoss = detectActiveBossEngagement(player.gridX, player.gridY, now, 95);
      if (activeBoss && activeBoss.entity) {
        const e = activeBoss.entity;
        bossEntityId = e.id || bossEntityId;
        bossGridX = e.gridX;
        bossGridY = e.gridY;
        bossFound = true;
        log(`Boss already engaged during melee walk (${activeBoss.reason}) -> entering fight`);
        setState(STATE.FIGHTING_BOSS);
        break;
      }

      // Engagement distances:
      // - Immune bosses often require stepping in close to trigger fight phase.
      // - Already damageable bosses are effectively engaged, so we can switch sooner.
      const IMMUNE_ENGAGE_RANGE = 30;
      const DAMAGEABLE_ENGAGE_RANGE = 52;
      const CANDIDATE_SCAN_RANGE = 650;
      const HOLD_MIN_MS = 900;

      // Requested simple rule:
      // - Go to nearest MonsterUnique that is either far (>40) or immune.
      // - Then wait for engage signal as before.
      const uniques = poe2.getEntities({
        type: 'Monster',
        subtype: 'MonsterUnique',
        aliveOnly: true,
        lightweight: false,
        maxDistance: CANDIDATE_SCAN_RANGE
      }) || [];

      const radarBoss = getRadarBossTarget();
      const approachAnchor = radarBoss || ((Number.isFinite(bossGridX) && Number.isFinite(bossGridY)) ? { x: bossGridX, y: bossGridY } : null);
      const approachAnchorRadius = checkpointReached ? 180 : 280;
      const playerToRadarDist = radarBoss ? Math.hypot(player.gridX - radarBoss.x, player.gridY - radarBoss.y) : null;
      let selected = null;
      let bestScore = -Infinity;
      for (const e of uniques) {
        if (!isBossApproachCandidate(e)) continue;
        const isLockedCandidate = bossCandidateId && e.id === bossCandidateId;
        const likelyBoss = isLockedCandidate || isLikelyMapBossEntity(e, radarBoss) || isUniqueNearBossArena(e, radarBoss, approachAnchorRadius);
        if (!likelyBoss) continue;
        if (!isLockedCandidate && approachAnchor) {
          const ax = e.gridX - approachAnchor.x;
          const ay = e.gridY - approachAnchor.y;
          if (ax * ax + ay * ay > approachAnchorRadius * approachAnchorRadius) continue;
        }
        const dx = e.gridX - player.gridX;
        const dy = e.gridY - player.gridY;
        const d = Math.sqrt(dx * dx + dy * dy);
        let score = 0;
        if (isLockedCandidate) score += 120;
        if (e.cannotBeDamaged) score += 36;
        if (e.isHiddenMonster) score += 20;
        if (radarBoss) {
          const candToRadar = Math.hypot(e.gridX - radarBoss.x, e.gridY - radarBoss.y);
          score -= candToRadar * 1.9;
          if (checkpointReached && playerToRadarDist !== null) {
            // Prefer candidates deeper into arena than player's current position.
            if (candToRadar < playerToRadarDist - 8) score += 30;
            else score -= 50;
          }
        }
        score -= d * 0.15;
        if (score > bestScore) {
          bestScore = score;
          selected = e;
        }
      }

      // Fallback: if none match strict rule, use nearest unique anyway.
      if (!selected) {
        for (const e of uniques) {
          if (!isBossApproachCandidate(e)) continue;
          const isLockedCandidate = bossCandidateId && e.id === bossCandidateId;
          const likelyBoss = isLockedCandidate || isLikelyMapBossEntity(e, radarBoss) || isUniqueNearBossArena(e, radarBoss, approachAnchorRadius);
          if (!likelyBoss) continue;
          if (!isLockedCandidate && approachAnchor) {
            const ax = e.gridX - approachAnchor.x;
            const ay = e.gridY - approachAnchor.y;
            if (ax * ax + ay * ay > approachAnchorRadius * approachAnchorRadius) continue;
          }
          const dx = e.gridX - player.gridX;
          const dy = e.gridY - player.gridY;
          const d = Math.sqrt(dx * dx + dy * dy);
          let score = 0;
          if (isLockedCandidate) score += 120;
          if (e.cannotBeDamaged) score += 28;
          if (e.isHiddenMonster) score += 16;
          if (radarBoss) {
            const candToRadar = Math.hypot(e.gridX - radarBoss.x, e.gridY - radarBoss.y);
            score -= candToRadar * 1.5;
          }
          score -= d * 0.12;
          if (score > bestScore) {
            bestScore = score;
            selected = e;
          }
        }
      }

      // No radar line + no regular unique hit: use full-entity scan to find hidden/immune boss.
      if (!selected) {
        const fullCandidates = getBossFullEntityCandidates(
          player.gridX,
          player.gridY,
          approachAnchor ? approachAnchor.x : null,
          approachAnchor ? approachAnchor.y : null,
          checkpointReached ? 320 : 360
        );
        if (fullCandidates.length > 0) {
          selected = fullCandidates[0].entity;
          bestScore = fullCandidates[0].score;
          logBossMeleeTargetSelection(selected, player.gridX, player.gridY, 'full-entity-fallback');
        }
      }

      if (selected) {
        bossCandidateId = selected.id || bossCandidateId;
        bossMeleeStaticEntityId = selected.id || 0;
        logBossMeleeTargetSelection(selected, player.gridX, player.gridY, 'unique');
        const selectedIsImmune = !!selected.cannotBeDamaged;
        const desiredStandRange = selectedIsImmune ? IMMUNE_ENGAGE_RANGE : DAMAGEABLE_ENGAGE_RANGE;
        const walkableApproach = getBossApproachWalkablePoint(
          player.gridX,
          player.gridY,
          selected.gridX,
          selected.gridY,
          desiredStandRange
        );
        if (walkableApproach) {
          bossMeleeStaticX = walkableApproach.x;
          bossMeleeStaticY = walkableApproach.y;
        } else {
          bossMeleeStaticX = selected.gridX;
          bossMeleeStaticY = selected.gridY;
        }
      } else {
        // Water/phase scenario: no unique candidate visible yet.
        // Push into arena toward radar boss endpoint while waiting for unique visibility.
        logBossMeleeTargetSelection(null, player.gridX, player.gridY, 'edge-fallback');
        if (radarBoss) {
          const dx = radarBoss.x - player.gridX;
          const dy = radarBoss.y - player.gridY;
          const len = Math.hypot(dx, dy) || 1;
          bossMeleeStaticX = player.gridX + (dx / len) * Math.min(90, len);
          bossMeleeStaticY = player.gridY + (dy / len) * Math.min(90, len);
          bossMeleeStaticEntityId = 0;
        } else if (!bossMeleeStaticLocked) {
          // No radar and no explicit unique: derive inward push from checkpoint context.
          let dirX = 1;
          let dirY = 0;
          if (templeFound && Number.isFinite(templeGridX) && Number.isFinite(templeGridY) && Number.isFinite(bossGridX) && Number.isFinite(bossGridY)) {
            // Move away from temple through checkpoint into arena.
            dirX = bossGridX - templeGridX;
            dirY = bossGridY - templeGridY;
          } else if (Number.isFinite(bossGridX) && Number.isFinite(bossGridY)) {
            dirX = bossGridX - player.gridX;
            dirY = bossGridY - player.gridY;
          }
          const inward = getWalkableDirectionalTarget(player.gridX, player.gridY, dirX, dirY);
          if (inward) {
            bossMeleeStaticX = inward.x;
            bossMeleeStaticY = inward.y;
          } else {
            bossMeleeStaticX = player.gridX + 60;
            bossMeleeStaticY = player.gridY + 20;
          }
          bossMeleeStaticEntityId = 0;
        }
      }

      const distToLocked = Math.sqrt(
        (player.gridX - bossMeleeStaticX) ** 2 + (player.gridY - bossMeleeStaticY) ** 2
      );

      // Keep path target synced to nearest unique with mild throttle.
      const targetChanged =
        Math.hypot(bossMeleeStaticX - targetGridX, bossMeleeStaticY - targetGridY) > 18 ||
        (selected && bossMeleeStaticEntityId !== (selected.id || 0));
      if (!bossMeleeStaticLocked || targetChanged || now - bossMeleeLastRetargetTime > 1500 || currentPath.length === 0) {
        bossMeleeStaticLocked = true;
        bossMeleeLastRetargetTime = now;
        const meleeLabel = selected ? 'Boss Melee (unique target)' : 'Boss Melee (edge fallback)';
        startWalkingTo(bossMeleeStaticX, bossMeleeStaticY, meleeLabel, '');
      }

      const selectedIsImmune = selected ? !!selected.cannotBeDamaged : false;
      const desiredStandRange = selectedIsImmune ? IMMUNE_ENGAGE_RANGE : DAMAGEABLE_ENGAGE_RANGE;
      const distToBossEntity = selected ? Math.hypot(player.gridX - selected.gridX, player.gridY - selected.gridY) : Infinity;

      if (distToLocked > desiredStandRange) {
        bossMeleeHoldStartTime = 0;
        const result = stepPathWalker();
        statusMessage = selected
          ? `Walking to boss unique... ${distToLocked.toFixed(0)} units`
          : `Walking to boss edge... ${distToLocked.toFixed(0)} units`;
        if (result === 'stuck' && selected && (now - stateStartTime > 25000)) {
          // Only abandon when we had a concrete unique target but still couldn't reach.
          // If no unique yet (boss in water), keep holding near edge.
          log('Could not reach nearest unique boss target, re-searching');
          setState(STATE.FINDING_BOSS);
        }
        break;
      }

      // If the pre-fight room has extra mobs (abyss etc), don't stand still and die.
      // Force a fast roll-away from boss to keep room while waiting for true engagement.
      const meleeHostiles = POE2Cache.getEntities({
        type: 'Monster',
        aliveOnly: true,
        lightweight: true,
        maxDistance: 80
      }) || [];
      const nearbyThreat = findNearestHostile(meleeHostiles, player.gridX, player.gridY, 80);
      if (selected && nearbyThreat && nearbyThreat.dist < 45) {
        if (tryBossEmergencyRollOut(player, selected, now)) {
          statusMessage = `Boss pre-engage: dodging room pressure (${nearbyThreat.dist.toFixed(0)}u)`;
          break;
        }
      }

      sendStopMovementLimited();
      if (bossMeleeHoldStartTime === 0) bossMeleeHoldStartTime = now;
      const holdMs = now - bossMeleeHoldStartTime;

      const bossIsDamageable = selected ? !selected.cannotBeDamaged : false;
      const bossIsTargetable = selected ? !!selected.isTargetable : false;
      const bossEngaged = bossIsDamageable || bossIsTargetable;

      // Requested engage rules:
      // - Immune bosses: push in close; if within 20, start fight phase anyway.
      // - Non-immune bosses: once within 40-50 range, start fight phase.
      if (selected && selectedIsImmune && distToBossEntity <= 20) {
        bossEntityId = selected.id || bossEntityId;
        bossGridX = selected.gridX;
        bossGridY = selected.gridY;
        const bossName = ((selected.renderName || selected.name || 'Unknown')).split('/').pop();
        log(`Boss "${bossName}" immune-close threshold met (<=20) - entering fight`);
        setState(STATE.FIGHTING_BOSS);
        break;
      }

      if (selected && bossIsDamageable && distToBossEntity <= 50) {
        bossEntityId = selected.id || bossEntityId;
        bossGridX = selected.gridX;
        bossGridY = selected.gridY;
        const bossName = ((selected.renderName || selected.name || 'Unknown')).split('/').pop();
        log(`Boss "${bossName}" damageable and within 50 - entering fight`);
        setState(STATE.FIGHTING_BOSS);
        break;
      }

      if (bossEngaged && holdMs >= HOLD_MIN_MS) {
        bossEntityId = selected?.id || bossEntityId;
        bossGridX = selected?.gridX || bossMeleeStaticX;
        bossGridY = selected?.gridY || bossMeleeStaticY;
        const bossName = ((selected?.renderName || selected?.name || 'Unknown')).split('/').pop();
        log(`Boss "${bossName}" engaged (damageable=${bossIsDamageable}, targetable=${bossIsTargetable}) - entering fight`);
        setState(STATE.FIGHTING_BOSS);
      } else {
        statusMessage = `At nearest unique (${distToLocked.toFixed(0)}), waiting engage... ${(holdMs / 1000).toFixed(1)}s`;
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

      // Throttled combat snapshot to reduce per-frame load in heavy fights.
      const fightSnapshot = getFightMonsterSnapshot(now, fightScanRadius);
      const allMonstersNearby = fightSnapshot.all;
      const bossMonsters = fightSnapshot.alive;
      const radarBossFight = getRadarBossTarget();
      const arenaBossUniques = (allMonstersNearby || []).filter(e =>
        isBossApproachCandidate(e) && isUniqueNearBossArena(e, radarBossFight, 250)
      );
      const arenaBossAliveCount = arenaBossUniques.filter(e => e.isAlive).length;

      // Count hostiles near boss area AND near player
      const hostileCount = countHostilesNear(
        bossMonsters, bossGridX, bossGridY, fightScanRadius
      );
      const hostileCountNearPlayer = countHostilesNear(
        bossMonsters, player.gridX, player.gridY, currentSettings.bossFightRadius * 2
      );
      const totalHostiles = Math.max(hostileCount, hostileCountNearPlayer);

      // =================================================================
      // BOSS ENTITY TRACKING
      // Find and track the MonsterUnique - this is the map boss.
      // Once we have its ID, we can detect its death instantly.
      // =================================================================
      if (bossEntityId === 0 && allMonstersNearby) {
        let bestBoss = null;
        let bestScore = -Infinity;
        for (const e of arenaBossUniques) {
          if (!e.id || e.id === 0) continue;

          const isLockedCandidate = bossCandidateId && e.id === bossCandidateId;
          const likelyBoss = isLockedCandidate || isLikelyMapBossEntity(e, radarBossFight) || isUniqueNearBossArena(e, radarBossFight, 250);
          if (!likelyBoss) continue;

          const distToKnown = Math.hypot(e.gridX - bossGridX, e.gridY - bossGridY);
          let score = 0;
          if (isLockedCandidate) score += 80;
          if (isLikelyMapBossEntity(e, radarBossFight)) score += 35;
          score -= distToKnown * 0.22;
          if (score > bestScore) {
            bestScore = score;
            bestBoss = e;
          }
        }
        if (bestBoss) {
          bossEntityId = bestBoss.id;
          bossFound = true;
          bossGridX = bestBoss.gridX;
          bossGridY = bestBoss.gridY;
          const bossName = (bestBoss.renderName || bestBoss.name || 'Unknown').split('/').pop();
          log(`Boss identified: "${bossName}" (ID: ${bossEntityId})`);
        }
      }

      // =================================================================
      // BOSS DEATH CHECK (instant detection via entity HP/alive status)
      // =================================================================
      if (bossEntityId !== 0 && allMonstersNearby) {
        for (const e of allMonstersNearby) {
          if (e.id === bossEntityId) {
            const isLockedCandidate = bossCandidateId && e.id === bossCandidateId;
            const isLikelyBossTracked = isLockedCandidate || isLikelyMapBossEntity(e, radarBossFight) || isUniqueNearBossArena(e, radarBossFight, 250);
            if (!isLikelyBossTracked) {
              const n = (e.renderName || e.name || 'Unknown').split('/').pop();
              log(`Tracked unique "${n}" is not a likely map boss, dropping track`);
              bossEntityId = 0;
              break;
            }
            // Found the tracked boss entity - check if dead
            if (!e.isAlive || e.healthCurrent === 0) {
              const bossName = (e.renderName || e.name || 'Unknown').split('/').pop();
              log(`Boss DEAD: "${bossName}" (HP: ${e.healthCurrent || 0}/${e.healthMax || 0})`);
              const nextBoss = arenaBossUniques.find(b => b.id !== bossEntityId && b.isAlive);
              if (nextBoss) {
                bossEntityId = nextBoss.id || 0;
                bossGridX = nextBoss.gridX;
                bossGridY = nextBoss.gridY;
                const nextName = (nextBoss.renderName || nextBoss.name || 'Unknown').split('/').pop();
                log(`Additional arena boss detected: "${nextName}" (ID:${bossEntityId})`);
                break;
              }
              bossDead = true;
              sendStopMovementLimited(true);
              const templeLoc = templeFound ? { x: templeGridX, y: templeGridY } : findTempleTgt();
              if (shouldReturnToTempleFromBossFlow() && templeLoc) {
                templeFound = true;
                templeGridX = templeLoc.x;
                templeGridY = templeLoc.y;
                log('Boss killed before temple complete, resuming temple objective');
                resumeTempleAfterBoss = false;
                bossTgtFound = false;
                bossEntityId = 0;
                checkpointReached = false;
                setState(STATE.FINDING_TEMPLE);
              } else {
                if (!templeCleared && !templeLoc) {
                  log('Boss killed and no temple objective found in this map, marking complete');
                }
                setState(STATE.MAP_COMPLETE);
              }
              break;
            }
          }
        }
        if (bossDead) break; // Exit the case immediately
      }

      // Track if we've EVER seen hostiles in this fight (prevents premature exit)
      if (totalHostiles > 0 || arenaBossAliveCount > 0) {
        templeClearStartTime = 0; // Reset no-hostile timer
      }

      statusMessage = bossEntityId !== 0
        ? `Fighting Boss (ID:${bossEntityId})... ${totalHostiles} hostiles`
        : `Fighting Boss... ${totalHostiles} hostiles`;

      // =================================================================
      // MOVEMENT TARGET (KITE MODE)
      // Large circle pathing with non-repeating random sectors.
      // Avoid left-right yo-yo by keeping a persistent orbit direction.
      // =================================================================
      const dxBoss = bossGridX - player.gridX;
      const dyBoss = bossGridY - player.gridY;
      const distToBossArea = Math.sqrt(dxBoss * dxBoss + dyBoss * dyBoss);

      let moveTargetX, moveTargetY, distToTarget;

      let trackedBossEntity = null;
      if (bossEntityId !== 0 && allMonstersNearby) {
        for (const e of allMonstersNearby) {
          if (e.id === bossEntityId && e.isAlive) {
            trackedBossEntity = e;
            break;
          }
        }
      }

      if (trackedBossEntity) {
        moveTargetX = trackedBossEntity.gridX;
        moveTargetY = trackedBossEntity.gridY;
        bossGridX = trackedBossEntity.gridX;
        bossGridY = trackedBossEntity.gridY;
        const dx = moveTargetX - player.gridX;
        const dy = moveTargetY - player.gridY;
        distToTarget = Math.sqrt(dx * dx + dy * dy);
      } else if (distToBossArea > 60) {
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

      // Emergency anti-corner escape:
      // if we are too close to boss and in cramped space, force a roll OUT immediately.
      if (trackedBossEntity) {
        const distToTrackedBoss = Math.hypot(player.gridX - trackedBossEntity.gridX, player.gridY - trackedBossEntity.gridY);
        const localClear = quickClearanceScore(player.gridX, player.gridY);
        if (distToTrackedBoss < 44 && localClear <= 3) {
          if (tryBossEmergencyRollOut(player, trackedBossEntity, now)) {
            bossFightOrbitWaypointX = 0;
            bossFightOrbitWaypointY = 0;
          }
        }
      }

      // Optional dodge-roll burst to reposition behind boss using facing.
      // Runs on its own timer and is validated by facing+walkability checks.
      if (trackedBossEntity && tryBossDodgeRollBehind(player, trackedBossEntity, now)) {
        bossFightOrbitWaypointX = 0;
        bossFightOrbitWaypointY = 0;
      }

      // SMART fight movement: committed run waypoints (no rapid yo-yo retarget).
      if (distToTarget > 120) {
        const stepResult = stepFightDirectMove(player, moveTargetX, moveTargetY, now, 18);
        statusMessage = `Repositioning to boss ring... ${distToTarget.toFixed(0)} units`;
        // Lightweight stuck recovery: nudge direction instead of path recompute spam.
        if (stepResult === 'walking') {
          if (bossFightLastPosCheckTime === 0) {
            bossFightLastPosCheckTime = now;
            bossFightLastPosX = player.gridX;
            bossFightLastPosY = player.gridY;
          } else if (now - bossFightLastPosCheckTime > 2200) {
            const moved = Math.hypot(player.gridX - bossFightLastPosX, player.gridY - bossFightLastPosY);
            if (moved < 2.5) {
              sendMoveAngleLimited(Math.random() * 360, Math.max(20, currentSettings.stuckMoveDistance * 0.7));
            }
            bossFightLastPosCheckTime = now;
            bossFightLastPosX = player.gridX;
            bossFightLastPosY = player.gridY;
          }
        }
      } else {
        const distToWaypoint = Math.sqrt(
          (player.gridX - bossFightOrbitWaypointX) ** 2 + (player.gridY - bossFightOrbitWaypointY) ** 2
        );
        const localClear = quickClearanceScore(player.gridX, player.gridY);
        const fenceTrapped = localClear <= 3 || bossFightOrbitBlockedCount >= 1;
        const postDodgeLock = (bossDodgeLandingTime > 0 && now - bossDodgeLandingTime < 1200);
        if (postDodgeLock && Number.isFinite(bossDodgeLandingX) && Number.isFinite(bossDodgeLandingY)) {
          bossFightOrbitWaypointX = bossDodgeLandingX;
          bossFightOrbitWaypointY = bossDodgeLandingY;
          if (bossFightOrbitLastAssignTime === 0 || now - bossFightOrbitLastAssignTime > 180) {
            bossFightOrbitLastAssignTime = now;
          }
        }
        const waypointExpired = (now - bossFightOrbitLastAssignTime > (fenceTrapped ? 3400 : 2600));
        const canReassignNow = (now - bossFightOrbitLastAssignTime > 520);
        const needNewWaypoint =
          bossFightOrbitWaypointX === 0 ||
          bossFightOrbitWaypointY === 0 ||
          (distToWaypoint < 12 && canReassignNow) ||
          waypointExpired;

        if (needNewWaypoint && !postDodgeLock) {
          if (fenceTrapped) {
            const escapeWp = pickFenceEscapeWaypoint(player.gridX, player.gridY, moveTargetX, moveTargetY);
            if (escapeWp) {
              bossFightOrbitWaypointX = escapeWp.x;
              bossFightOrbitWaypointY = escapeWp.y;
              bossFightOrbitLastAssignTime = now;
              bossFightOrbitBlockedCount = 0;
              statusMessage = `Kiting Boss... fence-escape`;
            } else {
              bossOrbitDir *= -1;
            }
          }
          if (bossFightOrbitWaypointX === 0 || bossFightOrbitWaypointY === 0 || !fenceTrapped) {
          // Performance-first by default: skip expensive wide clearance scoring.
            const wp = currentSettings.fightUseWideOrbit
              ? (pickWideOrbitWaypoint(player.gridX, player.gridY, moveTargetX, moveTargetY) ||
                 pickLargeOrbitWaypoint(player.gridX, player.gridY, moveTargetX, moveTargetY))
              : pickLargeOrbitWaypoint(player.gridX, player.gridY, moveTargetX, moveTargetY);
            bossFightOrbitWaypointX = wp.x;
            bossFightOrbitWaypointY = wp.y;
            bossFightOrbitLastAssignTime = now;
          }
        }

        const stepResult = stepFightDirectMove(
          player,
          bossFightOrbitWaypointX,
          bossFightOrbitWaypointY,
          now,
          12
        );
        if (stepResult === 'walking') {
          if (bossFightLastPosCheckTime === 0) {
            bossFightLastPosCheckTime = now;
            bossFightLastPosX = player.gridX;
            bossFightLastPosY = player.gridY;
          } else if (now - bossFightLastPosCheckTime > 1800) {
            const moved = Math.hypot(player.gridX - bossFightLastPosX, player.gridY - bossFightLastPosY);
            if (moved < 2.0) {
              // Re-roll waypoint on micro-stalls; flip direction after repeated failures.
              bossFightOrbitBlockedCount++;
              bossFightOrbitWaypointX = 0;
              bossFightOrbitWaypointY = 0;
              if (bossFightOrbitBlockedCount >= 2) {
                bossOrbitDir *= -1;
                bossOrbitBlockedCount = 0;
                bossFightRecentOrbitSectors = [];
                log('Fight kite stuck: flipped orbit direction');
              }
            } else {
              bossFightOrbitBlockedCount = 0;
            }
            bossFightLastPosCheckTime = now;
            bossFightLastPosX = player.gridX;
            bossFightLastPosY = player.gridY;
          }
        } else if (stepResult === 'arrived') {
          bossFightOrbitWaypointX = 0;
          bossFightOrbitWaypointY = 0;
          bossOrbitBlockedCount = 0;
        }

        statusMessage = `Kiting Boss... ring=${distToTarget.toFixed(0)} wp=${Math.sqrt((player.gridX - bossFightOrbitWaypointX) ** 2 + (player.gridY - bossFightOrbitWaypointY) ** 2).toFixed(0)}`;
      }

      // =================================================================
      // COMPLETION CHECK
      // =================================================================
      if (totalHostiles === 0) {
        if (templeClearStartTime === 0) {
          templeClearStartTime = now;
        }
        const clearDuration = now - templeClearStartTime;

        // IMPORTANT:
        // Do NOT auto-mark map complete just because no hostiles are visible.
        // Some bosses engage/spawn late (10s+), so this can be a false completion.
        if (clearDuration >= 30000) {
          const templeLoc = templeFound ? { x: templeGridX, y: templeGridY } : findTempleTgt();
          if (shouldReturnToTempleFromBossFlow() && templeLoc) {
            templeFound = true;
            templeGridX = templeLoc.x;
            templeGridY = templeLoc.y;
            log('No boss activity for 30s, temple still incomplete -> returning to temple objective');
            resumeTempleAfterBoss = false;
            bossTgtFound = false;
            bossEntityId = 0;
            checkpointReached = false;
            setState(STATE.FINDING_TEMPLE);
            break;
          }

          // Re-search boss instead of completing map on delayed/hidden encounters.
          log('No boss activity for 30s at fight area, re-searching boss (not map complete)');
          bossTgtFound = false;
          bossFound = false;
          bossEntityId = 0;
          checkpointReached = false;
          setState(STATE.FINDING_BOSS);
          break;
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
      sendStopMovementLimited(true);
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
      sendStopMovementLimited(true);
    }
  }

  ImGui.sameLine();
  ImGui.textColored(
    enabled.value ? [0, 1, 0, 1] : [1, 0.3, 0.3, 1],
    enabled.value ? '[ACTIVE]' : '[OFF]'
  );

  ImGui.separator();
  if (ImGui.treeNode("Boss Dodge Roll")) {
    const dodgeEnabled = new ImGui.MutableVariable(!!currentSettings.bossDodgeRollEnabled);
    if (ImGui.checkbox("Enable behind-boss Dodge Roll", dodgeEnabled)) {
      saveSetting('bossDodgeRollEnabled', dodgeEnabled.value);
    }

    const dodgeInterval = new ImGui.MutableVariable(currentSettings.bossDodgeRollIntervalMs || 800);
    if (ImGui.sliderInt("Dodge Interval (ms)", dodgeInterval, 500, 2000)) {
      saveSetting('bossDodgeRollIntervalMs', dodgeInterval.value);
    }

    const dodgeDist = new ImGui.MutableVariable(currentSettings.bossDodgeRollDistance || 46);
    if (ImGui.sliderInt("Dodge Distance", dodgeDist, 20, 80)) {
      saveSetting('bossDodgeRollDistance', dodgeDist.value);
    }

    const behindMin = new ImGui.MutableVariable(currentSettings.bossDodgeBehindMinDeg || 6);
    if (ImGui.sliderInt("Behind Arc Min Deg", behindMin, 0, 45)) {
      saveSetting('bossDodgeBehindMinDeg', behindMin.value);
      if ((currentSettings.bossDodgeBehindMaxDeg || 20) < behindMin.value) {
        saveSetting('bossDodgeBehindMaxDeg', behindMin.value);
      }
    }

    const behindMax = new ImGui.MutableVariable(currentSettings.bossDodgeBehindMaxDeg || 20);
    if (ImGui.sliderInt("Behind Arc Max Deg", behindMax, 0, 70)) {
      saveSetting('bossDodgeBehindMaxDeg', Math.max(behindMax.value, currentSettings.bossDodgeBehindMinDeg || 6));
    }

    ImGui.textWrapped("Roll picks the safest behind spot by boss-facing + walkable clearance scoring.");
    ImGui.treePop();
  }

  ImGui.separator();

  if (ImGui.treeNode("Utility Targeting")) {
    const walkOpenables = new ImGui.MutableVariable(!!currentSettings.walkToOpenablesEnabled);
    if (ImGui.checkbox("Walk to opener targets", walkOpenables)) {
      saveSetting('walkToOpenablesEnabled', walkOpenables.value);
    }
    const walkNormalChests = new ImGui.MutableVariable(!!currentSettings.walkToNormalChestsEnabled);
    if (ImGui.checkbox("Walk normal/white chests (urns etc)", walkNormalChests)) {
      saveSetting('walkToNormalChestsEnabled', walkNormalChests.value);
    }
    const openableRadius = new ImGui.MutableVariable(currentSettings.openableWalkRadius || 200);
    if (ImGui.sliderInt("Openable walk radius", openableRadius, 40, 320)) {
      saveSetting('openableWalkRadius', openableRadius.value);
    }

    const walkLoot = new ImGui.MutableVariable(!!currentSettings.walkToLootEnabled);
    if (ImGui.checkbox("Walk to pickit loot", walkLoot)) {
      saveSetting('walkToLootEnabled', walkLoot.value);
    }
    const lootRadius = new ImGui.MutableVariable(currentSettings.lootWalkRadius || 200);
    if (ImGui.sliderInt("Loot walk radius", lootRadius, 40, 320)) {
      saveSetting('lootWalkRadius', lootRadius.value);
    }

    const noPathThreshold = new ImGui.MutableVariable(currentSettings.utilityNoPathBlacklistThreshold || 3);
    if (ImGui.sliderInt("No-path blacklist threshold", noPathThreshold, 2, 8)) {
      saveSetting('utilityNoPathBlacklistThreshold', noPathThreshold.value);
    }

    ImGui.separator();
    ImGui.textColored([0.8, 0.85, 1.0, 1.0], "Future Providers (placeholders)");
    const breachToggle = new ImGui.MutableVariable(!!currentSettings.walkToBreachTargetsEnabled);
    if (ImGui.checkbox("Breach targets (future)", breachToggle)) {
      saveSetting('walkToBreachTargetsEnabled', breachToggle.value);
    }
    const abyssToggle = new ImGui.MutableVariable(!!currentSettings.walkToAbyssTargetsEnabled);
    if (ImGui.checkbox("Abyss targets (future)", abyssToggle)) {
      saveSetting('walkToAbyssTargetsEnabled', abyssToggle.value);
    }
    const futureToggle = new ImGui.MutableVariable(!!currentSettings.walkToFutureMechanicsEnabled);
    if (ImGui.checkbox("Other mechanics (future)", futureToggle)) {
      saveSetting('walkToFutureMechanicsEnabled', futureToggle.value);
    }

    ImGui.separator();
    ImGui.text(`Candidates: total=${utilityStats.totalCandidates} openable=${utilityStats.openableCandidates} loot=${utilityStats.lootCandidates}`);
    ImGui.text(`Blacklisted this map: ${utilityStats.blacklistedCount}`);
    if (utilityActiveTarget) {
      ImGui.text(`Active utility target: ${utilityActiveTarget.type} (${utilityActiveTarget.meta?.name || 'unknown'})`);
    } else {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Active utility target: none");
    }

    ImGui.treePop();
  }

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
    if (
      currentState !== STATE.FINDING_BOSS &&
      currentState !== STATE.WALKING_TO_BOSS_CHECKPOINT &&
      currentState !== STATE.WALKING_TO_BOSS_MELEE &&
      currentState !== STATE.FIGHTING_BOSS
    ) {
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

export const mapperPlugin = { name: 'Mapper', onDraw };

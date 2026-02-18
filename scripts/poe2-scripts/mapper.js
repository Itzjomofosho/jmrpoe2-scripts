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
import { sendMoveRaw, moveAngle, stopMovement, int32ToBytesBE } from './movement.js';
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
  // Hideout flow states
  HIDEOUT_CHECK_PORTALS: 'HIDEOUT_CHECK_PORTALS',
  HIDEOUT_OPEN_MAP_DEVICE: 'HIDEOUT_OPEN_MAP_DEVICE',
  HIDEOUT_WAIT_ATLAS: 'HIDEOUT_WAIT_ATLAS',
  HIDEOUT_SELECT_MAP: 'HIDEOUT_SELECT_MAP',
  HIDEOUT_WAIT_TPM: 'HIDEOUT_WAIT_TPM',
  HIDEOUT_PLACE_WAYSTONE: 'HIDEOUT_PLACE_WAYSTONE',
  HIDEOUT_PLACE_PRECURSORS: 'HIDEOUT_PLACE_PRECURSORS',
  HIDEOUT_ACTIVATE_MAP: 'HIDEOUT_ACTIVATE_MAP',
  HIDEOUT_WAIT_PORTAL: 'HIDEOUT_WAIT_PORTAL',
  HIDEOUT_ENTER_PORTAL: 'HIDEOUT_ENTER_PORTAL',
  HIDEOUT_SUSPENDED: 'HIDEOUT_SUSPENDED',
  // In-map states
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
  // Hideout map opener
  hideoutFlowEnabled: false,
  waystoneMinTier: 1,
  waystoneMaxTier: 16,
  waystoneRarityNormal: true,
  waystoneRarityMagic: true,
  waystoneRarityRare: true,
  waystoneRarityUnique: true,
  waystoneCorruptedOnly: false,
  waystoneNonCorruptedOnly: false,
  enablePrecursors: false,
  precursorRarityNormal: true,
  precursorRarityMagic: true,
  precursorRarityRare: true,
  precursorRarityUnique: true,
  hideoutPortalEnterMaxAttempts: 4,
  // Map-complete cleanup / return
  mapCompleteRetreatDistance: 36,
  mapCompleteRetreatDurationMs: 10000,
  mapCompleteLootDelayMs: 0,
  mapCompleteUtilityDelayMs: 10000,
  mapCompleteAutoReturnToHideout: true,
  mapCompleteUseOpenTownPortalPacket: true,
  mapCompletePortalSearchRadius: 140,
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
let templeUnreachableTargets = []; // [{x,y,expiresAt}]

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
let bossMeleeExplorePickTime = 0;
let bossMeleeExploreNoPathCount = 0;

// Hideout flow state
let hideoutMapDeviceId = 0;
let hideoutSelectedNodeIndex = -1;
let hideoutActivationKey = null; // { x: int32, y: int32 } from node+0x2C8
let hideoutSuspendReason = '';
let hideoutLastActionTime = 0;
let hideoutWaystonePlaced = false;
let hideoutPrecursorsPlaced = 0;
let hideoutEntityScanLogged = false; // one-time log of nearby entities
let waystoneNoMatchLogAt = 0;
let hideoutWaystoneMoveAttempts = 0;
let hideoutTraverseAttempts = 0;
let hideoutPortalEnterAttempts = 0;
let hideoutFailedNodeBlacklist = new Set();
let traverseDebugCustomX = -59;  // custom X for manual traverse packet testing
let traverseDebugCustomY = -70;  // custom Y for manual traverse packet testing
let opt1TestSelectedNode = -1;   // selected node index for option 1 test
let opt1TestLog = [];            // log entries for option 1 test
let deathHealthZeroAt = 0;
let deathReturnTriggeredAt = 0;
let mapCompleteBossDeathX = 0;
let mapCompleteBossDeathY = 0;
let mapCompletePortalInteractLastAt = 0;
let mapCompletePortalInteractAttempts = 0;
let mapCompleteOpenPortalLastAt = 0;
let mapCompleteOpenPortalAttempts = 0;
let mapCompleteFlowStartTime = 0;
let mapCompleteRetreatReachedAt = 0;
let mapCompleteLastHp = 0;
let mapCompleteDangerDetectedAt = 0;
let mapCompleteDangerEscapeAttempts = 0;
let mapCompleteDangerLastEscapeAt = 0;
const HIDEOUT_ACTION_COOLDOWN_MS = 2000; // min time between hideout actions
const HIDEOUT_SUSPEND_REASON = {
  NO_UNCOMPLETED_MAPS: 'NO_UNCOMPLETED_MAPS',
  OPEN_TRAVERSE_PANEL_FAILED: 'OPEN_TRAVERSE_PANEL_FAILED',
  NO_WAYSTONE_MATCH: 'NO_WAYSTONE_MATCH',
  CTRLCLICK_FAILED: 'CTRLCLICK_FAILED',
  TPM_SLOT_NOT_DETECTED: 'TPM_SLOT_NOT_DETECTED',
  TRAVERSE_VALIDATE_FAILED: 'TRAVERSE_VALIDATE_FAILED',
  TRAVERSE_PACKET_FAILED: 'TRAVERSE_PACKET_FAILED',
  PORTAL_NOT_SPAWNED: 'PORTAL_NOT_SPAWNED',
};
const ITEM_RARITY_NAMES = ['Normal', 'Magic', 'Rare', 'Unique'];
// Traverse packet at 1920x1080: base coords (1201, 697) → screen (901, 470) → packet (-59, -70).
// Calibrated from average of confirmed working packets: (-60,-70) and (-58,-69).
const TRAVERSE_PACKET_WORKING = Object.freeze([0x00, 0xEC, 0x01, 0xFF, 0xFF, 0xFF, 0xC5, 0xFF, 0xFF, 0xFF, 0xBA]);
const DEATH_HIDEOUT_RECHECK_DELAY_MS = 1000;
const DEATH_HIDEOUT_TRIGGER_COOLDOWN_MS = 6000;

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
let bossImmuneStanceLastSig = '';
let bossImmuneStanceLastRemaining = Infinity;
let bossImmuneStancePreDodgeDone = false;
let bossActionProbeTime = 0;
let bossActionProbeEntity = null;
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

function pruneTempleUnreachableTargets(nowMs = Date.now()) {
  templeUnreachableTargets = (templeUnreachableTargets || []).filter(
    t => t && Number.isFinite(t.expiresAt) && t.expiresAt > nowMs
  );
}

function isTempleTargetTemporarilyBlocked(x, y) {
  const nowMs = Date.now();
  pruneTempleUnreachableTargets(nowMs);
  for (const t of templeUnreachableTargets) {
    const dx = x - t.x;
    const dy = y - t.y;
    if (dx * dx + dy * dy <= 65 * 65) return true;
  }
  return false;
}

function markTempleTargetTemporarilyBlocked(x, y, ttlMs = 22000) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const nowMs = Date.now();
  pruneTempleUnreachableTargets(nowMs);
  templeUnreachableTargets.push({
    x,
    y,
    expiresAt: nowMs + Math.max(4000, ttlMs)
  });
  if (templeUnreachableTargets.length > 16) {
    templeUnreachableTargets = templeUnreachableTargets.slice(-16);
  }
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

function getEntityActionRemainingSec(entity) {
  if (!entity) return null;
  let remaining = Number(entity.animCtrlRemaining);
  if (!Number.isFinite(remaining) || remaining < 0) {
    const duration = Number(entity.animationDuration);
    const elapsed = Number(entity.animCtrlElapsed);
    if (Number.isFinite(duration) && duration > 0 && Number.isFinite(elapsed)) {
      remaining = duration - elapsed;
    } else {
      const progress = Number(entity.animationProgress);
      if (Number.isFinite(duration) && duration > 0 && Number.isFinite(progress)) {
        remaining = duration - progress;
      } else {
        return null;
      }
    }
  }
  return Math.max(0, remaining);
}

function getImmuneBossStancePreDodgeSignal(entity) {
  if (!entity || !entity.cannotBeDamaged) return null;
  const animNameRaw = `${entity.animationName || ''}`;
  if (!animNameRaw) return null;
  const animName = animNameRaw.toLowerCase();
  if (!animName.includes('changetostance')) return null;

  const remaining = getEntityActionRemainingSec(entity);
  if (!Number.isFinite(remaining)) return null;

  const sig = `${entity.id || 0}:${animName}:${entity.currentActionId || 0}:${Math.round((entity.animationDuration || 0) * 100)}`;
  if (sig !== bossImmuneStanceLastSig || remaining > bossImmuneStanceLastRemaining + 0.35) {
    bossImmuneStanceLastSig = sig;
    bossImmuneStancePreDodgeDone = false;
  }
  bossImmuneStanceLastRemaining = remaining;

  // Trigger once as the cast nears completion (roughly ~0.5s left).
  if (!bossImmuneStancePreDodgeDone && remaining <= 0.58 && remaining >= 0.08) {
    bossImmuneStancePreDodgeDone = true;
    return { remaining, animationName: animNameRaw };
  }
  return null;
}

function resolveBossActionEntity(entity, nowMs) {
  if (!entity || !entity.id) return entity;
  const hasActionTelemetry =
    !!entity.animationName ||
    Number.isFinite(entity.animCtrlRemaining) ||
    (Number.isFinite(entity.animationDuration) && entity.animationDuration > 0);
  if (hasActionTelemetry) return entity;

  if (
    bossActionProbeEntity &&
    bossActionProbeEntity.id === entity.id &&
    (nowMs - bossActionProbeTime) < 220
  ) {
    return bossActionProbeEntity;
  }
  if ((nowMs - bossActionProbeTime) < 180) return entity;

  bossActionProbeTime = nowMs;
  const fullMonsters = POE2Cache.getEntities({
    type: 'Monster',
    maxDistance: 240
  }) || [];
  const found = fullMonsters.find(e => e && e.id === entity.id) || null;
  bossActionProbeEntity = found;
  return found || entity;
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
  // Keep rolls frequent, but not same-frame spam.
  if (now - lastBossEmergencyRollTime < 320) return false;
  if (now - lastBossDodgeRollTime < 260) return false;

  const playerRad = Math.atan2(player.gridY - bossEntity.gridY, player.gridX - bossEntity.gridX);
  const tangentLeft = normalizeRad(playerRad + Math.PI / 2);
  const tangentRight = normalizeRad(playerRad - Math.PI / 2);
  const facingRad = getEntityFacingRad(bossEntity);
  const behindRad = facingRad !== null ? normalizeRad(facingRad + Math.PI) : normalizeRad(playerRad + Math.PI);

  // Prefer orbit side continuity; still test both.
  const sideOrder = bossOrbitDir >= 0 ? [1, -1] : [-1, 1];
  const sideArcDeg = [48, 62, 78, 94];
  const radii = [86, 74, 64, 96];
  let best = null;
  let bestScore = -Infinity;

  for (const side of sideOrder) {
    const tangentBase = side > 0 ? tangentLeft : tangentRight;
    for (const offDeg of sideArcDeg) {
      const a = normalizeRad(tangentBase + side * (offDeg * Math.PI / 180));
      for (const r of radii) {
        const tx = bossEntity.gridX + Math.cos(a) * r;
        const ty = bossEntity.gridY + Math.sin(a) * r;
        if (!poe2.isWalkable(Math.floor(tx), Math.floor(ty))) continue;

        const clear = quickClearanceScore(tx, ty);
        if (clear < 3) continue;

        const bossToLX = tx - bossEntity.gridX;
        const bossToLY = ty - bossEntity.gridY;
        const bossToLLen = Math.hypot(bossToLX, bossToLY) || 1;

        // Reward moving around and behind boss, not straight backward pathing.
        const behindDot = (bossToLX / bossToLLen) * Math.cos(behindRad) + (bossToLY / bossToLLen) * Math.sin(behindRad);
        const lateralDot = (bossToLX / bossToLLen) * Math.cos(tangentBase) + (bossToLY / bossToLLen) * Math.sin(tangentBase);

        const travel = Math.hypot(tx - player.gridX, ty - player.gridY);
        const playerToBoss = Math.hypot(player.gridX - bossEntity.gridX, player.gridY - bossEntity.gridY);
        const landingToBoss = Math.hypot(tx - bossEntity.gridX, ty - bossEntity.gridY);
        const ringPenalty = Math.abs(landingToBoss - Math.max(58, Math.min(92, playerToBoss + 10))) * 0.35;

        const score =
          clear * 13 +
          behindDot * 28 +
          Math.max(0, lateralDot) * 18 +
          (side === bossOrbitDir ? 9 : -2) +
          Math.min(travel, 120) * 0.06 -
          ringPenalty;

        if (score > bestScore) {
          bestScore = score;
          best = { x: tx, y: ty, sideSign: side };
        }
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
  if (best.sideSign) bossOrbitDir = best.sideSign;
  // Reuse landing lock pathing so movement follows THROUGH the roll.
  bossDodgeLandingX = best.x;
  bossDodgeLandingY = best.y;
  bossDodgeLandingTime = now;
  // Longer suppress prevents immediate contradictory move packets.
  dodgeMoveSuppressUntil = now + 520;
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
    const isShrine =
      c.type === 'openable' &&
      (c.meta?.openableType === 'Shrine' || `${c.meta?.name || ''}`.toLowerCase().includes('shrine'));
    // Shrines are high-value utility; bias selection toward them.
    const shrineBonus = isShrine ? 16 : 0;
    const score = (c.priority || 0) + shrineBonus - (c.distance || 0) * distWeight;
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
  const baseDist = Math.max(30, currentSettings.openableWalkRadius || 200);
  const maxDist = currentState === STATE.MAP_COMPLETE ? Math.max(baseDist, 320) : baseDist;
  const openerTargets = getOpenableCandidatesForMapper(maxDist) || [];
  const out = [];
  const seenIds = new Set();
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
    if (c.id) seenIds.add(c.id);
    if (!isUtilityTargetIgnored(c)) out.push(c);
  }

  // Fallback shrine scanner:
  // In some layouts/opener states, shrine targets may not be surfaced by opener feed.
  // Add lightweight direct shrine detection so mapper can still walk to shrines.
  const nearby = POE2Cache.getEntities({ lightweight: true, maxDistance: maxDist + 40 }) || [];
  for (const e of nearby) {
    if (!e || !Number.isFinite(e.gridX) || !Number.isFinite(e.gridY)) continue;
    if (e.id && seenIds.has(e.id)) continue;
    if (e.isTargetable === false) continue;
    const path = (e.name || '').toLowerCase();
    const rname = (e.renderName || '').toLowerCase();
    const isShrine = path.includes('shrine') || rname.includes('shrine');
    if (!isShrine) continue;
    // Ignore obvious visual-only shrine effects.
    if (path.includes('effect') || path.includes('vfx') || path.includes('decal')) continue;
    const dist = Math.hypot((e.gridX || 0) - player.gridX, (e.gridY || 0) - player.gridY);
    if (!Number.isFinite(dist) || dist > maxDist) continue;

    const c = {
      type: 'openable',
      id: e.id || 0,
      x: e.gridX,
      y: e.gridY,
      priority: 25,
      distance: dist,
      source: 'shrine_fallback',
      meta: {
        openableType: 'Shrine',
        name: (e.renderName || e.name || '').split('/').pop() || 'Shrine'
      }
    };
    if (c.id) seenIds.add(c.id);
    if (!isUtilityTargetIgnored(c)) out.push(c);
  }
  return out;
}

function getLootUtilityCandidates(player) {
  if (!currentSettings.walkToLootEnabled) return [];
  const baseDist = Math.max(30, currentSettings.lootWalkRadius || 200);
  const maxDist = currentState === STATE.MAP_COMPLETE ? Math.max(baseDist, 320) : baseDist;
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

function getMapCompletePhaseConfig() {
  return {
    waitMs: Math.max(0, currentSettings.mapCompleteRetreatDurationMs || 0),
    utilityMs: Math.max(0, currentSettings.mapCompleteUtilityDelayMs || 0),
    retreatDist: Math.max(20, Math.min(30, currentSettings.mapCompleteRetreatDistance || 26)),
  };
}

function isIncursionObjectiveComplete() {
  const objectives = poe2.getMapObjectives();
  if (!objectives) return false;

  const hasIncursion = (txt) => (txt || '').toLowerCase().includes('incursion');

  const main = objectives.mainObjective;
  if (main && hasIncursion(main.text) && !!main.isCompleted) return true;

  for (const sub of (objectives.subObjectives || [])) {
    const label = `${sub.name || ''} ${sub.objective || ''}`;
    if (hasIncursion(label) && !!sub.isCompleted) return true;
  }
  return false;
}

function isMapObjectiveComplete() {
  const objectives = poe2.getMapObjectives();
  if (!objectives) return false;
  const main = objectives.mainObjective;
  if (main && !!main.isCompleted) return true;
  const mapCompleteFlag = objectives.mapComplete;
  if (mapCompleteFlag === true) return true;
  return false;
}

function isMapCompleteUtilityWindow(nowMs) {
  const mapCompleteContext =
    currentState === STATE.MAP_COMPLETE ||
    (currentState === STATE.WALKING_TO_UTILITY && utilityResumeState === STATE.MAP_COMPLETE);
  if (!mapCompleteContext) return false;
  if (!mapCompleteRetreatReachedAt) return false;
  const cfg = getMapCompletePhaseConfig();
  const utilityStartAt = mapCompleteRetreatReachedAt + cfg.waitMs;
  const utilityEndAt = utilityStartAt + cfg.utilityMs;
  return nowMs >= utilityStartAt && nowMs <= utilityEndAt;
}

function runTempleSearchExploration(player, now, reason = '') {
  const timeSinceSearchStart = now - stateStartTime;
  const reasonSuffix = reason ? ` (${reason})` : '';
  statusMessage = `Exploring for temple${reasonSuffix}... (${(timeSinceSearchStart / 1000).toFixed(0)}s)`;

  if (templeExploreDirX === 0 && templeExploreDirY === 0) {
    const a = Math.random() * Math.PI * 2;
    templeExploreDirX = Math.cos(a);
    templeExploreDirY = Math.sin(a);
    templeExploreAnchorX = player.gridX;
    templeExploreAnchorY = player.gridY;
  }

  const mobTarget = pickBossExploreMobTarget(
    player.gridX,
    player.gridY,
    templeExploreDirX,
    templeExploreDirY
  );
  let exploreX;
  let exploreY;
  let exploreName = 'Temple Search Explore';
  if (mobTarget) {
    exploreX = mobTarget.gridX;
    exploreY = mobTarget.gridY;
    const mdx = exploreX - player.gridX;
    const mdy = exploreY - player.gridY;
    const mlen = Math.hypot(mdx, mdy);
    if (mlen > 1) {
      templeExploreDirX = mdx / mlen;
      templeExploreDirY = mdy / mlen;
    }
    exploreName = 'Temple Search Mob';
  } else {
    exploreX = player.gridX + templeExploreDirX * 170;
    exploreY = player.gridY + templeExploreDirY * 170;
  }

  const needExploreTarget =
    Math.abs(targetGridX - exploreX) > 26 ||
    Math.abs(targetGridY - exploreY) > 26 ||
    currentPath.length === 0;
  if (needExploreTarget && now - lastRepathTime > 900) {
    startWalkingTo(exploreX, exploreY, exploreName, '');
  }

  const exploreStep = stepPathWalker();
  if (exploreStep === 'stuck' || (exploreStep === 'walking' && currentPath.length === 0)) {
    templeExploreNoPathCount++;
    if (templeExploreNoPathCount >= 3) {
      const rotate = (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 3); // +-60 deg
      const nx = templeExploreDirX * Math.cos(rotate) - templeExploreDirY * Math.sin(rotate);
      const ny = templeExploreDirX * Math.sin(rotate) + templeExploreDirY * Math.cos(rotate);
      templeExploreDirX = nx;
      templeExploreDirY = ny;
      templeExploreNoPathCount = 0;
      if (Number.isFinite(targetGridX) && Number.isFinite(targetGridY)) {
        log(`Temple explore target unreachable, rotating lane from (${targetGridX.toFixed(0)}, ${targetGridY.toFixed(0)})`);
      }
    }
  } else {
    templeExploreNoPathCount = 0;
  }
}

function canRunUtilityState() {
  return currentState === STATE.WALKING_TO_UTILITY;
}

function canInterruptForUtility() {
  if (currentState === STATE.MAP_COMPLETE) {
    return isMapCompleteUtilityWindow(Date.now());
  }

  // Allow utility during search/temple-walk states.
  // Keep boss checkpoint/melee/fight protected from utility interruptions.
  const isAllowedState =
    currentState === STATE.FINDING_TEMPLE ||
    currentState === STATE.FINDING_BOSS ||
    currentState === STATE.WALKING_TO_TEMPLE ||
    currentState === STATE.WALKING_TO_BOSS_CHECKPOINT ||
    currentState === STATE.WALKING_TO_BOSS_MELEE;
  if (!isAllowedState) return false;
  return true;
}

function reissueResumeStateTarget(resume) {
  if (resume === STATE.WALKING_TO_TEMPLE && Number.isFinite(templeGridX) && Number.isFinite(templeGridY)) {
    startWalkingTo(templeGridX, templeGridY, 'Temple', 'temple');
    return;
  }
  if (resume === STATE.WALKING_TO_BOSS_CHECKPOINT && Number.isFinite(bossGridX) && Number.isFinite(bossGridY)) {
    startWalkingTo(bossGridX, bossGridY, 'Boss Checkpoint', 'boss');
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
  if ((bossTgtFound || checkpointReached) && currentState === STATE.WALKING_TO_UTILITY && resume !== STATE.MAP_COMPLETE) {
    resume = STATE.WALKING_TO_BOSS_CHECKPOINT;
  }
  if (currentState === STATE.WALKING_TO_UTILITY) {
    if (resume === STATE.MAP_COMPLETE) {
      // Preserve original MAP_COMPLETE phase timer; do not restart it via setState().
      currentState = STATE.MAP_COMPLETE;
      statusMessage = 'Map complete: utility done, returning';
      return;
    }
    reissueResumeStateTarget(resume);
    setState(resume);
  }
}

function shouldReturnToTempleFromBossFlow() {
  if (isIncursionObjectiveComplete()) return false;
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
  const bossObjectiveCommitted = (bossTgtFound || checkpointReached || bossFound);
  const inCheckpointApproach = currentState === STATE.WALKING_TO_BOSS_CHECKPOINT;
  const inMeleeApproach = currentState === STATE.WALKING_TO_BOSS_MELEE;
  const checkpointExploring =
    inCheckpointApproach &&
    (targetName.includes('Detour') || targetName.includes('Mob Progress') || targetName.includes('Boss Arena Barrier'));
  const meleeExploring =
    inMeleeApproach &&
    (targetName.includes('Explore') || targetName.includes('Radar Push') || targetName.includes('Detour'));
  const activeIsShrine =
    utilityActiveTarget?.type === 'openable' &&
    (
      utilityActiveTarget?.meta?.openableType === 'Shrine' ||
      `${utilityActiveTarget?.meta?.name || ''}`.toLowerCase().includes('shrine')
    );
  const activeIsOpenable = utilityActiveTarget?.type === 'openable';
  const maxBossApproachUtilityDist =
    inCheckpointApproach ? (checkpointExploring ? 70 : 35) :
    inMeleeApproach ? (meleeExploring ? 60 : 32) :
    45;
  const activeDistCap = activeIsOpenable
    ? Math.max(120, currentSettings.openableWalkRadius || 200)
    : (activeIsShrine ? (maxBossApproachUtilityDist + 20) : maxBossApproachUtilityDist);
  if (utilityActiveTarget && !isUtilityTargetIgnored(utilityActiveTarget)) {
    if (
      currentState !== STATE.MAP_COMPLETE &&
      bossObjectiveCommitted &&
      Number.isFinite(utilityActiveTarget.distance) &&
      (
        (currentState === STATE.FINDING_BOSS && utilityActiveTarget.distance > 45) ||
        ((inCheckpointApproach || inMeleeApproach) && utilityActiveTarget.distance > activeDistCap)
      )
    ) {
      // Prevent long detours once boss objective is committed.
      // We still allow nearby shrine/chest/loot handoffs.
      utilityActiveTarget = null;
    } else {
      utilityResumeState = currentState;
      setState(STATE.WALKING_TO_UTILITY);
      return true;
    }
  }
  const candidates = gatherUtilityCandidates(player);
  const selected = selectBestUtilityCandidate(candidates);
  if (!selected) return false;
  const selectedIsShrine =
    selected.type === 'openable' &&
    (selected.meta?.openableType === 'Shrine' || `${selected.meta?.name || ''}`.toLowerCase().includes('shrine'));
  const selectedIsOpenable = selected.type === 'openable';
  // Allow wider shrine pickup radius during boss approach so mapper actually diverts.
  const selectedDistCap = selectedIsOpenable
    ? Math.max(120, currentSettings.openableWalkRadius || 200)
    : (selectedIsShrine ? Math.max(maxBossApproachUtilityDist + 60, 95) : maxBossApproachUtilityDist);

  if (currentState !== STATE.MAP_COMPLETE && bossObjectiveCommitted) {
    if (currentState === STATE.FINDING_BOSS) {
      // Boss committed: only allow nearby utility so we don't abandon boss route.
      if ((selected.distance || Infinity) > 45) return false;
    } else if (inCheckpointApproach || inMeleeApproach) {
      // During boss approach, allow utility nearby; relax while actively exploring lanes.
      if ((selected.distance || Infinity) > selectedDistCap) return false;
    }
  }

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
  // During MAP_COMPLETE utility window, hard-stop utility once the window expires
  // so portal return can start immediately.
  if (utilityResumeState === STATE.MAP_COMPLETE && !isMapCompleteUtilityWindow(now)) {
    utilityActiveTarget = null;
    utilityNoPathCount = 0;
    utilityArrivalWaitStart = 0;
    finishUtilityState();
    return false;
  }
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

    // Prefer a practical progression band; avoid both "too-close noise"
    // and very-far checkpoint jumps that can cause corridor ping-pong.
    if (distPlayer < 35) score -= 18;
    score -= Math.abs(distPlayer - 145) * 0.05;
    if (distPlayer > 280) score -= (distPlayer - 280) * 0.14;

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
  const prevState = currentState;
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
    bossImmuneStanceLastSig = '';
    bossImmuneStanceLastRemaining = Infinity;
    bossImmuneStancePreDodgeDone = false;
    bossActionProbeTime = 0;
    bossActionProbeEntity = null;
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
    bossMeleeExplorePickTime = 0;
    bossMeleeExploreNoPathCount = 0;

    // Defensive transition reset:
    // if we re-enter boss search from an approach/melee branch, clear stale
    // commitment/target data so we don't require full mapper restart.
    if (
      prevState === STATE.WALKING_TO_BOSS_CHECKPOINT ||
      prevState === STATE.WALKING_TO_BOSS_MELEE ||
      prevState === STATE.FIGHTING_BOSS
    ) {
      bossTgtFound = false;
      checkpointReached = false;
      bossTargetSource = '';
      bossCandidateId = 0;
      bossFound = false;
      bossEntityId = 0;
      bossMeleeHoldStartTime = 0;
      bossMeleeStaticLocked = false;
      bossMeleeStaticX = 0;
      bossMeleeStaticY = 0;
      bossMeleeStaticEntityId = 0;
      bossMeleeLastRetargetTime = 0;
      // Restart-like behavior: drop old abandoned entries that can block
      // correct boss-entry rediscovery after transient transition failures.
      abandonedBossTargets = [];
    }
  }
  if (newState === STATE.WALKING_TO_BOSS_MELEE) {
    bossMeleeExplorePickTime = 0;
    bossMeleeExploreNoPathCount = 0;
  }
  if (newState === STATE.MAP_COMPLETE) {
    mapCompleteFlowStartTime = Date.now();
    mapCompleteRetreatReachedAt = 0;
    if ((!Number.isFinite(mapCompleteBossDeathX) || !Number.isFinite(mapCompleteBossDeathY)) ||
        (mapCompleteBossDeathX === 0 && mapCompleteBossDeathY === 0)) {
      mapCompleteBossDeathX = Number.isFinite(bossGridX) ? bossGridX : 0;
      mapCompleteBossDeathY = Number.isFinite(bossGridY) ? bossGridY : 0;
    }
    mapCompletePortalInteractLastAt = 0;
    mapCompletePortalInteractAttempts = 0;
    mapCompleteOpenPortalLastAt = 0;
    mapCompleteOpenPortalAttempts = 0;
    mapCompleteLastHp = 0;
    mapCompleteDangerDetectedAt = 0;
    mapCompleteDangerEscapeAttempts = 0;
    mapCompleteDangerLastEscapeAt = 0;
    // Fresh utility pass after boss death: clear stale blacklist/target state
    // collected during traversal/fight so shrine/loot handoff can run again.
    ignoredUtilityTargets = new Set();
    utilityActiveTarget = null;
    utilityNoPathCount = 0;
    utilityArrivalWaitStart = 0;
    utilityDetourUntil = 0;
    utilityLastSelectedKey = '';
    utilityResumeState = STATE.IDLE;
    utilityStats.blacklistedCount = 0;
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
  templeExploreDirX = 0;
  templeExploreDirY = 0;
  templeExploreAnchorX = 0;
  templeExploreAnchorY = 0;
  templeExploreNoPathCount = 0;
  templeUnreachableTargets = [];
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
  bossMeleeExplorePickTime = 0;
  bossMeleeExploreNoPathCount = 0;
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
  bossImmuneStanceLastSig = '';
  bossImmuneStanceLastRemaining = Infinity;
  bossImmuneStancePreDodgeDone = false;
  bossActionProbeTime = 0;
  bossActionProbeEntity = null;
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
  // Hideout flow
  hideoutMapDeviceId = 0;
  hideoutSelectedNodeIndex = -1;
  hideoutActivationKey = null;
  hideoutSuspendReason = '';
  hideoutLastActionTime = 0;
  hideoutWaystonePlaced = false;
  hideoutPrecursorsPlaced = 0;
  hideoutEntityScanLogged = false;
  waystoneNoMatchLogAt = 0;
  hideoutWaystoneMoveAttempts = 0;
  hideoutTraverseAttempts = 0;
  hideoutPortalEnterAttempts = 0;
  deathHealthZeroAt = 0;
  deathReturnTriggeredAt = 0;
  mapCompleteBossDeathX = 0;
  mapCompleteBossDeathY = 0;
  mapCompletePortalInteractLastAt = 0;
  mapCompletePortalInteractAttempts = 0;
  mapCompleteOpenPortalLastAt = 0;
  mapCompleteOpenPortalAttempts = 0;
  mapCompleteFlowStartTime = 0;
  mapCompleteRetreatReachedAt = 0;
  mapCompleteLastHp = 0;
  mapCompleteDangerDetectedAt = 0;
  mapCompleteDangerEscapeAttempts = 0;
  mapCompleteDangerLastEscapeAt = 0;
}

// ============================================================================
// HIDEOUT FLOW HELPERS
// ============================================================================

function isInHideout() {
  const areaInfo = poe2.getAreaInfo();
  if (!areaInfo || !areaInfo.isValid) return false;
  const name = `${areaInfo.areaName || ''} ${areaInfo.areaId || ''}`.toLowerCase();
  return name.includes('hideout');
}

function findActiveMapPortal() {
  const entities = poe2.getEntities({ maxDistance: 200, lightweight: true });
  if (!entities || entities.length === 0) return null;
  const player = POE2Cache.getLocalPlayer();
  const px = player?.gridX;
  const py = player?.gridY;
  let best = null;
  let bestDist = Infinity;
  for (const e of entities) {
    const path = (e.name || '').toLowerCase();
    const rname = (e.renderName || '').toLowerCase();
    const isPortal = path.includes('portal') || rname.includes('portal');
    const isWaypoint = path.includes('waypoint');
    if (isPortal && !isWaypoint) {
      // Skip completed-map portals (name contains "completed")
      if (rname.includes('completed') || path.includes('completed')) {
        continue;
      }
      if (Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(e.gridX) && Number.isFinite(e.gridY)) {
        const d = Math.hypot(e.gridX - px, e.gridY - py);
        if (d < bestDist) {
          bestDist = d;
          best = e;
        }
      } else {
        // Fallback if player/entity coords are unavailable.
        return e;
      }
    }
  }
  return best;
}

function hasActiveMapPortal() {
  return findActiveMapPortal() !== null;
}

function findMapDeviceEntity() {
  // Map Device is a TILE entity — not in normal entity slabs.
  // Use getTileEntities() which scans the terrain tile grid.
  const tileEntities = poe2.getTileEntities({ nameContains: 'MapDevice' });

  // One-time log of all tile entities to help debug
  if (!hideoutEntityScanLogged) {
    hideoutEntityScanLogged = true;
    // Also log all tile entities in range for diagnostics
    const allTiles = poe2.getTileEntities({ maxDistance: 200 });
    if (allTiles && allTiles.length > 0) {
      log(`[Hideout] Found ${allTiles.length} tile entities nearby:`);
      for (const e of allTiles) {
        log(`  addr=${e.address} render="${e.renderName || ''}" path="${e.name || ''}" type=${e.entityType}`);
      }
    } else {
      log('[Hideout] No tile entities found nearby');
    }
  }

  if (tileEntities && tileEntities.length > 0) {
    const dev = tileEntities[0];
    log(`[Hideout] Found Map Device: addr=${dev.address} render="${dev.renderName}" grid=(${dev.gridX?.toFixed(1)}, ${dev.gridY?.toFixed(1)})`);
    return dev;
  }

  // Fallback: also check regular entities in case some map devices are in slabs
  const entities = poe2.getEntities({ maxDistance: 200, lightweight: true });
  if (entities) {
    for (const e of entities) {
      const rname = (e.renderName || '').toLowerCase();
      const path = (e.name || '').toLowerCase();
      if (rname.includes('map device') || path.includes('mapdevice') ||
          path.includes('map_device') || rname.includes('mapdevice')) {
        return e;
      }
    }
  }
  return null;
}

function buildCustomTraversePacket(x, y) {
  const xBytes = int32ToBytesBE(x);
  const yBytes = int32ToBytesBE(y);
  return new Uint8Array([0x00, 0xEC, 0x01, ...xBytes, ...yBytes]);
}

function computeTraversePacketDebug() {
  // Returns debug info about the activation key for the currently selected node.
  // The activation key is at node+0x2C8 (two int32 LE values, sent as BE in packet).
  const result = { available: false, reason: 'Not computed', hex: '', nodeInfo: null };

  // If we have a captured activation key from selectAtlasNode, show it
  if (hideoutActivationKey) {
    const { x, y } = hideoutActivationKey;
    const xBytes = int32ToBytesBE(x);
    const yBytes = int32ToBytesBE(y);
    const packet = new Uint8Array([0x00, 0xEC, 0x01, ...xBytes, ...yBytes]);
    result.available = true;
    result.hex = packetToHex(packet);
    result.actX = x;
    result.actY = y;
    result.source = 'captured';
  }

  // Also try to read activation data from atlas nodes for the debug display
  const atlas = poe2.getAtlasNodes({ includeHidden: true });
  if (atlas && atlas.isValid) {
    result.nodeInfo = [];
    for (let i = 0; i < atlas.nodes.length; i++) {
      const n = atlas.nodes[i];
      if (!n.isUnlocked || n.isCompleted) continue;
      if (n.activationX !== undefined && n.activationY !== undefined) {
        const ax = n.activationX;
        const ay = n.activationY;
        const xB = int32ToBytesBE(ax);
        const yB = int32ToBytesBE(ay);
        const pkt = new Uint8Array([0x00, 0xEC, 0x01, ...xB, ...yB]);
        const name = n.shortName || n.fullName || `Node ${i}`;
        result.nodeInfo.push({
          index: i,
          name,
          actX: ax,
          actY: ay,
          rawHex: (n.activationRawBytes || []).map(b => b.toString(16).padStart(2, '0')).join(' '),
          packetHex: packetToHex(pkt),
        });
      }
    }
    if (!result.available && result.nodeInfo.length > 0) {
      // No captured key yet - show what the first node would be
      const first = result.nodeInfo[0];
      result.available = true;
      result.hex = first.packetHex;
      result.actX = first.actX;
      result.actY = first.actY;
      result.source = 'atlas (first uncompleted)';
    }
  }

  return result;
}

function buildTraversePacket() {
  // Build the Traverse activation packet: 00 EC 01 [int32_BE val1] [int32_BE val2]
  //
  // The payload is NOT screen coordinates - it's the atlas node's activation key
  // stored at node+0x2C8 as two little-endian int32 values. The packet encodes
  // them as big-endian. This key uniquely identifies which map to activate.
  //
  // The activation key is captured during selectAtlasNode() and stored in
  // hideoutActivationKey = { x, y }.

  if (!hideoutActivationKey) {
    log('[Traverse] ERROR: No activation key captured! Using fallback packet.');
    return new Uint8Array(TRAVERSE_PACKET_WORKING);
  }

  const { x, y } = hideoutActivationKey;
  const xBytes = int32ToBytesBE(x);
  const yBytes = int32ToBytesBE(y);
  const packet = new Uint8Array([0x00, 0xEC, 0x01, ...xBytes, ...yBytes]);
  log(`[Traverse] Activation key=(${x}, ${y}) Packet: ${packetToHex(packet)}`);
  return packet;
}

function interactWithEntity(entityId) {
  const packet = new Uint8Array([
    0x01, 0x90, 0x01, 0x20, 0x00, 0xC2, 0x66, 0x04, 0x00, 0xFF, 0x08, 0x00, 0x00,
    (entityId >> 8) & 0xFF,
    entityId & 0xFF
  ]);
  return poe2.sendPacket(packet);
}

function packetToHex(packet) {
  return Array.from(packet || []).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function sendHideoutReturnPacketA() {
  // Candidate packet captured by user for hideout return flow.
  const packet = new Uint8Array([0x00, 0x63, 0x01, 0x00]);
  const ok = poe2.sendPacket(packet);
  log(`[Manual] Send hideout-return candidate A: ${packetToHex(packet)} ok=${ok}`);
  return ok;
}

function sendHideoutReturnPacketB() {
  // Candidate packet captured by user for resurrect-in-hideout flow.
  const packet = new Uint8Array([0x01, 0x69, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]);
  const ok = poe2.sendPacket(packet);
  log(`[Manual] Send hideout-return candidate B: ${packetToHex(packet)} ok=${ok}`);
  return ok;
}

function sendBackToHideoutAndReset(source = 'Manual') {
  const okA = sendHideoutReturnPacketA();
  const okB = sendHideoutReturnPacketB();
  log(`[${source}] Back To Hideout sequence sent (A then B), okA=${okA}, okB=${okB}. Resetting mapper state.`);
  resetMapper();
  return okA || okB;
}

function tryHandleDeathReturn(now, player) {
  const hpMax = Number(player?.healthMax || 0);
  const hpCur = Number(player?.healthCurrent || 0);
  if (!Number.isFinite(hpMax) || hpMax <= 0) {
    deathHealthZeroAt = 0;
    return false;
  }
  if (hpCur > 0) {
    deathHealthZeroAt = 0;
    return false;
  }

  if (deathReturnTriggeredAt > 0 && (now - deathReturnTriggeredAt) < DEATH_HIDEOUT_TRIGGER_COOLDOWN_MS) {
    statusMessage = `Death return cooldown... ${((DEATH_HIDEOUT_TRIGGER_COOLDOWN_MS - (now - deathReturnTriggeredAt)) / 1000).toFixed(1)}s`;
    return true;
  }

  if (deathHealthZeroAt === 0) {
    deathHealthZeroAt = now;
    statusMessage = `Health 0 detected, re-validating in ${(DEATH_HIDEOUT_RECHECK_DELAY_MS / 1000).toFixed(1)}s...`;
    return true;
  }

  const waitMs = now - deathHealthZeroAt;
  if (waitMs < DEATH_HIDEOUT_RECHECK_DELAY_MS) {
    statusMessage = `Health 0 re-check pending... ${((DEATH_HIDEOUT_RECHECK_DELAY_MS - waitMs) / 1000).toFixed(1)}s`;
    return true;
  }

  const fresh = poe2.getLocalPlayer();
  const freshMax = Number(fresh?.healthMax || hpMax);
  const freshCur = Number(fresh?.healthCurrent || 0);
  if (Number.isFinite(freshMax) && freshMax > 0 && freshCur <= 0) {
    deathHealthZeroAt = 0;
    deathReturnTriggeredAt = now;
    sendBackToHideoutAndReset('Death');
    statusMessage = 'Health 0 confirmed, returning to hideout...';
    return true;
  }

  deathHealthZeroAt = 0;
  return false;
}

function isAtlasPanelVisible() {
  const atlas = poe2.getAtlasNodes();
  return atlas && atlas.isValid;
}

function findFirstUncompletedNode() {
  const atlas = poe2.getAtlasNodes();
  if (!atlas || !atlas.isValid) return -1;
  for (let i = 0; i < atlas.nodes.length; i++) {
    const n = atlas.nodes[i];
    if (!n.isUnlocked || n.isCompleted) continue;
    if (hideoutFailedNodeBlacklist.has(i)) continue;
    return i;
  }
  // If everything available is blacklisted, clear fail-blacklist once and try again.
  // This prevents hard lock if all visible nodes failed previously.
  if (hideoutFailedNodeBlacklist.size > 0) {
    hideoutFailedNodeBlacklist.clear();
    log('[Hideout] Cleared failed-node blacklist (no selectable nodes remained)');
    for (let i = 0; i < atlas.nodes.length; i++) {
      const n = atlas.nodes[i];
      if (n.isUnlocked && !n.isCompleted) return i;
    }
  }
  return -1;
}

function blacklistCurrentHideoutNode(reason = '') {
  if (hideoutSelectedNodeIndex >= 0) {
    hideoutFailedNodeBlacklist.add(hideoutSelectedNodeIndex);
    log(
      `[Hideout] Blacklisted atlas node ${hideoutSelectedNodeIndex} ` +
      `(failed portal entry${reason ? `: ${reason}` : ''})`
    );
  } else {
    log(`[Hideout] Failed portal entry${reason ? `: ${reason}` : ''} (no selected node index to blacklist)`);
  }
}

function getAcceptedWaystoneRarities() {
  const rarities = [];
  if (currentSettings.waystoneRarityNormal) rarities.push(0);
  if (currentSettings.waystoneRarityMagic) rarities.push(1);
  if (currentSettings.waystoneRarityRare) rarities.push(2);
  if (currentSettings.waystoneRarityUnique) rarities.push(3);
  return rarities;
}

function getAcceptedPrecursorRarities() {
  const rarities = [];
  if (currentSettings.precursorRarityNormal) rarities.push(0);
  if (currentSettings.precursorRarityMagic) rarities.push(1);
  if (currentSettings.precursorRarityRare) rarities.push(2);
  if (currentSettings.precursorRarityUnique) rarities.push(3);
  return rarities;
}

function isMapperMasterEnabled() {
  // Keep both values in agreement; this protects against stale mutable value cases.
  return !!enabled.value && !!currentSettings.enabled;
}

function setHideoutSuspended(reasonCode, detail = '') {
  const finalReason = detail ? `${reasonCode}: ${detail}` : reasonCode;
  hideoutSuspendReason = finalReason;
  log(`[Hideout] Suspended -> ${finalReason}`);
  setState(STATE.HIDEOUT_SUSPENDED);
}

function rarityName(rarity) {
  return ITEM_RARITY_NAMES[rarity] || `R${rarity}`;
}

function getItemSlotRef(item) {
  const slotId = Number(item?.slotId || 0);
  if (slotId > 0) return slotId;
  const slotHandle = Number(item?.itemSlotHandle || 0);
  if (slotHandle > 0) return slotHandle;
  return 0;
}

function getItemCorruptionInfo(item) {
  if (!item) return { corrupted: false, known: false };
  // Positive-only evidence:
  // Some APIs expose false/0 for all items, so negative values are not trusted.
  if (item.isCorrupted === true || item.corrupted === true) return { corrupted: true, known: true };
  if (Number(item.corruptionState) > 0) return { corrupted: true, known: true };
  const tags = [
    item.corruptionState,
    item.flags,
    item.state,
    item.implicitText,
    item.explicitText,
    item.flavorText,
    item.baseName,
    item.uniqueName,
  ];
  for (const t of tags) {
    if (typeof t === 'string' && t.toLowerCase().includes('corrupt')) {
      return { corrupted: true, known: true };
    }
  }
  // If API explicitly exposes non-corrupted flags, treat as known clean.
  // Keep this strict to avoid false negatives on APIs that omit the field.
  if (Object.prototype.hasOwnProperty.call(item, 'isCorrupted') && item.isCorrupted === false) {
    return { corrupted: false, known: true };
  }
  if (Object.prototype.hasOwnProperty.call(item, 'corrupted') && item.corrupted === false) {
    return { corrupted: false, known: true };
  }
  if (Object.prototype.hasOwnProperty.call(item, 'corruptionState') && Number(item.corruptionState) === 0) {
    return { corrupted: false, known: true };
  }
  // Unknown, not confirmed non-corrupted.
  return { corrupted: false, known: false };
}

function extractWaystoneTier(item) {
  const probes = [
    item?.baseName || '',
    item?.uniqueName || '',
    item?.itemPath || '',
  ];

  for (const txt of probes) {
    const tierMatch = txt.match(/[Tt]ier[\s:_-]*(\d{1,2})/);
    if (tierMatch) return parseInt(tierMatch[1], 10);
    const pathTier = txt.match(/(?:^|[_\-\/])t(?:ier)?[_\-]?(\d{1,2})(?:$|[_\-\/])/i);
    if (pathTier) return parseInt(pathTier[1], 10);
  }
  return 0;
}

function collectWaystoneCandidates(inv, acceptedRarities, minTier, maxTier) {
  const candidates = [];
  const stats = {
    seenWaystones: 0,
    rarityRejected: 0,
    tierRejected: 0,
    missingTierParsed: 0,
    corruptedRejected: 0,
    corruptionUnknown: 0,
  };

  for (const item of inv.items) {
    if (!item.hasItem) continue;
    const path = (item.itemPath || '').toLowerCase();
    const name = (item.baseName || '').toLowerCase();
    if (!path.includes('waystone') && !name.includes('waystone')) continue;
    stats.seenWaystones++;

    if (!acceptedRarities.includes(item.rarity)) {
      stats.rarityRejected++;
      continue;
    }
    const corruptionInfo = getItemCorruptionInfo(item);

    const tier = extractWaystoneTier(item);
    if (tier <= 0) stats.missingTierParsed++;

    if (tier > 0 && (tier < minTier || tier > maxTier)) {
      stats.tierRejected++;
      continue;
    }

    candidates.push({
      ...item,
      tier,
      corrupted: corruptionInfo.corrupted,
      corruptionKnown: corruptionInfo.known,
      slotRef: getItemSlotRef(item),
    });
  }

  // Apply corrupted-only as positive-evidence filter.
  // If no positive evidence exists at all, fail-open instead of rejecting everything.
  const corruptedOnly = !!currentSettings.waystoneCorruptedOnly && !currentSettings.waystoneNonCorruptedOnly;
  const nonCorruptedOnly = !!currentSettings.waystoneNonCorruptedOnly;

  if (corruptedOnly && candidates.length > 0) {
    const positives = candidates.filter(c => c.corrupted);
    if (positives.length > 0) {
      stats.corruptedRejected += (candidates.length - positives.length);
      return { candidates: positives, stats };
    }
    stats.corruptionUnknown = candidates.length;
  }

  // Apply non-corrupted-only filter (STRICT).
  // If corruption state is unknown, we reject it because user explicitly requested
  // non-corrupted items only.
  if (nonCorruptedOnly && candidates.length > 0) {
    const knownClean = candidates.filter(c => c.corruptionKnown && !c.corrupted);
    if (knownClean.length === 0) {
      stats.corruptedRejected += candidates.filter(c => c.corrupted).length;
      stats.corruptionUnknown = candidates.filter(c => !c.corruptionKnown).length;
      return { candidates: [], stats };
    }
    stats.corruptedRejected += (candidates.length - knownClean.length);
    return { candidates: knownClean, stats };
  }

  return { candidates, stats };
}

function isLikelyTpmInventory(inv) {
  const hint = `${inv?.inventoryName || ''} ${inv?.uiPath || ''}`.toLowerCase();
  if (hint.includes('traverse') || hint.includes('mapdevice') || hint.includes('map_device') || hint.includes('map device')) {
    return true;
  }
  const w = Number(inv?.gridWidth || 0);
  const h = Number(inv?.gridHeight || 0);
  // Typical map-device slots are tiny; this avoids matching random large UIs.
  return w > 0 && h > 0 && w <= 4 && h <= 2;
}

function findNearestReturnPortal(maxDistance = 140) {
  const entities = poe2.getEntities({ maxDistance, lightweight: true }) || [];
  const player = POE2Cache.getLocalPlayer();
  if (!player) return null;
  let bestTown = null;
  let bestTownDist = Infinity;
  let bestMap = null;
  let bestMapDist = Infinity;

  function classifyPortalEntity(e) {
    const pathRaw = `${e?.name || ''}`;
    const rnameRaw = `${e?.renderName || ''}`;
    const path = pathRaw.toLowerCase();
    const rname = rnameRaw.toLowerCase();
    const looksHideoutLabel = rname.includes(' hideout') || rname.endsWith('hideout');

    // Ignore obvious non-portals and problematic portal-like monster objects.
    const hasPortalToken = path.includes('portal') || rname.includes('portal');
    // Some return portals render as "<Area> Hideout" without literal "portal" token.
    if (!hasPortalToken && looksHideoutLabel) return 'town';
    if (!hasPortalToken) return null;
    if (path.includes('waypoint')) return null;
    if (path.includes('/monsters/') || path.includes('\\monsters\\')) return null;
    if (path.includes('beacon') || path.includes('checkpoint')) return null;

    // If targetable flag exists, trust it to avoid non-interactable visuals.
    if (e && e.isTargetable === false) return null;

    // Strong allowlist for real return portals.
    const isTown =
      path.includes('townportal') ||
      rname.includes('town portal') ||
      rname.includes('hideout portal') ||
      looksHideoutLabel ||
      path.includes('hideout');
    if (isTown) return 'town';

    const isMap =
      path.includes('mapportal') ||
      path.includes('map_device_portal') ||
      rname.includes('map portal') ||
      rname === 'portal';
    if (isMap) return 'map';

    return null;
  }

  for (const e of entities) {
    const portalType = classifyPortalEntity(e);
    if (!portalType) continue;
    const d = Math.hypot((e.gridX || 0) - player.gridX, (e.gridY || 0) - player.gridY);

    if (portalType === 'town' && d < bestTownDist) {
      bestTown = e;
      bestTownDist = d;
    }
    if (portalType === 'map' && d < bestMapDist) {
      bestMap = e;
      bestMapDist = d;
    }
  }
  return bestTown || bestMap;
}

function sendOpenTownPortalPacket() {
  // Provided packet capture for opening a town portal outside hideout.
  const packet = new Uint8Array([0x00, 0xC4, 0x01]);
  return poe2.sendPacket(packet);
}

function tpmWaystoneSlotHasItem() {
  // Check if the TPM waystone slot already contains an item.
  // Use getVisibleInventories but only consider inventories that look like map device/traverse UI.
  try {
    const visInvs = poe2.getVisibleInventories();
    if (!visInvs) return false;
    for (const inv of visInvs) {
      // Skip player inventories (ID 1 = main bag, 2/3 = secondary bags, etc.)
      if (inv.inventoryId <= 10) continue;
      if (!isLikelyTpmInventory(inv)) continue;
      // Check if this inventory has any items (likely the map device slot)
      if (inv.items && inv.items.length > 0) {
        for (const item of inv.items) {
          const name = (item.baseName || '').toLowerCase();
          if (name.includes('waystone')) {
            log(
              `[Hideout] TPM slot check: found waystone in invId=${inv.inventoryId} ` +
              `name="${inv.inventoryName || ''}" uiPath="${inv.uiPath || ''}" grid=${inv.gridWidth || 0}x${inv.gridHeight || 0}`
            );
            return true;
          }
        }
      }
    }
  } catch (e) {
    // getVisibleInventories may not be available or may fail
  }
  return false;
}

function getLikelyTpmInventories() {
  const visInvs = poe2.getVisibleInventories();
  if (!visInvs) return [];
  return visInvs.filter(inv => inv.inventoryId > 10 && isLikelyTpmInventory(inv));
}

function inspectTraverseDeviceSlots() {
  const invs = getLikelyTpmInventories();
  let hasWaystone = false;
  let precursorCount = 0;
  const waystones = [];

  for (const inv of invs) {
    for (const item of (inv.items || [])) {
      const path = (item.itemPath || '').toLowerCase();
      const name = (item.baseName || '').toLowerCase();
      if (path.includes('waystone') || name.includes('waystone')) {
        hasWaystone = true;
        waystones.push({
          name: item.baseName || item.uniqueName || 'Waystone',
          slotRef: getItemSlotRef(item),
          tier: extractWaystoneTier(item),
          rarity: item.rarity,
        });
      }
      if (path.includes('precursor') || name.includes('precursor')) precursorCount++;
    }
  }

  return { hasWaystone, precursorCount, invs, waystones };
}

function findWaystoneInInventory() {
  const inv = poe2.getInventory(1);
  if (!inv || !inv.isValid || !inv.items) return null;
  const acceptedRarities = getAcceptedWaystoneRarities();
  const minTier = currentSettings.waystoneMinTier || 1;
  const maxTier = currentSettings.waystoneMaxTier || 16;

  const { candidates, stats } = collectWaystoneCandidates(inv, acceptedRarities, minTier, maxTier);

  if (candidates.length === 0) {
    const now = Date.now();
    if (now - waystoneNoMatchLogAt > 2500) {
      waystoneNoMatchLogAt = now;
      if (currentSettings.waystoneNonCorruptedOnly && inv.items) {
        const rawWaystones = inv.items
          .filter(i => i?.hasItem && (((i.itemPath || '').toLowerCase().includes('waystone')) || ((i.baseName || '').toLowerCase().includes('waystone'))))
          .slice(0, 10);
        if (rawWaystones.length > 0) {
          log('[Hideout] Non-corrupted strict mode debug (raw item corruption fields):');
          for (const w of rawWaystones) {
            log(
              `  - ${w.baseName || w.uniqueName || 'Waystone'} ` +
              `isCorrupted=${String(w.isCorrupted)} corrupted=${String(w.corrupted)} ` +
              `corruptionState=${String(w.corruptionState)} flags=${String(w.flags)} state=${String(w.state)}`
            );
          }
        }
      }
      log(
        `[Hideout] Waystone scan found no candidates: ` +
        `seen=${stats.seenWaystones}, rarityRejected=${stats.rarityRejected}, tierRejected=${stats.tierRejected}, ` +
        `missingTierParsed=${stats.missingTierParsed}, corruptedRejected=${stats.corruptedRejected}, ` +
        `corruptionUnknown=${stats.corruptionUnknown}, minTier=${minTier}, maxTier=${maxTier}, ` +
        `corruptedOnly=${!!currentSettings.waystoneCorruptedOnly}, ` +
        `nonCorruptedOnly=${!!currentSettings.waystoneNonCorruptedOnly}, ` +
        `acceptedRarities=[${acceptedRarities.join(',')}]`
      );
    }
    return null;
  }

  // Prefer highest tier within range, then highest rarity
  candidates.sort((a, b) => (b.tier - a.tier) || (b.rarity - a.rarity));
  return candidates[0];
}

function findPrecursorInInventory() {
  const inv = poe2.getInventory(1);
  if (!inv || !inv.isValid || !inv.items) return null;
  const acceptedRarities = getAcceptedPrecursorRarities();

  for (const item of inv.items) {
    if (!item.hasItem) continue;
    const path = (item.itemPath || '').toLowerCase();
    const name = (item.baseName || '').toLowerCase();
    if (!path.includes('precursor') && !name.includes('precursor')) continue;
    if (!acceptedRarities.includes(item.rarity)) continue;
    return item;
  }
  return null;
}

function processHideoutFlow(now) {
  if (!isMapperMasterEnabled()) {
    if (currentState.startsWith('HIDEOUT_')) {
      log('[Hideout] Master mapper toggle OFF - stopping hideout flow');
      resetMapper();
    }
    return;
  }

  // Cooldown between actions to let UI/game respond
  if (now - hideoutLastActionTime < HIDEOUT_ACTION_COOLDOWN_MS) return;

  switch (currentState) {
    case STATE.HIDEOUT_CHECK_PORTALS: {
      if (hasActiveMapPortal()) {
        log('Active map portal found - will enter it');
        setState(STATE.HIDEOUT_ENTER_PORTAL);
        return;
      }
      log('No active portals - opening Map Device');
      setState(STATE.HIDEOUT_OPEN_MAP_DEVICE);
      break;
    }

    case STATE.HIDEOUT_OPEN_MAP_DEVICE: {
      // If atlas is already open, skip straight to map selection
      if (isAtlasPanelVisible()) {
        log('Atlas panel already open');
        setState(STATE.HIDEOUT_SELECT_MAP);
        return;
      }
      const mapDevice = findMapDeviceEntity();
      if (!mapDevice) {
        statusMessage = 'Map Device not found nearby';
        return;
      }
      hideoutMapDeviceId = mapDevice.id;
      log(`Interacting with Map Device (id=${mapDevice.id}, addr=${mapDevice.address}, render="${mapDevice.renderName || ''}")`);
      if (!mapDevice.id) {
        log('[Hideout] WARNING: Map Device entity ID is 0 - interaction may fail');
      }
      interactWithEntity(mapDevice.id);
      hideoutLastActionTime = now;
      setState(STATE.HIDEOUT_WAIT_ATLAS);
      break;
    }

    case STATE.HIDEOUT_WAIT_ATLAS: {
      if (isAtlasPanelVisible()) {
        log('Atlas panel opened');
        setState(STATE.HIDEOUT_SELECT_MAP);
        return;
      }
      // Timeout after 5s
      if (now - stateStartTime > 5000) {
        log('Timeout waiting for atlas panel - retrying');
        setState(STATE.HIDEOUT_OPEN_MAP_DEVICE);
      }
      statusMessage = 'Waiting for atlas panel...';
      break;
    }

    case STATE.HIDEOUT_SELECT_MAP: {
      // Atlas panel is open - read nodes and grab the activation key directly
      // from the node data (node+0x2C8) instead of calling selectAtlasNode.
      // Node data may take a moment to populate after the atlas panel opens,
      // so retry for up to 3 seconds before giving up.
      const nodeIdx = findFirstUncompletedNode();
      if (nodeIdx < 0) {
        if (now - stateStartTime < 3000) {
          statusMessage = 'Waiting for atlas node data...';
          return;
        }
        setHideoutSuspended(HIDEOUT_SUSPEND_REASON.NO_UNCOMPLETED_MAPS);
        return;
      }
      hideoutSelectedNodeIndex = nodeIdx;

      // Read activation key from the atlas node memory
      const atlasData = poe2.getAtlasNodes();
      if (!atlasData || !atlasData.isValid || !atlasData.nodes[nodeIdx]) {
        log('[Hideout] Failed to read atlas data for activation key');
        setHideoutSuspended(HIDEOUT_SUSPEND_REASON.OPEN_TRAVERSE_PANEL_FAILED);
        return;
      }

      const node = atlasData.nodes[nodeIdx];
      if (node.activationX !== undefined && node.activationY !== undefined) {
        hideoutActivationKey = { x: node.activationX, y: node.activationY };
        const name = node.shortName || node.fullName || `Node ${nodeIdx}`;
        log(`[Hideout] Selected map: ${name} [${nodeIdx}], activationKey=(${hideoutActivationKey.x}, ${hideoutActivationKey.y})`);
      } else {
        log(`[Hideout] Node ${nodeIdx} has no activation key data`);
        setHideoutSuspended(HIDEOUT_SUSPEND_REASON.OPEN_TRAVERSE_PANEL_FAILED);
        return;
      }

      // Now select the node to open the TPM (traverse panel)
      const result = poe2.selectAtlasNode(nodeIdx);
      const ok = typeof result === 'object' ? result.success : !!result;
      if (!ok) {
        log('[Hideout] selectAtlasNode failed - TPM may not open');
      } else {
        log('[Hideout] selectAtlasNode succeeded, waiting for TPM');
      }

      hideoutLastActionTime = now;
      setState(STATE.HIDEOUT_WAIT_TPM);
      break;
    }

    case STATE.HIDEOUT_WAIT_TPM: {
      // Wait for TPM to be ready after selectAtlasNode opened it
      const tpmHasWaystone = tpmWaystoneSlotHasItem();
      statusMessage = tpmHasWaystone
        ? 'Traverse panel detected (waystone already slotted)'
        : 'Waiting for traverse panel...';
      if (now - stateStartTime > 1000 && tpmHasWaystone) {
        log('[Hideout] TPM appears ready early (waystone slot populated)');
        hideoutWaystonePlaced = true;
        setState(currentSettings.enablePrecursors ? STATE.HIDEOUT_PLACE_PRECURSORS : STATE.HIDEOUT_ACTIVATE_MAP);
        return;
      }
      if (now - stateStartTime > 2000) {
        log(`[Hideout] TPM wait elapsed (${now - stateStartTime}ms), proceeding to waystone placement`);
        setState(STATE.HIDEOUT_PLACE_WAYSTONE);
      }
      break;
    }

    case STATE.HIDEOUT_PLACE_WAYSTONE: {
      // Already placed? Move on.
      if (hideoutWaystonePlaced) {
        if (currentSettings.enablePrecursors) {
          setState(STATE.HIDEOUT_PLACE_PRECURSORS);
        } else {
          setState(STATE.HIDEOUT_ACTIVATE_MAP);
        }
        return;
      }

      // Check if TPM waystone slot already has an item (prevent double-placement)
      if (tpmWaystoneSlotHasItem()) {
        log('TPM waystone slot already has an item - skipping placement');
        hideoutWaystonePlaced = true;
        if (currentSettings.enablePrecursors) {
          setState(STATE.HIDEOUT_PLACE_PRECURSORS);
        } else {
          setState(STATE.HIDEOUT_ACTIVATE_MAP);
        }
        return;
      }

      // Ensure the main inventory panel is visible before moving items
      // UI path: root > 1 > 29 > 5 > 35
      poe2.ensureUiVisible([1, 29, 5, 35]);

      // Check if we have a waystone in inventory
      const waystone = findWaystoneInInventory();
      if (!waystone) {
        setHideoutSuspended(HIDEOUT_SUSPEND_REASON.NO_WAYSTONE_MATCH, 'Inventory(1) has no waystone matching current filters');
        return;
      }

      // Deep visibility into what we found and why this candidate was chosen.
      try {
        const inv = poe2.getInventory(1);
        if (inv && inv.isValid && inv.items) {
          const acceptedRarities = getAcceptedWaystoneRarities();
          const minTier = currentSettings.waystoneMinTier || 1;
          const maxTier = currentSettings.waystoneMaxTier || 16;
          const { candidates } = collectWaystoneCandidates(inv, acceptedRarities, minTier, maxTier);
          log(`[Hideout] Found ${candidates.length} matching waystone candidate(s) before placement:`);
          for (const c of candidates.slice(0, 12)) {
            log(
              `  - ${c.baseName || c.uniqueName || 'Unknown'} ` +
              `rarity=${rarityName(c.rarity)}(${c.rarity}) tier=${c.tier || '?'} ` +
              `identified=${c.identifiedKnown ? (c.isIdentified ? 'yes' : 'no') : 'unknown'} ` +
              `corrupted=${c.corrupted ? 'yes' : (c.corruptionKnown ? 'no' : 'unknown')} ` +
              `slotId=${c.slotId || 0} slotHandle=${c.itemSlotHandle || 0} slotRef=${c.slotRef || 0}`
            );
          }
        }
      } catch (e) {
        log(`[Hideout] Candidate logging failed: ${e?.message || e}`);
      }

      // Cooldown between attempts to give inventory UI time to appear
      if (now - hideoutLastActionTime < HIDEOUT_ACTION_COOLDOWN_MS) return;

      // Move waystone to the map device slot
      const slotRef = getItemSlotRef(waystone);
      log(
        `Moving waystone: ${waystone.baseName} (T${waystone.tier || '?'}, rarity=${rarityName(waystone.rarity)}(${waystone.rarity})) ` +
        `identified=${waystone.identifiedKnown ? (waystone.isIdentified ? 'yes' : 'no') : 'unknown'} ` +
        `corrupted=${waystone.corrupted ? 'yes' : (waystone.corruptionKnown ? 'no' : 'unknown')} ` +
        `slotId=${waystone.slotId || 0} slotHandle=${waystone.itemSlotHandle || 0} slotRef=${slotRef}`
      );
      const moved = slotRef > 0 ? poe2.ctrlClickItem(1, slotRef) : false;
      hideoutLastActionTime = now;
      hideoutWaystoneMoveAttempts++;
      if (moved) {
        log('Waystone ctrl+click sent - verifying placement...');
        if (!tpmWaystoneSlotHasItem()) {
          log(`[Hideout] Post-click immediate verify: TPM slot still empty (attempt ${hideoutWaystoneMoveAttempts})`);
          if (hideoutWaystoneMoveAttempts >= 3) {
            setHideoutSuspended(
              HIDEOUT_SUSPEND_REASON.TPM_SLOT_NOT_DETECTED,
              `No waystone detected in TPM after ${hideoutWaystoneMoveAttempts} move attempts`
            );
            return;
          }
        }
        // Don't immediately mark as placed - we'll verify next tick via tpmWaystoneSlotHasItem()
      } else {
        log('Failed to move waystone - no valid slotRef or ctrl+click call failed.');
        setHideoutSuspended(HIDEOUT_SUSPEND_REASON.CTRLCLICK_FAILED, `ctrlClickItem(1, slotRef=${slotRef}) returned false`);
      }
      break;
    }

    case STATE.HIDEOUT_PLACE_PRECURSORS: {
      // Max 3 precursors
      if (hideoutPrecursorsPlaced >= 3) {
        log('All 3 precursor slots filled, activating map');
        setState(STATE.HIDEOUT_ACTIVATE_MAP);
        return;
      }

      // Ensure inventory is visible
      poe2.ensureUiVisible([1, 29, 5, 35]);

      const precursor = findPrecursorInInventory();
      if (!precursor) {
        log(`No more precursors to place (placed ${hideoutPrecursorsPlaced}), activating map`);
        setState(STATE.HIDEOUT_ACTIVATE_MAP);
        return;
      }

      // Cooldown between placements
      if (now - hideoutLastActionTime < HIDEOUT_ACTION_COOLDOWN_MS) return;

      const precursorSlotRef = getItemSlotRef(precursor);
      log(
        `Moving precursor ${hideoutPrecursorsPlaced + 1}/3: ${precursor.baseName} ` +
        `(rarity=${rarityName(precursor.rarity)}(${precursor.rarity})) ` +
        `slotId=${precursor.slotId || 0} slotHandle=${precursor.itemSlotHandle || 0} slotRef=${precursorSlotRef}`
      );
      const moved = precursorSlotRef > 0 ? poe2.ctrlClickItem(1, precursorSlotRef) : false;
      if (moved) {
        hideoutPrecursorsPlaced++;
        hideoutLastActionTime = now;
        // Stay in this state to place more (cooldown will gate next attempt)
      } else {
        log(`Failed to move precursor (slotRef=${precursorSlotRef})`);
        setState(STATE.HIDEOUT_ACTIVATE_MAP);
      }
      break;
    }

    case STATE.HIDEOUT_ACTIVATE_MAP: {
      // Final validation before execute-traverse packet:
      // waystone must be present; precursors must still be present if enabled.
      const slotInfo = inspectTraverseDeviceSlots();
      const expectedPrecursors = currentSettings.enablePrecursors ? Math.min(3, hideoutPrecursorsPlaced) : 0;
      if (!slotInfo.hasWaystone) {
        log('[Hideout] Traverse validation: waystone missing from TPM; returning to placement');
        hideoutWaystonePlaced = false;
        setState(STATE.HIDEOUT_PLACE_WAYSTONE);
        return;
      }
      if (expectedPrecursors > 0 && slotInfo.precursorCount < expectedPrecursors) {
        log(
          `[Hideout] Traverse validation: precursor mismatch (${slotInfo.precursorCount}/${expectedPrecursors}); ` +
          `returning to precursor placement`
        );
        hideoutPrecursorsPlaced = slotInfo.precursorCount;
        setState(STATE.HIDEOUT_PLACE_PRECURSORS);
        return;
      }

      const invDebug = slotInfo.invs
        .map(inv => `invId=${inv.inventoryId} name="${inv.inventoryName || ''}" uiPath="${inv.uiPath || ''}" items=${(inv.items || []).length}`)
        .join(' | ');
      log(
        `[Hideout] Traverse validation OK: waystone=${slotInfo.hasWaystone} ` +
        `precursors=${slotInfo.precursorCount}/${expectedPrecursors} [${invDebug}]`
      );

      // Execute Traverse: send the activation packet built from node+0x2C8 data.
      // Packet format: 00 EC 01 [int32_BE activationX] [int32_BE activationY]
      hideoutTraverseAttempts++;
      const activatePacket = buildTraversePacket();
      log(`Sending map activation packet (attempt ${hideoutTraverseAttempts}): ${packetToHex(activatePacket)}`);
      const sent = poe2.sendPacket(activatePacket);
      log(`sendPacket returned: ${sent}`);
      if (!sent) {
        setHideoutSuspended(HIDEOUT_SUSPEND_REASON.TRAVERSE_PACKET_FAILED, `sendPacket returned false on attempt ${hideoutTraverseAttempts}`);
        return;
      }

      // Close/hide the atlas panel and any force-shown TPM inventories so we can
      // see and interact with the portal that spawns.
      poe2.ensureUiVisible([1, 22], false);
      log('[Hideout] Hid atlas panel after activation packet');

      hideoutLastActionTime = now;
      setState(STATE.HIDEOUT_WAIT_PORTAL);
      break;
    }

    case STATE.HIDEOUT_WAIT_PORTAL: {
      // Wait for a new (non-completed) portal to spawn in the hideout
      statusMessage = 'Waiting for map portal to spawn...';
      const portal = findActiveMapPortal();
      if (portal) {
        log(`Map portal spawned: id=${portal.id} render="${portal.renderName || ''}" path="${portal.name || ''}"`);
        setState(STATE.HIDEOUT_ENTER_PORTAL);
        return;
      }
      // Timeout after 10s
      if (now - stateStartTime > 10000) {
        if (hideoutTraverseAttempts < 3) {
          log(`Timeout waiting for portal, retrying traverse execute (${hideoutTraverseAttempts}/3)`);
          setState(STATE.HIDEOUT_ACTIVATE_MAP);
          return;
        }
        log('Timeout waiting for portal to spawn');
        setHideoutSuspended(
          HIDEOUT_SUSPEND_REASON.PORTAL_NOT_SPAWNED,
          `No portal after ${hideoutTraverseAttempts} execute attempts`
        );
      }
      break;
    }

    case STATE.HIDEOUT_ENTER_PORTAL: {
      // Interact with the portal to enter the map
      if (now - hideoutLastActionTime < HIDEOUT_ACTION_COOLDOWN_MS) return;
      const maxPortalAttempts = Math.max(1, Math.min(4, Number(currentSettings.hideoutPortalEnterMaxAttempts || 4)));
      if (hideoutPortalEnterAttempts >= maxPortalAttempts) {
        blacklistCurrentHideoutNode(`attempts=${hideoutPortalEnterAttempts}`);
        log(
          `[Hideout] Portal entry failed ${hideoutPortalEnterAttempts}/${maxPortalAttempts} times. ` +
          `Starting a fresh node instead of reusing this portal.`
        );
        hideoutPortalEnterAttempts = 0;
        hideoutTraverseAttempts = 0;
        hideoutWaystonePlaced = false;
        hideoutPrecursorsPlaced = 0;
        hideoutSelectedNodeIndex = -1;
        hideoutActivationKey = null;
        setState(STATE.HIDEOUT_OPEN_MAP_DEVICE);
        return;
      }
      const portal = findActiveMapPortal();
      if (!portal) {
        log('Portal disappeared - going back to wait');
        setState(STATE.HIDEOUT_WAIT_PORTAL);
        return;
      }
      hideoutPortalEnterAttempts++;
      log(`Entering map portal (id=${portal.id}) attempt=${hideoutPortalEnterAttempts}`);
      const ok = interactWithEntity(portal.id);
      if (!ok) {
        log('[Hideout] Portal interact packet send returned false; will retry');
      }
      hideoutLastActionTime = now;
      // The area change will reset mapper into normal map-running mode
      // via the areaGuard logic in processMapper()
      statusMessage = 'Entering map portal...';
      break;
    }

    case STATE.HIDEOUT_SUSPENDED: {
      statusMessage = `Suspended: ${hideoutSuspendReason}`;
      break;
    }
  }
}

function processMapper() {
  if (!isMapperMasterEnabled()) {
    if (currentState !== STATE.IDLE) {
      resetMapper();
      sendStopMovementLimited(true);
    }
    return;
  }

  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) return;
  const now = Date.now();

  // Death fail-safe: if health is zero, re-check after a short delay, then
  // trigger hideout return + reset using the confirmed working sequence.
  if (tryHandleDeathReturn(now, player)) {
    return;
  }

  // Area guard: handle hideout flow or block in towns
  const areaInfo = poe2.getAreaInfo();
  if (isNonMapArea(areaInfo)) {
    const areaLabel = areaInfo?.areaName || areaInfo?.areaId || 'unknown';
    const inHideout = areaLabel.toLowerCase().includes('hideout');

    // Hideout flow: if enabled, run the map-opening flow
    if (inHideout && currentSettings.hideoutFlowEnabled && isMapperMasterEnabled()) {
      if (!areaGuardBlockedLastFrame || areaGuardLastName !== areaLabel) {
        areaGuardBlockedLastFrame = true;
        areaGuardLastName = areaLabel;
      }
      // If we were in a map state, reset first
      if (currentState !== STATE.IDLE &&
          !currentState.startsWith('HIDEOUT_')) {
        resetMapper();
        sendStopMovementLimited(true);
      }
      // Start hideout flow if idle
      if (currentState === STATE.IDLE) {
        setState(STATE.HIDEOUT_CHECK_PORTALS);
      }
      // Process hideout state machine
      processHideoutFlow(Date.now());
      return;
    }

    // Non-hideout non-map area (town etc) - just wait
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
    // If we were in hideout flow, reset to start fresh map logic
    if (currentState.startsWith('HIDEOUT_')) {
      resetMapper();
    }
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
      pruneTempleUnreachableTargets(now);
      if (isIncursionObjectiveComplete()) {
        templeCleared = true;
        log('Incursion objective already completed -> skipping temple and continuing to boss');
        setState(STATE.FINDING_BOSS);
        break;
      }

      // Early boss pre-scan (just in case boss path/signal is already known).
      const earlyBoss = getRadarBossTarget();
      if (earlyBoss && !earlyBossHintLogged) {
        earlyBossHintLogged = true;
        log(`Early boss signal detected at (${earlyBoss.x.toFixed(0)}, ${earlyBoss.y.toFixed(0)})`);
      }

      const templeLoc = findTempleTgt();
      const templeLocBlocked = templeLoc && isTempleTargetTemporarilyBlocked(templeLoc.x, templeLoc.y);
      if (templeLoc && !templeLocBlocked) {
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
        if (!alreadyClear && isIncursionObjectiveComplete()) {
          alreadyClear = true;
          log('Incursion objective completed -> temple considered cleared');
        }

        if (alreadyClear) {
          templeCleared = true;
          setState(STATE.FINDING_BOSS);
        } else {
          templeExploreNoPathCount = 0;
          startWalkingTo(templeGridX, templeGridY, 'Temple', 'temple');
          setState(STATE.WALKING_TO_TEMPLE);
        }
      } else {
        templeFound = false;
        if (templeLocBlocked && now - lastTempleUnreachableLogTime > 1400) {
          log(`Temple target temporarily blocked (${templeLoc.x.toFixed(0)}, ${templeLoc.y.toFixed(0)}), exploring other lanes`);
          lastTempleUnreachableLogTime = now;
        }
        runTempleSearchExploration(player, now, templeLocBlocked ? 'target blocked' : '');
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
        const distToCandidate = Math.hypot(
          nearbyBossCandidate.gridX - player.gridX,
          nearbyBossCandidate.gridY - player.gridY
        );
        const engagedNow = detectActiveBossEngagement(player.gridX, player.gridY, now, 75);
        const canDirectMelee =
          distToCandidate <= 85 ||
          !!nearbyBossCandidate.cannotBeDamaged ||
          (!!engagedNow && engagedNow.entity && engagedNow.entity.id === nearbyBossCandidate.id);

        resumeTempleAfterBoss = true;
        checkpointReached = false;
        bossTgtFound = false;
        bossGridX = nearbyBossCandidate.gridX;
        bossGridY = nearbyBossCandidate.gridY;
        bossCandidateId = nearbyBossCandidate.id || 0;
        if (canDirectMelee) {
          checkpointReached = true; // safe to skip checkpoint because boss is truly close/engaged
          bossMeleeStaticLocked = false;
          bossMeleeStaticX = 0;
          bossMeleeStaticY = 0;
          bossMeleeLastRetargetTime = 0;
          log(
            `Boss encountered en route to temple at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)}) ` +
            `dist=${distToCandidate.toFixed(0)} -> direct melee`
          );
          setState(STATE.WALKING_TO_BOSS_MELEE);
        } else {
          log(
            `Boss-like unique seen during temple walk but too far for direct melee ` +
            `(dist=${distToCandidate.toFixed(0)}). Switching to FINDING_BOSS first.`
          );
          setState(STATE.FINDING_BOSS);
        }
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
        if (targetName && targetName.startsWith('Temple Explore')) {
          // Reached a temporary exploration leg; continue searching for real temple target.
          templeFound = false;
          templeStuckTime = 0;
          setState(STATE.FINDING_TEMPLE);
          break;
        }
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
            log(`Temple path unreachable for ${(stuckDuration / 1000).toFixed(0)}s, switching to temple search exploration`);
            lastTempleUnreachableLogTime = now;
          }
          if (Number.isFinite(templeGridX) && Number.isFinite(templeGridY)) {
            markTempleTargetTemporarilyBlocked(templeGridX, templeGridY, 22000);
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
          setState(STATE.FINDING_TEMPLE);
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
      if (isMapObjectiveComplete()) {
        log('Map objective complete while finding boss -> map complete');
        setState(STATE.MAP_COMPLETE);
        break;
      }
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
          'boss'
        );
        setState(STATE.WALKING_TO_BOSS_CHECKPOINT);
        break;
      }

      // No TGT/radar endpoint fallback for checkpoint selection.
      // If checkpoint isn't visible yet, keep exploring forward until it appears.

      // Prefer radar-guided exploration when available: this follows the exact
      // map route line and naturally handles layouts that require wrapping around walls.
      const radarBossHint = radarBossTarget || getRadarBossTarget();
      if (radarBossHint && !isAbandonedTarget(radarBossHint.x, radarBossHint.y)) {
        const hintDist = Math.hypot(player.gridX - radarBossHint.x, player.gridY - radarBossHint.y);
        if (hintDist > 24) {
          statusMessage = `Radar-guided boss search... ${hintDist.toFixed(0)} units`;
          const needRadarRetarget =
            targetName !== 'Boss Radar Explore' ||
            Math.abs(targetGridX - radarBossHint.x) > 24 ||
            Math.abs(targetGridY - radarBossHint.y) > 24 ||
            currentPath.length === 0;
          if (needRadarRetarget && now - lastRepathTime > 700) {
            startWalkingTo(radarBossHint.x, radarBossHint.y, 'Boss Radar Explore', 'boss');
          }
          const radarStep = stepPathWalker();
          if (radarStep === 'stuck' || (radarStep === 'walking' && currentPath.length === 0 && targetName === 'Boss Radar Explore')) {
            bossExploreNoPathCount++;
            if (bossExploreNoPathCount >= 4) {
              abandonedBossTargets.push({ x: radarBossHint.x, y: radarBossHint.y });
              bossExploreNoPathCount = 0;
              log(`Radar boss explore target unreachable, abandoning (${radarBossHint.x.toFixed(0)}, ${radarBossHint.y.toFixed(0)})`);
            }
          } else {
            bossExploreNoPathCount = 0;
          }
          break;
        }
      }

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
      if (isMapObjectiveComplete()) {
        log('Map objective complete during checkpoint walk -> map complete');
        setState(STATE.MAP_COMPLETE);
        break;
      }
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
      const approachLabel = bossTargetSource === 'arena_object' ? 'Boss Arena Barrier' : 'Boss Checkpoint';
      statusMessage = `Walking to ${approachLabel}... ${dist.toFixed(0)} units`;

      // Corridor lock-in:
      // If we are already near the radar boss endpoint (or have a nearby unique),
      // stop bouncing between checkpoint anchors and commit to boss melee flow.
      const radarBossDuringCheckpoint = getRadarBossTarget();
      if (radarBossDuringCheckpoint) {
        const pToRadar = Math.hypot(player.gridX - radarBossDuringCheckpoint.x, player.gridY - radarBossDuringCheckpoint.y);
        if (pToRadar <= 125) {
          checkpointReached = true;
          bossMeleeHoldStartTime = 0;
          bossMeleeStaticLocked = false;
          bossMeleeStaticX = 0;
          bossMeleeStaticY = 0;
          bossMeleeStaticEntityId = 0;
          bossMeleeLastRetargetTime = 0;
          log(`Near radar boss endpoint (${pToRadar.toFixed(0)}u) -> switching to melee engagement`);
          setState(STATE.WALKING_TO_BOSS_MELEE);
          break;
        }
      }
      const nearbyBossOnRoute = findBossCandidateUnique(
        player.gridX,
        player.gridY,
        135,
        radarBossDuringCheckpoint ? radarBossDuringCheckpoint.x : null,
        radarBossDuringCheckpoint ? radarBossDuringCheckpoint.y : null,
        radarBossDuringCheckpoint ? 240 : 190
      );
      if (nearbyBossOnRoute) {
        checkpointReached = true;
        bossCandidateId = nearbyBossOnRoute.id || bossCandidateId;
        bossMeleeHoldStartTime = 0;
        bossMeleeStaticLocked = false;
        bossMeleeStaticX = 0;
        bossMeleeStaticY = 0;
        bossMeleeStaticEntityId = 0;
        bossMeleeLastRetargetTime = 0;
        log('Nearby unique detected between checkpoints -> switching to melee engagement');
        setState(STATE.WALKING_TO_BOSS_MELEE);
        break;
      }

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

      // Keep boss-entry target fresh while approaching (checkpoint OR boss-arena barrier).
      if (now - lastBossCheckpointScanTime > 3000) {
        lastBossCheckpointScanTime = now;
        let nextTarget = null;
        let nextSource = '';
        const radarForRetarget = getRadarBossTarget();
        const checkpoints = poe2.getEntities({
          nameContains: 'Checkpoint_Endgame_Boss',
          lightweight: false,
        });
        if (checkpoints && checkpoints.length > 0) {
          const cp = selectBestBossCheckpoint(checkpoints, radarForRetarget, player.gridX, player.gridY);
          if (cp) {
            nextTarget = { x: cp.gridX, y: cp.gridY };
            nextSource = 'checkpoint';
          }
        }
        if (!nextTarget || bossTargetSource === 'arena_object') {
          const anchor = findBossRoomObjectAnchor(player.gridX, player.gridY, radarForRetarget);
          if (anchor) {
            const ax = anchor.anchorGridX ?? anchor.gridX;
            const ay = anchor.anchorGridY ?? anchor.gridY;
            if (Number.isFinite(ax) && Number.isFinite(ay)) {
              nextTarget = { x: ax, y: ay };
              nextSource = 'arena_object';
            }
          }
        }
        if (nextTarget && (Math.abs(nextTarget.x - bossGridX) > 20 || Math.abs(nextTarget.y - bossGridY) > 20)) {
          const currentToRadar = radarForRetarget ? Math.hypot(bossGridX - radarForRetarget.x, bossGridY - radarForRetarget.y) : Infinity;
          const nextToRadar = radarForRetarget ? Math.hypot(nextTarget.x - radarForRetarget.x, nextTarget.y - radarForRetarget.y) : Infinity;
          const playerToCurrent = Math.hypot(player.gridX - bossGridX, player.gridY - bossGridY);
          const playerToNext = Math.hypot(player.gridX - nextTarget.x, player.gridY - nextTarget.y);
          const shouldRetarget =
            !Number.isFinite(currentToRadar) ||
            nextToRadar + 45 < currentToRadar ||
            playerToCurrent > 260 ||
            playerToNext + 60 < playerToCurrent;
          if (!shouldRetarget) {
            // Keep current target to avoid back-and-forth between nearby checkpoint nodes.
            nextTarget = null;
          }
        }
        if (nextTarget) {
          bossGridX = nextTarget.x;
          bossGridY = nextTarget.y;
          bossTgtFound = true;
          bossTargetSource = nextSource || bossTargetSource;
          const retargetLabel = bossTargetSource === 'arena_object' ? 'Boss arena barrier retarget' : 'Checkpoint retarget';
          log(`${retargetLabel} -> (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
          startWalkingTo(
            bossGridX,
            bossGridY,
            bossTargetSource === 'arena_object' ? 'Boss Arena Barrier' : 'Boss Checkpoint',
            'boss'
          );
        }
      }

      if (result === 'arrived') {
        if (targetName === 'Boss Checkpoint Detour') {
          // Reached an intermediate lane point; retry direct checkpoint route from here.
          bossNoPathCount = 0;
          startWalkingTo(
            bossGridX,
            bossGridY,
            bossTargetSource === 'arena_object' ? 'Boss Arena Barrier' : 'Boss Checkpoint',
            'boss'
          );
          break;
        }
        const radarBossAtCheckpoint = getRadarBossTarget();
        const playerToRadar = radarBossAtCheckpoint
          ? Math.hypot(player.gridX - radarBossAtCheckpoint.x, player.gridY - radarBossAtCheckpoint.y)
          : Infinity;
        const engagedAtCheckpoint = detectActiveBossEngagement(player.gridX, player.gridY, now, 90);
        const nearbyBossCandidateAtCheckpoint = findBossCandidateUnique(
          player.gridX,
          player.gridY,
          125,
          radarBossAtCheckpoint ? radarBossAtCheckpoint.x : null,
          radarBossAtCheckpoint ? radarBossAtCheckpoint.y : null,
          radarBossAtCheckpoint ? 220 : 170
        );
        // Once checkpoint is reached, commit to melee-approach flow.
        // Do NOT bounce back to FINDING_BOSS here (causes checkpoint corridor yo-yo).
        if (nearbyBossCandidateAtCheckpoint && nearbyBossCandidateAtCheckpoint.id) {
          bossCandidateId = nearbyBossCandidateAtCheckpoint.id;
        }
        if (engagedAtCheckpoint && engagedAtCheckpoint.entity && engagedAtCheckpoint.entity.id) {
          bossCandidateId = engagedAtCheckpoint.entity.id;
        }

        checkpointReached = true;
        bossCandidateId = 0; // drop stale candidate lock from pre-checkpoint scans
        if (nearbyBossCandidateAtCheckpoint && nearbyBossCandidateAtCheckpoint.id) {
          bossCandidateId = nearbyBossCandidateAtCheckpoint.id;
        }
        if (engagedAtCheckpoint && engagedAtCheckpoint.entity && engagedAtCheckpoint.entity.id) {
          bossCandidateId = engagedAtCheckpoint.entity.id;
        }
        bossMeleeHoldStartTime = 0;
        bossMeleeStaticLocked = false;
        bossMeleeStaticX = 0;
        bossMeleeStaticY = 0;
        bossMeleeStaticEntityId = 0;
        bossMeleeLastRetargetTime = 0;
        log(`Boss entry reached (${bossTargetSource === 'arena_object' ? 'barrier' : 'checkpoint'}) -> switching to melee engagement`);
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
          log(`Boss entry path slow after ${(timeInWalk / 1000).toFixed(0)}s, continuing approach (no re-search)`);
          bossNoPathCount = 0;
          bossRecentDetours = [];
          stateStartTime = now; // restart watchdog window without leaving approach state
        } else {
          // Avoid ping-pong reset while we are already in a progress detour leg.
          if (!targetName.includes('Detour') && !targetName.includes('Mob Progress')) {
            startWalkingTo(
              bossGridX,
              bossGridY,
              bossTargetSource === 'arena_object' ? 'Boss Arena Barrier' : 'Boss Checkpoint',
              'boss'
            );
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
      if (isMapObjectiveComplete()) {
        log('Map objective complete during melee approach -> map complete');
        setState(STATE.MAP_COMPLETE);
        break;
      }
      const activeBoss = detectActiveBossEngagement(player.gridX, player.gridY, now, 95);
      if (activeBoss && activeBoss.entity) {
        const e = activeBoss.entity;
        // Safety-first: if boss is already active on engage, execute a fast evasive
        // roll before committing to fight state so we don't stand in front of attacks.
        const distToEngaged = Math.hypot(player.gridX - e.gridX, player.gridY - e.gridY);
        if (distToEngaged <= 90) {
          if (tryBossEmergencyRollOut(player, e, now) || tryBossDodgeRollBehind(player, e, now)) {
            statusMessage = `Boss engaged: evasive roll (${distToEngaged.toFixed(0)}u)`;
          }
        }
        bossEntityId = e.id || bossEntityId;
        bossGridX = e.gridX;
        bossGridY = e.gridY;
        bossFound = true;
        log(`Boss already engaged during melee walk (${activeBoss.reason}) -> entering fight`);
        setState(STATE.FIGHTING_BOSS);
        break;
      }

      const IMMUNE_ENGAGE_RANGE = 5;
      const DAMAGEABLE_ENGAGE_RANGE = 46;
      const radarBoss = getRadarBossTarget();
      const anchor = radarBoss || (Number.isFinite(bossGridX) && Number.isFinite(bossGridY) ? { x: bossGridX, y: bossGridY } : null);
      const anchorRadius = checkpointReached ? 260 : 320;

      let selected = findBossCandidateUnique(
        player.gridX,
        player.gridY,
        760,
        anchor ? anchor.x : null,
        anchor ? anchor.y : null,
        anchorRadius
      );

      if (!selected) {
        const fullCandidates = getBossFullEntityCandidates(
          player.gridX,
          player.gridY,
          anchor ? anchor.x : null,
          anchor ? anchor.y : null,
          checkpointReached ? 360 : 420
        );
        if (fullCandidates.length > 0) selected = fullCandidates[0].entity;
      }

      if (!selected) {
        const meleeElapsed = now - stateStartTime;
        // Deterministic post-checkpoint behavior:
        // keep pushing deeper toward boss endpoint until a real boss entity appears.
        if (radarBoss) {
          const changedTarget =
            targetName !== 'Boss Radar Push' ||
            Math.hypot(targetGridX - radarBoss.x, targetGridY - radarBoss.y) > 18 ||
            currentPath.length === 0;
          if (changedTarget && (now - bossMeleeExplorePickTime > 700 || currentPath.length === 0)) {
            startWalkingTo(radarBoss.x, radarBoss.y, 'Boss Radar Push', 'boss');
            bossMeleeExplorePickTime = now;
          }
          const exploreStep = stepPathWalker();
          const noPath = exploreStep === 'stuck' || (exploreStep === 'walking' && currentPath.length === 0);
          if (noPath) {
            bossMeleeExploreNoPathCount++;
            if (bossMeleeExploreNoPathCount >= 4) {
              // No forward path right now; hold and retry radar path shortly.
              bossMeleeExplorePickTime = 0;
              bossMeleeExploreNoPathCount = 0;
            }
          } else {
            bossMeleeExploreNoPathCount = 0;
          }
          const distToRadar = Math.hypot(player.gridX - radarBoss.x, player.gridY - radarBoss.y);
          statusMessage = `No boss unique yet, exploring... ${distToRadar.toFixed(0)}u (${(meleeElapsed / 1000).toFixed(0)}s)`;
        } else {
          // No radar endpoint: continue pushing from barrier/checkpoint direction only.
          if (Number.isFinite(bossGridX) && Number.isFinite(bossGridY)) {
            const changedTarget =
              targetName !== 'Boss Melee Forward Push' ||
              Math.hypot(targetGridX - bossGridX, targetGridY - bossGridY) > 18 ||
              currentPath.length === 0;
            if (changedTarget && (now - bossMeleeExplorePickTime > 700 || currentPath.length === 0)) {
              startWalkingTo(bossGridX, bossGridY, 'Boss Melee Forward Push', 'boss');
              bossMeleeExplorePickTime = now;
            }
            stepPathWalker();
          }
          statusMessage = `No boss unique visible yet, pushing forward... ${(meleeElapsed / 1000).toFixed(0)}s`;
        }
        break;
      }

      bossCandidateId = selected.id || bossCandidateId;
      bossMeleeStaticEntityId = selected.id || 0;
      bossGridX = selected.gridX;
      bossGridY = selected.gridY;
      const selectedIsImmune = !!selected.cannotBeDamaged;
      const engageRange = selectedIsImmune ? IMMUNE_ENGAGE_RANGE : DAMAGEABLE_ENGAGE_RANGE;
      const distToBossEntity = Math.hypot(player.gridX - selected.gridX, player.gridY - selected.gridY);

      if (distToBossEntity > engageRange) {
        bossMeleeHoldStartTime = 0;
        const shouldRetarget =
          targetName !== 'Boss Melee Target' ||
          Math.hypot(targetGridX - selected.gridX, targetGridY - selected.gridY) > 12 ||
          currentPath.length === 0 ||
          now - bossMeleeLastRetargetTime > 900;
        if (shouldRetarget) {
          bossMeleeLastRetargetTime = now;
          startWalkingTo(selected.gridX, selected.gridY, 'Boss Melee Target', 'boss');
        }

        const result = stepPathWalker();
        statusMessage = selectedIsImmune
          ? `Walking to immune boss... ${distToBossEntity.toFixed(0)} units`
          : `Walking to boss... ${distToBossEntity.toFixed(0)} units`;
        if (result === 'stuck' && (now - stateStartTime > 32000)) {
          log('Boss melee target unreachable for too long, dropping candidate and exploring');
          bossCandidateId = 0;
          bossMeleeStaticEntityId = 0;
          bossMeleeLastRetargetTime = 0;
        }
        break;
      }

      sendStopMovementLimited();
      if (bossMeleeHoldStartTime === 0) bossMeleeHoldStartTime = now;
      const holdMs = now - bossMeleeHoldStartTime;

      if (selectedIsImmune) {
        const selectedActionEntity = resolveBossActionEntity(selected, now);
        const stanceSignal = getImmuneBossStancePreDodgeSignal(selectedActionEntity);
        if (stanceSignal && (tryBossEmergencyRollOut(player, selected, now) || tryBossDodgeRollBehind(player, selected, now))) {
          statusMessage = `Boss ${stanceSignal.animationName} (${stanceSignal.remaining.toFixed(2)}s) -> pre-dodge`;
          break;
        }
        if (distToBossEntity <= IMMUNE_ENGAGE_RANGE) {
          bossEntityId = selected.id || bossEntityId;
          const bossName = ((selected.renderName || selected.name || 'Unknown')).split('/').pop();
          log(`Boss "${bossName}" immune-close threshold met (<=5) - entering fight`);
          setState(STATE.FIGHTING_BOSS);
        } else {
          statusMessage = `Holding near immune boss... ${distToBossEntity.toFixed(1)} units`;
        }
        break;
      }

      bossEntityId = selected.id || bossEntityId;
      if (holdMs >= 300) {
        const bossName = ((selected.renderName || selected.name || 'Unknown')).split('/').pop();
        log(`Boss "${bossName}" within engage range - entering fight`);
        setState(STATE.FIGHTING_BOSS);
      } else {
        statusMessage = `At boss (${distToBossEntity.toFixed(0)}), stabilizing... ${(holdMs / 1000).toFixed(1)}s`;
      }
      break;
    }

    case STATE.FIGHTING_BOSS: {
      if (isMapObjectiveComplete()) {
        log('Map objective complete during boss fight -> map complete');
        setState(STATE.MAP_COMPLETE);
        break;
      }
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
                mapCompleteBossDeathX = Number.isFinite(e.gridX) ? e.gridX : player.gridX;
                mapCompleteBossDeathY = Number.isFinite(e.gridY) ? e.gridY : player.gridY;
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

      // First-contact safety: instant-up bosses can swing immediately on engage.
      // Roll out first instead of committing to a stand/move command in that window.
      if (trackedBossEntity && (now - bossFightEngagedAt) < 1600) {
        const firstContactDist = Math.hypot(player.gridX - trackedBossEntity.gridX, player.gridY - trackedBossEntity.gridY);
        if (firstContactDist < 68 && tryBossEmergencyRollOut(player, trackedBossEntity, now)) {
          statusMessage = `Boss first-contact evasive roll (${firstContactDist.toFixed(0)}u)`;
          break;
        }
      }

      // Immune stance wind-up reaction:
      // when boss is in ChangeToStance* near completion, pre-dodge behind/around.
      if (trackedBossEntity && trackedBossEntity.cannotBeDamaged) {
        const trackedActionEntity = resolveBossActionEntity(trackedBossEntity, now);
        const stanceSignal = getImmuneBossStancePreDodgeSignal(trackedActionEntity);
        if (stanceSignal) {
          if (tryBossEmergencyRollOut(player, trackedBossEntity, now) || tryBossDodgeRollBehind(player, trackedBossEntity, now)) {
            statusMessage = `Boss ${stanceSignal.animationName} (${stanceSignal.remaining.toFixed(2)}s) -> pre-dodge`;
            break;
          }
          const safeWp = pickLargeOrbitWaypoint(player.gridX, player.gridY, trackedBossEntity.gridX, trackedBossEntity.gridY);
          if (safeWp && Number.isFinite(safeWp.x) && Number.isFinite(safeWp.y)) {
            stepFightDirectMove(player, safeWp.x, safeWp.y, now, 14);
            statusMessage = `Boss ${stanceSignal.animationName} (${stanceSignal.remaining.toFixed(2)}s) -> pre-reposition`;
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
        const fenceTrapped = localClear <= 3 || bossOrbitBlockedCount >= 1;
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
              bossOrbitBlockedCount = 0;
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
              bossOrbitBlockedCount++;
              bossFightOrbitWaypointX = 0;
              bossFightOrbitWaypointY = 0;
              if (bossOrbitBlockedCount >= 2) {
                bossOrbitDir *= -1;
                bossOrbitBlockedCount = 0;
                bossFightRecentOrbitSectors = [];
                log('Fight kite stuck: flipped orbit direction');
              }
            } else {
              bossOrbitBlockedCount = 0;
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
      if (!mapCompleteFlowStartTime) mapCompleteFlowStartTime = stateStartTime || now;
      const cfg = getMapCompletePhaseConfig();
      const bossX = Number.isFinite(mapCompleteBossDeathX) ? mapCompleteBossDeathX : bossGridX;
      const bossY = Number.isFinite(mapCompleteBossDeathY) ? mapCompleteBossDeathY : bossGridY;
      const haveBossAnchor = Number.isFinite(bossX) && Number.isFinite(bossY);
      const distFromBoss = haveBossAnchor ? Math.hypot(player.gridX - bossX, player.gridY - bossY) : Infinity;
      const hpCur = Number(player?.healthCurrent || 0);
      const hpValid = Number.isFinite(hpCur) && hpCur > 0;

      // Post-boss hazard fallback:
      // If HP is dropping (ground degen/fire/pit), perform up to 2 emergency escapes
      // before resuming normal retreat/utility/portal phases.
      if (hpValid) {
        if (mapCompleteLastHp > 0 && hpCur < mapCompleteLastHp) {
          mapCompleteDangerDetectedAt = now;
          // New danger episode: reset attempt counter after a quiet period.
          if (now - mapCompleteDangerLastEscapeAt > 2200) {
            mapCompleteDangerEscapeAttempts = 0;
          }
        }
        mapCompleteLastHp = hpCur;
      }

      if (mapCompleteDangerDetectedAt > 0) {
        const dangerAge = now - mapCompleteDangerDetectedAt;
        if (dangerAge <= 2200) {
          const canTryEscape =
            mapCompleteDangerEscapeAttempts < 2 &&
            (now - mapCompleteDangerLastEscapeAt) >= 320;
          if (canTryEscape) {
            let escaped = false;
            if (haveBossAnchor) {
              // Reuse boss emergency roll logic with death-anchor as pseudo-boss origin.
              escaped = tryBossEmergencyRollOut(player, { gridX: bossX, gridY: bossY }, now);
            }
            if (!escaped) {
              const away = haveBossAnchor
                ? getWalkableDirectionalTarget(player.gridX, player.gridY, player.gridX - bossX, player.gridY - bossY)
                : null;
              if (away) {
                startWalkingTo(away.x, away.y, 'Boss Death Damage Escape', '');
                stepPathWalker();
              } else {
                sendMoveAngleLimited(Math.random() * 360, Math.max(26, currentSettings.stuckMoveDistance * 0.6));
              }
            }
            mapCompleteDangerEscapeAttempts++;
            mapCompleteDangerLastEscapeAt = now;
            log(`Map complete danger escape attempt ${mapCompleteDangerEscapeAttempts}/2`);
          } else if (targetName === 'Boss Death Damage Escape') {
            stepPathWalker();
          }
          statusMessage = `Map complete: taking damage, escaping (${mapCompleteDangerEscapeAttempts}/2)`;
          break;
        }
        mapCompleteDangerDetectedAt = 0;
        mapCompleteDangerEscapeAttempts = 0;
      }

      // Phase 1: move to a safe ring 20-30 away from boss.
      if (!mapCompleteRetreatReachedAt) {
        if (haveBossAnchor && distFromBoss < cfg.retreatDist) {
          const away = getWalkableDirectionalTarget(player.gridX, player.gridY, player.gridX - bossX, player.gridY - bossY);
          if (away) {
            if (targetName !== 'Boss Death Safety Retreat' || currentPath.length === 0) {
              startWalkingTo(away.x, away.y, 'Boss Death Safety Retreat', '');
            }
            stepPathWalker();
          } else {
            sendMoveAngleLimited(Math.random() * 360, Math.max(24, currentSettings.stuckMoveDistance * 0.5));
          }
          statusMessage = `Map complete: retreating (${distFromBoss.toFixed(0)}/${cfg.retreatDist}u)`;
          break;
        }
        sendStopMovementLimited();
        mapCompleteRetreatReachedAt = now;
        log(`Map complete: retreat ring reached (${Number.isFinite(distFromBoss) ? distFromBoss.toFixed(0) : 'n/a'}u), starting wait`);
      }

      // Phase 2: wait briefly for drops/interactions to settle.
      const waitElapsed = now - mapCompleteRetreatReachedAt;
      if (waitElapsed < cfg.waitMs) {
        sendStopMovementLimited();
        statusMessage = `Map complete: waiting (${Math.max(0, ((cfg.waitMs - waitElapsed) / 1000)).toFixed(1)}s)`;
        break;
      }

      // Phase 3: utility sweep window (pickit/opener can walk to loot/chests).
      const utilityElapsed = waitElapsed - cfg.waitMs;
      if (utilityElapsed < cfg.utilityMs) {
        statusMessage = `Map complete: utility sweep (${Math.max(0, ((cfg.utilityMs - utilityElapsed) / 1000)).toFixed(1)}s)`;
        break;
      }

      // Phase 4: return to hideout by taking nearest portal.
      if (!currentSettings.mapCompleteAutoReturnToHideout) {
        statusMessage = `Map complete: return disabled`;
        break;
      }

      const portalRadius = Math.max(40, currentSettings.mapCompletePortalSearchRadius || 140);
      const returnPortal = findNearestReturnPortal(portalRadius);
      if (!returnPortal) {
        if (currentSettings.mapCompleteUseOpenTownPortalPacket) {
          if (now - mapCompleteOpenPortalLastAt >= 2500 && mapCompleteOpenPortalAttempts < 6) {
            mapCompleteOpenPortalLastAt = now;
            mapCompleteOpenPortalAttempts++;
            const opened = sendOpenTownPortalPacket();
            log(
              `Map complete: send open-town-portal packet (00 C4 01) ` +
              `attempt=${mapCompleteOpenPortalAttempts} ok=${opened}`
            );
          }
          statusMessage = `Map complete: opening town portal... (${mapCompleteOpenPortalAttempts}/6)`;
        } else {
          statusMessage = `Map complete: no portal in ${portalRadius}u (open one manually)`;
        }
        break;
      }

      if (now - mapCompletePortalInteractLastAt >= 1500) {
        mapCompletePortalInteractLastAt = now;
        mapCompletePortalInteractAttempts++;
        log(
          `Map complete: taking portal "${returnPortal.renderName || returnPortal.name || 'Portal'}" ` +
          `id=${returnPortal.id} attempt=${mapCompletePortalInteractAttempts}`
        );
        interactWithEntity(returnPortal.id);
      }
      statusMessage = `Map complete: taking portal... (${mapCompletePortalInteractAttempts})`;
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

  if (!ImGui.begin("Mapper", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }

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
  if (ImGui.treeNode("Hideout Map Opener")) {
    if (!isMapperMasterEnabled()) {
      ImGui.textColored([1.0, 0.8, 0.2, 1.0], 'Mapper is OFF - hideout flow settings are currently inactive.');
    }

    const hideoutEnabled = new ImGui.MutableVariable(!!currentSettings.hideoutFlowEnabled);
    if (ImGui.checkbox("Enable Hideout Flow", hideoutEnabled)) {
      saveSetting('hideoutFlowEnabled', hideoutEnabled.value);
    }
    ImGui.textWrapped("When in hideout: find Map Device, open atlas, select map, place waystone/precursors.");
    const portalRetries = new ImGui.MutableVariable(currentSettings.hideoutPortalEnterMaxAttempts || 4);
    if (ImGui.sliderInt("Portal entry max attempts", portalRetries, 1, 4)) {
      saveSetting('hideoutPortalEnterMaxAttempts', portalRetries.value);
    }
    ImGui.text(`Failed-node blacklist: ${hideoutFailedNodeBlacklist.size}`);
    ImGui.sameLine();
    if (ImGui.button("Clear##hideoutNodeBlacklist")) {
      hideoutFailedNodeBlacklist.clear();
      log('[Hideout] Cleared failed-node blacklist (manual)');
    }

    ImGui.separator();
    ImGui.textColored([0.3, 0.8, 1.0, 1.0], "Waystone Preferences");
    const minTier = new ImGui.MutableVariable(currentSettings.waystoneMinTier || 1);
    if (ImGui.sliderInt("Min Tier", minTier, 1, 16)) {
      saveSetting('waystoneMinTier', minTier.value);
    }
    const maxTier = new ImGui.MutableVariable(currentSettings.waystoneMaxTier || 16);
    if (ImGui.sliderInt("Max Tier", maxTier, 1, 16)) {
      saveSetting('waystoneMaxTier', Math.max(maxTier.value, currentSettings.waystoneMinTier || 1));
    }

    const wsNormal = new ImGui.MutableVariable(!!currentSettings.waystoneRarityNormal);
    if (ImGui.checkbox("Normal##ws", wsNormal)) saveSetting('waystoneRarityNormal', wsNormal.value);
    ImGui.sameLine();
    const wsMagic = new ImGui.MutableVariable(!!currentSettings.waystoneRarityMagic);
    if (ImGui.checkbox("Magic##ws", wsMagic)) saveSetting('waystoneRarityMagic', wsMagic.value);
    ImGui.sameLine();
    const wsRare = new ImGui.MutableVariable(!!currentSettings.waystoneRarityRare);
    if (ImGui.checkbox("Rare##ws", wsRare)) saveSetting('waystoneRarityRare', wsRare.value);
    ImGui.sameLine();
    const wsUnique = new ImGui.MutableVariable(!!currentSettings.waystoneRarityUnique);
    if (ImGui.checkbox("Unique##ws", wsUnique)) saveSetting('waystoneRarityUnique', wsUnique.value);
    const wsCorruptedOnly = new ImGui.MutableVariable(!!currentSettings.waystoneCorruptedOnly);
    if (ImGui.checkbox("Corrupted Only##ws", wsCorruptedOnly)) {
      saveSetting('waystoneCorruptedOnly', wsCorruptedOnly.value);
      if (wsCorruptedOnly.value && currentSettings.waystoneNonCorruptedOnly) {
        saveSetting('waystoneNonCorruptedOnly', false);
      }
    }
    ImGui.sameLine();
    const wsNonCorruptedOnly = new ImGui.MutableVariable(!!currentSettings.waystoneNonCorruptedOnly);
    if (ImGui.checkbox("Non-Corrupted Only##ws", wsNonCorruptedOnly)) {
      saveSetting('waystoneNonCorruptedOnly', wsNonCorruptedOnly.value);
      if (wsNonCorruptedOnly.value && currentSettings.waystoneCorruptedOnly) {
        saveSetting('waystoneCorruptedOnly', false);
      }
    }
    if (currentSettings.waystoneNonCorruptedOnly) {
      ImGui.textColored([1.0, 0.8, 0.2, 1.0], "Non-Corrupted Only is strict: unknown corruption items are rejected.");
    }

    ImGui.separator();
    ImGui.textColored([0.8, 0.6, 1.0, 1.0], "Precursor Tablets");
    const precEnabled = new ImGui.MutableVariable(!!currentSettings.enablePrecursors);
    if (ImGui.checkbox("Enable Precursor Placement", precEnabled)) {
      saveSetting('enablePrecursors', precEnabled.value);
    }

    if (currentSettings.enablePrecursors) {
      const pcNormal = new ImGui.MutableVariable(!!currentSettings.precursorRarityNormal);
      if (ImGui.checkbox("Normal##pc", pcNormal)) saveSetting('precursorRarityNormal', pcNormal.value);
      ImGui.sameLine();
      const pcMagic = new ImGui.MutableVariable(!!currentSettings.precursorRarityMagic);
      if (ImGui.checkbox("Magic##pc", pcMagic)) saveSetting('precursorRarityMagic', pcMagic.value);
      ImGui.sameLine();
      const pcRare = new ImGui.MutableVariable(!!currentSettings.precursorRarityRare);
      if (ImGui.checkbox("Rare##pc", pcRare)) saveSetting('precursorRarityRare', pcRare.value);
      ImGui.sameLine();
      const pcUnique = new ImGui.MutableVariable(!!currentSettings.precursorRarityUnique);
      if (ImGui.checkbox("Unique##pc", pcUnique)) saveSetting('precursorRarityUnique', pcUnique.value);
    }

    ImGui.separator();
    // Show hideout flow status
    if (currentState.startsWith('HIDEOUT_')) {
      ImGui.textColored([1.0, 1.0, 0.0, 1.0], `State: ${currentState}`);
      if (hideoutSuspendReason) {
        ImGui.textColored([1.0, 0.4, 0.4, 1.0], hideoutSuspendReason);
      }
      if (currentState === STATE.HIDEOUT_SUSPENDED) {
        if (ImGui.button("Retry##hideout")) {
          setState(STATE.HIDEOUT_CHECK_PORTALS);
          hideoutSuspendReason = '';
        }
      }
    }

    // Debug: show traverse activation key and packet for atlas nodes
    if (ImGui.treeNode("Traverse Packet Debug")) {
      const tpDebug = computeTraversePacketDebug();

      // Show captured activation key (from selectAtlasNode)
      if (hideoutActivationKey) {
        ImGui.textColored([0.5, 1.0, 0.5, 1.0],
          `Captured Key: (${hideoutActivationKey.x}, ${hideoutActivationKey.y}) [node ${hideoutSelectedNodeIndex}]`);
      } else {
        ImGui.textColored([1.0, 0.5, 0.5, 1.0], 'No activation key captured (select a node first)');
      }

      if (tpDebug.available) {
        ImGui.textColored([0.5, 1.0, 0.5, 1.0], `Packet: ${tpDebug.hex}`);
        ImGui.sameLine();
        if (ImGui.button("Copy##tpkt")) {
          ImGui.setClipboardText(tpDebug.hex);
        }
        ImGui.sameLine();
        if (ImGui.button("Send##tpktC")) {
          const bytes = tpDebug.hex.split(' ').map(h => parseInt(h, 16));
          const ok = poe2.sendPacket(new Uint8Array(bytes));
          log(`[Traverse Debug] Sent: ${tpDebug.hex} -> ${ok}`);
        }
        if (tpDebug.source) {
          ImGui.textColored([0.6, 0.6, 0.6, 1.0], `Source: ${tpDebug.source}`);
        }
      }

      // Show activation keys for all uncompleted nodes
      if (tpDebug.nodeInfo && tpDebug.nodeInfo.length > 0) {
        ImGui.separator();
        if (ImGui.treeNode(`Node Activation Keys (${tpDebug.nodeInfo.length})###nodeActKeys`)) {
          for (const ni of tpDebug.nodeInfo) {
            const selected = (ni.index === hideoutSelectedNodeIndex) ? ' <<' : '';
            ImGui.textColored([1.0, 1.0, 0.0, 1.0],
              `[${ni.index}] ${ni.name}: (${ni.actX}, ${ni.actY})${selected}`);
            ImGui.textColored([0.6, 0.8, 1.0, 1.0],
              `    Raw: ${ni.rawHex}  Pkt: ${ni.packetHex}`);
            ImGui.sameLine();
            if (ImGui.button(`Copy##nk${ni.index}`)) {
              ImGui.setClipboardText(ni.packetHex);
            }
            ImGui.sameLine();
            if (ImGui.button(`Send##nk${ni.index}`)) {
              const bytes = ni.packetHex.split(' ').map(h => parseInt(h, 16));
              const ok = poe2.sendPacket(new Uint8Array(bytes));
              log(`[Traverse Debug] Sent node ${ni.index} (${ni.name}): ${ni.packetHex} -> ${ok}`);
            }
          }
          ImGui.treePop();
        }
      }

      // Manual packet with custom X/Y (for testing arbitrary activation keys)
      ImGui.separator();
      ImGui.textColored([1.0, 0.8, 0.3, 1.0], 'Manual Activation Key:');
      const customXMut = new ImGui.MutableVariable(traverseDebugCustomX);
      if (ImGui.sliderInt("X##tpktCustom", customXMut, -960, 960)) {
        traverseDebugCustomX = customXMut.value;
      }
      const customYMut = new ImGui.MutableVariable(traverseDebugCustomY);
      if (ImGui.sliderInt("Y##tpktCustom", customYMut, -960, 960)) {
        traverseDebugCustomY = customYMut.value;
      }
      const customPkt = buildCustomTraversePacket(traverseDebugCustomX, traverseDebugCustomY);
      ImGui.text(`Packet: ${packetToHex(customPkt)}`);
      ImGui.sameLine();
      if (ImGui.button("Copy##tpktM")) {
        ImGui.setClipboardText(packetToHex(customPkt));
      }
      ImGui.sameLine();
      if (ImGui.button("Send##tpktM")) {
        const ok = poe2.sendPacket(customPkt);
        log(`[Traverse Debug] Sent manual (${traverseDebugCustomX}, ${traverseDebugCustomY}): ${packetToHex(customPkt)} -> ${ok}`);
      }

      ImGui.treePop();
    }

    ImGui.treePop();
  }

  ImGui.separator();
  if (ImGui.treeNode("All Inventory Contexts (incl. hidden)")) {
    try {
      const allInvs = poe2.getVisibleInventories({ includeHidden: true });
      if (allInvs && allInvs.length > 0) {
        ImGui.text(`Discovered ${allInvs.length} inventory context(s):`);
        for (const inv of allInvs) {
          const vis = inv.isVisible ? 'VISIBLE' : 'HIDDEN';
          const grid = `${inv.gridWidth || 0}x${inv.gridHeight || 0}`;
          const itemCount = (inv.items || []).length;
          const label = `[${vis}] invId=${inv.inventoryId} grid=${grid} items=${itemCount} path="${inv.uiPath || ''}"`;
          if (ImGui.treeNode(`inv_${inv.inventoryId}`, label)) {
            for (const item of (inv.items || [])) {
              const name = item.baseName || item.uniqueName || '(unnamed)';
              ImGui.text(`  slot=(${item.slotX},${item.slotY}) ${item.width}x${item.height} rarity=${item.rarity} "${name}"`);
            }
            if ((inv.items || []).length === 0) ImGui.text('  (empty)');
            ImGui.treePop();
          }
        }
      } else {
        ImGui.text('No inventory contexts discovered yet.');
      }
    } catch (e) {
      ImGui.text(`Error: ${e?.message || e}`);
    }
    ImGui.treePop();
  }

  ImGui.separator();
  if (ImGui.treeNode("Test Map Activation")) {
    // Helper to append to the test log (kept small)
    const opt1Log = (msg) => {
      opt1TestLog.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
      if (opt1TestLog.length > 80) opt1TestLog.splice(0, opt1TestLog.length - 80);
    };

    ImGui.textWrapped(
      'Open the atlas panel (interact with Map Device) first. ' +
      'Select a node below, then use the step buttons or Run All to test the activation flow. ' +
      'After sending the packet the atlas panel will be hidden.'
    );

    // Step 1: Read atlas nodes (atlas panel must be open)
    ImGui.separator();
    ImGui.textColored([1.0, 0.8, 0.3, 1.0], 'Step 1: Atlas Nodes');
    let atlasData = null;
    try {
      atlasData = poe2.getAtlasNodes();
    } catch (_) {}

    const atlasOpen = !!(atlasData && atlasData.isValid);
    if (atlasOpen) {
      ImGui.textColored([0.3, 1.0, 0.3, 1.0], 'Atlas panel: OPEN');
    } else {
      ImGui.textColored([1.0, 0.3, 0.3, 1.0], 'Atlas panel: CLOSED - open it first (interact with Map Device)');
    }

    if (atlasData && atlasData.isValid && atlasData.nodes) {
      const uncompleted = atlasData.nodes
        .map((n, i) => ({ ...n, idx: i }))
        .filter(n => n.isUnlocked && !n.isCompleted);
      ImGui.text(`${atlasData.nodes.length} total nodes, ${uncompleted.length} uncompleted`);

      if (uncompleted.length > 0) {
        // Node selector
        const labels = uncompleted.map(n =>
          `[${n.idx}] ${n.shortName || n.fullName || '?'} key=(${n.activationX ?? '?'}, ${n.activationY ?? '?'})`
        );
        let selIdx = uncompleted.findIndex(n => n.idx === opt1TestSelectedNode);
        if (selIdx < 0) selIdx = 0;
        const selMut = new ImGui.MutableVariable(selIdx);
        if (ImGui.combo("Target Node##opt1", selMut, labels)) {
          opt1TestSelectedNode = uncompleted[selMut.value].idx;
        }
        if (opt1TestSelectedNode < 0) opt1TestSelectedNode = uncompleted[0].idx;
        const sel = uncompleted.find(n => n.idx === opt1TestSelectedNode) || uncompleted[0];

        ImGui.text(`Selected: [${sel.idx}] ${sel.shortName || sel.fullName || '?'}`);
        if (sel.activationX !== undefined) {
          const xB = int32ToBytesBE(sel.activationX);
          const yB = int32ToBytesBE(sel.activationY);
          const pkt = new Uint8Array([0x00, 0xEC, 0x01, ...xB, ...yB]);
          ImGui.text(`  ActivationKey: (${sel.activationX}, ${sel.activationY})`);
          ImGui.text(`  Packet: ${packetToHex(pkt)}`);
          if (sel.activationRawBytes) {
            ImGui.text(`  Raw @+0x2C8: ${sel.activationRawBytes.map(b => b.toString(16).padStart(2,'0')).join(' ')}`);
          }
        } else {
          ImGui.textColored([1.0, 0.3, 0.3, 1.0], '  No activation key data!');
        }

        // Step 2: Select node (opens TPM)
        ImGui.separator();
        ImGui.textColored([1.0, 0.8, 0.3, 1.0], 'Step 2: Select Node (open TPM)');
        if (ImGui.button("selectAtlasNode##opt1step2")) {
          const result = poe2.selectAtlasNode(sel.idx);
          const ok = typeof result === 'object' ? result.success : !!result;
          opt1Log(`selectAtlasNode(${sel.idx}) -> ${ok}`);
          if (ok && sel.activationX !== undefined) {
            hideoutActivationKey = { x: sel.activationX, y: sel.activationY };
            opt1Log(`Captured activationKey=(${sel.activationX}, ${sel.activationY})`);
          }
        }

        // Step 3: Inventory state
        ImGui.separator();
        ImGui.textColored([1.0, 0.8, 0.3, 1.0], 'Step 3: Inventories');
        let allInvs = [];
        try {
          allInvs = poe2.getVisibleInventories({ includeHidden: true }) || [];
        } catch (_) {}
        const tpmInvs = allInvs.filter(inv => inv.inventoryId > 10 && isLikelyTpmInventory(inv));
        ImGui.text(`Total contexts: ${allInvs.length} | TPM-like: ${tpmInvs.length}`);
        for (const inv of tpmInvs) {
          const vis = inv.isVisible ? 'VIS' : 'HID';
          const items = (inv.items || []).map(it => it.baseName || '?').join(', ') || '(empty)';
          ImGui.text(`  [${vis}] invId=${inv.inventoryId} ${inv.gridWidth}x${inv.gridHeight} path="${inv.uiPath || ''}" [${items}]`);
        }
        if (tpmInvs.length === 0) {
          ImGui.textColored([1.0, 0.5, 0.2, 1.0], '  No TPM inventories found. Select a node first (Step 2).');
        }
        if (ImGui.button("Force-Show Main Inv [1,29,5,35]##opt1")) {
          const ok = poe2.ensureUiVisible([1, 29, 5, 35]);
          opt1Log(`Force-show main inventory -> ${ok}`);
        }

        // Step 4: Place waystone
        ImGui.separator();
        ImGui.textColored([1.0, 0.8, 0.3, 1.0], 'Step 4: Place Waystone');
        if (ImGui.button("Ctrl+Click Waystone into TPM##opt1")) {
          const waystone = findWaystoneInInventory();
          if (waystone) {
            const slotRef = getItemSlotRef(waystone);
            opt1Log(`Found waystone: ${waystone.baseName} T${waystone.tier || '?'} slotRef=${slotRef}`);
            if (slotRef > 0) {
              const moved = poe2.ctrlClickItem(1, slotRef);
              opt1Log(`ctrlClickItem(1, ${slotRef}) -> ${moved}`);
            } else {
              opt1Log('ERROR: slotRef is 0');
            }
          } else {
            opt1Log('ERROR: No waystone matching filters in inventory');
          }
        }

        // Step 5: Send activation packet
        ImGui.separator();
        ImGui.textColored([1.0, 0.8, 0.3, 1.0], 'Step 5: Send Activation Packet');
        if (sel.activationX !== undefined) {
          const xB5 = int32ToBytesBE(sel.activationX);
          const yB5 = int32ToBytesBE(sel.activationY);
          const pkt5 = new Uint8Array([0x00, 0xEC, 0x01, ...xB5, ...yB5]);
          ImGui.text(`Packet: ${packetToHex(pkt5)}`);
          if (ImGui.button("Send Activation Packet##opt1")) {
            const ok = poe2.sendPacket(pkt5);
            opt1Log(`sendPacket(${packetToHex(pkt5)}) -> ${ok}`);
          }
          ImGui.sameLine();
          if (ImGui.button("Copy##opt1pkt")) {
            ImGui.setClipboardText(packetToHex(pkt5));
          }
        }

        // Step 6: Hide atlas panel
        ImGui.separator();
        ImGui.textColored([1.0, 0.8, 0.3, 1.0], 'Step 6: Hide Atlas Panel');
        if (ImGui.button("Hide Atlas [1,22]##opt1")) {
          const ok = poe2.ensureUiVisible([1, 22], false);
          opt1Log(`Hide atlas [1,22] -> ${ok}`);
        }

        // Full auto test button
        ImGui.separator();
        ImGui.textColored([0.3, 1.0, 0.3, 1.0], 'Run Full Sequence:');
        ImGui.textWrapped(
          'Runs: selectAtlasNode -> show inventory -> place waystone -> send packet -> hide atlas'
        );
        if (ImGui.button("Run All Steps##opt1full")) {
          opt1Log('=== FULL TEST START ===');

          if (sel.activationX === undefined) {
            opt1Log('ABORT: No activation key for selected node');
          } else {
            // 1. Select node to open TPM
            const selResult = poe2.selectAtlasNode(sel.idx);
            const selOk = typeof selResult === 'object' ? selResult.success : !!selResult;
            opt1Log(`selectAtlasNode(${sel.idx}) -> ${selOk}`);
            hideoutActivationKey = { x: sel.activationX, y: sel.activationY };
            opt1Log(`Key=(${sel.activationX}, ${sel.activationY})`);

            // 2. Show main inventory
            poe2.ensureUiVisible([1, 29, 5, 35]);
            opt1Log('Showed main inventory');

            // 3. Place waystone
            const ws = findWaystoneInInventory();
            if (ws) {
              const ref = getItemSlotRef(ws);
              if (ref > 0) {
                const moved = poe2.ctrlClickItem(1, ref);
                opt1Log(`Placed waystone: ${ws.baseName} slotRef=${ref} -> ${moved}`);
              } else {
                opt1Log('ERROR: waystone slotRef=0');
              }
            } else {
              opt1Log('WARNING: No waystone in inventory (may already be in TPM)');
            }

            // 4. Send activation packet
            const xBA = int32ToBytesBE(sel.activationX);
            const yBA = int32ToBytesBE(sel.activationY);
            const pktA = new Uint8Array([0x00, 0xEC, 0x01, ...xBA, ...yBA]);
            const sent = poe2.sendPacket(pktA);
            opt1Log(`Sent packet: ${packetToHex(pktA)} -> ${sent}`);

            // 5. Hide atlas panel
            poe2.ensureUiVisible([1, 22], false);
            opt1Log('Hid atlas panel');

            opt1Log('=== FULL TEST DONE ===');
          }
        }
      } else {
        ImGui.text('No uncompleted nodes found.');
      }
    } else if (!atlasOpen) {
      ImGui.text('Open the atlas panel to see nodes here.');
    }

    // Test log
    ImGui.separator();
    ImGui.textColored([0.7, 0.7, 1.0, 1.0], `Test Log (${opt1TestLog.length} entries):`);
    if (ImGui.button("Clear Log##opt1log")) {
      opt1TestLog.length = 0;
    }
    for (let i = Math.max(0, opt1TestLog.length - 20); i < opt1TestLog.length; i++) {
      ImGui.text(opt1TestLog[i]);
    }

    ImGui.treePop();
  }

  ImGui.separator();
  if (ImGui.treeNode("Map Complete Flow")) {
    ImGui.textWrapped("After boss death: retreat to safe distance, wait, run utility sweep, then auto-enter nearest portal.");

    const retreatDist = new ImGui.MutableVariable(currentSettings.mapCompleteRetreatDistance || 26);
    if (ImGui.sliderInt("Retreat Distance", retreatDist, 20, 30)) {
      saveSetting('mapCompleteRetreatDistance', retreatDist.value);
    }

    const waitMs = new ImGui.MutableVariable(currentSettings.mapCompleteRetreatDurationMs || 10000);
    if (ImGui.sliderInt("Post-Retreat Wait (ms)", waitMs, 0, 20000)) {
      saveSetting('mapCompleteRetreatDurationMs', waitMs.value);
    }

    const utilDelay = new ImGui.MutableVariable(currentSettings.mapCompleteUtilityDelayMs || 10000);
    if (ImGui.sliderInt("Utility Time (ms)", utilDelay, 0, 60000)) {
      saveSetting('mapCompleteUtilityDelayMs', utilDelay.value);
    }

    const autoReturn = new ImGui.MutableVariable(!!currentSettings.mapCompleteAutoReturnToHideout);
    if (ImGui.checkbox("Auto Return To Hideout", autoReturn)) {
      saveSetting('mapCompleteAutoReturnToHideout', autoReturn.value);
    }
    const useOpenPortalPacket = new ImGui.MutableVariable(!!currentSettings.mapCompleteUseOpenTownPortalPacket);
    if (ImGui.checkbox("Use Open Town Portal Packet (00 C4 01)", useOpenPortalPacket)) {
      saveSetting('mapCompleteUseOpenTownPortalPacket', useOpenPortalPacket.value);
    }

    const portalRadius = new ImGui.MutableVariable(currentSettings.mapCompletePortalSearchRadius || 140);
    if (ImGui.sliderInt("Portal Search Radius", portalRadius, 40, 320)) {
      saveSetting('mapCompletePortalSearchRadius', portalRadius.value);
    }

    if (currentState === STATE.MAP_COMPLETE) {
      ImGui.textColored([0.7, 0.9, 1.0, 1.0], `Active: ${(Date.now() - stateStartTime) / 1000 | 0}s`);
      ImGui.text(`Portal attempts: ${mapCompletePortalInteractAttempts}`);
      ImGui.text(`Open-portal attempts: ${mapCompleteOpenPortalAttempts}`);
    }

    ImGui.treePop();
  }

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
  ImGui.textColored([1.0, 0.85, 0.0, 1.0], "Manual Hideout Return");
  if (ImGui.button("Back To Hideout + Reset")) {
    sendBackToHideoutAndReset('Manual');
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
    const areaName = areaInfo.areaName || areaInfo.areaId || 'unknown';
    const areaColor = areaName.toLowerCase().includes('hideout') ? [1, 1, 0, 1] : [1, 1, 1, 1];
    ImGui.textColored(areaColor, `Area: ${areaName}`);
  }

  // ---- Map Objectives (shown when in a map) ----
  const objectives = poe2.getMapObjectives();
  if (objectives) {
    ImGui.separator();
    ImGui.textColored([1.0, 0.85, 0.0, 1.0], "Map Objectives");

    // Main objective
    if (objectives.mainObjective) {
      const main = objectives.mainObjective;
      const mainColor = main.isCompleted ? [0.0, 1.0, 0.0, 1.0] : [1.0, 1.0, 1.0, 1.0];
      const mainIcon = main.isCompleted ? '[x]' : '[ ]';
      ImGui.textColored(mainColor, `  ${mainIcon} ${main.text || '(no text)'}`);
    }

    // Sub-objectives
    if (objectives.subObjectives && objectives.subObjectives.length > 0) {
      const doneCount = objectives.subObjectives.filter(s => s.isCompleted).length;
      const totalCount = objectives.subObjectives.length;
      ImGui.textColored([0.7, 0.8, 1.0, 1.0], `  Content: ${doneCount}/${totalCount} completed`);

      for (const sub of objectives.subObjectives) {
        const subColor = sub.isCompleted ? [0.4, 0.8, 0.4, 1.0] : [0.9, 0.9, 0.9, 1.0];
        const subIcon = sub.isCompleted ? '[x]' : '[ ]';
        const name = sub.name || '???';
        const obj = sub.objective || '';
        ImGui.textColored(subColor, `    ${subIcon} ${name}`);
        if (obj && !sub.isCompleted) {
          ImGui.textColored([0.6, 0.6, 0.6, 1.0], `        ${obj}`);
        }
      }
    }
  }

  // ---- Uncompleted Atlas Maps (always readable, even with atlas closed) ----
  const atlas = poe2.getAtlasNodes({ includeHidden: true });
  if (atlas && atlas.isValid) {
    ImGui.separator();
    const uncompletedNodes = [];
    for (let i = 0; i < atlas.nodes.length; i++) {
      const n = atlas.nodes[i];
      if (n.isUnlocked && !n.isCompleted) {
        uncompletedNodes.push({ index: i, node: n });
      }
    }
    const totalNodes = atlas.nodeCount;
    const completedCount = atlas.nodes.filter(n => n.isCompleted).length;

    ImGui.textColored([0.3, 0.8, 1.0, 1.0],
      `Atlas: ${completedCount}/${totalNodes} completed, ${uncompletedNodes.length} available`);

    if (uncompletedNodes.length > 0 && ImGui.treeNode(`Uncompleted Maps (${uncompletedNodes.length})###uncompleted_maps`)) {
      for (const item of uncompletedNodes) {
        const n = item.node;
        const name = n.shortName || n.fullName || `Node ${item.index}`;
        const traits = (n.traits || []).map(t => t.name).filter(Boolean);
        const traitStr = traits.length > 0 ? ` [${traits.join(', ')}]` : '';

        ImGui.textColored([1.0, 1.0, 0.0, 1.0], `  [${item.index}] ${name}${traitStr}`);
      }
      ImGui.treePop();
    }
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

  ImGui.end();
}

// ============================================================================
// PLUGIN EXPORT
// ============================================================================

function onDraw() {
  drawUI();
}

export const mapperPlugin = { name: 'Mapper', onDraw };

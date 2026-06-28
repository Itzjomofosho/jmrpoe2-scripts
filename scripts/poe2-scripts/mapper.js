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
import { sendMoveRaw, moveAngle, stopMovement, int32ToBytesBE, sendMoveGridDir, sendBotMoveTo } from './movement.js';
import { executeChanneledSkill, angleToDeltas, buildDirectionalPacket } from './rotation_builder.js';
import { runAutoDodge, AUTO_DODGE_DEFAULTS, autoDodgeStatus, drawDangerZones } from './auto_dodge_core.js';
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
  moveIntervalMs: 140,        // ms between move packets; finer = smoother dither-staircase in tight corridors
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
  // General auto-dodge (folded in from the AutoDodge plugin): dodge boss/rare telegraphs, projectiles,
  // ground effects and melee cones -- in ANY state. Dodge packet re-captured + fixed 2026-06-21 (bare 01 A3,
  // no DC). ON by default. (Replaces the AutoDodge plugin -- disable that plugin to avoid double-dodge.)
  autoDodgeEnabled: true,
  // CLICK-TO-MOVE: route movement through the GAME pathfinder (0xA3 move-to-position) -> collision-aware, no JS
  // wall-jab/dither yoyo. ON by default; auto-falls-back to the heading packets if inert (needs in-game Move=Mouse).
  clickToMove: true,
  // Delirium: at map entry, walk INTO the start mirror to activate it before heading to the boss.
  deliriumMirrorEnabled: true,
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
  // Hideout map opener (Auto-pick & enter maps)
  hideoutFlowEnabled: true,
  releaseOnDeath: true,         // 'Release on death': auto resurrect-in-hideout so the loop continues
  waystoneMinTier: 1,
  waystoneMaxTier: 16,
  waystoneRarityNormal: true,
  waystoneRarityMagic: true,
  waystoneRarityRare: true,
  waystoneRarityUnique: true,
  waystoneCorruptedOnly: false,
  waystoneNonCorruptedOnly: false,
  waystoneIdentifiedOnly: true,   // default ON: never place an UNIDENTIFIED waystone
  // Map node filtering
  avoidPowerfulMapBoss: true,   // skip atlas nodes flagged "Powerful Map Boss" (scary bosses)
  clearIncursion: true,         // walk to each unopened Vaal Chest (incursion) so the opener opens it
  clearRares: true,             // engage nearby rares/uniques before proceeding (entity_actions kills)
  clearBreach: true,            // breach roam BUILT (stabilise detection + isObjectiveDone done-flag) -> catch breaches
  clearAbyss: true,             // do abyss big nodes (AbyssFinalNodeBase) one at a time; gated on Abyss [x]
  clearVerisiumRemnants: true,  // Expedition2 (Verisium): auto -- clear-to-unlock -> open -> auto-pick best reward -> hammer -> clear -> loot
  stopWhenInventoryFull: true,  // AFK SAFETY: while in hideout, don't start a new map if the inventory is full (auto-resumes when cleared)
  inventoryFullStopFreeCells: 2,// "full" = this many or fewer free 1x1 cells left in the main inventory
  drawLines: true,              // MASTER toggle: draw lines to things (boss + incursion/breach/abyss/delirium)
  enablePrecursors: false,
  activatePrecursorBeacon: true, // activate a Precursor (Tower) Beacon in the map-complete phase, after loot
  precursorRarityNormal: true,
  precursorRarityMagic: true,
  precursorRarityRare: true,
  precursorRarityUnique: true,
  hideoutPortalEnterMaxAttempts: 4,
  hideoutPortalEnterDelayMs: 1200,
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
let templeExploreLastPickAt = 0;
let templeRareExploreCache = null;
let templeRareExploreCacheAt = 0;
let templeOptionalSearchStartAt = 0;
let templeOptionalSearchStartX = 0;
let templeOptionalSearchStartY = 0;
let templeOptionalSearchMaxDist = 0;
let templeUnreachableTargets = []; // [{x,y,expiresAt}]
let lastTempleBossBypassLogTime = 0;
let lastLateTempleHandoffCheck = 0;

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
let lastExploreScanTime = 0;
let lastPauseTellTime = 0;
const deliriumBlacklist = new Set();   // "gx,gy" of Delirium pieces we can't reach/consume
let deliriumTargetKey = '';
let deliriumTargetStart = 0;
let bossExploreLastTargetX = 0;
let bossExploreLastTargetY = 0;
let bossExploreLastPickTime = 0;
let bossExploreNoPathCount = 0;
let exploreTgtX = null, exploreTgtY = null, exploreTgtSetAt = 0, exploreTgtIsMarker = false;   // STICKY explore target (anti-yoyo): commit to one marker OR frontier until reached/30s/stuck
let bossFightOrbitWaypointX = 0;
let bossFightOrbitWaypointY = 0;
let bossFightOrbitLastAssignTime = 0;
let bossFightRecentOrbitSectors = []; // small ring-buffer of recent sectors to avoid repeats
let bossFightRecentWaypoints = []; // [{x,y}] recent kite points to avoid ping-pong loops
let bossFightStuckCount = 0;
let bossNoPathCount = 0;
let bossDetourLastPickTime = 0;
let bossRecentDetours = []; // [{x,y}] recent detour anchors to avoid loops
let bossCheckpointGateFailCount = 0;
let bossCheckpointLastDist = Infinity;
let bossCheckpointLastImprovementTime = 0;
let checkpointBestDist = Infinity;                       // anti-freeze watchdog: min dist-to-anchor reached this checkpoint attempt
let fogBlockedAnchorX = 0, fogBlockedAnchorY = 0, fogBlockedAnchorUntil = 0;  // boss anchor proven fog-UNREACHABLE -> FINDING_BOSS skips it + explores toward it to reveal (survives the FINDING_BOSS-entry abandonedBossTargets wipe)
let fogBlockedAnchorConf = 0, _bbSeedAt = 0;   // FIND-layer: confidence of the held bearing (>=0.7 -> structural opposite-side reject in pickUnexploredHeading) + the seed throttle
let bossMeleeExplorePickTime = 0;
let bossMeleeExploreNoPathCount = 0;
let bossMeleeCachedTarget = null;
let bossMeleeCachedTargetAt = 0;
let bossMeleeCachedActionEntity = null;
let bossMeleeActionProbeAt = 0;
let bossMeleeStallLastDist = Infinity;
let bossMeleeStallLastProgressAt = 0;
let bossMeleeApproachLastEvadeAt = 0;
let bossArenaCacheX = NaN, bossArenaCacheY = NaN;   // arena-interior (boss spawn / activation spot) LOCKED once ever seen -- the objects flicker in/out of stream range
let bossMeleeProbeX = NaN, bossMeleeProbeY = NaN;   // one-time committed probe PAST the checkpoint into the arena when no interior is streamed yet

// Hideout flow state
let hideoutMapDeviceId = 0;
let hideoutSelectedNodeIndex = -1;
let hideoutActivationKey = null; // { x: int32, y: int32 } from node+0x2C8
let hideoutSuspendReason = '';
let hideoutLastActionTime = 0;
let hideoutMapDeviceInteractAt = 0;   // cooldown gate: the device interact TOGGLES the atlas, never spam it
let hideoutWaystonePlaced = false;
let uiAtlasCache = null;
// getAtlasNodes() REFRESHES the open atlas panel on EVERY call, and the node list is static while open.
// So read it ONCE and cache it; every UI panel reads through here. The "Re-read##atlas" button clears it.
function getAtlasCached() {
  if (!uiAtlasCache || !uiAtlasCache.isValid) {
    try { uiAtlasCache = poe2.getAtlasNodes({ includeHidden: true }); } catch (e) { uiAtlasCache = null; }
  }
  return uiAtlasCache;
}
let hideoutPrecursorsPlaced = 0;
let hideoutEntityScanLogged = false; // one-time log of nearby entities
let waystoneNoMatchLogAt = 0;
let hideoutWaystoneMoveAttempts = 0;
let hideoutNodeRetryCount = 0;        // # of DIFFERENT atlas nodes whose waystone placement failed this cycle (cap=3, then suspend)
let hideoutTraverseAttempts = 0;
let hideoutPortalEnterAttempts = 0;
let hideoutFailedNodeBlacklist = new Set();
let hideoutSkipExistingPortalUntil = 0; // after map complete, ignore old hideout portals briefly
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
const TRAVERSE_PACKET_WORKING = Object.freeze([0x00, 0xF7, 0x01, 0xFF, 0xFF, 0xFF, 0xC5, 0xFF, 0xFF, 0xFF, 0xBA]);
const DEATH_HIDEOUT_RECHECK_DELAY_MS = 1000;
const DEATH_HIDEOUT_TRIGGER_COOLDOWN_MS = 6000;
const HIDEOUT_SKIP_OLD_PORTALS_AFTER_COMPLETE_MS = 45000;

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
let lastBossZekoaPanicRollTime = 0;
let bossDodgeSide = 1; // alternates left/right around behind arc
let dodgeMoveSuppressUntil = 0; // pause normal move packets briefly after dodge roll
let _dodgeDiagAt = 0;           // TEMP diag throttle: log state+mode during boss/unique fights
const autoDodgeCfg = { ...AUTO_DODGE_DEFAULTS, minIntervalMs: 1100 }; // folded-in AutoDodge (faster re-dodge in fights)
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
let fightLastNearbyMonsterCount = 0;
let fightArenaEvalTime = 0;
let fightArenaBossUniques = [];
let fightArenaBossAliveCount = 0;
let fightArenaRadarX = NaN;
let fightArenaRadarY = NaN;
let fightObjectiveInfoCache = null;
let fightObjectiveInfoTime = 0;
let bossFightClearanceScore = 8;
let bossFightClearanceSampleAt = 0;
let bossFightClearanceSampleX = 0;
let bossFightClearanceSampleY = 0;
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
let ignoredUtilityTargets = new Map();   // key -> expiry ts (was a no-expiry Set: B7/B8 -- timed-out targets now retry)
let utilityActiveTarget = null;
let utilityNoPathCount = 0;
let utilityArrivalWaitStart = 0;
let utilityDetourUntil = 0;
let utilityLastSelectedKey = '';
let utilityResumeState = STATE.IDLE;
let utilitySessionStartTime = 0;
let utilitySessionGiveUpUntil = 0;
let utilityLastProgressDist = Infinity;
let utilityLastProgressTime = 0;
let utilityStats = {
  openableCandidates: 0,
  lootCandidates: 0,
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
const RADAR_TARGET_TOL = 60;   // a name-matched radar path is only trusted if its endpoint is within this of the requested target
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
          // proximity gate: a 'boss'/'temple' name-match whose endpoint is far from the requested target is
          // the WRONG beacon (radar's "Boss Beacon" = farthest TGT, often river-side) -> reject, fall through.
          const ddx = rp.targetX - targetGX, ddy = rp.targetY - targetGY;
          if (ddx * ddx + ddy * ddy > RADAR_TARGET_TOL * RADAR_TARGET_TOL) continue;
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

// BOSS ARENA POINTER: far boss-arena indicator objects (VaalBossStatue wall-lasers, BossArenaBlocker once it
// streams, Checkpoint_Endgame_Boss, etc.) carry REAL grid coords even from across the map -- their cluster
// centroid is the boss DIRECTION when no boss checkpoint/entity is streamed yet. Skips origin-junk (unstreamed
// entities default to (0,0)). Cached 4s (the arena is static). Returns {x,y,count} or null.
const BOSS_ARENA_HINT_PATTERNS = ['Checkpoint_Endgame_Boss', 'VaalBossStatue', 'BossArenaBlocker', 'BossLeagueContent', 'Throne'];
let bossArenaHintCache = null, bossArenaHintAt = -99999;
function findBossArenaHint(player, now) {
  if (now - bossArenaHintAt < 4000) return bossArenaHintCache;
  bossArenaHintAt = now;
  // getAllEntities = UNCAPPED (getEntities's 128-cap drops far static arena objects in dense areas). One pass, 4s.
  let all; try { all = poe2.getAllEntities() || []; } catch (e) { return bossArenaHintCache; }
  // STRONGEST signal: the boss + its minions/adds are ALIVE Unique monsters with 'Boss' in the metadata name
  // (e.g. .../HyenaCentaurSpearBossMinion). Their centroid IS the arena. Fall back to the static arena objects
  // (VaalBossStatue / Throne / boss checkpoint / arena blocker) only when no boss mobs are streamed yet.
  const rx = new RegExp(BOSS_ARENA_HINT_PATTERNS.join('|'), 'i');
  let bsx = 0, bsy = 0, bn = 0, asx = 0, asy = 0, an = 0;
  for (const e of all) {
    const nm = e.name || '', gx = e.gridX || 0, gy = e.gridY || 0;
    if (Math.abs(gx) < 40 && Math.abs(gy) < 40) continue;         // origin-junk = unstreamed, skip
    if ((e.entitySubtype || '').includes('Unique') && /boss/i.test(nm) && e.isAlive !== false) { bsx += gx; bsy += gy; bn++; }
    else if (rx.test(nm)) { asx += gx; asy += gy; an++; }
  }
  if (bn > 0)      bossArenaHintCache = { x: Math.round(bsx / bn), y: Math.round(bsy / bn), count: bn, src: 'boss-mobs' };
  else if (an > 0) bossArenaHintCache = { x: Math.round(asx / an), y: Math.round(asy / an), count: an, src: 'arena-obj' };
  else             bossArenaHintCache = null;
  return bossArenaHintCache;
}

// Arena INTERIOR (where the boss spawns / ACTIVATES on proximity -- user: "he activates once we get close to the
// middle-top of the arena") = the streamed arena-boundary objects EXCLUDING the entrance checkpoint, plus any alive
// boss-mobs. These objects FLICKER in/out of stream range, so callers LOCK the result. 3s scan, uncapped entity list.
let bossArenaInteriorCache = null, bossArenaInteriorAt = -99999;
function findBossArenaInterior(now) {
  if (now - bossArenaInteriorAt < 3000) return bossArenaInteriorCache;
  bossArenaInteriorAt = now;
  let all; try { all = poe2.getAllEntities() || []; } catch (e) { return bossArenaInteriorCache; }
  const rxInt = /BossArenaBlocker|VaalBossStatue|Throne|BossLeagueContent|BossArenaLocker|BossForceField/i;
  let bsx = 0, bsy = 0, bn = 0, asx = 0, asy = 0, an = 0;
  for (const e of all) {
    const nm = e.name || '', gx = e.gridX || 0, gy = e.gridY || 0;
    if (Math.abs(gx) < 40 && Math.abs(gy) < 40) continue;          // origin-junk = unstreamed
    if ((e.entitySubtype || '').includes('Unique') && /boss/i.test(nm) && e.isAlive !== false) { bsx += gx; bsy += gy; bn++; }
    else if (rxInt.test(nm)) { asx += gx; asy += gy; an++; }
  }
  if (bn > 0) bossArenaInteriorCache = { x: Math.round(bsx / bn), y: Math.round(bsy / bn) };
  else if (an > 0) bossArenaInteriorCache = { x: Math.round(asx / an), y: Math.round(asy / an) };
  else bossArenaInteriorCache = null;
  return bossArenaInteriorCache;
}

// JS BFS pathfinder over isWalkable -- findPathBFS is DEAD (returns empty), so this is the real "walk around
// closed walls" nav for any non-objective target. Bounded box around from->to, coarse 8u cells, snaps an
// in-wall target to the nearest walkable cell. Returns {x,y} world-grid waypoints, or null (let radar/steer
// handle it). Cheap: BFS explores only what it needs (~100-300 isWalkable probes in practice).
function jsBfsPath(fromX, fromY, toX, toY) {
  if (![fromX, fromY, toX, toY].every(Number.isFinite)) return null;
  const CELL = 8, MARGIN = 140, CAP = 14000;   // MARGIN was 64 -- too tight to find a WIDE way AROUND a wall on REVEALED terrain (the abyss "walk back around" bug: the route exists but lies outside the from->to box, so BFS finds nothing + navTo parks). Widen the search box (CAP raised to match) so navTo routes AROUND, not just straight through.
  fromX = Math.floor(fromX); fromY = Math.floor(fromY); toX = Math.floor(toX); toY = Math.floor(toY);
  const minX = Math.min(fromX, toX) - MARGIN, maxX = Math.max(fromX, toX) + MARGIN;
  const minY = Math.min(fromY, toY) - MARGIN, maxY = Math.max(fromY, toY) + MARGIN;
  const W = Math.ceil((maxX - minX) / CELL), H = Math.ceil((maxY - minY) / CELL);
  if (W < 2 || H < 2 || W * H > CAP) return null;
  const wc = new Map();
  const walk = (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
    const k = cy * W + cx; let v = wc.get(k);
    if (v === undefined) { try { v = poe2.isWalkable(Math.floor(minX + cx * CELL + CELL / 2), Math.floor(minY + cy * CELL + CELL / 2)); } catch (e) { v = false; } wc.set(k, v); }
    return v;
  };
  const sx = Math.floor((fromX - minX) / CELL), sy = Math.floor((fromY - minY) / CELL);
  let tx = Math.floor((toX - minX) / CELL), ty = Math.floor((toY - minY) / CELL);
  if (!walk(sx, sy)) return null;                       // we're in a wall cell -> let steering handle it
  if (!walk(tx, ty)) {                                  // target sits in a wall cell -> snap to nearest walkable
    let best = null, bestD = Infinity;
    for (let r = 1; r <= 4 && !best; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (walk(tx + dx, ty + dy)) { const d = dx * dx + dy * dy; if (d < bestD) { bestD = d; best = [tx + dx, ty + dy]; } }
      }
    }
    if (!best) return null;
    tx = best[0]; ty = best[1];
  }
  const prev = new Int32Array(W * H).fill(-1), vis = new Uint8Array(W * H);
  const tgt = ty * W + tx, NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const q = [sy * W + sx]; vis[sy * W + sx] = 1; let qh = 0, found = false;
  while (qh < q.length) {
    const cur = q[qh++];
    if (cur === tgt) { found = true; break; }
    const cx = cur % W, cy = (cur - cx) / W;
    for (const d of NB) {
      const nx = cx + d[0], ny = cy + d[1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (vis[ni] || !walk(nx, ny)) continue;
      vis[ni] = 1; prev[ni] = cur; q.push(ni);
    }
  }
  if (!found) return null;
  const path = [];
  for (let cur = tgt; cur !== -1; cur = prev[cur]) { const cx = cur % W, cy = (cur - cx) / W; path.push({ x: minX + cx * CELL + CELL / 2, y: minY + cy * CELL + CELL / 2 }); }
  path.reverse();
  return path.length >= 2 ? path : null;
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
    // Adopt the radar's target ONLY for non-boss types. A 'boss' target is terrain-anchored (arena centroid)
    // and authoritative -- never let a far radar "Boss Beacon" hijack it (that's what ran us south into the
    // river). EDIT 1 already guarantees an ACCEPTED boss radar path ends within RADAR_TARGET_TOL, so we still
    // FOLLOW the path; we just don't move the target out from under arrival/steer.
    const radarOff = Math.hypot(radarResult.targetX - toX, radarResult.targetY - toY);
    if (radarOff > 30 && targetPathType !== 'boss') {
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
  // 1.5) JS BFS over isWalkable -- routes around CLOSED walls for ANY target (findPathBFS below is dead). The
  //      radar path above still wins for objectives; this covers elites / content / breach / anything else.
  // =====================================================================
  try {
    const jp = jsBfsPath(fromX, fromY, toX, toY);
    if (jp && jp.length >= 2) {
      currentPath = jp;
      currentWaypointIndex = 0;
      pathComputeCount++;
      const njs = Date.now();
      if (njs - lastPathFoundLogTime > 1200) { log(`JS path: ${jp.length} wp`); lastPathFoundLogTime = njs; }
      return true;
    }
  } catch (e) { /* fall through to findPathBFS / steer */ }

  // =====================================================================
  // 1.75) WHOLE-MAP terrain pathfinder over STATIC grid_walkable_data (NOT fog-gated) via RadarV2's proven
  //       coarse (8x) pipeline -- routes to FAR / unexplored targets that jsBfsPath (margin-box) and
  //       findPathBFS (revealed cache) cannot. Output is already {x,y} fine-grid -> walker consumes unchanged.
  //       Also feeds the C++ renderer (setRadarPaths) so the route DRAWS on the minimap + large map (V1-style).
  // =====================================================================
  try {
    const tp = poe2.findPathTerrain(fromX, fromY, toX, toY);
    if (tp && tp.length >= 2) {
      currentPath = tp;
      currentWaypointIndex = 0;
      pathComputeCount++;
      const ntp = Date.now();
      if (ntp - lastPathFoundLogTime > 1200) { log(`Terrain path: ${tp.length} wp`); lastPathFoundLogTime = ntp; }
      return true;
    }
  } catch (e) { /* binding not in DLL yet -> fall through to findPathBFS / steer */ }

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
    // BFS ran but found NO path -> the target is genuinely UNREACHABLE. Do NOT fall through to the A*
    // fallback: its "path" ignores walls (the degenerate 2-wp the bot rams straight into the wall).
    // Report no-path so the explorer drops this target and picks a reachable one.
    currentPath = [];
    return false;
  } catch (err) {
    // findPathBFS truly unavailable (pre-rebuild only) -> only THEN fall back to A* below.
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

// NEW move protocol: send a grid-space HEADING directly (no iso round-trip -> no aspect distortion).
function sendMoveGridLimited(gridDX, gridDY, force = false) {
  const now = Date.now();
  const minGap = Math.max(120, currentSettings.moveIntervalMs || 200);
  if (!force && now < dodgeMoveSuppressUntil) return false;
  if (!force && now - lastMovePacketTime < minGap) return false;
  if (!force && now - lastStopPacketTime < 120) return false;
  const sent = sendMoveGridDir(gridDX, gridDY);
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

// Sample isWalkable along a straight line -> true only if the whole segment is walkable (no corner-cut).
let lastMoveLogTime = 0;
let freezeBestDist = Infinity;
let steerBestDist = Infinity, steerBestTime = 0, steerTgtX = NaN, steerTgtY = NaN;  // steer-fallback (no BFS path) progress
let freezeBestTime = 0;
let feelMode = false, feelDir = 0, feelTrialStart = 0, feelBlocked = [0, 0, 0, 0];
let feelTrialX = 0, feelTrialY = 0, feelOriginX = 0, feelOriginY = 0;
// Physical obstacles (rocks/corpses/doodads) are invisible to isWalkable/findPathBFS. On CONTACT (sent a
// heading, didn't move) we remember the spot briefly so path-aim + the explorer route AROUND it instead of
// re-feeding the bot into the same wedge.
let softBlocks = [];                 // {x,y,t}
const SOFTBLOCK_TTL = 12000;         // ms
const SOFTBLOCK_R = 22;              // grid units
function addSoftBlock(gx, gy) {
  const t = Date.now();
  softBlocks = softBlocks.filter((b) => t - b.t < SOFTBLOCK_TTL);
  for (const b of softBlocks) if ((b.x - gx) ** 2 + (b.y - gy) ** 2 < (SOFTBLOCK_R * 0.6) ** 2) { b.t = t; return; }
  softBlocks.push({ x: gx, y: gy, t });
}
function nearSoftBlock(gx, gy, r = SOFTBLOCK_R) {
  const t = Date.now();
  for (const b of softBlocks) { if (t - b.t >= SOFTBLOCK_TTL) continue; if ((b.x - gx) ** 2 + (b.y - gy) ** 2 < r * r) return b; }
  return null;
}
let lastFrontierMarkX = NaN, lastFrontierMarkY = NaN;
function lineWalkable(x0, y0, x1, y1) {
  if (typeof poe2.isWalkable !== 'function') return true;
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.floor(d / 6));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!poe2.isWalkable(Math.floor(x0 + (x1 - x0) * t), Math.floor(y0 + (y1 - y0) * t))) return false;
  }
  return true;
}

let _steerSign = 1;   // hysteresis: which side we steered around the LAST wall (commit to one side -> kill the left/right flip-flop yoyo)
// ============================== CLICK-TO-MOVE backend ==============================
// Route grid movement through the GAME pathfinder via the 0xA3 move-to-POSITION packet (sendBotMoveTo) instead of a
// blind grid HEADING -> the game sees real collision, so no wall-jab / dither yoyo. Guarded by clickToMove (default ON).
// 0xA3 is INERT unless the in-game Move keybind = Mouse, so a PREFLIGHT watches for motion and auto-disables (-> heading
// packets) if a far move produces none. moveTowardGridPos is the SINGLE choke point (stepPathWalker + every direct chase
// route through it), so this one guard covers all mapper movement.
let clickToMoveDisabled = false;            // preflight tripped -> heading packets for the rest of the session
// Frame REBUILT 2026-06-28 from a live capture (01 A3 ... 29 09 04 00 FF 00 | dx | dy, 19B + the 01AB release) -- no
// longer desyncs. But behavior was rough live (yoyo'd over items / no-progress on far loot / skipped abysses), so it's
// OFF for now (user: "screw click to move, WASD for now; revisit"). Flip true + un-hide the checkbox when we tune it.
const CLICK_TO_MOVE_READY = false;
let _ctmTryAt = 0, _ctmTryPx = NaN, _ctmTryPy = NaN;
function clickToMovePreflightTick(pgx, pgy, gridDist) {
  if (clickToMoveDisabled) return;
  if (gridDist < 20) { _ctmTryAt = 0; return; }                       // not really going anywhere -> don't judge motion
  const now = Date.now();
  if (!_ctmTryAt || !Number.isFinite(_ctmTryPx)) { _ctmTryAt = now; _ctmTryPx = pgx; _ctmTryPy = pgy; return; }
  if (Math.hypot(pgx - _ctmTryPx, pgy - _ctmTryPy) > 8) { _ctmTryAt = now; _ctmTryPx = pgx; _ctmTryPy = pgy; return; }   // it moved -> 0xA3 works
  if (now - _ctmTryAt > 1200) {                                       // 1.2s of move-to packets to a far target, NO motion -> inert
    clickToMoveDisabled = true;
    log('[ClickToMove] no motion after 1.2s -> 0xA3 inert (set in-game Move=Mouse to use click-to-move) -> using heading packets');
  }
}
function sendClickMoveLimited(playerGX, playerGY, targetGX, targetGY) {
  const now = Date.now();
  const minGap = Math.max(120, currentSettings.moveIntervalMs || 200);
  if (now < dodgeMoveSuppressUntil) return false;
  if (now - lastMovePacketTime < minGap) return false;
  if (now - lastStopPacketTime < 120) return false;
  const ok = sendBotMoveTo(targetGX - playerGX, targetGY - playerGY);  // 0xA3 grid-DELTA move -> game pathfinds to (player+delta)
  if (ok !== false) lastMovePacketTime = now;
  return ok;
}

function moveTowardGridPos(playerGX, playerGY, targetGX, targetGY) {
  let gridDX = targetGX - playerGX;
  let gridDY = targetGY - playerGY;
  const gridDist = Math.sqrt(gridDX * gridDX + gridDY * gridDY);

  if (gridDist < 1) return false;

  // CLICK-TO-MOVE: hand routing to the GAME pathfinder (collision-aware) instead of the blind grid heading below.
  if (CLICK_TO_MOVE_READY && currentSettings.clickToMove !== false && !clickToMoveDisabled) {
    clickToMovePreflightTick(playerGX, playerGY, gridDist);
    if (!clickToMoveDisabled) return sendClickMoveLimited(playerGX, playerGY, targetGX, targetGY);
    // preflight just tripped this frame -> fall through to the heading packets
  }

  // WALL-AVOIDANCE: probe a step straight toward the target; if that tile is UNWALKABLE, rotate the heading
  // until a walkable direction is found (steer around the wall). isWalkable works even though findPathBFS is
  // dead -- so this lets the straight-line mover route AROUND terrain instead of jamming into it.
  let nav = 'grid-heading';
  try {
    const step = Math.min(16, gridDist);
    const ux = gridDX / gridDist, uy = gridDY / gridDist;
    const walkAt = (hx, hy) => poe2.isWalkable(Math.floor(playerGX + hx * step), Math.floor(playerGY + hy * step));
    if (!walkAt(ux, uy)) {
      // HYSTERESIS: probe the side we steered around the LAST wall FIRST (small->large), only flipping to the
      // other side if this one is fully blocked. Stateless left-then-right probing was the left/right flip-flop
      // yoyo at walls. Cap ~75deg -- NEVER steer backward/away from the target.
      const angles = _steerSign >= 0 ? [0.5, 0.9, 1.3, -0.5, -0.9, -1.3] : [-0.5, -0.9, -1.3, 0.5, 0.9, 1.3];
      for (const a of angles) {
        const ca = Math.cos(a), sa = Math.sin(a);
        const hx = ux * ca - uy * sa, hy = ux * sa + uy * ca;
        if (walkAt(hx, hy)) { gridDX = hx * gridDist; gridDY = hy * gridDist; nav = 'grid-steer'; _steerSign = a >= 0 ? 1 : -1; break; }
      }
    }
  } catch (e) {}

  // NEW move protocol: send the grid-space HEADING directly (00 63 packet). The player walks that way
  // until the next heading / stop, so we keep re-sending each tick and stop on arrival.
  lastMoveDebug = { gridDX: gridDX.toFixed(1), gridDY: gridDY.toFixed(1), angle: '-', dist: gridDist.toFixed(0), nav };
  const sent = sendMoveGridLimited(gridDX, gridDY);
  return sent;
}

// ── Incursion (Vaal Chest) clearing ─────────────────────────────────────────
// Old-school: walk straight at each UNOPENED Vaal Chest via moveTowardGridPos (grid-heading packet,
// NO findPathBFS), let the game's opener open it (its chest component flips isAlive->false), then on
// to the next-nearest. Handles 2+ incursions by always re-targeting the nearest unopened chest.
// Dwell ~8s per chest as a fallback if the opener doesn't bite. Reset per map in resetMapper().
const INCURSION_DWELL_MS = 8000;     // 5-10s dwell at each chest
const INCURSION_REACH = 16;          // grid units that count as "at" the chest
let incursionDwellStart = 0;
let incursionLastInteract = 0;
let incursionCurId = 0;
let incursionCurStartAt = 0;
let incursionRecentlyDone = new Map();   // chest id -> expiry ts (briefly skip after dwell timeout / give-up)
// --- Vaal Beacon (incursion pedestal) ACTIVATION flow: go to a beacon, clear guardians + activate (on
// approach), done when activated (isObjectiveDone flips back to true after we saw it activatable, or the
// precise MinimapIcon+0x10 binding) or a 12s dwell timeout. ---
const INCURSION_BEACON_REACH = 30;       // proximity that counts as "at" the beacon (it activates on approach)
const INCURSION_BEACON_DWELL_MS = 12000; // dwell fallback at a beacon (user: clear within 10-15s OR complete)
let incBeaconId = 0, incBeaconStartAt = 0, incBeaconDwell = 0, incBeaconLastInteract = 0;
let incBeaconWasActivatable = false;     // saw isObjectiveDone==false (cleared/activatable) -> next true = activated
let incBeaconBlacklist = new Map();      // beacon id -> expiry ts (done / unreachable)

function getUnopenedVaalChests(now) {
  // rename-proof: 0.5.4 moved the folder LeagueIncursion -> LeagueIncursionNew, so the old
  // 'LeagueIncursion/EncounterChest' substring stopped matching. Match any Incursion EncounterChest.
  const e = poe2.getEntities({ nameContains: 'EncounterChest', lightweight: true }) || [];
  // NB: getEntities returns the local PLAYER as a fallback when nothing matches the filter -> VALIDATE the
  // name, or we "dwell" on ourselves (id 782 = DexFour at d=0 forever). Same trap for any nameContains query.
  return e.filter(x => x && x.isAlive && /Incursion/i.test(x.name || '') && /EncounterChest/i.test(x.name || '') && !((incursionRecentlyDone.get(x.id) || 0) > now));
}

function runIncursionChestRun(player, now) {
  if (!player) return false;
  const chests = getUnopenedVaalChests(now);
  if (chests.length === 0) { incursionCurId = 0; incursionDwellStart = 0; return false; }
  chests.sort((a, b) =>
    ((a.gridX - player.gridX) ** 2 + (a.gridY - player.gridY) ** 2) -
    ((b.gridX - player.gridX) ** 2 + (b.gridY - player.gridY) ** 2));
  const t = chests[0];
  if (incursionCurId !== t.id) { incursionCurId = t.id; incursionCurStartAt = now; incursionDwellStart = 0; }

  // Give up on a chest we can't reach in 25s (skip it 30s, try the next / fall through to boss).
  if (now - incursionCurStartAt > 25000) {
    incursionRecentlyDone.set(t.id, now + 30000);
    log(`[Incursion] can't reach Vaal Chest ${t.id} in 25s -> skipping`);
    incursionCurId = 0; incursionDwellStart = 0;
    return false;
  }

  const dist = Math.hypot(t.gridX - player.gridX, t.gridY - player.gridY);
  if (dist > INCURSION_REACH) {
    incursionDwellStart = 0;
    navTo(t.gridX, t.gridY, 'Vaal Chest', now);   // walk via pathfinder; don't skip on a transient 'stuck'
    statusMessage = `Incursion: -> Vaal Chest ${dist.toFixed(0)}u (${chests.length} left)`;
    return true;
  }

  // At the chest: stop + let the opener open it; also self-interact as a fallback. Dwell until opened.
  if (!incursionDwellStart) { incursionDwellStart = now; log(`[Incursion] at Vaal Chest (${Math.round(t.gridX)},${Math.round(t.gridY)}) -> opening`); }
  if (now - incursionLastInteract > 500) { incursionLastInteract = now; try { interactWithEntity(t); } catch (_) {} }

  // "Until opened": once opened, isAlive->false so getUnopenedVaalChests drops it next frame.
  // Fallback so we never get stuck: dwell timeout -> skip briefly and move to the next.
  if (now - incursionDwellStart >= INCURSION_DWELL_MS) {
    incursionRecentlyDone.set(t.id, now + 15000);
    log(`[Incursion] dwell timeout at Vaal Chest ${t.id} -> next`);
    incursionCurId = 0; incursionDwellStart = 0;
    return true;
  }
  statusMessage = `Incursion: dwelling at Vaal Chest ${((now - incursionDwellStart) / 1000).toFixed(0)}s`;
  return true;
}

function getIncursionBeacons(now) {
  // VALIDATE the name -- getEntities returns the local player as a fallback when nothing matches (player-trap).
  const e = poe2.getEntities({ nameContains: 'IncursionPedestalEncounter', lightweight: false }) || [];
  return e.filter(x => x && /IncursionPedestalEncounter/i.test(x.name || '')
    && !((incBeaconBlacklist.get(x.id) || 0) > now)
    && x.isTargetable !== false                       // a SPENT/done beacon goes non-targetable instantly (live-RE: done beacon isTargetable=false) -- belt for a lagging minimapIconDone flag; active beacons stay targetable (the bot interacts to activate)
    && !minimapDoneOf(x.address, now));
}

function nearestIncursionBeacon(player, now) {
  const beacons = getIncursionBeacons(now);
  if (!beacons.length) return null;
  let best = null, bestD = Infinity;
  for (const b of beacons) { const d = Math.hypot(b.gridX - player.gridX, b.gridY - player.gridY); if (d < bestD) { bestD = d; best = b; } }
  if (best) best._d = bestD;
  return best;
}

// Vaal Beacon flow: walk to the nearest beacon, clear its guardians + activate (approach + interact nudge),
// done when ACTIVATED (precise minimapIconDone binding, or isObjectiveDone went false->true) or a 12s
// dwell timeout. Returns true while handling (preempts the boss flow), false when nothing to do.
function runIncursionBeaconRun(player, now) {
  if (!player) return false;
  const beacons = getIncursionBeacons(now);
  if (!beacons.length) { incBeaconId = 0; incBeaconDwell = 0; return false; }
  beacons.sort((a, b) =>
    ((a.gridX - player.gridX) ** 2 + (a.gridY - player.gridY) ** 2) -
    ((b.gridX - player.gridX) ** 2 + (b.gridY - player.gridY) ** 2));
  const t = beacons[0];
  if (incBeaconId !== t.id) { incBeaconId = t.id; incBeaconStartAt = now; incBeaconDwell = 0; incBeaconWasActivatable = false; }

  // DONE detection. Precise binding wins if present (MinimapIcon+0x10). JS fallback: isObjectiveDone is FALSE
  // only in the cleared/activatable window; once we've SEEN it activatable and it locks back to true, it was
  // activated. (An un-cleared beacon also reads true, so we only conclude "done" after seeing the false window.)
  let done = false;
  try {
    if (minimapDoneOf(t.address, now)) done = true;
    else { const od = poe2.isObjectiveDone(Number(t.address)); if (od === false) incBeaconWasActivatable = true; else if (incBeaconWasActivatable) done = true; }
  } catch (_) {}
  if (done) {
    incBeaconBlacklist.set(t.id, now + 600000);
    log(`[Incursion] Vaal Beacon ${t.id} ACTIVATED -> done`);
    incBeaconId = 0; incBeaconDwell = 0;
    return true;
  }

  // can't reach in 25s -> skip a while, try the next / fall through to boss.
  if (now - incBeaconStartAt > 25000) {
    incBeaconBlacklist.set(t.id, now + 60000);
    log(`[Incursion] can't reach Vaal Beacon ${t.id} in 25s -> skipping`);
    incBeaconId = 0; incBeaconDwell = 0;
    return false;
  }

  const dist = Math.hypot(t.gridX - player.gridX, t.gridY - player.gridY);
  if (dist > INCURSION_BEACON_REACH) {
    incBeaconDwell = 0;
    navTo(t.gridX, t.gridY, 'Vaal Beacon', now);   // walk via pathfinder; don't skip on a transient 'stuck'
    statusMessage = `Incursion: -> Vaal Beacon ${dist.toFixed(0)}u (${beacons.length} left)`;
    return true;
  }

  // at the beacon: dwell while the bot clears guardians + it activates on approach; nudge with an interact.
  if (!incBeaconDwell) { incBeaconDwell = now; log(`[Incursion] at Vaal Beacon (${Math.round(t.gridX)},${Math.round(t.gridY)}) -> clear + activate`); }
  if (now - incBeaconLastInteract > 600) { incBeaconLastInteract = now; try { interactWithEntity(t); } catch (_) {} }

  // ALREADY-COMPLETE backstop (USER: "it's done in the map, why are you here"): poe2.minimapIconDone misses some
  // already-ACTIVATED beacons, and the isObjectiveDone fallback can't conclude "done" without first witnessing the
  // activatable window -- which never happens for one that was done on arrival. A FRESH beacon either flips
  // activatable (-> incBeaconWasActivatable) or still has guardians to clear; an already-DONE one does NEITHER.
  // So after 4s dwell with no activatable window AND no hostiles left near it, skip it instead of burning 12s.
  if (!incBeaconWasActivatable && now - incBeaconDwell > 4000) {
    let hostiles = 0;
    try { for (const m of (poe2.getEntities({ lightweight: true }) || [])) {
      if (m.entityType === 'Monster' && m.isAlive && m.isHostile && m.isTargetable &&
          Math.hypot((m.gridX || 0) - t.gridX, (m.gridY || 0) - t.gridY) < 55) { hostiles++; break; }
    } } catch (_) {}
    if (hostiles === 0) {
      incBeaconBlacklist.set(t.id, now + 600000);
      log(`[Incursion] Vaal Beacon ${t.id} already complete (no guardians, never activatable) -> skip`);
      incBeaconId = 0; incBeaconDwell = 0;
      return true;
    }
  }

  if (now - incBeaconDwell >= INCURSION_BEACON_DWELL_MS) {
    incBeaconBlacklist.set(t.id, now + 120000);
    log(`[Incursion] Vaal Beacon ${t.id} dwell timeout (${Math.round(INCURSION_BEACON_DWELL_MS / 1000)}s) -> next`);
    incBeaconId = 0; incBeaconDwell = 0;
    return true;
  }
  statusMessage = `Incursion: at Vaal Beacon ${((now - incBeaconDwell) / 1000).toFixed(0)}s${incBeaconWasActivatable ? ' (activatable)' : ''}`;
  return true;
}

// ── Content rotation: clear-nearby rares + strict-nearest content mechanic (all timeout-bounded) ────
// Top-level preempt (runs before the state switch in any non-boss, non-hideout state). Agreed design:
//   (1) STAY and clear any nearby rare/unique -> stop in range, entity_actions kills it (never run away)
//   (2) else go to the NEAREST incomplete content mechanic (incursion/delirium/breach) and run it.
// Every step has a timeout + brief blacklist, so the bot can never get permanently stuck -- it just
// moves to the next-nearest target. Movement is old-school (moveTowardGridPos), NOT the broken BFS.
const ROT_RARE_RANGE    = 62;     // a rare/unique within this many grid units is "nearby" -> engage it
const ROT_RARE_TIMEOUT  = 12000;  // can't kill it in 12s (immune/unreachable) -> blacklist 20s, move on
const ROT_CONTENT_REACH = 14;     // "at" a content target
const ROT_BREACH_DWELL    = 75000; // HARD cap = stuck-safety ONLY. A WIDE/tanky breach needs >45s to fully clear (45s cut one off mid-fight with elites still up = the "left without finishing" bug). The no-mob CLEAR_MS ends a real breach far sooner, and unreachable mobs get blacklisted -> no-mob -> clear, so this rarely fires
const ROT_BREACH_CLEAR_MS = 7000;  // no breach mob near the center for this long -> cleared, move on
const ROT_BREACH_MOB_R   = 230;   // pursue breach mobs within this of the CENTER -- the ring spawns OUTWARD WIDE (elites/hands/fingers land 150-210u out); now ACTUALLY applied (was dead code -> unbounded off-map chase). Bounds the chase + keeps us near the middle.
const ROT_BREACH_SWEEP_R = 55;    // when no mob in range, sweep this far from center (mobs spawn in a ring)
const ROT_BREACH_ORBIT_R    = 70;    // BIG-CIRCLE radius -- orbit the center WIDE (mobs spawn outward in a ring)
const ROT_BREACH_ORBIT_STEP = 0.8;   // radians per heading change (~8 points = a real circle, not 1 direction)
const ROT_BREACH_ORBIT_MS   = 800;   // heading-change interval (slow = NO per-tick-orbit stutter/DC)
const ROT_BREACH_SPAWN_GRACE = 12000; // before ANY mob is seen, give the breach this long to spawn before declaring it empty
let rotRareId = 0, rotRareStart = 0;
let rotRareBlacklist = new Map();      // rare id -> expiry ts
let rotDeliriumKey = '', rotDeliriumStart = 0;
let rotBreachId = 0, rotBreachStart = 0;
let rotBreachClosestD = Infinity, rotBreachClosestAt = 0;  // PHASE-1 closest approach -> "close but pathfinder parked" activate
let rotBreachBlacklist = new Map();    // breach id -> expiry ts
let rotBreachActivatedAt = 0;          // when we reached the Brequel center (breach activated)
let rotBreachCenterX = 0, rotBreachCenterY = 0;   // CACHED breach center (Brequel despawns on activation)
let rotBreachLastMobAt = 0;            // last time a breach mob was near the center (adaptive "cleared")
let rotBreachMobCache = null, rotBreachMobScanAt = 0;   // throttled breach-mob scan (cuts the stutter)
let rotBreachSweepAng = 0, rotBreachSweepUntil = 0;     // slow WIDE sweep when no mob is in range
let rotBreachSawMob = false;           // did ANY breach mob spawn this activation? no -> already-complete breach
let rotBreachMobBL = new Map();        // breach mob id -> expiry (mobs we can't reach -- behind a wall/pit)
let rotBreachTgtId = 0, rotBreachTgtSince = 0;  // current pursued mob id + start (stuck/yoyo detection)
let rotBreachStabilised = false;       // a Rare/Unique breach mob has spawned -> head BACK to the center for it
let rotBreachStabilisedLogged = false; // one-shot guard for the "stabilised -> returning" log line
let rotBreachClearedAt = 0;            // when the breach CLOSED -> 5s loot-collect dwell before leaving
let breachReturnTgtX = NaN, breachReturnTgtY = NaN;   // P5 RETURN-ANCHOR: the pre-breach explore heading, restored when the breach closes so we resume toward the boss/frontier we detoured FROM

// nearest ALIVE hostile rare/unique within ROT_RARE_RANGE (pure distance; magic is left to entity_actions)
function nearestRareToClear(player, now) {
  let mons;
  try { mons = poe2.getEntities({ type: 'Monster', aliveOnly: true, lightweight: true }) || []; } catch (e) { return null; }
  let best = null, bestD = ROT_RARE_RANGE;
  for (const e of mons) {
    const sub = e.entitySubtype || '';
    if (!sub.includes('Rare') && !sub.includes('Unique')) continue;   // magic = clear on the move, don't stop
    if (!isHostileAlive(e)) continue;
    if (/BossCannon/i.test(e.name || '')) continue;   // boss-spawned cannon PROPS -- can't be killed (the +0x8A flag was reverted; name-match instead, pending RE)
    if ((rotRareBlacklist.get(e.id) || 0) > now) continue;
    const d = Math.hypot((e.gridX || 0) - player.gridX, (e.gridY || 0) - player.gridY);
    if (d < bestD) { bestD = d; best = e; best._d = d; }
  }
  return best;
}

// Is an ALIVE hostile rare/unique CLOSE enough to be attacking us? Arms auto-dodge ('rare' mode) regardless of
// whether the rotation is engaging it (rotRareId) -- a unique swinging while we walk / boss-find must STILL be
// dodged. Ignores the engage-blacklist (a rare we gave up CHASING can still swing). Throttled ~250ms; range
// generous since the dodge CORE only actually rolls on a real incoming attack.
let _rareNearAt = 0, _rareNearVal = false;
function rareUniqueNear(now) {
  if (now - _rareNearAt < 250) return _rareNearVal;
  _rareNearAt = now;
  _rareNearVal = false;
  let player; try { player = POE2Cache.getLocalPlayer(); } catch (e) { return false; }
  if (!player || player.gridX == null) return false;
  let mons; try { mons = poe2.getEntities({ type: 'Monster', aliveOnly: true, lightweight: true }) || []; } catch (e) { return false; }
  for (const e of mons) {
    const sub = e.entitySubtype || '';
    if (!sub.includes('Rare') && !sub.includes('Unique')) continue;
    if (!isHostileAlive(e)) continue;
    const dx = (e.gridX || 0) - player.gridX, dy = (e.gridY || 0) - player.gridY;
    if (dx * dx + dy * dy <= 75 * 75) { _rareNearVal = true; break; }
  }
  return _rareNearVal;
}

// clear-nearby-then-go: walk to the rare, then hold (entity_actions kills). Returns true while engaging.
function runClearNearbyRares(player, now) {
  const e = nearestRareToClear(player, now);
  if (!e) { rotRareId = 0; return false; }
  if (rotRareId !== e.id) { rotRareId = e.id; rotRareStart = now; }
  if (now - rotRareStart > ROT_RARE_TIMEOUT) {                       // can't kill -> blacklist + move on
    rotRareBlacklist.set(e.id, now + 20000);
    log(`[Rotation] rare ${e.id} not dying in ${ROT_RARE_TIMEOUT / 1000}s -> skip`);
    rotRareId = 0; return false;
  }
  const sub = (e.entitySubtype || '').replace('Monster', '');
  // REDIRECT movement toward the rare (engage it -- do NOT stop); entity_actions deals the damage and
  // auto-dodge (wired next) handles dodging its attacks. The build is fast, so it dies on contact.
  moveTowardGridPos(player.gridX, player.gridY, e.gridX, e.gridY);
  statusMessage = `Engage ${sub} (${e._d.toFixed(0)}u)`;
  return true;
}

// nearest unopened Vaal Chest (incursion), _d set; null if none
function nearestUnopenedChest(player, now) {
  const chests = getUnopenedVaalChests(now);
  let best = null, bestD = Infinity;
  for (const c of chests) { const d = Math.hypot((c.gridX || 0) - player.gridX, (c.gridY || 0) - player.gridY); if (d < bestD) { bestD = d; best = c; best._d = d; } }
  return best;
}

// nearest non-blacklisted Delirium piece/mirror from base-game map content; {gx,gy,d} or null.
// STICKY: if we're already committed to a piece (rotDeliriumKey) and it's still present, keep targeting
// IT instead of re-picking the per-frame nearest -- two similar-distance pieces flip-flopping as we move
// was the yo-yo. Sticky holds until the piece is consumed (gone from content) or blacklisted (15s timeout).
function nearestDeliriumPiece(player) {
  let mc;
  try { mc = (typeof poe2.getMapContent === 'function') ? poe2.getMapContent() : null; } catch (e) { return null; }
  if (!mc || !mc.length) return null;
  let kx = null, ky = null;
  if (rotDeliriumKey) { const a = rotDeliriumKey.split(',').map(Number); kx = a[0]; ky = a[1]; }
  let best = null, bestD = Infinity, sticky = null, stickyD = Infinity;
  for (const m of mc) {
    if (m.type !== 'Delirium' && !(m.path && m.path.indexOf('Delirium') >= 0)) continue;
    const gx = Math.round(m.gridX), gy = Math.round(m.gridY);
    if (deliriumBlacklist.has(gx + ',' + gy)) continue;
    const d = Math.hypot(player.gridX - gx, player.gridY - gy);
    if (d < bestD) { bestD = d; best = { gx, gy, d }; }
    if (kx !== null) { const sd = Math.hypot(gx - kx, gy - ky); if (sd <= 6 && sd < stickyD) { stickyD = sd; sticky = { gx, gy, d }; } }
  }
  return sticky || best;
}

// walk to the delirium piece (old-school mover), step in when close; timeout -> blacklist + move on
function runDelirium(player, now, piece) {
  const p = piece || nearestDeliriumPiece(player);
  if (!p) { rotDeliriumKey = ''; return false; }
  const key = p.gx + ',' + p.gy;
  if (rotDeliriumKey !== key) { rotDeliriumKey = key; rotDeliriumStart = now; }
  if (now - rotDeliriumStart > 15000) {                              // can't reach/consume in 15s -> blacklist
    deliriumBlacklist.add(key);
    log(`[Rotation] delirium piece (${key}) timeout -> blacklist`);
    rotDeliriumKey = ''; return false;
  }
  // SMART-path the bulk of the way so we route AROUND walls (was a straight-line diagonal that drove INTO them);
  // once CLOSE, walk ONTO the piece (redirect, like rares) so it gets consumed (moveTowardGridPos no-ops at dist<1).
  if (p.d > ROT_CONTENT_REACH) navTo(p.gx, p.gy, 'Delirium', now);
  else moveTowardGridPos(player.gridX, player.gridY, p.gx, p.gy);
  statusMessage = p.d > ROT_CONTENT_REACH ? `Delirium -> ${p.d.toFixed(0)}u` : `Delirium: stepping in`;
  return true;
}

// nearest breach activation point (PARKED; off by default). {id,gridX,gridY,_d} or null
function nearestBreachPoint(player, now) {
  // non-lightweight so each Brequel carries .address (the EntityData ptr) for the isObjectiveDone read.
  let e;
  try { e = poe2.getEntities({ nameContains: 'BrequelInitiator', lightweight: false }) || []; } catch (_) { return null; }
  let best = null, bestD = Infinity;
  for (const x of e) {
    // getEntities returns the local PLAYER as a fallback when nothing matches -> VALIDATE the name.
    if (!x || !/BrequelInitiator/i.test(x.name || '')) continue;
    // DEFINITIVE skip: the game marks a SPENT breach via the MinimapIcon component +0x38 (0=openable,
    // 1=spent/done), read by poe2.isObjectiveDone. Skip done ones -> no re-target, no stale line.
    let done = false; try { done = poe2.isObjectiveDone(Number(x.address)); } catch (_) {}
    if (done) continue;
    if ((rotBreachBlacklist.get(x.id) || 0) > now) continue;
    const d = Math.hypot((x.gridX || 0) - player.gridX, (x.gridY || 0) - player.gridY);
    if (d < bestD) { bestD = d; best = x; best._d = d; }
  }
  return best;
}

// PARKED breach handler: stand on the point + interact. Closing-detection is the future hard part, so
// this is timeout-bounded and runs only when currentSettings.clearBreach is explicitly enabled.
// PHASE 1: walk to the Brequel center and activate the breach (it despawns on contact -> cache the center)
function runWalkToBreach(player, now, b) {
  if (rotBreachId !== b.id) {
    rotBreachId = b.id; rotBreachStart = now; rotBreachClosestD = Infinity; rotBreachClosestAt = now; rotBreachClearedAt = 0;
    if (Number.isFinite(exploreTgtX)) { breachReturnTgtX = exploreTgtX; breachReturnTgtY = exploreTgtY; }   // P5 SAVE-RETURN-ANCHOR: remember the pre-breach heading
  }
  const d = Math.hypot(b.gridX - player.gridX, b.gridY - player.gridY);
  rotBreachCenterX = b.gridX; rotBreachCenterY = b.gridY;   // cache center every frame (despawn-on-open safe)
  if (d < rotBreachClosestD - 2) { rotBreachClosestD = d; rotBreachClosestAt = now; }   // track closest approach
  // SMART REACH (user): don't blacklist a far-but-WALKABLE breach on a flat timer -- keep going while we're CLOSING
  // (slow / stunned / mob-blocked is fine). Bail only on genuine NO-PROGRESS (>11s no closer approach = stuck) or a
  // generous backstop -- so the bot can trek 400-500u to an objective instead of skipping at 25s.
  if ((now - rotBreachClosestAt > 11000) || (now - rotBreachStart > 50000)) {
    rotBreachBlacklist.set(b.id, now + 60000); log(`[Breach] Brequel ${b.id} no progress (closest ${rotBreachClosestD.toFixed(0)}u) -> skip`); rotBreachId = 0; breachReturnTgtX = NaN; breachReturnTgtY = NaN; return false;   // clear the return-anchor: this bail skips runBreachRoam's restore, so a saved anchor would leak to the next breach
  }
  // Must actually TOUCH the Brequel (<=REACH) to OPEN it. Declaring "activated" from afar = a PHANTOM breach
  // (no mobs spawn -> false-complete) -- that was the 16u "got close but didn't touch" bug. The Brequel often
  // sits on a cell the pathfinder treats non-walkable, so the path PARKS a few u short. When stalled close,
  // STEER STRAIGHT at the exact center to close the final gap instead of giving up + faking activation.
  if (d > ROT_CONTENT_REACH) {
    // PUSH-THROUGH (2026-06-27): navTo parks short on tight web/bridge terrain. When no closer for ~3s AND within frontier
    // range, drive STRAIGHT at the Brequel to cross the gap (was d<=30-only -> a 192u/727u park just sat there till the bail).
    const parked = ((d <= 30 && now - rotBreachClosestAt > 1000) || (now - rotBreachClosestAt > 3000 && d < 300));
    if (parked) moveTowardGridPos(player.gridX, player.gridY, b.gridX, b.gridY);   // push the gap directly (frontier-walk)
    else navTo(b.gridX, b.gridY, 'Breach', now);                                    // pathfind the bulk of the way
    statusMessage = parked ? `Breach: pushing ${d.toFixed(0)}u` : `Breach -> ${d.toFixed(0)}u`;
    return true;   // the 25s timeout handles a truly-unreachable Brequel
  }
  // TOUCHED (<=REACH) -> the Brequel despawns NOW; hand off to PHASE 2 (which HOLDS the center until mobs spawn).
  rotBreachActivatedAt = now; rotBreachLastMobAt = now; rotBreachSawMob = false; rotBreachStabilised = false; rotBreachStabilisedLogged = false;
  rotBreachMobBL.clear(); rotBreachTgtId = 0;
  rotBreachBlacklist.set(b.id, now + 120000);   // don't try to re-walk this (now-gone) Brequel
  log(`[Breach] TOUCHED (${d.toFixed(0)}u) -> activated at (${Math.round(b.gridX)},${Math.round(b.gridY)}) -> clearing`);
  return true;
}

// nearest ALIVE hostile monster near the cached breach center, prioritized rare/unique > magic > white
function bestBreachMob(player, now) {
  // throttle the scan -- entity reads during a breach's spawn churn are a big stutter source.
  if (now - rotBreachMobScanAt < 320) return rotBreachMobCache;
  rotBreachMobScanAt = now;
  // breach mobs are tagged "/Monsters/Breach/" AND getEntities({type:'Monster'}) MISSES them -> use getAllEntities.
  let all; try { all = poe2.getAllEntities() || []; } catch (e) { rotBreachMobCache = null; return null; }
  let best = null, bestRank = -1, bestDp = Infinity;
  for (const e of all) {
    if (!/\/Monsters\/Breach\//i.test(e.name || '')) continue;   // the real breach-mob marker
    if (e.isAlive === false) continue;
    const sub = e.entitySubtype || '';
    if (sub.includes('Rare') || sub.includes('Unique')) rotBreachStabilised = true;   // breach rares up == STABILISED
    if ((rotBreachMobBL.get(e.id) || 0) > now) continue;         // can't-reach (walled) mob -> skip it
    if (Math.hypot((e.gridX || 0) - rotBreachCenterX, (e.gridY || 0) - rotBreachCenterY) > ROT_BREACH_MOB_R) continue;   // outside the breach ring -> don't chase it off-map (keeps us near center)
    const rank = (sub.includes('Unique') || sub.includes('Rare')) ? 2 : sub.includes('Magic') ? 1 : 0;
    const dp = Math.hypot((e.gridX || 0) - player.gridX, (e.gridY || 0) - player.gridY);
    if (rank > bestRank || (rank === bestRank && dp < bestDp)) { bestRank = rank; bestDp = dp; best = { id: e.id, gridX: e.gridX, gridY: e.gridY, sub, dp }; }
  }
  rotBreachMobCache = best;
  return best;
}

// PHASE 2: ACTIVE breach -- FOLLOW THE MOBS: chase the nearest breach mob so entity_actions actually KILLS it
// (chasing mobs as they spawn/spread around the ring IS the wide arc). No mob in range -> wide slow sweep to find
// the next cluster. RARE spawned == STABILISED -> go to center for it. Done when cleared/collapsed.
function runBreachRoam(player, now) {
  const elapsed = now - rotBreachActivatedAt;
  const mob = bestBreachMob(player, now);   // nearest mob to PURSUE + kill (also sets rotBreachStabilised on a rare)
  if (mob) { rotBreachLastMobAt = now; rotBreachSawMob = true; }
  if (rotBreachStabilised && !rotBreachStabilisedLogged) {
    rotBreachStabilisedLogged = true;
    log(`[Breach] STABILISED -- rares spawned -> back to center for them`);
  }
  // DONE -- NO "already complete" guessing (nearestBreachPoint already filtered isObjectiveDone breaches, so
  // this one is REAL). Before ANY mob is seen, give it SPAWN_GRACE to spawn (mobs can take >4s -- the old 4s
  // skip was the false-complete bug). After a mob is seen, end CLEAR_MS after the last one. Hard cap = safety.
  const clearTimeout = rotBreachSawMob ? ROT_BREACH_CLEAR_MS : ROT_BREACH_SPAWN_GRACE;
  if ((elapsed > 4000 && now - rotBreachLastMobAt > clearTimeout) || elapsed > ROT_BREACH_DWELL) {
    // CLOSED -> if mobs spawned (so loot dropped), DWELL 5s holding the center so the breach's (delayed) loot
    // lands + gets picked up before we hand off to boss/next content. A no-mob breach has nothing to collect.
    if (!rotBreachClearedAt) { rotBreachClearedAt = now; log(`[Breach] ${rotBreachSawMob ? 'cleared' : 'no mobs spawned'} after ${Math.round(elapsed / 1000)}s${rotBreachSawMob ? ' -> collecting loot 5s' : ' -> done'}`); }
    if (rotBreachSawMob && now - rotBreachClearedAt < 5000) {
      moveTowardGridPos(player.gridX, player.gridY, rotBreachCenterX, rotBreachCenterY);   // hold near the drops
      statusMessage = `Breach: collecting loot ${((now - rotBreachClearedAt) / 1000).toFixed(0)}s`;
      return true;
    }
    rotBreachBlacklist.set(rotBreachId, now + 1800000);
    // P5 RESUME-FROM-ANCHOR: restore the pre-breach explore heading so we continue toward the boss/frontier we detoured
    // FROM, instead of re-exploring blindly from the breach spot. (No-op during a boss-approach -- bossGridX/Y persists.)
    if (Number.isFinite(breachReturnTgtX)) {
      exploreTgtX = breachReturnTgtX; exploreTgtY = breachReturnTgtY; exploreTgtSetAt = now; exploreTgtIsMarker = false;
      breachReturnTgtX = NaN; breachReturnTgtY = NaN;
      log(`[Breach] done -> leaving (resumed pre-breach heading)`);
    } else { log(`[Breach] done -> leaving`); }
    rotBreachActivatedAt = 0; rotBreachId = 0; rotBreachMobCache = null; rotBreachClearedAt = 0;
    return false;
  }
  if (mob) {
    // FOLLOW THE MOBS (incl. rares once stabilised) -- go straight at the nearest breach mob so entity_actions
    // KILLS it. This clears the WIDE-spread breach; the old order parked the STABILISED branch at the center
    // while elites lingered 150-210u out at the edges = the "stopped tracking it / left without finishing" bug.
    // Yoyo-guard: a mob chased >5s without dying (walled/unreachable) gets blacklisted -> move to the next.
    if (rotBreachTgtId !== mob.id) { rotBreachTgtId = mob.id; rotBreachTgtSince = now; }
    else if (now - rotBreachTgtSince > 5000) { rotBreachMobBL.set(mob.id, now + 8000); rotBreachTgtId = 0; }   // 5s (was 3s -- a far rare within the ring needs time to reach before we call it unreachable)
    moveTowardGridPos(player.gridX, player.gridY, mob.gridX, mob.gridY);
    statusMessage = `Breach: kill ${mob.sub || 'mob'} ${Math.round(mob.dp)}u${rotBreachStabilised ? ' [stab]' : ''} (${Math.round(elapsed / 1000)}s)`;
  } else if (rotBreachStabilised) {
    // STABILISED but no mob in pursue range -> rares may be holding at the center; go there for them.
    moveTowardGridPos(player.gridX, player.gridY, rotBreachCenterX, rotBreachCenterY);
    statusMessage = `Breach: STABILISED -> center (${Math.round(elapsed / 1000)}s)`;
  } else if (!rotBreachSawMob) {
    // SPAWN GRACE -- breach not open yet (no mob ever seen): HOLD the center so we stay inside the breach's
    // trigger zone and it actually OPENS, instead of sweeping back out of it (the other half of the 16u bug).
    moveTowardGridPos(player.gridX, player.gridY, rotBreachCenterX, rotBreachCenterY);
    statusMessage = `Breach: opening -- hold center ${Math.round(elapsed / 1000)}s`;
  } else {
    // NO mob in range (after some already spawned) -> WIDE slow sweep around the center for the next cluster.
    if (now > rotBreachSweepUntil) { rotBreachSweepAng += ROT_BREACH_ORBIT_STEP; rotBreachSweepUntil = now + ROT_BREACH_ORBIT_MS; }
    const sx = rotBreachCenterX + Math.cos(rotBreachSweepAng) * ROT_BREACH_ORBIT_R;
    const sy = rotBreachCenterY + Math.sin(rotBreachSweepAng) * ROT_BREACH_ORBIT_R;
    moveTowardGridPos(player.gridX, player.gridY, sx, sy);
    statusMessage = `Breach: sweep for mobs ${Math.round(elapsed / 1000)}s`;
  }
  return true;
}

// Walk to a target USING the pathfinder (routes AROUND walls via the radar BFS / jsBfsPath), NOT straight-line.
// Use for content walks (abyss/breach/incursion) so they don't yoyo into walls. Returns stepPathWalker's result.
function navTo(tx, ty, label, now) {
  if ((Math.abs(targetGridX - tx) > 18 || Math.abs(targetGridY - ty) > 18 || currentPath.length === 0) && now - lastRepathTime > 500) {
    startWalkingTo(tx, ty, label, '');
  }
  return stepPathWalker();
}

// Read an entity's MinimapIcon+0x10 done-flag (1 = spent/done/gray, 0 = active). Prefers the minimapIconDone
// C++ binding; if it isn't in the loaded DLL yet, FALLS BACK to parsing dumpEntityComponents (works with NO
// rebuild -- that binding already exists). Cached ~2s (the dump is heavy).
const _mmDoneCache = new Map();
function minimapDoneOf(addr, now) {
  if (!addr) return false;
  now = now || Date.now();
  if (typeof poe2.minimapIconDone === 'function') { try { return poe2.minimapIconDone(Number(addr)); } catch (_) { return false; } }
  const c = _mmDoneCache.get(addr);
  if (c && now - c.at < 2000) return c.v;
  let v = false;
  try { const d = poe2.dumpEntityComponents(Number(addr)) || ''; const m = d.match(/MinimapIcon:\s+\S+\s+\S+\s+(\S+)/); if (m) v = parseInt(m[1], 16) !== 0; } catch (_) {}
  _mmDoneCache.set(addr, { v, at: now });
  return v;
}

// THE abyss done-signal = the minimap ICON SPRITE itself (what the user actually sees go gray). getQuestMarkers
// gives each marker's iconType: 890 = ACTIVE node (colored, go fight) / 891 = DONE-or-DEAD (gray, skip) -- same
// active/done sprite split as the cracks (888 active / 889 done). This beats the plinth StateMachine byte, which
// only catches "completed WITH reward" and misses "collapsed/dead" (greyed, no plinth). Cached ~1.5s.
let _qmCache = null, _qmAt = 0;
function abyssIconType(gx, gy, now) {
  if (!_qmCache || now - _qmAt > 1500) { _qmAt = now; try { _qmCache = poe2.getQuestMarkers() || []; } catch (_) { _qmCache = []; } }
  let best = null, bd = 10;
  for (const m of _qmCache) {
    const d = Math.hypot((m.gridX || 0) - gx, (m.gridY || 0) - gy);
    if (d < bd) { bd = d; best = m.iconType; }
  }
  return best;
}

// Classify an AbyssFinalNodeBase entity by its minimap icon: 'active' (iconType 890 -> green, go fight) vs
// 'done' (891 or anything else -> gray, skip = completed OR dead). Fallback when the marker is missing: the
// 'currently-spawning' gameplay byte TriggerableBlockage+0x30 (word[6] low byte) == 1. Cached 1.5s.
const _abyssStCache = new Map();
function abyssNodeStatus(ent, now) {
  if (!ent || !ent.address) return 'done';
  now = now || Date.now();
  const c = _abyssStCache.get(ent.address);
  if (c && now - c.at < 1500) return c.v;
  let v;
  const it = abyssIconType(ent.gridX || 0, ent.gridY || 0, now);
  if (it === 890) v = 'active';
  else if (it === 891) v = 'done';
  else {
    try { const d = poe2.dumpEntityComponents(Number(ent.address)) || ''; const tb = d.match(/TriggerableBlockage:\s+(?:\S+\s+){6}(\S+)/); v = (tb && (parseInt(tb[1], 16) & 0xFF) === 1) ? 'active' : 'done'; } catch (_) { v = 'done'; }
  }
  _abyssStCache.set(ent.address, { v, at: now });
  return v;
}

// --- ABYSS: do the big nodes ONE AT A TIME. Active node = AbyssFinalNodeBase with MinimapIcon+0x10==0 (done
// ==1 = spent/gray). Walk to it, dwell while entity_actions clears the abyss mobs, done when it flips to 1 or
// a 30s timeout (closed off). Gated on the Abyss [x] map objective (whole-map stop). Ignores AbyssCrack (small).
const ABYSS_REACH = 35;            // proximity that counts as "at" the big node
const ABYSS_DWELL_MS = 45000;      // per-node HARD cap (closed-off / can't-finish fallback) -- user wants more kill time
let abyssId = 0, abyssStartAt = 0, abyssDwell = 0, abyssLastInteract = 0, abyssBestDist = Infinity, abyssBestAt = 0;
let abyssBlacklist = new Map();    // node id -> expiry (done / unreachable)
let abyssLootDwellAt = 0;          // ts the node we cleared flipped gray -> loot dwell before moving on
const ABYSS_MIN_LOOT_MS = 5000;    // stay >=5s at a just-cleared node to loot drops + finish stragglers (user)
let abyssNoMobAt = 0;              // ts the area around the current node went abyss-mob-free -> clear/loot timer
const ABYSS_CLEAR_MS = 12000;      // abyss-mob-free (within the 300u chase) THIS long = done -> loot-dwell + next

function getAbyssNodes(now) {
  // VALIDATE the name (player-fallback trap). Keep only genuinely-active nodes (plinth-authoritative classifier).
  const e = poe2.getEntities({ nameContains: 'AbyssFinalNodeBase', lightweight: false }) || [];
  return e.filter(x => {
    if (!x || !/AbyssFinalNodeBase/i.test(x.name || '')) return false;
    if (abyssNodeStatus(x, now) !== 'active') return false;             // GRAY/done (891) -> skip
    if ((abyssBlacklist.get(x.id) || 0) > now) return false;           // retired this run -> stay out. NO self-heal un-blacklist: it resurrected just-cleared nodes -> re-froze the bot.
    return true;
  });
}

function nearestAbyssNode(player, now) {
  const nodes = getAbyssNodes(now);
  if (!nodes.length) return null;
  let best = null, bestD = Infinity;
  for (const n of nodes) { const d = Math.hypot(n.gridX - player.gridX, n.gridY - player.gridY); if (d < bestD) { bestD = d; best = n; } }
  if (best) best._d = bestD;
  return best;
}

let _abyssMobCache = null, _abyssMobAt = 0;
// Nearest alive abyss mob within ABYSS_MOB_RADIUS -- to FOLLOW THE TRAIL UP the cracks (go after the spread, not sleep on
// the node). 150u was too tight: live LeagueAbyss mobs sat at 180-210u -> the bot read "mob-free" + parked on the green
// node. Wider radius -> chase the trail up; PHASE B recenters on the node when nothing's left in range. Throttled 320ms.
const ABYSS_MOB_RADIUS = 300;
function bestAbyssMob(player, now) {
  if (now - _abyssMobAt < 320) return _abyssMobCache;
  _abyssMobAt = now;
  let all; try { all = poe2.getAllEntities() || []; } catch (e) { _abyssMobCache = null; return null; }
  let best = null, bestD = Infinity;
  for (const e of all) {
    if (!/\/Monsters\/LeagueAbyss\//i.test(e.name || '')) continue;
    if (e.isAlive === false) continue;
    const d = Math.hypot((e.gridX || 0) - player.gridX, (e.gridY || 0) - player.gridY);
    if (d <= ABYSS_MOB_RADIUS && d < bestD) { bestD = d; best = { gridX: e.gridX, gridY: e.gridY, d }; }
  }
  _abyssMobCache = best;
  return best;
}

// Abyss flow: walk to the nearest ACTIVE big node, then FIGHT AROUND it (pursue nearby abyss mobs; entity_actions
// kills + pickit loots); done when the node flips MinimapIcon+0x10==1 or a 30s timeout (closed off). One at a time.
let abyssChaseMoveAt = 0, abyssChasePX = 0, abyssChasePY = 0;   // abyss-clear WEDGE detector: route AROUND walls when the corner-chase stops moving
let abyssReachMoveAt = 0, abyssReachPX = 0, abyssReachPY = 0;   // abyss-REACH movement tracker (don't bail a route-AROUND just because dist-to-node isn't closing)
function runAbyssRun(player, now) {
  if (!player) return false;
  const nodes = getAbyssNodes(now);
  // The node we were clearing just flipped GRAY (dropped from the active list) -> DWELL to loot drops +
  // finish stragglers (>=5s, longer while in combat) BEFORE moving to the next node (user request).
  if (abyssId && abyssDwell && !nodes.some(n => n.id === abyssId)) {
    if (!abyssLootDwellAt) abyssLootDwellAt = now;
    const dwelt = now - abyssLootDwellAt;
    const am = bestAbyssMob(player, now);
    // USER: the node just flipped GREEN->GRAY -> STAY STILL on it for 5s so the reward CHEST spawns (moving off the
    // node can suppress the spawn). Dodging still works -- it's a separate hook -- so only HOLD when not mid-roll;
    // do NOT chase stragglers in this window.
    if (dwelt < ABYSS_MIN_LOOT_MS) {
      if (now >= dodgeMoveSuppressUntil) sendStopMovementLimited();
      statusMessage = `Abyss: hold for chest ${Math.round(dwelt / 1000)}/5s (node ${abyssId})`;
      return true;
    }
    // after the 5s hold: finish stragglers, then retire. CAP the chase (15s total dwell) so a re-spawning / drifting
    // wave can't pin the bot at a finished node forever (audit: the dwell straggler-chase had no timeout).
    if (am && dwelt < 15000) {
      moveTowardGridPos(player.gridX, player.gridY, am.gridX, am.gridY);
      statusMessage = `Abyss: stragglers node ${abyssId} (${Math.round(dwelt / 1000)}s)`;
      return true;
    }
    abyssBlacklist.set(abyssId, now + 600000);
    log(`[Abyss] node ${abyssId} cleared + held ${Math.round(dwelt / 1000)}s + looted -> next`);
    abyssId = 0; abyssDwell = 0; abyssLootDwellAt = 0;
    return true;
  }
  abyssLootDwellAt = 0;
  if (!nodes.length) { abyssId = 0; abyssDwell = 0; return false; }
  nodes.sort((a, b) =>
    ((a.gridX - player.gridX) ** 2 + (a.gridY - player.gridY) ** 2) -
    ((b.gridX - player.gridX) ** 2 + (b.gridY - player.gridY) ** 2));
  const t = nodes[0];
  if (abyssId !== t.id) { abyssId = t.id; abyssStartAt = now; abyssDwell = 0; abyssBestDist = Infinity; abyssBestAt = now; abyssNoMobAt = 0; abyssChaseMoveAt = 0; abyssReachMoveAt = now; abyssReachPX = player.gridX; abyssReachPY = player.gridY; }

  // DONE (precise): the node flipped to spent (MinimapIcon+0x10==1).
  if (abyssNodeStatus(t, now) !== 'active') { abyssBlacklist.set(t.id, now + 600000); log(`[Abyss] node ${t.id} done/inert -> next`); abyssId = 0; abyssDwell = 0; return true; }
  // (reach-failure is handled PROGRESS-BASED in Phase A below -- a far-but-walkable node isn't skipped on a flat timer.)
  const dist = Math.hypot(t.gridX - player.gridX, t.gridY - player.gridY);
  // PHASE A -- WALK to the node the FIRST time (abyssDwell unset = not yet reached).
  if (!abyssDwell) {
    if (dist > ABYSS_REACH) {
      if (dist < abyssBestDist - 2) { abyssBestDist = dist; abyssBestAt = now; }   // track closest approach
      if (Math.hypot(player.gridX - abyssReachPX, player.gridY - abyssReachPY) > 10) { abyssReachPX = player.gridX; abyssReachPY = player.gridY; abyssReachMoveAt = now; }   // physically moving (incl. routing AROUND)
      // SMART REACH (user "U CAME FROM THERE, walk AROUND"): bail only on a GENUINE stall -- not closing for 11s AND not
      // physically moving for 6s. A route-AROUND a wall temporarily INCREASES dist-to-node, so the dist-only timer alone
      // would wrongly skip a node the bot is actively walking around to.
      if (((now - abyssBestAt > 11000) && (now - abyssReachMoveAt > 6000)) || (now - abyssStartAt > 50000)) { abyssBlacklist.set(t.id, now + 90000); log(`[Abyss] node ${t.id} no progress (closest ${abyssBestDist.toFixed(0)}u) -> skip`); abyssId = 0; return false; }
      // navTo (fog-gated jsBfs) PARKS at a wall it can't route past -- the corner-stuck bug. When it stops CLOSING for
      // ~2.5s, steer along the FOG-INDEPENDENT macro path (macroWaypointToward = the game-terrain router that sees the
      // whole map's connectivity) to go AROUND the wall. Sticky while routing (going around doesn't close dist, so this
      // stays true) until it brings us close, then navTo finishes the fine approach.
      const navStuck = (now - abyssBestAt > 2500) && dist < 450;
      const mw = navStuck ? macroWaypointToward(player.gridX, player.gridY, t.gridX, t.gridY) : null;
      if (mw) moveTowardGridPos(player.gridX, player.gridY, mw.x, mw.y);
      else navTo(t.gridX, t.gridY, 'Abyss Node', now);
      statusMessage = `Abyss: ${mw ? 'routing around ->' : '->'} node ${dist.toFixed(0)}u (${nodes.length} left)`;
      return true;
    }
    abyssDwell = now; abyssNoMobAt = 0;
    log(`[Abyss] at node (${Math.round(t.gridX)},${Math.round(t.gridY)}) -> clearing (${Math.round(ABYSS_DWELL_MS / 1000)}s cap)`);
  }
  // PHASE B -- CLEAR. FOLLOW THE TRAIL: CHASE abyss mobs (wide radius) even AWAY from the node so the whole spread
  // wave dies -- do NOT pull back to the node while a mob is in range (that anchor was why it killed ~nothing and
  // left). Recenter on the node only when nothing's near (the next wave spawns by it). Done = the node flips gray
  // (checked above) OR mob-free at the node for ABYSS_CLEAR_MS OR the hard cap. (user: spend MORE time killing.)
  if (now - abyssDwell >= ABYSS_DWELL_MS) {
    abyssBlacklist.set(t.id, now + 120000);
    log(`[Abyss] node ${t.id} ${Math.round(ABYSS_DWELL_MS / 1000)}s cap (closed off?) -> next`);
    abyssId = 0; abyssDwell = 0; abyssNoMobAt = 0;
    return true;
  }
  const am = bestAbyssMob(player, now);
  if (am) {
    abyssNoMobAt = 0;
    // CHASE the abyss mob. Dead-reckon straight while we're actually MOVING; but if our POSITION stops changing while
    // chasing (boxed in a corner, jamming into a WALL between us and the mob = the "stuck firing tornado, U CAME FROM
    // THERE" bug), route AROUND via the pathfinder instead. The path exists (we walked in), so navTo can find it.
    if (!abyssChaseMoveAt) { abyssChaseMoveAt = now; abyssChasePX = player.gridX; abyssChasePY = player.gridY; }
    if (Math.hypot(player.gridX - abyssChasePX, player.gridY - abyssChasePY) > 8) { abyssChasePX = player.gridX; abyssChasePY = player.gridY; abyssChaseMoveAt = now; }
    const wedged = now - abyssChaseMoveAt > 2200;
    if (wedged) { const mwc = macroWaypointToward(player.gridX, player.gridY, am.gridX, am.gridY); if (mwc) moveTowardGridPos(player.gridX, player.gridY, mwc.x, mwc.y); else navTo(am.gridX, am.gridY, 'Abyss Mob', now); }
    else if (am.d > 55) navTo(am.gridX, am.gridY, 'Abyss Mob', now);             // FAR mob -> ROUTE up the trail (pathfinder runs UP the cracks); dead-reckoning straight at it through cave terrain yoyos left/right ("why not run up")
    else moveTowardGridPos(player.gridX, player.gridY, am.gridX, am.gridY);     // CLOSE -> dead-reckon the final approach
    statusMessage = `Abyss: ${(wedged || am.d > 55) ? 'running to' : 'clearing'} ${Math.round(am.d)}u (${Math.round((now - abyssDwell) / 1000)}s)`;
  } else if (dist > 55) {
    navTo(t.gridX, t.gridY, 'Abyss Node', now);                         // no mob + drifted off -> recenter for the next wave
    statusMessage = `Abyss: recenter ${dist.toFixed(0)}u`;
  } else {
    if (!abyssNoMobAt) abyssNoMobAt = now;
    if (now - abyssLastInteract > 600) { abyssLastInteract = now; try { interactWithEntity(t); } catch (_) {} }   // nudge in case a wave needs a trigger
    if (now - abyssNoMobAt >= ABYSS_CLEAR_MS) {                          // mob-free within the 300u chase for the full window = done
      // NO green-gate infinite-hold: it froze the bot (~45s, ZERO movement) on a finished-but-still-green node and the
      // self-heal then resurrected it ("sat there till i clicked"). With the 300u chase we'd have followed any live wave,
      // so a full mob-free window = done. RETIRE VIA THE LOOT-DWELL: blacklist so getAbyssNodes drops it, but KEEP
      // abyssId + abyssDwell -> the dwell branch at the top fires next frame, holds 5s for the reward CHEST and loots it
      // BEFORE moving to the next node (fixes "skipped a chest that was complete").
      abyssBlacklist.set(t.id, now + 600000);
      log(`[Abyss] node ${t.id} mob-free ${Math.round(ABYSS_CLEAR_MS / 1000)}s -> loot + next`);
      abyssNoMobAt = 0;
      return true;
    }
    statusMessage = `Abyss: hold ${Math.round((now - abyssNoMobAt) / 1000)}/${Math.round(ABYSS_CLEAR_MS / 1000)}s`;
  }
  return true;
}

// BASE-GAME per-type objective completion -- the [x] Breach / [x] Incursion the Map Content panel renders
// (objState present @+8807 / complete @+8810). We gate content on THIS so a COMPLETED breach/incursion is
// never re-attempted, and because it's game-state it SURVIVES a mapper reload. Bitfield primary (matches the
// panel exactly) + getMapObjectives panel fallback. Cached 1.5s.
const MAP_OBJ_NAMES = ['MapBoss', 'CorruptedNexus', 'Checkpoints', 'RareMonsters', 'Breach', 'Expedition',
  'Delirium', 'Ritual', 'Abyss', 'AbyssDepths', 'Shrines', 'Strongboxes', 'Essences', 'RogueExiles',
  'AzmeriSpirits', 'StoneCircles', 'Incursion', 'Expedition2', 'Breach2'];
let _mapObjDone = {}, _mapObjDoneAt = -99999;
function readMapObjectiveState(now) {
  if (now - _mapObjDoneAt < 1500) return _mapObjDone;
  _mapObjDoneAt = now;
  const out = {};
  try {
    const r = a => Number(Memory.readU64(a)), u32 = a => Number(Memory.readU32(a)) >>> 0;
    const ok = a => a > 0x10000000000 && a < 0x7ff000000000;
    const ig = Number(poe2.getInGameState());
    if (ig) {
      for (const ch of [[0x4e0, 0xd8], [0x2f0, 0x328]]) {   // base-game mgr / UI-root holder -> +424 = objState
        const m = r(ig + ch[0]); if (!ok(m)) continue;
        const s = r(m + ch[1]); if (!ok(s)) continue;
        const os = r(s + 424); if (!ok(os)) continue;
        const present = u32(os + 8807) & 0x7FFFF, complete = u32(os + 8810) & 0x7FFFF;
        if (present !== 0 && (complete & ~present) === 0) {   // validate by bitfield SHAPE (no hardcoded vtable)
          for (let i = 0; i < MAP_OBJ_NAMES.length; i++) if (present & (1 << i)) out[MAP_OBJ_NAMES[i]] = (complete & (1 << i)) ? 1 : 0;
          break;
        }
      }
    }
    if (!Object.keys(out).length) {   // chain failed -> panel fallback (renders the same bits)
      const mo = poe2.getMapObjectives();
      if (mo && mo.content) for (const c of mo.content) out[c.id] = c.isCompleted ? 1 : 0;
    }
  } catch (e) {}
  _mapObjDone = out;
  return out;
}
function mapObjectiveComplete(name, now) { return readMapObjectiveState(now || Date.now())[name] === 1; }

// THE driver: clear nearby rares, else run the strict-nearest incomplete content mechanic. Returns true
// if it handled the frame (caller returns, preempting the boss flow); false -> nothing, fall to boss.
// ============================================================================
// Expedition2 (Verisium Remnant) -- AUTO content.
// Flow: navigate -> CLEAR mobs to unlock -> OPEN the recipe panel (01A3 + 01AA) -> AUTO-PICK
// (read the OFFERED recipes via getExpedition2Offered, rank by reward priority, select the best
// in ONE 00F9 + verify) -> HAMMER (0301 act 00) -> clear the waves (normal attack loop) ->
// LOOT (0301 act 01) -> done. F8 = manual override. Auto-resumes if you hammer manually (state
// flips to fighting). Handles
// multiple remnants. HARD SKIP if a REGULAR Expedition is in the map (user directive).
// Packet constants (01A3 / 0301 / 01AA, handle 87B20004) are pre-patch-proven --
// re-verify at the first live remnant.
// ============================================================================
const EXP2_REACH = 22;             // interact range (grid units)
const EXP2_FIGHT_RADIUS = 95;      // hold within this of the remnant during waves
const EXP2_WIDE_FIGHT_RADIUS = 200; // runes>4 -> chase waves out to here (they spawn wide), returning near the stone
const EXP2_HANDLE = 0x87B20004;    // 0301 hammer/loot handle (FIXED constant)
// EXP2 hammer/pick is fully auto-driven now (no manual F8 key)
const EXP2_TOTAL_TIMEOUT = 180000; // hard safety: bail a remnant after 3 min
const EXP2_LOOT_GRACE = 30000;     // linger for stragglers before looting
const EXP2_SELECT_WAIT = 280;      // ms to let a 00F9 select round-trip before reading the result
const EXP2_PRESELECT_WALK_MS = 1000; // walk this long to CLOSE the panel / un-pause BEFORE the select (the 00F9+01FD no-ops while the panel is open)
// reward VALUE priority (poe2db.tw/Runeshape_Combinations prices x-checked vs the user's value lists,
// 2026-06-27). Exalted-equiv (Divine x ~9); higher value = higher pick priority. NOTE: SPECIFIC-unique
// names (Aldur's Saga / the named Runes / Alloys) need a live cross-check at a remnant -- the binding may
// return "[Rarity|Unique] X" for the random-unique recipes; those fall through to the unique tier below.
const EXP2_VALUE = {
  'Mirror of Kalandra': 43000, "Hinekora's Lock": 8400,
  "Aldur's Saga": 340, 'Perfect Flux': 290, 'Perfect Chaos Orb': 158, "Kolr's Hunt": 156,
  'Thaumaturgic Flux (Level 20)': 113, 'Perfect Exalted Orb': 92, "Olroth's Saga": 80, 'Transcendent Alloy': 80,
  "Astrid's Creativity": 65, "Uhtred's Sidereus": 54, 'Sovereign Alloy': 53,
  "Hedgewitch Assandra's Rune of Wisdom": 38, 'Void Flux': 37, "Medved's Tending": 33,
  "Vorana's Carnage": 31, "Farrul's Rune of the Chase": 28, "The Runebinder's Alloy": 28,
  "Serle's Triumph": 22, 'Celestial Alloy': 18, 'Blazing Flux': 13, 'Chilling Flux': 12,
  "Medved's Saga": 12, "Vorana's Saga": 12, "The Runefather's Alloy": 12,
  "Countess Seske's Rune of Archery": 11, 'Ire of Aldur': 10, 'Crackling Flux': 9,
  "Saqawal's Rune of Memory": 8, 'Betrayal of Aldur': 8, "Courtesan Mannan's Rune of Cruelty": 7,
  'Divine Orb': 9, 'Orb of Annulment': 7, 'Breath of Aldur': 5, 'Greater Chaos Orb': 3,
  'Passion of Aldur': 3, "Thane Girt's Rune of Wildness": 2.5, 'Vaal Orb': 1, 'Chaos Orb': 1,
  'Exalted Orb': 1, 'Greater Exalted Orb': 1, "Greater Jeweller's Orb": 1, "Artificer's Orb": 1,
  "Arcanist's Etcher": 1, "Glassblower's Bauble": 1, 'Orb of Alchemy': 0.6, 'Regal Orb': 0.5,
  "Gemcutter's Prism": 2, 'Uncut Spirit Gem': 1.5, "Perfect Jeweller's Orb": 20, "Lesser Jeweller's Orb": 0.5,
  'Orb of Transmutation': 0.1, 'Orb of Augmentation': 0.1, "Blacksmith's Whetstone": 0.1, 'Orb of Chance': 1,
};
const EXP2_VERISIUM = ['Verisium Pile', 'Powered by Verisium', 'Verisium Manifestations', 'Remnants of Kalguur'];
function exp2Score(r) {
  const name = r.name || '';
  const v = EXP2_VALUE[name];                              // EXACT match -- leveled rewards (Thaumaturgic Flux
  if (v != null) return -v;                                // (Level NN)) only score high at the priced level
  if (/\[Rarity\|Unique\]/i.test(name)) return -15;        // random unique weapon/armour ~ 15 ex
  if (/Uncut (Skill|Support) Gem/i.test(name)) return -3;  // uncut gems ~ small value
  if (/\bRune\b/i.test(name)) return -3;                   // generic/unnamed Rune (Adept/Glacial/Greater...) -- socketable;
                                                           // MUST beat basic Verisium mats: Armourer's Scrap etc. were tying
                                                           // at the default 10 and winning on runeCount (the bad pick you saw)
  if (EXP2_VERISIUM.indexOf(name) >= 0) return 100;        // Verisium mats (lowest)
  return 10;                                               // gems / everything else
}
// USER HEURISTIC (2026-06-27, CORRECTED to value-primary): pick the HIGHEST-VALUE affordable reward; rune-count is
// only the TIEBREAK -- never burn a Mirror-tier pick on a higher-rune lesser item. Prune to runeCount<=loaded (only
// what you can afford), then sort VALUE DESC, rune-count DESC. NOTE: random "[Rarity|Unique]" recipes have rewardAddr=0
// (no fixed reward -- the unique is rolled), so they all score the SAME estimate and can't be ranked vs each other.
function exp2RankCandidates(runeCount) {
  let pool = (poe2.getExpedition2Recipes() || []).filter(r => runeCount <= 0 || r.runeCount <= runeCount);
  if (!pool.length) pool = (poe2.getExpedition2Recipes() || []).slice();
  pool.sort((a, b) => (exp2Score(a) - exp2Score(b)) || (b.runeCount - a.runeCount));   // VALUE DESC, runeCount tiebreak
  pool = pool.slice(0, 60);                                // bound the select-and-verify probes
  return pool;
}
function exp2Select(remnant, idx) {                       // 00 F9 01 + htonl(idx) + htonl(id), THEN 01 FD 00 00 commit
  const id = remnant.id >>> 0;
  const pkt = new Uint8Array([0x00, 0xF9, 0x01,
    (idx >>> 24) & 0xff, (idx >>> 16) & 0xff, (idx >>> 8) & 0xff, idx & 0xff,
    (id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff]);
  // LIVE-PROVEN 2026-06-27 (full capture of manual select recipes 2+4, then a WORKING bot replay -- Transmutation
  // switched): the select is TWO back-to-back SENDs -- 00F9 (idx + remnant id) THEN a `01 FD 00 00` commit. The 01FD is
  // REQUIRED; I'd wrongly removed it off an incomplete capture that showed only the 00F9. CRITICAL: `id` MUST be the
  // Expedition2Encounter entity id, NOT the RuneEncounterController next to it (reads ONE higher -> select misses).
  // Game RECVs 0300 to confirm. (00 00, NOT the 00 01 of the combination-change variant.)
  try {
    const ok = poe2.sendPacket(pkt);
    poe2.sendPacket(new Uint8Array([0x01, 0xFD, 0x00, 0x00]));    // commit -- REQUIRED
    return ok;
  } catch (e) { return false; }
}
// Read the OFFERED recipes straight from the open recipe-panel UI -- drift-proof (the heap select-state vtable is
// dead). offered = uiVisible tiles (bit 0xB of +0x180) in the ~321-tile catalog list; name @ tile.child0 +0x390;
// EXACT-name match -> getExpedition2Recipes index (catalog has Lesser/normal/Greater tiers -- fuzzy match picks wrong).
function exp2OfferedFromUI() {
  if (typeof poe2.getUiRoot !== 'function' || typeof poe2.getExpedition2Recipes !== 'function') return null;
  const root = poe2.getUiRoot(); if (!root) return null;
  const kids = (el) => { const out = []; if (!el) return out; const f = poe2.readMemory(el + 0x10, 'int64'), l = poe2.readMemory(el + 0x18, 'int64'); if (f && l > f) { let n = (l - f) / 8; if (n > 400) n = 400; for (let i = 0; i < n; i++) { const c = poe2.readMemory(f + i * 8, 'int64'); if (c) out.push(c); } } return out; };
  const vis = (el) => { try { return ((poe2.readMemory(el + 0x180, 'uint32') >>> 0) & (1 << 0xB)) !== 0; } catch (e) { return false; } };
  const navp = (el, ix) => { let c = el; for (const i of ix) { const k = kids(c); if (i >= k.length) return 0; c = k[i]; } return c; };
  let list = 0;   // recipe panel = a VISIBLE root child whose [3,2,2,0] subtree is the big catalog tile-list
  for (const c of kids(root)) { if (!vis(c)) continue; const l = navp(c, [3, 2, 2, 0]); if (l && kids(l).length > 100) { list = l; break; } }
  if (!list) return null;
  // A recipe NAME can have DUPLICATES at different rune-counts (LIVE-RE 2026-06-27: "Greater Orb of Transmutation"
  // exists at idx 84/rune3 AND idx 195/rune5; Augmentation at 82/rune3 + 194/rune5). The OFFERED tile shows ONE
  // specific rune-count -> we MUST disambiguate by it. The old byName[last] grabbed the WRONG dupe -> exp2Select sent
  // 195 instead of 84 and silently picked nothing (root cause of "not activated"). Build a name->[recipes] multimap +
  // match the tile's rune-count, which = (tile child count - 1): child 0 is the name, the rest are runeshape icons.
  const byName = {};
  for (const r of (poe2.getExpedition2Recipes() || [])) { if (r && r.name) { const k = r.name.toLowerCase(); (byName[k] || (byName[k] = [])).push(r); } }
  const offered = [];
  for (const t of kids(list)) {
    if (!vis(t)) continue;                                  // only craftable (visible) tiles are OFFERED
    const tk = kids(t);
    const ne = tk[0]; if (!ne) continue;
    let uiName = ''; try { uiName = poe2.readWideStringPtr(ne + 0x390) || ''; } catch (e) {}
    if (!uiName) continue;
    const tileRunes = Math.max(0, tk.length - 1);           // child 0 = name (only child WITH text); icons after it = rune count
    // CASCADE disambiguation (user 2026-06-27): LEVEL 1 = name. If that ties (dup names like the rune3/rune5 orbs),
    // LEVEL 2 = + rune-count -> almost always unique. LEVEL 3 (FUTURE, only if name+count STILL tie) = per-runeshape
    // matching, which needs the deeper rune-TYPE RE -- so we only pay for that when name+count genuinely can't decide.
    let cands = byName[uiName.replace(/^\d+x\s+/, '').trim().toLowerCase()] || [];   // L1: strip "Nx ", exact name
    if (cands.length > 1) { const byRune = cands.filter(r => r.runeCount === tileRunes); if (byRune.length) cands = byRune; }   // L2: + rune-count
    const cat = cands[0] || null;                           // narrowed pick (L3 rune-type RE only if cands.length still >1)
    if (cat) offered.push({ name: cat.name, catalogIdx: cat.index, runeCount: cat.runeCount, uiName });
    else offered.push({ name: uiName, catalogIdx: -1, runeCount: tileRunes, uiName });   // unmapped -> logged, not selectable
  }
  return offered;
}

let exp2CurId = 0;                 // remnant id we're driving
let exp2Phase = 'idle';            // idle | awaitpick | fighting | loot
let exp2StartAt = 0, exp2LastAct = 0, exp2ClearedAt = 0, exp2LootedAt = 0;
let exp2CurDist = Infinity;        // live dist to the remnant we're walking to (USER far-walk shrine-yield gate)
const exp2Done = new Map();        // remnant id -> expiry ts (looted/skipped)
let exp2Candidates = null;         // ranked recipe pool for the current auto-pick (null = rebuild)
let exp2CandIdx = 0;               // candidate being tried
let exp2SelSentAt = 0;             // ts of the current select packet (0 = not yet sent)
let exp2DispatchAt = 0;            // ts the pick was confirmed -> side-step "dispatch" dwell, then hammer (commit packets)
let exp2DecidedAt = 0;             // ts the recipe was DECIDED (panel read)
let exp2SelRunes = 0;              // rune count of the SELECTED recipe -> >4 = WIDE encounter (200u clear + +30s)
let exp2FightStartAt = 0;          // ts the FIGHTING phase began (hammer) -> min-clear duration for wide encounters
let exp2LootWaitAt = 0;            // ts we entered loot NOT-yet-loot-ready -> wait for the isTargetable flip (don't abandon the reward)
let exp2LootReadyAt = 0;           // ts loot-ready first read -> 2s settle + RE-VALIDATE still-finished before firing the open packet (user)
let exp2ClearAt = 0;               // ts we started clearing mobs to unlock the remnant (0 = not clearing)
let exp2NoMobsAt = 0;              // ts the post-hammer fight area went mob-free -> completion timer

function exp2Remnants(now) {
  const es = poe2.getEntities({ lightweight: true }) || [];   // lightweight has name/id/pos/isAlive/isTargetable -- the full read here was a per-frame lag bomb on big maps
  // A LIVE remnant ALWAYS has a nearby RuneEncounterController (present even when untouched); a SPENT / expired /
  // looted one does NOT -- the controller despawns (the same signal the FIGHTING phase uses for "encounter ended").
  // So REQUIRE a controller -> never chase a remnant that's already gone even though its entity still lingers
  // (objective COMPLETE + no controller = done; multi-remnant maps still work -- each LIVE one has its own controller).
  const ctrls = [];
  for (const e of es) if (/RuneEncounterController/i.test(e.name || '') && e.isAlive !== false) ctrls.push(e);
  // The remnant we're ALREADY driving (exp2CurId) is EXEMPT from the controller-proximity check: once committed,
  // the phase state + timeouts (15s awaitpick / 3min total / loot-done) govern completion. The 128-cap getEntities
  // can transiently DROP the controller on a busy map (the encounter floods the list with wave mobs) -> without this
  // exempt the remnant vanished ~3s after OPEN and the bot abandoned it mid-encounter (the '10s timeout' bug).
  // New / un-engaged remnants STILL require a live controller (so we never chase a spent/expired one).
  return es.filter(e => e && /Expedition2/i.test(e.name || '') && /Encounter|Remnant|Rune/i.test(e.name || '')
    && e.isAlive !== false && !((exp2Done.get(e.id) || 0) > now)
    && (e.id === exp2CurId || ctrls.some(c => Math.hypot((c.gridX || 0) - (e.gridX || 0), (c.gridY || 0) - (e.gridY || 0)) < 120)));
}
function exp2NearestRemnant(player, now) {
  let best = null, bd = Infinity;
  for (const r of exp2Remnants(now)) {
    const d = Math.hypot(r.gridX - player.gridX, r.gridY - player.gridY);
    if (d < bd) { bd = d; best = r; }
  }
  if (best) best._d = bd;
  return best;
}
function exp2FindRemnant(player, now) {
  // prefer the remnant we're already driving (sticky), else nearest
  const rems = exp2Remnants(now);
  if (!rems.length) return null;
  let t = exp2CurId ? rems.find(r => r.id === exp2CurId) : null;
  if (!t) { let bd = Infinity; for (const r of rems) { const d = Math.hypot(r.gridX - player.gridX, r.gridY - player.gridY); if (d < bd) { bd = d; t = r; } } }
  if (t) t._d = Math.hypot(t.gridX - player.gridX, t.gridY - player.gridY);
  return t;
}
// HARD SKIP: a REAL (Dannig) Expedition in the map. MUST exclude the Verisium/Expedition2 faction --
// its own entities legitimately contain the substring "Expedition": the remnant "Expedition2Encounter"
// AND the controller "Metadata/Monsters/LeagueExpeditionNew/RuneEncounterController". Matching those
// false-positived and SKIPPED every remnant (the "never stopped at verisium" bug). Real Expedition =
// "Expedition" but NOT Expedition2 / ExpeditionNew / Rune.
function exp2RegularExpeditionPresent(now) {
  const es = poe2.getEntities({ lightweight: true }) || [];
  for (const e of es) {
    const n = e.name || '';
    if (/Expedition/i.test(n) && !/Expedition2|ExpeditionNew|Rune/i.test(n)) return true;
  }
  return false;
}
function exp2ControllerNear(t) {
  const cs = poe2.getEntities({ lightweight: true }) || [];
  for (const c of cs) {
    if (/RuneEncounterController/i.test(c.name || '') &&
        Math.hypot((c.gridX || 0) - t.gridX, (c.gridY || 0) - t.gridY) < 220) return true;
  }
  return false;
}
// State is PHASE-DRIVEN (the bot tracks what IT did) -- the RuneEncounterController is present even when
// UNTOUCHED, so it CANNOT separate untouched from lootready (that was the misread bug). isTargetable is the
// transition signal: untouched=true -> (hammer) -> fighting=false -> (waves cleared) -> lootready=true -> (loot) -> done.
// exp2ControllerNear is used ONLY for the reload-mid-fight resume case.
function exp2HostilesNear(t, radius) {
  const ms = poe2.getEntities({ lightweight: true }) || [];
  let n = 0;
  for (const m of ms) {
    if (m.entityType === 'Monster' && m.isAlive && m.isHostile && m.isTargetable &&
        !/RuneEncounterController/i.test(m.name || '') &&
        Math.hypot((m.gridX || 0) - t.gridX, (m.gridY || 0) - t.gridY) < radius) n++;
  }
  return n;
}
// Nearest alive hostile near the remnant (for the pre-open mob-clear pursuit -> unlock the remnant).
function exp2NearestHostile(t, radius) {
  const ms = poe2.getEntities({ lightweight: true }) || [];
  let best = null, bd = Infinity;
  for (const m of ms) {
    if (m.entityType === 'Monster' && m.isAlive && m.isHostile && m.isTargetable &&
        !/RuneEncounterController/i.test(m.name || '')) {
      const d = Math.hypot((m.gridX || 0) - t.gridX, (m.gridY || 0) - t.gridY);
      if (d < radius && d < bd) { bd = d; best = m; }
    }
  }
  return best;
}
// 0301 01 + htonl(id) + handle(4) + action(1) + 00 00 00.  action 0x00=hammer/start, 0x01=loot.
function exp2Craft(remnant, action) {
  const id = remnant.id >>> 0, h = EXP2_HANDLE >>> 0;
  const pkt = new Uint8Array([
    0x03, 0x01, 0x01,
    (id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff,
    (h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff,
    action & 0xff, 0x00, 0x00, 0x00,
  ]);
  try { return poe2.sendPacket(pkt); } catch (e) { log('[Exp2] send fail ' + e); return false; }
}
function exp2Open(remnant) {
  try { interactWithEntity(remnant); } catch (_) {}                       // 01A3 ... press (opens panel)
  try { poe2.sendPacket(new Uint8Array([0x01, 0xAA, 0x01])); } catch (_) {} // 01AA release
}
// SIDE-STEP near the remnant to FLUSH the packet queue (user: the select/hammer don't "commit" while standing
// idle -- the game dispatches queued packets on a state-changing action). Oscillates L/R every 500ms so we stay
// next to the remnant instead of wandering off.
function exp2SideStep(player, t, now) {
  const dx = t.gridX - player.gridX, dy = t.gridY - player.gridY, L = Math.hypot(dx, dy) || 1;
  const px = -dy / L, py = dx / L;                            // unit perpendicular to the remnant direction
  const s = (Math.floor(now / 500) % 2) ? 1 : -1;            // flip every 500ms -> hover in place
  try { moveTowardGridPos(player.gridX, player.gridY, player.gridX + px * 14 * s, player.gridY + py * 14 * s); } catch (_) {}
}

// drive from runContentRotation; returns true while handling. PHASE-DRIVEN.
let exp2DriveFrame = -1, exp2DriveResult = false;
// Public driver -- BOTH the mapper rotation AND opener.js (standalone) call this. Once-per-frame guard: only the
// first caller per frame processes; the other gets the cached result (so the two never double-advance the state).
// NOTE: the clearVerisiumRemnants gate moved OUT to the callers (mapper gates via the rotation cand; opener gates
// via its own 'Verisium Runeshape Looter' toggle) so the opener can drive it even with the mapper setting off.
function runExpedition2(player, now) {
  const _f = (typeof POE2Cache !== 'undefined' && POE2Cache.getFrameNumber) ? POE2Cache.getFrameNumber() : now;
  if (_f === exp2DriveFrame) return exp2DriveResult;
  exp2DriveFrame = _f;
  exp2DriveResult = _runExpedition2(player, now);
  return exp2DriveResult;
}
function _runExpedition2(player, now) {
  if (!player) return false;
  if (exp2RegularExpeditionPresent(now)) return false;                    // HARD SKIP a real Expedition
  // Drive off LIVE remnants (per-remnant), NOT the whole-map Expedition2 objective: like incursion, a map can have
  // MULTIPLE remnants and the objective flips COMPLETE after the FIRST -- which then STRANDED the rest (LIVE-CONFIRMED
  // 2026-06-27: objective read complete while an OPENABLE remnant remained -> mapper ignored it + walked to boss).
  // exp2FindRemnant already gates on alive + not-in-exp2Done, so a truly spent / absent map yields no target -> stop.
  const t = exp2FindRemnant(player, now);
  if (!t) { if (exp2Phase !== 'idle') { exp2Phase = 'idle'; exp2CurId = 0; } return false; }
  if (exp2CurId !== t.id) { exp2CurId = t.id; exp2Phase = 'walk'; exp2StartAt = now; exp2ClearedAt = 0; exp2LootedAt = 0; exp2Candidates = null; exp2ClearAt = 0; exp2NoMobsAt = 0; exp2DispatchAt = 0; exp2SelSentAt = 0; exp2DecidedAt = 0; exp2SelRunes = 0; exp2FightStartAt = 0; exp2LootWaitAt = 0; exp2LootReadyAt = 0; }

  const tgt = !!t.isTargetable;
  const dist = Math.hypot(t.gridX - player.gridX, t.gridY - player.gridY);
  exp2CurDist = dist;

  if (now - exp2StartAt > EXP2_TOTAL_TIMEOUT) { exp2Done.set(t.id, now + 60000); log(`[Exp2] remnant ${t.id} timeout -> skip`); exp2Phase = 'idle'; exp2CurId = 0; return false; }

  // ---- WALK to it, CLEAR the surrounding mobs to UNLOCK it, then OPEN ----
  // Like incursion: the remnant is NOT targetable until the mobs around it are cleared (and isTargetable also
  // reads false at distance). So: walk up; if still not targetable up close, clear the nearby mobs until it
  // flips targetable, THEN open. Genuinely looted/done = no controller AND no mobs up close (after a grace).
  if (exp2Phase === 'walk' || exp2Phase === 'idle') {
    // Phase 1: walk to within 30u FIRST. exp2ClearAt only (re)starts while we have NOT reached yet -- once set it
    // PERSISTS, so the clear-pursuit stepping away below can't reset the 15s timer (that reset = the never-opens yo-yo).
    if (!exp2ClearAt) {
      if (dist > 30) { navTo(t.gridX, t.gridY, 'Verisium', now); statusMessage = `Verisium: -> remnant ${dist.toFixed(0)}u`; return true; }
      exp2ClearAt = now; log(`[Exp2] remnant ${t.id} reached (${dist.toFixed(0)}u) -> clear mobs (<=15s) then open`);
    }
    // Phase 2: clear nearby mobs for up to 15s OR until none within 60u (pursuit may step away; timer NOT reset).
    const nearMobs = exp2HostilesNear(t, 60);
    if (nearMobs > 0 && now - exp2ClearAt < 15000) {
      const m = exp2NearestHostile(t, 60);
      if (m) moveTowardGridPos(player.gridX, player.gridY, m.gridX, m.gridY);
      statusMessage = `Verisium: clearing ${nearMobs} mob(s) (${((now - exp2ClearAt) / 1000).toFixed(0)}/15s)`;
      return true;
    }
    // Phase 3: done clearing -> step BACK within 30u if we drifted, THEN open ONCE.
    if (dist > 30) { navTo(t.gridX, t.gridY, 'Verisium', now); statusMessage = `Verisium: -> open ${dist.toFixed(0)}u`; return true; }
    exp2Open(t); exp2Phase = 'awaitpick'; exp2LastAct = now; exp2Candidates = null; exp2ClearAt = 0;
    log(`[Exp2] remnant ${t.id} -> OPENED (${nearMobs === 0 ? 'area clear' : '15s timeout, ' + nearMobs + ' left'})`);
    return true;
  }

  // ---- AUTO-PICK (panel open; select-and-verify the best OFFERED recipe by reward priority, then hammer) ----
  // Catalog (non-offered) recipes are server-rejected no-ops, so we try the ranked pool top-down and the
  // first select that "takes" (getExpedition2Selected == candidate) is the best offered one -> hammer it.
  if (exp2Phase === 'awaitpick') {
    if (!tgt) { exp2Phase = 'fighting'; exp2ClearedAt = 0; exp2Candidates = null; if (!exp2FightStartAt) exp2FightStartAt = now; if (!exp2SelRunes) exp2SelRunes = 5; return true; }  // hammered manually -> take over (default WIDE + start the fight clock so the cap + wide-clear apply -- review B4 edge)
    // AFK SAFETY: NEVER stand at a remnant we can't activate -- that hung the run and got us KILLED. If we
    // haven't hammered within 15s, SKIP it so the bot keeps clearing/dodging instead of dying on it. (The real
    // activation is NOT the select+hammer here -- per the user it needs pick-rune -> MOVE packet -> activate
    // with the recipe LIST CLOSED; that opener sequence still needs RE'ing/packet-capture.)
    if (now - exp2LastAct > 15000) {
      exp2Done.set(t.id, now + 300000);
      log(`[Exp2] remnant ${t.id} not activated in 15s -> SKIP (no hang/die); opener needs RE`);
      exp2Phase = 'idle'; exp2CurId = 0; exp2Candidates = null; return false;
    }
    if (dist > EXP2_REACH * 1.5) navTo(t.gridX, t.gridY, 'Verisium', now);  // drifted off -> ease back (don't re-open)
    // ---- CRACKED FLOW (LIVE-PROVEN 2026-06-27): the ENTIRE chain works with the panel OPEN via packets -- NO close/ESC/
    // walk needed. open -> READ -> SELECT (00F9+01FD) -> brief dwell -> HAMMER (0301 act 00) -> FIGHT -> LOOT (0301 act 01).
    // (The early "no-op while open" was only the wrong id [controller vs Encounter] + missing 01FD; the right packet lands.)
    // STEP 1 -- READ + DECIDE: pick the best OFFERED recipe.
    if (!exp2Candidates) {
      if (typeof poe2.getUiRoot !== 'function' || typeof poe2.getExpedition2Recipes !== 'function') { statusMessage = `Verisium: UI/recipe binding unavailable (remnant ${t.id})`; return true; }
      const offered = exp2OfferedFromUI();
      if (!offered) { statusMessage = `Verisium: reading offers...`; return true; }
      const pickable = offered.filter(o => o.catalogIdx >= 0);
      if (!pickable.length) { statusMessage = `Verisium: ${offered.length} offer(s), none mapped`; return true; }
      // VALUE-PICK (re-enabled 2026-06-27 now the SELECT works + the list/index is correct via the rune-count cascade):
      // exp2Score returns -value for PRICED rewards, so the ASC sort puts highest-value FIRST; rune-count is the tiebreak.
      // Unpriced names return +10 -> sort LAST (below every priced reward); Verisium mats +100 = absolute last. So a known
      // reward ALWAYS beats an unpriced one -- "pick top-down, unpriced falls to the bottom" (user 2026-06-27). EXP2_VALUE
      // is poe2db.tw/Runeshape_Combinations-verified (Exalted units, Divine~9 Ex; Perfect Exalted 92 > Divine 9 confirmed).
      pickable.sort((a, b) => (exp2Score(a) - exp2Score(b)) || (b.runeCount - a.runeCount));
      exp2Candidates = pickable;
      exp2DecidedAt = now;                                    // pick timestamp
      const best = pickable[0];
      log(`[Exp2] remnant ${t.id} offered: ` + offered.map(o => `${o.uiName}${o.catalogIdx < 0 ? '(?)' : '#' + o.catalogIdx + '/v' + (-exp2Score(o)).toFixed(0)}`).join(' | ') + ` -> PICK BY VALUE: ${best.name} (idx ${best.catalogIdx}, v${(-exp2Score(best)).toFixed(0)})`);
      return true;
    }
    // STEP 2 -- SELECT (00F9 + 01FD 00 00, id = Expedition2Encounter). Works PANEL-OPEN -- LIVE-PROVEN, no close needed.
    if (!exp2SelSentAt) {
      const best = exp2Candidates[0];
      exp2Select(t, best.catalogIdx);
      exp2SelSentAt = now; exp2DispatchAt = now; exp2SelRunes = best.runeCount || 0;
      log(`[Exp2] remnant ${t.id} SELECT sent: ${best.name} (idx ${best.catalogIdx}, ${exp2SelRunes} runes)`);
      return true;
    }
    // STEP 3 -- brief dwell to let the select register, then HAMMER (0301 act 00, handle 87B20004). Also PANEL-OPEN.
    // The ~830-byte 02BA reply = waves spawning -> 'fighting'.
    if (exp2DispatchAt) {
      if (now - exp2DispatchAt < 500) { statusMessage = `Verisium: select sent -> hammering...`; return true; }   // 0.5s gap (user)
      exp2Craft(t, 0x00); exp2Phase = 'fighting'; exp2ClearedAt = 0; exp2Candidates = null; exp2DispatchAt = 0; exp2FightStartAt = now;
      log(`[Exp2] remnant ${t.id} HAMMERED (activate, panel-open, ${exp2SelRunes} runes)`);
      return true;
    }
    return true;
  }

  // ---- FIGHTING (waves up after hammer; clear them, recognise COMPLETION, then loot) ----
  if (exp2Phase === 'fighting') {
    if (tgt) { exp2Phase = 'loot'; exp2ClearedAt = now; exp2NoMobsAt = 0; return true; }   // remnant clickable = loot-ready
    // CLEAR the waves. The tgt flip above = the COMPLETE / ready-to-open state (isTargetable) -- the DEFINITIVE done signal
    // (user 2026-06-28: "that's THE complete-to-open"). Mob-free + a generous time CAP are only BACKSTOPS if it never flips
    // (NOT a floor). A WIDE recipe (runes>4) chases out to 200u and waits a longer mob-free window (waves spawn far + intermittently).
    const wide = exp2SelRunes > 4;
    const fightR = wide ? EXP2_WIDE_FIGHT_RADIUS : EXP2_FIGHT_RADIUS;
    const hostiles = exp2HostilesNear(t, fightR);
    if (!exp2ControllerNear(t)) { exp2Phase = 'loot'; exp2ClearedAt = now; exp2NoMobsAt = 0; log(`[Exp2] remnant ${t.id} encounter ended (controller gone) -> finish`); return true; }
    if (now - exp2FightStartAt > (wide ? 90000 : 60000)) { exp2Phase = 'loot'; exp2ClearedAt = now; exp2NoMobsAt = 0; log(`[Exp2] remnant ${t.id} fight CAP (${wide ? 90 : 60}s, never flipped complete) -> loot`); return true; }   // backstop CAP, not a floor
    if (hostiles === 0) {
      if (!exp2NoMobsAt) exp2NoMobsAt = now;
      if (now - exp2NoMobsAt > (wide ? 12000 : 5000)) { exp2Phase = 'loot'; exp2ClearedAt = now; exp2NoMobsAt = 0; log(`[Exp2] remnant ${t.id} waves cleared (mob-free ${wide ? '12s wide' : '5s'}) -> loot`); return true; }
    } else { exp2NoMobsAt = 0; }
    // PURSUE the nearest mob (out to fightR). When nothing's close: a WIDE recipe PATHFINDS back near the stone if we've
    // drifted past the normal radius (anchors the sweep, routes around walls); otherwise HOLD (no snap-back yoyo).
    const m = exp2NearestHostile(t, fightR);
    if (m) moveTowardGridPos(player.gridX, player.gridY, m.gridX, m.gridY);   // a mob's up -> go kill it
    else sendStopMovementLimited();   // USER: no mob after the hammer -> just HOLD + yield to pickit. The wide recenter (navTo) re-pathed every frame = the left/right yoyo. A fresh wave re-triggers the chase above, so no recenter is needed.
    statusMessage = `Verisium: clearing ${wide ? 'WIDE ' : ''}waves (remnant ${t.id}, ${hostiles} mobs)`;
    return true;
  }

  // ---- LOOT (waves cleared; click remnant to collect, then retire) ----
  if (exp2Phase === 'loot') {
    // LOOT-READY = the remnant flips isTargetable=true (the COMPLETE/open state). The FIGHTING phase can exit on the
    // mob-free FALLBACK *before* that flip, so tgt may be FALSE on entry -- do NOT mistake that for "already looted"
    // (the "I finished it but you ran away instead of opening it" bug). Only AFTER we've actually looted does !tgt = done.
    if (exp2LootedAt && !tgt) { exp2Done.set(t.id, now + 600000); log(`[Exp2] remnant ${t.id} looted -> done`); exp2Phase = 'idle'; exp2CurId = 0; return true; }
    if (!tgt) {
      // NOT loot-ready yet -> WAIT on the stone for the COMPLETE flip (auto-attack still clears any stragglers); 15s backstop.
      if (!exp2LootWaitAt) exp2LootWaitAt = now;
      if (now - exp2LootWaitAt > 15000) { exp2Done.set(t.id, now + 600000); log(`[Exp2] remnant ${t.id} loot never went ready (15s) -> give up`); exp2Phase = 'idle'; exp2CurId = 0; return true; }
      if (dist > EXP2_REACH) navTo(t.gridX, t.gridY, 'Verisium loot-wait', now); else sendStopMovementLimited();
      statusMessage = `Verisium: waiting to OPEN ${t.id} (${((now - exp2LootWaitAt) / 1000).toFixed(0)}s)`;
      return true;
    }
    // loot-ready (tgt true). USER 2026-06-28: give it 2s + RE-VALIDATE still-finished, THEN fire the open packet (in case
    // the flip was premature). If tgt drops during the 2s the !tgt branch above re-catches it. Walk up meanwhile.
    if (dist > EXP2_REACH) { navTo(t.gridX, t.gridY, 'Verisium loot', now); statusMessage = `Verisium: -> loot ${dist.toFixed(0)}u`; return true; }
    if (!exp2LootReadyAt) exp2LootReadyAt = now;
    if (now - exp2LootReadyAt < 2000) { statusMessage = `Verisium: loot-ready, settling ${((now - exp2LootReadyAt) / 1000).toFixed(1)}s ${t.id}`; return true; }
    if (!exp2LootedAt) { exp2Craft(t, 0x01); exp2LootedAt = now; log(`[Exp2] remnant ${t.id} -> loot click (re-validated 2s)`); }
    else if (now - exp2LootedAt > 7000) { exp2Done.set(t.id, now + 600000); log(`[Exp2] remnant ${t.id} loot done -> retire`); exp2Phase = 'idle'; exp2CurId = 0; return true; }
    statusMessage = `Verisium: looting ${t.id}`;
    return true;
  }

  return true;
}

// ============================================================================
// The Forgotten Prisoner (Pirasha) -- a CHAINED Unique boss released by interacting the 3 Runic Seals
// (BossChainAnchor). Detect by the boss RENDER name "...the Forgotten Prisoner" (the metadata name is
// "Balbala/BalbalaMAP" so name-matching misses it). Walk to each seal, interact 1-by-1 with a 2s gap;
// once all 3 are done the fight proceeds. No-op on every other map.
// ============================================================================
const FP_SEAL_REACH = 18;       // interact range for a Runic Seal (grid units)
const FP_SEAL_DELAY = 2000;     // 2s between seal interactions (user spec)
const fpSealsDone = new Set();  // seal ids already interacted (this arena)
let fpLastSealAt = 0;

function forgottenPrisonerPresent(now) {
  const es = poe2.getEntities({ lightweight: true }) || [];
  for (const e of es) {
    if (/forgotten\s*prisoner/i.test((e.renderName || '') + '|' + (e.name || ''))) return true;
  }
  return false;
}
function getRunicSeals(now) {
  const es = poe2.getEntities({ lightweight: false }) || [];
  return es.filter(e => e && /BossChainAnchor/i.test(e.name || '')
    && e.isTargetable !== false && !fpSealsDone.has(e.id));
}
// interact the Runic Seals one-by-one (2s apart) to release The Forgotten Prisoner. Returns true while handling.
function runRunicSeals(player, now) {
  if (!player) return false;   // always-on when the Forgotten Prisoner is in the map (no toggle)
  if (!forgottenPrisonerPresent(now)) { if (fpSealsDone.size) fpSealsDone.clear(); return false; }
  const seals = getRunicSeals(now);
  if (!seals.length) return false;                                        // all sealed-anchors done -> fight proceeds
  // walk to the NEAREST un-done seal
  let t = null, bd = Infinity;
  for (const s of seals) { const d = Math.hypot(s.gridX - player.gridX, s.gridY - player.gridY); if (d < bd) { bd = d; t = s; } }
  const dist = Math.hypot(t.gridX - player.gridX, t.gridY - player.gridY);
  if (dist > FP_SEAL_REACH) { navTo(t.gridX, t.gridY, 'Runic Seal', now); statusMessage = `Runic Seal: -> ${dist.toFixed(0)}u (${seals.length} left)`; return true; }
  // at the seal: enforce the 2s gap since the last interaction, then interact (reuse 01A3 interactWithEntity)
  if (now - fpLastSealAt < FP_SEAL_DELAY) { statusMessage = `Runic Seal: 2s gap ${((FP_SEAL_DELAY - (now - fpLastSealAt)) / 1000).toFixed(1)}s`; return true; }
  try { interactWithEntity(t); } catch (_) {}
  fpSealsDone.add(t.id); fpLastSealAt = now;
  log(`[ForgottenPrisoner] Runic Seal ${t.id} interacted (${seals.length - 1} left)`);
  statusMessage = `Runic Seal: activated (${seals.length - 1} left)`;
  return true;
}

let rotLockedType = null;   // CONTENT LOCK: the content type the rotation is currently sticking to (released when it leaves the cand list)
// ===============================================================================================================
// MAPPER REWORK (2026-06-28, mapper-rework-design workflow) -- P0 SCAFFOLD. New structures, NOT yet authoritative:
// a parity refactor (CONTENT_VALUE -> CONTENT_POLICY, identical values) + delirium turned off. The queue/arbiter
// are built behind the existing rotation until pickFrameGoal (P4) takes over. Review fixes folded in from the start.
// ===============================================================================================================
// Per-type policy (replaces the inline CONTENT_VALUE map). value = parity with the old map. delirium.enabled=false
// honours the user "skip delirium for now". vaalBeacon is DEFERRED on purpose (review: the only in-game "vaal beacon"
// is the incursion pedestal = dwell-activate, NOT an area-clear mechanic) -- not added as a type until disambiguated,
// so we never ship a doneSignal with no detector. breach.ttlMs is the HARD safety cap (review: 'closed' signal may be
// unreachable -> lock deadlock) -- filled in P5.
const CONTENT_POLICY = {
  verisium:           { value: 115, timeSensitive: true,  lockOnEngage: true,  doneSignal: 'looted' },
  breach:             { value: 105, timeSensitive: true,  lockOnEngage: true,  doneSignal: 'closed', engage: 'returnToCenter', ttlMs: 0 },
  'incursion-chest':  { value: 100, timeSensitive: false, lockOnEngage: true,  doneSignal: 'opened' },
  'incursion-beacon': { value: 100, timeSensitive: false, lockOnEngage: true,  doneSignal: 'activated' },
  abyss:              { value: 100, timeSensitive: false, lockOnEngage: true,  doneSignal: 'iconGray' },
  delirium:           { value: 80,  timeSensitive: true,  lockOnEngage: false, enabled: false },
};
// Persistent spotted-content QUEUE (P1 populates; P2 reads). key = `${type}:${id||roundGrid}`. Entity (Positioned) grid
// only -- never key off getQuestMarkers Render grid (review PRIMARY RISK: coordinate-system mixing).
const contentQueue = new Map();
// P2 REWORK gate. OFF (default) = today's per-frame singular-finder rotation, byte-parity. ON = queue-backed candidates
// via classifyObjective (STATUS x PROXIMITY x DIRECTION). User flips to live-test the rework. Flag-OFF, every new branch
// below falls through to the verbatim current code, so the bot always behaves exactly as today.
const REWORK_ARBITER = false;
// Gate constants -- single canonical tiers/budgets replacing the scattered 600/550/500 magic radii.
const NEAR_DIST = 150, MID_LIMIT = 500, DETOUR_BUDGET = 220, EXTENDED_DETOUR_BUDGET = 380;
// Perpendicular distance from P=(px,py) to the infinite line A=(ax,ay)->B=(bx,by). |(P-A) x (B-A)| / |B-A|.
function perpDistToLine(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay, L = Math.hypot(abx, aby);
  if (L < 1) return Math.hypot(px - ax, py - ay);
  return Math.abs((px - ax) * aby - (py - ay) * abx) / L;
}
// Detour cost of objective O off the player->boss route. null = no bearing OR O is BEHIND the player (negative
// projection = a backtrack, NOT a detour). Else the perpendicular distance. (review fix: pickUtilityDetour is a
// waypoint-finder, not perpendicular math -- this is the from-scratch primitive the DIRECTION leg needs.)
function routeDetourCost(px, py, ox, oy, bx, by) {
  const abx = bx - px, aby = by - py, L2 = abx * abx + aby * aby;
  if (L2 < 1) return null;
  const t = ((ox - px) * abx + (oy - py) * aby) / L2;   // projection param along player->boss
  if (t < -0.15 || t > 1.3) return null;                // behind us OR far PAST the boss -> not a cheap on-the-way detour
  return perpDistToLine(ox, oy, px, py, bx, by);
}
// Pure objective classifier (P2/P3 use it). STATUS x PROXIMITY x DIRECTION truth table. bossAnchor null -> DIRECTION
// degrades, decide on proximity + timeSensitivity only (review: no from-afar bearing most of FINDING_BOSS).
function classifyObjective(entry, player, bossAnchor) {
  const dist = Math.hypot((entry.gridX || 0) - player.gridX, (entry.gridY || 0) - player.gridY);
  const pol = CONTENT_POLICY[entry.type] || {};
  const timeSensitive = !!pol.timeSensitive;
  const tier = dist <= NEAR_DIST ? 'NEAR' : (dist < MID_LIMIT ? 'MID' : 'FAR');
  const detourCost = bossAnchor ? routeDetourCost(player.gridX, player.gridY, entry.gridX, entry.gridY, bossAnchor.x, bossAnchor.y) : null;
  let eligible;
  if (tier === 'NEAR') eligible = true;
  else if (tier === 'MID') eligible = timeSensitive ? true : (detourCost == null || detourCost <= DETOUR_BUDGET);
  else eligible = timeSensitive ? (detourCost != null && detourCost <= EXTENDED_DETOUR_BUDGET) : false;   // FAR
  const score = (pol.value || 60) - dist * 0.10 - (detourCost || 0) * 0.05;
  return { tier, timeSensitive, detourCost, eligible, score, dist };
}
// Multi-checker fused boss-bearing, sticky ~28s so a flickering arena object pins DIRECTION after it leaves stream
// range. Priority: radar > locked arena interior > arena-hint centroid > fog-blocked anchor (streamed-unique leg in P3).
// Returns {x,y,conf,src} or null. P0: defined; not yet driving the gate.
let bossBearingCache = null, bossBearingAt = -99999;
function resolveBossBearing(player, now) {
  let best = null;
  // TIER-A (FIND-layer): the two most reliable from-afar signals, previously NOT fused into the bearing.
  try { const c = getBossArenaCentroid(); if (c && Number.isFinite(c.gx)) best = { x: c.gx, y: c.gy, conf: 0.9, src: 'tgt-centroid' }; } catch (e) {}
  if (!best) { try { const m = getBossRoomMarker(); if (m && Number.isFinite(m.gx)) best = { x: m.gx, y: m.gy, conf: 0.85, src: 'bossroom-marker' }; } catch (e) {} }
  if (!best) try { const r = (typeof getRadarBossTarget === 'function') ? getRadarBossTarget() : null; if (r && Number.isFinite(r.x) && (Math.abs(r.x) > 1 || Math.abs(r.y) > 1)) best = { x: r.x, y: r.y, conf: 0.8, src: 'radar' }; } catch (e) {}
  if (!best && Number.isFinite(bossArenaCacheX)) best = { x: bossArenaCacheX, y: bossArenaCacheY, conf: 0.7, src: 'arena-locked' };
  // USER idea: no boss signal -> commit toward a known CONTENT landmark (Expedition2, etc.) so the conf>=0.7 structural
  // same-side reject drives the bot AT a real reachable destination + reveals the map en route, instead of ping-ponging
  // blind buckets. Nav bearing only; the content rotation handles it if we arrive. Any real boss tier above overrides it.
  if (!best) { try { const lm = getExploreLandmark(player); if (lm && Number.isFinite(lm.gx)) best = { x: lm.gx, y: lm.gy, conf: 0.7, src: 'explore-landmark' }; } catch (e) {} }
  if (!best) { try { const h = findBossArenaHint(player, now); if (h && Math.hypot(h.x, h.y) >= 80) best = { x: h.x, y: h.y, conf: 0.5, src: 'arena-hint' }; } catch (e) {} }
  if (!best && (Math.abs(fogBlockedAnchorX) > 1 || Math.abs(fogBlockedAnchorY) > 1)) best = { x: fogBlockedAnchorX, y: fogBlockedAnchorY, conf: 0.3, src: 'fog-anchor' };
  if (best) { bossBearingCache = best; bossBearingAt = now; return best; }
  if (bossBearingCache && now - bossBearingAt < 28000) return bossBearingCache;   // sticky hold
  return null;
}

// ===== P3 REWORK: engaged-lock (flag-gated). Replaces rotLockedType + the exp2Committed/rotBreachActivatedAt early-
// returns when REWORK_ARBITER is ON -- with a lock that RE-VALIDATES the locked item's done-signal EVERY frame + a HARD
// per-type ttl cap, so an unreachable locked breach/objective can NEVER deadlock the bot off the boss (review fix 1). =====
let frameLock = null;   // { type, id, engagedAt, ttlMs } or null. Nothing reads it while REWORK_ARBITER is false.
function lockTtlFor(type) {
  const p = CONTENT_POLICY[type] || {};
  if (type === 'breach')   return Math.max(p.ttlMs || 0, 90000);   // HARD cap: an unreachable closing-rare can't pin forever
  if (type === 'verisium') return 75000;
  if (type === 'abyss')    return 60000;
  return 45000;
}
// Per-frame done re-check -- ONLY id-keyed Maps + whole-map breach (no address read on a possibly-freed entity).
// Incursion is per-encounter (review fix 2: never the whole-map objective).
function lockIsDone(type, id, now) {
  try {
    if (type === 'verisium')         return (exp2Done.get(id) || 0) > now;
    if (type === 'incursion-chest')  return (incursionRecentlyDone.get(id) || 0) > now;
    if (type === 'incursion-beacon') return (incBeaconBlacklist.get(id) || 0) > now;
    if (type === 'abyss')            return (abyssBlacklist.get(id) || 0) > now;
    if (type === 'breach')           return mapObjectiveComplete('Breach', now);
  } catch (e) {}
  return false;
}
function lockEngage(type, id, now) {
  if (frameLock && frameLock.type === type && frameLock.id === (id || 0)) return;
  frameLock = { type, id: id || 0, engagedAt: now, ttlMs: lockTtlFor(type) };
  if (CONTENT_POLICY[type] && CONTENT_POLICY[type].lockOnEngage) log(`[Lock] engaged ${type} id=${id || 0} ttl=${(frameLock.ttlMs / 1000) | 0}s`);
}
// EVERY-FRAME validator (called from the arbiter): release the lock on its HARD ttl (deadlock-proof) OR the instant its
// done-signal fires. Returns whether a lock is still held.
function frameLockStillValid(now) {
  if (!frameLock) return false;
  if (now - frameLock.engagedAt > frameLock.ttlMs) { log(`[Lock] ${frameLock.type} ttl cap (${(frameLock.ttlMs / 1000) | 0}s) -> release`); frameLock = null; return false; }
  if (lockIsDone(frameLock.type, frameLock.id, now)) { log(`[Lock] ${frameLock.type} done -> release`); frameLock = null; return false; }
  return true;
}

// P2 REWORK: build the rotation's candidate list FROM contentQueue (state active) instead of the per-frame singular
// finders -- so flag-on-spot content (seen en-route, now out of stream) is selectable. Each entry is filtered by
// classifyObjective (the STATUS x PROXIMITY x DIRECTION gate; detourCost via routeDetourCost). RUNNERS are reused
// verbatim (the per-content sub-state machines are untouched; only WHICH content runs changes). A stale/freed entry
// whose runner can't re-find its live entity just returns false (no crash). Carries _cl so the scorer can use the
// classify score (value - dist*0.10 - detour*0.05) when the flag is on. Only reached when REWORK_ARBITER === true.
function buildQueueCands(player, now, bossAnchor) {
  const out = [];
  try {
    for (const e of contentQueue.values()) {
      if (e.state !== 'active') continue;
      const cl = classifyObjective(e, player, bossAnchor);
      if (!cl.eligible) continue;
      let run = null;
      switch (e.type) {
        case 'verisium':         run = () => runExpedition2(player, now); break;
        case 'abyss':            run = () => runAbyssRun(player, now); break;
        case 'incursion-chest':  run = () => runIncursionChestRun(player, now); break;
        case 'incursion-beacon': run = () => runIncursionBeaconRun(player, now); break;
        case 'breach': { const b = nearestBreachPoint(player, now); if (b) run = () => runWalkToBreach(player, now, b); break; }
      }
      if (!run) continue;   // breach with no live Brequel in stream -> not actionable this frame (P4 explore reaches it)
      out.push({ d: cl.dist, type: e.type, run, score: cl.score, _cl: cl, _id: e.id || 0 });
    }
  } catch (er) { return []; }
  return out;
}

function runContentRotation(player, now, skipRares = false) {
  if (!player) return false;
  if (!skipRares && currentSettings.clearRares !== false && runClearNearbyRares(player, now)) return true;
  // USER ORDER (current remnant -> breach -> rest): a Verisium remnant we've REACHED and are working (clearing /
  // opened / fighting / looting) is FINISHED before yielding to a touched breach -- never abandon a remnant mid-open.
  // exp2ClearAt>0 = reached (clearing / about-to-open); awaitpick|fighting|loot = opened. A remnant we're only
  // WALKING toward ('walk' && exp2ClearAt==0) stays BELOW the breach (re-engaged by the lower block after it).
  // B1 fix: these early-returns used to skip the rotLockedType assignment below, leaving a STALE lock that could
  // force a suboptimal pick when the breach/remnant finished. Set the lock to what we're actually handling.
  const exp2Committed = exp2Phase !== 'idle' && (exp2Phase !== 'walk' || exp2ClearAt > 0);
  if (exp2Committed && runExpedition2(player, now)) { rotLockedType = 'verisium'; if (REWORK_ARBITER) lockEngage('verisium', exp2CurId || 0, now); return true; }
  // an ACTIVE breach roams off the CACHED center (the Brequel despawns on activation) -- entity-independent
  if (rotBreachActivatedAt && runBreachRoam(player, now)) { rotLockedType = 'breach'; if (REWORK_ARBITER) lockEngage('breach', rotBreachId || 0, now); return true; }
  // a Verisium remnant we're still WALKING toward -- below the breach, so a live (time-limited) breach goes first;
  // after the breach this re-engages the remaining remnants so the PILE is finished, not abandoned.
  if (exp2Phase !== 'idle' && runExpedition2(player, now)) { rotLockedType = 'verisium'; if (REWORK_ARBITER) lockEngage('verisium', exp2CurId || 0, now); return true; }
  const cands = [];
  if (REWORK_ARBITER) {
    // P2 REWORK: candidates from the persistent spotted-content QUEUE, filtered by classifyObjective (STATUS x PROXIMITY
    // x DIRECTION). Flag-on-spot content (seen en-route, now out of stream) becomes selectable here.
    const bossAnchor = resolveBossBearing(player, now);
    for (const qc of buildQueueCands(player, now, bossAnchor)) cands.push(qc);
  } else {
    // ===== FLAG-OFF (default): verbatim current rotation -- byte-parity with before the rework =====
    // GATE on the base-game objective completion (the Map Content [x]) -- never re-attempt completed content.
    const brDone = mapObjectiveComplete('Breach', now), delDone = mapObjectiveComplete('Delirium', now), abyDone = mapObjectiveComplete('Abyss', now);
    // Incursion is NOT gated on the whole-map Incursion [x] -- that objective is a single 0/1 but a map can have
    // MULTIPLE encounters (2 pedestals etc). Drive off the PER-encounter minimap done-flag instead (getIncursionBeacons
    // / getUnopenedVaalChests already filter on minimapDoneOf), so a 2nd ACTIVE beacon isn't blocked by the 1st flipping
    // the objective done. When every encounter reads done those return empty -> the bot stops on its own.
    if (currentSettings.clearIncursion !== false)        { const c = nearestUnopenedChest(player, now); if (c) cands.push({ d: c._d, type: 'incursion-chest', run: () => runIncursionChestRun(player, now) }); }
    if (currentSettings.clearIncursion !== false)        { const vb = nearestIncursionBeacon(player, now); if (vb) cands.push({ d: vb._d, type: 'incursion-beacon', run: () => runIncursionBeaconRun(player, now) }); }
    if (currentSettings.deliriumMirrorEnabled !== false && CONTENT_POLICY.delirium.enabled !== false && !delDone) { const p = nearestDeliriumPiece(player);       if (p) cands.push({ d: p.d,  type: 'delirium', run: () => runDelirium(player, now, p) }); }
    if (currentSettings.clearBreach === true && !brDone)            { const b = nearestBreachPoint(player, now);    if (b) cands.push({ d: b._d, type: 'breach', run: () => runWalkToBreach(player, now, b) }); }
    if (currentSettings.clearAbyss !== false && !abyDone)           { const ab = nearestAbyssNode(player, now);      if (ab) cands.push({ d: ab._d, type: 'abyss', run: () => runAbyssRun(player, now) }); }
    // KEEP-ALIVE (audit fix -- HOISTED out of the !abyDone guard): when the LAST/only node clears AND the whole-map
    // Abyss[x] objective flips done in the SAME window, abyDone used to skip this branch -> runAbyssRun was never
    // re-dispatched -> the loot-dwell never fired + the reward chest was SKIPPED (the exact regression this prevents).
    // Keep dispatching runAbyssRun while a node is mid-loot-dwell (abyssId && abyssDwell), regardless of abyDone.
    if (currentSettings.clearAbyss !== false && abyssId && abyssDwell && !cands.some(c => c.type === 'abyss')) cands.push({ d: 0, type: 'abyss', run: () => runAbyssRun(player, now) });
    if (currentSettings.clearVerisiumRemnants !== false && !exp2RegularExpeditionPresent(now)) { const ex = exp2NearestRemnant(player, now); if (ex) cands.push({ d: ex._d, type: 'verisium', run: () => runExpedition2(player, now) }); }
  }
  if (!cands.length) { rotLockedType = null; return false; }
  // USER (2026-06-27): BALANCED value x distance, not strict-nearest. Objectives (breach/abyss/incursion/verisium) are
  // worth a long WALKABLE detour (~up to 550u) -- a slightly-farther high-value objective beats a near low-value one,
  // but a much-closer one still wins. LIGHT distance weight so we actually GO DO objectives. Verisium=time-limited->top.
  // P0 REWORK: scores read from CONTENT_POLICY (parity values); the inline CONTENT_VALUE map is retired.
  // Scoring: flag-off = parity (value - dist*0.10). Flag-on = the classifyObjective score (adds the DIRECTION/detour
  // term, -detour*0.05) computed in buildQueueCands; parity fallback for any cand without _cl.
  for (const c of cands) c.score = (REWORK_ARBITER && c._cl) ? c._cl.score : (((CONTENT_POLICY[c.type] && CONTENT_POLICY[c.type].value) || 60) - (c.d || 0) * 0.10);
  const near = cands.filter(c => (c.d || 0) <= 550);   // beyond this -> leave it until we explore closer (don't trek the whole map)
  const pool = near.length ? near : cands;             // but if EVERY objective is far, still take the best (don't stall)
  // Flag-on: TIME-SENSITIVE partition wins (a time-sensitive item is never preempted by a higher-VALUE non-time-sensitive
  // one). Flag-off: the plain value-per-distance sort, exactly as before.
  if (REWORK_ARBITER) pool.sort((a, b) => (((CONTENT_POLICY[b.type] || {}).timeSensitive ? 1 : 0) - ((CONTENT_POLICY[a.type] || {}).timeSensitive ? 1 : 0)) || (b.score - a.score));
  else pool.sort((a, b) => b.score - a.score);
  // CONTENT LOCK: once engaged in a type, STICK to it until it leaves the list (done). Flag-on = the re-validating
  // frameLock (real entry id, so it can be done-checked); flag-off = the legacy rotLockedType.
  let pick = null;
  if (REWORK_ARBITER && frameLock) pick = pool.find(c => c.type === frameLock.type);
  if (!pick) pick = rotLockedType ? pool.find(c => c.type === rotLockedType) : null;
  if (!pick) pick = pool[0];
  rotLockedType = pick.type;
  if (REWORK_ARBITER && CONTENT_POLICY[pick.type] && CONTENT_POLICY[pick.type].lockOnEngage && !frameLock) lockEngage(pick.type, pick._id || 0, now);
  return pick.run();
}

// P1 REWORK (shadow): populate the persistent spotted-content QUEUE from the existing plural finders. Upsert every hit
// (NO distance cap) so content seen en-route to the boss SURVIVES leaving the 128-entity stream window -- the user's
// flag-on-spot ("spot it, do it later if not too far"), impossible with the per-frame fresh-scan rotation. Entity
// (Positioned) grid only -- never key off getQuestMarkers Render grid (coordinate-system mixing risk). Done-marking
// uses ONLY id-keyed blacklist Maps + whole-map [x] (safe for out-of-stream entries; per-entity address reads would
// crash on freed entities -- P2 adds precise per-entity done on STREAMED entries). SHADOW: nothing reads contentQueue
// until P2 -- this is harmless data-keeping.
let _cqLastPopAt = 0, _cqLogAt = 0;
function populateContentQueue(player, now) {
  if (!player) return;
  if (now - _cqLastPopAt < 800) return;   // ~1.2Hz -- review: the finders have NO internal cache + 3 are FULL getEntities reads (lag bombs on ~21k-entity maps); content is static so a slow refresh is fine
  _cqLastPopAt = now;
  const seen = new Set();
  const upsert = (type, id, gx, gy, address) => {
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
    if (Math.abs(gx) < 40 && Math.abs(gy) < 40) return;   // origin-junk / player-fallback trap
    const key = `${type}:${id || (Math.round(gx / 12) + 'x' + Math.round(gy / 12))}`;
    seen.add(key);
    let e = contentQueue.get(key);
    if (!e) {
      contentQueue.set(key, { type, id: id || 0, gridX: gx, gridY: gy, address: address || 0, firstSeenAt: now, lastSeenAt: now, state: 'active', timeSensitive: !!(CONTENT_POLICY[type] && CONTENT_POLICY[type].timeSensitive), expireAt: 0, score: 0 });
    } else {
      e.gridX = gx; e.gridY = gy; e.lastSeenAt = now;
      if (address) e.address = address;
      if (e.state !== 'engaged') e.state = 'active';
    }
  };
  try { if (currentSettings.clearAbyss !== false)            for (const n of (getAbyssNodes(now) || []))        upsert('abyss', n.id, n.gridX, n.gridY, n.address); } catch (e) {}
  try { if (currentSettings.clearVerisiumRemnants !== false) for (const r of (exp2Remnants(now) || []))          upsert('verisium', r.id, r.gridX, r.gridY, r.address); } catch (e) {}
  try { if (currentSettings.clearIncursion !== false)        for (const c of (getUnopenedVaalChests(now) || [])) upsert('incursion-chest', c.id, c.gridX, c.gridY, c.address); } catch (e) {}
  try { if (currentSettings.clearIncursion !== false)        for (const b of (getIncursionBeacons(now) || []))   upsert('incursion-beacon', b.id, b.gridX, b.gridY, b.address); } catch (e) {}
  try { if (currentSettings.clearBreach === true) { const b = nearestBreachPoint(player, now); if (b) upsert('breach', b.id, b.gridX, b.gridY, b.address); } } catch (e) {}
  // DONE / prune pass. Refreshed-this-frame entries stay active. NOT-seen entries: mark done ONLY via id-keyed safe
  // signals (no address reads on possibly-freed entities); else PERSIST (the flag-on-spot point).
  for (const [key, e] of contentQueue) {
    if (seen.has(key)) continue;
    let done = false;
    try {
      if (e.type === 'verisium')              done = (exp2Done.get(e.id) || 0) > now;
      else if (e.type === 'incursion-chest')  done = (incursionRecentlyDone.get(e.id) || 0) > now;
      else if (e.type === 'incursion-beacon') done = (incBeaconBlacklist.get(e.id) || 0) > now;
      else if (e.type === 'abyss')            done = (abyssBlacklist.get(e.id) || 0) > now;   // per-NODE (parallels incursion); whole-map Abyss[x] would prune a still-active far node on multi-node maps
      else if (e.type === 'breach')           done = mapObjectiveComplete('Breach', now);     // singular finder / single-instance -> whole-map is fine (matches the rotation's !brDone gate)
    } catch (er) {}
    if (done) { contentQueue.delete(key); continue; }
    if (now - e.lastSeenAt > 600000) contentQueue.delete(key);   // 10min stale safety
  }
  if (now - _cqLogAt > 5000 && contentQueue.size) {
    const by = {}; for (const e of contentQueue.values()) by[e.type] = (by[e.type] || 0) + 1;
    log(`[Queue] ${contentQueue.size} spotted: ${Object.entries(by).map(([k, v]) => k + ':' + v).join(' ')}`);
    _cqLogAt = now;
  }
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

function getChangeToStanceInfo(entity, minRemaining = 0.12) {
  if (!entity) return null;
  const animNameRaw = `${entity.animationName || ''}`;
  if (!animNameRaw) return null;
  const animName = animNameRaw.toLowerCase();
  if (!animName.includes('changetostance')) return null;
  const remaining = getEntityActionRemainingSec(entity);
  if (!Number.isFinite(remaining) || remaining < minRemaining) return null;
  return { animationName: animNameRaw, remaining };
}

function getImmuneBossStancePreDodgeSignal(entity) {
  if (!entity) return null;
  const info = getChangeToStanceInfo(entity, 0.05);
  if (!info) return null;
  const animNameRaw = info.animationName;
  const animName = animNameRaw.toLowerCase();
  const remaining = info.remaining;

  const sig = `${entity.id || 0}:${animName}:${entity.currentActionId || 0}:${Math.round((entity.animationDuration || 0) * 100)}`;
  if (sig !== bossImmuneStanceLastSig || remaining > bossImmuneStanceLastRemaining + 0.35) {
    bossImmuneStanceLastSig = sig;
    bossImmuneStancePreDodgeDone = false;
  }
  bossImmuneStanceLastRemaining = remaining;

  // Trigger once in the very end of cast, not early.
  if (!bossImmuneStancePreDodgeDone && remaining <= 0.28 && remaining >= 0.05) {
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

// Post-patch dodge (re-captured 2026-06-21): a SINGLE 01 A3 skill-activate -- NO 00 63 move, and NOT the
// executeChanneledSkill wrapper (its 02 D0 channel packets are stale and DC the client). The bare 01 A3
// rolls cleanly; adding a 00 63 heading made it over-travel. buildDirectionalPacket = same proven builder
// our attacks use. dirGX/dirGY = grid-space roll direction (encoded into the 01 A3 deltas).
function sendDodgeRoll(dirGX, dirGY) {
  const mag = Math.hypot(dirGX, dirGY) || 1;
  const dx = Math.round((dirGX / mag) * 46);
  const dy = Math.round((dirGY / mag) * 46);
  try {
    poe2.sendPacket(buildDirectionalPacket([0x80, 0x00, 0x00, 0x40], dx, dy)); // 01 A3 activate DodgeRoll
    return true;
  } catch (e) { log(`[Dodge] sendDodgeRoll error: ${e}`); return false; }
}

function tryBossDodgeRollBehind(player, bossEntity, now) {
  if (!currentSettings.bossDodgeRollEnabled) return false;
  if (!bossEntity) return false;
  if (quickClearanceScore(player.gridX, player.gridY) <= 3) return false;
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
  if (quickClearanceScore(player.gridX, player.gridY) <= 3) return false;
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

function tryBossFirstContactDiagonalRoll(player, bossEntity, now) {
  if (!currentSettings.bossDodgeRollEnabled) return false;
  if (!bossEntity) return false;
  if (now - lastBossDodgeRollTime < 220) return false;

  const distToBoss = Math.hypot(player.gridX - bossEntity.gridX, player.gridY - bossEntity.gridY);
  if (!Number.isFinite(distToBoss) || distToBoss < 8 || distToBoss > 95) return false;

  // Build a diagonal-away vector from boss->player plus side tangent.
  const oxRaw = player.gridX - bossEntity.gridX;
  const oyRaw = player.gridY - bossEntity.gridY;
  const olen = Math.hypot(oxRaw, oyRaw);
  if (olen < 1e-3) return false;
  const ox = oxRaw / olen;
  const oy = oyRaw / olen;
  const tx = -oy;
  const ty = ox;

  const rollLen = Math.max(34, Math.min(64, currentSettings.bossDodgeRollDistance || 46));
  const sideOrder = bossOrbitDir >= 0 ? [1, -1] : [-1, 1];

  let best = null;
  let bestScore = -Infinity;
  for (const side of sideOrder) {
    // Favor diagonal, not straight back: side tangent contributes strongly.
    const blend = 0.92;
    const vxRaw = ox + side * tx * blend;
    const vyRaw = oy + side * ty * blend;
    const vlen = Math.hypot(vxRaw, vyRaw);
    if (vlen < 1e-3) continue;
    const vx = vxRaw / vlen;
    const vy = vyRaw / vlen;

    const candidateLens = [rollLen, rollLen - 8, rollLen + 8];
    for (const d of candidateLens) {
      const lx = player.gridX + vx * d;
      const ly = player.gridY + vy * d;
      if (!poe2.isWalkable(Math.floor(lx), Math.floor(ly))) continue;

      const clearance = quickClearanceScore(lx, ly);
      if (clearance < 3) continue;
      const landingBossDist = Math.hypot(lx - bossEntity.gridX, ly - bossEntity.gridY);
      if (landingBossDist < 34) continue; // avoid rolling into boss body

      const score =
        clearance * 10 +
        landingBossDist * 0.55 +
        (side === bossOrbitDir ? 8 : 0) -
        Math.abs(d - rollLen) * 0.18;
      if (score > bestScore) {
        bestScore = score;
        best = { x: lx, y: ly, sideSign: side };
      }
    }
  }

  if (!best) return false;

  const toX = best.x - player.gridX;
  const toY = best.y - player.gridY;
  const screenAngle = gridVectorToScreenAngleDeg(toX, toY);
  const deltas = angleToDeltas(screenAngle, Math.max(22, Math.min(110, Math.hypot(toX, toY))));
  if (!Number.isFinite(deltas.dx) || !Number.isFinite(deltas.dy)) return false;

  const dodgeRollPacketBytes = [128, 0, 0, 64];
  const ok = executeChanneledSkill(dodgeRollPacketBytes, deltas.dx, deltas.dy, 1);
  if (!ok) return false;

  lastBossEmergencyRollTime = now;
  lastBossDodgeRollTime = now;
  if (best.sideSign) bossOrbitDir = best.sideSign;
  bossDodgeLandingX = best.x;
  bossDodgeLandingY = best.y;
  bossDodgeLandingTime = now;
  dodgeMoveSuppressUntil = now + 520;
  lastMovePacketTime = now;
  lastStopPacketTime = now;
  return true;
}

function tryBossZekoaPanicRoll(player, bossEntity, now) {
  if (!currentSettings.bossDodgeRollEnabled) return false;
  if (!bossEntity) return false;
  if (now - lastBossZekoaPanicRollTime < 170) return false;

  let facingRad = getEntityFacingRad(bossEntity);
  if (facingRad === null) {
    facingRad = Math.atan2(player.gridY - bossEntity.gridY, player.gridX - bossEntity.gridX);
  }
  const behindRad = normalizeRad(facingRad + Math.PI);
  const sideSign = bossOrbitDir >= 0 ? 1 : -1;
  const sideOff = 44 * Math.PI / 180;
  const angles = [
    behindRad + sideSign * sideOff,
    behindRad - sideSign * sideOff,
    behindRad,
    behindRad + sideSign * (70 * Math.PI / 180),
    behindRad - sideSign * (70 * Math.PI / 180)
  ];
  const radii = [78, 68, 58];

  let best = null;
  let bestScore = -Infinity;
  for (const a of angles) {
    for (const r of radii) {
      const lx = bossEntity.gridX + Math.cos(a) * r;
      const ly = bossEntity.gridY + Math.sin(a) * r;
      if (!poe2.isWalkable(Math.floor(lx), Math.floor(ly))) continue;
      const clear = quickClearanceScore(lx, ly);
      if (clear < 3) continue;
      const travel = Math.hypot(lx - player.gridX, ly - player.gridY);
      const bossToPlayer = Math.hypot(player.gridX - bossEntity.gridX, player.gridY - bossEntity.gridY);
      const score = clear * 14 + Math.min(travel, 120) * 0.08 + bossToPlayer * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = { x: lx, y: ly };
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

  lastBossZekoaPanicRollTime = now;
  lastBossEmergencyRollTime = now;
  lastBossDodgeRollTime = now;
  bossDodgeLandingX = best.x;
  bossDodgeLandingY = best.y;
  bossDodgeLandingTime = now;
  dodgeMoveSuppressUntil = now + 560;
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
  const baseInterval = Math.max(120, currentSettings.fightEntityScanIntervalMs || 220);
  const adaptiveExtra =
    fightLastNearbyMonsterCount > 220 ? 180 :
      (fightLastNearbyMonsterCount > 140 ? 90 : 0);
  const interval = baseInterval + adaptiveExtra;
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
  fightLastNearbyMonsterCount = all.length;
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
// FRONTIER nav for unrevealed maps (LIVE-PROVEN 2026-06-23): isWalkable is FOG-GATED (X for unrevealed terrain)
// and findPathBFS only routes WITHIN the revealed/walkable area, so a far target across the dark is BFS-unreachable
// (bfs=0). Instead of steering straight at it (jams the unrevealed edge -> yoyo), find the farthest WALKABLE cell
// in a fan toward the target -- the revealed FRONTIER. Walking there reveals more terrain so BFS routes next leg.
function frontierTowardTarget(pgx, pgy, tx, ty) {
  // 360 fan: the boss can be walled off in its direction (spawn only opens AWAY from it), so we must follow the
  // longest OPEN corridor even if it leads away, with a boss-ward bonus as a tiebreak, and avoid revisits.
  const baseAng = Math.atan2(ty - pgy, tx - pgx);
  let bestA = 0, bestScore = -Infinity, bestReach = 0;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2, ux = Math.cos(a), uy = Math.sin(a);
    let lastW = 0;
    for (let d = 14; d <= 220; d += 14) {
      let w = false; try { w = poe2.isWalkable(Math.floor(pgx + ux * d), Math.floor(pgy + uy * d)); } catch (e) {}
      if (w) lastW = d; else break;   // first unwalkable cell = the revealed frontier on this ray
    }
    if (lastW < 28) continue;   // ignore tiny pockets -- want a real corridor to explore down
    const fx = pgx + ux * lastW, fy = pgy + uy * lastW;
    let score = lastW + Math.cos(a - baseAng) * 120;        // long open corridor + boss-ward tiebreak
    if (nearSoftBlock(fx, fy, SOFTBLOCK_R)) score -= 260;    // deprioritize recently-visited / dead-end frontiers
    if (score > bestScore) { bestScore = score; bestA = a; bestReach = lastW; }
  }
  if (bestScore === -Infinity) return null;
  // USER crawl idea (2026-06-28): score by FULL corridor reach (pick the best/through corridor), but TARGET only a SHORT
  // HOP down it -- NOT the 220u straight-line end. The far end needs a winding path that stalls ~70u short ("Stuck! re-route");
  // a short hop along a confirmed-walkable ray is directly reachable, and we re-cast from the new spot each cycle, so the bot
  // SNAKES the winding corridor in steps. ~35u >= the 28u min-corridor, well short of the far-end stall.
  const hop = Math.min(bestReach, 35);
  return { x: Math.round(pgx + Math.cos(bestA) * hop), y: Math.round(pgy + Math.sin(bestA) * hop) };
}

// MICRO-EXPLORE HEADING toward genuinely UNEXPLORED open map. getUnexploredBuckets() (C++, ONE full-grid pass) returns
// coarse {x,y,count} buckets where the fog-INDEPENDENT vertex grid HAS terrain but the fog-gated walkable grid has NOT
// revealed it yet -> the real unexplored bulk (where a far boss usually is). Pick the biggest, lightly distance-
// discounted, with a fog-blocked-anchor nudge. Throttled ~2s (the binding copies the grids). null -> caller falls back.
let _unexpAt = 0, _unexpCache = null, _unexpLogAt = 0;
let _unexpFailed = new Map();      // bucket key -> expiry: UNREACHABLE unexplored buckets we got stuck lunging at (the yoyo)
let _unexpTrackKey = null, _unexpTrackBestD = Infinity, _unexpTrackAt = 0;   // progress toward the CURRENT heading bucket
function pickUnexploredHeading(player, now) {
  if (typeof poe2.getUnexploredBuckets !== 'function') return null;   // pre-rebuild -> fall back to old heading
  if (now - _unexpAt < 2000) return _unexpCache;
  _unexpAt = now;
  let buckets = null;
  try { buckets = poe2.getUnexploredBuckets(8); } catch (_) { buckets = null; }
  if (!buckets || !buckets.length) { _unexpCache = null; return null; }
  const bkey = (b) => Math.round((b.x || 0) / 64) + ':' + Math.round((b.y || 0) / 64);
  // REACHABILITY toward a bucket (bearing-independent corridor follow): a bucket CENTER is fog-independent terrain that
  // is by-construction NOT yet revealed, so isWalkable(center) is ALWAYS false -- probing the center is the WRONG test
  // (it rejects every bucket). The RIGHT measure is how far a WALKABLE corridor extends FROM THE PLAYER TOWARD the
  // bucket's bearing (the fog-gated fine grid). We step out along that bearing until isWalkable fails: lastW = corridor
  // length we can actually start walking NOW. Cheap (<=12 probes), reuses the frontierTowardTarget ray idea.
  const reachToward = (bx, by) => {
    const ang = Math.atan2(by - player.gridY, bx - player.gridX), ux = Math.cos(ang), uy = Math.sin(ang);
    let lastW = 0;
    for (let dd = 14; dd <= 168; dd += 14) {
      let w = false; try { w = poe2.isWalkable(Math.floor(player.gridX + ux * dd), Math.floor(player.gridY + uy * dd)); } catch (e) {}
      if (w) lastW = dd; else break;
    }
    return lastW;   // 0 = cannot even step toward it now (walled/fog at the door); >=28 = a real corridor opens that way
  };
  // First pass: does ANY non-blacklisted bucket have a walkable approach? If yes we GATE on reachability (corridor
  // follow). If NO bucket is reachable (heavy fog / boxed lull), we must NOT freeze -> fall back to raw biggest-bucket
  // so the bot still picks SOMETHING and reveals (the deadlock floor). This keeps the old behavior as the safety net.
  let anyReachable = false;
  for (const b of buckets) {
    if (!b || (b.count || 0) <= 0) continue;
    const d = Math.hypot((b.x || 0) - player.gridX, (b.y || 0) - player.gridY);
    if (d < 60) continue;
    if ((_unexpFailed.get(bkey(b)) || 0) > now) continue;
    if (reachToward(b.x || 0, b.y || 0) >= 28) { anyReachable = true; break; }
  }
  const pickBest = () => {
    let best = null, bestScore = -Infinity;
    for (const b of buckets) {
      if (!b || (b.count || 0) <= 0) continue;
      const d = Math.hypot((b.x || 0) - player.gridX, (b.y || 0) - player.gridY);
      if (d < 60) continue;                                   // skip our own area (already revealing it)
      if ((_unexpFailed.get(bkey(b)) || 0) > now) continue;   // skip UNREACHABLE buckets we got stuck on (the yoyo fix)
      const reach = reachToward(b.x || 0, b.y || 0);          // corridor length we can walk NOW toward this bucket
      // REACHABILITY GATE (the corridor-follow fix, bearing-INDEPENDENT): when at least one bucket has a walkable
      // approach, HARD-SKIP the ones with none -- so the unreachable far/big bucket (e.g. (1359,116) w16=false) can
      // NEVER be picked over a reachable nearer one (e.g. (1963,116)). When NOTHING is reachable, anyReachable=false
      // and we do NOT gate -> raw count picks SOMETHING (no freeze). This is additive/orthogonal to the boss-bearing
      // terms below: with a confident bearing the opposite-side reject still fires; reach only further filters.
      if (anyReachable && reach < 28) continue;
      // Score: prefer NEARER reachable frontier (corridor follow) with count demoted to a tiebreak, and a strong bonus
      // for a LONG open corridor toward the bucket (ride the winding path). The -d term now dominates count so the bot
      // follows the local reachable corridor instead of lunging at the biggest distant expanse.
      let score = reach * 0.6 - d * 0.10 + (b.count || 0) * 0.15;
      if (now < fogBlockedAnchorUntil) {                      // a boss bearing is held -> bias the reveal toward it
        const toAnchor = Math.hypot((b.x || 0) - fogBlockedAnchorX, (b.y || 0) - fogBlockedAnchorY);
        if (fogBlockedAnchorConf >= 0.7) {
          // STRUCTURAL anti-yoyo: NEVER pick a bucket on the OPPOSITE side of a confident boss bearing -> the two-far-
          // opposite-buckets ping-pong is impossible BY CONSTRUCTION (not a weight tune). Among same-side buckets, a STRONG
          // toward-boss term so the boss-ward one beats raw count. If ALL buckets are opposite-side, pickBest returns null
          // and the explore falls to the fog-anchor DIRECTION (frontierTowardTarget) = head toward the boss anyway.
          if ((fogBlockedAnchorX - player.gridX) * ((b.x || 0) - player.gridX) + (fogBlockedAnchorY - player.gridY) * ((b.y || 0) - player.gridY) < 0) continue;
          score -= toAnchor * 0.03;                            // rescaled for the new (smaller) reach/dist score scale; same relative boss-ward pull
        } else {
          score -= toAnchor * 0.008;                           // a shaky (low-conf) bearing -> weak nudge only, never a hard reject
        }
      }
      if (score > bestScore) { bestScore = score; best = { x: b.x, y: b.y }; }
    }
    return best;
  };
  let best = pickBest();
  // PROGRESS GUARD (the "going nowhere" fix): if we're NOT getting closer to the chosen bucket over ~10s, it's walled off
  // from us -> blacklist it 60s and take the next REACHABLE bucket, so we explore where we CAN instead of lunging at a wall.
  if (best) {
    const key = bkey(best), d = Math.hypot(best.x - player.gridX, best.y - player.gridY);
    if (_unexpTrackKey !== key) { _unexpTrackKey = key; _unexpTrackBestD = d; _unexpTrackAt = now; }
    else if (d < _unexpTrackBestD - 45) { _unexpTrackBestD = d; _unexpTrackAt = now; }   // closing FOR REAL (45u) -> reset; slow wall-crawl (~1.5u/s) does NOT
    else if (now - _unexpTrackAt > 8000) {                                               // 8s without real progress -> unreachable, turn
      _unexpFailed.set(key, now + 180000);   // 3min: a WALLED bucket stays walled for the map -> stop re-lunging at it (the slow re-try loop)
      log(`[Explore] bucket (${best.x},${best.y}) unreachable -> blacklist 3min, exploring elsewhere`);
      _unexpTrackKey = null; _unexpTrackBestD = Infinity;
      best = pickBest();
      if (best) { _unexpTrackKey = bkey(best); _unexpTrackBestD = Math.hypot(best.x - player.gridX, best.y - player.gridY); _unexpTrackAt = now; }
    }
  }
  _unexpCache = best;
  if (best && now - _unexpLogAt > 4000) { log(`[Explore] unexplored heading -> (${best.x},${best.y}) of ${buckets.length} open bucket(s)`); _unexpLogAt = now; }
  return best;
}

// Macro-route cache for the far-target frontier heading (fog-INDEPENDENT vertex-grid route via the macroPathTo
// binding). Recomputed on staleness / target-move; cheap Dijkstra over the tiny tile grid.
let macroRouteCache = null;        // [{x,y}] fine-grid waypoints, or null
let macroRouteTargetX = NaN, macroRouteTargetY = NaN, macroRouteComputedAt = 0, macroRouteLogAt = 0;

// Lookahead point along the macro route toward (tx,ty), to BIAS the frontier-walk AROUND gaps the fog-gated fine
// pathfinders can't see (they dead-end at the dark edge -> the far-boss yoyo). Returns {x,y} ~160u ahead, or null.
function macroWaypointToward(pgx, pgy, tx, ty) {
  if (typeof poe2.macroPathTo !== 'function') return null;   // pre-rebuild
  const now = Date.now();
  const targetMoved = !Number.isFinite(macroRouteTargetX) || Math.hypot(tx - macroRouteTargetX, ty - macroRouteTargetY) > 60;
  if (!macroRouteCache || targetMoved || now - macroRouteComputedAt > 1500) {
    let route = null;
    try { route = poe2.macroPathTo(Math.floor(pgx), Math.floor(pgy), Math.floor(tx), Math.floor(ty)); } catch (e) { return null; }
    macroRouteCache = (route && route.length >= 2) ? route : null;
    macroRouteTargetX = tx; macroRouteTargetY = ty; macroRouteComputedAt = now;
    if (macroRouteCache && now - macroRouteLogAt > 2500) { log(`Macro route: ${macroRouteCache.length} wp around the fog toward (${Math.round(tx)},${Math.round(ty)})`); macroRouteLogAt = now; }
  }
  if (!macroRouteCache) return null;
  // nearest route point to the player, then step forward to ~160u out (a STABLE far heading the frontier can ride).
  let nearIdx = 0, nearD = Infinity;
  for (let i = 0; i < macroRouteCache.length; i++) {
    const d = Math.hypot(macroRouteCache[i].x - pgx, macroRouteCache[i].y - pgy);
    if (d < nearD) { nearD = d; nearIdx = i; }
  }
  for (let i = nearIdx; i < macroRouteCache.length; i++) {
    if (Math.hypot(macroRouteCache[i].x - pgx, macroRouteCache[i].y - pgy) >= 160) return macroRouteCache[i];
  }
  return macroRouteCache[macroRouteCache.length - 1];   // route end (near the target) if shorter than 160u
}

function stepPathWalker() {
  const now = Date.now();
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) return 'no_path';

  const pgx = player.gridX;
  const pgy = player.gridY;

  // No real target yet (e.g. just entered FINDING_BOSS before the first explore pick) -> don't walk
  // toward (0,0) / the origin. Wait for a target.
  if (!Number.isFinite(targetGridX) || !Number.isFinite(targetGridY) || (targetGridX === 0 && targetGridY === 0)) return 'no_path';

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

    if (stuckCount > 2) {
      log('Stuck on target -> abandoning + re-picking a different one');
      currentPath = [];
      return 'stuck';
    }

    // Re-route once; if a path exists, FALL THROUGH so the move-block feel-around can work the obstacle
    // (random angle-moves did nothing and just preempted the feel-around at gates). If no path, abandon.
    let rerouted = false;
    try {
      const bfsPath = poe2.findPathBFS(Math.floor(pgx), Math.floor(pgy), Math.floor(targetGridX), Math.floor(targetGridY));
      if (bfsPath && bfsPath.length > 0) {
        currentPath = bfsPath;
        currentWaypointIndex = 0;
        pathComputeCount++;
        lastRepathTime = now;
        rerouted = true;
        log(`Stuck! re-route ${bfsPath.length} wp -> feeling for a way through`);
      }
    } catch (e) { /* BFS unavailable */ }

    if (!rerouted) {
      currentPath = [];
      return 'stuck';   // genuinely no path -> abandon, don't flail with random moves
    }
    // rerouted: do NOT return -> fall through to the feel-around in the move block
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
    // computePath tries the radar's WORKING pathfinder, then the dead findPathBFS. If nothing, DON'T abandon
    // here -- fall through to the steer-toward-target block below (the floor nav now that findPathBFS is dead).
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

    // Move toward a LOOK-AHEAD point (rate-limited). Aiming at the immediate ~8u waypoint gives a twitchy
    // heading the player can't translate along; aim at the farthest waypoint we have clear line-of-sight to
    // (~60u) for a STABLE heading the dither can ride down the corridor.
    if (now - lastMoveTime >= currentSettings.moveIntervalMs) {
      // Aim at the FARTHEST waypoint we have a clear WALKABLE straight line to (<=~70u) -- scan far->near,
      // take the first visible one. Stable far heading in open corridors; NEVER aims through a wall at a
      // bend (blind 45u-ahead drove into walls, d=(-39,-39) frozen = the jam + constant re-pick "running
      // around"). Cheap: stops at the first hit (one check in an open corridor).
      let aimIdx = currentWaypointIndex;
      for (let i = Math.min(currentPath.length - 1, currentWaypointIndex + 80); i >= currentWaypointIndex; i--) {
        const w = currentPath[i];
        if (Math.hypot(pgx - w.x, pgy - w.y) > 70) continue;
        if (lineWalkable(pgx, pgy, w.x, w.y) && !nearSoftBlock((pgx + w.x) / 2, (pgy + w.y) / 2, SOFTBLOCK_R)) { aimIdx = i; break; }
      }
      const wp = currentPath[aimIdx];
      // Progress is measured to the AIM WAYPOINT, not the final target -- a winding path takes us
      // temporarily AWAY from the straight-line target (around a wall), which used to false-fire "no
      // progress" mid-corridor and trigger a bogus feel-around.
      const distT = Math.hypot(pgx - wp.x, pgy - wp.y);
      if (distT < freezeBestDist - 4) { freezeBestDist = distT; freezeBestTime = now; feelMode = false; }
      else if (freezeBestTime === 0) { freezeBestDist = distT; freezeBestTime = now; }
      const noProg = freezeBestTime > 0 ? now - freezeBestTime : 0;
      if (noProg > 3500) {
        addSoftBlock(pgx, pgy);                                // blacklist the wedge spot itself
        abandonedBossTargets.push({ x: targetGridX, y: targetGridY });
        currentPath = []; freezeBestDist = Infinity; freezeBestTime = 0; feelMode = false;
        return 'stuck';
      }
      let aimX = wp.x, aimY = wp.y;
      if (noProg > 900) {
        // WEDGED on an invisible obstacle. Wall-follow TOWARD the goal: among the 4 sendable grid-diagonal
        // headings, pick the one whose component is most toward the aim WAYPOINT, EXCLUDING the one that
        // points straight back -- so we never commit to walking away (that was the UP ping-pong). Exit only
        // when we got net-closer to the waypoint. Hysteresis keeps us skirting one consistent way.
        const CARD = [[12, 12], [-12, -12], [12, -12], [-12, 12]]; // UP / DOWN / RIGHT / LEFT (grid deltas)
        if (!feelMode) {
          feelMode = true; feelTrialStart = now; feelTrialX = pgx; feelTrialY = pgy;
          feelOriginX = pgx; feelOriginY = pgy;
          freezeBestDist = distT;                  // baseline = wp-distance at wedge start
          addSoftBlock(pgx, pgy);                  // remember the contact point
          feelDir = -1; feelBlocked = [0, 0, 0, 0];   // force a fresh pick below
        }
        // Exit when we got closer to the wp, OR once we've moved ~30u off the wedge spot (escaped). The
        // soft-block dropped at wedge-start keeps the re-path from routing straight back in, so backing out
        // then re-pathing AROUND the obstacle replaces the old "keep reversing forever".
        if (distT < freezeBestDist - 12 || Math.hypot(pgx - feelOriginX, pgy - feelOriginY) > 30) {
          feelMode = false; freezeBestTime = now; freezeBestDist = distT;   // resume normal pathing
        } else {
          const movedTrial = Math.hypot(pgx - feelTrialX, pgy - feelTrialY);
          const stalled = (now - feelTrialStart > 200 && movedTrial < 8);
          if (feelDir >= 0 && stalled) feelBlocked[feelDir] = now;   // this heading physically didn't move
          // Re-pick the sidestep direction ONLY when the current one physically STALLS (not on a timer):
          // commit to one side and follow the wall, instead of flip-flopping as the goal angle shifts
          // (that side-switching was the ~50u oscillation / "running backwards").
          if (feelDir < 0 || stalled) {
            const gdx = wp.x - pgx, gdy = wp.y - pgy, gl = Math.hypot(gdx, gdy) || 1;
            const ux = gdx / gl, uy = gdy / gl;          // unit heading to the aim waypoint
            let bestI = -1, bestScore = -Infinity;
            for (let k = 0; k < 4; k++) {
              const dx = CARD[k][0], dy = CARD[k][1], dl = Math.hypot(dx, dy);
              const prog = (dx * ux + dy * uy) / dl;      // -1 (away) .. +1 (toward wp)
              let score = prog;                           // PREFER goalward, but do NOT hard-exclude the
              if (now - feelBlocked[k] < 1500) score -= 3; //   away dir -- we must be able to BACK OUT of a
              if (nearSoftBlock(pgx + dx * 2.2, pgy + dy * 2.2, SOFTBLOCK_R)) score -= 1.5; // dead-end pocket.
              if (k === feelDir) score += 0.6;            // STRONG hysteresis: keep the same side; -3 = avoid a stall
              if (score > bestScore) { bestScore = score; bestI = k; }
            }
            feelDir = bestI < 0 ? 0 : bestI;
            feelTrialStart = now; feelTrialX = pgx; feelTrialY = pgy;
            // EVERY cardinal (incl. backward) just stalled -> genuinely boxed in -> abandon + remember it
            if (bestScore < -2 && Math.hypot(pgx - feelOriginX, pgy - feelOriginY) > 25) {
              addSoftBlock(targetGridX, targetGridY);
              feelMode = false; return 'stuck';
            }
          }
          aimX = pgx + CARD[feelDir][0]; aimY = pgy + CARD[feelDir][1];
        }
      }
      moveTowardGridPos(pgx, pgy, aimX, aimY);
      lastMoveTime = now;
    }
  } else {
    // No fine path (radar/jsBFS/terrain/findPathBFS all dead -- e.g. a FAR target across the fog). moveTowardGridPos
    // STEERS around walls (isWalkable probe). For a FAR target, bias the frontier-walk along the fog-INDEPENDENT
    // MACRO route (vertex-grid Dijkstra via macroPathTo) so we head AROUND the gap instead of jamming straight at
    // the target (the yoyo). Track no-progress against the STEER point (the macro lookahead when active), NOT the
    // straight-line target -- routing around a gap temporarily increases straight-line distance and would else
    // false-fire the abandon. Abandon only on NO progress to the steer point for ~4s (genuinely boxed in).
    let steerTx = targetGridX, steerTy = targetGridY;
    if (Math.hypot(pgx - targetGridX, pgy - targetGridY) > 150) {
      const mw = macroWaypointToward(pgx, pgy, targetGridX, targetGridY);
      if (mw) { steerTx = mw.x; steerTy = mw.y; }
    }
    if (!(Math.abs(steerTgtX - steerTx) < 18 && Math.abs(steerTgtY - steerTy) < 18)) {
      steerTgtX = steerTx; steerTgtY = steerTy; steerBestDist = Infinity; steerBestTime = 0;
    }
    const distT = Math.hypot(pgx - steerTx, pgy - steerTy);
    if (distT < steerBestDist - 4) { steerBestDist = distT; steerBestTime = now; }
    else if (steerBestTime === 0) { steerBestDist = distT; steerBestTime = now; }
    if (steerBestTime > 0 && now - steerBestTime > 4000) {
      addSoftBlock(pgx, pgy);
      abandonedBossTargets.push({ x: targetGridX, y: targetGridY });
      steerBestDist = Infinity; steerBestTime = 0;
      return 'stuck';
    }
    if (now - lastMoveTime >= currentSettings.moveIntervalMs) {
      // FRONTIER-WALK toward the steer point (macro lookahead for far targets, else straight-line): walk to the
      // farthest WALKABLE cell toward it, revealing terrain so the fine pathfinder can route the next leg.
      const fr = frontierTowardTarget(pgx, pgy, steerTx, steerTy);
      if (fr) moveTowardGridPos(pgx, pgy, fr.x, fr.y);
      else moveTowardGridPos(pgx, pgy, steerTx, steerTy);
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
  // ANTI-FREEZE: re-issuing the SAME target (even with no path) must NOT reset the stuck/progress clock -- else a
  // fog-sealed far target re-issued every tick resets its own watchdog forever and never escalates (the (1093,161)
  // freeze). Only a genuinely NEW target (beyond the <8u hysteresis above) restarts it.
  if (!sameTarget) {
    lastPositionChangeTime = now;
    stuckCount = 0;
  }

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
  if (entity.isFriendly) return false;        // same team as you: allied NPCs + your own minions/pets
  if (entity.entitySubtype === 'MonsterFriendly') return false;
  if (entity.isHiddenMonster) return false;
  if (entity.cannotBeDamaged) return false;
  if (entity.hiddenFromPlayer) return false;
  if (entity.hasGroundEffect) return false;
  return true;
}

function collapseBossProxyEntities(entities) {
  if (!entities || entities.length <= 1) return entities || [];
  const groups = new Map();
  const cell = 16;
  const hpNorm = (v) => (Number.isFinite(v) ? Math.max(0, Math.floor(v / 3000)) : 0);
  const normName = (e) => `${e?.renderName || e?.name || ''}`.split('/').pop().toLowerCase().trim();

  for (const e of entities) {
    if (!e) continue;
    const gx = Number.isFinite(e.gridX) ? Math.floor(e.gridX / cell) : 0;
    const gy = Number.isFinite(e.gridY) ? Math.floor(e.gridY / cell) : 0;
    const key = `${normName(e)}:${gx}:${gy}:${hpNorm(e.healthMax)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const out = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    let best = g[0];
    let bestScore = -Infinity;
    for (const e of g) {
      let score = 0;
      if (e.isTargetable) score += 2000;
      if (!e.cannotBeDamaged) score += 800;
      score += Math.max(0, Number(e.healthCurrent || 0)) * 0.001;
      score += Math.max(0, Number(e.healthMax || 0)) * 0.0002;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    out.push(best);
  }
  return out;
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
function countHostilesNear(entities, gx, gy, radius, maxChecks = Infinity) {
  let count = 0;
  const radiusSq = radius * radius;
  let checked = 0;

  for (const entity of entities) {
    if (!isHostileAlive(entity)) continue;
    if (entity.entityType !== 'Monster') continue;
    if (!entity.gridX) continue;
    checked++;
    if (checked > maxChecks) break;

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
  const exp = ignoredUtilityTargets.get(key);   // B7/B8: Map (key -> expiry) so a timed-out target gets RETRIED, not abandoned forever
  if (exp == null) return false;
  if (exp <= Date.now()) { ignoredUtilityTargets.delete(key); return false; }
  return true;
}

function addIgnoredUtilityTarget(candidate, reason, ttlMs) {
  const key = getUtilityTargetKey(candidate);
  if (!key) return;
  const existed = (ignoredUtilityTargets.get(key) || 0) > Date.now();
  ignoredUtilityTargets.set(key, Date.now() + (ttlMs || 600000));   // default 10min; a NOT-serviced timeout passes a short ttl
  utilityStats.blacklistedCount = ignoredUtilityTargets.size;
  if (!existed) { const name = candidate?.meta?.name || candidate?.type || 'target'; logUtility(`Utility blacklist add (${reason}): ${name}`, `utility:blacklist:${key}`, 1200); }
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

// OBJECTIVE-OVER-UTILITY guard (user 2026-06-28): is a LIVE (non-blacklisted) content objective within reach? Stops the
// bot detouring to an openable CHEST while an abyss/verisium is right there ("skipped abyss to go open a chest" bug).
// 1s-cached so it's not a per-frame entity scan. Abyss + Verisium for now (the cases hit); breach/incursion can be added.
let _liveObjCache = { at: 0, px: 0, py: 0, result: null };
function hasLiveObjectiveNear(player, radius) {
  if (!player) return null;
  const now = Date.now();
  const px = Math.round(player.gridX / 25), py = Math.round(player.gridY / 25);   // B2 fix: re-scan if we moved a ~25u bucket
  if (now - _liveObjCache.at < 400 && _liveObjCache.px === px && _liveObjCache.py === py) return _liveObjCache.result;
  const r = radius || 600;
  let res = null;
  try { const a = getAbyssNodes(now) || []; for (const n of a) { if (((abyssBlacklist.get(n.id) || 0) <= now) && Math.hypot((n.gridX || 0) - player.gridX, (n.gridY || 0) - player.gridY) <= r) { res = 'abyss'; break; } } } catch (_) {}
  if (!res) { try { const v = exp2Remnants(now) || []; for (const n of v) { if (Math.hypot((n.gridX || 0) - player.gridX, (n.gridY || 0) - player.gridY) <= r) { res = 'verisium'; break; } } } catch (_) {} }
  _liveObjCache = { at: now, px, py, result: res };
  return res;
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

function gatherUtilityCandidates(player) {
  const openables = getOpenableUtilityCandidates(player);
  const loot = getLootUtilityCandidates(player);
  const all = [...openables, ...loot];
  utilityStats.openableCandidates = openables.length;
  utilityStats.lootCandidates = loot.length;
  utilityStats.totalCandidates = all.length;
  utilityStats.blacklistedCount = ignoredUtilityTargets.size;
  return all;
}

// Precursor (Tower) Beacon -- a RARE interactable structure (Maps/TowerBeacon, e.g. "PrecursorBeaconNorth") you
// activate after clearing the tower. Found by name/path (the "...Cosmetic" twin is skipped; only the targetable
// one counts). Activated in the MAP_COMPLETE phase AFTER loot, before portalling. getAllEntities scan is throttled
// (this phase is rare + brief, so the uncapped read is fine here).
// getAllEntities is UNCAPPED -> it also returns beacons in ADJACENT zones; only activate one actually IN this map.
// A 2465u "beacon" is cross-map -- navTo'ing it BLOCKED the portal forever (user: "if it's there click, if not skip").
const PRECURSOR_BEACON_MAX_DIST = 250;   // grid units; farther than this -> treat as absent -> go to portal (500 was a big post-map detour)
let precursorBeaconActivatedThisMap = false, precursorBeaconScanAt = 0, precursorBeaconCache = null, precursorBeaconInteractAt = 0;
function findPrecursorBeacon(player, now) {
  if (now - precursorBeaconScanAt < 800) return precursorBeaconCache;
  precursorBeaconScanAt = now; precursorBeaconCache = null;
  try {
    let best = null, bd = Infinity;
    for (const e of (poe2.getAllEntities() || [])) {
      const nm = e.name || '';
      if (!/PrecursorBeacon|TowerBeacon/i.test(nm + ' ' + (e.baseEntityPath || ''))) continue;
      if (/Cosmetic/i.test(nm)) continue;                    // skip the non-interactable cosmetic twin
      if (e.isTargetable === false) continue;                 // only the activatable beacon
      const d = Math.hypot((e.gridX || 0) - player.gridX, (e.gridY || 0) - player.gridY);
      if (d < bd) { bd = d; best = e; }
    }
    if (best) best._d = bd;
    precursorBeaconCache = best;
  } catch (e) {}
  return precursorBeaconCache;
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

function getTempleObjectiveRequirement() {
  const objectives = poe2.getMapObjectives();
  if (!objectives) return 'unknown';

  const mainText = `${objectives.mainObjective?.text || ''}`.toLowerCase();
  const subText = (objectives.subObjectives || [])
    .map(s => `${s?.name || ''} ${s?.objective || ''}`.toLowerCase())
    .join(' ');
  const combined = `${mainText} ${subText}`.trim();
  if (!combined) return 'unknown';

  // Temple phase is optional in many maps. Only force temple routing when
  // objective text explicitly signals an incursion/beacon/temple step.
  if (
    combined.includes('incursion') ||
    combined.includes('beacon') ||
    combined.includes('temple') ||
    combined.includes('vaal')
  ) {
    return 'required';
  }
  return 'optional';
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

function getMainDefeatObjectiveInfo() {
  const objectives = poe2.getMapObjectives();
  if (!objectives || !objectives.mainObjective) {
    return { hasDefeatObjective: false, isCompleted: false, bossName: '', tokens: [] };
  }
  const main = objectives.mainObjective;
  const text = `${main.text || ''}`;
  const lower = text.toLowerCase();
  const m = lower.match(/\bdefeat\s+(.+)/);
  if (!m) {
    return { hasDefeatObjective: false, isCompleted: !!main.isCompleted, bossName: '', tokens: [] };
  }
  let bossName = `${m[1] || ''}`;
  bossName = bossName.replace(/\(.*?\)/g, ' ');
  bossName = bossName.replace(/[^a-z0-9,'\- ]+/g, ' ').trim();
  const tokens = bossName
    .split(/[\s,]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 4 && t !== 'defeat');
  return {
    hasDefeatObjective: true,
    isCompleted: !!main.isCompleted,
    bossName,
    tokens
  };
}

function isEntityLikelyMainObjectiveBoss(entity) {
  if (!entity) return false;
  const obj = getMainDefeatObjectiveInfo();
  if (!obj.hasDefeatObjective) return true;
  const entityName = `${entity.renderName || entity.name || ''}`
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9,'\- ]+/g, ' ')
    .trim();
  if (!entityName) return false;
  if (obj.bossName && (entityName.includes(obj.bossName) || obj.bossName.includes(entityName))) {
    return true;
  }
  if (!obj.tokens || obj.tokens.length === 0) return false;
  let hits = 0;
  for (const t of obj.tokens) {
    if (entityName.includes(t)) hits++;
  }
  const needHits = obj.tokens.length >= 3 ? 2 : 1;
  return hits >= needHits;
}

function isZekoaObjectiveActive() {
  const obj = getMainDefeatObjectiveInfo();
  if (!obj || !obj.hasDefeatObjective || obj.isCompleted) return false;
  const text = `${obj.bossName || ''} ${(obj.tokens || []).join(' ')}`.toLowerCase();
  return text.includes('zekoa') || text.includes('headcrusher');
}

function isZekoaBossEntity(entity) {
  if (!entity) return false;
  const n = `${entity.renderName || entity.name || ''}`.toLowerCase();
  return n.includes('zekoa') || n.includes('headcrusher');
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

function pickTempleExploreRareTarget(playerGX, playerGY, forwardX, forwardY) {
  const now = Date.now();
  if (templeRareExploreCache && (now - templeRareExploreCacheAt) < 260) {
    return templeRareExploreCache;
  }
  const rares = POE2Cache.getEntities({
    type: 'Monster',
    subtype: 'MonsterRare',
    aliveOnly: true,
    lightweight: true,
    maxDistance: 300
  }) || [];
  if (rares.length === 0) {
    templeRareExploreCache = null;
    templeRareExploreCacheAt = now;
    return null;
  }

  const fLen = Math.hypot(forwardX, forwardY);
  const fx = fLen > 0.01 ? forwardX / fLen : 0;
  const fy = fLen > 0.01 ? forwardY / fLen : 0;

  let best = null;
  let bestScore = -Infinity;
  for (const e of rares) {
    if (!isHostileAlive(e)) continue;
    if (!e.isTargetable) continue;
    if (!Number.isFinite(e.gridX) || !Number.isFinite(e.gridY)) continue;
    if (isAbandonedTarget(e.gridX, e.gridY)) continue;

    const dx = e.gridX - playerGX;
    const dy = e.gridY - playerGY;
    const dist = Math.hypot(dx, dy);
    if (dist < 12 || dist > 300) continue;

    const dirScore = (fx === 0 && fy === 0) ? 0 : ((dx * fx + dy * fy) / dist);
    if (dirScore < -0.25) continue; // avoid obvious backtracking rares
    const score = dirScore * 180 + Math.min(dist, 240) * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  templeRareExploreCache = best || null;
  templeRareExploreCacheAt = now;
  return best;
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

  const exploringNow = targetName.startsWith('Temple Search');
  const shouldRepickTarget =
    !exploringNow ||
    currentPath.length === 0 ||
    (now - templeExploreLastPickAt > 1500) ||
    templeExploreNoPathCount >= 2;
  if (shouldRepickTarget) {
    // Keep temple search lightweight: simple lane walking.
    // Avoid frequent entity scans/chasing during FINDING_TEMPLE to reduce lag spikes.
    if (templeExploreNoPathCount >= 2) {
      const rotate = (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 5); // +-36 deg
      const nx = templeExploreDirX * Math.cos(rotate) - templeExploreDirY * Math.sin(rotate);
      const ny = templeExploreDirX * Math.sin(rotate) + templeExploreDirY * Math.cos(rotate);
      templeExploreDirX = nx;
      templeExploreDirY = ny;
    }
    const exploreX = player.gridX + templeExploreDirX * 190;
    const exploreY = player.gridY + templeExploreDirY * 190;
    const exploreName = 'Temple Search Walk';

    const needExploreTarget =
      Math.abs(targetGridX - exploreX) > 26 ||
      Math.abs(targetGridY - exploreY) > 26 ||
      currentPath.length === 0;
    if (needExploreTarget && now - lastRepathTime > 900) {
      startWalkingTo(exploreX, exploreY, exploreName, '');
      templeExploreLastPickAt = now;
    }
  }

  const exploreStep = stepPathWalker();
  if (exploreStep === 'stuck' || (exploreStep === 'walking' && currentPath.length === 0)) {
    templeExploreNoPathCount++;
    if (templeExploreNoPathCount >= 4) {
      const rotate = (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 3); // +-60 deg
      const nx = templeExploreDirX * Math.cos(rotate) - templeExploreDirY * Math.sin(rotate);
      const ny = templeExploreDirX * Math.sin(rotate) + templeExploreDirY * Math.cos(rotate);
      templeExploreDirX = nx;
      templeExploreDirY = ny;
      templeExploreNoPathCount = 0;
      templeExploreLastPickAt = 0;
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

  // Allow utility during exploration/search states and boss approach.
  // Boss fight remains protected.
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
  if (
    (bossTgtFound || checkpointReached || bossFound) &&
    currentState === STATE.WALKING_TO_UTILITY &&
    resume !== STATE.MAP_COMPLETE &&
    resume === STATE.FINDING_BOSS
  ) {
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

function tryLateTempleHandoffFromBossFlow(player, now, reason = '') {
  return false;   // boss-only mapping: temple flow disabled -- never peel off to temple (cleanup pending)
  if (templeCleared) return false;
  if (!player || !Number.isFinite(player.gridX) || !Number.isFinite(player.gridY)) return false;
  if (now - lastLateTempleHandoffCheck < 1800) return false;
  lastLateTempleHandoffCheck = now;

  // If boss is already actively engaged nearby, do not peel off to temple.
  const engaged = detectActiveBossEngagement(player.gridX, player.gridY, now, 90);
  if (engaged && engaged.entity) return false;

  const templeLoc = findTempleTgt();
  if (!templeLoc) return false;
  if (isTempleTargetTemporarilyBlocked(templeLoc.x, templeLoc.y)) return false;

  templeGridX = templeLoc.x;
  templeGridY = templeLoc.y;
  templeFound = true;
  templeCleared = false;
  resumeTempleAfterBoss = false;
  checkpointReached = false;

  startWalkingTo(templeGridX, templeGridY, 'Temple (late objective)', 'temple');
  log(
    `Late temple handoff${reason ? ` (${reason})` : ''}: ` +
    `switching from boss flow to temple at (${templeGridX.toFixed(0)}, ${templeGridY.toFixed(0)})`
  );
  setState(STATE.WALKING_TO_TEMPLE);
  return true;
}

function startUtilityState(selected) {
  utilityActiveTarget = selected;
  utilityNoPathCount = 0;
  utilityArrivalWaitStart = 0;
  if (utilityResumeState !== currentState || utilitySessionStartTime === 0) {
    utilitySessionStartTime = Date.now();
  }
  utilityResumeState = currentState;
  utilityLastProgressDist = Infinity;
  utilityLastProgressTime = 0;
  setState(STATE.WALKING_TO_UTILITY);
  startWalkingTo(selected.x, selected.y, `Utility ${selected.type}`, '');
}

function tryStartUtilityNavigation(player, now) {
  if (!canInterruptForUtility()) return false;
  // Keep utility checks hot. A short cooldown prevents thrash loops, but should
  // never starve nearby loot/openables for seconds.
  if (utilitySessionGiveUpUntil > now && utilityActiveTarget) return false;
  const bossObjectiveCommitted = (bossTgtFound || checkpointReached || bossFound);
  const inCheckpointApproach = currentState === STATE.WALKING_TO_BOSS_CHECKPOINT;
  const inMeleeApproach = currentState === STATE.WALKING_TO_BOSS_MELEE;
  const inFindingBoss = currentState === STATE.FINDING_BOSS;
  const findingBossExploring =
    inFindingBoss &&
    (targetName.includes('Boss Radar Explore') || targetName.includes('Boss Search'));
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
  const activeIsLoot = utilityActiveTarget?.type === 'loot';
  // Loot should still be collectible during boss approach, just with bounded detours.
  // Too-tight caps caused "not yielding to utility" even for nearby map dots.
  const configuredLootRadius = Math.max(30, currentSettings.lootWalkRadius || 200);
  const nearbyBossApproachLootCap =
    inCheckpointApproach ? (checkpointExploring ? Math.min(configuredLootRadius, 150) : Math.min(configuredLootRadius, 105)) :
    inMeleeApproach ? (meleeExploring ? Math.min(configuredLootRadius, 135) : Math.min(configuredLootRadius, 92)) :
    45;
  const findingBossActiveCap = findingBossExploring
    ? (activeIsOpenable ? Math.max(120, currentSettings.openableWalkRadius || 200) : (activeIsShrine ? 95 : 65))
    : 45;
  const maxBossApproachUtilityDist =
    inCheckpointApproach ? (checkpointExploring ? 70 : 35) :
    inMeleeApproach ? (meleeExploring ? 60 : 32) :
    45;
  const activeDistCap = activeIsOpenable
    ? Math.max(120, currentSettings.openableWalkRadius || 200)
    : (activeIsLoot ? nearbyBossApproachLootCap : (activeIsShrine ? (maxBossApproachUtilityDist + 20) : maxBossApproachUtilityDist));
  if (utilityActiveTarget && !isUtilityTargetIgnored(utilityActiveTarget)) {
    // USER 2026-06-28: once we YIELD to a utility, COMMIT for >=2s before the boss-approach distance caps can yank it
    // back ("u yield to utility then leave immediately"). After the 2s grace the caps apply exactly as before.
    const utilCommitted = utilitySessionStartTime > 0 && (now - utilitySessionStartTime) < 2000;
    if (
      !utilCommitted &&
      currentState !== STATE.MAP_COMPLETE &&
      (inCheckpointApproach || inMeleeApproach) &&
      !activeIsOpenable &&
      (!activeIsLoot || (utilityActiveTarget.distance || Infinity) > nearbyBossApproachLootCap)
    ) {
      // During boss approach, keep openables and VERY-near loot only.
      utilityActiveTarget = null;
    }
    if (
      !utilCommitted &&
      currentState !== STATE.MAP_COMPLETE &&
      bossObjectiveCommitted &&
      utilityActiveTarget &&
      Number.isFinite(utilityActiveTarget.distance) &&
      (
        (currentState === STATE.FINDING_BOSS && utilityActiveTarget.distance > findingBossActiveCap) ||
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
  const selectedIsLoot = selected.type === 'loot';
  // OBJECTIVE-OVER-UTILITY (user 2026-06-28): never start an openable-CHEST detour while a LIVE (non-blacklisted) abyss/
  // verisium objective is in reach -- objectives WIN. Shrines (buffs) + loot (quick grabs) still allowed; a blacklisted/
  // unreachable objective does NOT block the chest (nothing better to do).
  if (selectedIsOpenable && !selectedIsShrine) {
    const obj = hasLiveObjectiveNear(player, 600);
    if (obj) { logUtility(`Utility skip: openable -> live ${obj} objective in reach (objective wins)`, 'utility:skip:obj', 2000); return false; }
  }
  const findingBossSelectedCap = findingBossExploring
    ? (selectedIsOpenable ? Math.max(120, currentSettings.openableWalkRadius || 200) : (selectedIsShrine ? 95 : 65))
    : 45;
  // Allow wider shrine pickup radius during boss approach so mapper actually diverts.
  const selectedDistCap = selectedIsOpenable
    ? Math.max(120, currentSettings.openableWalkRadius || 200)
    : (selectedIsLoot ? nearbyBossApproachLootCap : (selectedIsShrine ? Math.max(maxBossApproachUtilityDist + 60, 95) : maxBossApproachUtilityDist));

  if (currentState !== STATE.MAP_COMPLETE && bossObjectiveCommitted) {
    if (currentState === STATE.FINDING_BOSS) {
      // Boss committed: only allow nearby utility so we don't abandon boss route.
      if ((selected.distance || Infinity) > findingBossSelectedCap) return false;
    } else if (inCheckpointApproach || inMeleeApproach) {
      // During checkpoint/melee approach, allow openables and very-near loot only.
      if (!selectedIsOpenable && (!selectedIsLoot || (selected.distance || Infinity) > nearbyBossApproachLootCap)) {
        return false;
      }
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
  // Runed Monoliths (StoneCircle/RuneRock) can hang the bot -> HARD 5s cap each; everything else 12s.
  const _utName = ((utilityActiveTarget && utilityActiveTarget.meta && utilityActiveTarget.meta.name) || '').toLowerCase();
  const _isMonolith = /monolith|runerock|stonecircle/.test(_utName);
  const utilitySessionMaxMs = (utilityResumeState === STATE.MAP_COMPLETE) ? 0 : (_isMonolith ? 5000 : 12000);

  // DON'T dump the area while Verisium/breach content is still being worked or PENDING nearby. This cap measures the
  // TOTAL utility session incl. content time, so after a long breach it would instantly fire and strand unopened
  // remnants (the "didn't open the pile" bug). exp2NearestRemnant is only probed once we're already over the cap
  // (short-circuited after the cheaper exp2Phase / breach checks). exp2 has its own per-remnant timeout as a backstop.
  if (utilitySessionMaxMs > 0 && utilitySessionStartTime > 0 && (now - utilitySessionStartTime) > utilitySessionMaxMs
      && !(exp2Phase !== 'idle' || rotBreachActivatedAt > 0 || exp2NearestRemnant(player, now))) {
    const elapsed = now - utilitySessionStartTime;
    log(`Utility timeout after ${(elapsed / 1000).toFixed(1)}s, resuming ${utilityResumeState}`);
    if (utilityActiveTarget) addIgnoredUtilityTarget(utilityActiveTarget, 'failed:timeout');   // BLACKLIST the timed-out target so we don't re-select + re-yoyo the same (walled) one
    utilitySessionGiveUpUntil = now + 1400;
    utilityActiveTarget = null;
    utilityNoPathCount = 0;
    utilityArrivalWaitStart = 0;
    utilitySessionStartTime = 0;
    utilityLastProgressDist = Infinity;
    utilityLastProgressTime = 0;
    finishUtilityState();
    return false;
  }

  if (!utilityActiveTarget || isUtilityTargetIgnored(utilityActiveTarget)) {
    utilityActiveTarget = null;
    utilityNoPathCount = 0;
    utilityArrivalWaitStart = 0;
    utilitySessionStartTime = 0;
    utilityLastProgressDist = Infinity;
    utilityLastProgressTime = 0;
    finishUtilityState();
    return false;
  }

  if (!utilityActiveTarget) return false;

  const dx = utilityActiveTarget.x - player.gridX;
  const dy = utilityActiveTarget.y - player.gridY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (!Number.isFinite(utilityLastProgressDist) || dist < utilityLastProgressDist - 3) {
    utilityLastProgressDist = dist;
    utilityLastProgressTime = now;
  } else if (utilityLastProgressTime === 0) {
    utilityLastProgressTime = now;
  }
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
      addIgnoredUtilityTarget(utilityActiveTarget, gotYield ? `handled:${lock.source}` : 'handled:arrived', gotYield ? 600000 : 45000);   // serviced -> 10min; arrived-but-opener-busy -> 45s retry (B7)
      utilityActiveTarget = null;
      utilityNoPathCount = 0;
      utilityArrivalWaitStart = 0;
      utilitySessionStartTime = 0;
      utilityLastProgressDist = Infinity;
      utilityLastProgressTime = 0;
      finishUtilityState();
    }
    statusMessage = `Utility wait: ${utilityActiveTarget?.type || 'target'} (${dist.toFixed(0)}u)`;
    return true;
  }

  // ANTI-YOYO (USER: walled Trunk): no NET progress toward the target for 5s -- despite detouring around -- means it's
  // UNREACHABLE (across a wall). Blacklist it so we stop oscillating target<->detour and actually skip it. (utilityLast-
  // ProgressTime only advances on a NEW best-dist, so a detour that merely moves us sideways/back doesn't reset it.)
  if (utilityLastProgressTime > 0 && now - utilityLastProgressTime > 5000) {
    log(`Utility ${utilityActiveTarget.type} unreachable (no progress 5s at ${dist.toFixed(0)}u) -> blacklist + skip`);
    addIgnoredUtilityTarget(utilityActiveTarget, 'failed:no-net-progress');
    utilityActiveTarget = null;
    utilityNoPathCount = 0; utilityArrivalWaitStart = 0; utilityLastProgressDist = Infinity; utilityLastProgressTime = 0;
    finishUtilityState();
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
  const noProgressTooLong = utilityLastProgressTime > 0 && (now - utilityLastProgressTime) > 4200;
  if (noProgressTooLong) {
    addIgnoredUtilityTarget(utilityActiveTarget, 'failed:no-progress');
    utilityActiveTarget = null;
    utilityNoPathCount = 0;
    utilityArrivalWaitStart = 0;
    utilityLastProgressDist = Infinity;
    utilityLastProgressTime = 0;
    // Re-evaluate next candidate without immediately abandoning utility session.
    return true;
  }
  if (utilityNoPathCount >= threshold) {
    addIgnoredUtilityTarget(utilityActiveTarget, 'failed:no-path');
    utilityActiveTarget = null;
    utilityNoPathCount = 0;
    utilityArrivalWaitStart = 0;
    utilityLastProgressDist = Infinity;
    utilityLastProgressTime = 0;
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

// ---- Infinity-style CHUNK-BASED systematic map exploration ------------------
// Split the whole map (terrain bounds) into a grid of chunks; classify each OPEN/WALL once on area enter;
// then always head to the nearest unvisited OPEN reachable chunk until every reachable chunk is covered.
// Systematic coverage with a clean DONE condition -> no greedy-frontier backtracking / "running around".
const CHUNK = 100;                 // chunk size (grid units) ~= the player's reveal/stream radius
let chunkMap = null;               // Map<"cx,cy", {cx,cy,wx,wy,walkable,visited,unreachable}>
function chunkKey(cx, cy) { return cx + ',' + cy; }
function buildChunkGrid() {
  chunkMap = new Map();
  let W = 1800, H = 1900;
  try { const ti = poe2.getTerrainInfo(); if (ti && ti.isValid && ti.width) { W = ti.width; H = ti.height; } } catch (e) {}
  const ncx = Math.ceil(W / CHUNK) + 1, ncy = Math.ceil(H / CHUNK) + 1, S = CHUNK / 3;
  for (let cx = 0; cx < ncx; cx++) {
    for (let cy = 0; cy < ncy; cy++) {
      const cX = cx * CHUNK + CHUNK / 2, cY = cy * CHUNK + CHUNK / 2;
      let wx = -1, wy = -1;
      for (let ox = -S; ox <= S && wx < 0; ox += S)
        for (let oy = -S; oy <= S && wx < 0; oy += S) {
          const x = Math.floor(cX + ox), y = Math.floor(cY + oy);
          if (poe2.isWalkable(x, y)) { wx = x; wy = y; }
        }
      chunkMap.set(chunkKey(cx, cy), { cx, cy, wx, wy, walkable: wx >= 0, visited: false, unreachable: false });
    }
  }
  let open = 0; for (const c of chunkMap.values()) if (c.walkable) open++;
  log(`Chunk grid built: ${open} open / ${chunkMap.size} chunks (${CHUNK}u)`);
}
// per-tick: mark every OPEN chunk whose center is within the reveal radius as visited (~= stream range)
function markFrontierVisited(gx, gy) {
  if (!chunkMap || !Number.isFinite(gx) || !Number.isFinite(gy)) return;
  const R2 = 130 * 130, ccx = Math.floor(gx / CHUNK), ccy = Math.floor(gy / CHUNK);
  for (let dcx = -2; dcx <= 2; dcx++)
    for (let dcy = -2; dcy <= 2; dcy++) {
      const ch = chunkMap.get(chunkKey(ccx + dcx, ccy + dcy));
      if (!ch || !ch.walkable || ch.visited) continue;
      const cX = ch.cx * CHUNK + CHUNK / 2, cY = ch.cy * CHUNK + CHUNK / 2;
      if ((gx - cX) ** 2 + (gy - cY) ** 2 < R2) ch.visited = true;
    }
}
// nearest unvisited OPEN reachable chunk -> a walkable point in it (null when the map is covered)
function pickExploreTarget(px, py) {
  if (typeof poe2.isWalkable !== 'function') return null;
  if (!chunkMap) buildChunkGrid();
  markFrontierVisited(px, py);                 // ensure our current chunk counts as visited first
  const cands = [];
  for (const ch of chunkMap.values()) {
    if (!ch.walkable || ch.visited || ch.unreachable) continue;
    if (nearSoftBlock(ch.wx, ch.wy)) continue;
    const cX = ch.cx * CHUNK + CHUNK / 2, cY = ch.cy * CHUNK + CHUNK / 2;
    cands.push({ ch, d: (px - cX) ** 2 + (py - cY) ** 2 });
  }
  if (cands.length === 0) {
    for (const ch of chunkMap.values()) ch.unreachable = false;   // ran dry -> clear stale unreachable + retry
    return null;                                                   // (or genuinely covered the whole map)
  }
  cands.sort((a, b) => a.d - b.d);                                 // NEAREST unvisited open chunk first
  for (let i = 0; i < cands.length && i < 6; i++) {
    const ch = cands[i].ch;
    const path = poe2.findPathBFS(Math.floor(px), Math.floor(py), ch.wx, ch.wy);
    if (path && path.length > 0) return { x: ch.wx, y: ch.wy };
    ch.unreachable = true;            // not reachable from here right now -> skip; cleared when we run dry
  }
  return null;                        // nearest few unreachable this pass -> retry next call (we'll have moved)
}

// Nearest ALIVE elite (magic/rare/unique) -- streamed, so nearby. Priority: unique > rare > magic, then dist.
function findNearestEliteAlive(pgx, pgy) {
  let mons;
  try { mons = poe2.getEntities({ type: 'Monster', aliveOnly: true, lightweight: true }) || []; } catch (e) { return null; }
  let best = null, bestRank = 0, bestD = Infinity;
  for (const e of mons) {
    if (!isHostileAlive(e)) continue;
    const sub = e.entitySubtype || '';
    const rank = sub.includes('Unique') ? 3 : sub.includes('Rare') ? 2 : sub.includes('Magic') ? 1 : 0;
    if (rank < 1) continue;   // BLUE (magic) or higher only
    if (isAbandonedTarget(e.gridX || 0, e.gridY || 0)) continue;   // steer-fallback gave up (walled off) -> skip, don't re-pick
    const d = Math.hypot((e.gridX || 0) - pgx, (e.gridY || 0) - pgy);
    if (rank > bestRank || (rank === bestRank && d < bestD)) { bestRank = rank; bestD = d; best = e; }
  }
  return best;
}

// --- Delirium mirror + pieces -------------------------------------------------------------------------
// Delirium objects (the "mirror" initiator AND the shard pieces you step into) all show up as
// type:"Delirium" in getMapContent and drop out once consumed. We OPPORTUNISTICALLY step into the
// nearest one that's within picker/opener REACH and WALKABLE and not blacklisted; anything we can't
// reach/consume gets blacklisted so we don't wedge. Nothing in reach -> hand back to the boss flow.
const DELIRIUM_REACH = 70; // ~picker/opener yield distance (tunable)
function findDeliriumMirror(pgx, pgy) {
  let mc;
  try { mc = (typeof poe2.getMapContent === 'function') ? poe2.getMapContent() : null; } catch (e) { return null; }
  if (!mc || !mc.length) return null;
  const canWalk = typeof poe2.isWalkable === 'function';
  let best = null, bestD = Infinity;
  for (const m of mc) {
    if (m.type !== 'Delirium' && !(m.path && m.path.indexOf('Delirium') >= 0)) continue;
    const gx = Math.round(m.gridX), gy = Math.round(m.gridY);
    const key = gx + ',' + gy;
    if (deliriumBlacklist.has(key)) continue;
    const d = Math.hypot(pgx - gx, pgy - gy);
    if (d > DELIRIUM_REACH) continue;                                  // only within picker/opener reach
    if (canWalk && !poe2.isWalkable(gx, gy)) { deliriumBlacklist.add(key); continue; } // not walkable -> skip
    if (d < bestD) { bestD = d; best = { gx, gy, d, key }; }
  }
  return best;
}

// Step into the nearest reachable Delirium piece; returns true while doing so (caller skips boss logic),
// false when there's nothing reachable nearby. Ongoing -- runs as new pieces come into reach while walking.
function handleDeliriumMirror(player, now) {
  if (currentSettings.deliriumMirrorEnabled === false) return false;
  // DELIRIUM COMPLETE -> stop chasing phantom pieces. getMapContent keeps listing the Delirium pieces even after the
  // encounter is done, so without this gate the start-mirror handler steps into them forever (the post-complete yo-yo).
  // Same gate the rotation uses (runContentRotation: deliriumMirrorEnabled && !mapObjectiveComplete('Delirium')).
  if (mapObjectiveComplete('Delirium', now)) { deliriumTargetKey = ''; return false; }
  const mirror = findDeliriumMirror(player.gridX, player.gridY);
  if (!mirror) { deliriumTargetKey = ''; return false; }              // nothing reachable nearby -> proceed
  if (deliriumTargetKey !== mirror.key) { deliriumTargetKey = mirror.key; deliriumTargetStart = now; }
  if (now - deliriumTargetStart > 4000) {                             // can't consume in 4s -> blacklist, move on
    deliriumBlacklist.add(mirror.key);
    log(`[Delirium] piece (${mirror.key}) unreachable -> blacklisted`);
    deliriumTargetKey = ''; currentPath = [];
    return false;
  }
  statusMessage = `Delirium -> stepping into piece (${mirror.d.toFixed(0)}u)`;
  if ((Math.abs(targetGridX - mirror.gx) > 12 || Math.abs(targetGridY - mirror.gy) > 12 || currentPath.length === 0) && now - lastRepathTime > 400) {
    startWalkingTo(mirror.gx, mirror.gy, 'Delirium', 'boss');
  }
  const step = stepPathWalker();
  if (step === 'arrived') sendMoveGridDir(mirror.gx - player.gridX, mirror.gy - player.gridY); // nudge in
  else if (step === 'stuck') { deliriumBlacklist.add(mirror.key); deliriumTargetKey = ''; currentPath = []; }
  return true;
}

function isEndgameBossCheckpointEntity(entity) {
  const name = `${entity?.name || ''} ${entity?.renderName || ''}`.toLowerCase();
  return name.includes('checkpoint_endgame_boss');
}

function canSwitchToBossMeleeFromCheckpointState(player, now) {
  if (!player || !Number.isFinite(player.gridX) || !Number.isFinite(player.gridY)) {
    return { ok: false, reason: 'invalid-player' };
  }
  if (!Number.isFinite(bossGridX) || !Number.isFinite(bossGridY)) {
    return { ok: false, reason: 'invalid-checkpoint-anchor' };
  }

  const distToAnchor = Math.hypot(player.gridX - bossGridX, player.gridY - bossGridY);
  const radarBoss = getRadarBossTarget();
  const engaged = detectActiveBossEngagement(player.gridX, player.gridY, now, 90);
  if (engaged && engaged.entity) {
    if (isMapObjectiveComplete() || isEntityLikelyMainObjectiveBoss(engaged.entity)) {
      return { ok: true, reason: 'active-engagement' };
    }
  }

  const nearbyBoss = findBossCandidateUnique(
    player.gridX,
    player.gridY,
    180,
    bossGridX,
    bossGridY,
    260
  );
  if (nearbyBoss && (isMapObjectiveComplete() || isEntityLikelyMainObjectiveBoss(nearbyBoss))) {
    return { ok: true, reason: 'nearby-boss-candidate' };
  }

  if (bossTargetSource === 'checkpoint') {
    const cps = poe2.getEntities({
      nameContains: 'Checkpoint_Endgame_Boss',
      lightweight: true,
    }) || [];
    const hasCheckpointNearAnchor = cps.some((cp) => {
      if (!isEndgameBossCheckpointEntity(cp)) return false;
      if (!Number.isFinite(cp.gridX) || !Number.isFinite(cp.gridY)) return false;
      return Math.hypot(cp.gridX - bossGridX, cp.gridY - bossGridY) <= 56;
    });
    if (!hasCheckpointNearAnchor) {
      const distAnchorToRadar = radarBoss ? Math.hypot(bossGridX - radarBoss.x, bossGridY - radarBoss.y) : Infinity;
      // Some layouts briefly drop/occlude checkpoint entities from the scan.
      // If we are physically at the locked checkpoint anchor, allow a trust handoff.
      if (distToAnchor <= 20 && distAnchorToRadar <= 260) {
        return { ok: true, reason: 'checkpoint-trust-close' };
      }
      return { ok: false, reason: 'no-checkpoint-entity-near-anchor' };
    }
    if (distToAnchor > 30) {
      return { ok: false, reason: `far-from-checkpoint-${distToAnchor.toFixed(0)}` };
    }
    return { ok: true, reason: 'checkpoint-confirmed' };
  }

  if (bossTargetSource === 'arena_object') {
    const distAnchorToRadar = radarBoss ? Math.hypot(bossGridX - radarBoss.x, bossGridY - radarBoss.y) : Infinity;
    if (distToAnchor <= 24 && distAnchorToRadar <= 200) {
      return { ok: true, reason: 'arena-anchor-near-radar' };
    }
    return {
      ok: false,
      reason: `arena-anchor-unconfirmed dAnchor=${distToAnchor.toFixed(0)} dRadar=${Number.isFinite(distAnchorToRadar) ? distAnchorToRadar.toFixed(0) : 'inf'}`,
    };
  }

  if (distToAnchor <= 20) return { ok: true, reason: 'close-anchor-fallback' };
  return { ok: false, reason: `anchor-too-far-${distToAnchor.toFixed(0)}` };
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

      // Hard reject invalid origin anchors. EITHER coord at the origin = unresolved: a positionless
      // BossArenaBlocker reported (46, 0) -- x resolved, y unresolved -- and the old &&-check let it through,
      // sending the bot marching at a junk corner. Reject if x OR y is near the grid EDGE (within 40) -- the
      // positionless blocker's legacy grid resolves to the corner (e.g. (15,53)), which slipped the old <=1 check.
      if (gx === null || gy === null || Math.abs(gx) < 40 || Math.abs(gy) < 40) continue;
      // Reject out-of-bounds garbage: positionless BossArenaBlocker structures report grid (0,0),
      // and the legacy-grid fallback above then adopts a JUNK legacy coord (e.g. 3035433216) ->
      // billion-unit unreachable target -> pathfinder returns 0 waypoints -> bot frozen. Real map
      // grids are a few thousand at most.
      if (Math.abs(gx) > 50000 || Math.abs(gy) > 50000) continue;
      if (isAbandonedTarget(gx, gy)) continue;
      // Reject dormant/unplaced boss-arena templates: they report grid == player position (legacy 0,0)
      // and FOLLOW the player -> dAnchor~0 -> degenerate push -> side-to-side thrash (Trenches "Dex/DexFour").
      // A real boss arena is never on top of us; if it were, the boss would already be streaming/engaged.
      const dpx = gx - playerGX, dpy = gy - playerGY;
      const dPlayer = Math.sqrt(dpx * dpx + dpy * dpy);
      if (dPlayer < 35) continue;
      // Reject implausibly-FAR anchors: a boss-room object only STREAMS IN / renders when we're near it (a few
      // hundred u). A "detected" object reporting a position ~1000s of units away has JUNK grid coords (a
      // positionless template) -> the bot beelines OFF-MAP "sidewards" (the (40,887)@1685u bug) -> yoyo + lag.
      // Real barriers are detected close; keep EXPLORING until we actually approach one.
      if (dPlayer > 900) continue;
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

function markRecentFightWaypoint(x, y, maxKeep = 8) {
  bossFightRecentWaypoints.push({ x, y });
  if (bossFightRecentWaypoints.length > maxKeep) {
    bossFightRecentWaypoints.shift();
  }
}

function isRecentFightWaypoint(x, y, radius = 24) {
  const r2 = radius * radius;
  for (const p of bossFightRecentWaypoints) {
    const dx = x - p.x;
    const dy = y - p.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
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
function pickBossCheckpointDetour(playerGX, playerGY, bossGX, bossGY, minForwardDot = 0.12) {
  const toBossX = bossGX - playerGX;
  const toBossY = bossGY - playerGY;
  const toBossLen = Math.hypot(toBossX, toBossY);
  if (toBossLen < 1) return null;
  const ux = toBossX / toBossLen;
  const uy = toBossY / toBossLen;
  const baseAngle = Math.atan2(toBossY, toBossX);

  // Forward-first cone only. Avoid side/back detours that cause checkpoint yo-yo.
  const angleOffsets = [0, Math.PI / 10, -Math.PI / 10, Math.PI / 6, -Math.PI / 6, Math.PI / 4, -Math.PI / 4];
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
      if (towardScore < minForwardDot) continue;
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
// BOSS-BEHIND (user 2026-06-23): a kite waypoint BEHIND the boss (opposite its facing) at orbit range, so
// frontal attacks -- including the big-circle AoE -- miss. Returns null when facing is unknown OR the back arc
// is fully walled (boss in/against a wall), so the caller falls back to the generic orbit. Tries the exact back
// then a few offsets so we still get roughly-behind when the precise spot is blocked.
function pickBehindBossWaypoint(player, boss) {
  if (!boss) return null;
  const facing = getEntityFacingRad(boss);
  if (facing === null) return null;            // unknown facing -> let the generic orbit handle it
  const backA = normalizeRad(facing + Math.PI);
  const radius = 55;                            // behind + in shooting range
  for (const off of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05]) {
    const a = normalizeRad(backA + off);
    const tx = boss.gridX + Math.cos(a) * radius;
    const ty = boss.gridY + Math.sin(a) * radius;
    if (poe2.isWalkable(Math.floor(tx), Math.floor(ty))) return { x: tx, y: ty };
  }
  return null;                                  // back fully walled -> orbit fallback
}

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
      if (isRecentFightWaypoint(tx, ty, 22)) continue;

      markRecentOrbitSector(sector, 7);
      markRecentFightWaypoint(tx, ty, 10);
      return { x: tx, y: ty, sector };
    }
  }

  // Fallback: keep moving tangentially in locked direction with slight outward bias.
  const tangentAngle = Math.atan2(playerGY - bossGY, playerGX - bossGX) + (Math.PI / 2) * bossOrbitDir;
  const tx = playerGX + Math.cos(tangentAngle) * 38 + Math.cos(tangentAngle - (Math.PI / 2) * bossOrbitDir) * 8;
  const ty = playerGY + Math.sin(tangentAngle) * 38 + Math.sin(tangentAngle - (Math.PI / 2) * bossOrbitDir) * 8;
  markRecentFightWaypoint(tx, ty, 10);
  return { x: tx, y: ty, sector: -1 };
}

// RADIAL kite-retreat: a walkable point ~targetDist straight AWAY from the boss (the OPPOSITE of orbiting -- GAIN radial
// distance, don't circle at melee). Angular fallbacks if the straight-back tile is walled; pass 1 prefers an OPEN landing
// (don't retreat into a wall), pass 2 takes any walkable. null = fully boxed -> caller keeps the orbit. (FIGHTING_BOSS floor.)
function pickRadialRetreatWaypoint(playerGX, playerGY, bossGX, bossGY, targetDist) {
  let ax = playerGX - bossGX, ay = playerGY - bossGY;
  if (Math.hypot(ax, ay) < 1) { ax = 1; ay = 0; }            // boss exactly on us -> arbitrary away dir
  const baseA = Math.atan2(ay, ax);
  const offs = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4];
  for (const minClear of [6, 0]) {
    for (const off of offs) {
      const a = baseA + off;
      const tx = bossGX + Math.cos(a) * targetDist, ty = bossGY + Math.sin(a) * targetDist;
      if (!poe2.isWalkable(Math.floor(tx), Math.floor(ty))) continue;
      if (minClear && getWalkableClearanceScore(tx, ty) < minClear) continue;
      return { x: tx, y: ty };
    }
  }
  return null;
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
    bossFightRecentWaypoints = [];
    bossOrbitDir = Math.random() < 0.5 ? 1 : -1;
    bossFightStuckCount = 0;
    lastBossDodgeRollTime = 0;
    lastBossEmergencyRollTime = 0;
    lastBossZekoaPanicRollTime = 0;
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
    fightLastNearbyMonsterCount = 0;
    fightArenaEvalTime = 0;
    fightArenaBossUniques = [];
    fightArenaBossAliveCount = 0;
    fightArenaRadarX = NaN;
    fightArenaRadarY = NaN;
    fightObjectiveInfoCache = null;
    fightObjectiveInfoTime = 0;
    bossFightClearanceScore = 8;
    bossFightClearanceSampleAt = 0;
    bossFightClearanceSampleX = 0;
    bossFightClearanceSampleY = 0;
    bossFightLastPosCheckTime = 0;
    bossFightLastPosX = 0;
    bossFightLastPosY = 0;
    bossMeleeCachedTarget = null;
    bossMeleeCachedTargetAt = 0;
    bossMeleeCachedActionEntity = null;
    bossMeleeActionProbeAt = 0;
  }
  if (newState === STATE.FINDING_BOSS) {
    bossExploreDirX = 0;
    bossExploreDirY = 0;
    bossExploreLastTargetX = 0;
    bossExploreLastTargetY = 0;
    bossExploreLastPickTime = 0;
    bossExploreNoPathCount = 0;
    bossNoPathCount = 0;
    bossCheckpointGateFailCount = 0;
    bossDetourLastPickTime = 0;
    bossRecentDetours = [];
    bossCheckpointLastDist = Infinity;
    bossCheckpointLastImprovementTime = 0;
    bossMeleeExplorePickTime = 0;
    bossMeleeExploreNoPathCount = 0;
    bossMeleeCachedTarget = null;
    bossMeleeCachedTargetAt = 0;
    bossMeleeCachedActionEntity = null;
    bossMeleeActionProbeAt = 0;

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
  if (newState === STATE.FINDING_TEMPLE) {
    templeOptionalSearchStartAt = Date.now();
    templeOptionalSearchStartX = 0;
    templeOptionalSearchStartY = 0;
    templeOptionalSearchMaxDist = 0;
    templeExploreLastPickAt = 0;
    templeRareExploreCache = null;
    templeRareExploreCacheAt = 0;
  }
  if (newState === STATE.WALKING_TO_BOSS_CHECKPOINT) {
    bossCheckpointLastImprovementTime = 0;   // fresh anti-freeze watchdog per checkpoint attempt
    checkpointBestDist = Infinity;
  }
  if (newState === STATE.WALKING_TO_BOSS_MELEE) {
    bossMeleeExplorePickTime = 0;
    bossMeleeExploreNoPathCount = 0;
    bossMeleeCachedTarget = null;
    bossMeleeCachedTargetAt = 0;
    bossMeleeCachedActionEntity = null;
    bossMeleeActionProbeAt = 0;
    bossMeleeStallLastDist = Infinity;
    bossMeleeStallLastProgressAt = 0;
    bossMeleeApproachLastEvadeAt = 0;
  }
  if (newState === STATE.MAP_COMPLETE) {
    // Completed-map portals can remain in hideout briefly and are hard to
    // classify reliably by name/path across tilesets. Ignore existing portals
    // for a short window so we start a fresh node instead of re-entering.
    hideoutSkipExistingPortalUntil = Date.now() + HIDEOUT_SKIP_OLD_PORTALS_AFTER_COMPLETE_MS;
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
    ignoredUtilityTargets = new Map();   // key -> expiry ts (was a no-expiry Set: B7/B8 -- timed-out targets now retry)
    utilityActiveTarget = null;
    utilityNoPathCount = 0;
    utilityArrivalWaitStart = 0;
    utilityDetourUntil = 0;
    utilityLastSelectedKey = '';
    utilityResumeState = STATE.IDLE;
    utilitySessionStartTime = 0;
    utilitySessionGiveUpUntil = 0;
    utilityLastProgressDist = Infinity;
    utilityLastProgressTime = 0;
    utilityStats.blacklistedCount = 0;
  }
}

function resetMapper() {
  currentState = STATE.IDLE;
  stateStartTime = Date.now();
  currentPath = [];
  currentWaypointIndex = 0;
  try { poe2.setRadarPaths([]); } catch (e) {}  // clear drawn route + release path ownership (objective auto-pather resumes)
  deliriumBlacklist.clear();
  deliriumTargetKey = '';
  deliriumTargetStart = 0;
  incursionRecentlyDone.clear();
  incursionCurId = 0;
  incursionDwellStart = 0;
  incursionCurStartAt = 0;
  incBeaconId = 0; incBeaconStartAt = 0; incBeaconDwell = 0; incBeaconWasActivatable = false; incBeaconBlacklist.clear();
  abyssId = 0; abyssStartAt = 0; abyssDwell = 0; abyssBlacklist.clear();
  rotRareId = 0; rotRareStart = 0; rotRareBlacklist.clear();
  rotDeliriumKey = ''; rotDeliriumStart = 0;
  rotBreachId = 0; rotBreachStart = 0; rotBreachActivatedAt = 0; rotBreachCenterX = 0; rotBreachCenterY = 0; rotBreachLastMobAt = 0; rotBreachSawMob = false; rotBreachStabilised = false; rotBreachStabilisedLogged = false; rotBreachMobCache = null; rotBreachMobScanAt = 0; rotBreachSweepAng = 0; rotBreachSweepUntil = 0; rotBreachMobBL.clear(); rotBreachTgtId = 0; rotBreachTgtSince = 0; rotBreachBlacklist.clear(); breachReturnTgtX = NaN; breachReturnTgtY = NaN;
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
  templeExploreLastPickAt = 0;
  templeRareExploreCache = null;
  templeRareExploreCacheAt = 0;
  templeOptionalSearchStartAt = 0;
  templeOptionalSearchStartX = 0;
  templeOptionalSearchStartY = 0;
  templeOptionalSearchMaxDist = 0;
  templeUnreachableTargets = [];
  lastTempleBossBypassLogTime = 0;
  lastLateTempleHandoffCheck = 0;
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
  chunkMap = null;   // rebuild the chunk grid for the new map on the next explore pick
  softBlocks = []; lastFrontierMarkX = NaN; lastFrontierMarkY = NaN;
  lastExploreScanTime = 0;
  bossFightOrbitWaypointX = 0;
  bossFightOrbitWaypointY = 0;
  bossFightOrbitLastAssignTime = 0;
  bossFightRecentOrbitSectors = [];
  bossFightRecentWaypoints = [];
  bossFightStuckCount = 0;
  bossNoPathCount = 0;
  bossDetourLastPickTime = 0;
  bossRecentDetours = [];
  bossCheckpointGateFailCount = 0;
  bossCheckpointLastDist = Infinity;
  bossCheckpointLastImprovementTime = 0;
  checkpointBestDist = Infinity;
  fogBlockedAnchorX = 0; fogBlockedAnchorY = 0; fogBlockedAnchorUntil = 0;   // review: clear the fog-block so it can't leak into the next map
  bossMeleeExplorePickTime = 0;
  bossMeleeExploreNoPathCount = 0;
  bossMeleeCachedTarget = null;
  bossMeleeCachedTargetAt = 0;
  bossMeleeCachedActionEntity = null;
  bossMeleeActionProbeAt = 0;
  bossArenaCacheX = NaN; bossArenaCacheY = NaN; bossMeleeProbeX = NaN; bossMeleeProbeY = NaN; bossArenaInteriorCache = null;
  frameLock = null; contentQueue.clear();   // P3/P1 rework: drop the engaged-lock + the spotted-content queue on map change
  bossMeleeStallLastDist = Infinity;
  bossMeleeStallLastProgressAt = 0;
  bossMeleeApproachLastEvadeAt = 0;
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
  lastBossZekoaPanicRollTime = 0;
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
  fightLastNearbyMonsterCount = 0;
  fightArenaEvalTime = 0;
  fightArenaBossUniques = [];
  fightArenaBossAliveCount = 0;
  fightArenaRadarX = NaN;
  fightArenaRadarY = NaN;
  fightObjectiveInfoCache = null;
  fightObjectiveInfoTime = 0;
  bossFightClearanceScore = 8;
  bossFightClearanceSampleAt = 0;
  bossFightClearanceSampleX = 0;
  bossFightClearanceSampleY = 0;
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
  ignoredUtilityTargets = new Map();   // key -> expiry ts (was a no-expiry Set: B7/B8 -- timed-out targets now retry)
  utilityActiveTarget = null;
  utilityNoPathCount = 0;
  utilityArrivalWaitStart = 0;
  utilityDetourUntil = 0;
  utilityLastSelectedKey = '';
  utilityResumeState = STATE.IDLE;
  utilitySessionStartTime = 0;
  utilitySessionGiveUpUntil = 0;
  utilityLastProgressDist = Infinity;
  utilityLastProgressTime = 0;
  utilityStats = {
    openableCandidates: 0,
    lootCandidates: 0,
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
  hideoutNodeRetryCount = 0;
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

  // One-time diagnostic: COUNT only (the old per-entity dump was 2500+ lines of log spam).
  if (!hideoutEntityScanLogged) {
    hideoutEntityScanLogged = true;
    const allTiles = poe2.getTileEntities({ maxDistance: 200 }) || [];
    const deviceish = allTiles.filter(e =>
      `${e.renderName || ''} ${e.name || ''}`.toLowerCase().includes('mapdevice'));
    log(`[Hideout] Tile scan: ${allTiles.length} nearby, ${deviceish.length} look like a MapDevice`);
    for (const e of deviceish.slice(0, 5)) {
      log(`  MapDevice? addr=${e.address} render="${e.renderName || ''}" path="${e.name || ''}"`);
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
  return new Uint8Array([0x00, 0xF7, 0x01, ...xBytes, ...yBytes]);
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
    const packet = new Uint8Array([0x00, 0xF7, 0x01, ...xBytes, ...yBytes]);
    result.available = true;
    result.hex = packetToHex(packet);
    result.actX = x;
    result.actY = y;
    result.source = 'captured';
  }

  // Also try to read activation data from atlas nodes for the debug display
  const atlas = getAtlasCached();
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
        const pkt = new Uint8Array([0x00, 0xF7, 0x01, ...xB, ...yB]);
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
  const packet = new Uint8Array([0x00, 0xF7, 0x01, ...xBytes, ...yBytes]);
  log(`[Traverse] Activation key=(${x}, ${y}) Packet: ${packetToHex(packet)}`);
  return packet;
}

function interactWithEntity(target) {
  // target = entity object (preferred; carries grid) or a raw id. PortalTaker-confirmed format:
  // 01 A3 01 | 20 00 C2 66 (Interaction) | 04 00 FF 08 | id(BE4) | gx(BE4) gy(BE4).
  // The FF 08 flag requires the grid coords to follow -- omitting them (old code) DC'd on portal-take.
  const id = (((typeof target === 'object' && target) ? target.id : target) >>> 0);
  const be4 = v => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
  const bytes = [0x01, 0xA3, 0x01, 0x20, 0x00, 0xC2, 0x66, 0x04, 0x00, 0xFF, 0x08, ...be4(id)];
  if (typeof target === 'object' && target && Number.isFinite(target.gridX) && Number.isFinite(target.gridY)) {
    bytes.push(...be4(Math.floor(target.gridX)), ...be4(Math.floor(target.gridY)));
  }
  return poe2.sendPacket(new Uint8Array(bytes));
}

// Open the hideout map device -> brings up the atlas / endgame-map screen.
// WorldScreen (NavigateUiTree(uiRoot,{22})) byte +860 flips 0->4 = select-mode.
// THE OPEN IS A CLICK = TWO packets, press + release (captured live 2026-06-21):
//   SEND 01 A3 01 20 00 C2 66 04 00 FF 08 <id BE4> <gx BE4> <gy BE4>   (press/interact)
//   SEND 01 AA 01                                                       (release)
// Sending ONLY the interact (no release) leaves it "held" -> the atlas
// "refreshes over and over". ALWAYS pair the release. (Server replies 01 C6 with
// the atlas data; a 2nd 01 AA 01 may follow -- one release is enough to open.)
// REFRESH PITFALL #2: while open do NOT call getAtlasNodes() repeatedly -- each
// call re-refreshes the panel. Read the node list ONCE and cache (getAtlasCached()).
// SELECT a node once open: sub_140B8FF70(WorldScreen, node) (RVA 0xB8FF70).
function openMapDevice() {
  const md = (poe2.getTileEntities({ nameContains: 'MapDevice' }) || [])[0];
  if (!md) { log('[Atlas] openMapDevice: device not found'); return false; }
  interactWithEntity(md);                               // 01 A3 ... press
  poe2.sendPacket(new Uint8Array([0x01, 0xAA, 0x01]));  // 01 AA 01 release
  log('[Atlas] openMapDevice -> press+release device id=' + md.id);
  return true;
}

function packetToHex(packet) {
  return Array.from(packet || []).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function sendHideoutReturnPacketA() {
  // Resurrect 1/2 -- 006C. Resurrects AT CHECKPOINT (continue the map); routes to hideout ONLY when out of revives
  // (high maps). Re-captured 2026-06-27 -- replaced stale 0063 (sibling that drifted); decode workflow w93n0d0nh.
  const packet = new Uint8Array([0x00, 0x6C, 0x01, 0x00]);
  const ok = poe2.sendPacket(packet);
  log(`[Manual] Send hideout-return candidate A: ${packetToHex(packet)} ok=${ok}`);
  return ok;
}

function sendHideoutReturnPacketB() {
  // Resurrect 2/2 -- 0177 (the actual respawn/release). Checkpoint resurrect; hideout only when out of revives.
  // Re-captured 2026-06-27 -- replaced stale 0169 (sibling that drifted). Decode workflow w93n0d0nh.
  const packet = new Uint8Array([0x01, 0x77, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]);
  const ok = poe2.sendPacket(packet);
  log(`[Manual] Send hideout-return candidate B: ${packetToHex(packet)} ok=${ok}`);
  return ok;
}

function sendBackToHideoutAndReset(source = 'Manual') {
  const okA = sendHideoutReturnPacketA();
  const okB = sendHideoutReturnPacketB();
  log(`[${source}] Resurrect sequence sent (checkpoint / hideout if out of revives, A then B), okA=${okA}, okB=${okB}. Resetting mapper state.`);
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

  // 'Release on death' OFF -> detected dead, but do NOT auto-resurrect; idle with a status (manual release).
  if (currentSettings.releaseOnDeath === false) {
    statusMessage = 'Dead -- Release on death is OFF (release manually)';
    return true;
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

function getAtlasNodeFilterDecision(node) {
  if (!node) return { blocked: false, reason: '' };
  const traits = (node.traits || []).map(t => `${t?.name || ''}`).join(' ');
  const shortName = `${node.shortName || ''}`.trim();
  const fullName = `${node.fullName || ''}`.trim();
  const shortLower = shortName.toLowerCase();
  const fullLower = fullName.toLowerCase();
  const text = `${shortName} ${fullName} ${node.worldAreaRef || ''} ${traits}`.toLowerCase();

  const hasCitadelSignal =
    text.includes('citadel') ||
    text.includes('/citadels/') ||
    text.includes('\\citadels\\') ||
    text.includes('mapnodecitadel');

  // Keep "unique map" matching fairly strict so normal maps with unrelated "unique"
  // words are not accidentally filtered.
  const hasUniqueSignal =
    text.includes('unique map') ||
    text.includes('uniquemap') ||
    text.includes('mapunique') ||
    text.includes('/uniquemaps/') ||
    text.includes('\\uniquemaps\\') ||
    text.includes('mapnodeuniquemap');
  const hasVaalCitySignal = text.includes('vaal city');
  const hasSunTempleSignal = text.includes('sun temple');
  const hasMoltenVaultSignal = text.includes('molten vault');
  const hasMerchantSignal = text.includes('merchant');
  const hasPowerfulBossSignal = text.includes('powerful map boss');

  // Exact map-name exclusions (kept as explicit strings for future toggles).
  const EXCLUDED_MAP_NAMES = new Set([
    'seepage',
    'sun temple',
    'molten vault',
    'vaal city',
    'stronghold',
    'fortress',
    'forge',
    'augury',
    'hive',
    'crypt',
    'mesa',
	'bluff',
    'lost towers',
    'sinking spire',
	'blooming field',
    'epitaph',
    'savannah',
    'wayward isle',
    'pit',
    'trenches',
    'cliffside',
    'precursor tower'
  ]);
  // Substring (path/name) exclusions -- block ANY map whose name/path CONTAINS one of these (e.g. 'gateway' ->
  // Western Gateway, Eastern Gateway, ...). Use for FAMILIES of maps; exact short-names go in the Set above.
  const EXCLUDED_MAP_SUBSTRINGS = ['gateway'];
  const hasExactNameExclusion =
    EXCLUDED_MAP_NAMES.has(shortLower) ||
    EXCLUDED_MAP_NAMES.has(fullLower);
  const hasSubstringExclusion = EXCLUDED_MAP_SUBSTRINGS.some(s => text.includes(s));

  if (hasCitadelSignal) return { blocked: true, reason: 'citadel' };
  if (hasUniqueSignal) return { blocked: true, reason: 'unique' };
  if (hasMerchantSignal) return { blocked: true, reason: 'merchant' };
  if (hasPowerfulBossSignal && currentSettings.avoidPowerfulMapBoss !== false) {
    return { blocked: true, reason: 'powerful-map-boss' };
  }
  if (hasExactNameExclusion) return { blocked: true, reason: 'excluded-map-name' };
  if (hasSubstringExclusion) return { blocked: true, reason: 'excluded-map-substring' };
  if (hasSunTempleSignal) return { blocked: true, reason: 'sun-temple' };
  if (hasMoltenVaultSignal) return { blocked: true, reason: 'molten-vault' };
  if (hasVaalCitySignal) return { blocked: true, reason: 'vaal-city' };
  return { blocked: false, reason: '' };
}

function getAtlasNodeSelectionPriority(node) {
  if (!node) return 9999;
  const traits = (node.traits || []).map(t => `${t?.name || ''}`).join(' ');
  const text = `${node.shortName || ''} ${node.fullName || ''} ${node.worldAreaRef || ''} ${traits}`.toLowerCase();
  // Keep Powerful Map Boss maps as fallback picks (last).
  if (text.includes('powerful map boss')) return 1000;
  return 0;
}

function findFirstUncompletedNode() {
  const atlas = poe2.getAtlasNodes();
  if (!atlas || !atlas.isValid) return -1;
  const candidates = [];
  for (let i = 0; i < atlas.nodes.length; i++) {
    const n = atlas.nodes[i];
    if (!n.isUnlocked || n.isCompleted) continue;
    if (hideoutFailedNodeBlacklist.has(i)) continue;
    const decision = getAtlasNodeFilterDecision(n);
    if (decision.blocked) continue;
    candidates.push({ idx: i, prio: getAtlasNodeSelectionPriority(n) });
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => (a.prio - b.prio) || (a.idx - b.idx));
    return candidates[0].idx;
  }
  // If everything available is blacklisted, clear fail-blacklist once and try again.
  // This prevents hard lock if all visible nodes failed previously.
  if (hideoutFailedNodeBlacklist.size > 0) {
    hideoutFailedNodeBlacklist.clear();
    log('[Hideout] Cleared failed-node blacklist (no selectable nodes remained)');
    const retryCandidates = [];
    for (let i = 0; i < atlas.nodes.length; i++) {
      const n = atlas.nodes[i];
      if (!n.isUnlocked || n.isCompleted) continue;
      const decision = getAtlasNodeFilterDecision(n);
      if (decision.blocked) continue;
      retryCandidates.push({ idx: i, prio: getAtlasNodeSelectionPriority(n) });
    }
    if (retryCandidates.length > 0) {
      retryCandidates.sort((a, b) => (a.prio - b.prio) || (a.idx - b.idx));
      return retryCandidates[0].idx;
    }
  }
  // Helpful signal for why no node could be picked.
  const blockedByMapType = (atlas.nodes || []).some(n => {
    if (!n?.isUnlocked || n?.isCompleted) return false;
    return getAtlasNodeFilterDecision(n).blocked;
  });
  if (blockedByMapType) {
    log('[Hideout] No selectable atlas nodes: remaining available nodes are filtered (citadel/unique/merchant/excluded)');
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
  // slot_id for ctrlClickItem = the item's itemSlotHandle. LIVE-PROVEN 2026-06-22: the game's
  // real ctrl-click passes a2 = itemSlotHandle (NOT the grid index; ctrlClickItem(1,0) no-op'd).
  // slotId is a legacy probe that doesn't exist on current inventory items (harmless fallthrough).
  const slotId = Number(item?.slotId || 0);
  if (slotId > 0) return slotId;
  const slotHandle = Number(item?.itemSlotHandle || 0);
  if (slotHandle > 0) return slotHandle;
  return 0;
}

function getItemAddressRef(item) {
  const probes = [
    Number(item?.itemAddress || 0),
    Number(item?.address || 0),
    Number(item?.addr || 0),
    Number(item?.entityAddress || 0),
  ];
  for (const p of probes) {
    if (Number.isFinite(p) && p > 0) return p;
  }
  return 0;
}

function getItemModsFlags(item) {
  const out = {
    identifiedKnown: false,
    identified: false,
    corruptedKnown: false,
    corrupted: false,
    twiceCorrupted: false,
  };
  if (!item) return out;

  const applyMods = (mods) => {
    if (!mods || mods.isValid === false) return false;
    if (typeof mods.identified === 'boolean') {
      out.identifiedKnown = true;
      out.identified = mods.identified;
    }
    if (typeof mods.corrupted === 'boolean') {
      out.corruptedKnown = true;
      out.corrupted = mods.corrupted;
    }
    if (typeof mods.twiceCorrupted === 'boolean') {
      out.twiceCorrupted = mods.twiceCorrupted;
      if (mods.twiceCorrupted) {
        out.corruptedKnown = true;
        out.corrupted = true;
      }
    }
    return out.identifiedKnown || out.corruptedKnown || out.twiceCorrupted;
  };

  // Fast-path if item already carries component mods.
  if (applyMods(item.mods)) return out;

  // Component API fallback via item address from inventory reader.
  const itemAddr = getItemAddressRef(item);
  if (itemAddr > 0 && typeof poe2.getItemMods === 'function') {
    try {
      const mods = poe2.getItemMods(itemAddr);
      applyMods(mods);
    } catch (err) {
      // ignore; keep heuristic fallback in callers
    }
  }
  return out;
}

function getItemIdentificationInfo(item) {
  const modsInfo = getItemModsFlags(item);
  if (modsInfo.identifiedKnown) {
    return { identified: modsInfo.identified, known: true };
  }
  return { identified: false, known: false };
}

function getItemCorruptionInfo(item) {
  if (!item) return { corrupted: false, known: false };
  const modsInfo = getItemModsFlags(item);
  if (modsInfo.corruptedKnown || modsInfo.twiceCorrupted) {
    return {
      corrupted: !!modsInfo.corrupted || !!modsInfo.twiceCorrupted,
      known: true
    };
  }
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
  let candidates = [];
  const stats = {
    seenWaystones: 0,
    rarityRejected: 0,
    tierRejected: 0,
    missingTierParsed: 0,
    corruptedRejected: 0,
    corruptionUnknown: 0,
    unidentifiedRejected: 0,
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
    const identificationInfo = getItemIdentificationInfo(item);

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
      identified: identificationInfo.identified,
      identifiedKnown: identificationInfo.known,
      slotRef: getItemSlotRef(item),
    });
  }

  // Apply identified-only filter (STRICT, default ON): NEVER place an UNIDENTIFIED waystone.
  // We have the real ID flag now (getItemMods.identified via getItemModsFlags), so require
  // identifiedKnown && identified -- both unidentified AND unknown-id waystones are rejected.
  if (currentSettings.waystoneIdentifiedOnly !== false) {
    const beforeId = candidates.length;
    candidates = candidates.filter(c => c.identifiedKnown && c.identified);
    stats.unidentifiedRejected = beforeId - candidates.length;
  }

  // Apply corrupted-only filter (STRICT).
  // Require authoritative identified+corrupted data. Unknowns are rejected.
  const corruptedOnly = !!currentSettings.waystoneCorruptedOnly && !currentSettings.waystoneNonCorruptedOnly;
  const nonCorruptedOnly = !!currentSettings.waystoneNonCorruptedOnly;

  if (corruptedOnly && candidates.length > 0) {
    const knownCorruptedIdentified = candidates.filter(
      c => c.identifiedKnown && c.identified && c.corruptionKnown && c.corrupted
    );
    if (knownCorruptedIdentified.length === 0) {
      stats.corruptedRejected += candidates.filter(c => c.corruptionKnown && !c.corrupted).length;
      stats.corruptionUnknown += candidates.filter(c => !c.corruptionKnown).length;
      // Unidentified should never satisfy "corrupted only".
      stats.corruptionUnknown += candidates.filter(c => !c.identifiedKnown || !c.identified).length;
      return { candidates: [], stats };
    }
    stats.corruptedRejected += (candidates.length - knownCorruptedIdentified.length);
    return { candidates: knownCorruptedIdentified, stats };
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
  // Open a town portal. Opcode shifted 00 C4 -> 00 CF in the 2026-06 patch (re-captured live).
  const packet = new Uint8Array([0x00, 0xCF, 0x01]);
  return poe2.sendPacket(packet);
}

// Map-device holders (LIVE-CONFIRMED 2026-06-22): waystone = inventory id 14 ("Map1"),
// tablets = inventory id 77 ("Relics1"). Reading these directly is far more reliable than the
// visible-UI heuristic. ctrlClickItem(1, item.itemSlotHandle) places; the game routes by type.
const DEVICE_WAYSTONE_INV = 14;
const DEVICE_TABLET_INV = 77;

function getMapDeviceState() {
  const out = { waystoneCount: 0, tabletCount: 0, waystones: [], tablets: [], direct: false };
  try {
    const w = poe2.getInventory(DEVICE_WAYSTONE_INV);
    if (w && w.isValid) {
      out.direct = true;
      out.waystones = (w.items || []).filter(it => it && it.hasItem);
      out.waystoneCount = out.waystones.length;
    }
    const t = poe2.getInventory(DEVICE_TABLET_INV);
    if (t && t.isValid) {
      out.direct = true;
      out.tablets = (t.items || []).filter(it => it && it.hasItem);
      out.tabletCount = out.tablets.length;
    }
  } catch (e) {}
  return out;
}

function tpmWaystoneSlotHasItem() {
  // Proven path: the waystone holder is inventory id 14 - read it directly.
  const dev = getMapDeviceState();
  if (dev.direct) return dev.waystoneCount > 0;

  // Fallback (older/other devices where inv 14 isn't exposed): visible-UI heuristic.
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
  // Proven path: read holders directly (waystone=inv 14, tablets=inv 77).
  const dev = getMapDeviceState();
  if (dev.direct) {
    return {
      hasWaystone: dev.waystoneCount > 0,
      precursorCount: dev.tabletCount,
      invs: [
        { inventoryId: DEVICE_WAYSTONE_INV, inventoryName: 'Map1', uiPath: 'direct', items: dev.waystones },
        { inventoryId: DEVICE_TABLET_INV, inventoryName: 'Relics1', uiPath: 'direct', items: dev.tablets },
      ],
      waystones: dev.waystones.map(item => ({
        name: item.baseName || item.uniqueName || 'Waystone',
        slotRef: getItemSlotRef(item),
        tier: extractWaystoneTier(item),
        rarity: item.rarity,
      })),
    };
  }

  // Fallback: legacy visible-UI heuristic.
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
            const modsInfo = getItemModsFlags(w);
            log(
              `  - ${w.baseName || w.uniqueName || 'Waystone'} ` +
              `isCorrupted=${String(w.isCorrupted)} corrupted=${String(w.corrupted)} ` +
              `corruptionState=${String(w.corruptionState)} flags=${String(w.flags)} state=${String(w.state)} ` +
              `mods.ident=${modsInfo.identifiedKnown ? String(modsInfo.identified) : 'unknown'} ` +
              `mods.corrupt=${modsInfo.corruptedKnown ? String(modsInfo.corrupted) : 'unknown'} ` +
              `mods.twice=${String(!!modsInfo.twiceCorrupted)}`
            );
          }
        }
      }
      log(
        `[Hideout] Waystone scan found no candidates: ` +
        `seen=${stats.seenWaystones}, rarityRejected=${stats.rarityRejected}, tierRejected=${stats.tierRejected}, ` +
        `missingTierParsed=${stats.missingTierParsed}, corruptedRejected=${stats.corruptedRejected}, ` +
        `corruptionUnknown=${stats.corruptionUnknown}, unidentifiedRejected=${stats.unidentifiedRejected}, ` +
        `minTier=${minTier}, maxTier=${maxTier}, ` +
        `identifiedOnly=${currentSettings.waystoneIdentifiedOnly !== false}, ` +
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

// Canonical PoE2 tablet (TowerAugment) types. An item's baseName already reads e.g.
// "Breach Tablet", so name matching is direct; only the path metadata name differs for some
// (Temple's path is "Incursion", not "Temple"). getTabletName(item) -> canonical name or ''.
const TABLET_NAMES = [
  'Abyss Tablet', 'Breach Tablet', 'Delirium Tablet', 'Expedition Tablet',
  'Irradiated Tablet', 'Temple Tablet', 'Overseer Tablet', 'Ritual Tablet',
];
const TABLET_PATH_TO_NAME = {
  // CONFIRMED from live items 2026-06-22:
  breachaugment: 'Breach Tablet',
  incursionaugment: 'Temple Tablet',     // Temple mechanic = Incursion in the metadata path
  // Inferred (auto-confirmed at runtime the first time such a tablet is seen):
  abyssaugment: 'Abyss Tablet',
  deliriumaugment: 'Delirium Tablet',
  expeditionaugment: 'Expedition Tablet',
  irradiatedaugment: 'Irradiated Tablet',
  overseeraugment: 'Overseer Tablet',
  ritualaugment: 'Ritual Tablet',
};
function getTabletName(item) {
  if (!item) return '';
  const base = (item.baseName || item.uniqueName || '').trim();
  // baseName is already the display name -> match the canonical list directly (case-insensitive).
  const hit = TABLET_NAMES.find(n => n.toLowerCase() === base.toLowerCase());
  if (hit) return hit;
  // Derive from path: Metadata/Items/TowerAugment/<X>Augment (handles a missing/localized name).
  const path = (item.itemPath || '').toLowerCase();
  const m = path.match(/toweraugment\/([a-z0-9]+)/);
  if (m) {
    const key = m[1].endsWith('augment') ? m[1] : m[1] + 'augment';
    if (TABLET_PATH_TO_NAME[key]) return TABLET_PATH_TO_NAME[key];
  }
  // A tablet we don't have catalogued yet but is clearly a tablet.
  if (/tablet/i.test(base)) return base;
  return '';
}

// Per-type tablet enable (checkbox). Default ON unless explicitly unchecked.
function tabletSettingKey(name) { return 'tablet' + String(name).replace(/[^A-Za-z0-9]/g, ''); }
function isTabletEnabled(name) { return currentSettings[tabletSettingKey(name)] !== false; }

// Find a tablet in the bag that is (a) a CHECKED type and (b) not already in the device.
// presentTypes = Set of canonical names already in the tablet holder (1 per type allowed):
// if a type is already in a slot we never place a duplicate; we only fill with a checked type
// that isn't present yet.
function findTabletToPlace(presentTypes) {
  const inv = poe2.getInventory(1);
  if (!inv || !inv.isValid || !inv.items) return null;
  const acceptedRarities = getAcceptedPrecursorRarities();
  for (const item of inv.items) {
    if (!item || !item.hasItem) continue;
    const tname = getTabletName(item);
    if (!tname) continue;                                   // not a tablet
    if (!isTabletEnabled(tname)) continue;                  // type unchecked in the UI
    if (presentTypes && presentTypes.has(tname)) continue;  // already one of this type in device
    if (acceptedRarities.length && !acceptedRarities.includes(item.rarity)) continue;
    return { item, tname };
  }
  return null;
}

function findPrecursorInInventory() {
  const inv = poe2.getInventory(1);
  if (!inv || !inv.isValid || !inv.items) return null;
  const acceptedRarities = getAcceptedPrecursorRarities();

  for (const item of inv.items) {
    if (!item.hasItem) continue;
    const path = (item.itemPath || '').toLowerCase();
    const name = (item.baseName || '').toLowerCase();
    // Tablets live under Metadata/Items/TowerAugment/* and are named "<X> Tablet"
    // (e.g. Breach/Temple Tablet) - the old "precursor"-only filter never matched them.
    const isTablet = path.includes('toweraugment') || path.includes('precursor') ||
                     name.includes('tablet') || name.includes('precursor');
    if (!isTablet) continue;
    if (!acceptedRarities.includes(item.rarity)) continue;
    return item;
  }
  return null;
}

// AFK SAFETY: is the main inventory (id 1) FULL -- i.e. <= inventoryFullStopFreeCells free 1x1 cells? Builds the
// grid occupancy from each item's slotX/Y + width/height (de-duped via a Set, robust to per-cell or per-item
// lists). Cached 2s (getInventory is a bit heavy). Returns false on any read failure (never false-stop).
let _invFullCacheAt = -99999, _invFullCacheVal = false, _invFullLogAt = 0;
function hideoutInventoryFull(now) {
  if (now - _invFullCacheAt < 2000) return _invFullCacheVal;
  _invFullCacheAt = now;
  let full = false;
  try {
    const inv = poe2.getInventory(1);
    if (inv && inv.isValid && Array.isArray(inv.items)) {
      const W = inv.totalBoxesX || 12, H = inv.totalBoxesY || 5;
      const occ = new Set();
      for (const it of inv.items) {
        if (!it || !it.hasItem) continue;
        const sx = it.slotX | 0, sy = it.slotY | 0, w = Math.max(1, it.width | 0), h = Math.max(1, it.height | 0);
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) {
          const cx = sx + dx, cy = sy + dy;
          if (cx >= 0 && cx < W && cy >= 0 && cy < H) occ.add(cy * W + cx);
        }
      }
      const free = (W * H) - occ.size;
      const thr = Number(currentSettings.inventoryFullStopFreeCells ?? 2);
      full = free <= thr;
      if (full && now - _invFullLogAt > 15000) { _invFullLogAt = now; log(`[Hideout] STOP: inventory full (${free} free cells <= ${thr}) -> waiting for you to clear space (auto-resumes)`); }
    }
  } catch (e) {}
  _invFullCacheVal = full;
  return full;
}

function processHideoutFlow(now) {
  if (!isMapperMasterEnabled()) {
    if (currentState.startsWith('HIDEOUT_')) {
      log('[Hideout] Master mapper toggle OFF - stopping hideout flow');
      resetMapper();
    }
    return;
  }

  // AFK SAFETY (user request): STOP starting/entering maps while the main inventory is FULL so loot isn't
  // wasted. Holds in the hideout with a clear status, and AUTO-RESUMES the moment you clear space.
  if (currentSettings.stopWhenInventoryFull !== false && hideoutInventoryFull(now)) {
    statusMessage = 'STOPPED: inventory full -- clear space to continue (auto-resumes)';
    return;
  }

  // Cooldown between actions to let UI/game respond
  if (now - hideoutLastActionTime < HIDEOUT_ACTION_COOLDOWN_MS) return;

  switch (currentState) {
    case STATE.HIDEOUT_CHECK_PORTALS: {
      const activePortal = findActiveMapPortal();
      if (activePortal) {
        if (now < hideoutSkipExistingPortalUntil) {
          const remain = ((hideoutSkipExistingPortalUntil - now) / 1000).toFixed(1);
          log(`Active portal present but skipped (${remain}s post-complete window left)`);
        } else {
          log('Active map portal found - will enter it');
          setState(STATE.HIDEOUT_ENTER_PORTAL);
          return;
        }
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
      // The device interact TOGGLES the atlas, so NEVER re-fire it rapidly -- that was the open/close spam.
      // One interact, then wait for the panel; only retry after a real cooldown.
      if (now - hideoutMapDeviceInteractAt < 4000) {
        statusMessage = 'Opening atlas (interact cooldown)...';
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
      interactWithEntity(mapDevice);                        // 01 A3 press
      poe2.sendPacket(new Uint8Array([0x01, 0xAA, 0x01]));  // 01 AA 01 release -- BOTH are required;
      // press alone just toggles/flashes the device without opening the atlas (matches openMapDevice()).
      hideoutMapDeviceInteractAt = now;
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
              `identified=${c.identifiedKnown ? (c.identified ? 'yes' : 'no') : 'unknown'} ` +
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
        `identified=${waystone.identifiedKnown ? (waystone.identified ? 'yes' : 'no') : 'unknown'} ` +
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
            // This node won't take the waystone (quest/Burning-Monolith traverse node, or a flaky TPM). Don't give
            // up -- try a DIFFERENT available node. Cap at 3 DIFFERENT nodes total, THEN suspend.
            hideoutNodeRetryCount++;
            if (hideoutNodeRetryCount >= 3) {
              setHideoutSuspended(
                HIDEOUT_SUSPEND_REASON.TPM_SLOT_NOT_DETECTED,
                `No waystone accepted after trying ${hideoutNodeRetryCount} different nodes`
              );
              return;
            }
            blacklistCurrentHideoutNode(`waystone not accepted (TPM slot empty after ${hideoutWaystoneMoveAttempts} attempts)`);
            hideoutWaystoneMoveAttempts = 0;
            hideoutWaystonePlaced = false;
            log(`[Hideout] Waystone not accepted on node ${hideoutSelectedNodeIndex} -> trying a DIFFERENT node (${hideoutNodeRetryCount}/3)`);
            setState(STATE.HIDEOUT_OPEN_MAP_DEVICE);   // re-establish atlas + findFirstUncompletedNode skips the blacklisted node
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
      const TABLET_SLOTS = 3;  // device tablet slots; 1 of each distinct type, no duplicates

      // Read the tablet holder (inv 77): which TYPES are already in, and how many.
      const dev = getMapDeviceState();
      const presentTypes = new Set((dev.tablets || []).map(getTabletName).filter(Boolean));
      if (dev.direct) hideoutPrecursorsPlaced = dev.tabletCount;  // verification-based count

      if (hideoutPrecursorsPlaced >= TABLET_SLOTS) {
        log(`Tablet slots full (${hideoutPrecursorsPlaced}/${TABLET_SLOTS}: [${[...presentTypes].join(', ')}]), activating map`);
        setState(STATE.HIDEOUT_ACTIVATE_MAP);
        return;
      }

      poe2.ensureUiVisible([1, 29, 5, 35]);

      // Pick a CHECKED tablet type that isn't already in the device (1 per type).
      const pick = findTabletToPlace(presentTypes);
      if (!pick) {
        log(`No eligible tablet to place (in device: [${[...presentTypes].join(', ')}], ${hideoutPrecursorsPlaced}/${TABLET_SLOTS}), activating map`);
        setState(STATE.HIDEOUT_ACTIVATE_MAP);
        return;
      }

      // Cooldown between placements
      if (now - hideoutLastActionTime < HIDEOUT_ACTION_COOLDOWN_MS) return;

      const tabletSlotRef = getItemSlotRef(pick.item);
      log(`Placing tablet ${pick.tname} (slot ${hideoutPrecursorsPlaced + 1}/${TABLET_SLOTS}, rarity=${rarityName(pick.item.rarity)}, handle=${tabletSlotRef})`);
      const moved = tabletSlotRef > 0 ? poe2.ctrlClickItem(1, tabletSlotRef) : false;
      hideoutLastActionTime = now;
      if (!moved) {
        log(`Failed to place tablet ${pick.tname} (slotRef=${tabletSlotRef}) - will retry next tick`);
      }
      // Stay in this state: next tick re-reads the device (present types + count) and places the next.
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

      // Close atlas between map activation and portal entry so UI does not block
      // portal interaction. Prefer dedicated API when available.
      if (typeof poe2.closeAtlas === 'function') {
        const closed = poe2.closeAtlas();
        log(`[Hideout] closeAtlas() after activation -> ${closed}`);
      } else {
        // Backward compatibility fallback.
        poe2.ensureUiVisible([1, 22], false);
        log('[Hideout] Hid atlas panel after activation packet (fallback)');
      }

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
        // 3 traverse attempts, still no portal -> this node won't activate (e.g. "You do not have the required
        // quest state to access this Map" -- a quest-locked node). Retrying the SAME node never works, so don't
        // suspend: blacklist it and START A DIFFERENT map node. Mirrors the failed-portal-entry recovery below.
        blacklistCurrentHideoutNode(`no portal after ${hideoutTraverseAttempts} traverse attempts (quest-locked map?)`);
        log(`[Hideout] No portal after ${hideoutTraverseAttempts} traverse attempts (likely quest-locked map). Blacklisting node + starting a DIFFERENT map.`);
        hideoutPortalEnterAttempts = 0;
        hideoutTraverseAttempts = 0;
        hideoutWaystonePlaced = false;
        hideoutPrecursorsPlaced = 0;
        hideoutSelectedNodeIndex = -1;
        hideoutActivationKey = null;
        setState(STATE.HIDEOUT_OPEN_MAP_DEVICE);
        return;
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
      const enterDelayMs = Math.max(0, Math.floor(Number(currentSettings.hideoutPortalEnterDelayMs || 0)));
      const waitedMs = now - stateStartTime;
      if (waitedMs < enterDelayMs) {
        statusMessage = `Portal spawned, entering in ${((enterDelayMs - waitedMs) / 1000).toFixed(1)}s...`;
        return;
      }
      hideoutPortalEnterAttempts++;
      log(`Entering map portal (id=${portal.id}) attempt=${hideoutPortalEnterAttempts}`);
      const ok = interactWithEntity(portal);
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

// PRIMARY boss locator: centroid of all boss-arena terrain tiles (getTgtLocations keys matching /boss/).
// Present AT MAP ENTRY (terrain, not streamed) -> reliable boss destination from the start. Cached per area.
let _bossArenaCentroid = null;   // null = uncomputed, false = computed-empty, {gx,gy} = found
let _bossArenaArea = -1;
// FIND-layer: the curated BossRoom minimap icon -> a real from-afar boss bearing (C++ surfaces its Positioned grid coords
// even while sleeping). Previously read by FINDING_BOSS only as a "farthest content marker" and EXCLUDED, so it was wasted.
function getBossRoomMarker() {
  try {
    for (const m of (poe2.getQuestMarkers() || [])) {
      const gx = m.gridX || 0, gy = m.gridY || 0;
      if ((!gx && !gy) || Math.hypot(gx, gy) < 40) continue;   // origin-junk
      if (/BossRoom|Endgame.*Boss/i.test(m.path || '')) return { gx, gy };
    }
  } catch (e) {}
  return null;
}

// USER idea (signal-less maps): with NO boss bearing, head toward a known CONTENT landmark to GET SOMEWHERE + reveal the
// map + keep looking for the boss en route. Pure NAV target (the content rotation engages it if we arrive). Picks the
// NEAREST quest/content marker that is a real destination -- excludes the Checkpoint/Portal/Waypoint we spawned at so we
// never head back where we came from, and skips anything <150u (already there).
function getExploreLandmark(player) {
  try {
    let best = null, bestD = Infinity;
    for (const m of (poe2.getQuestMarkers() || [])) {
      const gx = m.gridX || 0, gy = m.gridY || 0;
      if (!gx && !gy) continue;
      if (/Checkpoint|Portal|Waypoint|TownPortal|\/Town/i.test(m.path || '')) continue;
      const d = Math.hypot(gx - player.gridX, gy - player.gridY);
      if (d < 150) continue;
      if (d < bestD) { bestD = d; best = { gx, gy }; }
    }
    return best;
  } catch (e) {}
  return null;
}

function getBossArenaCentroid() {
  const ac = POE2Cache.getAreaChangeCount();
  if (ac !== _bossArenaArea) { _bossArenaCentroid = null; _bossArenaArea = ac; }
  if (_bossArenaCentroid !== null) return _bossArenaCentroid || null;
  try {
    const t = poe2.getTgtLocations();
    if (!t || !t.isValid || !t.locations) return null;        // terrain not ready yet -> retry next call
    const L = t.locations; let sx = 0, sy = 0, n = 0;
    for (const k in L) { if (!/boss/i.test(k)) continue; const a = L[k]; for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i].x) < 40 && Math.abs(a[i].y) < 40) continue;     // skip origin-junk tiles (unstreamed -> (0,0))
      sx += a[i].x; sy += a[i].y; n++;
    } }
    const c = n ? { gx: sx / n, gy: sy / n } : null;
    // Reject a near-origin centroid -- a real boss arena is never at the grid corner; that's origin-junk pollution
    // (the 'Boss Melee Forward Push (15,53)' yoyo: the bot shoves at an empty corner forever).
    _bossArenaCentroid = (c && Math.hypot(c.gx, c.gy) >= 80) ? c : false;
    return _bossArenaCentroid || null;
  } catch (e) { return null; }
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
  // Only record reveal when we actually MOVED (~>10u): marking a 144u patch every tick while wedged floods
  // the visited grid and starves the frontier picker (it then re-targets behind the same obstacle).
  if (!Number.isFinite(lastFrontierMarkX) ||
      (player.gridX - lastFrontierMarkX) ** 2 + (player.gridY - lastFrontierMarkY) ** 2 > 100) {
    markFrontierVisited(player.gridX, player.gridY);
    lastFrontierMarkX = player.gridX; lastFrontierMarkY = player.gridY;
  }

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
    // Re-entered a map from a non-map area: reclear ANY leftover state (not just HIDEOUT_ -- a stale
    // WALKING_TO_BOSS_MELEE after death->hideout->new-map leaks through the old HIDEOUT_-only check).
    if (currentState !== STATE.IDLE) {
      log('Area guard: re-entered map with stale state ' + currentState + ' -> resetting');
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

  // Auto-dodge (folded-in AutoDodge core). Gated to BOSS fights only by default (autoDodgeBossOnly) --
  // dodge the boss's telegraphs/ground/projectiles, but DON'T waste dodges on trash during map clear.
  // Runs BEFORE the state throttle so it reacts fast; self-gated (100ms scan / 1800ms between rolls).
  // mode: boss fight -> 'boss' (ALL categories incl. ground + hazard-monsters like exploding mushrooms);
  // engaging a rare/unique -> 'rare' (projectiles + melee cones + telegraphs, NO ground/hazard); else 'off'.
  // Forced per the user's category list (no boss-only toggle): boss fight -> 'boss' (telegraphs + ground +
  // hazard-monster mushrooms); engaging a rare/unique -> 'rare' (telegraphs + projectiles + melee cones, no
  // ground/hazard); else 'off'. The CORE enforces which categories fire per mode.
  const inBossDodge = currentState === STATE.FIGHTING_BOSS || currentState === STATE.WALKING_TO_BOSS_MELEE;
  // 'rare' mode whenever a rare/unique is CLOSE (swinging at us) -- NOT only while the rotation chases one.
  // Independent of clearRares (dodging != engaging). autoDodgeEnabled still gates the whole block below.
  const dodgeMode = inBossDodge ? 'boss' : (rareUniqueNear(now) ? 'rare' : 'off');
  if (inBossDodge || dodgeMode === 'rare') {   // TEMP diag: see state+mode whenever a boss/unique is up
    if (now - _dodgeDiagAt > 1500) { _dodgeDiagAt = now; log(`[DodgeDiag] state=${currentState} mode=${dodgeMode} dodgeOn=${currentSettings.autoDodgeEnabled !== false}`); }
  }
  if (currentSettings.autoDodgeEnabled && dodgeMode !== 'off') {
    autoDodgeCfg.mode = dodgeMode;
    autoDodgeCfg.bossEngaged = currentState === STATE.FIGHTING_BOSS;   // gate the boss-proximity dodge safety net to the FIGHT only (not the melee walk-in)
    // Feed the nav target so the dodge biases TOWARD it while approaching (anti-yoyo); null when there's no real target.
    const _hasDodgeGoal = Number.isFinite(targetGridX) && (targetGridX !== 0 || targetGridY !== 0);
    autoDodgeCfg.goalX = _hasDodgeGoal ? targetGridX : null;
    autoDodgeCfg.goalY = _hasDodgeGoal ? targetGridY : null;
    autoDodgeCfg.debug = true; autoDodgeCfg.log = log;   // TEMP: log boss-doing vs dodge-sees (compare per your ask)
    try {
      if (runAutoDodge(autoDodgeCfg)) {
        const _we = autoDodgeStatus().walkEgress;
        if (_we && Number.isFinite(_we.dx)) {
          // WALK-OUT: one roll won't clear this hazard (overlapping field). Keep MOVING out along the escape heading
          // instead of going passive, so we don't sit ticking in the cloud between rolls.
          sendMoveGridLimited(_we.dx, _we.dy, true);   // force past the dodge-suppress
          dodgeMoveSuppressUntil = now + 140;          // short pause, movement resumes fast (vs the usual 520)
        } else {
          dodgeMoveSuppressUntil = now + 520;
        }
      }
    } catch (e) { /* auto_dodge_core unavailable */ }
  }

  // Keep non-fight states fully responsive; throttle only boss fight logic.
  const logicInterval = currentState === STATE.FIGHTING_BOSS
    ? (fightLastNearbyMonsterCount > 220 ? 250 : (fightLastNearbyMonsterCount > 140 ? 220 : 190))
    : 150;  // throttle non-fight logic to ~7 Hz (was 0 = full-speed scans/pathing every frame -> tanked FPS)
  if (now - lastMapperLogicTime < logicInterval) return;
  lastMapperLogicTime = now;

  // The Forgotten Prisoner: interact the Runic Seals (BossChainAnchor) to RELEASE the chained boss BEFORE
  // engaging it. No-op on every other map (returns false unless the boss render name is present).
  if (runRunicSeals(player, now)) return;

  // CONTENT ROTATION priority: stay and engage nearby rares/uniques, else go to the NEAREST incomplete
  // content mechanic (incursion/delirium/breach) -- all via old-school straight-line nav with per-step
  // timeouts. Runs before the switch in any non-boss state and preempts the frame while work remains.
  // P1 REWORK: keep the spotted-content QUEUE warm (flag-on-spot). Always-on shadow; P2/P3 read it when REWORK_ARBITER.
  if (!String(currentState).startsWith('HIDEOUT_') && currentState !== STATE.IDLE
      && currentState !== STATE.FIGHTING_BOSS && currentState !== STATE.WALKING_TO_BOSS_MELEE) {   // PERF: skip the plural finders (3 full getEntities) during boss-engage -- the most FPS-sensitive frames; content is re-spotted after the fight
    try { populateContentQueue(player, now); } catch (e) {}
  }
  // P3 REWORK: re-validate the engaged-lock EVERY frame (TTL cap + done-signal) so an unreachable locked item releases.
  if (REWORK_ARBITER) { try { frameLockStillValid(now); } catch (e) { frameLock = null; } }

  const inBossEngage = currentState === STATE.FIGHTING_BOSS || currentState === STATE.WALKING_TO_BOSS_MELEE;
  if (!inBossEngage && !String(currentState).startsWith('HIDEOUT_')) {
    // VERISIUM far-walk yield (USER 2026-06-27): while only WALKING to a remnant we haven't engaged (>100u away,
    // not reached/opened), let a nearby shrine/utility go FIRST so we don't blow past it. tryStartUtilityNavigation
    // returns true only if it actually took over (-> WALKING_TO_UTILITY, stepped by the switch below); in that case
    // skip the rotation so exp2 doesn't immediately re-preempt. No utility nearby -> rotation runs, verisium walk continues.
    const exp2FarWalkYield = exp2Phase === 'walk' && exp2ClearAt === 0 && exp2CurDist > 100 && tryStartUtilityNavigation(player, now);
    if (!exp2FarWalkYield && runContentRotation(player, now)) return;
  } else if (currentState === STATE.WALKING_TO_BOSS_MELEE) {
    // G1 (user grievance): once we enter boss-melee the content rotation stops, so an OPENED/stabilised breach
    // gets abandoned and a nearby Vaal Beacon gets skipped ("swapped to MELEE too soon cuz they were all
    // compacted"). While APPROACHING the boss, finish content OBJECTIVES first (breach roam + vaal/incursion/
    // abyss/delirium) -- skipRares so we don't chase trash forever instead of reaching the boss. FIGHTING_BOSS
    // stays boss-only (don't leave an engaged boss). When content is clear this returns false -> melee proceeds.
    if (runContentRotation(player, now, /*skipRares=*/true)) return;
  }

  // Priority order:
  // 1) movement lock (handled above)
  // 2) core mapper state machine
  // 3) utility walk state

  // P4 REWORK (flag-on): FAR-content EXPLORE fallback. When hunting the boss with NO bearing AND no engaged lock AND no
  // utility in progress, a FAR-flagged objective (classifyObjective FLAGged it -- too far to chase now) would otherwise
  // be abandoned while the boss-explore wanders the frontier away from it. Walk TOWARD the nearest one so it promotes to
  // MID/NEAR and gets cleared. Walk-commit LATCH (review fix): re-path only on a NEW target / after >1.5s, never per tick.
  if (REWORK_ARBITER && currentState === STATE.FINDING_BOSS && !frameLock && !utilityActiveTarget && !resolveBossBearing(player, now)) {
    let far = null;
    for (const e of contentQueue.values()) {
      if (e.state !== 'active' || lockIsDone(e.type, e.id, now)) continue;
      const d = Math.hypot((e.gridX || 0) - player.gridX, (e.gridY || 0) - player.gridY);
      if (d >= MID_LIMIT && (!far || d < far.d)) far = { e, d };
    }
    if (far) {
      if ((targetName !== 'Content Explore' || Math.hypot(targetGridX - far.e.gridX, targetGridY - far.e.gridY) > 60 || currentPath.length === 0) && now - lastRepathTime > 1500) {
        startWalkingTo(far.e.gridX, far.e.gridY, 'Content Explore', 'explore');
      }
      stepPathWalker();
      statusMessage = `Exploring toward flagged ${far.e.type} ${far.d.toFixed(0)}u (so it gets cleared)`;
      return;
    }
  }

  if (tryStartUtilityNavigation(player, now)) {
    // Utility state can start from any non-critical mapping state.
  }

  switch (currentState) {
    case STATE.IDLE:
      // Boss-only mapping: skip the temple flow entirely, go straight to the boss.
      setState(STATE.FINDING_BOSS);
      break;

    case STATE.FINDING_TEMPLE: {
      if (isMapObjectiveComplete()) {   // MAP-OBJECTIVE GATE: map done -> don't go hunting the temple -> finish
        log('Map objective complete -> stop finding temple -> map complete');
        setState(STATE.MAP_COMPLETE); break;
      }
      pruneTempleUnreachableTargets(now);
      if (templeOptionalSearchStartAt === 0) templeOptionalSearchStartAt = now;
      if (templeOptionalSearchStartX === 0 && templeOptionalSearchStartY === 0) {
        templeOptionalSearchStartX = player.gridX;
        templeOptionalSearchStartY = player.gridY;
      }
      const optionalTravel = Math.hypot(player.gridX - templeOptionalSearchStartX, player.gridY - templeOptionalSearchStartY);
      if (optionalTravel > templeOptionalSearchMaxDist) templeOptionalSearchMaxDist = optionalTravel;
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
            nameContains: 'EncounterChest',  // rename-proof (LeagueIncursion -> LeagueIncursionNew, 0.5.4)
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
        const templeRequirement = getTempleObjectiveRequirement();
        const templeSearchMs = now - stateStartTime;
        const optionalSearchMs = now - templeOptionalSearchStartAt;
        const OPTIONAL_TEMPLE_MIN_SEARCH_MS = 60000;
        const OPTIONAL_TEMPLE_MIN_TRAVEL_DIST = 650;
        if (
          templeRequirement === 'optional' &&
          optionalSearchMs > OPTIONAL_TEMPLE_MIN_SEARCH_MS &&
          templeOptionalSearchMaxDist >= OPTIONAL_TEMPLE_MIN_TRAVEL_DIST
        ) {
          templeCleared = true;
          log(
            `No temple objective for this map after ${(optionalSearchMs / 1000).toFixed(0)}s ` +
            `and ${templeOptionalSearchMaxDist.toFixed(0)}u explored; moving to boss`
          );
          setState(STATE.FINDING_BOSS);
          break;
        }
        if (templeLocBlocked && now - lastTempleUnreachableLogTime > 1400) {
          log(`Temple target temporarily blocked (${templeLoc.x.toFixed(0)}, ${templeLoc.y.toFixed(0)}), exploring other lanes`);
          lastTempleUnreachableLogTime = now;
        }
        runTempleSearchExploration(player, now, templeLocBlocked ? 'target blocked' : '');
      }
      break;
    }

    case STATE.WALKING_TO_TEMPLE: {
      if (isMapObjectiveComplete()) {   // MAP-OBJECTIVE GATE: map done -> stop walking to the temple -> finish
        log('Map objective complete -> stop walking to temple -> map complete');
        setState(STATE.MAP_COMPLETE); break;
      }
      if (isIncursionObjectiveComplete()) {
        templeCleared = true;
        usingBossFallback = false;
        templeStuckTime = 0;
        templeCenterApproachStartTime = 0;
        if (bossDead || isMapObjectiveComplete()) {
          log('Temple already cleared while walking to temple -> map complete');
          setState(STATE.MAP_COMPLETE);
        } else {
          log('Temple already cleared while walking to temple -> switching to boss flow');
          setState(STATE.FINDING_BOSS);
        }
        break;
      }
      if (templeCleared) {
        // Strict temple contract: if we found temple, do not trust stale cleared flag
        // unless the objective actually reports completion.
        templeCleared = false;
      }
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
      const templeRequirement = getTempleObjectiveRequirement();
      const distToTempleObjective = Math.hypot(player.gridX - templeGridX, player.gridY - templeGridY);
      const allowTempleRouteBossInterrupt =
        templeCleared ||
        templeRequirement === 'optional' ||
        distToTempleObjective <= 120;
      if (nearbyBossCandidate && isLikelyMapBossEntity(nearbyBossCandidate, nearbyBossSignal)) {
        if (!allowTempleRouteBossInterrupt) {
          if (now - lastTempleBossBypassLogTime > 1800) {
            const n = (nearbyBossCandidate.renderName || nearbyBossCandidate.name || 'Unknown').split('/').pop();
            log(
              `Ignoring boss-like unique "${n}" while routing to required temple ` +
              `(distToTemple=${distToTempleObjective.toFixed(0)})`
            );
            lastTempleBossBypassLogTime = now;
          }
        } else {
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
          log(
            `Boss encountered en route to temple at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)}) ` +
            `dist=${distToCandidate.toFixed(0)} -> switching to FINDING_BOSS (checkpoint-first gate)`
          );
          setState(STATE.FINDING_BOSS);
        } else {
          log(
            `Boss-like unique seen during temple walk but too far for direct melee ` +
            `(dist=${distToCandidate.toFixed(0)}). Switching to FINDING_BOSS first.`
          );
          setState(STATE.FINDING_BOSS);
        }
        break;
        }
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
      // MAP-OBJECTIVE GATE (user: "things had to be GATED AROUND map's objectives completed"): once the MAP objective is
      // TICKED (e.g. the boss kill completed the map), STOP grinding the optional temple/beacon and finish -- don't wait
      // on the incursion SUB-objective, the map is already done.
      if (isMapObjectiveComplete()) {
        log('Map objective complete -> stop clearing temple -> map complete');
        templeCleared = true; templeClearStartTime = 0; templeNoHostilesSince = 0; templeCenterApproachStartTime = 0; usingBossFallback = false;
        setState(STATE.MAP_COMPLETE);
        break;
      }
      const incursionDone = isIncursionObjectiveComplete();
      if (incursionDone) {
        templeCleared = true;
        templeCenterApproachStartTime = 0;
        templeClearStartTime = 0;
        templeNoHostilesSince = 0;
        usingBossFallback = false;
        if (bossDead || isMapObjectiveComplete()) {
          log('Temple already cleared while in clear state -> map complete');
          setState(STATE.MAP_COMPLETE);
        } else {
          log('Temple already cleared while in clear state -> switching to boss flow');
          setState(STATE.FINDING_BOSS);
        }
        break;
      }
      if (templeCleared && !incursionDone) {
        templeCleared = false;
      }
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
          nameContains: 'EncounterChest',  // rename-proof (LeagueIncursion -> LeagueIncursionNew, 0.5.4)
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
        // Strict objective gating: beacon/chest/buff is a useful signal, but we
        // only leave temple once map objectives report Incursion complete.
        if (now - lastTempleUnreachableLogTime > 2500) {
          log('Beacon energised; waiting for Incursion objective completion');
          lastTempleUnreachableLogTime = now;
        }
      }

      // Safety timeout: keep searching/holding temple, do not skip objective.
      if (timeInState > 60000) {
        if (now - lastTempleUnreachableLogTime > 3000) {
          log(`Temple still not complete after ${(timeInState / 1000).toFixed(0)}s; continuing until Incursion objective is done`);
          lastTempleUnreachableLogTime = now;
        }
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
          if (now - lastTempleUnreachableLogTime > 2500) {
            log(`Temple room clear fallback hit (${(noHostilesMs / 1000).toFixed(0)}s), waiting for objective completion`);
            lastTempleUnreachableLogTime = now;
          }
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

          // If center cannot be reached for a while after room is already clear, keep trying.
          if (centerApproachMs > 14000) {
            if (now - lastTempleUnreachableLogTime > 2500) {
              log(`Temple center unreachable for ${(centerApproachMs / 1000).toFixed(0)}s, rotating search lane`);
              lastTempleUnreachableLogTime = now;
            }
            templeCenterApproachStartTime = now - 6000;
          }
        } else {
          // AT the center - start/continue waiting for beacon to activate
          templeCenterApproachStartTime = 0;
          if (templeClearStartTime === 0) {
            templeClearStartTime = now;
            log(`At temple center, waiting for beacon activation...`);
          }

          const waitTime = now - templeClearStartTime;

          // Hold at center; do not leave until objective confirms completion.
          if (waitTime >= 8000) {
            if (now - lastTempleUnreachableLogTime > 2500) {
              log('Beacon wait exceeded 8s at center, continuing to hold for Incursion objective');
              lastTempleUnreachableLogTime = now;
            }
            templeClearStartTime = now - 3000;
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
      // Delirium: walk INTO the start mirror first (activates Delirium), THEN proceed to the boss.
      if (handleDeliriumMirror(player, now)) break;
      // PRIMARY: boss-arena terrain tile (present at map entry, 100% reliable) -> skip the guesswork below.
      const arenaCentroid = getBossArenaCentroid();
      // Skip an anchor we just proved FOG-UNREACHABLE (the checkpoint watchdog blocked it): re-committing it would
      // bounce straight back to WALKING_TO_BOSS_CHECKPOINT and re-freeze. While blocked, fall through to the explore
      // below (which biases toward this anchor's direction to reveal fog) until the TTL expires or a path opens.
      const arenaFogBlocked = arenaCentroid && now < fogBlockedAnchorUntil &&
        Math.hypot(arenaCentroid.gx - fogBlockedAnchorX, arenaCentroid.gy - fogBlockedAnchorY) < 60;
      if (arenaCentroid && !arenaFogBlocked) {
        bossGridX = arenaCentroid.gx; bossGridY = arenaCentroid.gy; bossTgtFound = true; bossTargetSource = 'arena_tgt';
        log(`Boss arena (terrain) at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)}) -> walking`);
        startWalkingTo(bossGridX, bossGridY, 'Boss Arena', 'boss');
        setState(STATE.WALKING_TO_BOSS_CHECKPOINT);
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

        // BACKUP boss-checkpoint finder: ONLY "Checkpoint_Endgame_Boss" (the actual boss checkpoint). A plain
        // "Checkpoint_Endgame" is an ENTRY/waypoint (the one you spawn at) -> NEVER the boss. Targeting a plain
        // one made the bot run BACK to the entry once it had walked away; the arena hint drives us forward instead.
        if (!bossTgtFound) {
          const eps = poe2.getEntities({ nameContains: 'Checkpoint_Endgame_Boss', lightweight: false }) || [];
          let best = null, bestD = Infinity;
          for (const e of eps) {
            if (!/Checkpoint_Endgame_Boss/i.test(e.name || '')) continue;
            if (!Number.isFinite(e.gridX) || (Math.abs(e.gridX) < 5 && Math.abs(e.gridY) < 5)) continue;
            const d = Math.hypot(e.gridX - player.gridX, e.gridY - player.gridY);
            if (d < bestD) { bestD = d; best = e; }
          }
          if (best) {
            bossGridX = best.gridX; bossGridY = best.gridY;
            bossTgtFound = true; bossTargetSource = 'checkpoint';
            log(`Boss checkpoint (Checkpoint_Endgame_Boss) at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
          }
        }
      }

      // STRICT MODE: no generic radar/TGT endpoint fallback.
      // Allowed fallback is strict boss-room object anchors only.
      if (!bossTgtFound) {
        const anchor = findBossRoomObjectAnchor(player.gridX, player.gridY, radarBossTarget);
        const ax = anchor ? (anchor.anchorGridX ?? anchor.gridX) : 0;
        const ay = anchor ? (anchor.anchorGridY ?? anchor.gridY) : 0;
        // REJECT origin-junk anchors (a (0,0)/(26,0) DoodadNoBlocking with unresolved coords) -- that's what
        // sent us walking to the map corner. A real boss anchor is never within ~40u of the grid origin.
        if (anchor && Number.isFinite(ax) && Number.isFinite(ay) && Math.abs(ax) > 2 && Math.abs(ay) > 2 && !(Math.abs(ax) < 40 && Math.abs(ay) < 40)) {
          bossGridX = ax;
          bossGridY = ay;
          bossTgtFound = true;
          bossTargetSource = 'arena_object';
          const shortName = (anchor.name || 'BossRoomObject').split('/').pop();
          log(`Boss room anchor fallback: "${shortName}" at (${bossGridX.toFixed(0)}, ${bossGridY.toFixed(0)})`);
        } else if (anchor) {
          log(`Boss room anchor "${(anchor.name || '?').split('/').pop()}" at (${ax.toFixed(0)},${ay.toFixed(0)}) is origin-junk -> rejected`);
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
      // DECIDE: CHECKPOINT FIRST, then boss approach in melee state.
      // Normally do NOT target a unique directly from FINDING_BOSS...
      // EXCEPT: if the actual OBJECTIVE boss has streamed in, engage it directly.
      // Tile-less maps (Trenches) have no checkpoint/anchor -> frontier exploration
      // finds the boss by streaming; commit the moment we confirm it's the objective.
      // isEntityLikelyMainObjectiveBoss matches the entity to the "Defeat X" objective.
      // =================================================================
      if (nearestBoss && nearestBossDist < 280 &&
          !isMapObjectiveComplete() && isEntityLikelyMainObjectiveBoss(nearestBoss)) {
        bossEntityId = nearestBoss.id || bossEntityId;
        bossGridX = nearestBoss.gridX;
        bossGridY = nearestBoss.gridY;
        bossFound = true;
        bossTgtFound = true;
        bossTargetSource = 'unique';
        checkpointReached = true; // boss visible -> skip checkpoint gate, close in + fight
        const bn = (nearestBoss.renderName || nearestBoss.name || '?').split('/').pop();
        log(`Objective boss "${bn}" streamed at dist=${nearestBossDist.toFixed(0)} -> engaging directly`);
        setState(STATE.WALKING_TO_BOSS_MELEE);
        break;
      }
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

      // BOSS ARENA HINT (user idea 2026-06-23): no checkpoint/boss entity streamed, but far arena-indicator
      // objects (VaalBossStatue wall-lasers etc.) carry REAL coords across the map -> push toward the cluster
      // centroid; the real Checkpoint_Endgame_Boss / arena streams in as we close + STRATEGY 1 takes over.
      if (!bossTgtFound) {
        const arenaHint = findBossArenaHint(player, now);
        if (arenaHint) {   // persistent DIRECTION -- never drop it via isAbandonedTarget; re-route on stuck, don't pause
          const hd = Math.hypot(arenaHint.x - player.gridX, arenaHint.y - player.gridY);
          statusMessage = `Boss arena hint (${arenaHint.count}) -> (${arenaHint.x},${arenaHint.y}) ${hd.toFixed(0)}u`;
          const needArenaRetarget = targetName !== 'Boss Arena Hint' || Math.abs(targetGridX - arenaHint.x) > 50 || Math.abs(targetGridY - arenaHint.y) > 50 || currentPath.length === 0;
          if (needArenaRetarget && now - lastRepathTime > 700) startWalkingTo(arenaHint.x, arenaHint.y, 'Boss Arena Hint', 'boss');
          const ahs = stepPathWalker();
          if (ahs === 'stuck') { addSoftBlock(player.gridX, player.gridY); currentPath = []; }
          break;
        }
      }

      // STRATEGY 5: Exploration fallback (never stand still while searching).
      // If temple is known, bias away from temple. Otherwise, pick/maintain a forward heading.
      if (timeSinceStart > 1200) {
        // No boss PATH on this map. User's flow: chase the nearest alive RARE/MAGIC (they're streamed =
        // nearby; entity_actions kills them). If there's nothing to fight either, PAUSE + TELL the user to
        // walk further to reveal more map -- do NOT blind-explore.
        const elite = findNearestEliteAlive(player.gridX, player.gridY);
        if (elite && Number.isFinite(elite.gridX)) {
          const sub = (elite.entitySubtype || 'Mob').replace('Monster', '');
          const ed = Math.hypot(player.gridX - elite.gridX, player.gridY - elite.gridY);
          statusMessage = `Closing on ${sub} (boss proxy, pathing) ${ed.toFixed(0)}u`;
          if (ed > 24) {
            if ((Math.abs(targetGridX - elite.gridX) > 18 || Math.abs(targetGridY - elite.gridY) > 18 || currentPath.length === 0) && now - lastRepathTime > 500) {
              startWalkingTo(elite.gridX, elite.gridY, 'Elite', 'boss');
            }
            const step = stepPathWalker();
            if (step === 'stuck') { addSoftBlock(player.gridX, player.gridY); currentPath = []; }
          } else {
            sendStopMovementLimited();   // in range -> hold; entity_actions does the killing
          }
        } else {
          // SEE MOBS -> GO TO THEM first. The explore kept stopping just short of visible mobs ("almost there").
          // If a targetable hostile is within reach, walk to it so the attack loop closes the gap + kills it,
          // instead of exploring past them. (Elites are handled above; this catches the white-mob clusters.)
          let nearMob = null, nearMobD = 220;
          try {
            for (const m of (poe2.getEntities({ lightweight: true }) || [])) {
              if (m.entityType !== 'Monster' || m.isAlive === false || !m.isHostile || !m.isTargetable) continue;
              const md = Math.hypot((m.gridX || 0) - player.gridX, (m.gridY || 0) - player.gridY);
              if (md < nearMobD) { nearMobD = md; nearMob = m; }
            }
          } catch (e) {}
          // Anti-yoyo: when committed to an explore heading, DON'T divert BACKWARD to a mob -- that's the
          // frontier<->mob flip-flop (slow boss-find: stable frontier vs a mob in the OPPOSITE direction). Forward
          // and very-close (<50u) mobs still get engaged; a mob sitting opposite the heading is ignored here
          // (entity_actions still shoots it) so movement keeps closing on the frontier instead of oscillating.
          // Backward-guard ONLY when we have a LOCKED boss arena (we KNOW the boss dir -> don't divert backward, rush it).
          // With NO locked boss (signal-less / still searching), GO TO THE MOB -- user: "there are mobs nearby, why not go
          // there?" Killing a nearby mob is progress + reveals the map; the explore bias still pulls forward afterward.
          if (nearMob && Number.isFinite(bossArenaCacheX) && exploreTgtX !== null && nearMobD > 50) {
            const _ex = exploreTgtX - player.gridX, _ey = exploreTgtY - player.gridY;
            const _mx = nearMob.gridX - player.gridX, _my = nearMob.gridY - player.gridY;
            if (_ex * _mx + _ey * _my <= 0) nearMob = null;
          }
          if (nearMob && nearMobD > 18) {
            statusMessage = `Explore -> mob ${Math.round(nearMobD)}u`;
            if ((Math.abs(targetGridX - nearMob.gridX) > 18 || Math.abs(targetGridY - nearMob.gridY) > 18 || currentPath.length === 0) && now - lastRepathTime > 400) {
              startWalkingTo(nearMob.gridX, nearMob.gridY, 'Boss Explore', 'boss');
            }
            const mStep = stepPathWalker();
            if (mStep === 'stuck') { addSoftBlock(player.gridX, player.gridY); currentPath = []; }
          } else {
            // No mob in reach -> EXPLORE toward an objective marker. STICKY commit: hold ONE marker until reached
            // (<60u) / it vanishes / 30s, THEN pick the next. Re-picking the FARTHEST marker every tick flip-flopped
            // between two far-apart markers (e.g. boss obj 1369,1070 <-> Verisium marker 414,932) = the yoyo.
            let exTarget = null;
            const markers = [];
            try { for (const m of (poe2.getQuestMarkers() || [])) {
              const mx = m.gridX || 0, my = m.gridY || 0; if (!mx && !my) continue;
              // SEPARATION OF CONCERNS (2026-06-28): the boss-explore owns ONLY boss/quest navigation. It must NOT chase
              // CONTENT (breach/verisium/abyss/incursion/delirium/ritual) or UTILITY (shrine/checkpoint/strongbox/chest)
              // markers -- those belong to runContentRotation / the utility system. getQuestMarkers returns ALL of them,
              // so the explore was picking the FARTHEST one (a CLEARED Brequel breach behind us) = the "going backwards"
              // bug. Exclude them by path; with no real boss/quest marker the explore heads to the unexplored FRONTIER.
              if (/Expedition2|Brequel|Breach|Abyss|Incursion|Vaal|Delirium|Ritual|Shrine|Checkpoint|Strongbox|Chest|Sanctum|Affliction/i.test(m.path || '')) continue;
              markers.push({ x: mx, y: my, d: Math.hypot(mx - player.gridX, my - player.gridY) });
            } } catch (e) {}
            if (exploreTgtX !== null) {
              const reached = Math.hypot(exploreTgtX - player.gridX, exploreTgtY - player.gridY) < 60;
              // A MARKER target is valid only while its objective still exists; a FRONTIER target (open fog, no marker)
              // has nothing to "still" against -> hold it unconditionally until reached / 30s / stuck. WITHOUT this,
              // frontier targets FAILED the marker check, got cleared + re-picked EVERY cycle (frontierTowardTarget is
              // player-relative + unstable) -> the (667,1311)<->(1206,1478) flip-flop yoyo the user hit.
              const valid = exploreTgtIsMarker ? markers.some(m => Math.hypot(m.x - exploreTgtX, m.y - exploreTgtY) < 100) : true;
              if (valid && !reached && now - exploreTgtSetAt < 30000) exTarget = { x: exploreTgtX, y: exploreTgtY };
              else exploreTgtX = null;
            }
            if (!exTarget) {
              let best = null, bestD = 60;
              for (const m of markers) { if (m.d > bestD) { bestD = m.d; best = m; } }
              // No marker -> steer toward genuinely UNEXPLORED open map (fog-independent vertex grid via
              // getUnexploredBuckets), not a blind east probe. Fall back to the fog-blocked anchor, then east, if the
              // binding is absent / the map is fully revealed. The sticky-target logic above holds the pick (anti-yoyo).
              let exDirX, exDirY;
              // BOSS-WARD bias (FIND-layer rewrite): resolve ONE fused boss bearing (TGT-centroid > BossRoom-marker > radar >
              // arena-hint > fog-anchor) and seed the fog-anchor (20s) so pickUnexploredHeading biases the frontier reveal
              // TOWARD the boss. With conf>=0.7 the picker STRUCTURALLY REJECTS opposite-side buckets -> kills the ping-pong.
              if (now - _bbSeedAt > 1500) {
                _bbSeedAt = now;
                const _bb = resolveBossBearing(player, now);
                if (_bb && Number.isFinite(_bb.x)) { fogBlockedAnchorX = _bb.x; fogBlockedAnchorY = _bb.y; fogBlockedAnchorUntil = now + 20000; fogBlockedAnchorConf = _bb.conf || 0; }
              }
              const uh = pickUnexploredHeading(player, now);
              if (uh) { exDirX = uh.x; exDirY = uh.y; }
              else if (now < fogBlockedAnchorUntil) { exDirX = fogBlockedAnchorX; exDirY = fogBlockedAnchorY; }
              else { exDirX = player.gridX + 200; exDirY = player.gridY; }
              exTarget = best || frontierTowardTarget(player.gridX, player.gridY, exDirX, exDirY);
              if (exTarget) { exploreTgtX = exTarget.x; exploreTgtY = exTarget.y; exploreTgtSetAt = now; exploreTgtIsMarker = !!best; }
            }
            if (exTarget) {
              const exIsMarker = markers.some(m => Math.hypot(m.x - exTarget.x, m.y - exTarget.y) < 5);
              const _exd = Math.round(Math.hypot(exTarget.x - player.gridX, exTarget.y - player.gridY));
              statusMessage = exIsMarker
                ? `-> boss objective ${_exd}u (pathing, ${currentPath.length}wp)`   // has a real path to a known objective marker, not blind
                : `Exploring (revealing) -> frontier ${_exd}u`;
              if ((targetName !== 'Boss Explore' || Math.abs(targetGridX - exTarget.x) > 90 || Math.abs(targetGridY - exTarget.y) > 90 || currentPath.length === 0) && now - lastRepathTime > 700) {
                startWalkingTo(exTarget.x, exTarget.y, 'Boss Explore', 'boss');
              }
              const exStep = stepPathWalker();
              // Unreachable frontier -> RELEASE the sticky target so next cycle re-picks AWAY (the soft-block we just
              // dropped steers frontierTowardTarget off this wedge). Without the release the bot re-issued the same
              // dead-end target every second (the '(1053,1422)' wedge).
              if (exStep === 'stuck') { addSoftBlock(player.gridX, player.gridY); currentPath = []; exploreTgtX = null; }
            } else {
              statusMessage = 'PAUSED: boxed in (no open frontier) -- WALK FURTHER';
              sendStopMovementLimited(); currentPath = []; targetGridX = player.gridX; targetGridY = player.gridY;
              if (now - lastPauseTellTime > 6000) { log('>>> PAUSED: boxed in, no open frontier nearby. WALK FURTHER. <<<'); lastPauseTellTime = now; }
            }
          }
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
        if (!isMapObjectiveComplete() && !isEntityLikelyMainObjectiveBoss(e)) {
          const n = (e.renderName || e.name || 'Unknown').split('/').pop();
          log(`Ignoring engaged non-objective unique during checkpoint walk: "${n}"`);
        } else {
        bossEntityId = e.id || bossEntityId;
        bossGridX = e.gridX;
        bossGridY = e.gridY;
        bossFound = true;
        checkpointReached = true;
        bossMeleeHoldStartTime = 0;
        bossMeleeStaticLocked = false;
        bossMeleeStaticX = 0;
        bossMeleeStaticY = 0;
        bossMeleeStaticEntityId = 0;
        bossMeleeLastRetargetTime = 0;
        log(`Boss already engaged during checkpoint walk (${activeBoss.reason}) -> closing in via melee`);
        setState(STATE.WALKING_TO_BOSS_MELEE);
        break;
        }
      }
      if (tryLateTempleHandoffFromBossFlow(player, now, 'while walking to boss checkpoint')) {
        break;
      }

      const result = stepPathWalker();
      const dist = Math.hypot(player.gridX - bossGridX, player.gridY - bossGridY);
      const approachLabel = bossTargetSource === 'arena_object' ? 'Boss Arena Barrier' : 'Boss Checkpoint';
      statusMessage = `Walking to ${approachLabel}... ${dist.toFixed(0)} units`;

      // Reach the boss entry. OR: the arena centroid can sit on an UNWALKABLE cell, so the terrain path ends a
      // few wp SHORT and we never get within 18u -- we just oscillate 2-6 wp out (the yo-yo). So ALSO accept being
      // CLOSE (<=50u) with the path basically spent / stuck, and hand off to the melee state (it chases the actual
      // boss ENTITY, not the centroid, so it engages from there instead of bouncing forever on an unreachable point).
      const pathSpent = currentPath.length <= 3 || result === 'stuck' || (result === 'walking' && currentPath.length === 0);
      if (result === 'arrived' || dist <= 18 || (dist <= 50 && pathSpent)) {
        const meleeGate = canSwitchToBossMeleeFromCheckpointState(player, now);
        if (!meleeGate.ok) {
          // Basics-first behavior:
          // once we are at checkpoint, do NOT side/back unlock detours.
          // Go straight into melee-forward push mode toward boss area.
          bossCheckpointGateFailCount++;
          checkpointReached = true;
          bossMeleeHoldStartTime = 0;
          bossMeleeStaticLocked = false;
          bossMeleeStaticX = 0;
          bossMeleeStaticY = 0;
          bossMeleeStaticEntityId = 0;
          bossMeleeLastRetargetTime = 0;
          log(
            `Checkpoint reached but gate blocked (${meleeGate.reason}); ` +
            `forcing melee-forward mode (attempt ${bossCheckpointGateFailCount})`
          );
          setState(STATE.WALKING_TO_BOSS_MELEE);
          break;
        }
        bossCheckpointGateFailCount = 0;
        checkpointReached = true;
        bossMeleeHoldStartTime = 0;
        bossMeleeStaticLocked = false;
        bossMeleeStaticX = 0;
        bossMeleeStaticY = 0;
        bossMeleeStaticEntityId = 0;
        bossMeleeLastRetargetTime = 0;
        log(
          `Boss entry reached (${bossTargetSource === 'arena_object' ? 'barrier' : 'checkpoint'}) ` +
          `gate=${meleeGate.reason} -> switching to melee engagement`
        );
        setState(STATE.WALKING_TO_BOSS_MELEE);
        break;
      }

      // === ANTI-FREEZE COMMIT WATCHDOG (fires at ANY distance) ===
      // The escapes below are gated dist<=130, so a far fog-sealed anchor (the (1093,161) freeze) never escalates.
      // Track best-dist to the anchor; reset the clock ONLY on real >4u closing (sideways creep doesn't count).
      if (bossCheckpointLastImprovementTime === 0) { bossCheckpointLastImprovementTime = now; checkpointBestDist = dist; }
      if (dist < checkpointBestDist - 4) { checkpointBestDist = dist; bossCheckpointLastImprovementTime = now; }
      if (now - bossCheckpointLastImprovementTime > 5000) {
        // No >4u progress for 5s -> anchor unreachable. Close -> melee (chases the boss ENTITY); far + fog-sealed ->
        // mark it fog-blocked (TTL) + re-find so FINDING_BOSS EXPLORES toward it to reveal a way around, not ram it.
        if (dist <= 130) {
          log(`[Mapper] Boss anchor unreachable 5s at ${dist.toFixed(0)}u -> melee engagement`);
          checkpointReached = true; bossNoPathCount = 0; bossCheckpointLastImprovementTime = 0; checkpointBestDist = Infinity;
          bossMeleeHoldStartTime = 0; bossMeleeStaticLocked = false; bossMeleeStaticX = 0; bossMeleeStaticY = 0; bossMeleeStaticEntityId = 0; bossMeleeLastRetargetTime = 0;
          setState(STATE.WALKING_TO_BOSS_MELEE);
          break;
        }
        log(`[Mapper] Boss anchor (${bossGridX.toFixed(0)},${bossGridY.toFixed(0)}) fog-unreachable 5s at ${dist.toFixed(0)}u -> abandon + re-find (explore to reveal)`);
        fogBlockedAnchorX = bossGridX; fogBlockedAnchorY = bossGridY; fogBlockedAnchorUntil = now + 25000;
        bossTgtFound = false; bossCheckpointLastImprovementTime = 0; checkpointBestDist = Infinity; bossNoPathCount = 0;
        setState(STATE.FINDING_BOSS);
        break;
      }

      if (result === 'stuck' || (result === 'walking' && currentPath.length === 0)) {
        bossNoPathCount++;
        // UNREACHABLE anchor + already CLOSE -> stop detouring/bouncing and hand to the melee state, which chases
        // the boss ENTITY and frontier-walks INTO the arena. This is the 97u "manually got the checkpoint but the
        // bot kept bouncing 2<->35 wp on the interior centroid" yo-yo: the centroid sits past the checkpoint
        // barrier so no path reaches it, and detours can't fix an unreachable point.
        if (bossNoPathCount >= 3 && dist <= 130) {
          log(`[Mapper] Boss anchor unreachable (no-path ${bossNoPathCount}x at ${dist.toFixed(0)}u) -> melee engagement`);
          checkpointReached = true; bossNoPathCount = 0;
          bossMeleeHoldStartTime = 0; bossMeleeStaticLocked = false; bossMeleeStaticX = 0; bossMeleeStaticY = 0; bossMeleeStaticEntityId = 0; bossMeleeLastRetargetTime = 0;
          setState(STATE.WALKING_TO_BOSS_MELEE);
          break;
        }
        const canTryDetour = (now - bossDetourLastPickTime > 1800);
        if (bossNoPathCount >= 3 && canTryDetour) {
          const detour = pickBossCheckpointDetour(player.gridX, player.gridY, bossGridX, bossGridY, 0.16);
          if (detour) {
            bossDetourLastPickTime = now;
            markRecentBossDetour(detour.x, detour.y);
            log(`Boss checkpoint no-path, taking detour at (${detour.x.toFixed(0)}, ${detour.y.toFixed(0)})`);
            startWalkingTo(detour.x, detour.y, 'Boss Checkpoint Detour', '');
            break;
          }
        }

        if (!targetName.includes('Detour')) {
          startWalkingTo(
            bossGridX,
            bossGridY,
            bossTargetSource === 'arena_object' ? 'Boss Arena Barrier' : 'Boss Checkpoint',
            'boss'
          );
        }
      } else {
        bossNoPathCount = 0;
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
        if (!isMapObjectiveComplete() && !isEntityLikelyMainObjectiveBoss(e)) {
          const n = (e.renderName || e.name || 'Unknown').split('/').pop();
          log(`Ignoring engaged non-objective unique during melee walk: "${n}"`);
        } else {
        // Safety-first: if boss is already active on engage, execute a fast evasive
        // roll before committing to fight state so we don't stand in front of attacks.
        const distToEngaged = Math.hypot(player.gridX - e.gridX, player.gridY - e.gridY);
        const engagedActionEntity = resolveBossActionEntity(e, now) || e;
        const engagedStanceInfo = getChangeToStanceInfo(engagedActionEntity, 0.12);
        const engagedClear = quickClearanceScore(player.gridX, player.gridY);
        const canEarlyEvade =
          !engagedStanceInfo &&
          distToEngaged <= 40 &&
          engagedClear >= 3 &&
          (now - bossMeleeApproachLastEvadeAt) > 1150;
        if (canEarlyEvade) {
          if (
            tryBossEmergencyRollOut(player, e, now) ||
            tryBossFirstContactDiagonalRoll(player, e, now) ||
            tryBossDodgeRollBehind(player, e, now)
          ) {
            bossMeleeApproachLastEvadeAt = now;
            statusMessage = `Boss engaged: evasive roll (${distToEngaged.toFixed(0)}u)`;
          }
        }
        bossEntityId = e.id || bossEntityId;
        bossGridX = e.gridX;
        bossGridY = e.gridY;
        bossFound = true;
        if (engagedStanceInfo) {
          const stanceLabel = engagedStanceInfo.animationName || 'ChangeToStance';
          sendStopMovementLimited();
          statusMessage = `Waiting (safe): ${stanceLabel} ${engagedStanceInfo.remaining.toFixed(2)}s | engaged ${distToEngaged.toFixed(0)}u`;
        } else if (e.cannotBeDamaged) {
          // BOSS SPAWN / INTRO / PHASE-TRANSITION: it's INVULNERABLE. A NICE WAIT (user): hold at a dodge-ready distance
          // (don't run point-blank into it, don't attack into immunity, don't re-find), and let the boss-dodge hook
          // handle its intro telegraphs. Engage the INSTANT it becomes damageable (this branch stops firing -> the fight
          // branch below takes over). [future: a C++ animation-end hook would be tighter than cannotBeDamaged.]
          const holdD = 26;
          if (distToEngaged > holdD + 14) {
            if (now - bossMeleeLastRetargetTime > 600) { bossMeleeLastRetargetTime = now; startWalkingTo(e.gridX, e.gridY, 'Boss Wait Approach', 'boss'); }
            stepPathWalker();
          } else { sendStopMovementLimited(); }
          statusMessage = `Boss spawning / immune -- waiting to become vulnerable (${distToEngaged.toFixed(0)}u)`;
        } else {
          const engageFightDist = 32;   // (cannotBeDamaged handled by the wait branch above -> this is the damageable range)
          if (distToEngaged <= engageFightDist) {
          // If the boss is right on top of us, prefer one quick escape roll first.
          if (
            distToEngaged <= 16 &&
            engagedClear >= 3 &&
            (now - bossMeleeApproachLastEvadeAt) > 850 &&
            (
              tryBossEmergencyRollOut(player, e, now) ||
              tryBossFirstContactDiagonalRoll(player, e, now)
            )
          ) {
            bossMeleeApproachLastEvadeAt = now;
            statusMessage = `Boss engaged point-blank: emergency evade (${distToEngaged.toFixed(0)}u)`;
          } else {
            log(`Boss engaged during melee walk (${activeBoss.reason}) dist=${distToEngaged.toFixed(0)} -> entering fight`);
            setState(STATE.FIGHTING_BOSS);
          }
          } else {
            // Early-activated boss: hard-lock direct approach to engaged entity.
            // Do not fall back to checkpoint corridor push, which can backtrack into walls.
            const needsRetarget =
              targetName !== 'Boss Melee Engaged Target' ||
              Math.hypot(targetGridX - e.gridX, targetGridY - e.gridY) > 10 ||
              currentPath.length === 0 ||
              now - bossMeleeLastRetargetTime > 500;
            if (needsRetarget) {
              bossMeleeLastRetargetTime = now;
              startWalkingTo(e.gridX, e.gridY, 'Boss Melee Engaged Target', 'boss');
            }
            stepPathWalker();
            statusMessage = `Boss engaged early, closing in... ${distToEngaged.toFixed(0)} units`;
          }
        }
        break;
        }
      }

      const IMMUNE_ENGAGE_RANGE = 5;
      const DAMAGEABLE_ENGAGE_RANGE = 30;
      const radarBoss = getRadarBossTarget();
      const anchor = radarBoss || (Number.isFinite(bossGridX) && Number.isFinite(bossGridY) ? { x: bossGridX, y: bossGridY } : null);
      const anchorRadius = checkpointReached ? 260 : 320;

      const meleeTargetRefreshMs = fightLastNearbyMonsterCount > 160 ? 520 : 300;
      let selected = null;
      const cachedAlive = bossMeleeCachedTarget && isHostileAlive(bossMeleeCachedTarget);
      const canRefreshTarget = !cachedAlive || (now - bossMeleeCachedTargetAt > meleeTargetRefreshMs);

      if (!canRefreshTarget) {
        selected = bossMeleeCachedTarget;
      } else {
        selected = findBossCandidateUnique(
          player.gridX,
          player.gridY,
          760,
          anchor ? anchor.x : null,
          anchor ? anchor.y : null,
          anchorRadius
        );
        if (selected && !isMapObjectiveComplete() && !isEntityLikelyMainObjectiveBoss(selected)) {
          const n = (selected.renderName || selected.name || 'Unknown').split('/').pop();
          log(`Ignoring non-objective unique in melee target selection: "${n}"`);
          selected = null;
        }

        if (!selected) {
          const fullCandidates = getBossFullEntityCandidates(
            player.gridX,
            player.gridY,
            anchor ? anchor.x : null,
            anchor ? anchor.y : null,
            checkpointReached ? 320 : 360
          );
          if (fullCandidates.length > 0) selected = fullCandidates[0].entity;
        }
        bossMeleeCachedTarget = selected || null;
        bossMeleeCachedTargetAt = now;
      }

      if (!selected) {
        bossMeleeCachedActionEntity = null;
        bossMeleeActionProbeAt = 0;
        const meleeElapsed = now - stateStartTime;
        // ============================================================================================================
        // SIMPLIFIED 2026-06-28 (user: "draw a path from me to the boss and walk it"; boss-melee-yoyo-fix workflow):
        // The boss UNIQUE hasn't streamed yet. The OLD code (stall-detour + radar-push + corridor-push) manufactured a
        // push DIRECTION from (bossGridX - player). When standing ON the checkpoint anchor that vector's magnitude IS
        // distToAnchor (~0), so normalizing it produced a RANDOM per-tick bearing x ~50u = the 20s "so close then back
        // out" yoyo -- and because the bot kept backing off it never CROSSED the checkpoint, so the boss never spawned.
        // FIX: pick ONE STABLE target deeper into the arena and walk a committed path to it; HOLD if already on the
        // deepest known point. No player-relative push, no 700ms re-pick, no stall-detour. Replaces ~130 lines.
        // ============================================================================================================
        // Repair a garbage (origin-junk) anchor first.
        if (!Number.isFinite(bossGridX) || !Number.isFinite(bossGridY) || Math.hypot(bossGridX, bossGridY) < 80) {
          const _bh = findBossArenaHint(player, now);
          if (_bh && Math.hypot(_bh.x, _bh.y) >= 80) { bossGridX = _bh.x; bossGridY = _bh.y; }
          else { setState(STATE.FINDING_BOSS); break; }   // garbage anchor + no hint -> re-find, don't shove a corner
        }
        // The boss ACTIVATES when we get close to the ARENA INTERIOR (user: "he activates once we get close to the
        // middle-top of the arena" = the red-circle spot = the streamed BossArenaBlocker that sits PAST the checkpoint).
        // Those objects FLICKER in/out of stream range, so LOCK the interior the moment we ever see it.
        const interior = findBossArenaInterior(now);
        if (interior) { bossArenaCacheX = interior.x; bossArenaCacheY = interior.y; }
        let bossTgtX, bossTgtY;
        if (radarBoss) { bossTgtX = radarBoss.x; bossTgtY = radarBoss.y; bossMeleeProbeX = NaN; }
        else if (Number.isFinite(bossArenaCacheX)) { bossTgtX = bossArenaCacheX; bossTgtY = bossArenaCacheY; bossMeleeProbeX = NaN; }
        else {
          // Interior not streamed yet -> commit a ONE-TIME probe a fixed distance PAST the checkpoint, away from our
          // approach side (= into the arena). Captured ONCE so it can't flip across the checkpoint (the old yoyo);
          // walking it gets us within stream-range of the interior, which then LOCKS the cache above and takes over.
          if (!Number.isFinite(bossMeleeProbeX)) {
            const ex = bossGridX - player.gridX, ey = bossGridY - player.gridY, el = Math.hypot(ex, ey);
            if (el > 6) { bossMeleeProbeX = bossGridX + (ex / el) * 130; bossMeleeProbeY = bossGridY + (ey / el) * 130; }
            else { bossMeleeProbeX = bossGridX; bossMeleeProbeY = bossGridY; }   // standing ON the checkpoint, no approach dir
          }
          bossTgtX = bossMeleeProbeX; bossTgtY = bossMeleeProbeY;
        }
        const distToBossTgt = Math.hypot(player.gridX - bossTgtX, player.gridY - bossTgtY);
        if (distToBossTgt <= 16) {
          if (Number.isFinite(bossArenaCacheX)) {
            // In the arena interior, boss not activated yet -> HOLD briefly (it activates on proximity); re-find if it
            // never shows so we never park forever.
            sendStopMovementLimited();
            statusMessage = `In boss arena, waiting for boss to activate... ${(meleeElapsed / 1000).toFixed(0)}s`;
            if (meleeElapsed > 12000) { log('In boss arena 12s, no boss activated -> re-finding'); setState(STATE.FINDING_BOSS); }
          } else {
            // Blind probe reached + still no arena objects streamed -> direction guess was wrong -> re-find (re-probes
            // from here). Keeps MOVING/searching rather than parking on the checkpoint.
            log('Boss arena probe reached, no arena/boss streamed -> re-finding'); bossMeleeProbeX = NaN; setState(STATE.FINDING_BOSS);
          }
          break;
        }
        // COMMITTED walk: re-path ONLY if the stable target moved a lot (>40u) or the path ran out -- NEVER every 700ms.
        const changedBossTarget = targetName !== 'Boss Melee Approach' || Math.hypot(targetGridX - bossTgtX, targetGridY - bossTgtY) > 40 || currentPath.length === 0;
        if (changedBossTarget && (now - bossMeleeExplorePickTime > 500)) {
          startWalkingTo(bossTgtX, bossTgtY, 'Boss Melee Approach', 'boss');
          bossMeleeExplorePickTime = now;
        }
        const bossApproachStep = stepPathWalker();
        if (bossApproachStep === 'stuck' || (bossApproachStep === 'walking' && currentPath.length === 0)) {
          bossMeleeExploreNoPathCount++;
          if (bossMeleeExploreNoPathCount >= 4) { addSoftBlock(player.gridX, player.gridY); currentPath = []; bossMeleeExplorePickTime = now - 600; bossMeleeExploreNoPathCount = 0; }
        } else {
          bossMeleeExploreNoPathCount = 0;
        }
        statusMessage = `Walking into boss arena... ${distToBossTgt.toFixed(0)}u (${(meleeElapsed / 1000).toFixed(0)}s)`;
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
        let selectedActionEntity = null;
        if (selectedIsImmune) {
          const actionProbeMs = fightLastNearbyMonsterCount > 160 ? 220 : 140;
          const cachedActionValid =
            bossMeleeCachedActionEntity &&
            bossMeleeCachedActionEntity.id === selected.id &&
            (now - bossMeleeActionProbeAt) <= actionProbeMs;
          if (cachedActionValid) {
            selectedActionEntity = bossMeleeCachedActionEntity;
          } else {
            selectedActionEntity = resolveBossActionEntity(selected, now);
            bossMeleeCachedActionEntity = selectedActionEntity || selected;
            bossMeleeActionProbeAt = now;
          }
        }
        const approachAnimName = `${selectedActionEntity?.animationName || ''}`;
        const approachAnimLower = approachAnimName.toLowerCase();
        const approachRemaining = getEntityActionRemainingSec(selectedActionEntity);
        const approachingChangeToStance =
          selectedIsImmune &&
          approachAnimLower.includes('changetostance') &&
          Number.isFinite(approachRemaining) &&
          approachRemaining > 0.12;
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
        if (approachingChangeToStance) {
          const stanceLabel = approachAnimName || 'ChangeToStance';
          statusMessage = `Waiting (safe): ${stanceLabel} ${approachRemaining.toFixed(2)}s | closing ${distToBossEntity.toFixed(0)}u`;
        } else {
          statusMessage = selectedIsImmune
            ? `Walking to immune boss... ${distToBossEntity.toFixed(0)} units`
            : `Walking to boss... ${distToBossEntity.toFixed(0)} units`;
        }
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
        let selectedActionEntity = null;
        const actionProbeMs = fightLastNearbyMonsterCount > 160 ? 220 : 140;
        const cachedActionValid =
          bossMeleeCachedActionEntity &&
          bossMeleeCachedActionEntity.id === selected.id &&
          (now - bossMeleeActionProbeAt) <= actionProbeMs;
        if (cachedActionValid) {
          selectedActionEntity = bossMeleeCachedActionEntity;
        } else {
          selectedActionEntity = resolveBossActionEntity(selected, now);
          bossMeleeCachedActionEntity = selectedActionEntity || selected;
          bossMeleeActionProbeAt = now;
        }
        const actionAnimName = `${selectedActionEntity?.animationName || ''}`;
        const actionAnimLower = actionAnimName.toLowerCase();
        const actionRemaining = getEntityActionRemainingSec(selectedActionEntity);
        const waitingForChangeToStance =
          actionAnimLower.includes('changetostance') &&
          Number.isFinite(actionRemaining) &&
          actionRemaining > 0.12;
        if (waitingForChangeToStance) {
          const stanceLabel = actionAnimName || 'ChangeToStance';
          // Strict stance safety hold:
          // while ChangeToStance is clearly active, do NOT roll or strafe.
          // Only allow pre-dodge in the very last end window.
          if (actionRemaining > 0.30) {
            sendStopMovementLimited();
            statusMessage = `Waiting (safe): ${stanceLabel} ${actionRemaining.toFixed(2)}s`;
            break;
          }
          // Final moments before completion: allow a single pre-dodge reaction.
          const stanceSignal = getImmuneBossStancePreDodgeSignal(selectedActionEntity);
          if (stanceSignal && (tryBossEmergencyRollOut(player, selected, now) || tryBossDodgeRollBehind(player, selected, now))) {
            statusMessage = `Waiting (final): ${stanceSignal.animationName} ${stanceSignal.remaining.toFixed(2)}s -> pre-dodge`;
            break;
          }
          sendStopMovementLimited();
          statusMessage = `Waiting (final): ${stanceLabel} ${actionRemaining.toFixed(2)}s`;
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
      const fightScanRadius = currentSettings.bossFightRadius * 2.35;

      // Throttled combat snapshot to reduce per-frame load in heavy fights.
      const fightSnapshot = getFightMonsterSnapshot(now, fightScanRadius);
      const allMonstersNearby = fightSnapshot.all;
      const bossMonsters = fightSnapshot.alive;
      const nearbyMonsterCount = allMonstersNearby?.length || 0;
      const heavyFightLoad = nearbyMonsterCount > 140;
      const severeFightLoad = nearbyMonsterCount > 220;
      const radarBossFight = getRadarBossTarget();
      const radarX = Number.isFinite(radarBossFight?.x) ? radarBossFight.x : NaN;
      const radarY = Number.isFinite(radarBossFight?.y) ? radarBossFight.y : NaN;
      const radarWasValid = Number.isFinite(fightArenaRadarX) && Number.isFinite(fightArenaRadarY);
      const radarIsValid = Number.isFinite(radarX) && Number.isFinite(radarY);
      const radarShifted =
        radarWasValid !== radarIsValid ||
        (radarIsValid && Math.hypot(radarX - fightArenaRadarX, radarY - fightArenaRadarY) > 18);
      const arenaReevalInterval = Math.max(
        severeFightLoad ? 700 : (heavyFightLoad ? 560 : 320),
        currentSettings.fightEntityScanIntervalMs || 220
      );
      const shouldReevalArenaUniques =
        now - fightArenaEvalTime > arenaReevalInterval ||
        radarShifted ||
        (fightArenaBossUniques.length === 0 && (allMonstersNearby?.length || 0) > 0);
      if (shouldReevalArenaUniques) {
        const rawArenaBossUniques = (allMonstersNearby || []).filter(e =>
          isBossApproachCandidate(e) && isUniqueNearBossArena(e, radarBossFight, 250)
        );
        fightArenaBossUniques = collapseBossProxyEntities(rawArenaBossUniques);
        fightArenaBossAliveCount = fightArenaBossUniques.filter(e => e.isAlive).length;
        fightArenaEvalTime = now;
        fightArenaRadarX = radarX;
        fightArenaRadarY = radarY;
      }
      const arenaBossUniques = fightArenaBossUniques;
      const arenaBossAliveCount = fightArenaBossAliveCount;
      const hostileCountCheckCap =
        severeFightLoad ? 90 :
          (heavyFightLoad ? 130 : (bossMonsters.length > 170 ? 170 : Infinity));

      // Count hostiles near boss area AND near player
      const hostileCount = countHostilesNear(
        bossMonsters, bossGridX, bossGridY, fightScanRadius, hostileCountCheckCap
      );
      const hostileCountNearPlayer = countHostilesNear(
        bossMonsters, player.gridX, player.gridY, currentSettings.bossFightRadius * 2, hostileCountCheckCap
      );
      const totalHostiles = Math.max(hostileCount, hostileCountNearPlayer);

      // =================================================================
      // BOSS ENTITY TRACKING
      // Find and track the MonsterUnique - this is the map boss.
      // Once we have its ID, we can detect its death instantly.
      // =================================================================
      const objectiveRefreshInterval = severeFightLoad ? 700 : (heavyFightLoad ? 520 : 320);
      if (!fightObjectiveInfoCache || (now - fightObjectiveInfoTime) > objectiveRefreshInterval) {
        fightObjectiveInfoCache = getMainDefeatObjectiveInfo();
        fightObjectiveInfoTime = now;
      }
      const mainObjectiveInfo = fightObjectiveInfoCache || getMainDefeatObjectiveInfo();
      const objectiveNeedsSpecificBoss = mainObjectiveInfo.hasDefeatObjective && !mainObjectiveInfo.isCompleted;
      const isObjectiveBossCandidate = (entity) => {
        if (!objectiveNeedsSpecificBoss) return true;
        const entityName = `${entity?.renderName || entity?.name || ''}`
          .split('/')
          .pop()
          .toLowerCase()
          .replace(/[^a-z0-9,'\- ]+/g, ' ')
          .trim();
        if (!entityName) return false;
        if (
          mainObjectiveInfo.bossName &&
          (entityName.includes(mainObjectiveInfo.bossName) || mainObjectiveInfo.bossName.includes(entityName))
        ) {
          return true;
        }
        const tokens = mainObjectiveInfo.tokens || [];
        if (tokens.length === 0) return false;
        let hits = 0;
        for (const t of tokens) {
          if (entityName.includes(t)) hits++;
        }
        const needHits = tokens.length >= 3 ? 2 : 1;
        return hits >= needHits;
      };

      if (bossEntityId === 0 && allMonstersNearby) {
        let bestBoss = null;
        let bestScore = -Infinity;
        for (const e of arenaBossUniques) {
          if (!e.id || e.id === 0) continue;
          if (!isObjectiveBossCandidate(e)) continue;

          const isLockedCandidate = bossCandidateId && e.id === bossCandidateId;
          const likelyByName = isLikelyMapBossEntity(e, radarBossFight);
          const likelyBoss = isLockedCandidate || likelyByName || isUniqueNearBossArena(e, radarBossFight, 250);
          if (!likelyBoss) continue;

          const distToKnown = Math.hypot(e.gridX - bossGridX, e.gridY - bossGridY);
          let score = 0;
          if (isLockedCandidate) score += 80;
          if (likelyByName) score += 35;
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
              if (!isMapObjectiveComplete()) {
                log('Tracked unique died but map objective still incomplete -> reacquiring objective boss');
                bossEntityId = 0;
                bossFound = false;
                bossCandidateId = 0;
                setState(STATE.FINDING_BOSS);
                break;
              }
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

      if (trackedBossEntity) {
        const trackedActionEntity = resolveBossActionEntity(trackedBossEntity, now) || trackedBossEntity;
        const stanceHold = getChangeToStanceInfo(trackedActionEntity, 0.30);
        if (stanceHold) {
          sendStopMovementLimited();
          statusMessage = `Waiting (safe): ${stanceHold.animationName} ${stanceHold.remaining.toFixed(2)}s`;
          break;
        }
      }

      // First-contact safety: instant-up bosses can swing immediately on engage.
      // Roll out first instead of committing to a stand/move command in that window.
      const zekoaPanicMode =
        trackedBossEntity &&
        isZekoaObjectiveActive() &&
        (isZekoaBossEntity(trackedBossEntity) || isEntityLikelyMainObjectiveBoss(trackedBossEntity)) &&
        (now - bossFightEngagedAt) < 3200;
      if (zekoaPanicMode) {
        const zDist = Math.hypot(player.gridX - trackedBossEntity.gridX, player.gridY - trackedBossEntity.gridY);
        if (zDist < 112) {
          if (
            tryBossZekoaPanicRoll(player, trackedBossEntity, now) ||
            tryBossEmergencyRollOut(player, trackedBossEntity, now) ||
            tryBossFirstContactDiagonalRoll(player, trackedBossEntity, now) ||
            tryBossDodgeRollBehind(player, trackedBossEntity, now)
          ) {
            statusMessage = `Zekoa opener panic evade (${zDist.toFixed(0)}u)`;
            break;
          }
          // If roll couldn't fire this tick, force reposition to the back arc.
          let facingRad = getEntityFacingRad(trackedBossEntity);
          if (facingRad === null) {
            facingRad = Math.atan2(player.gridY - trackedBossEntity.gridY, player.gridX - trackedBossEntity.gridX);
          }
          const behindX = trackedBossEntity.gridX + Math.cos(normalizeRad(facingRad + Math.PI)) * 72;
          const behindY = trackedBossEntity.gridY + Math.sin(normalizeRad(facingRad + Math.PI)) * 72;
          if (poe2.isWalkable(Math.floor(behindX), Math.floor(behindY))) {
            stepFightDirectMove(player, behindX, behindY, now, 12);
            statusMessage = `Zekoa opener reposition (${zDist.toFixed(0)}u)`;
            break;
          }
        }
      }

      if (trackedBossEntity && (now - bossFightEngagedAt) < 1600) {
        const firstContactDist = Math.hypot(player.gridX - trackedBossEntity.gridX, player.gridY - trackedBossEntity.gridY);
        const trackedActionEntity = resolveBossActionEntity(trackedBossEntity, now) || trackedBossEntity;
        const stanceInfo = getChangeToStanceInfo(trackedActionEntity, 0.12);
        if (stanceInfo) {
          sendStopMovementLimited();
          statusMessage = `Waiting (safe): ${stanceInfo.animationName} ${stanceInfo.remaining.toFixed(2)}s`;
          break;
        }
        if (
          firstContactDist < 68 &&
          (tryBossFirstContactDiagonalRoll(player, trackedBossEntity, now) ||
            tryBossEmergencyRollOut(player, trackedBossEntity, now))
        ) {
          statusMessage = `Boss first-contact evasive roll (${firstContactDist.toFixed(0)}u)`;
          break;
        }
      }

      // Immune stance wind-up reaction:
      // when boss is in ChangeToStance* near completion, pre-dodge behind/around.
      if (trackedBossEntity) {
        const trackedActionEntity = resolveBossActionEntity(trackedBossEntity, now);
        const stanceSignal = getImmuneBossStancePreDodgeSignal(trackedActionEntity);
        if (stanceSignal) {
          const localClear = quickClearanceScore(player.gridX, player.gridY);
          if (
            localClear >= 4 &&
            (tryBossEmergencyRollOut(player, trackedBossEntity, now) || tryBossDodgeRollBehind(player, trackedBossEntity, now))
          ) {
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
          const closeTargetCheckCap = severeFightLoad ? 80 : (heavyFightLoad ? 120 : Infinity);
          let checkedCloseTargets = 0;
          for (const e of bossMonsters) {
            checkedCloseTargets++;
            if (checkedCloseTargets > closeTargetCheckCap) break;
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
        const needClearRefresh =
          bossFightClearanceSampleAt === 0 ||
          now - bossFightClearanceSampleAt > 220 ||
          Math.hypot(player.gridX - bossFightClearanceSampleX, player.gridY - bossFightClearanceSampleY) > 2.2;
        if (needClearRefresh) {
          bossFightClearanceScore = quickClearanceScore(player.gridX, player.gridY);
          bossFightClearanceSampleAt = now;
          bossFightClearanceSampleX = player.gridX;
          bossFightClearanceSampleY = player.gridY;
        }
        const localClear = bossFightClearanceScore;
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
        const needClearRefresh =
          bossFightClearanceSampleAt === 0 ||
          now - bossFightClearanceSampleAt > 220 ||
          Math.hypot(player.gridX - bossFightClearanceSampleX, player.gridY - bossFightClearanceSampleY) > 2.2;
        if (needClearRefresh) {
          bossFightClearanceScore = quickClearanceScore(player.gridX, player.gridY);
          bossFightClearanceSampleAt = now;
          bossFightClearanceSampleX = player.gridX;
          bossFightClearanceSampleY = player.gridY;
        }
        const localClear = bossFightClearanceScore;
        const fenceTrapped = localClear <= 3 || bossOrbitBlockedCount >= 1;
        const postDodgeLock = (bossDodgeLandingTime > 0 && now - bossDodgeLandingTime < 1200);
        if (postDodgeLock && Number.isFinite(bossDodgeLandingX) && Number.isFinite(bossDodgeLandingY)) {
          bossFightOrbitWaypointX = bossDodgeLandingX;
          bossFightOrbitWaypointY = bossDodgeLandingY;
          markRecentFightWaypoint(bossDodgeLandingX, bossDodgeLandingY, 10);
          if (bossFightOrbitLastAssignTime === 0 || now - bossFightOrbitLastAssignTime > 180) {
            bossFightOrbitLastAssignTime = now;
          }
        }
        // KITE-FLOOR (anti-death): a ranged build must never get pinned at melee. When the boss has chased onto us
        // (distToBoss < KITE_FLOOR) and we're not mid-i-frame-roll, override the tangential orbit with a RADIAL retreat
        // straight AWAY from the boss -- orbiting alone keeps re-centering at melee while un-telegraphed swings kill us.
        let kiteFloorEngaged = false;
        if (trackedBossEntity && !postDodgeLock) {
          const _bd = Math.hypot(player.gridX - trackedBossEntity.gridX, player.gridY - trackedBossEntity.gridY);
          const KITE_FLOOR = 46;   // BELOW the ~55-58 orbit radius (pickBehindBossWaypoint 55 / pickLargeOrbitWaypoint 58) so the floor doesn't fight the orbit. bossFightRadius*0.9=72 was ABOVE it -> kite-out-to-84 then orbit-back-to-55 YOYO. Now engages only when the boss closes INSIDE the orbit; retreats to the orbit band (KITE_FLOOR+12=58u).
          if (_bd < KITE_FLOOR) {
            const _rt = pickRadialRetreatWaypoint(player.gridX, player.gridY, trackedBossEntity.gridX, trackedBossEntity.gridY, KITE_FLOOR + 12);
            if (_rt) {
              bossFightOrbitWaypointX = _rt.x; bossFightOrbitWaypointY = _rt.y;
              bossFightOrbitLastAssignTime = now; markRecentFightWaypoint(_rt.x, _rt.y, 8);
              kiteFloorEngaged = true;
              statusMessage = `Kiting Boss... BACK OFF ${Math.round(_bd)}->${KITE_FLOOR}u`;
            }
          }
        }
        const waypointExpired = (now - bossFightOrbitLastAssignTime > (fenceTrapped ? 3400 : 2600));
        const canReassignNow = (now - bossFightOrbitLastAssignTime > 520);
        const needNewWaypoint =
          bossFightOrbitWaypointX === 0 ||
          bossFightOrbitWaypointY === 0 ||
          (distToWaypoint < 12 && canReassignNow) ||
          waypointExpired;

        if (needNewWaypoint && !postDodgeLock && !kiteFloorEngaged) {
          if (fenceTrapped) {
            const escapeWp = pickFenceEscapeWaypoint(player.gridX, player.gridY, moveTargetX, moveTargetY);
            if (escapeWp && !isRecentFightWaypoint(escapeWp.x, escapeWp.y, 22)) {
              bossFightOrbitWaypointX = escapeWp.x;
              bossFightOrbitWaypointY = escapeWp.y;
              bossFightOrbitLastAssignTime = now;
              bossOrbitBlockedCount = 0;
              markRecentFightWaypoint(escapeWp.x, escapeWp.y, 10);
              statusMessage = `Kiting Boss... fence-escape`;
            } else {
              bossOrbitDir *= -1;
            }
          }
          if (bossFightOrbitWaypointX === 0 || bossFightOrbitWaypointY === 0 || !fenceTrapped) {
          // BOSS-BEHIND (user): prefer a spot BEHIND the boss (frontal attacks incl. the big circle miss); fall
          // back to the generic orbit when behind is walled / boss in a wall / facing unknown.
          // Performance-first by default: skip expensive wide clearance scoring.
            const behindWp = (trackedBossEntity && currentSettings.fightStayBehindBoss !== false)
              ? pickBehindBossWaypoint(player, trackedBossEntity) : null;
            const wp = behindWp || (currentSettings.fightUseWideOrbit
              ? (pickWideOrbitWaypoint(player.gridX, player.gridY, moveTargetX, moveTargetY) ||
                 pickLargeOrbitWaypoint(player.gridX, player.gridY, moveTargetX, moveTargetY))
              : pickLargeOrbitWaypoint(player.gridX, player.gridY, moveTargetX, moveTargetY));
            bossFightOrbitWaypointX = wp.x;
            bossFightOrbitWaypointY = wp.y;
            bossFightOrbitLastAssignTime = now;
            markRecentFightWaypoint(wp.x, wp.y, 10);
            if (behindWp) statusMessage = `Kiting Boss... (behind)`;
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
      if (!mapCompleteFlowStartTime) { mapCompleteFlowStartTime = stateStartTime || now; precursorBeaconActivatedThisMap = false; precursorBeaconScanAt = 0; precursorBeaconCache = null; }
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

      // Phase 3.5: activate a Precursor (Tower) Beacon if one is present -- RARE; AFTER loot, before the portal.
      if (currentSettings.activatePrecursorBeacon !== false && !precursorBeaconActivatedThisMap) {
        const beacon = findPrecursorBeacon(player, now);
        // Only chase/activate a beacon that's actually IN this map -- a cross-map one (e.g. 2465u) would get navTo'd
        // forever and BLOCK the portal. Beyond the cap -> skip it + fall through to Phase 4 (return to hideout).
        if (beacon && beacon._d <= PRECURSOR_BEACON_MAX_DIST) {
          if (beacon._d > 22) {
            navTo(beacon.gridX, beacon.gridY, 'Precursor Beacon', now);
            statusMessage = `Map complete: -> Precursor Beacon ${beacon._d.toFixed(0)}u`;
            break;
          }
          if (now - precursorBeaconInteractAt >= 1400) {
            precursorBeaconInteractAt = now;
            interactWithEntity(beacon);                                       // 01A3 interact (press)
            try { poe2.sendPacket(new Uint8Array([0x01, 0xAA, 0x01])); } catch (_) {}  // 01AA release
            log(`[Precursor] activated Tower Beacon id=${beacon.id}`);
            precursorBeaconActivatedThisMap = true;
          }
          statusMessage = `Map complete: activating Precursor Beacon`;
          break;
        }
        if (beacon) log(`[Precursor] beacon ${beacon._d.toFixed(0)}u away (>${PRECURSOR_BEACON_MAX_DIST}u, cross-map) -> skip, go to portal`);
        precursorBeaconActivatedThisMap = true;   // none nearby -> proceed to portal, don't re-scan
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
              `Map complete: send open-town-portal packet (00 CF 01) ` +
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
        interactWithEntity(returnPortal);
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
    // Fresh start on EITHER toggle: clear stale state + boss target. The plugin is NOT reloaded on a GAME relog,
    // so a WALKING_TO_BOSS_MELEE + stale bossGridX/Y from the previous map survives -> re-enabling resumed a
    // blind "Boss Melee Forward Push" toward a dead target. resetMapper -> IDLE -> clean FINDING_BOSS, so we
    // re-find the arena/checkpoint BEFORE any melee-push.
    resetMapper();
    sendStopMovementLimited(true);
  }

  ImGui.sameLine();
  ImGui.textColored(
    enabled.value ? [0, 1, 0, 1] : [1, 0.3, 0.3, 1],
    enabled.value ? '[ACTIVE]' : '[OFF]'
  );

  const showDebug = new ImGui.MutableVariable(!!currentSettings.showDebugTools);
  if (ImGui.checkbox("Show Debug Tools", showDebug)) saveSetting('showDebugTools', showDebug.value);

  // --- Full-loop master toggles ---
  const autoPickMaps = new ImGui.MutableVariable(currentSettings.hideoutFlowEnabled !== false);
  if (ImGui.checkbox("Auto-pick & enter maps", autoPickMaps)) saveSetting('hideoutFlowEnabled', autoPickMaps.value);
  const releaseDeath = new ImGui.MutableVariable(currentSettings.releaseOnDeath !== false);
  if (ImGui.checkbox("Release on death", releaseDeath)) saveSetting('releaseOnDeath', releaseDeath.value);

  const clrRares = new ImGui.MutableVariable(currentSettings.clearRares !== false);
  if (ImGui.checkbox("Engage nearby rares/uniques", clrRares)) saveSetting('clearRares', clrRares.value);
  // CLICK-TO-MOVE UI HIDDEN (user: revisit later). Backend gated off by CLICK_TO_MOVE_READY=false; re-show when tuned.
  // const clickMove = new ImGui.MutableVariable(currentSettings.clickToMove !== false);
  // if (ImGui.checkbox("Click-to-move (game pathfinder -- needs in-game Move=Mouse)", clickMove)) saveSetting('clickToMove', clickMove.value);
  const dz = new ImGui.MutableVariable(!!currentSettings.drawDangerZones);
  if (ImGui.checkbox("Draw danger zones (RED -- what auto-dodge sees on bosses/rares)", dz)) saveSetting('drawDangerZones', dz.value);
  const stopInvFull = new ImGui.MutableVariable(currentSettings.stopWhenInventoryFull !== false);
  if (ImGui.checkbox("Stop in hideout if inventory full (AFK safety)", stopInvFull)) saveSetting('stopWhenInventoryFull', stopInvFull.value);
  const drawLn = new ImGui.MutableVariable(currentSettings.drawLines !== false);
  if (ImGui.checkbox("Draw lines to things (boss + content)", drawLn)) saveSetting('drawLines', drawLn.value);

  ImGui.separator();
  if (ImGui.treeNode("Map Objectives")) {
    const clrInc = new ImGui.MutableVariable(currentSettings.clearIncursion !== false);
    if (ImGui.checkbox("Incursion (Vaal Chests)", clrInc)) saveSetting('clearIncursion', clrInc.value);
    const clrBreach = new ImGui.MutableVariable(currentSettings.clearBreach === true);
    if (ImGui.checkbox("Breach (walk to Brequel + roam 35s)", clrBreach)) saveSetting('clearBreach', clrBreach.value);
    const clrAbyss = new ImGui.MutableVariable(currentSettings.clearAbyss !== false);
    if (ImGui.checkbox("Abyss (big nodes, fight around)", clrAbyss)) saveSetting('clearAbyss', clrAbyss.value);
    const deliMirror = new ImGui.MutableVariable(currentSettings.deliriumMirrorEnabled !== false);
    if (ImGui.checkbox("Delirium (walk into start mirror)", deliMirror)) saveSetting('deliriumMirrorEnabled', deliMirror.value);
    const clrVerisium = new ImGui.MutableVariable(currentSettings.clearVerisiumRemnants !== false);
    if (ImGui.checkbox("Verisium (Runeshape Looter)", clrVerisium)) saveSetting('clearVerisiumRemnants', clrVerisium.value);
    const actBeacon = new ImGui.MutableVariable(currentSettings.activatePrecursorBeacon !== false);
    if (ImGui.checkbox("Activate Precursor Beacon (after loot)", actBeacon)) saveSetting('activatePrecursorBeacon', actBeacon.value);
    ImGui.treePop();
  }

  ImGui.separator();
  if (ImGui.treeNode("Map Opener: device + waystone")) {
    if (!isMapperMasterEnabled()) {
      ImGui.textColored([1.0, 0.8, 0.2, 1.0], 'Mapper is OFF - these settings are currently inactive.');
    }
    ImGui.textWrapped("Used when 'Auto-pick & enter maps' is ON: find Map Device, open atlas, select map, place waystone/precursors.");
    const portalRetries = new ImGui.MutableVariable(currentSettings.hideoutPortalEnterMaxAttempts || 4);
    if (ImGui.sliderInt("Portal entry max attempts", portalRetries, 1, 4)) {
      saveSetting('hideoutPortalEnterMaxAttempts', portalRetries.value);
    }
    const portalEnterDelay = new ImGui.MutableVariable(Math.max(0, Math.floor(Number(currentSettings.hideoutPortalEnterDelayMs || 1200))));
    if (ImGui.sliderInt("Portal entry delay (ms)", portalEnterDelay, 0, 5000)) {
      saveSetting('hideoutPortalEnterDelayMs', portalEnterDelay.value);
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
    const wsIdentifiedOnly = new ImGui.MutableVariable(currentSettings.waystoneIdentifiedOnly !== false);
    if (ImGui.checkbox("Identified Only (default on)##ws", wsIdentifiedOnly)) {
      saveSetting('waystoneIdentifiedOnly', wsIdentifiedOnly.value);
    }
    if (currentSettings.waystoneIdentifiedOnly !== false) {
      ImGui.textColored([0.6, 1.0, 0.6, 1.0], "Identified Only: never places an unidentified waystone.");
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

      ImGui.text("Tablet types to use (1 of each per map; never a duplicate of a type already in the device):");
      for (let i = 0; i < TABLET_NAMES.length; i++) {
        const tn = TABLET_NAMES[i];
        const tv = new ImGui.MutableVariable(isTabletEnabled(tn));
        const shortLbl = tn.replace(/\s*Tablet$/i, '');
        if (ImGui.checkbox(`${shortLbl}##tab`, tv)) saveSetting(tabletSettingKey(tn), tv.value);
        if (i % 2 === 0) ImGui.sameLine();  // 2 per row
      }
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
    if (showDebug.value && ImGui.treeNode("Traverse Packet Debug")) {
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

  if (showDebug.value) ImGui.separator();
  if (showDebug.value && ImGui.treeNode("All Inventory Contexts (incl. hidden)")) {
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

  if (showDebug.value) ImGui.separator();
  if (showDebug.value && ImGui.treeNode("Test Map Activation")) {
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
      atlasData = getAtlasCached();
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
          const pkt = new Uint8Array([0x00, 0xF7, 0x01, ...xB, ...yB]);
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
          const pkt5 = new Uint8Array([0x00, 0xF7, 0x01, ...xB5, ...yB5]);
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
            const pktA = new Uint8Array([0x00, 0xF7, 0x01, ...xBA, ...yBA]);
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
    const autoDodgeEnabled = new ImGui.MutableVariable(!!currentSettings.autoDodgeEnabled);
    if (ImGui.checkbox("Auto Dodge (telegraphs/projectiles/ground/melee)", autoDodgeEnabled)) {
      saveSetting('autoDodgeEnabled', autoDodgeEnabled.value);
    }
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "  folded-in AutoDodge -- runs in every state, no plugin needed");
    try { const ds = autoDodgeStatus(); ImGui.text("  live: " + ds.lastDecision + "  |  hazards: " + ds.hazards); } catch (e) {}
    if (ImGui.button("Test Dodge (left)")) sendDodgeRoll(-1, 1);
    ImGui.separator();

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

  // ---- Uncompleted Atlas Maps ---- (cached read via getAtlasCached; "Re-read##atlas" button forces fresh)
  const atlas = getAtlasCached();
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
    ImGui.sameLine();
    if (ImGui.button("Re-read##atlas")) uiAtlasCache = null;   // force ONE fresh read (refreshes the panel once)

    if (showDebug.value && uncompletedNodes.length > 0 && ImGui.treeNode(`Uncompleted Maps (${uncompletedNodes.length})###uncompleted_maps`)) {
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

  if (showDebug.value) {
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
  } // end Show Debug Tools wrap

  ImGui.end();
}

// ============================================================================
// PLUGIN EXPORT
// ============================================================================

// ── Target lines, drawn straight from the mapper (it knows the live targets) ─────────────────────
// boss=orange, breach=purple, incursion=yellow, delirium=gray. The breach line tracks the CACHED center
// during an active breach (the Brequel despawns on activation). Targets refreshed ~5Hz, drawn each frame.
function mlColor(r, g, b, a) { return ((Math.floor(a * 255) << 24) | (Math.floor(b * 255) << 16) | (Math.floor(g * 255) << 8) | Math.floor(r * 255)) >>> 0; }
const ML_BOSS = mlColor(1.00, 0.55, 0.10, 0.95);
const ML_INC  = mlColor(1.00, 0.90, 0.20, 0.95);
const ML_DELI = mlColor(0.66, 0.66, 0.66, 0.95);
const ML_BRCH = mlColor(0.72, 0.32, 1.00, 0.95);
const ML_ABYSS = mlColor(0.20, 1.00, 0.30, 0.95);       // active/INCOMPLETE abyss big node (GREEN)
const ML_ABYSS_DONE = mlColor(0.45, 0.45, 0.45, 0.80);  // COMPLETED abyss big node (gray) -- proves the distinction
let mlTargets = [], mlLastGather = 0, _brDbgAt = 0;

function gatherMapperLineTargets(player, now) {
  const t = [];
  let bx = bossGridX, by = bossGridY, bl = 'BOSS';
  if (!(Number.isFinite(bx) && Number.isFinite(by) && (bx || by))) { const rb = getRadarBossTarget(); if (rb) { bx = rb.x; by = rb.y; } }
  // No real boss target visible -> point the line at the HIDDEN arena (VaalBossStatue/arena cluster) so you
  // can see where the bot is actually heading.
  // ARENA fallback (USER 2026-06-27: only for ACTUAL boss rooms): draw only when the hint is a real arena STRUCTURE
  // (VaalBossStatue/Throne/BossArenaBlocker/Checkpoint), NOT the boss-MOB guess -- that mislabels rarity-unique rares
  // (stray crabs/turtles with a boss-ish path) as "ARENA". The boss-mob hint still drives navigation, just draws no line.
  if (!(Number.isFinite(bx) && Number.isFinite(by) && (bx || by))) { const ah = findBossArenaHint(player, now); if (ah && ah.src === 'arena-obj') { bx = ah.x; by = ah.y; bl = 'ARENA'; } }
  if (Number.isFinite(bx) && Number.isFinite(by) && (bx || by)) t.push({ gx: bx, gy: by, c: ML_BOSS, l: bl });
  if (currentSettings.clearIncursion !== false) try { for (const ch of getUnopenedVaalChests(now)) t.push({ gx: ch.gridX, gy: ch.gridY, c: ML_INC, l: 'Incursion' }); } catch (e) {}
  try { const dp = nearestDeliriumPiece(player); if (dp) t.push({ gx: dp.gx, gy: dp.gy, c: ML_DELI, l: 'Delirium' }); } catch (e) {}
  // BREACH (only when clearing breach): while active, line the cached center ONLY if breach mobs are still alive
  // (else done/collapsed -- no stale line). Otherwise line the nearest un-opened, non-blacklisted Brequel.
  if (currentSettings.clearBreach === true) {
    let breachMobsLeft = false;
    if (rotBreachActivatedAt) { try { breachMobsLeft = (poe2.getAllEntities() || []).some(e => /\/Monsters\/Breach\//i.test(e.name || '') && e.isAlive !== false); } catch (e) {} }
    if (rotBreachActivatedAt && breachMobsLeft) t.push({ gx: rotBreachCenterX, gy: rotBreachCenterY, c: ML_BRCH, l: 'Breach' });
    else { try { const b = nearestBreachPoint(player, now); if (b) t.push({ gx: b.gridX, gy: b.gridY, c: ML_BRCH, l: 'Breach' }); } catch (e) {} }
  }
  // ABYSS (only when clearing abyss): GREEN line to each ACTIVE big node (iconType 890), GRAY to done/dead (891).
  if (currentSettings.clearAbyss !== false) try {
    for (const ab of (poe2.getEntities({ nameContains: 'AbyssFinalNodeBase', lightweight: false }) || [])) {
      if (!/AbyssFinalNodeBase/i.test(ab.name || '')) continue;
      if (abyssNodeStatus(ab, now) === 'active') t.push({ gx: ab.gridX, gy: ab.gridY, c: ML_ABYSS, l: 'Abyss' });   // green active only; no gray
    }
  } catch (e) {}
  if (currentSettings.showDebugTools) debugBreach(player, now);
  return t;
}

// Debug: log the breach state ~1/s (enable "Show Debug Tools") so we can see WHY a breach line persists.
function debugBreach(player, now) {
  if (now - _brDbgAt < 1000) return;
  _brDbgAt = now;
  let brq = null, brqBL = false;
  try { for (const x of (poe2.getEntities({ nameContains: 'BrequelInitiator', lightweight: true }) || [])) { if (/BrequelInitiator/i.test(x.name || '')) { brq = x; brqBL = (rotBreachBlacklist.get(x.id) || 0) > now; break; } } } catch (e) {}
  let mobs = 0;
  try { mobs = (poe2.getAllEntities() || []).filter(e => /\/Monsters\/Breach\//i.test(e.name || '') && e.isAlive !== false).length; } catch (e) {}
  log(`[BreachDBG] active=${rotBreachActivatedAt ? Math.round((now - rotBreachActivatedAt) / 1000) + 's' : 'no'} center=(${Math.round(rotBreachCenterX)},${Math.round(rotBreachCenterY)}) clearTimer=${rotBreachLastMobAt ? Math.round((now - rotBreachLastMobAt) / 1000) + 's' : '-'} breachMobsAlive=${mobs} brequel=${brq ? `(${Math.round(brq.gridX)},${Math.round(brq.gridY)}) id=${brq.id} blacklisted=${brqBL}` : 'none'} clearBreach=${currentSettings.clearBreach === true}`);
}

let mlPublishAt = 0;
// PATHWAY-STYLE content lines: publish ONE colored WALKABLE ROUTE per content target (boss=orange,
// breach=purple, abyss=green, incursion=yellow, delirium=gray) to the C++ renderer (setRadarPaths), which
// draws them on the minimap + large map + 3D world. Routes go AROUND walls (findPathTerrain over the whole-map
// static grid); a target the pathfinder can't reach falls back to a straight 2-point line so it still shows.
// Throttled (the C++ renderer redraws every frame), capped to bound the per-publish flood cost.
function drawMapperLines() {
  const now = Date.now();
  if (now - mlPublishAt < 600) return;   // recompute + publish on this interval only; C++ draws every frame
  mlPublishAt = now;
  const active = isMapperMasterEnabled() && currentSettings.drawLines !== false;
  if (!active) { try { poe2.setRadarPaths([]); } catch (e) {} return; }   // off -> clear routes + release to objective auto-pather
  let player; try { player = POE2Cache.getLocalPlayer(); } catch (e) { return; }
  if (!player || player.gridX == null) return;
  let targets; try { targets = gatherMapperLineTargets(player, now); } catch (e) { targets = []; }
  const px = Math.floor(player.gridX), py = Math.floor(player.gridY);
  const routes = [];
  for (const t of targets.slice(0, 8)) {
    if (!Number.isFinite(t.gx) || !Number.isFinite(t.gy)) continue;
    const tx = Math.floor(t.gx), ty = Math.floor(t.gy);
    let pts = null;
    try { pts = poe2.findPathTerrain(px, py, tx, ty); } catch (e) {}
    if (!pts || pts.length < 2) {
      // Target unreachable (sealed arena / across a void). Route to the FARTHEST REACHABLE point toward it so we
      // draw the walkable way as far as it goes, instead of a straight line ploughing through walls.
      for (const fr of [0.8, 0.6, 0.4]) {
        const mx = Math.floor(px + (tx - px) * fr), my = Math.floor(py + (ty - py) * fr);
        let part = null;
        try { part = poe2.findPathTerrain(px, py, mx, my); } catch (e) {}
        if (part && part.length >= 2) { pts = part; break; }
      }
    }
    if (!pts || pts.length < 2) pts = [{ x: px, y: py }, { x: tx, y: ty }];   // last-resort straight line (whole direction unreachable)
    routes.push({ points: pts, color: (t.c >>> 0), label: t.l });
  }
  try { poe2.setRadarPaths(routes); } catch (e) {}
}

function onDraw() {
  drawUI();
  try { drawMapperLines(); } catch (e) {}
  if (currentSettings.drawDangerZones) { try { const _p = POE2Cache.getLocalPlayer(); if (_p) drawDangerZones(_p.worldZ); } catch (e) {} }
}

export const mapperPlugin = { name: 'Mapper', onDraw };

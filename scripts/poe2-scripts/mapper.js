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

// ============================================================================
// TGT-TILE TARGET DATABASE (ExileCore2 "Radar" method, adopted 2026-07-02)
// ----------------------------------------------------------------------------
// poe2.getTgtLocations() returns { locations: { "<full tile path>": [{x,y},...] } } for the CURRENT area. exCore2's
// Radar matches those tile paths (regex) against a per-area targets.json to KNOW where the boss/content is from
// map-entry, then routes DIRECTLY there (no blind exploration -> no yoyo). Schema mirrors exCore2/Radar/targets.json:
// keyed by area RawName (we key by lowercased areaId), each { boss:[patterns], <content>:[patterns] } where a pattern
// is a regex tested against the tile path. '_default' = generic fallback used when a map has no curated entry.
// PROVEN LIVE 2026-07-02 (Cenotes): "Metadata/Terrain/Maps/Cenotes/Tiles/CenotesArena01.tdt" = 144-tile boss arena
// cluster @~(1150,2130). PoE2 endgame arenas are consistently named "<Map>Arena<NN>", so the generic 'Arena\d' +
// densest-cluster isolates the real arena from stray matches (the false-positive worry the old strict list avoided).
// TODO: add per-map curated entries as we dump getTgtLocations on each map (the exCore2 instance-dumper approach).
const TARGETS_DB = {
  '_default': { boss: ['Arena\\d', 'BossArena', 'pillararena', 'arenatransition', 'pinnacle', 'tower_beacon'] },
  'mapcenotes': { boss: ['CenotesArena'] },
};

// Densest-cluster center of tile positions (robust to stray matched tiles). Picks the point with the most neighbors
// within `radius`, then averages all points within `radius` of it. For a SINGLE boss arena this returns its true
// center (K-Means would split one blob into k sub-clusters -> off-center); for stray-polluted matches it isolates the
// real (densest) arena. O(n^2) but n is small (~150 arena tiles) and the result is cached per area. -> {x,y,size}|null.
function densestClusterCenter(points, radius) {
  const n = points.length;
  if (n === 0) return null;
  if (n <= 2) { let sx = 0, sy = 0; for (const p of points) { sx += p.x; sy += p.y; } return { x: sx / n, y: sy / n, size: n }; }
  const r2 = radius * radius;
  let bestI = 0, bestCount = -1;
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let j = 0; j < n; j++) { const dx = points[i].x - points[j].x, dy = points[i].y - points[j].y; if (dx * dx + dy * dy <= r2) c++; }
    if (c > bestCount) { bestCount = c; bestI = i; }
  }
  const cx = points[bestI].x, cy = points[bestI].y;
  let sx = 0, sy = 0, cnt = 0;
  for (let j = 0; j < n; j++) { const dx = points[j].x - cx, dy = points[j].y - cy; if (dx * dx + dy * dy <= r2) { sx += points[j].x; sy += points[j].y; cnt++; } }
  return { x: sx / cnt, y: sy / cnt, size: cnt };
}

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
  // DORMANT-BOSS ACTIVATION (default ON): treat an idle-loop boss (hasActiveAction=false, currentActionTypeId=0) as NOT
  // acting so the press-in gate can fire, and drive the press-in to the arena centre to trigger staged/dormant twins that
  // only aggro when the player walks into the middle of the room. OFF = raw bossIsActing + press-in to the boss entity.
  fightActivateDormantBoss: true,
  // RANGED-KITE (opt-in, DEFAULT OFF): for a bow/ranged build (Tornado Shot) -- hold the boss at bossKiteRange (never
  // enter melee <45u) and radial-retreat when it closes inside that band, reusing the existing kite machinery. OFF =
  // the melee walk-to-30u entry stays byte-parity.
  kiteBoss: false,
  bossKiteRange: 75,          // stand-off (u) held from the boss when kiteBoss is ON; ~60-80 = bow range (clamped 45-140)
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
  objectiveGoalMode: true,      // DEFAULT ON (user 2026-07-03): complete ALL required map objectives (incursion/breach/abyss beacons) BEFORE the boss + don't leave until they're done. OFF = legacy boss-first. Requires mapCompleteAutoReturnToHideout (already default true).
  bossReachV2: true,            // DEFAULT ON: boss-reaching v2 -- with a CONFIDENT boss bearing, macro-route the fogged arena FIRST (elite-chase only when on-the-way) + fog-seal becomes a short checkpoint-approach cooldown instead of erasing the target. OFF = legacy elite-first / target-erase fog-seal. Gates the FINDING_BOSS shared-path changes for byte-parity.
  stopWhenInventoryFull: true,  // AFK SAFETY: while in hideout, don't start a new map if the inventory is full (auto-resumes when cleared)
  inventoryFullStopFreeCells: 2,// "full" = this many or fewer free 1x1 cells left in the main inventory
  drawLines: true,              // MASTER toggle: draw lines to things (boss + incursion/breach/abyss/delirium)
  drawContentMarkers: true,     // RadarV2 minimap: colored diamond per discovered content (boss/abyss/breach/incursion/verisium); dim=completed
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
let meleeQueueScanAt = 0;   // throttle for the reduced-rate content discovery during the final melee walk-in (server streams new content as we close on the arena)
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
let _s5EliteId = 0, _s5SwitchAt = 0;           // STRATEGY-5 sticky branch latch: engaged elite id + last elite/explore branch switch
let bossCkptX = NaN, bossCkptY = NaN;   // USER: persist the boss checkpoint once SEEN -> a high-conf bearing that SURVIVES the marker de-streaming, so the bot keeps committing toward it instead of wandering after it abandons an unreachable approach
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
// objectiveGoalMode post-boss content-cleanup clocks (0 = inactive). Seeded at MAP_COMPLETE entry; read ONLY when objGoalOn().
let mapCompleteCleanupStartAt = 0;         // HARD budget clock: (now - this) >= OBJ_CLEANUP_BUDGET_MS -> stop cleaning, portal out
let mapCompleteCleanupNoProgressSince = 0; // fast-out clock: nothing reachable for OBJ_CLEANUP_NOPROGRESS_MS -> portal out (don't burn full budget)
let mapCompleteProgressCount = -1;         // outstanding-objective count snapshot: a DROP (= a completion) refreshes the cleanup budget window
let mapCompleteCleanupDone = false;        // latched once the cleanup CONCEDES (budget spent / nothing reachable) -> never re-enter it, head straight for the portal
let mapCompleteContentDriveAt = 0;         // last time the cleanup ACTIVELY drove content (abyss hover/hive/beacon) -> suppresses the death-ground escape (fight damage is expected)
let mapCompleteSkipSettle = false;         // MAP_COMPLETE entered with the boss ALREADY dead (no fresh kill) -> skip the retreat/wait/utility settle phases, sweep immediately
// objectiveGoalMode PRE-boss content-hold clocks (0 = inactive). Seeded on the FIRST pre-boss hold this map; read ONLY when objGoalOn().
let preBossHoldStartAt = 0;         // HARD budget clock (ULTIMATE cap): (now - this) >= PREBOSS_HOLD_BUDGET_MS -> engage the boss. RESET whenever a required objective completes (each beacon buys a fresh window) so a multi-beacon map with detours isn't cut off mid-pursuit.
let preBossHoldNoProgressSince = 0; // fast-out clock: nothing reachable for PREBOSS_HOLD_NOPROGRESS_MS -> engage the boss
let preBossEnergCount = 0;          // energisedBeacons.length seen last pre-boss frame -> a rise = a beacon done = progress = reset the budget wall
// per-required-target stuck detector (fog-route): ban a required objective we can't get CLOSER to, so we try the next one / boss instead of holding forever on an unreachable one.
let preBossReqKey = null, preBossReqBestDist = Infinity, preBossReqStuckAt = 0, preBossReqLastFrameAt = 0;
// CHANGE 3 (bossReachV2 / ARBITER): ONE global pre-boss content-deferral budget. With a CONFIDENT boss anchor known,
// content that keeps preempting the boss = the map never finishes. Reuses PREBOSS_HOLD_BUDGET_MS as the ULTIMATE cap
// + a ~30s no-boss-progress fast-out; both reset on a required-objective completion (each beacon buys a fresh window).
// arbBossDeferSince=0 => not currently deferring; arbBossDeferSpent mirrors the last decision for the utility gate (CHANGE 4).
let arbBossDeferSince = 0, arbBossDeferBestDist = Infinity, arbBossDeferImprovedAt = 0, arbBossDeferEnergCount = 0, arbBossDeferSpent = false;
const PREBOSS_BOSS_FASTOUT_MS = 30000;   // no boss-anchor approach for this long while deferring content -> engage the boss (secondary to the 240s ULTIMATE cap)
// CHANGE 2 (ARBITER): last time the WALKING_TO_BOSS_CHECKPOINT case actually stepped the walker. When content/utility/dodge
// preempted the case, the wall-clock watchdog would age into a false fog-block on resume -> count WALK time, not wall time.
let lastCheckpointStepAt = 0;
// CHANGE 5 (bossReachV2): after a genuine fog-seal, keep the bearing + boss target and impose a SHORT checkpoint-approach
// cooldown (explore/reveal around the seal, then re-attempt) instead of erasing the target and re-exploring blind.
let bossCheckpointApproachCooldownUntil = 0;
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
let _dodgeDiagAt = 0;           // throttle for the opt-in (dodgeDebug) state+mode diag
let _lockTickAt = 0;            // previous opener/pickit-yield frame ts -- used to PAUSE dwell timers while serviced
let _portalLootHoldAt = 0;      // first portal-intent ts -- bounds the pre-portal loot-collect hold
let _portalOpenChkAt = 0, _portalOpenLeft = 0;   // throttled unopened-openables count for the portal gate
let _cleanupDriveAt = 0;        // last frame tryCleanupContent drove a target -- discover only runs 5s after it stops
let pbWalkX = NaN, pbWalkY = NaN, pbWalkStartAt = 0, pbAcquireAt = 0;   // Precursor Beacon final leg (any distance)
const _pbTrack = mkProgressTracker();
let _cleanupRejLogAt = 0;       // throttle for the active-but-rejected diagnostic line
let mapCompleteUtilityExtendUntil = 0;           // portal-gate window extension: utility keeps selecting while targets remain
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
// PRESS-IN-TO-ACTIVATE (kite only): detect a proximity-gated phase (boss immune/inert while we hold the kite floor)
// as an HP-stall and temporarily press in. Keyed to the tracked boss id so a boss swap can't corrupt the diff.
let pressInHpBossId = 0;      // id the HP samples below belong to
let pressInLastHpValue = NaN; // that boss's healthCurrent last FIGHTING_BOSS tick
let pressInLastDropAt = 0;    // timestamp of the last real HP decrease (ms)
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
const _utTrack = mkProgressTracker();   // owned-progress tracker for the utility unreachable ban
let _sbChkAt = 0, _sbOpen = false, _sbOpenAt = 0;   // strongbox event hold: throttled targetable read + open ts
let utilityNoPathCount = 0;
let utilityArrivalWaitStart = 0;
let utilityLastYieldAt = 0, utilityYieldCount = 0;   // T0.6: dwell-until-settled at an openable/loot -- count distinct yields; don't leave on the FIRST (essence = 3 touches, loot pile = N items)
let utilityDetourUntil = 0;
let utilityLastSelectedKey = '';
let utilityResumeState = STATE.IDLE;
let utilitySessionStartTime = 0;
// OPENER-RACE FIX (2026-07-02): the utility STEP runs only on UNLOCKED frames (the movement-lock yield returns before it),
// so the timeout branch can NEVER observe a live isMovementLocked(). Stamp servicing-recency from the yield block instead.
// No cross-session reset needed: the earliest _servicing check (no-net-progress @5s / timeout @>=5s) is always past the
// 2.5s window, so a stale stamp from a prior target self-clears before it could falsely grace the next one.
let utilityLastServicedAt = 0;
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
  if (now - bossArenaHintAt < 8000) return bossArenaHintCache;   // last-resort bearing + an UNCAPPED getAllEntities (~26ms, ~125ms juiced) now on the arbiter DRIVING path -> throttle harder
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
// ===== MOVEMENT BROKER (user: 'one movement writer at a time, THREAD SAFE') =====
// Every movement send funnels through the five primitives below; the broker gates them all. Each subsystem
// declares itself the current WRITER at its entry point (MB.set); a send is allowed unless a STRICTLY
// higher-priority owner has sent within the ownership window. Ladder: dodge(1) > fight(2) > content(3) >
// utility(4) > nav/explore(5). Blocking startWalkingTo too makes target-name theft (the foreign-path
// false-ban class) mechanically impossible.
// moveBroker OFF (default): byte-parity behavior + SHADOW LOG of every would-be block ('[MB] shadow-block')
// so the fight-map is visible live. ON: lower-priority sends are dropped for the window (700ms).
const MB = {
  cur: { owner: 'nav', prio: 5 },
  hold: { owner: '', prio: 9, at: 0 },
  WINDOW: 700,
  logAt: 0,
  set(owner, prio) { this.cur.owner = owner; this.cur.prio = prio; },
  gate() {
    const now = Date.now();
    const c = this.cur, h = this.hold;
    const blocked = h.at && (now - h.at) < this.WINDOW && h.owner !== c.owner && h.prio < c.prio;
    if (!blocked) { h.owner = c.owner; h.prio = c.prio; h.at = now; return true; }
    const enforce = currentSettings.moveBroker === true;
    if (now - this.logAt > 1500) {
      this.logAt = now;
      log(`[MB] ${enforce ? 'BLOCK' : 'shadow-block'}: ${c.owner}(p${c.prio}) vs holder ${h.owner}(p${h.prio})`);
    }
    return !enforce;
  },
};

function sendMoveAngleLimited(angleDeg, dist, force = false) {
  if (!MB.gate()) return false;
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
  if (!MB.gate()) return false;
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
  if (!MB.gate()) return false;
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
  if (!MB.gate()) return false;
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
const DELIRIUM_PUSH_REACH = 55;   // within this of the delirium mirror -> push straight into it (walk-into-to-activate), don't path around it
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
let rotBreachOppFlipAt = 0;                             // last opposite-side jump (4s dry corner -> cross the ring)
let rotBreachLastMobPX = NaN, rotBreachLastMobPY = NaN; // player pos at last mob seen = where the collapse loot lands
let rotBreachSawMob = false;           // did ANY breach mob spawn this activation? no -> already-complete breach
let rotBreachMobBL = new Map();        // breach mob id -> expiry (mobs we can't reach -- behind a wall/pit)
let rotBreachTgtId = 0, rotBreachTgtSince = 0;  // current pursued mob id + start (stuck/yoyo detection)
let rotBreachStabilised = false;       // a Rare/Unique breach mob has spawned -> head BACK to the center for it
let rotBreachStabilisedLogged = false; // one-shot guard for the "stabilised -> returning" log line
// ANTI-GUILLOTINE (user): a dwell/phase timer gates STARTING new work -- it must never end collection in flight.
// Every post-content loot dwell holds ON past its base time while pickit still has matching drops in range,
// bounded by each site's own hard cap so a walled/unpickable item can't trap the map. 600ms-cached: the dwell
// sites poll every frame and the pickit feed scans entities.
let _lootLeftAt = 0, _lootLeftVal = false, _lootLeftR = 0;
function lootStillLeft(radius) {
  const _n = Date.now(), _r = radius || 70;
  if (_n - _lootLeftAt < 600 && _lootLeftR === _r) return _lootLeftVal;
  _lootLeftAt = _n; _lootLeftR = _r;
  try { _lootLeftVal = (getLootCandidatesForMapper(_r) || []).length > 0; } catch (_) { _lootLeftVal = false; }
  return _lootLeftVal;
}
// ===== COMMITMENT DISCIPLINE (user): a target may only be BANNED for unreachability measured while WE owned
// the movement. Frames where movement belonged to someone else (opener/pickit lock, dodge suppression, another
// writer's walk) never tick the no-progress clock; preemption re-queues, it never bans. trackOwnedProgress is
// the shared primitive: accumulate owned-no-progress ms per target key; gaps >1s (preempted / not called) add 0.
function mkProgressTracker() { return { key: '', bestD: Infinity, ownedMs: 0, lastAt: 0 }; }
function trackOwnedProgress(tr, key, dist, owned, now) {
  if (tr.key !== key) { tr.key = key; tr.bestD = dist; tr.ownedMs = 0; tr.lastAt = now; return 0; }
  const dt = Math.min(Math.max(now - tr.lastAt, 0), 1000);
  tr.lastAt = now;
  if (dist < tr.bestD - 6) { tr.bestD = dist; tr.ownedMs = 0; return 0; }
  if (owned) tr.ownedMs += dt;
  return tr.ownedMs;
}
// LOOT SWEEP (user: mapper movement FIGHTS the pickit interact auto-walk): with pickit's interact range turned
// DOWN (short lock-friendly grabs), the MAPPER walks each remaining drop into grab range nearest-first -- ONE
// movement writer. Site-anchored so drops can't lead us off the site. A spot bans ONLY when truly unpickable
// (stood in grab range 8s, item still in the feed); path trouble just tries the next drop.
const _lsBan = new Map();
let _lsTgtKey = '', _lsTgtAt = 0, _lsActiveAt = 0;
function sweepLootStep(player, now, ax, ay, siteR) {
  if (!Number.isFinite(ax) || !player) return false;
  MB.set('content', 3);
  let cands = [];
  try { cands = getLootCandidatesForMapper(Math.max(90, siteR)) || []; } catch (_) { return false; }
  let best = null, bestD = Infinity, left = 0;
  for (const c of cands) {
    const e = c.entity; if (!e || !Number.isFinite(e.gridX)) continue;
    if (Math.hypot(e.gridX - ax, e.gridY - ay) > siteR) continue;
    const bk = Math.round(e.gridX / 6) + ':' + Math.round(e.gridY / 6);
    if ((_lsBan.get(bk) || 0) > now) continue;
    left++;
    const d = Math.hypot(e.gridX - player.gridX, e.gridY - player.gridY);
    if (d < bestD) { bestD = d; best = { x: e.gridX, y: e.gridY, bk }; }
  }
  if (!best) { _lsTgtKey = ''; return false; }
  _lsActiveAt = now;                                  // utility selection stands down while the sweep owns movement
  if (bestD <= 14) {
    sendStopMovementLimited();                        // in grab range -> hold; pickit's short interact takes the lock
    if (_lsTgtKey !== best.bk) { _lsTgtKey = best.bk; _lsTgtAt = now; }
    else if (now - _lsTgtAt > 8000) { _lsBan.set(best.bk, now + 120000); log(`[LootSweep] drop at (${Math.round(best.x)},${Math.round(best.y)}) unpickable 8s -> skip`); }
  } else {
    _lsTgtKey = '';
    navTo(best.x, best.y, 'Loot Sweep', now);
  }
  statusMessage = `Loot sweep: ${left} drop(s), nearest ${Math.round(bestD)}u`;
  return true;
}
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
    // The MAP BOSS is never a rotation rare: chasing it here (12s timeout, rare-mode dodge, no press-in machinery)
    // delays the boss-flow engage detector by the whole timeout. Skip -> the boss flow promotes immediately.
    try { if (sub.includes('Unique') && isEntityLikelyMainObjectiveBoss(e)) continue; } catch (_) {}
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
// HAZARD TERRAIN near (fungal burst spawners): arms the dodge like a rare would -- the exploding-mushroom
// patches (no Life/Actor, invisible to every other net) must be seen, avoided, and drawn OUTSIDE fights too.
// nameContains filters in C++ (cheap); 500ms throttle.
let _hzTerrAt = 0, _hzTerrVal = false;
function hazardTerrainNear(now) {
  if (now - _hzTerrAt < 500) return _hzTerrVal;
  _hzTerrAt = now;
  _hzTerrVal = false;
  try { _hzTerrVal = (poe2.getEntities({ nameContains: 'FungalBurst', maxDistance: 90, lightweight: true }) || []).length > 0; } catch (_) {}
  return _hzTerrVal;
}
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
  // The mirror is a PHYSICAL object you WALK INTO to start it (not a tile you path onto). Smart-path only the far
  // approach; from DELIRIUM_PUSH_REACH out, PUSH straight into the centre with moveTowardGridPos -- navTo would route
  // AROUND the mirror (obstacle) and stall at its walkable edge, never overlapping it (the "stood next to it, Stuck!" bug).
  if (p.d > DELIRIUM_PUSH_REACH) navTo(p.gx, p.gy, 'Delirium', now);
  else moveTowardGridPos(player.gridX, player.gridY, p.gx, p.gy);
  statusMessage = p.d > DELIRIUM_PUSH_REACH ? `Delirium -> ${p.d.toFixed(0)}u` : `Delirium: walking in`;
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
  // C++ path-filter (matches the same /Monsters/Breach/ path, bounded + nearest-first): ~2ms vs a ~57ms uncapped
  // getAllEntities on a 9k-entity map. getEntities({type:'Monster'}) MISSES breach mobs, but nameContains on the path does not.
  let all; try { all = poe2.getEntities({ nameContains: 'Monsters/Breach', maxDistance: ROT_BREACH_MOB_R + 60, aliveOnly: true, lightweight: true }) || []; } catch (e) { rotBreachMobCache = null; return null; }
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
  MB.set('content', 3);
  const elapsed = now - rotBreachActivatedAt;
  const mob = bestBreachMob(player, now);   // nearest mob to PURSUE + kill (also sets rotBreachStabilised on a rare)
  if (mob) { rotBreachLastMobAt = now; rotBreachSawMob = true; rotBreachLastMobPX = player.gridX; rotBreachLastMobPY = player.gridY; }
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
    if (!rotBreachClearedAt) { rotBreachClearedAt = now; log(`[Breach] ${rotBreachSawMob ? 'cleared' : 'no mobs spawned'} after ${Math.round(elapsed / 1000)}s${rotBreachSawMob ? ' -> stand still + collect loot 10s' : ' -> done'}`); }
    const _bDwelt = now - rotBreachClearedAt;
    if (rotBreachSawMob && _bDwelt < 10000) {
      // STAND STILL for 10s post-collapse (user 2026-07-03): breach loot flies TO the player, so moving here just
      // yo-yos. Plant (send stop) + let pickit vacuum the close drops.
      sendStopMovementLimited();
      statusMessage = `Breach: standing still, collecting loot ${(_bDwelt / 1000).toFixed(0)}s`;
      return true;
    }
    // After the base window: WALK each remaining drop into grab range (pickit's interact range is short now).
    // Anchor at the FIGHT-END spot (loot drops on the char, user), falling back to the breach center.
    const _bsx = Number.isFinite(rotBreachLastMobPX) ? rotBreachLastMobPX : rotBreachCenterX;
    const _bsy = Number.isFinite(rotBreachLastMobPY) ? rotBreachLastMobPY : rotBreachCenterY;
    if (rotBreachSawMob && _bDwelt < 40000 && sweepLootStep(player, now, _bsx, _bsy, 140)) return true;
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
    // RANGED: never walk ONTO the pack. Swarm press -> standoff step away; otherwise approach only to bow range and
    // stand (the rotation kills from there) -- chasing to contact planted the player inside 5 swinging melees.
    const _so = swarmStandoffPoint(player, now, rotBreachCenterX, rotBreachCenterY, ROT_BREACH_MOB_R);
    if (_so) { moveTowardGridPos(player.gridX, player.gridY, _so.x, _so.y); statusMessage = `Breach: standoff (${_so.n} in melee press)`; return true; }
    if (mob.dp > 55) moveTowardGridPos(player.gridX, player.gridY, mob.gridX, mob.gridY);
    else sendStopMovementLimited();
    statusMessage = `Breach: kill ${mob.sub || 'mob'} ${Math.round(mob.dp)}u${rotBreachStabilised ? ' [stab]' : ''} (${Math.round(elapsed / 1000)}s)`;
  } else if (rotBreachSawMob && elapsed > 35000) {
    // LATE-BREACH no-mob = the COLLAPSE (user): the loot drops ON THE CHAR where the fight ended -- STOP there,
    // don't orbit and don't walk to the stabilised center (that's only for killing rares). If we drifted, return
    // to where we stood when the mobs ended; the cleared-dwell + loot sweep take over from that spot.
    const _dLp = Number.isFinite(rotBreachLastMobPX)
      ? Math.hypot(rotBreachLastMobPX - player.gridX, rotBreachLastMobPY - player.gridY) : 0;
    if (_dLp > 15) moveTowardGridPos(player.gridX, player.gridY, rotBreachLastMobPX, rotBreachLastMobPY);
    else if (now >= dodgeMoveSuppressUntil) sendStopMovementLimited();
    statusMessage = `Breach: collapse hold (${Math.round(elapsed / 1000)}s)`;
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
    // DRY CORNER (user): the next cluster is usually on the OTHER side of the ring, and the slow same-direction
    // orbit paced one empty corner back-and-forth. 4s without seeing any mob -> JUMP the sweep to the opposite
    // side and orbit on from there; repeats each dry 4s until mobs are found or the 7s clear-timeout ends it.
    if (now - rotBreachLastMobAt > 4000 && now - rotBreachOppFlipAt > 4000) {
      rotBreachOppFlipAt = now;
      rotBreachSweepAng += Math.PI;
      rotBreachSweepUntil = now + ROT_BREACH_ORBIT_MS;
      log(`[Breach] no mobs ${Math.round((now - rotBreachLastMobAt) / 1000)}s -> sweeping the opposite side`);
    } else if (now > rotBreachSweepUntil) { rotBreachSweepAng += ROT_BREACH_ORBIT_STEP; rotBreachSweepUntil = now + ROT_BREACH_ORBIT_MS; }
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
let abyssNodeX = NaN, abyssNodeY = NaN;   // committed node pos: the loot dwell only plants when we're actually AT it
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
  // C++ path-filter (same /Monsters/LeagueAbyss/ path, bounded + nearest-first): ~2ms vs a ~57ms uncapped scan.
  let all; try { all = poe2.getEntities({ nameContains: 'Monsters/LeagueAbyss', maxDistance: ABYSS_MOB_RADIUS + 60, aliveOnly: true, lightweight: true }) || []; } catch (e) { _abyssMobCache = null; return null; }
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
  MB.set('content', 3);
  const nodes = getAbyssNodes(now);
  // The node we were clearing just flipped GRAY (dropped from the active list) -> DWELL to loot drops +
  // finish stragglers (>=5s, longer while in combat) BEFORE moving to the next node (user request).
  if (abyssId && abyssDwell && !nodes.some(n => n.id === abyssId)) {
    // Node gone from the list = finished (gray) OR merely DE-STREAMED because we walked far away. Only dwell when
    // actually AT the node and not engaging the boss -- a 3-min-stale dwell fired mid-boss-approach and PLANTED
    // the bot under the boss's AoE (stale-dwell bug). Far / boss-engaged -> quiet reset, no dwell, no ban.
    const _ndD = Math.hypot((abyssNodeX || 0) - player.gridX, (abyssNodeY || 0) - player.gridY);
    if (!(Number.isFinite(_ndD) && _ndD <= 130)
        || currentState === STATE.WALKING_TO_BOSS_MELEE || currentState === STATE.FIGHTING_BOSS) {
      abyssId = 0; abyssDwell = 0; abyssLootDwellAt = 0;
      return false;
    }
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
    // Chest opened / drops on the ground -> WALK each into grab range before retiring (pickit range is short).
    if (dwelt < 45000 && sweepLootStep(player, now, abyssNodeX, abyssNodeY, 130)) {
      statusMessage = `Abyss: ${statusMessage} (node ${abyssId})`;
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
  // STICKY NODE (commitment discipline): re-sorting to nearest each call flip-flopped the walk between
  // near-equidistant pits ((748,805)<->(702,909)<->(840,736) morning yoyo). Hold the committed pit while
  // it's still in the live list; swap only when it's gone (cleared/de-streamed) or blacklisted.
  let t = nodes[0];
  if (abyssId && (abyssBlacklist.get(abyssId) || 0) <= now) {
    const _held = nodes.find(n => n.id === abyssId);
    if (_held) t = _held;
  }
  if (abyssId !== t.id) { abyssId = t.id; abyssNodeX = t.gridX; abyssNodeY = t.gridY; abyssStartAt = now; abyssDwell = 0; abyssBestDist = Infinity; abyssBestAt = now; abyssNoMobAt = 0; abyssChaseMoveAt = 0; abyssReachMoveAt = now; abyssReachPX = player.gridX; abyssReachPY = player.gridY; }

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
  // LAST-GOOD SNAPSHOT: a transiently-failed read (recycled-slab AV mid-chain) must not cache {} -- an empty result makes
  // every consumer flap (outstanding counts drop -> spurious cleanup-budget refresh; done-bits vanish -> zombie content).
  // Keep the previous snapshot; the next successful read replaces it. Cleared per map in resetMapper.
  if (Object.keys(out).length) _mapObjDone = out;
  return _mapObjDone;
}
function mapObjectiveComplete(name, now) { return readMapObjectiveState(now || Date.now())[name] === 1; }
// PRESENT in the map (whether complete or not) -- parallel to mapObjectiveComplete, same base-game bitfield so it
// SURVIVES a mapper reload. USER: gate Verisium on mapObjectiveExists('Expedition') (no Verisium in Expedition maps).
function mapObjectiveExists(name, now) { return readMapObjectiveState(now || Date.now())[name] !== undefined; }

// ===== CONTENT-COMPLETION (objectiveGoalMode) -- PART 1: the objective-checklist MODEL. READ-ONLY (the driver + boss-
// gating hook in later, all behind objGoalOn()). Flag OFF (default) => nothing here changes behavior; the UI just SHOWS it. =====
function objGoalOn() { return currentSettings.objectiveGoalMode === true; }   // live master toggle (flag-off = today's boss-only flow)
// objective-name -> the content runner that DRIVES it to done (has a finder + per-instance done-detector). Everything else
// (RareMonsters/Checkpoints/Shrines/Strongboxes/Essences/StoneCircles/Delirium/Ritual/RogueExiles/AzmeriSpirits/...) is
// PASSIVE: tracked in the checklist, completed by clearing/traversal, never gated.
const OBJ_DRIVABLE = { Abyss: 'abyss', AbyssDepths: 'abyss', Breach: 'breach', Breach2: 'breach2', Incursion: 'incursion', Expedition2: 'verisium' };
function objDriveEnabled(type) {   // mirror the clear* toggles so a disabled mechanic isn't counted "outstanding"
  switch (type) {
    case 'abyss':     return currentSettings.clearAbyss !== false;
    case 'breach':    return currentSettings.clearBreach === true;   // match every breach driver (typeShouldRun / runContentRotation / populateContentQueue all gate on === true)
    case 'breach2':   return currentSettings.clearBreach === true;   // Breach Hives share the breach toggle
    case 'incursion': return currentSettings.clearIncursion !== false;
    case 'verisium':  return currentSettings.clearVerisiumRemnants !== false;
    default:          return true;
  }
}
// Is the base-game objective for this contentQueue TYPE already COMPLETE? Once the game marks a content type done we must
// STOP tracking/chasing/drawing it -- otherwise stale queue entries (e.g. Verisium loot RUNES that transiently matched the
// finder during the explosion, or any finder over-match) yoyo the bot, bloat the counter, and spam radar markers.
const _CQTYPE_OBJNAMES = { verisium: ['Expedition2'], 'incursion-beacon': ['Incursion'], 'incursion-chest': ['Incursion'], abyss: ['Abyss', 'AbyssDepths'], breach: ['Breach'], breach2: ['Breach2'] };
function objectiveTypeComplete(type, now) {
  const names = _CQTYPE_OBJNAMES[type]; if (!names) return false;
  const st = readMapObjectiveState(now || Date.now());
  return names.some(n => st[n] === 1);
}
// ===== MAP OBJECTIVES vs MAP CONTENT split (user 2026-07-03) =====
// A mechanic is a REQUIRED MAP OBJECTIVE if its `objective` line appears in getMapObjectives().mainObjective (the game's
// top-right "Map Objectives" block, e.g. "Defeat Viper Napuatzi\n Energise the Vaal Beacons"). Required objectives GATE
// map-completion (we don't leave until they're done) AND are driven regardless of the clear* toggle. Everything else in
// content[] is OPTIONAL MAP CONTENT: toggle-gated, done opportunistically, does NOT gate leaving.
// EXTENSIBLE objective-text -> objective-name map. The PRIMARY association is data-driven: the game's content[].objective
// line is matched into mainObjective.text (so "Energise the Vaal Beacons" -> the content row id 'Incursion' with no
// hardcoding). This table is a documented FALLBACK for objective lines that appear in mainObjective but have no matching
// content[] row, and records the exact live strings. Verisium/Expedition2 is DELIBERATELY absent -- it never appears as a
// map objective (user 2026-07-03), it is always optional MAP CONTENT. Add the Breach objective line here when captured.
const OBJ_TEXT_HINTS = [
  { re: /energise the vaal beacons/, name: 'Incursion' },   // Vaal Beacons (Alva incursion) -- CONFIRMED live 2026-07-03
  { re: /complete all breach hives/, name: 'Breach2' },     // Breach Hives -- CONFIRMED live 2026-07-05 (mainObjective line; no content[] row exists for it)
  // { re: /<breach objective text>/, name: 'Breach' },      // TODO(user): capture the live Breach objective line, then enable
];
let _reqObjCache = null, _reqObjAt = 0;
function getRequiredObjectiveNames(now) {   // -> Set of MAP_OBJ_NAMES that are REQUIRED objectives this map
  const t = now || Date.now();
  if (_reqObjCache && t - _reqObjAt < 1500) return _reqObjCache;
  const req = new Set();
  try {
    const mo = poe2.getMapObjectives();
    if (mo && mo.mainObjective) {
      const mainText = `${mo.mainObjective.text || ''}`.toLowerCase();
      if (/\bdefeat\s+/.test(mainText)) req.add('MapBoss');                 // "Defeat X" line -> the boss is required
      for (const c of (mo.content || [])) {
        const o = `${c.objective || ''}`.toLowerCase();
        if (o && c.id && mainText.includes(o)) req.add(c.id);              // content objective line present in the block -> required (data-driven)
      }
      for (const h of OBJ_TEXT_HINTS) if (h.re.test(mainText)) req.add(h.name);   // fallback: known objective-text -> name (covers a missing content[] row)
    }
  } catch (e) {}
  _reqObjCache = req; _reqObjAt = t;
  return req;
}
// is this contentQueue drivable TYPE (abyss/breach/incursion/verisium) a required objective this map?
function isRequiredType(type, now) {
  if (!type) return false;
  const req = getRequiredObjectiveNames(now);
  for (const nm in OBJ_DRIVABLE) if (OBJ_DRIVABLE[nm] === type && req.has(nm)) return true;
  return false;
}
// the map's live objective checklist: every PRESENT base-game objective + complete-bit + whether we can drive it + REQUIRED.
function getObjectiveChecklist(now) {
  const st = readMapObjectiveState(now || Date.now());
  const req = getRequiredObjectiveNames(now);
  const out = [];
  for (const name of MAP_OBJ_NAMES) {
    // Present in the bitfield OR named REQUIRED by the mainObjective text: a required objective with no bitfield/
    // content[] row (e.g. "Complete all Breach Hives") must still appear in the checklist AND gate leaving.
    if (st[name] === undefined && !req.has(name)) continue;
    const type = OBJ_DRIVABLE[name] || null;
    out.push({ name, type, complete: st[name] === 1, drivable: !!type, enabled: type ? objDriveEnabled(type) : false, required: req.has(name) });
  }
  return out;
}
// OUTSTANDING = any REQUIRED drivable objective still incomplete (the boss is handled separately via bossDead). Per the user:
// leave/hold gate is the REQUIRED objectives ONLY -- optional MAP CONTENT is done opportunistically but does NOT gate.
function hasOutstandingObjectives(now) {
  for (const o of getObjectiveChecklist(now)) {
    if (o.name === 'MapBoss') continue;
    if (o.required && o.drivable && !o.complete) return true;   // required objective forced (ignore the clear* toggle)
  }
  return false;
}
// PART 2 (per-INSTANCE counts): the whole-map objective bit is 0/1 and can't express "3 of 5 breaches done". The persistent
// contentQueue holds every DISCOVERED instance (stable key survives de-stream); the prune pass PERSISTS completed instances
// (state='completed') instead of deleting, so we count discovered vs completed per type. Read-only + cheap (queue is tens of
// entries); per-frame callers should cache (the HUD gates 1/s). discovered GROWS as the server reveals more over the map.
function getContentCounts(now) {
  const out = {};
  for (const e of contentQueue.values()) {
    if (!e || typeof e.type !== 'string') continue;
    const c = out[e.type] || (out[e.type] = { discovered: 0, completed: 0, active: 0 });
    c.discovered++;
    if (e.state === 'completed') c.completed++; else c.active++;
  }
  return out;
}
let _objUiCache = null, _objUiAt = 0;   // Part 5 UI: cache the checklist compute (1/s) so the per-frame draw is cheap (NO-LAG)
// DISPLAY-ONLY sticky set of objective names that were EVER a required MAP OBJECTIVE this map. Keeps a now-complete
// required objective in the MAP OBJECTIVES panel (instead of jumping to MAP CONTENT when it drops out of mainObjective).
// Does NOT feed the leave/hold logic (that uses the live `required` flag) -- purely to stop the UI rows hopping sections.
let _objUiEverReq = new Set();

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
  // PREFER the C++ getExpedition2Offered binding: it reads the offered run straight from the panel struct and already
  // resolves each to its rune-count-disambiguated catalog index -> drift-proof, unlike the UI-tree walk below (whose
  // [3,2,2,0] nav + tile offsets broke -> null -> the "reading offers..." hang). Fall back to the walk if absent/empty.
  exp2CatalogAlive = false;
  // COMPUTE PATH (authoritative, drift-proof): getExpedition2Offered reads the OPEN panel's offered run of DAT-row
  // pointers and returns each offer's positional catalog index = (rowPtr-rowBegin)/185. No name-match, so a catalog
  // RESHUFFLE can't misalign it. Use it verbatim when present.
  try {
    if (typeof poe2.getExpedition2Offered === 'function') {
      const raw = poe2.getExpedition2Offered();
      if (raw && raw.length) {
        exp2CatalogAlive = true;
        return raw.map(o => ({ name: o.name, catalogIdx: (Number.isInteger(o.index) && o.index >= 0) ? o.index : -1, runeCount: o.runeCount || 0, uiName: o.name, computed: true }));
      }
    }
  } catch (e) {}
  // COMPUTE unavailable this poll -> UI name-match FALLBACK (fragile last resort). It needs the catalog; if
  // getExpedition2Recipes is ALSO empty, BOTH recipe bindings are blind (DAT-table anchor drift) -> return null with
  // exp2CatalogAlive=false so the caller diagnoses + fast-skips instead of the old silent 15s "none mapped" hang.
  if (typeof poe2.getUiRoot !== 'function') return null;
  const catalog = (typeof poe2.getExpedition2Recipes === 'function') ? (poe2.getExpedition2Recipes() || []) : [];
  if (catalog.length) exp2CatalogAlive = true; else return null;
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
  for (const r of catalog) { if (r && r.name) { const k = r.name.toLowerCase(); (byName[k] || (byName[k] = [])).push(r); } }
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
let exp2PollAt = 0;                // throttle the panel/offers read to ~500ms (a per-frame UI-tree + DAT read = lag spike -> DC)
let exp2CatalogAlive = false;      // true iff a recipe binding (compute getExpedition2Offered OR catalog getExpedition2Recipes) returned real data on the LAST poll; still false >5s after panel-open = DAT-table vtable/anchor drift -> DLL rebuild
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
let exp2SawUntgt = false, exp2LastHammerAt = 0, exp2HammerCount = 0;   // hammer-take verification: untargetable = encounter started; else re-hammer 1/s (bounded)
let exp2MissAt = 0;                // engaged stone missing from the flooded scan since (6s grace before conceding)
let exp2LastOpenAt = 0;            // GLOBAL single-open throttle (one open interact per 5s -- the DC storm guard)
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
  // Match the ENCOUNTER/REMNANT structure only -- NOT '/Rune/', which caught the reward RUNE LOOT (their path carries
  // 'Expedition2') dropping next to the controller -> 30+ phantom verisium in the queue + a pile of pink radar boxes
  // (user 2026-07-03). The live remnant is 'Expedition2Encounter' so 'Encounter' still catches it; the driven remnant
  // (exp2CurId) stays exempt regardless of name.
  return es.filter(e => e && /Expedition2/i.test(e.name || '') && /Encounter|Remnant/i.test(e.name || '')
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
  // USER 2026-06-28 "NO VERISIUM IN EXPEDITION MAPS": gate on the base-game objective EXISTING (like the other content
  // guards check complete) -- knows from map-start, before the Dannig camp entity streams, and survives a mapper reload.
  if (mapObjectiveExists('Expedition', now)) return true;
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

// NEVER abandon an OPEN select panel: panel-open PAUSES the world (solo) -- walking away froze the game with the
// list up (the 6-minute 'wall livelock' was this, not a wall). When the offers can't be read, ACTIVATE instead:
// a hammer without our select is a supported first-class flow (same as the manual-hammer takeover), the panel
// closes itself when the encounter starts, and the fighting phase verifies the take (8 bounded re-hammers).
function exp2BlindHammer(t, now, reason) {
  log(`[Exp2] remnant ${t.id} ${reason} -> BLIND HAMMER (never abandon an open select panel)`);
  try { exp2Craft(t, 0x00); } catch (_) {}
  exp2Phase = 'fighting'; exp2ClearedAt = 0; exp2Candidates = null; exp2DispatchAt = 0; exp2FightStartAt = now;
  exp2SawUntgt = false; exp2LastHammerAt = now; exp2HammerCount = 1;
  if (!exp2SelRunes) exp2SelRunes = 5;
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
  MB.set('content', 3);   // set here (not just the rotation): opener.js also drives this standalone
  if (exp2RegularExpeditionPresent(now)) return false;                    // HARD SKIP a real Expedition
  // Drive off LIVE remnants (per-remnant), NOT the whole-map Expedition2 objective: like incursion, a map can have
  // MULTIPLE remnants and the objective flips COMPLETE after the FIRST -- which then STRANDED the rest (LIVE-CONFIRMED
  // 2026-06-27: objective read complete while an OPENABLE remnant remained -> mapper ignored it + walked to boss).
  // exp2FindRemnant already gates on alive + not-in-exp2Done, so a truly spent / absent map yields no target -> stop.
  let t = exp2FindRemnant(player, now);
  // ENGAGED-STICKY (the BIG-LAG DC): mid-encounter the 128-cap entity list FLOODS with wave spawns and the
  // driven stone can transiently VANISH from the scan -> the old code adopted a nearest phantom, RESET the
  // phase to 'walk', and re-OPEN/SELECT/HAMMERed the same stone in a loop (packet + UI-read storm -> DC).
  // While a phase is engaged we NEVER switch ids: hold up to 6s for the real stone to re-stream; only a
  // sustained miss concedes.
  if (exp2Phase !== 'idle' && exp2CurId) {
    if (t && t.id !== exp2CurId) t = null;
    if (!t) {
      if (!exp2MissAt) exp2MissAt = now;
      if (now - exp2MissAt < 6000) { sendStopMovementLimited(); statusMessage = `Verisium: remnant ${exp2CurId} re-streaming...`; return true; }
      log(`[Exp2] remnant ${exp2CurId} gone from scan 6s -> concede`);
      exp2Phase = 'idle'; exp2CurId = 0; exp2MissAt = 0; return false;
    }
    exp2MissAt = 0;
  }
  if (!t) { if (exp2Phase !== 'idle') { exp2Phase = 'idle'; exp2CurId = 0; } return false; }
  if (exp2CurId !== t.id) { exp2CurId = t.id; exp2Phase = 'walk'; exp2StartAt = now; exp2ClearedAt = 0; exp2LootedAt = 0; exp2Candidates = null; exp2ClearAt = 0; exp2NoMobsAt = 0; exp2DispatchAt = 0; exp2SelSentAt = 0; exp2DecidedAt = 0; exp2SelRunes = 0; exp2FightStartAt = 0; exp2LootWaitAt = 0; exp2LootReadyAt = 0; }

  const tgt = !!t.isTargetable;
  const dist = Math.hypot(t.gridX - player.gridX, t.gridY - player.gridY);
  exp2CurDist = dist;

  // STALE COMMIT (post-reach phases only -- 'walk' is legitimately far): a boss drive yanked us away mid-encounter
  // and the phase lingered for minutes (suppressing loot-yields + pinning the arb mid-engagement freeze) until the
  // total timeout. Far from the remnant with a reached/opened phase -> retire NOW; looted -> done-ban.
  if (exp2Phase !== 'idle' && exp2Phase !== 'walk' && dist > 250) {
    if (exp2LootedAt) exp2Done.set(t.id, now + 600000);
    log(`[Exp2] remnant ${t.id} left behind at ${Math.round(dist)}u (phase ${exp2Phase}) -> retire`);
    exp2Phase = 'idle'; exp2CurId = 0;
    return false;
  }
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
    sendStopMovementLimited(true);   // user: STOP MOVING before opening -- a moving / mid-path interact doesn't register + spikes lag/DC
    // SINGLE-OPEN THROTTLE (user, after the DC): one open interact per 5s GLOBALLY, no matter what the phase
    // machine thinks -- a re-open loop can never become a packet storm again.
    if (now - exp2LastOpenAt < 5000) { statusMessage = `Verisium: open cooldown (${((5000 - (now - exp2LastOpenAt)) / 1000).toFixed(1)}s)`; return true; }
    exp2LastOpenAt = now;
    exp2Open(t); exp2Phase = 'awaitpick'; exp2LastAct = now; exp2Candidates = null; exp2ClearAt = 0; exp2PollAt = now;
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
      exp2BlindHammer(t, now, 'offers unreadable 15s');
      return true;
    }
    if (dist > EXP2_REACH * 1.5) { navTo(t.gridX, t.gridY, 'Verisium', now); return true; }  // drifted off -> ease back (don't re-open)
    sendStopMovementLimited();   // user: WAIT PATIENTLY -- stay planted at the remnant while the panel/offers stream in (no drift, no spam)
    // ---- CRACKED FLOW (LIVE-PROVEN 2026-06-27): the ENTIRE chain works with the panel OPEN via packets -- NO close/ESC/
    // walk needed. open -> READ -> SELECT (00F9+01FD) -> brief dwell -> HAMMER (0301 act 00) -> FIGHT -> LOOT (0301 act 01).
    // (The early "no-op while open" was only the wrong id [controller vs Encounter] + missing 01FD; the right packet lands.)
    // STEP 1 -- READ + DECIDE: pick the best OFFERED recipe.
    if (!exp2Candidates) {
      // user: check the list every ~500ms -- do NOT hammer the UI-tree walk + DAT recipe read every frame (that per-frame read is the lag spike -> DC).
      if (now - exp2PollAt < 500) { statusMessage = `Verisium: waiting for offers... (${((now - exp2LastAct) / 1000).toFixed(0)}s)`; return true; }
      exp2PollAt = now;
      // Need only ONE recipe binding: the COMPUTE path (getExpedition2Offered) supplies indices without the catalog.
      if (typeof poe2.getExpedition2Offered !== 'function' && (typeof poe2.getUiRoot !== 'function' || typeof poe2.getExpedition2Recipes !== 'function')) { statusMessage = `Verisium: recipe binding unavailable (remnant ${t.id})`; return true; }
      const offered = exp2OfferedFromUI();
      if (!offered) {
        // Both compute + catalog empty. A healthy DLL populates the catalog within a poll of panel-open; still blind >5s
        // = DAT-table anchor drifted (game patch) -> both bindings dead. Skip FAST with the real cause instead of hanging
        // to the 15s AFK timeout. FIX = rebuild DLL (poe2_wrap.cc FindExp2Table path-signature scan / kSelVtRva).
        if (!exp2CatalogAlive && now - exp2LastAct > 5000) {
          statusMessage = `Verisium: recipe bindings DEAD (DLL rebuild needed) -> blind hammer`;
          exp2BlindHammer(t, now, 'recipe bindings DEAD (DLL rebuild needed)');
          return true;
        }
        statusMessage = `Verisium: reading offers... (${((now - exp2LastAct) / 1000).toFixed(0)}s)`; return true;
      }
      const pickable = offered.filter(o => o.catalogIdx >= 0);
      if (!pickable.length) {
        // Offers READ but none resolved to an index. The compute path SUPPLIES indices, so this is the UI name-match
        // fallback missing (compute down + name-match failed). Retry a few polls, then skip fast (not the silent 15s hang).
        if (now - exp2LastAct > 8000) {
          statusMessage = `Verisium: ${offered.length} offer(s), none mapped -> blind hammer`;
          exp2BlindHammer(t, now, `${offered.length} offer(s), NONE mapped after 8s`);
          return true;
        }
        statusMessage = `Verisium: ${offered.length} offer(s), mapping... (${((now - exp2LastAct) / 1000).toFixed(0)}s)`; return true;
      }
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
    // STEP 3 -- dwell to let the select register, then HAMMER (0301 act 00, handle 87B20004). Also PANEL-OPEN.
    // The ~830-byte 02BA reply = waves spawning -> 'fighting'. USER: be PATIENT -- 1s after the choice, never sooner
    // (a too-early hammer lands before the select registers -> the encounter UI resets with cog-wheels + wedges).
    if (exp2DispatchAt) {
      if (now - exp2DispatchAt < 1000) { statusMessage = `Verisium: select sent -> hammering...`; return true; }
      exp2Craft(t, 0x00); exp2Phase = 'fighting'; exp2ClearedAt = 0; exp2Candidates = null; exp2DispatchAt = 0; exp2FightStartAt = now;
      exp2SawUntgt = false; exp2LastHammerAt = now; exp2HammerCount = 1;   // hammer-take verification state (fighting phase)
      log(`[Exp2] remnant ${t.id} HAMMERED (activate, panel-open, ${exp2SelRunes} runes)`);
      return true;
    }
    return true;
  }

  // ---- FIGHTING (waves up after hammer; clear them, recognise COMPLETION, then loot) ----
  if (exp2Phase === 'fighting') {
    // HAMMER-TAKE VERIFICATION: a started encounter flips the remnant UN-targetable. Still targetable + never flipped =
    // the hammer landed before the select registered (encounter not started) -- firing LOOT here is what wedges the UI
    // (cog-wheels). Re-hammer from CLOSE (<55u), ONCE per second AT MOST (user), bounded -> then skip.
    if (tgt && !exp2SawUntgt) {
      if (dist > 55) { navTo(t.gridX, t.gridY, 'Verisium hammer', now); statusMessage = `Verisium: closing to hammer ${dist.toFixed(0)}u`; return true; }
      if (now - exp2LastHammerAt >= 1000) {
        if (exp2HammerCount >= 8) {
          exp2Done.set(t.id, now + 300000);
          // LAST RESORT (user): the select panel may still be OPEN (world paused) -- send the ESC-equivalent the
          // atlas flow uses to close the top panel, so we never walk away from a paused game.
          try { if (typeof poe2.closeAtlas === 'function') poe2.closeAtlas(); } catch (_) {}
          log(`[Exp2] remnant ${t.id} hammer never took (${exp2HammerCount} attempts) -> ESC-close panel + skip`);
          exp2Phase = 'idle'; exp2CurId = 0; return false;
        }
        exp2Craft(t, 0x00); exp2LastHammerAt = now; exp2HammerCount++;
        log(`[Exp2] remnant ${t.id} re-HAMMER #${exp2HammerCount} (encounter not started yet)`);
      }
      sendStopMovementLimited(); statusMessage = `Verisium: awaiting encounter start (hammer #${exp2HammerCount})`;
      return true;
    }
    if (!tgt) exp2SawUntgt = true;                                              // encounter running -> the NEXT tgt flip is the real loot-ready
    if (tgt) { exp2Phase = 'loot'; exp2ClearedAt = now; exp2NoMobsAt = 0; return true; }   // remnant clickable again = loot-ready
    // CLEAR the waves. The tgt flip above = the COMPLETE / ready-to-open state (isTargetable) -- the DEFINITIVE done signal
    // (user 2026-06-28: "that's THE complete-to-open"). Mob-free + a generous time CAP are only BACKSTOPS if it never flips
    // (NOT a floor). A WIDE recipe (runes>4) chases out to 200u and waits a longer mob-free window (waves spawn far + intermittently).
    const wide = exp2SelRunes > 4;
    const fightR = wide ? EXP2_WIDE_FIGHT_RADIUS : EXP2_FIGHT_RADIUS;
    const hostiles = exp2HostilesNear(t, fightR);
    // Controller GONE = the encounter is OVER and its loot (if any) is already ON THE GROUND -- the remnant will never
    // flip targetable again, so waiting-to-open here strands the bot. Go straight to the collect-dwell (pickit grabs the
    // drops) then retire.
    if (!exp2ControllerNear(t)) { exp2Phase = 'loot'; exp2LootedAt = now; exp2ClearedAt = now; exp2NoMobsAt = 0; log(`[Exp2] remnant ${t.id} encounter ended (controller gone) -> collect + retire`); return true; }
    if (now - exp2FightStartAt > (wide ? 90000 : 60000)) { exp2Phase = 'loot'; exp2ClearedAt = now; exp2NoMobsAt = 0; log(`[Exp2] remnant ${t.id} fight CAP (${wide ? 90 : 60}s, never flipped complete) -> loot`); return true; }   // backstop CAP, not a floor
    if (hostiles === 0) {
      if (!exp2NoMobsAt) exp2NoMobsAt = now;
      if (now - exp2NoMobsAt > (wide ? 12000 : 5000)) { exp2Phase = 'loot'; exp2ClearedAt = now; exp2NoMobsAt = 0; log(`[Exp2] remnant ${t.id} waves cleared (mob-free ${wide ? '12s wide' : '5s'}) -> loot`); return true; }
    } else { exp2NoMobsAt = 0; }
    // PURSUE the nearest mob (out to fightR). When nothing's close: a WIDE recipe PATHFINDS back near the stone if we've
    // drifted past the normal radius (anchors the sweep, routes around walls); otherwise HOLD (no snap-back yoyo).
    const m = exp2NearestHostile(t, fightR);
    const mD = m ? Math.hypot((m.gridX || 0) - player.gridX, (m.gridY || 0) - player.gridY) : Infinity;
    if (m && mD > 72) moveTowardGridPos(player.gridX, player.gridY, m.gridX, m.gridY);   // T0.4: step in ONLY if the pack is out of auto-attack reach (~72u)
    else if (!m && dist > 50) navTo(t.gridX, t.gridY, 'Verisium', now);   // waves clear + drifted (wide-chase goes to 200u) -> BACK to the stone: the completion flip / final open need <60u proximity
    else sendStopMovementLimited();   // T0.4: in range (or no mob) -> STAND STILL + let processAutoAttack clear the waves. Chasing every mob = never stationary = waves never hit 0 = remnant never flips targetable = the 15s "loot never went ready" give-up. Standing is how the fight completes + yields to pickit.
    statusMessage = `Verisium: clearing ${wide ? 'WIDE ' : ''}waves (remnant ${t.id}, ${hostiles} mobs)`;
    return true;
  }

  // ---- LOOT (waves cleared; click remnant to collect, then retire) ----
  if (exp2Phase === 'loot') {
    // LOOT-READY = the remnant flips isTargetable=true (the COMPLETE/open state). The FIGHTING phase can exit on the
    // mob-free FALLBACK *before* that flip, so tgt may be FALSE on entry -- do NOT mistake that for "already looted"
    // (the "I finished it but you ran away instead of opening it" bug). Only AFTER we've actually looted does !tgt = done.
    // USER 2026-06-28: once we've fired the loot/open, HOLD STILL 5s so pickit collects the drops, THEN retire -- don't
    // run off the instant the remnant de-targets (the "ran sideways after looting" bug). This 5s dwell replaces the
    // tgt-flip early-done AND the old 7s backstop; it fires regardless of the remnant's targetable state once looted.
    if (exp2LootedAt) {
      const _vDwelt = now - exp2LootedAt;
      // 5s base stand (drops settle), then WALK each remaining drop into grab range (pickit range is short).
      if (_vDwelt < 5000) { sendStopMovementLimited(); statusMessage = `Verisium: loot dwell ${(_vDwelt / 1000).toFixed(1)}s ${t.id}`; return true; }
      if (_vDwelt < 30000 && sweepLootStep(player, now, t.gridX, t.gridY, 130)) return true;
      exp2Done.set(t.id, now + 600000); log(`[Exp2] remnant ${t.id} looted -> dwell+sweep done -> retire`); exp2Phase = 'idle'; exp2CurId = 0; return true;
    }
    if (!tgt) {
      // NOT loot-ready yet -> WAIT ON the stone for the COMPLETE flip (it needs proximity, <60u; auto-attack still clears
      // stragglers). The 15s backstop only counts DOWN while we're actually close -- far away the flip can't happen.
      if (dist > 55) { navTo(t.gridX, t.gridY, 'Verisium loot-wait', now); statusMessage = `Verisium: returning to open ${dist.toFixed(0)}u`; return true; }
      if (!exp2LootWaitAt) exp2LootWaitAt = now;
      if (now - exp2LootWaitAt > 15000) { exp2Done.set(t.id, now + 600000); log(`[Exp2] remnant ${t.id} loot never went ready (15s close) -> give up`); exp2Phase = 'idle'; exp2CurId = 0; return true; }
      if (dist > EXP2_REACH) navTo(t.gridX, t.gridY, 'Verisium loot-wait', now); else sendStopMovementLimited();
      statusMessage = `Verisium: waiting to OPEN ${t.id} (${((now - exp2LootWaitAt) / 1000).toFixed(0)}s)`;
      return true;
    }
    // loot-ready (tgt true). USER 2026-06-28: give it 2s + RE-VALIDATE still-finished, THEN fire the open packet (in case
    // the flip was premature). If tgt drops during the 2s the !tgt branch above re-catches it. Walk up meanwhile.
    if (dist > EXP2_REACH) { navTo(t.gridX, t.gridY, 'Verisium loot', now); statusMessage = `Verisium: -> loot ${dist.toFixed(0)}u`; return true; }
    if (!exp2LootReadyAt) exp2LootReadyAt = now;
    if (now - exp2LootReadyAt < 2000) { statusMessage = `Verisium: loot-ready, settling ${((now - exp2LootReadyAt) / 1000).toFixed(1)}s ${t.id}`; return true; }
    exp2Craft(t, 0x01); exp2LootedAt = now; log(`[Exp2] remnant ${t.id} -> loot/open fired (re-validated 2s) -> 5s dwell`); return true;   // -> next frame the 5s stay-still dwell above takes over
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
const FP_SEAL_REACH = 18;             // (legacy close-interact range)
const FP_SEAL_INTERACT_RANGE = 70;    // interact from up to 70u -- 0xA3 interact makes the GAME pathfind to + open the seal, so the JS nav getting stuck against the central arena pit (the "stuck 44u, never reached the old 18u interact range" loop) no longer blocks it
const FP_SEAL_DELAY = 2000;           // 2s between seal interactions (user spec)
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
    && e.isTargetable !== false);   // DONE = the seal OPENED (isTargetable flips false) -- the PROVEN signal, no timeout/give-up
}
// interact the Runic Seals one-by-one (2s apart) to release The Forgotten Prisoner. Returns true while handling.
function runRunicSeals(player, now) {
  if (!player) return false;   // always-on when the Forgotten Prisoner is in the map (no toggle)
  if (!forgottenPrisonerPresent(now)) return false;
  const seals = getRunicSeals(now);
  if (!seals.length) return false;                                        // every seal OPEN (isTargetable=false) or given-up -> fight proceeds
  // target the NEAREST not-yet-open seal
  let t = null, bd = Infinity;
  for (const s of seals) { const d = Math.hypot(s.gridX - player.gridX, s.gridY - player.gridY); if (d < bd) { bd = d; t = s; } }
  const dist = Math.hypot(t.gridX - player.gridX, t.gridY - player.gridY);
  // FIX (USER "keeps clicking the seal it can't reach"): interact from up to FP_SEAL_INTERACT_RANGE -- 0xA3 makes the GAME
  // pathfind to + open it, so the JS nav stuck against the central pit no longer blocks it. navTo only when even further.
  if (dist > FP_SEAL_INTERACT_RANGE) { navTo(t.gridX, t.gridY, 'Runic Seal', now); statusMessage = `Runic Seal: -> ${dist.toFixed(0)}u (${seals.length} left)`; return true; }
  if (now - fpLastSealAt < FP_SEAL_DELAY) { statusMessage = `Runic Seal: 2s gap ${((FP_SEAL_DELAY - (now - fpLastSealAt)) / 1000).toFixed(1)}s`; return true; }
  // DONE = the seal OPENING (isTargetable flips false -> getRunicSeals drops it), NOT "we clicked it" -- so an
  // out-of-range / missed click never falsely marks it done (the old fpSealsDone-on-interact left the boss chained).
  try { interactWithEntity(t); } catch (_) {}
  fpLastSealAt = now;
  // KEEP interacting every 2s until the seal actually OPENS (isTargetable -> false, which getRunicSeals drops). NO timeout,
  // NO give-up: the interact is from range so the GAME walks the last bit + opens it; "done" is the proven flip, period.
  log(`[ForgottenPrisoner] Runic Seal ${t.id} interact sent (${seals.length} still closed) -- waiting for isTargetable->false`);
  statusMessage = `Runic Seal: opening ${t.id} (${seals.length} left)`;
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
  breach2:            { value: 105, timeSensitive: false, lockOnEngage: true,  doneSignal: 'markerGone' },   // Breach Hive: defend/clear at the BrequelSpawnerCover until its 1048 marker clears
  'incursion-chest':  { value: 100, timeSensitive: false, lockOnEngage: true,  doneSignal: 'opened' },
  'incursion-beacon': { value: 100, timeSensitive: false, lockOnEngage: true,  doneSignal: 'activated' },
  abyss:              { value: 100, timeSensitive: false, lockOnEngage: true,  doneSignal: 'iconGray' },
  delirium:           { value: 80,  timeSensitive: true,  lockOnEngage: false, enabled: true },   // gated by the deliriumMirrorEnabled UI toggle
};
// Persistent spotted-content QUEUE (populated by populateContentQueue; read by the arbiter + HUD counts). key =
// `${type}:${id||roundGrid}`. Entity (Positioned) grid ONLY -- never key off getQuestMarkers Render grid (coord-system mixing).
const contentQueue = new Map();
// Gate constants -- single canonical tiers/budgets replacing the scattered 600/550/500 magic radii.
const NEAR_DIST = 150, MID_LIMIT = 500, DETOUR_BUDGET = 220, EXTENDED_DETOUR_BUDGET = 380;   // DETOUR_BUDGET/EXTENDED still used by the legacy revisit gate
const ARB_GRAB_DIST = 260;   // content THIS close to the player is ALWAYS eligible -- "it's right there" beats "it's off the boss route" (route-insertion still orders everything farther). TUNABLE.
// ===== OBJECTIVE-WEIGHTING (route-insertion cost, conf- & distance-scaled) -- decides DO-NOW vs DEFER for OPTIONAL content:
// grab near/on-route content, defer far OFF-route optional (tighter when we KNOW where the boss is + as we near it). Fixes
// the old classifyObjective's two defects (k_detour<k_dist -> off-route cheaper than distance -> wander; routeDetourCost
// null-for-backtrack -> a backtrack scored as free/on-route). Pre-boss this gates EVERYTHING incl. required (boss-on-the-
// way model); post-boss required is eligible at any distance (pickObjective) and the MAP_COMPLETE cleanup drives it.
const DETOUR_VALUE_RATE  = 2.2;   // grid-units of insertion travel each value-pt earns (value100 -> 220u reference budget)
const TS_DETOUR_MULT     = 1.7;   // time-sensitive (breach/verisium) earns a bigger budget (expires -> can't defer to post-boss)
const INS_DETOUR_CAP     = 900;   // absolute detour/reach ceiling (== CLEANUP_REACH_LIMIT) -- "never trek the whole map"
const UNKNOWN_REACH_MULT = 3.0;   // boss UNKNOWN (no route end): plain reach radius from the anchor = baseBudget * this
const CONF_TIGHT_BASE    = 1.35;  // budget conf-scale = BASE - SLOPE*conf : conf0.9 -> 0.855x (KNOW -> tight, don't wander)
const CONF_TIGHT_SLOPE   = 0.55;  //   ... conf0.3 -> 1.185x (fog-guess -> loose, still grab en-route content)
const DIST_SHRINK_REF    = 500;   // boss-distance corridor-shrink reference (== MID_LIMIT)
const DIST_SHRINK_MIN    = 0.5;   // near-boss floor  (corridor >= 0.5x -> "almost there, don't wander")
const DIST_SHRINK_MAX    = 1.6;   // far-boss ceiling (corridor <= 1.6x)
const K_INS              = 0.10;  // score: pts per insertion-grid (0.10 keeps ARB_MARGIN 20 ~= 200u hysteresis parity)
const K_DIST             = 0.02;  // score: pts per live-grid (light proximity tiebreak among on-route cands)
const REACH_FOG_MULT     = 0.65;  // score: fogged value down-weight (prefer a reachable peer; still explore-toward if it's the best)
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
// TRUE marginal insertion cost to visit O between the (frozen) tour anchor A and the tour-end B (the boss). Always >= 0:
// ~0 for on-route content, ~2x perp for off-route, ~2x backtrack for behind -- retires routeDetourCost's null/free-backtrack bug.
function routeInsertionCost(ax, ay, ox, oy, bx, by) {
  return Math.hypot(ox - ax, oy - ay) + Math.hypot(bx - ox, by - oy) - Math.hypot(bx - ax, by - ay);
}
function baseDetourBudget(type) {
  const p = CONTENT_POLICY[type] || {}, v = p.value || 60;
  return Math.min(v * DETOUR_VALUE_RATE * (p.timeSensitive ? TS_DETOUR_MULT : 1), INS_DETOUR_CAP);
}
// full budget when the boss is KNOWN: conf tightens ("we KNOW -> don't wander"), boss-distance shrinks ("almost there -> tighten").
function detourBudgetFor(type, conf, distToBoss) {
  const cm = CONF_TIGHT_BASE - CONF_TIGHT_SLOPE * Math.max(0, Math.min(1, conf));
  const dm = Math.max(DIST_SHRINK_MIN, Math.min(DIST_SHRINK_MAX, distToBoss / DIST_SHRINK_REF));
  return Math.min(baseDetourBudget(type) * cm * dm, INS_DETOUR_CAP);
}
// Objective classifier: eligibility + score via the route-insertion gate. bossAnchor KNOWN -> TSP insertion vs a
// conf/dist-scaled budget; UNKNOWN (blind explore, no route end) -> a plain reach radius from the frozen anchor. Insertion
// is measured from the FROZEN commit anchor (arbRouteAnchor -- set at commit, re-seeded to player when uncommitted) so the
// DO/DEFER set is stable during a commitment (anti-yoyo). Required is score-boosted (+1000) but distance-gated pre-boss.
function classifyObjective(entry, player, bossAnchor, reach) {
  const ox = entry.gridX || 0, oy = entry.gridY || 0;
  const dist = Math.hypot(ox - player.gridX, oy - player.gridY);                 // LIVE proximity (NEAR-grab + score tiebreak)
  const pol = CONTENT_POLICY[entry.type] || {};
  const timeSensitive = !!pol.timeSensitive, value = pol.value || 60;
  const ax = Number.isFinite(arbRouteAnchorX) ? arbRouteAnchorX : player.gridX;  // FROZEN commit anchor (anti-yoyo) else live
  const ay = Number.isFinite(arbRouteAnchorY) ? arbRouteAnchorY : player.gridY;
  let insCost, eligible, tier, budget;
  if (bossAnchor) {                                                              // KNOWN: TSP insertion vs conf/dist-scaled budget
    const distToBoss = Math.hypot(bossAnchor.x - player.gridX, bossAnchor.y - player.gridY);
    budget = detourBudgetFor(entry.type, bossAnchor.conf || 0.5, distToBoss);
    insCost = routeInsertionCost(ax, ay, ox, oy, bossAnchor.x, bossAnchor.y);
    eligible = dist <= ARB_GRAB_DIST || insCost <= budget;
    tier = dist <= ARB_GRAB_DIST ? 'NEAR' : (insCost <= budget ? 'ONROUTE' : 'OFFROUTE');
  } else {                                                                       // UNKNOWN: plain reach radius (blind explore)
    budget = Math.min(baseDetourBudget(entry.type) * UNKNOWN_REACH_MULT, INS_DETOUR_CAP);
    insCost = Math.hypot(ox - ax, oy - ay);
    eligible = dist <= ARB_GRAB_DIST || insCost <= budget;
    tier = dist <= ARB_GRAB_DIST ? 'NEAR' : (insCost <= budget ? 'INREACH' : 'FAR');
  }
  const reachMult = reach === 'fogged' ? REACH_FOG_MULT : 1;
  const score = value * reachMult - K_INS * insCost - K_DIST * dist;
  return { tier, timeSensitive, detourCost: insCost, budget, eligible, score, dist };
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
  if (!best && Number.isFinite(bossCkptX)) best = { x: bossCkptX, y: bossCkptY, conf: 0.85, src: 'boss-ckpt-stored' };   // USER: persisted boss checkpoint -- survives the marker de-streaming so the bearing holds
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

// Per-type lock TTL (deadlock-proof HARD cap) + per-instance done-signal -- used by the objective arbiter's commit latch.
function lockTtlFor(type) {
  const p = CONTENT_POLICY[type] || {};
  if (type === 'breach')   return Math.max(p.ttlMs || 0, 90000);   // HARD cap: an unreachable closing-rare can't pin forever
  if (type === 'breach2')  return 220000;  // must outlast summon + the full ~9-wave Ailith defense
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

// ===============================================================================================================
// UNIFIED OBJECTIVE ARBITER v2 (2026-07-03, atlas-planner design) -- ONE committed goal per frame, anti-yoyo.
// Supersedes the fragmented rotLockedType + revisitKey + frameLock latches when ARBITER is ON. Three anti-yoyo rules:
//   1. COMMIT-LATCH: once committed, HOLD until a TERMINATOR (done / TTL / walled) -- never re-pick nearest mid-walk.
//   2. HYSTERESIS: a challenger must beat the committed score by ARB_MARGIN after ARB_MIN_DWELL -- near-ties can't swap.
//      (higher-priority / time-sensitive get margin 0 -> they preempt ONCE, cleanly.)
//   3. ROUTE-ORDER: after a completion, "nearest" is from a FROZEN anchor (finished obj) -> consecutive frames agree.
// Priority via score: required (+ARB_REQ_BONUS) > optional > boss (only when nothing eligible). Fog = debounced sticky.
// FLAG: ARBITER=true -> pickObjective DRIVES (distance-weighted content selection), replacing the legacy runContentRotation/
//       revisit/preboss chain. ARBITER=false -> legacy chain drives + the arbiter SHADOW-logs its pick (side-effect-free).
// ===============================================================================================================
const ARBITER = true;              // master: false = legacy + shadow-log; true = arbiter drives (distance-weighted content selection via routeInsertionCost).
const ARB_MARGIN = 20;             // challenger must beat committed score by this to steal (~200u closer OR +20 value)
const ARB_MIN_DWELL_MS = 1500;     // no preemption for this long after a fresh commit (kills churn)
const ARB_REACH_HOLD_MS = 2000;    // a reach-status change must hold this long before it's written (debounce)
const ARB_REQ_BONUS = 1000;        // required objectives lexicographically dominate the score
let arbCommittedKey = null, arbCommittedSince = 0, arbCommittedTtl = 0, arbFrozeAt = 0;
let arbRouteAnchorX = NaN, arbRouteAnchorY = NaN, arbRouteOrder = [], arbRouteAt = 0;
let arbCommitHistory = [], arbYoyoCount = 0, arbShadowAt = 0, arbTickAt = 0;
let arbBossAnchor = null, arbBossAnchorAt = 0;   // 1s cache of resolveBossBearing (its signal-less fallback does 2x getQuestMarkers -- don't pay it per driving frame)
let arbDeferLogAt = 0;                           // throttle for the near-defer visibility log
const arbReachMap = new Map();     // key -> {reach:'reachable'|'fogged'|'walled', since, cand, candAt}
let arbReachAt = 0;
function arbReset() {              // per-map (from resetMapper)
  arbCommittedKey = null; arbCommittedSince = 0; arbCommittedTtl = 0; arbFrozeAt = 0;
  arbRouteAnchorX = NaN; arbRouteAnchorY = NaN; arbRouteOrder = []; arbRouteAt = 0;
  arbCommitHistory = []; arbYoyoCount = 0; arbShadowAt = 0; arbReachMap.clear(); arbReachAt = 0;
  arbBossAnchor = null; arbBossAnchorAt = 0; arbTickAt = 0;
}
// module-level copy of pickUnexploredHeading's corridor probe: how far a WALKABLE corridor extends toward (bx,by).
function arbReachToward(px, py, bx, by) {
  const ang = Math.atan2(by - py, bx - px), ux = Math.cos(ang), uy = Math.sin(ang);
  let lastW = 0;
  for (let dd = 14; dd <= 168; dd += 14) {
    let w = false; try { w = poe2.isWalkable(Math.floor(px + ux * dd), Math.floor(py + uy * dd)); } catch (e) {}
    if (w) lastW = dd; else break;
  }
  return lastW;   // 0 = walled at the door; >=28 = a real corridor opens that way
}
// priority class: 2=required, 1=optional (toggle on), 0=not-driven
function arbPriClass(e, now) {
  if (isRequiredType(CQTYPE_TO_DRIVE[e.type], now)) return 2;
  if (typeShouldRun(e.type, now)) return 1;
  return 0;
}
// Debounced fog reach status per key -- recomputed on a throttled cadence (NOT per frame), sticky (a change must hold
// ARB_REACH_HOLD_MS before it's written) so corridor/stream flicker can't flip it frame-to-frame.
function arbUpdateReach(player, now) {
  if (now - arbReachAt < 800) return;
  arbReachAt = now;
  for (const [key, e] of contentQueue) {
    if (!e || e.state !== 'active') { arbReachMap.delete(key); continue; }
    let cand;
    try { const r = arbReachToward(player.gridX, player.gridY, e.gridX, e.gridY); cand = (r >= 28) ? 'reachable' : (r === 0 ? 'walled' : 'fogged'); }
    catch (er) { cand = 'fogged'; }
    let st = arbReachMap.get(key);
    if (!st) { arbReachMap.set(key, { reach: cand, since: now, cand, candAt: now }); continue; }
    if (cand === st.reach) { st.cand = cand; st.candAt = now; }
    else if (cand !== st.cand) { st.cand = cand; st.candAt = now; }               // new candidate -> restart debounce
    else if (now - st.candAt >= ARB_REACH_HOLD_MS) { st.reach = cand; st.since = now; }   // held -> commit the change
  }
}
function arbReachOf(key) { const st = arbReachMap.get(key); return st ? st.reach : 'reachable'; }
function arbCommitTo(key, now, reason) {
  if (arbCommittedKey === key) return;
  if (arbCommittedKey && reason !== 'done' && (now - arbCommittedSince) < 3000) {   // yoyo: swapping off a still-fresh commit
    for (let i = arbCommitHistory.length - 1; i >= 0 && (now - arbCommitHistory[i].at) < 10000; i--) {
      if (arbCommitHistory[i].key === key) { arbYoyoCount++; log(`[Yoyo!] ${arbCommittedKey}<->${key} #${arbYoyoCount} dt=${now - arbCommitHistory[i].at}ms`); break; }
    }
  }
  arbCommittedKey = key; arbCommittedSince = now; arbFrozeAt = 0;
  const e = contentQueue.get(key); arbCommittedTtl = e ? lockTtlFor(e.type) : 45000;
  arbCommitHistory.push({ key, at: now }); if (arbCommitHistory.length > 12) arbCommitHistory.shift();
}
function arbRelease(now) {
  const e = arbCommittedKey ? contentQueue.get(arbCommittedKey) : null;
  if (e) { arbRouteAnchorX = e.gridX; arbRouteAnchorY = e.gridY; }   // freeze the route anchor at the finished obj
  arbCommittedKey = null; arbCommittedSince = 0; arbCommittedTtl = 0; arbRouteOrder = []; arbRouteAt = 0; arbFrozeAt = 0;
}
function arbTerminated(e, now) {
  if (!e || e.state !== 'active') return true;
  if (objectiveTypeComplete(e.type, now)) return true;
  if (lockIsDone(e.type, e.id, now)) return true;
  if (e.type === 'incursion-beacon' && isBeaconEnergisedAt(e.gridX, e.gridY)) return true;
  if (!typeShouldRun(e.type, now)) return true;                       // toggle changed
  if (now - arbCommittedSince > arbCommittedTtl) {                    // HARD ttl (deadlock-proof) -> BAN 60s so R4 can't instantly re-commit the same unreachable target (livelock guard)
    if (arbCommittedKey) revisitSkip.set(arbCommittedKey, now + 60000);
    return true;
  }
  return false;
}
function arbHysteresis(cE, bE, now) {
  if (arbPriClass(bE, now) > arbPriClass(cE, now)) return 0;          // higher priority steals immediately
  const cPol = CONTENT_POLICY[cE.type] || {}, bPol = CONTENT_POLICY[bE.type] || {};
  if (bPol.timeSensitive && !cPol.timeSensitive) return 0;            // time-sensitive preempts
  return ARB_MARGIN;
}
function arbNNsweep(ax, ay, cands) {   // greedy nearest-neighbour order of cand keys from a frozen anchor
  const rem = cands.slice(), order = []; let cx = ax, cy = ay;
  while (rem.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < rem.length; i++) { const e = rem[i].e; const d = Math.hypot(e.gridX - cx, e.gridY - cy); if (d < bd) { bd = d; bi = i; } }
    const p = rem.splice(bi, 1)[0]; order.push(p.key); cx = p.e.gridX; cy = p.e.gridY;
  }
  return order;
}
function arbRunnerFor(e, player, now) {
  switch (e.type) {
    case 'verisium':         return () => runExpedition2(player, now);
    case 'abyss':            return () => runAbyssRun(player, now);
    case 'incursion-chest':  return () => runIncursionChestRun(player, now);
    case 'incursion-beacon': return () => runIncursionBeaconRun(player, now);
    case 'breach': { const b = nearestBreachPoint(player, now); return b ? () => runWalkToBreach(player, now, b) : null; }
  }
  return null;
}
// Walk toward a FOGGED objective with the BOSS's fog-routing (macro-route around fog + frontier reveal), HOLD while
// routing (bounded by the commit TTL + pre-boss budget). Anti-yoyo repath latch. Only called when DRIVING.
function arbExploreToward(e, player, now) {
  if ((targetName !== 'Content Explore' || Math.hypot(targetGridX - e.gridX, targetGridY - e.gridY) > 60 || currentPath.length === 0) && now - lastRepathTime > 1500) {
    startWalkingTo(e.gridX, e.gridY, 'Content Explore', 'boss');
  }
  stepPathWalker();
  return true;   // HOLD -- don't let the boss-arena walk override the required-content route
}
// COORDINATE-DRIVE: the walk+arrival leg for marker/position-anchored content (Vaal Beacons, Breach Hives) whose entity
// runner can't act (proximity variants / nothing streamed). Walks the remembered coordinate with fog-routing, then hands
// arrival to the type's dwell (energise / summon+defend). Without this the arbiter COMMITS on-route beacons/hives but
// never executes them (the pick would stay committed while the boss walk carries on past the target).
function arbCoordDrive(key, e, player, now) {
  MB.set('content', 3);
  const dP = Math.hypot(e.gridX - player.gridX, e.gridY - player.gridY);
  const step = (dP <= 25) ? 'arrived' : 'walking';
  { const bd = beaconArrivalDwell(player, e, key, dP, step, now, 'Arbiter');
    if (bd === 'dwell' || bd === 'done') return true;
    if (bd === 'cap') return false; }
  { const hd = hiveArrivalDwell(player, e, key, dP, step, now, 'Arbiter');
    if (hd === 'dwell' || hd === 'done') return true;
    if (hd === 'cap') return false; }
  if ((targetName !== 'Objective Walk' || Math.hypot(targetGridX - e.gridX, targetGridY - e.gridY) > 60 || currentPath.length === 0) && now - lastRepathTime > 1500) {
    startWalkingTo(e.gridX, e.gridY, 'Objective Walk', 'boss');
  }
  const ws = stepPathWalker();
  if (ws === 'walking' || ws === 'arrived') { statusMessage = `Objective: walking to ${e.type} ${Math.round(dP)}u`; return true; }
  if (ws === 'stuck') addSoftBlock(player.gridX, player.gridY);
  // walled/stuck -> ban so the commit releases (no livelock). REQUIRED content gets a SHORT ban -- a 60s ban let the
  // discovery explorer take over the whole window while the required beacon sat parked.
  revisitSkip.set(key, now + (isRequiredType(CQTYPE_TO_DRIVE[e.type], now) ? 15000 : 60000));
  return false;
}
function arbGoal(c, player, now) {
  const reach = c.reach || arbReachOf(c.key);
  const dbg = c.cl ? { tier: c.cl.tier, ins: Math.round(c.cl.detourCost || 0), bud: Math.round(c.cl.budget || 0) } : null;   // shadow-validation
  if (reach === 'fogged') return { kind: 'content', key: c.key, fogged: true, dbg, run: () => arbExploreToward(c.e, player, now) };
  const run = arbRunnerFor(c.e, player, now);
  const coord = (c.e.type === 'incursion-beacon' || c.e.type === 'breach2');   // position-anchored -> always has the walk+dwell fallback
  const drive = coord ? () => ((run && run()) || arbCoordDrive(c.key, c.e, player, now)) : (run || (() => false));
  return { kind: 'content', key: c.key, dbg, run: drive };
}
// Cached boss bearing (perf: bearing barely moves; cuts the getTgtLocations/getQuestMarkers cost on the DRIVING path).
// Used by pickObjective (the driving path refreshes it once per second).
function bossAnchorCached(player, now) {
  if (now - arbBossAnchorAt > 1000) { arbBossAnchor = resolveBossBearing(player, now); arbBossAnchorAt = now; }
  return arbBossAnchor;
}
// THE arbiter. phase 'preboss' (NEAR/MID-detour for optional) | 'postboss' (wide 900u). Returns {kind,key,run,...}.
function pickObjective(player, now, phase) {
  arbUpdateReach(player, now);
  const bossAnchor = bossAnchorCached(player, now);
  if (!arbCommittedKey) { arbRouteAnchorX = player.gridX; arbRouteAnchorY = player.gridY; }   // route/insertion anchor frozen ONLY while committed -> no stale-anchor defers on a long uncommitted explore
  // CHANGE 3: pre-boss content-deferral budget. Only meaningful in the pre-boss phase with a CONFIDENT boss anchor
  // (>=0.7) actually known. Once the ULTIMATE budget (PREBOSS_HOLD_BUDGET_MS) OR the ~30s no-boss-progress fast-out is
  // spent, STOP deferring -> return boss; the remaining content is finished by the post-boss MAP_COMPLETE cleanup. Any
  // required-objective completion (energised beacon) re-seeds a fresh window. No confident anchor / post-boss -> the
  // budget isn't running (don't force a boss we can't reach). ARBITER-gated -> flag-off shadow path is unaffected.
  let _bossDeferSpent = false;
  if (ARBITER && phase !== 'postboss' && bossAnchor && Number.isFinite(bossAnchor.x) && (bossAnchor.conf || 0) >= 0.7) {
    if (energisedBeacons.length > arbBossDeferEnergCount) {   // required objective completed -> fresh window
      arbBossDeferEnergCount = energisedBeacons.length; arbBossDeferSince = now; arbBossDeferBestDist = Infinity; arbBossDeferImprovedAt = now;
    }
    if (!arbBossDeferSince) { arbBossDeferSince = now; arbBossDeferImprovedAt = now; arbBossDeferBestDist = Infinity; }   // seed on the first deferral this map
    const _dAnchor = Math.hypot(bossAnchor.x - player.gridX, bossAnchor.y - player.gridY);
    if (_dAnchor < arbBossDeferBestDist - 20) { arbBossDeferBestDist = _dAnchor; arbBossDeferImprovedAt = now; }   // real boss-progress -> refresh the fast-out clock
    // An ACTIVE content ENGAGEMENT (verisium fight/waves, breach, hive, beacon hold, abyss dwell) IS progress --
    // freeze the fast-out during it, else the 30s cap fires MID-FIGHT and forces a boss walk-off (walk-away/return yoyo).
    if (exp2Phase !== 'idle' || rotBreachActivatedAt > 0 || hiveKey !== null || hiveDefStart > 0
        || revisitBeaconKey !== null || (abyssLootDwellAt > 0 && now - abyssLootDwellAt < 15000) || abyssId !== 0) {
      arbBossDeferImprovedAt = now;
    }
    _bossDeferSpent = (now - arbBossDeferSince) >= PREBOSS_HOLD_BUDGET_MS || (now - arbBossDeferImprovedAt) >= PREBOSS_BOSS_FASTOUT_MS;
  } else {
    arbBossDeferSince = 0;
  }
  arbBossDeferSpent = _bossDeferSpent;
  if (_bossDeferSpent) return { kind: 'boss' };   // budget spent -> engage the boss (remaining content = post-boss cleanup)
  const cands = [];
  for (const [key, e] of contentQueue) {
    if (!e || e.state !== 'active') continue;
    if ((revisitSkip.get(key) || 0) > now) continue;                 // TTL-banned / unreachable (shared w/ legacy revisit) -> R4 can't re-commit it
    const pri = arbPriClass(e, now);
    if (pri === 0) continue;
    if (objectiveTypeComplete(e.type, now)) continue;
    if (e.type === 'incursion-beacon' && isBeaconEnergisedAt(e.gridX, e.gridY)) continue;
    if (lockIsDone(e.type, e.id, now)) continue;
    let reach = arbReachOf(key);
    // 'walled' is a 14u straight-ray HEURISTIC (a wall on the bearing, not path-unreachability) -- dropping REQUIRED
    // content on it releases the commit and strands the objective. Required + walled -> treat as fogged (the
    // macro-route/explore leg walks around the local wall); optional keeps the skip (budget still bounds the map).
    if (reach === 'walled') {
      if (!(objGoalOn() && isRequiredType(CQTYPE_TO_DRIVE[e.type] || e.type, now))) continue;
      reach = 'fogged';
    }
    const cl = classifyObjective(e, player, bossAnchor, reach);      // route-insertion gate (fog down-weights the score)
    let elig;
    if (phase === 'postboss') elig = pri === 2 || cl.dist <= CLEANUP_REACH_LIMIT;   // post-boss: REQUIRED at any distance (finish the map), optional within the cleanup radius
    else elig = cl.eligible;                                         // pre-boss (boss-on-the-way): EVERYTHING is route-insertion gated -- on-route/cheap-detour content now, the rest post-boss
    if (!elig) {
      // NEAR-DEFER visibility: a close-ish objective deferred by the route gate is invisible in the shadow log (only the
      // PICK prints) -- name the defer so "why did it skip X right there" is answerable from the log.
      if (cl.dist < 450 && now - arbDeferLogAt > 5000) {
        arbDeferLogAt = now;
        log(`[Arb] defer ${key}: ${cl.tier} dist=${Math.round(cl.dist)} ins=${Math.round(cl.detourCost || 0)} bud=${Math.round(cl.budget || 0)} -> post-boss sweep`);
      }
      continue;
    }
    cands.push({ key, e, cl, pri, reach, score: cl.score + (pri === 2 ? ARB_REQ_BONUS : 0) });
  }
  // R1/R3 -- validate + HOLD commitment (the anti-yoyo core)
  if (arbCommittedKey) {
    const ce = contentQueue.get(arbCommittedKey);
    if (arbTerminated(ce, now)) arbRelease(now);
    else {
      const committed = cands.find(c => c.key === arbCommittedKey);
      if (committed) {
        if (now - arbCommittedSince < ARB_MIN_DWELL_MS) return arbGoal(committed, player, now);
        let best = committed; for (const c of cands) if (c.score > best.score) best = c;
        if (best.key === committed.key) return arbGoal(committed, player, now);
        if (best.score - committed.score >= arbHysteresis(committed.e, best.e, now)) { arbCommitTo(best.key, now, 'preempt'); return arbGoal(best, player, now); }
        return arbGoal(committed, player, now);                      // HOLD -- kills A-close/B-close swap
      }
      // out of cands but alive: keep walking/exploring toward it -- UNLESS it's walled or banned, then RELEASE so R4 re-picks (no livelock).
      if (arbReachOf(arbCommittedKey) !== 'walled' && !((revisitSkip.get(arbCommittedKey) || 0) > now))
        return arbGoal({ key: arbCommittedKey, e: ce, reach: arbReachOf(arbCommittedKey) }, player, now);
      arbRelease(now);
    }
  }
  // R4 -- fresh pick via route order (frozen anchor); recompute the sweep only on release / staleness
  if (cands.length) {
    if (!arbRouteOrder.length || now - arbRouteAt > 15000) {
      arbRouteOrder = arbNNsweep(Number.isFinite(arbRouteAnchorX) ? arbRouteAnchorX : player.gridX, Number.isFinite(arbRouteAnchorY) ? arbRouteAnchorY : player.gridY, cands);
      arbRouteAt = now;
    }
    let chosen = cands[0]; for (const c of cands) if (c.score > chosen.score) chosen = c;   // highest score first -- REQUIRED (+1000) dominates (no 1.5s optional detour)
    if (arbPriClass(chosen.e, now) < 2) {                                                   // no required outstanding -> NN route sweep for the optional tour
      for (const key of arbRouteOrder) { const c = cands.find(x => x.key === key); if (c) { chosen = c; break; } }
    }
    arbCommitTo(chosen.key, now, 'fresh');
    return arbGoal(chosen, player, now);
  }
  // R5 -- nothing eligible -> BOSS (far/fogged content, required included, is finished POST-boss by the MAP_COMPLETE cleanup)
  return { kind: 'boss' };
}
// Frame entry point. ALWAYS computes the pick (own state, invisible to legacy latches) + shadow-logs it. DRIVES only when
// ARBITER. Returns true if the arbiter handled the frame (caller returns), false -> fall through to legacy/boss.
function arbTick(player, now) {
  // PERF: driving -> every frame (movement). Shadow -> throttle to ~1/s (we only log every 2s; the shadow compute is pure
  // overhead -- pickObjective re-runs resolveBossBearing whose signal-less fallback does getTgtLocations + getQuestMarkers).
  if (!ARBITER && now - arbTickAt < 1000) return false;
  arbTickAt = now;
  const phase = (currentState === STATE.MAP_COMPLETE) ? 'postboss' : 'preboss';
  let goal = null; try { goal = pickObjective(player, now, phase); } catch (e) { goal = null; }
  if (now - arbShadowAt > 2000) { arbShadowAt = now;
    const gk = !goal ? 'none' : (goal.kind === 'boss' ? 'boss' : (goal.key + (goal.fogged ? '(fog)' : '')));
    const dbg = (goal && goal.dbg) ? ` ${goal.dbg.tier} ins=${goal.dbg.ins} bud=${goal.dbg.bud}` : '';   // route-insertion gate (validate weighting)
    log(`[ArbShadow] pick=${gk}${dbg} committed=${arbCommittedKey || '-'} yoyo=${arbYoyoCount} phase=${phase}${ARBITER ? ' LIVE' : ''}`);
  }
  if (!ARBITER || !goal) return false;                               // shadow mode -> log only, legacy drives
  if (goal.kind === 'content' && goal.run && goal.run()) { statusMessage = `Objective: ${goal.key}${goal.fogged ? ' (explore)' : ''}`; return true; }
  return false;                                                      // boss -> fall through to the boss-find flow
}

// ===== HYBRID revisit-nearby-content-before-boss (objectiveGoalMode). Reads the PERSISTENT contentQueue (survives
// de-stream) and, during boss APPROACH only (FINDING_BOSS / WALKING_TO_BOSS_CHECKPOINT -- NOT melee-approach, NOT
// FIGHTING_BOSS), detours to the nearest ACTIVE instance that is CLOSE to us OR barely off the boss route -- then hands
// off to that content's existing runner. FLAG-OFF (default) = first line returns false = no-op / behavior-parity. =====
let revisitKey = null;            // committed instance key (anti-flip sticky)
let revisitSince = 0;             // commit time (hard 30s TTL release)
const revisitSkip = new Map();    // contentQueue key -> banUntil (best-effort unreachable skip; openBlacklist ethos)
// mirror the clear* toggles EXACTLY as populateContentQueue does. Do NOT use objDriveEnabled(): its keys are 'incursion'
// not 'incursion-chest'/'incursion-beacon' -> would fall through to default:true (ignores clearIncursion).
function typeToggleOn(type) {
  if (type === 'abyss')            return currentSettings.clearAbyss !== false;
  if (type === 'verisium')         return currentSettings.clearVerisiumRemnants !== false;
  if (type === 'incursion-chest' ||
      type === 'incursion-beacon') return currentSettings.clearIncursion !== false;
  if (type === 'breach' ||
      type === 'breach2')          return currentSettings.clearBreach === true;
  return false;
}
// contentQueue TYPE -> the base-game drivable objective it satisfies (for the required-objective force-through).
const CQTYPE_TO_DRIVE = { abyss: 'abyss', verisium: 'verisium', 'incursion-chest': 'incursion', 'incursion-beacon': 'incursion', breach: 'breach', breach2: 'breach2' };
// Soonest expiry among revisitSkip bans currently hiding an ACTIVE required content key (0 = none banned). The
// post-boss required fast-out waits this out so a required objective that is merely ban-hidden (the deliberate
// 60-120s arb-TTL / hive-beacon dwell-cap bans) gets its retry instead of a premature concede+portal.
function soonestRequiredBanExpiry(now) {
  let soon = 0;
  try {
    for (const [k, e] of contentQueue) {
      if (!e || e.state !== 'active') continue;
      if (!isRequiredType(CQTYPE_TO_DRIVE[e.type] || e.type, now)) continue;
      const exp = revisitSkip.get(k) || 0;
      if (exp > now && (soon === 0 || exp < soon)) soon = exp;
    }
  } catch (_) {}
  return soon;
}
// SHOULD this contentQueue instance be DRIVEN? = its clear* toggle is on (OPTIONAL content) OR it is a REQUIRED map
// objective (user 2026-07-03: "always do required objectives" -- forced regardless of the toggle; only the objGoalOn()-
// gated revisit/cleanup callers reach this, so flag-off parity is preserved by their own top-level objGoalOn() guard).
function typeShouldRun(type, now) {
  if (typeToggleOn(type)) return true;
  const drive = CQTYPE_TO_DRIVE[type];
  return !!(drive && isRequiredType(drive, now));
}
// -- SWARM STANDOFF (ranged build survival) ----------------------------------------------------------------------
// >=2 hostiles inside melee press range of the PLAYER -> step AWAY from the pack centroid to bow range instead of
// standing in it / chasing into it. One roll per ~1.1s cannot out-live a point-blank swing swarm -- positioning is
// the fix, not more rolls. Clamped inside the caller's anchor leash so the objective is never abandoned.
const SWARM_PRESS_R = 30, SWARM_PRESS_N = 2, SWARM_STANDOFF = 48;
let swarmScanAt = 0, swarmEscape = null;
function swarmStandoffPoint(player, now, anchorX, anchorY, leash) {
  if (now - swarmScanAt > 300) {
    swarmScanAt = now; swarmEscape = null;
    let n = 0, cx = 0, cy = 0;
    try { for (const m of (poe2.getEntities({ lightweight: true }) || [])) {
      if (!m || m.entityType !== 'Monster' || !m.isAlive || !m.isHostile || !m.isTargetable) continue;
      const d = Math.hypot((m.gridX || 0) - player.gridX, (m.gridY || 0) - player.gridY);
      if (d <= SWARM_PRESS_R) { n++; cx += (m.gridX || 0); cy += (m.gridY || 0); }
    } } catch (_) { return null; }
    if (n >= SWARM_PRESS_N) {
      cx /= n; cy /= n;
      let ax = player.gridX - cx, ay = player.gridY - cy;
      const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
      swarmEscape = { x: player.gridX + ax * SWARM_STANDOFF, y: player.gridY + ay * SWARM_STANDOFF, n };
    }
  }
  if (!swarmEscape) return null;
  if (Number.isFinite(anchorX) && Number.isFinite(leash)) {
    const dx = swarmEscape.x - anchorX, dy = swarmEscape.y - anchorY, dd = Math.hypot(dx, dy);
    if (dd > leash) return { x: anchorX + (dx / dd) * leash, y: anchorY + (dy / dd) * leash, n: swarmEscape.n };
  }
  return swarmEscape;
}
// KITE around a defend anchor: keep MOVING (orbit it) instead of planting -- a stationary target in a breach swarm
// dies. Aims for a ring point ~ringR from the anchor, stepped ~28deg around each call, so the bot circles the anchor
// (the pathfinder routes around the fence walls) -- always near the objective, never standing still. The dodge still
// rolls out of danger; this drifts us back around so Ailith is never abandoned and we are never a stationary target.
let _hiveKiteDir = 1;
function hiveKiteTarget(player, now, ax, ay, ringR) {
  let rx = player.gridX - ax, ry = player.gridY - ay;
  const rd = Math.hypot(rx, ry);
  if (rd < 1) { rx = 1; ry = 0; }
  const ang = Math.atan2(ry, rx) + 0.5 * _hiveKiteDir;
  return { x: ax + Math.cos(ang) * ringR, y: ay + Math.sin(ang) * ringR };
}
// -- BREACH HIVES (Breach2, "Complete all Breach Hives") ---------------------------------------------------------
// Each hive node = a Metadata/MiscellaneousObjects/Brequel/BrequelSpawnerCover with a GLOBAL quest-marker (iconType 1048
// while ACTIVE; markers exist beyond entity-stream range, so coordinates are de-stream-proof). The hive field is fenced by
// BrequelBlocker walls with BrequelSpawner spawn points pouring breach mobs. "Complete" = defend/clear AT the cover; the
// marker CLEARS when that node is done (v1 inference -- covers vanish off completed spawners). Unknown icon -> log + ACTIVE.
const HIVE_ACTIVE_ICONS = new Set([1048]);
const HIVE_FIGHT_REACH   = 25;      // <= this to the cover -> enter the defend/clear hold
const HIVE_FIGHT_RADIUS  = 100;     // engage hostiles within this of the cover; never chase past it
const HIVE_NOMOB_TIMEOUT = 25000;   // no hostile near the anchor this long AND marker still active -> give up (retry later); must outlast inter-wave gaps
const HIVE_TOTAL_TIMEOUT = 180000;  // hard cap at one hive (the Ailith defense runs wave after wave -- generous)
let hiveScanAt = 0, hiveCache = null, hiveIconWarned = new Set();
function getBreachHives(now) {                       // -> [{x,y,icon}] ACTIVE hive covers, null = scan failed (don't prune)
  if (now - hiveScanAt < 1000) return hiveCache;
  hiveScanAt = now;
  try {
    const out = [];
    for (const m of (poe2.getQuestMarkers() || [])) {
      if (!/BrequelSpawnerCover/i.test(m.path || '')) continue;
      const icon = m.iconType;
      if (!HIVE_ACTIVE_ICONS.has(icon) && !hiveIconWarned.has(icon)) { hiveIconWarned.add(icon); log(`[Hive] unknown SpawnerCover iconType ${icon} -> treating ACTIVE (capture for the done-signal)`); }
      out.push({ x: Math.round(m.gridX || 0), y: Math.round(m.gridY || 0), icon });
    }
    hiveCache = out;
  } catch (_) { hiveCache = null; }
  return hiveCache;
}
let hiveKey = null, hiveStart = 0, hiveLastMobAt = 0, hiveSummonAt = 0, hiveSummonCount = 0;
let hivePieceScanAt = 0, hivePieceStab = null, hivePieceAilith = null, hiveMobScanAt = 0, hiveMobPt = null;
let beaconMobScanAt = 0, beaconMobPt = null;
let hiveDefScanAt = 0, hiveDefAilith = null, hiveDefStart = 0, hiveDefPreSummon = false, hiveDefEndAt = 0, hiveDefMobAt = 0, hiveDefMobPt = null, hiveHealAt = 0;
let hiveLootX = NaN, hiveLootY = NaN;   // post-defense loot-sweep anchor (the fight spot)
// ACTIVE-DEFENSE HOLD: a summoned hive defense is RUNNING -- protect Ailith until it finishes, before ANYTHING else can
// preempt (utility loot detours, arbiter re-picks, the boss walk). KEY: Ailith PRE-EXISTS at the Stabiliser (caged), so
// her presence alone means nothing -- "running" = Ailith alive AND the Stabiliser NO LONGER targetable (the summon
// consumed it). Pre-summon this stands DOWN so the arbiter's dwell can click Summon. Hard 240s safety cap.
function runHiveDefense(player, now) {
  if (!player) return false;
  MB.set('content', 3);
  // POST-DEFENSE LOOT DWELL: the event just ended -> hold at the fight spot for the drops (pickit collects), then release.
  if (hiveDefEndAt) {
    const _hDwelt = now - hiveDefEndAt;
    if (!Number.isFinite(hiveLootX)) { hiveLootX = player.gridX; hiveLootY = player.gridY; }   // fight-spot anchor
    // 6s base stand (hive drops despawn fast), then WALK each remaining drop into grab range.
    if (_hDwelt < 6000) { sendStopMovementLimited(); statusMessage = `Breach Hive: collecting drops (${(_hDwelt / 1000).toFixed(1)}s)`; return true; }
    if (_hDwelt < 30000 && sweepLootStep(player, now, hiveLootX, hiveLootY, 140)) return true;
    hiveDefEndAt = 0; hiveLootX = NaN; hiveLootY = NaN; return false;
  }
  if (!typeShouldRun('breach2', now)) return false;
  if (!mapObjectiveExists('Breach2', now)) return false;
  if (mapObjectiveComplete('Breach2', now)) {
    if (hiveDefStart) { hiveDefStart = 0; hiveDefEndAt = now; return true; }   // was defending -> event finished -> loot dwell
    return false;
  }
  if (now - hiveDefScanAt > 1000) {
    hiveDefScanAt = now;
    hiveDefAilith = null; hiveDefPreSummon = false;
    try { for (const f of (poe2.getEntities({ nameContains: 'ChayulaFarmer', lightweight: true }) || [])) {
      if (/ChayulaFarmer/i.test(f.name || '') && f.isAlive) { hiveDefAilith = { x: f.gridX, y: f.gridY }; break; }
    } } catch (_) {}
    if (hiveDefAilith) {
      let stabSeen = false;
      try { for (const s of (poe2.getEntities({ nameContains: 'BrequelStabiliser', lightweight: false }) || [])) {
        if (!/BrequelStabiliser/i.test(s.name || '')) continue;
        if (Math.hypot((s.gridX || 0) - hiveDefAilith.x, (s.gridY || 0) - hiveDefAilith.y) >= 200) continue;
        stabSeen = true;
        if (s.isTargetable) { hiveDefPreSummon = true; break; }
      } } catch (_) {}
      // No Stabiliser entity visible AND we never started a defense: this is the CAGED pre-existing Ailith seen
      // from afar (she streams in before the Stabiliser object does). Treat as PRE-SUMMON and stand down so the
      // arrival dwell walks in and summons -- otherwise this hold kites around the cage forever, never summoning.
      if (!stabSeen && !hiveDefStart) hiveDefPreSummon = true;
    }
  }
  const a = hiveDefAilith;
  if (!a) {
    if (hiveDefStart) { hiveDefStart = 0; hiveDefEndAt = now; return true; } // Ailith gone while we defended -> event over -> loot dwell
    return false;
  }
  if (hiveDefPreSummon) { hiveDefStart = 0; return false; }                  // NOT summoned yet -> stand down, let the dwell click Summon
  const dA = Math.hypot(a.x - player.gridX, a.y - player.gridY);
  if (dA > 250) { hiveDefStart = 0; return false; }                          // not our fight / already left
  if (!hiveDefStart) hiveDefStart = now;
  if (now - hiveDefStart > 240000) return false;                             // safety cap -> never pinned forever
  // HEAL AILITH (user): a ChayulaAilithHealDaemon becomes available ~20s AFTER summon; interact it once every 5s while
  // it exists. (Blind-wired to the standard interact -- the daemon reads non-targetable, so VERIFY it lands live.)
  if (now - hiveDefStart > 20000 && now - hiveHealAt > 5000) {
    try { for (const h of (poe2.getEntities({ nameContains: 'AilithHeal', lightweight: true }) || [])) {
      if (!/AilithHeal/i.test(h.name || '')) continue;
      interactWithEntity(h); poe2.sendPacket(new Uint8Array([0x01, 0xAA, 0x01])); hiveHealAt = now;
      log(`[Hive] Heal Ailith (interact HealDaemon id=${h.id})`); break;
    } } catch (_) {}
  }
  // DEFEND: throttled mob scan (a per-frame full-slab scan on a 2800-entity hive map = the lag).
  if (now - hiveDefMobAt > 300) {
    hiveDefMobAt = now; hiveDefMobPt = null;
    let md = Infinity;
    try { for (const m of (poe2.getEntities({ lightweight: true }) || [])) {
      if (m && m.entityType === 'Monster' && m.isAlive && m.isHostile && m.isTargetable) {
        const d = Math.hypot((m.gridX || 0) - a.x, (m.gridY || 0) - a.y);
        if (d < HIVE_FIGHT_RADIUS && d < md) { md = d; hiveDefMobPt = { x: m.gridX, y: m.gridY, d }; }
      }
    } } catch (_) {}
  }
  // PATROL-INTERCEPT: stand toward the attacker nearest HER (clamped to a 45u leash around her) instead of gluing to
  // her -- glued, an off-angle/behind-wall attacker chews her while the rotation has no line of sight.
  const mob = hiveDefMobPt;
  // SWARM PRESS overrides the intercept: back off to bow range (clamped near Ailith) instead of standing in the pack.
  const _dso = swarmStandoffPoint(player, now, a.x, a.y, 70);
  let tx = a.x, ty = a.y;
  if (mob) {
    const dxm = mob.x - a.x, dym = mob.y - a.y, dm = Math.hypot(dxm, dym) || 1;
    const c = Math.min(45, dm);
    tx = a.x + (dxm / dm) * c; ty = a.y + (dym / dm) * c;
  }
  if (_dso) { tx = _dso.x; ty = _dso.y; }
  const dT = Math.hypot(tx - player.gridX, ty - player.gridY);
  // Move to the intercept/standoff point; once there, KITE around her instead of planting (never a stationary target).
  if (dT > 12) moveTowardGridPos(player.gridX, player.gridY, tx, ty);
  else { const _kt = hiveKiteTarget(player, now, a.x, a.y, Math.min(45, HIVE_FIGHT_RADIUS * 0.45)); moveTowardGridPos(player.gridX, player.gridY, _kt.x, _kt.y); }
  statusMessage = _dso ? `Breach Hive: standoff (${_dso.n} in melee press)` : (mob ? `Breach Hive: defending Ailith (kiting ${Math.round(mob.d)}u)` : `Breach Hive: kiting Ailith`);
  return true;                                                               // HOLD -- nothing preempts an active defense
}
// Arrival hold at a hive field (LIVE-CAPTURED flow): walk to the BrequelStabiliser -> interact = "Summon Ailith" (standard
// 01A3+01AA pair) -> Ailith (NPC/ChayulaFarmerWild, friendly) spawns -> DEFEND her through the ~9 waves -> ONE defense
// completes the WHOLE field (all SpawnerCover markers clear + the Breach2 bit flips; Stabiliser goes un-targetable on
// summon, marker icon 30 when spent). Same caller contract as beaconArrivalDwell: 'dwell'/'done'/'cap'/null.
function hiveArrivalDwell(player, e, chosenKey, dP, step, now, label) {
  if (!e || e.type !== 'breach2') return null;
  // STICKY once committed: the Stabiliser can sit ~100u from the cover the walk targeted -- without the sticky the
  // summon-walk would leave cover-range, drop out, and oscillate against the caller's Phase-1 walk.
  if (!(step === 'arrived' || dP <= HIVE_FIGHT_REACH || hiveKey === chosenKey)) return null;
  if (hiveKey !== chosenKey) {
    hiveKey = chosenKey; hiveStart = now; hiveLastMobAt = now; hiveSummonCount = 0;
    log(`[Hive] ${label}: at Breach Hive (${Math.round(e.gridX)},${Math.round(e.gridY)}) -> summon + defend`);
  }
  // DONE: the whole-objective bit OR this cover's marker cleared (one Ailith defense completes the whole field).
  const hs = getBreachHives(now);
  const mk = (hs || []).find(h => Math.hypot(h.x - e.gridX, h.y - e.gridY) < 45);
  if (objectiveTypeComplete('breach2', now) || (hs && !mk)) {
    if (e.state !== 'completed') { e.state = 'completed'; e.completedAt = now; e.completionSource = 'markerGone'; }
    log(`[Hive] Breach Hive complete after ${((now - hiveStart) / 1000).toFixed(0)}s -> release`);
    hiveKey = null; hiveSummonAt = 0; revisitSkip.set(chosenKey, now + 10000); revisitKey = null;
    return 'done';
  }
  // FIELD PIECES (streamed once close): the Stabiliser (summon anchor) + Ailith (defend anchor). Throttled 1s -- these
  // are name-filtered full-slab scans, per-frame they lag a dense hive map.
  if (now - hivePieceScanAt > 1000) {
    hivePieceScanAt = now; hivePieceStab = null; hivePieceAilith = null;
    try { for (const s of (poe2.getEntities({ nameContains: 'BrequelStabiliser', lightweight: false }) || [])) {
      if (/BrequelStabiliser/i.test(s.name || '') && Math.hypot((s.gridX || 0) - e.gridX, (s.gridY || 0) - e.gridY) < 200) { hivePieceStab = s; break; }
    } } catch (_) {}
    try { for (const f of (poe2.getEntities({ nameContains: 'ChayulaFarmer', lightweight: true }) || [])) {
      if (/ChayulaFarmer/i.test(f.name || '') && f.isAlive) { hivePieceAilith = f; break; }
    } } catch (_) {}
  }
  const stab = hivePieceStab, ailith = hivePieceAilith;
  // SUMMON: Stabiliser targetable = not yet summoned -> walk onto it + interact, 1s apart, up to 5 attempts (MAKE SURE
  // it lands; the targetable->false flip confirms). After 5 the no-mob/total caps release the hold.
  if (stab && stab.isTargetable) {
    hiveLastMobAt = now;                                       // the summon phase never counts as idle
    const dS = Math.hypot((stab.gridX || 0) - player.gridX, (stab.gridY || 0) - player.gridY);
    if (dS > 14) { moveTowardGridPos(player.gridX, player.gridY, stab.gridX, stab.gridY); statusMessage = `Breach Hive: to Stabiliser ${Math.round(dS)}u`; return 'dwell'; }
    if (hiveSummonCount < 5 && now - hiveSummonAt >= 1000) {
      hiveSummonAt = now; hiveSummonCount++;
      try { interactWithEntity(stab); poe2.sendPacket(new Uint8Array([0x01, 0xAA, 0x01])); } catch (_) {}
      log(`[Hive] Summon Ailith (interact Stabiliser id=${stab.id}, attempt ${hiveSummonCount}/5)`);
    }
    // Fire the summon while KITING around the Stabiliser (stays in interact range, never a stationary target in the swarm).
    const _kt = hiveKiteTarget(player, now, stab.gridX, stab.gridY, 10);
    moveTowardGridPos(player.gridX, player.gridY, _kt.x, _kt.y);
    statusMessage = `Breach Hive: summoning Ailith (kiting)... (${hiveSummonCount}/5)`;
    return 'dwell';
  }
  // DEFEND: anchor = Ailith > Stabiliser > cover. Engage hostiles near the ANCHOR (entity_actions kills them), hold close
  // to her otherwise -- never chase past the leash. Mob scan throttled 300ms (per-frame full-slab scans = the lag).
  const ax = ailith ? ailith.gridX : (stab ? stab.gridX : e.gridX);
  const ay = ailith ? ailith.gridY : (stab ? stab.gridY : e.gridY);
  if (now - hiveMobScanAt > 300) {
    hiveMobScanAt = now; hiveMobPt = null;
    let md = Infinity;
    try { for (const m of (poe2.getEntities({ lightweight: true }) || [])) {
      if (m && m.entityType === 'Monster' && m.isAlive && m.isHostile && m.isTargetable) {
        const d = Math.hypot((m.gridX || 0) - ax, (m.gridY || 0) - ay);
        if (d < HIVE_FIGHT_RADIUS && d < md) { md = d; hiveMobPt = { d }; }
      }
    } } catch (_) {}
  }
  const mob = hiveMobPt;
  if (mob) hiveLastMobAt = now;
  const _hso = swarmStandoffPoint(player, now, ax, ay, HIVE_FIGHT_RADIUS);
  // Swarm-pressed -> back off (clamped near her); else KITE around her -- never plant (a stationary target dies), never
  // just "return and stop". The orbit ring pulls us back in when drifted and circles her when close.
  if (_hso) moveTowardGridPos(player.gridX, player.gridY, _hso.x, _hso.y);
  else { const _kt = hiveKiteTarget(player, now, ax, ay, Math.min(45, HIVE_FIGHT_RADIUS * 0.45)); moveTowardGridPos(player.gridX, player.gridY, _kt.x, _kt.y); }
  statusMessage = _hso ? `Breach Hive: standoff (${_hso.n} in melee press)` : (mob ? `Breach Hive: defending Ailith (kiting ${Math.round(mob.d)}u)` : `Breach Hive: kiting Ailith`);
  if (now - hiveLastMobAt >= HIVE_NOMOB_TIMEOUT || now - hiveStart >= HIVE_TOTAL_TIMEOUT) {
    log(`[Hive] Breach Hive not completing (${((now - hiveStart) / 1000).toFixed(0)}s, ${((now - hiveLastMobAt) / 1000).toFixed(0)}s no-mob) -> skip + retry later`);
    hiveKey = null; hiveSummonAt = 0; revisitSkip.set(chosenKey, now + 120000); revisitKey = null;
    return 'cap';
  }
  return 'dwell';
}
// -- Vaal-Beacon FIGHT-AND-ENERGISE hold (Alva-Temple proximity variant) ---------------------------------------
// The pedestal reads isTargetable=false -> getIncursionBeacons() is empty -> the entity runner never fires; the beacon
// energises by PROXIMITY once its guardians are dead. On arrival: engage hostiles AROUND the beacon (entity_actions kills
// them), return to the centre when clear so proximity energises it, detect done via the sticky quest-marker registry, and
// give up on 15s-no-mob or 30s-total. Sticky -- it re-enters and continues if the opener briefly pulls us off the beacon,
// so a passive plant can't be broken by an opener detour. done -> mark permanently; the prune + eligibility never re-offer it.
const BEACON_FIGHT_REACH   = 20;      // <= this to the centre -> enter the fight/energise hold
const BEACON_CENTRE_REACH  = 4;       // energise needs the player ON the chest-spawn CENTRE -> drive in to <= this (or through it), not a stand-off
const BEACON_FIGHT_RADIUS  = 70;      // engage hostiles within this of the centre (clear guardians); never chase past it
const BEACON_NOMOB_TIMEOUT = 15000;   // no hostile near the beacon this long AND still not energised -> give up
const BEACON_TOTAL_TIMEOUT = 30000;   // hard total cap at a beacon -> give up
const BEACON_CHEST_DWELL_MS = 6000;   // after the energise, HOLD at the beacon: the reward chest takes a few seconds to rise (doesn't always) -- leave too fast and it's missed
let revisitBeaconKey = null, revisitBeaconDwellStart = 0, revisitBeaconIncDoneAtStart = false, revisitBeaconLastMobAt = 0, revisitBeaconEnergisedAt = 0;
// Returns: 'dwell' -> handling (caller: return true); 'done' -> energised, released; 'cap' -> gave up, banned + released
//          (caller: return false); null -> not applicable (caller falls through to the uniform bailout).
function beaconArrivalDwell(player, e, chosenKey, dP, step, now, label) {
  if (!e || e.type !== 'incursion-beacon') return null;      // ONLY incursion-beacon; others keep the uniform ban
  if (!(step === 'arrived' || dP <= BEACON_FIGHT_REACH)) return null;   // must be CLOSE (~20u)
  if (revisitBeaconKey !== chosenKey) {                      // (re)commit -> fresh window (new beacon / first arrival)
    revisitBeaconKey = chosenKey; revisitBeaconDwellStart = now; revisitBeaconLastMobAt = now; revisitBeaconEnergisedAt = 0;
    revisitBeaconIncDoneAtStart = mapObjectiveComplete('Incursion', now);
    log(`[Incursion] ${label}: at Vaal Beacon (${Math.round(e.gridX)},${Math.round(e.gridY)}) -> fight + energise`);
  }
  scanEnergisedBeacons(now);                                 // refresh the sticky done registry from the streamed pedestal
  // ENERGISED (de-stream-proof quest-marker 994, or the whole-map Incursion bit flipped this hold) -> record it, then
  // HOLD a few seconds: the reward chest takes time to rise (opener/pickit grab it via the move-lock), THEN release.
  if (isBeaconEnergisedAt(e.gridX, e.gridY) || (mapObjectiveComplete('Incursion', now) && !revisitBeaconIncDoneAtStart)) {
    markBeaconEnergised(e.gridX, e.gridY);
    if (!revisitBeaconEnergisedAt) { revisitBeaconEnergisedAt = now; log(`[Incursion] Vaal Beacon energised after ${((now - revisitBeaconDwellStart) / 1000).toFixed(0)}s -> holding ${(BEACON_CHEST_DWELL_MS / 1000).toFixed(0)}s for the chest`); }
    const _bcDwelt = now - revisitBeaconEnergisedAt;
    // Base chest wait ON the centre (the chest pops late), then WALK each drop into grab range.
    if (_bcDwelt < BEACON_CHEST_DWELL_MS) {
      if (dP > BEACON_CENTRE_REACH) moveTowardGridPos(player.gridX, player.gridY, e.gridX, e.gridY); else sendStopMovementLimited();
      statusMessage = `Vaal Beacon: energised -- waiting for the chest (${(_bcDwelt / 1000).toFixed(1)}s)`;
      return 'dwell';
    }
    if (_bcDwelt < BEACON_CHEST_DWELL_MS + 30000 && sweepLootStep(player, now, e.gridX, e.gridY, 110)) return 'dwell';
    revisitBeaconKey = null; revisitBeaconDwellStart = 0; revisitBeaconEnergisedAt = 0;
    revisitSkip.set(chosenKey, now + 10000); revisitKey = null;
    return 'done';
  }
  // FIGHT AROUND: engage the nearest hostile near the beacon; when clear, return to the centre for proximity-energise.
  // Leashed to BEACON_FIGHT_RADIUS -- never chase a mob off the beacon.
  if (now - beaconMobScanAt > 300) {                         // throttled (a per-frame full-slab scan lags a dense map)
    beaconMobScanAt = now; beaconMobPt = null;
    let md = Infinity;
    try { for (const m of (poe2.getEntities({ lightweight: true }) || [])) {
      if (m && m.entityType === 'Monster' && m.isAlive && m.isHostile && m.isTargetable) {
        const d = Math.hypot((m.gridX || 0) - e.gridX, (m.gridY || 0) - e.gridY);
        if (d < BEACON_FIGHT_RADIUS && d < md) { md = d; beaconMobPt = { d }; }
      }
    } } catch (_) {}
  }
  const mob = beaconMobPt, md = mob ? mob.d : Infinity;
  if (mob) revisitBeaconLastMobAt = now;                     // guardians present -> hold the window; the ranged rotation kills them + the dodge kites their hits
  // HOLD THE CENTRE (proximity energises once guardians die). NEVER walk onto the mob -- a ranged char standing in a
  // unique's face just eats hits (the dodge can't out-roll a point-blank stand). Move to the centre only if drifted, else plant.
  // The beacon energises only when the player reaches the CENTRE (the chest-spawn point), so drive INTO it (or
  // through it) -- NO swarm stand-off here (it would hold us out of the energise zone); the dodge covers survival
  // while crossing the guardians. Plant only once actually on the centre.
  if (dP > BEACON_CENTRE_REACH) moveTowardGridPos(player.gridX, player.gridY, e.gridX, e.gridY);
  else sendStopMovementLimited();
  statusMessage = mob ? `Vaal Beacon: clearing guardians (${Math.round(md)}u no-mob ${((now - revisitBeaconLastMobAt) / 1000).toFixed(0)}s)` : `Vaal Beacon: energising`;
  // GIVE UP: 15s with no hostile near it (guardians done but never energised = wrong spot / already done) OR 30s total.
  if (now - revisitBeaconLastMobAt >= BEACON_NOMOB_TIMEOUT || now - revisitBeaconDwellStart >= BEACON_TOTAL_TIMEOUT) {
    log(`[Incursion] Vaal Beacon not energised (${((now - revisitBeaconDwellStart) / 1000).toFixed(0)}s, ${((now - revisitBeaconLastMobAt) / 1000).toFixed(0)}s no-mob) -> skip + move on`);
    revisitBeaconKey = null; revisitBeaconDwellStart = 0; revisitBeaconEnergisedAt = 0;
    revisitSkip.set(chosenKey, now + 120000); revisitKey = null;
    return 'cap';
  }
  return 'dwell';
}
function tryRevisitNearbyContent(player, now) {
  if (!objGoalOn()) return false;                                            // master OFF -> strict no-op (byte-parity)
  if (!player) return false;
  MB.set('content', 3);
  if (currentState !== STATE.FINDING_BOSS &&
      currentState !== STATE.WALKING_TO_BOSS_CHECKPOINT) return false;       // approach only; NOT melee-approach, NOT FIGHTING
  // Boss anchor for the DIRECTION leg: live boss grid, else the sticky bearing. null -> degrade to proximity.
  const anchor = (Number.isFinite(bossGridX) && Math.hypot(bossGridX, bossGridY) > 80)
    ? { x: bossGridX, y: bossGridY } : resolveBossBearing(player, now);
  // eligibility -> distance-to-player (a number) if the instance qualifies, else false. R = within NEAR_DIST(150u) OR
  // (perp detour off the boss route <= DETOUR_BUDGET(220u) AND within MID_LIMIT(500u)). Far-flung stays in the queue.
  const eligible = (key, e) => {
    if (!e || e.state !== 'active') return false;                            // skip engaged/completed
    if ((revisitSkip.get(key) || 0) > now) return false;                     // best-effort unreachable ban
    if (!typeShouldRun(e.type, now)) return false;                           // toggle off AND not a required objective -> skip
    if (objectiveTypeComplete(e.type, now)) return false;                    // whole objective already done -> ignore stale entries (no yoyo)
    if (e.type === 'incursion-beacon' && isBeaconEnergisedAt(e.gridX, e.gridY)) return false;   // sticky: already energised -> never revisit
    if (lockIsDone(e.type, e.id, now)) return false;                         // already done
    const dP = Math.hypot(e.gridX - player.gridX, e.gridY - player.gridY);
    const detour = anchor ? routeDetourCost(player.gridX, player.gridY, e.gridX, e.gridY, anchor.x, anchor.y) : null;
    const close = dP <= NEAR_DIST || (detour != null && detour <= DETOUR_BUDGET && dP <= MID_LIMIT);
    return close ? dP : false;
  };
  // 1) STICKY (anti-flip): keep the committed instance while still eligible + within a hard 30s TTL.
  let chosen = null, chosenKey = null, chosenD = Infinity;
  if (revisitKey && now - revisitSince < 30000) {
    const e = contentQueue.get(revisitKey), d = eligible(revisitKey, e);
    if (d !== false) { chosen = e; chosenKey = revisitKey; chosenD = d; }
  }
  // 2) FRESH PICK: nearest eligible active instance; commit it as the new sticky.
  if (!chosen) {
    for (const [key, e] of contentQueue) {
      const d = eligible(key, e);
      if (d === false) continue;
      if (d < chosenD) { chosenD = d; chosen = e; chosenKey = key; }
    }
    if (chosen) { revisitKey = chosenKey; revisitSince = now; }
  }
  if (!chosen) { revisitKey = null; return false; }                          // nothing close -> fall through to boss (never hang)
  const e = chosen, dP = chosenD;
  // PHASE 2: in stream -> hand to the existing runner (the type->runner switch). Runner true while working /
  // false when done or can't find its entity -> preempts exactly like today's hooks.
  let run = null;
  switch (e.type) {
    case 'verisium':         run = () => runExpedition2(player, now); break;
    case 'abyss':            run = () => runAbyssRun(player, now); break;
    case 'incursion-chest':  run = () => runIncursionChestRun(player, now); break;
    case 'incursion-beacon': run = () => runIncursionBeaconRun(player, now); break;
    case 'breach': { const b = nearestBreachPoint(player, now); if (b) run = () => runWalkToBreach(player, now, b); break; }
  }
  if (run && run()) { statusMessage = `Revisiting ${e.type} ${dP.toFixed(0)}u before boss`; return true; }
  // PHASE 1: out of stream -> WALK to the remembered pos. Commit-latch copied from the far-explore: re-path ONLY on a
  // new target / >60u move / empty path / after 1.5s -- the anti-yoyo guard.
  if ((targetName !== 'Content Revisit'
       || Math.hypot(targetGridX - e.gridX, targetGridY - e.gridY) > 60
       || currentPath.length === 0) && now - lastRepathTime > 1500) {
    startWalkingTo(e.gridX, e.gridY, 'Content Revisit', 'explore');
  }
  const step = stepPathWalker();
  if (step === 'walking') { statusMessage = `Walking to revisit ${e.type} ${dP.toFixed(0)}u before boss`; return true; }
  // Vaal-Beacon arrival-DWELL: proximity energises the pedestal, so do NOT ban-on-arrival for incursion-beacon (that
  // made the bot walk past). Capped inside the helper. Every OTHER type falls through to the uniform bailout below.
  { const bd = beaconArrivalDwell(player, e, chosenKey, dP, step, now, 'Revisit');
    if (bd === 'dwell' || bd === 'done') return true;
    if (bd === 'cap') return false; }
  // Breach-Hive arrival-DWELL: defend/clear at the SpawnerCover until its marker clears (same contract).
  { const hd = hiveArrivalDwell(player, e, chosenKey, dP, step, now, 'Revisit');
    if (hd === 'dwell' || hd === 'done') return true;
    if (hd === 'cap') return false; }
  // Any non-walking result (arrived-but-runner-never-engaged = content GONE, stuck, no_path) -> not actionable. If the
  // content were really there, runContentRotation (runs first) or PHASE 2 would have engaged it. Ban briefly + release
  // so the boss push resumes THIS frame -- no phantom-arrival hang, no spin.
  if (step === 'stuck') addSoftBlock(player.gridX, player.gridY);
  revisitSkip.set(chosenKey, now + (step === 'stuck' ? 90000 : 30000));
  revisitKey = null;
  return false;
}

// ===== POST-BOSS CONTENT CLEANUP (objectiveGoalMode) -- MAP_COMPLETE-only sibling of tryRevisitNearbyContent. The boss is
// dead so there is NO boss route to protect: clear ALL reachable active content (WIDE radius CLEANUP_REACH_LIMIT, no detour
// budget) instead of just the close/on-the-way subset. Reuses the SAME runners, the SAME per-instance unreachable ban
// (revisitSkip), and the SAME anti-flip commit-latch (revisitKey/revisitSince -- no yoyo, no per-tick re-path). Returns
// true while actively clearing OR walking to a reachable instance; false when NOTHING is reachable this frame (caller then
// counts toward the no-progress fast-out / budget and portals out). NEVER traps: unreachable -> revisitSkip ban -> false.
// ===== CLEANUP TUNABLES (the load-bearing safety -- keep obvious). BUDGET is the HARD per-map wall-clock cap measured from
// MAP_COMPLETE entry: when it is spent the bot PORTALS OUT even if content remains. It is NEVER reset by runner activity
// (an unreachable/stuck runner can therefore never hold the bot). NOPROGRESS is a faster give-up for the common
// unreachable-island case so we don't burn the whole budget when nothing is reachable at all. =====
const OBJ_CLEANUP_BUDGET_MS = 150000;     // HARD post-boss cleanup budget (ms), refreshed per completed objective. The boss-on-the-way model defers most content here, so one window must cover a full cross-map required pursuit (walk + fight). Stuck runners are bounded by the per-instance bans + the fast-out, not this. TUNABLE.
const OBJ_CLEANUP_NOPROGRESS_MS = 4000;   // fast-out (ms): nothing reachable for this long -> leave (don't wait out the full budget). TUNABLE.
const CLEANUP_REACH_LIMIT = 1800;  // grid units: widest we chase post-boss content (user: 'happy to search 1000+'). The walk budgets/bans bound the trek, not this cap; it only excludes the truly absurd. TUNABLE.
function tryCleanupContent(player, now) {
  MB.set('content', 3);
  if (!objGoalOn()) return false;                                            // master OFF -> strict no-op (byte-parity)
  if (!player) return false;
  // eligibility: active + not banned + type-enabled + not-done + within the WIDE post-boss reach (proximity only, no route detour).
  const eligible = (key, e) => {
    if (!e || e.state !== 'active') return false;                            // skip engaged/completed
    if ((revisitSkip.get(key) || 0) > now) return false;                     // best-effort unreachable ban (shared w/ revisit)
    if (!typeShouldRun(e.type, now)) return false;                           // toggle off AND not a required objective -> skip
    if (objectiveTypeComplete(e.type, now)) return false;                    // whole objective already done -> ignore stale entries (no yoyo)
    if (e.type === 'incursion-beacon' && isBeaconEnergisedAt(e.gridX, e.gridY)) return false;   // sticky: already energised -> never revisit
    if (lockIsDone(e.type, e.id, now)) return false;                         // already done
    const dP = Math.hypot(e.gridX - player.gridX, e.gridY - player.gridY);
    // REQUIRED objective (user "it's reachable, don't bail"): pursue it at ANY distance -- the pathfinder + the stuck-ban
    // (revisitSkip 90s) + the 90s cleanup/hold budget are the REAL reachability arbiter, NOT a flat 900u cap. Optional
    // content keeps the wide-radius cap (don't trek the whole map for a non-required abyss).
    if (isRequiredType(CQTYPE_TO_DRIVE[e.type], now)) return dP;
    return dP <= CLEANUP_REACH_LIMIT ? dP : false;
  };
  // 1) STICKY (anti-flip): keep the committed instance while still eligible + within the hard 30s TTL.
  let chosen = null, chosenKey = null, chosenD = Infinity;
  if (revisitKey && now - revisitSince < 30000) {
    const e = contentQueue.get(revisitKey), d = eligible(revisitKey, e);
    if (d !== false) { chosen = e; chosenKey = revisitKey; chosenD = d; }
  }
  // 2) FRESH PICK: nearest eligible active instance; commit it as the new sticky.
  if (!chosen) {
    for (const [key, e] of contentQueue) {
      const d = eligible(key, e);
      if (d === false) continue;
      if (d < chosenD) { chosenD = d; chosen = e; chosenKey = key; }
    }
    if (chosen) { revisitKey = chosenKey; revisitSince = now; }
  }
  if (!chosen) {
    // DIAGNOSTIC (throttled): an active queue entry exists but nothing was eligible -- log WHY the first one was
    // rejected, so "left with incursion-beacon:1 active" finally names its gate (ban / obj-complete / energised /
    // lock-done / out of reach).
    if (now - _cleanupRejLogAt > 5000) {
      for (const [key, e] of contentQueue) {
        if (!e || e.state !== 'active') continue;
        let why;
        if ((revisitSkip.get(key) || 0) > now) why = `banned ${Math.round((revisitSkip.get(key) - now) / 1000)}s more`;
        else if (!typeShouldRun(e.type, now)) why = 'type-toggle-off';
        else if (objectiveTypeComplete(e.type, now)) why = 'objective-reads-complete';
        else if (e.type === 'incursion-beacon' && isBeaconEnergisedAt(e.gridX, e.gridY)) why = 'beacon-energised';
        else if (lockIsDone(e.type, e.id, now)) why = 'lock-done';
        else why = `dist ${Math.round(Math.hypot(e.gridX - player.gridX, e.gridY - player.gridY))}u > reach`;
        log(`[Cleanup] ${key} active but rejected: ${why}`);
        _cleanupRejLogAt = now;
        break;
      }
    }
    revisitKey = null; return false;                                         // nothing reachable -> caller portals (never hang)
  }
  const e = chosen, dP = chosenD;
  // PHASE 2: in stream -> hand to the existing runner (same switch as the revisit). Runner true while working.
  let run = null;
  switch (e.type) {
    case 'verisium':         run = () => runExpedition2(player, now); break;
    case 'abyss':            run = () => runAbyssRun(player, now); break;
    case 'incursion-chest':  run = () => runIncursionChestRun(player, now); break;
    case 'incursion-beacon': run = () => runIncursionBeaconRun(player, now); break;
    case 'breach': { const b = nearestBreachPoint(player, now); if (b) run = () => runWalkToBreach(player, now, b); break; }
  }
  if (run && run()) { statusMessage = `Cleanup: clearing ${e.type} ${dP.toFixed(0)}u`; return true; }
  // PHASE 1: out of stream -> WALK to the remembered pos. SAME commit-latch as revisit (re-path only on new target / >60u
  // move / empty path / after 1.5s) -- the anti-yoyo guard. pathType 'boss' = fog-INDEPENDENT macro-route + frontier
  // reveal: a far cleanup target is usually behind unrevealed fog, and the fog-gated 'explore' pathing stalls at the
  // fog wall mid-pursuit.
  if ((targetName !== 'Content Cleanup'
       || Math.hypot(targetGridX - e.gridX, targetGridY - e.gridY) > 60
       || currentPath.length === 0) && now - lastRepathTime > 1500) {
    startWalkingTo(e.gridX, e.gridY, 'Content Cleanup', 'boss');
  }
  const step = stepPathWalker();
  if (step === 'walking') { statusMessage = `Cleanup: walking to ${e.type} ${dP.toFixed(0)}u`; return true; }
  // Vaal-Beacon arrival-DWELL (post-boss cleanup): same as the revisit -- plant on the beacon to energise it instead of
  // banning on arrival. Capped; other types fall through to the uniform bailout below unchanged.
  { const bd = beaconArrivalDwell(player, e, chosenKey, dP, step, now, 'Cleanup');
    if (bd === 'dwell' || bd === 'done') return true;
    if (bd === 'cap') return false; }
  // Breach-Hive arrival-DWELL: defend/clear at the SpawnerCover until its marker clears (same contract).
  { const hd = hiveArrivalDwell(player, e, chosenKey, dP, step, now, 'Cleanup');
    if (hd === 'dwell' || hd === 'done') return true;
    if (hd === 'cap') return false; }
  // FOREIGN PATH: another writer renamed the walk this frame, so the step verdict is about ITS path, not our leg --
  // banning the content off it fed the cleanup<->discover livelock (a fresh 30s ban per stolen frame). Hold the
  // frame instead; the 1.5s repath gate re-issues our walk next pass.
  if (targetName !== 'Content Cleanup' && targetName !== 'Cleanup Reveal') {
    statusMessage = `Cleanup: re-acquiring ${e.type} ${dP.toFixed(0)}u`;
    return true;
  }
  // arrived-but-runner-never-engaged (content GONE) / stuck / no_path -> for REQUIRED content, do NOT ban: the target is
  // almost always behind unrevealed fog, so EXPLORE toward it (hold the target as the fog-anchor -> pickUnexploredHeading
  // biases the reveal toward it, same-side reject keeps the heading honest) until a route opens. Bounded by the cleanup
  // budget + the picker's own walled-bucket blacklists. Optional content keeps the ban (don't trek/reveal for it).
  const _reqBan = isRequiredType(CQTYPE_TO_DRIVE[e.type], now);
  if (_reqBan && dP > 40) {
    fogBlockedAnchorX = e.gridX; fogBlockedAnchorY = e.gridY; fogBlockedAnchorConf = 0.75; fogBlockedAnchorUntil = now + 8000;
    const h = pickUnexploredHeading(player, now);
    if (h && Number.isFinite(h.x)) {
      if ((targetName !== 'Cleanup Reveal' || Math.hypot(targetGridX - h.x, targetGridY - h.y) > 60 || currentPath.length === 0) && now - lastRepathTime > 1500) {
        startWalkingTo(h.x, h.y, 'Cleanup Reveal', 'boss');
        log(`[Cleanup] required ${e.type} fog-blocked at ${Math.round(dP)}u -> exploring to reveal a route`);
      }
      if (stepPathWalker() === 'walking') { statusMessage = `Cleanup: revealing route to ${e.type} (${Math.round(dP)}u)`; return true; }
    }
  }
  if (step === 'stuck') addSoftBlock(player.gridX, player.gridY);
  revisitSkip.set(chosenKey, now + (step === 'stuck' ? (_reqBan ? 6000 : 90000) : (_reqBan ? 8000 : 30000)));
  revisitKey = null;
  return false;
}

// ===== PRE-BOSS CONTENT HOLD (objectiveGoalMode, LEGACY chain: drives only when ARBITER=false; the arbiter path uses the
// boss-on-the-way model instead -- route-gated pre-boss, everything else post-boss) -- do ALL incomplete DRIVABLE objective content
// (incursion/breach/abyss/verisium -- FAR beacons included) BEFORE engaging the boss; boss LAST. Runs from the boss-
// APPROACH states (FINDING_BOSS / WALKING_TO_BOSS_CHECKPOINT) via the pre-switch hook, BEFORE the engage transitions,
// AFTER the close-only tryRevisitNearbyContent (so CLOSE content is still preferred -- no needless backtracks). Reuses
// tryCleanupContent's WIDE-radius routing (CLEANUP_REACH_LIMIT 900, no boss-route detour, incl. beaconArrivalDwell) so it
// walks across the map to each Vaal Beacon and dwells to energise -- exactly what the close-only revisit cannot reach.
// BEST-EFFORT + HARD-CAPPED on its OWN wall-clock (NOT mapCompleteCleanupStartAt, which is 0/stale pre-boss): an
// unreachable / guardian-gated beacon can NEVER hold the boss -- cap -> false -> boss engages (a guardian-gated deadlock is
// then resolved POST-boss by the identical MAP_COMPLETE cleanup pass). Returns true => HOLD the boss (caller returns);
// false => nothing drivable reachable / capped => let the boss engage. FLAG-OFF (default) => objGoalOn() false at the top
// => strict no-op => byte-parity with today's boss-only approach (the boss engages exactly as before).
const PREBOSS_HOLD_BUDGET_MS = 240000;   // ULTIMATE pre-boss hold cap (ms) -- RESET on every required-objective completion (each beacon buys a fresh window), so a multi-beacon map with detours isn't cut off mid-pursuit. 4min = the pathological-freeze backstop, not the normal give-up (the per-target stuck detector is). TUNABLE.
const PREBOSS_HOLD_NOPROGRESS_MS = 4000; // fast-out (ms): nothing reachable this long -> engage the boss (don't burn the full budget). TUNABLE.
const PREBOSS_REQ_STUCK_MS = 25000;      // per-required-target: no CLOSER for this long while fog-routing to it -> ban it (2min), try the next required objective / boss. The real give-up (vs the 4min wall). TUNABLE.
const DISCOVER_EXPLORE_MS = 90000;       // LISTED-but-unfound content (an unexplored breach the map marks incomplete): POST-boss, reveal the map for up to this long looking for it, then leave (boss-on-the-way model: the boss is never held for it). Resets when content is found. TUNABLE.
let discoverExploreSince = 0;            // wall-clock the current "explore for unfound listed content" run started (0 = not exploring)
let discoverConceded = false;            // set once we GIVE UP finding unfound listed content this map (explore window spent / map fully revealed). Reset per map.
let discoverLastHeadingAt = 0;           // last time the picker returned a real heading (it caches null ~2s on a hiccup -> only a SUSTAINED null window means "map fully revealed")
let discoverTgtX = NaN, discoverTgtY = NaN, discoverBestD = Infinity, discoverProgAt = 0;   // STICKY explore target: walking toward a bucket REVEALS it -> the picker churns every pass -> without our own commit the heading yoyos across the map
let _discPatrolAng = 0;   // rotating spoke angle for the no-fog-frontier PATROL sweep
// PRE-BOSS: is there ANY DRIVABLE content still to do (toggle-on OR required, active, not-done/energised)? This is the
// user's "do all drivable content BEFORE the boss" rule -- BROADER than hasOutstandingObjectives (which is required-ONLY,
// for the LEAVE gate). So an OPTIONAL incursion/breach/abyss (its clear* toggle on but NOT named in the objective block)
// still holds the boss until it's done. Cheap queue scan; mirrors tryCleanupContent's eligibility (sans distance/ban).
function hasPreBossContentToDo(now) {
  for (const [key, e] of contentQueue) {
    if (!e || e.state !== 'active') continue;
    if (!typeShouldRun(e.type, now)) continue;                               // toggle off AND not required -> not driven
    if (objectiveTypeComplete(e.type, now)) continue;                        // whole objective done
    if (e.type === 'incursion-beacon' && isBeaconEnergisedAt(e.gridX, e.gridY)) continue;   // already energised
    if (lockIsDone(e.type, e.id, now)) continue;                            // per-instance done
    return true;
  }
  return false;
}
// The nearest ACTIVE, REQUIRED (in the objective block), not-done/energised drivable content -- the target the bot must
// explore TOWARD (revealing fog) when it can't be pathed directly, so a fogged required beacon is reached BEFORE the boss.
function nearestOutstandingRequiredContent(player, now) {
  let best = null, bd = Infinity;
  for (const [key, e] of contentQueue) {
    if (!e || e.state !== 'active') continue;
    if (!isRequiredType(CQTYPE_TO_DRIVE[e.type], now)) continue;             // REQUIRED only (matches the leave gate)
    if ((revisitSkip.get(key) || 0) > now) continue;                        // stuck-banned this pursuit -> try the NEXT required objective
    if (objectiveTypeComplete(e.type, now)) continue;
    if (e.type === 'incursion-beacon' && isBeaconEnergisedAt(e.gridX, e.gridY)) continue;
    if (lockIsDone(e.type, e.id, now)) continue;
    if (!Number.isFinite(e.gridX) || !Number.isFinite(e.gridY)) continue;
    const d = Math.hypot(e.gridX - player.gridX, e.gridY - player.gridY);
    if (d < bd) { bd = d; best = { x: e.gridX, y: e.gridY, type: e.type, key }; }
  }
  return best;
}
function tryPreBossContentPass(player, now) {
  if (!objGoalOn()) return false;                                            // master OFF -> strict no-op (byte-parity)
  if (!player) return false;
  MB.set('content', 3);
  if (currentState !== STATE.FINDING_BOSS &&
      currentState !== STATE.WALKING_TO_BOSS_CHECKPOINT) return false;       // approach only (parity w/ tryRevisitNearbyContent); NOT melee, NOT FIGHTING
  if (!hasPreBossContentToDo(now)) {                                        // no DRIVABLE (queued) content left -> let the boss go (unfound LISTED content is found post-boss by tryDiscoverListedContent)
    preBossHoldNoProgressSince = 0;                                         // release the no-progress clock only; KEEP preBossHoldStartAt so an intermittent read can't restart the wall (reset only in resetMapper)
    return false;
  }
  if (!preBossHoldStartAt) preBossHoldStartAt = now;                         // seed the ULTIMATE budget on the first hold this map
  // PROGRESS: a required beacon just got energised (the sticky registry grew) -> RESET the ultimate wall so the NEXT
  // beacon gets a fresh window. This is why a 3-beacon map with Verisium/breach detours no longer times out mid-pursuit.
  if (energisedBeacons.length > preBossEnergCount) { preBossEnergCount = energisedBeacons.length; preBossHoldStartAt = now; }
  else if (energisedBeacons.length < preBossEnergCount) preBossEnergCount = energisedBeacons.length;   // (map/registry reset safety)
  if (now - preBossHoldStartAt >= PREBOSS_HOLD_BUDGET_MS) return false;      // (a) ULTIMATE cap spent (pathological backstop) -> engage the boss (rest is done post-boss cleanup)
  if (tryCleanupContent(player, now)) {                                      // clearing / walking to a REACHABLE instance (wide radius; dwells beacons; all sub-caps inside)
    preBossHoldNoProgressSince = 0;                                          // real progress -> reset the fast-out clock
    // While actively pulled off the checkpoint walk for content, pause that state's anti-freeze watchdog so it re-seeds
    // fresh on resume (else the stale improvement-timer would spuriously escalate to melee/fog-block).
    if (currentState === STATE.WALKING_TO_BOSS_CHECKPOINT) { bossCheckpointLastImprovementTime = 0; checkpointBestDist = Infinity; }
    return true;                                                            // HOLD -- the boss waits
  }
  // Nothing PATHABLE this frame. If a REQUIRED objective is outstanding, do NOT concede to the boss -- it's just behind
  // UNREVEALED FOG (the exact "went to boss without doing the required incursion" bug: tryCleanupContent stuck-bans a
  // fogged beacon -> false). Redirect the FINDING_BOSS frontier exploration TOWARD the beacon (reveal the fog to it) by
  // setting the sticky explore target, and pull a checkpoint-walk back to FINDING_BOSS so that exploration actually runs.
  // Return FALSE so the (now beacon-directed) exploration executes this frame. Bounded by the 90s budget above -> a truly
  // walled-off beacon still eventually engages the boss (post-boss cleanup finishes it). Optional content is NOT forced
  // here (only the 900u-reachable subset, handled by tryCleanupContent) -- it never blocks the boss on fog.
  const reqTgt = nearestOutstandingRequiredContent(player, now);
  if (reqTgt) {
    // WALK to the fogged required objective with the BOSS's own fog-routing (pathType 'boss' = macro-route around fog +
    // frontier reveal) and HOLD (return true) so the boss-arena walk can't override it. Anti-yoyo repath latch: only
    // re-path on a new target / >60u move / empty path / after 1.5s.
    const dReq = Math.hypot(reqTgt.x - player.gridX, reqTgt.y - player.gridY);
    // PER-TARGET STUCK DETECTOR (the REAL give-up, vs the 4min wall): reset on a NEW target, on a DETOUR (branch not hit
    // >2.5s = Verisium/breach/utility took over -> don't false-ban), or when we get CLOSER. No-closer for
    // PREBOSS_REQ_STUCK_MS while actively fog-routing = this beacon is unreachable -> BAN it 2min + concede this frame so
    // nearestOutstandingRequiredContent yields the NEXT required objective (or, all banned, the boss). Reachable beacons
    // are pursued to completion; only genuinely-walled ones give up.
    if (reqTgt.key !== preBossReqKey || now - preBossReqLastFrameAt > 2500) { preBossReqKey = reqTgt.key; preBossReqBestDist = dReq; preBossReqStuckAt = now; }
    if (dReq < preBossReqBestDist - 20) { preBossReqBestDist = dReq; preBossReqStuckAt = now; }
    preBossReqLastFrameAt = now;
    if (now - preBossReqStuckAt > PREBOSS_REQ_STUCK_MS) {
      revisitSkip.set(reqTgt.key, now + 120000);
      log(`[PreBoss] required ${reqTgt.type} at (${Math.round(reqTgt.x)},${Math.round(reqTgt.y)}) no closer ${Math.round(PREBOSS_REQ_STUCK_MS / 1000)}s -> ban 2min, try next required / boss`);
      preBossReqKey = null;
      return false;
    }
    if ((targetName !== 'Required Content' || Math.hypot(targetGridX - reqTgt.x, targetGridY - reqTgt.y) > 60 || currentPath.length === 0) && now - lastRepathTime > 1500) {
      startWalkingTo(reqTgt.x, reqTgt.y, 'Required Content', 'boss');
      log(`[PreBoss] required ${reqTgt.type} at (${Math.round(reqTgt.x)},${Math.round(reqTgt.y)}) fog-unreachable -> WALKING to it (boss-route) BEFORE boss (${Math.round(dReq)}u)`);
    }
    stepPathWalker();
    preBossHoldNoProgressSince = 0;
    statusMessage = `Pre-boss: routing to required ${reqTgt.type} (fogged, ${Math.round(dReq)}u)`;
    return true;                                                             // HOLD -- the boss waits while we path to the required objective
  }
  // Only OPTIONAL content unreachable -> brief grace then concede (post-boss cleanup finishes it -- fog never blocks boss for optional).
  if (preBossHoldNoProgressSince === 0) preBossHoldNoProgressSince = now;
  if (now - preBossHoldNoProgressSince < PREBOSS_HOLD_NOPROGRESS_MS) return true;   // brief HOLD (grace)
  return false;                                                              // (b) nothing reachable for the fast-out window -> engage the boss (post-boss cleanup finishes it)
}

// The map LISTS a drivable content type incomplete with NO queued instance OF THAT TYPE -> we haven't FOUND it (unexplored,
// e.g. a fogged breach). Per-TYPE so a queued abyss can't mask an unfound breach. Holds the post-boss cleanup open and
// triggers the discovery explore below.
function hasUnfoundListedContent(now) {
  const t = now || Date.now();
  let found = 0;                                                      // 0 = none; 1 = optional-only; 2 = required unfound
  for (const objName in OBJ_DRIVABLE) {
    const type = OBJ_DRIVABLE[objName];
    if (!mapObjectiveExists(objName, t)) continue;                    // not present on this map
    if (mapObjectiveComplete(objName, t)) continue;                   // already done
    if (!objDriveEnabled(type) && !isRequiredType(type, t)) continue; // toggle-off and not required -> don't hold
    let queued = false;
    for (const [k, e] of contentQueue) {
      if (!e || e.state !== 'active') continue;
      if ((CQTYPE_TO_DRIVE[e.type] || e.type) !== type) continue;
      queued = true; break;                                           // an instance of THIS type is queued -> the cleanup drives it
    }
    if (!queued) found = Math.max(found, isRequiredType(type, t) ? 2 : 1);
  }
  return found;
}
// POST-BOSS DISCOVERY (objectiveGoalMode, boss-on-the-way model): the cleanup drivers only handle FOUND (queued) content;
// this handles the UNFOUND-but-listed case (an unexplored breach). Nothing to path to yet, so REVEAL the map: steer toward
// genuinely unexplored ground (pickUnexploredHeading carries its own anti-yoyo + walled-bucket blacklist) until the content
// streams in -> then it's queued and the cleanup drives it. The boss is DEAD here, so there is nothing to avoid and no fight
// this can hold hostage. HARD-BOUNDED: concede (latch discoverConceded) when the explore window is spent OR no frontier left.
function tryDiscoverListedContent(player, now) {
  MB.set('nav', 5);   // discover is exploration: it must never outrank a live content walk
  if (!objGoalOn() || !player) return false;                                 // master OFF -> no-op (flag-off parity)
  if (currentState !== STATE.MAP_COMPLETE) return false;                     // post-boss cleanup only
  if (discoverConceded) return false;                                        // already gave up this map
  if (nearestOutstandingRequiredContent(player, now)) return false;          // a KNOWN drivable required objective owns the frame -- never explore AWAY from it (its short ban expiring hands it back to the cleanup)
  const _unfound = hasUnfoundListedContent(now);                             // 0 none / 1 optional / 2 required
  if (!_unfound) { discoverExploreSince = 0; discoverLastHeadingAt = 0; discoverTgtX = NaN; return false; }   // nothing listed-but-unfound (or it's now queued -> cleanup owns it)
  if (discoverExploreSince === 0) discoverExploreSince = now;
  // OPTIONAL-only unfound gets a SHORT window: the game lists e.g. a Breach row on maps where none actually spawned
  // (the incomplete-bit means "possible", not "present"), so a long hunt on a phantom just burns the map's tail.
  const _discWindow = _unfound === 2 ? DISCOVER_EXPLORE_MS : 40000;
  const _discElapsed = now - discoverExploreSince;
  if (_discElapsed > _discWindow) {
    // SOFT window spent (user: 'you don't timeout, you EXPLORE'): concede ONLY when the map has no ROUTABLE
    // unexplored expanse left -- exploration terminates on MAP COVERAGE, not on a clock. A hard 3-minute tail
    // cap remains the anti-trap bound.
    const _more = pickRouteNearestBucket(player, now);
    if (_discElapsed > 180000 || !_more || !Number.isFinite(_more.x)) { discoverConceded = true; return false; }
  }
  // STICKY TARGET: keep walking to the COMMITTED bucket until reached (<60u) or no-closer for 9s. Re-consulting the picker
  // every pass yoyos -- walking toward a bucket reveals it, the picker re-picks, and with no boss bias the next pick can be
  // the opposite side of the map.
  const dT = Number.isFinite(discoverTgtX) ? Math.hypot(discoverTgtX - player.gridX, discoverTgtY - player.gridY) : NaN;
  if (Number.isFinite(dT) && dT < discoverBestD - 20) { discoverBestD = dT; discoverProgAt = now; }
  if (!Number.isFinite(discoverTgtX) || dT < 60 || now - discoverProgAt > 9000) {
    // STALLED (9s without closing, NOT reached): the fog-crawl can't reach that bucket now -> BLACKLIST it in the picker
    // so the next pick can't flip back to it (the A->B->A sweep yoyo); the sweep converges on the reachable remainder.
    if (Number.isFinite(discoverTgtX) && dT >= 60) {
      _unexpFailed.set(Math.round(discoverTgtX / 64) + ':' + Math.round(discoverTgtY / 64), now + 180000);
      log(`[Discover] bucket (${Math.round(discoverTgtX)},${Math.round(discoverTgtY)}) stalled -> blacklist + next`);
    } else if (Number.isFinite(discoverTgtX)) {
      // REACHED: CONSUME the bucket (short ban) so the picker moves ON. Without this, standing inside the 60u ring
      // re-picks every pass, and two near-equidistant buckets ping-pong the walk A->B->A instead of sweeping.
      _unexpFailed.set(Math.round(discoverTgtX / 64) + ':' + Math.round(discoverTgtY / 64), now + 60000);
    }
    // MARKER-FIRST: some content keeps a GLOBAL quest/minimap marker even when unstreamed (hive covers proven;
    // breach/abyss/incursion often do). Walking straight to the marker beats blind fog-reveal -- and it survives a
    // mapper RESTART, where the queue forgot the content's position but the marker didn't. Stalled markers get the
    // same bucket-key ban as everything else, so an unreachable one falls through to the fog/patrol explore.
    let h = null;
    try {
      const _unfoundTypes = new Set();
      for (const objName in OBJ_DRIVABLE) {
        const _ty = OBJ_DRIVABLE[objName];
        if (!mapObjectiveExists(objName, now) || mapObjectiveComplete(objName, now)) continue;
        if (!objDriveEnabled(_ty) && !isRequiredType(_ty, now)) continue;
        let _q = false;
        for (const [, qe] of contentQueue) { if (qe && qe.state === 'active' && (CQTYPE_TO_DRIVE[qe.type] || qe.type) === _ty) { _q = true; break; } }
        if (!_q) _unfoundTypes.add(_ty);
      }
      const _MRX = { breach: /Breach|Brequel/i, breach2: /Brequel/i, abyss: /Abyss/i, verisium: /Expedition2|Verisium/i, incursion: /Incursion|Vaal/i };
      let _bm = null, _bd = Infinity;
      for (const m of (poe2.getQuestMarkers() || [])) {
        const mx = m.gridX || 0, my = m.gridY || 0;
        if (!mx && !my) continue;
        for (const _ty of _unfoundTypes) {
          const rx = _MRX[_ty];
          if (!rx || !rx.test(m.path || '')) continue;
          if ((_unexpFailed.get(Math.round(mx / 64) + ':' + Math.round(my / 64)) || 0) > now) continue;
          const d = Math.hypot(mx - player.gridX, my - player.gridY);
          if (d > 120 && d < _bd) { _bd = d; _bm = { x: mx, y: my, ty: _ty }; }   // >120: markers <120u are breadcrumbs along a trail (abyss cracks) -- striding them 1-by-1 was the jitter-walk
        }
      }
      if (_bm) { h = { x: _bm.x, y: _bm.y }; log(`[Discover] ${_bm.ty} marker at (${Math.round(h.x)},${Math.round(h.y)}) -> walking straight to it`); }
    } catch (_) {}
    if (!h || !Number.isFinite(h.x)) h = pickRouteNearestBucket(player, now);
    if (!h || !Number.isFinite(h.x)) {
      // NO FOG FRONTIER but content still unfound: entities stream at ~100u while fog reveals much farther, so on a
      // revealed (or re-entered) map the content can sit in revealed-but-never-WALKED ground. PATROL: rotate far
      // spokes around the player so the walk passes through unwalked ground until it streams in. Reuses the sticky-
      // target walk + stall-blacklist below; bounded by the same explore window + concede latch.
      _discPatrolAng += 1.7;
      const _pk = { x: player.gridX + Math.cos(_discPatrolAng) * 350, y: player.gridY + Math.sin(_discPatrolAng) * 350 };
      if ((_unexpFailed.get(Math.round(_pk.x / 64) + ':' + Math.round(_pk.y / 64)) || 0) <= now) {
        h = _pk;
        log(`[Discover] no fog frontier -> patrol spoke toward (${Math.round(h.x)},${Math.round(h.y)})`);
      } else {
        // Only a SUSTAINED no-heading window (~8s) concedes -- a transient miss must NOT latch.
        if (discoverLastHeadingAt === 0) discoverLastHeadingAt = now;
        if (now - discoverLastHeadingAt > 8000) discoverConceded = true;
        return false;                                                        // miss -> retry next pass (no hold)
      }
    }
    discoverLastHeadingAt = now;
    // DEAD-BOSS-ARENA exclusion: content never spawns in the arena -- exploring into it just paces the boss room.
    const _bax = (Number.isFinite(mapCompleteBossDeathX) && mapCompleteBossDeathX) ? mapCompleteBossDeathX
      : (Number.isFinite(bossArenaCacheX) ? bossArenaCacheX : NaN);
    const _bay = (Number.isFinite(mapCompleteBossDeathY) && mapCompleteBossDeathY) ? mapCompleteBossDeathY
      : (Number.isFinite(bossArenaCacheY) ? bossArenaCacheY : NaN);
    if (Number.isFinite(_bax) && Math.hypot(h.x - _bax, h.y - _bay) < 200) {
      _unexpFailed.set(Math.round(h.x / 64) + ':' + Math.round(h.y / 64), now + 600000);
      log(`[Discover] bucket (${Math.round(h.x)},${Math.round(h.y)}) is the boss arena -> excluded`);
      discRouteAt = 0; discRouteBest = null;   // drop the 2.5s pick cache -- it re-served the banned bucket twice
      return false;                                                          // next pass picks elsewhere
    }
    discoverTgtX = h.x; discoverTgtY = h.y; discoverBestD = Infinity; discoverProgAt = now;
    log(`[Discover] listed content unfound -> exploring toward (${Math.round(h.x)},${Math.round(h.y)}) to reveal it`);
  }
  if ((targetName !== 'Content Discover' || Math.hypot(targetGridX - discoverTgtX, targetGridY - discoverTgtY) > 60 || currentPath.length === 0) && now - lastRepathTime > 1500) {
    startWalkingTo(discoverTgtX, discoverTgtY, 'Content Discover', 'boss');
  }
  const _dstep = stepPathWalker();
  // FRONTIER CRAWL (user: 'pick a BIG chunk and GO there'): the fog-gated path dead-ends at the dark edge
  // ('Terrain path: 2 wp') while the bucket sits beyond it -- the walk stopped closing, the 9s stall banned the
  // bucket, and the next pick flipped direction = the yoyo. When the path runs dry short of the target, HOP the
  // fog frontier ALONG THE SAME BEARING (boss-explore's crawl) so the reveal keeps pushing INTO the expanse; the
  // stall clock keeps ticking only if even the crawl stops closing.
  if ((_dstep === 'arrived' || currentPath.length === 0) && Number.isFinite(discoverTgtX)
      && Math.hypot(discoverTgtX - player.gridX, discoverTgtY - player.gridY) > 60 && now - lastRepathTime > 900) {
    const _fh = frontierTowardTarget(player.gridX, player.gridY, discoverTgtX, discoverTgtY);
    if (_fh && Number.isFinite(_fh.x)) startWalkingTo(_fh.x, _fh.y, 'Content Discover', 'boss');
  }
  statusMessage = `Cleanup: exploring for unfound content`;
  return true;                                                               // HOLD in MAP_COMPLETE -- reveal the map before leaving
}

function runContentRotation(player, now, skipRares = false) {
  if (!player) return false;
  MB.set('content', 3);
  if (!skipRares && currentSettings.clearRares !== false && runClearNearbyRares(player, now)) return true;
  // USER ORDER (current remnant -> breach -> rest): a Verisium remnant we've REACHED and are working (clearing /
  // opened / fighting / looting) is FINISHED before yielding to a touched breach -- never abandon a remnant mid-open.
  // exp2ClearAt>0 = reached (clearing / about-to-open); awaitpick|fighting|loot = opened. A remnant we're only
  // WALKING toward ('walk' && exp2ClearAt==0) stays BELOW the breach (re-engaged by the lower block after it).
  // B1 fix: these early-returns used to skip the rotLockedType assignment below, leaving a STALE lock that could
  // force a suboptimal pick when the breach/remnant finished. Set the lock to what we're actually handling.
  const exp2Committed = exp2Phase !== 'idle' && (exp2Phase !== 'walk' || exp2ClearAt > 0);
  if (exp2Committed && runExpedition2(player, now)) { rotLockedType = 'verisium'; return true; }
  // an ACTIVE breach roams off the CACHED center (the Brequel despawns on activation) -- entity-independent
  if (rotBreachActivatedAt && runBreachRoam(player, now)) { rotLockedType = 'breach'; return true; }
  // a Verisium remnant we're still WALKING toward -- below the breach, so a live (time-limited) breach goes first;
  // after the breach this re-engages the remaining remnants so the PILE is finished, not abandoned.
  if (exp2Phase !== 'idle' && runExpedition2(player, now)) { rotLockedType = 'verisium'; return true; }
  const cands = [];
  {
    // Legacy singular-finder rotation (the ARBITER supersedes this when ARBITER=true, driving from contentQueue instead).
    // GATE on the base-game objective completion (the Map Content [x]) -- never re-attempt completed content.
    const brDone = mapObjectiveComplete('Breach', now), delDone = mapObjectiveComplete('Delirium', now), abyDone = mapObjectiveComplete('Abyss', now);
    // FORCE-THROUGH (user 2026-07-03): a REQUIRED map objective is engaged even with its clear* toggle OFF. objGoalOn()-
    // gated so flag-off is byte-parity. (The !brDone/!abyDone completion guards below still hold -- a DONE objective is
    // never re-attempted, forced or not.)
    const _fr2 = objGoalOn();
    const _rInc    = currentSettings.clearIncursion !== false        || (_fr2 && isRequiredType('incursion', now));
    const _rBreach = currentSettings.clearBreach === true            || (_fr2 && isRequiredType('breach', now));
    const _rAbyss  = currentSettings.clearAbyss !== false            || (_fr2 && isRequiredType('abyss', now));
    const _rVeri   = currentSettings.clearVerisiumRemnants !== false || (_fr2 && isRequiredType('verisium', now));
    // Incursion is NOT gated on the whole-map Incursion [x] -- that objective is a single 0/1 but a map can have
    // MULTIPLE encounters (2 pedestals etc). Drive off the PER-encounter minimap done-flag instead (getIncursionBeacons
    // / getUnopenedVaalChests already filter on minimapDoneOf), so a 2nd ACTIVE beacon isn't blocked by the 1st flipping
    // the objective done. When every encounter reads done those return empty -> the bot stops on its own.
    if (_rInc)        { const c = nearestUnopenedChest(player, now); if (c) cands.push({ d: c._d, type: 'incursion-chest', run: () => runIncursionChestRun(player, now) }); }
    if (_rInc)        { const vb = nearestIncursionBeacon(player, now); if (vb) cands.push({ d: vb._d, type: 'incursion-beacon', run: () => runIncursionBeaconRun(player, now) }); }
    if (currentSettings.deliriumMirrorEnabled !== false && CONTENT_POLICY.delirium.enabled !== false && !delDone) { const p = nearestDeliriumPiece(player);       if (p) cands.push({ d: p.d,  type: 'delirium', run: () => runDelirium(player, now, p) }); }
    if (_rBreach && !brDone)            { const b = nearestBreachPoint(player, now);    if (b) cands.push({ d: b._d, type: 'breach', run: () => runWalkToBreach(player, now, b) }); }
    if (_rAbyss && !abyDone)            { const ab = nearestAbyssNode(player, now);      if (ab) cands.push({ d: ab._d, type: 'abyss', run: () => runAbyssRun(player, now) }); }
    // KEEP-ALIVE (audit fix -- HOISTED out of the !abyDone guard): when the LAST/only node clears AND the whole-map
    // Abyss[x] objective flips done in the SAME window, abyDone used to skip this branch -> runAbyssRun was never
    // re-dispatched -> the loot-dwell never fired + the reward chest was SKIPPED (the exact regression this prevents).
    // Keep dispatching runAbyssRun while a node is mid-loot-dwell (abyssId && abyssDwell), regardless of abyDone.
    if (_rAbyss && abyssId && abyssDwell && !cands.some(c => c.type === 'abyss')) cands.push({ d: 0, type: 'abyss', run: () => runAbyssRun(player, now) });
    if (_rVeri && !exp2RegularExpeditionPresentCached(now)) { const ex = exp2NearestRemnant(player, now); if (ex) cands.push({ d: ex._d, type: 'verisium', run: () => runExpedition2(player, now) }); }
  }
  if (!cands.length) { rotLockedType = null; return false; }
  // USER (2026-06-27): BALANCED value x distance, not strict-nearest. Objectives (breach/abyss/incursion/verisium) are
  // worth a long WALKABLE detour (~up to 550u) -- a slightly-farther high-value objective beats a near low-value one,
  // but a much-closer one still wins. LIGHT distance weight so we actually GO DO objectives. Verisium=time-limited->top.
  // Scores from CONTENT_POLICY value - dist*0.10 (balanced value×distance, not strict-nearest).
  for (const c of cands) c.score = ((CONTENT_POLICY[c.type] && CONTENT_POLICY[c.type].value) || 60) - (c.d || 0) * 0.10;
  const near = cands.filter(c => (c.d || 0) <= 550);   // beyond this -> leave it until we explore closer (don't trek the whole map)
  const pool = near.length ? near : cands;             // but if EVERY objective is far, still take the best (don't stall)
  pool.sort((a, b) => b.score - a.score);
  // CONTENT LOCK: once engaged in a type, STICK to it until it leaves the list (done) -- the legacy rotLockedType.
  let pick = rotLockedType ? pool.find(c => c.type === rotLockedType) : null;
  if (!pick) pick = pool[0];
  rotLockedType = pick.type;
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
// PERF (2026-07-02): exp2RegularExpeditionPresent is a full-slab lightweight ReadEntity scan that, on any non-Dannig map,
// falls PAST its cheap mapObjectiveExists short-circuit and scans every entity. Whether a REAL Expedition exists cannot
// change mid-map, so a 5s cache removes one of the two heaviest scans from almost every populate/rotation call.
let _exp2RegPresent = false, _exp2RegAt = 0;
function exp2RegularExpeditionPresentCached(now) {
  if (now - _exp2RegAt < 5000) return _exp2RegPresent;
  _exp2RegAt = now;
  try { _exp2RegPresent = exp2RegularExpeditionPresent(now); } catch (e) { _exp2RegPresent = false; }
  return _exp2RegPresent;
}
function populateContentQueue(player, now) {
  if (!player) return;
  // PERF (2026-07-02): the 6 finders are full-slab getEntities scans (2 are UNCAPPED no-name lightweight = the biggest).
  // ARBITER off: nothing consumes contentQueue urgently while revealing toward the boss (only the 1/s HUD count + the
  // throttled arbiter shadow read it). Back OFF hard during FINDING_BOSS; stay responsive (800ms) near/at content.
  const _cqInterval = (currentState === STATE.FINDING_BOSS) ? 3000 : 800;
  if (now - _cqLastPopAt < _cqInterval) return;
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
      // Phase 0: a COMPLETED instance must NOT revert to active on re-stream (blacklist TTL can expire + the entity
      // streams back) -- keep it completed so the count is stable and (flag-on) it isn't re-attempted.
      if (e.state === 'completed') { /* stay completed */ }
      else if (e.state !== 'engaged') e.state = 'active';
    }
  };
  // FORCE-THROUGH (user 2026-07-03): a REQUIRED map objective's finder runs even if its clear* toggle is OFF, so a forced
  // incursion/breach/etc. still enters the queue for the (objGoalOn-gated) revisit/cleanup to drive. Gated on objGoalOn()
  // so flag-off queue contents stay byte-identical (flag-off nothing but the 1/s HUD reads the queue anyway).
  const _fr = objGoalOn();
  const _wantAbyss  = currentSettings.clearAbyss !== false            || (_fr && isRequiredType('abyss', now));
  const _wantVeri   = currentSettings.clearVerisiumRemnants !== false || (_fr && isRequiredType('verisium', now));
  const _wantInc    = currentSettings.clearIncursion !== false        || (_fr && isRequiredType('incursion', now));
  const _wantBreach = currentSettings.clearBreach === true            || (_fr && isRequiredType('breach', now));
  try { if (_wantAbyss)  for (const n of (getAbyssNodes(now) || []))        upsert('abyss', n.id, n.gridX, n.gridY, n.address); } catch (e) {}
  try { if (_wantVeri && !exp2RegularExpeditionPresentCached(now)) for (const r of (exp2Remnants(now) || [])) {
    // PHANTOM GUARD (the verisium:17 queue explosion mid-encounter): only the real STONE path, and never a second
    // "remnant" within 40u of an already-queued one (wave pieces spawn ON the stone and matched the loose filter --
    // the arb then committed phantoms while the runner fought the real encounter).
    if (!/Expedition2Encounter/i.test(r.name || '')) continue;
    let _dup = false;
    for (const [, q] of contentQueue) {
      if (q && q.type === 'verisium' && q.id !== r.id && Math.hypot((q.gridX || 0) - (r.gridX || 0), (q.gridY || 0) - (r.gridY || 0)) < 40) { _dup = true; break; }
    }
    if (_dup) continue;
    upsert('verisium', r.id, r.gridX, r.gridY, r.address);
  } } catch (e) {}
  try { if (_wantInc)    for (const c of (getUnopenedVaalChests(now) || [])) upsert('incursion-chest', c.id, c.gridX, c.gridY, c.address); } catch (e) {}
  try { if (_wantInc)    for (const b of (getIncursionBeacons(now) || []))   upsert('incursion-beacon', b.id, b.gridX, b.gridY, b.address); } catch (e) {}
  try { if (_wantBreach) { const b = nearestBreachPoint(player, now); if (b) upsert('breach', b.id, b.gridX, b.gridY, b.address); } } catch (e) {}
  // BREACH HIVES (Breach2): GLOBAL SpawnerCover quest-markers -> every hive node is routable before it streams (like the
  // terrain beacons). Marker-keyed position ids; the prune below completes an entry whose marker has cleared.
  const _wantHive = currentSettings.clearBreach === true || (_fr && isRequiredType('breach2', now));
  try {
    if (_wantHive && mapObjectiveExists('Breach2', now) && !mapObjectiveComplete('Breach2', now)) {
      for (const h of (getBreachHives(now) || [])) upsert('breach2', 'hive-' + (Math.round(h.x / 12) + 'x' + Math.round(h.y / 12)), h.x, h.y, 0);
    }
  } catch (e) {}
  // TERRAIN Vaal Beacons (fog-independent): add FAR/unstreamed beacons from the map-generation TGT so the bot can route
  // to every required beacon before it streams in. Position-keyed (id 'tgt-gxXgy') + skip a cluster already covered by a
  // live entity beacon (<=60u) -- the streamed entity is authoritative (carries the numeric id + live done-detection).
  let _terrBeacons = [];
  try {
    if (_wantInc) {
      scanEnergisedBeacons(now);                                    // record any streamed done pedestal -> sticky registry (de-stream-proof)
      _terrBeacons = discoverTerrainBeacons(now) || [];
      const _liveB = [];
      for (const e of contentQueue.values()) if (e.type === 'incursion-beacon' && typeof e.id === 'number' && e.id && e.state === 'active') _liveB.push(e);
      for (const c of _terrBeacons) {
        if (_liveB.some(b => Math.hypot(b.gridX - c.x, b.gridY - c.y) <= 60)) continue;   // covered by a streamed entity beacon
        upsert('incursion-beacon', 'tgt-' + (Math.round(c.x / 12) + 'x' + Math.round(c.y / 12)), c.x, c.y, 0);
      }
    }
  } catch (e) {}
  const _terrReadable = _terrBeacons.length > 0;   // terrain read succeeded this frame -> safe to prune stale terrain beacons
  // DONE / prune pass. Refreshed-this-frame entries stay active. NOT-seen entries: mark done ONLY via id-keyed safe
  // signals (no address reads on possibly-freed entities); else PERSIST (the flag-on-spot point).
  const _srcOf = { verisium: 'exp2Done', 'incursion-chest': 'incRecentlyDone', 'incursion-beacon': 'incBeaconBL', abyss: 'abyssBL', breach: 'mapObj-Breach' };
  for (const [key, e] of contentQueue) {
    if (objectiveTypeComplete(e.type, now)) { contentQueue.delete(key); continue; }   // whole objective COMPLETE -> drop stale entries (verisium loot-rune bloat: fixes counter/markers/yoyo)
    // BEACON energised (sticky registry, de-stream-proof) -> PERSIST as completed (counts as done, never re-offered/revisited).
    if (e.type === 'incursion-beacon' && isBeaconEnergisedAt(e.gridX, e.gridY)) {
      if (e.state !== 'completed') { e.state = 'completed'; e.completedAt = now; e.completionSource = 'energised'; }
      continue;
    }
    // TERRAIN beacon (string 'tgt-' id) NOT re-discovered this frame while terrain WAS readable -> terrain re-read
    // dropped it (energised beacons are handled above) -> delete (no live entity/blacklist backs it, so it can't self-prune).
    if (e.type === 'incursion-beacon' && typeof e.id === 'string' && !seen.has(key) && _terrReadable) { contentQueue.delete(key); continue; }
    // HIVE whose marker has CLEARED (healthy scan, no active SpawnerCover within 45u) -> that node is DONE; persist as
    // completed (stable count, never re-offered). Scan-failed (null) -> leave untouched.
    if (e.type === 'breach2' && e.state !== 'completed') {
      const _hs = getBreachHives(now);
      if (_hs && !_hs.some(h => Math.hypot(h.x - e.gridX, h.y - e.gridY) < 45)) {
        e.state = 'completed'; e.completedAt = now; e.completionSource = 'markerGone';
        log(`[Hive] Breach Hive (${Math.round(e.gridX)},${Math.round(e.gridY)}) marker cleared -> completed`);
      }
      continue;
    }
    if (seen.has(key)) continue;
    let done = false;
    try {
      if (e.type === 'verisium')              done = (exp2Done.get(e.id) || 0) > now;
      else if (e.type === 'incursion-chest')  done = (incursionRecentlyDone.get(e.id) || 0) > now;
      else if (e.type === 'incursion-beacon') done = (incBeaconBlacklist.get(e.id) || 0) > now;
      else if (e.type === 'abyss')            done = (abyssBlacklist.get(e.id) || 0) > now;   // per-NODE (parallels incursion); whole-map Abyss[x] would prune a still-active far node on multi-node maps
      else if (e.type === 'breach')           done = mapObjectiveComplete('Breach', now);     // singular finder / single-instance -> whole-map is fine (matches the rotation's !brDone gate)
    } catch (er) {}
    // Phase 0 (counts): PERSIST the completed instance instead of deleting, so discovered/completed survives the whole
    // map. ARBITER off, nothing but the 1/s HUD counts + throttled arbiter-shadow reads contentQueue -> behavior-parity.
    if (done) {
      if (e.state !== 'completed') { e.state = 'completed'; e.completedAt = now; e.completionSource = _srcOf[e.type] || e.type; }
      continue;
    }
    if (e.state !== 'completed' && now - e.lastSeenAt > 600000) contentQueue.delete(key);   // 10min stale: active-only (completed persist to map end)
  }
  // TERRAIN<->ENTITY beacon dedup: once a real entity beacon exists, drop the coincident terrain placeholder (the entity
  // is authoritative -- numeric id + live done-detection). Keeps ONE queue entry + ONE radar marker + ONE route per beacon.
  try {
    const _numB = [];
    for (const e of contentQueue.values()) if (e.type === 'incursion-beacon' && typeof e.id === 'number' && e.id) _numB.push(e);
    if (_numB.length) for (const [key, e] of contentQueue) {
      if (e.type === 'incursion-beacon' && typeof e.id === 'string' && _numB.some(b => Math.hypot(b.gridX - e.gridX, b.gridY - e.gridY) <= 60)) contentQueue.delete(key);
    }
  } catch (e) {}
  if (now - _cqLogAt > 5000) {
    _cqLogAt = now;
    // ACTIVE (incomplete) only: completed entries now persist for the counts, so log the active set -> goes quiet once cleared.
    const by = {}; let _actN = 0;
    for (const e of contentQueue.values()) if (e.state !== 'completed') { by[e.type] = (by[e.type] || 0) + 1; _actN++; }
    if (_actN) log(`[Queue] ${_actN} active: ${Object.entries(by).map(([k, v]) => k + ':' + v).join(' ')}`);
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

// PRESS-IN-TO-ACTIVATE: "boss is mid-action". Resolves to the FULL action entity (lightweight snapshot has no Actor
// telemetry) then treats the boss as acting if EITHER a named non-locomotion action is present OR any action has time
// remaining. The remaining>0 arm closes the dive/"Move"-named blind spot that a name-only check would walk us into.
function bossIsActing(entity, nowMs) {
  if (!entity) return false;
  const a = resolveBossActionEntity(entity, nowMs) || entity;
  // GENUINELY IDLE = no active action AND no action type: then animCtrlRemaining is just the IDLE-LOOP animation's
  // remaining, NOT a real action. Reading that as "acting" dead-gates press-in-to-activate, so a DORMANT boss (idle,
  // full HP) is never approached and the fight orbits at range forever. An idle-loop is not an action.
  if (!a.hasActiveAction && (Number(a.currentActionTypeId) || 0) === 0) return false;   // covers undefined too -- the resolved action entity often omits the flag while idle
  const remaining = getEntityActionRemainingSec(a);
  if (Number.isFinite(remaining) && remaining > 0.05) return true;   // any in-progress action (incl. dives named "Move")
  const act = (a.actionSkillName || a.currentActionName || a.animationName || '').toLowerCase();
  return !!a.hasActiveAction && !!act &&
    act !== 'move' && act !== 'walk' && act !== 'run' && act !== 'idle';
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
let _unexpTrackPX = 0, _unexpTrackPY = 0;   // player pos at track start (local-jam vs walled-bucket discrimination)
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
  // STICKY COMMIT (anti-yoyo, 2026-07-03): KEEP the bucket we already committed to as long as it's still unexplored +
  // reachable + not blacklisted. Re-scoring every 2s between 2-3 similar-score far buckets is exactly the (865)<->(1072)
  // explore yoyo -- the bearing flips, so the 40u frontier hop flips. The progress guard below STILL blacklists + swaps a
  // committed bucket we can't actually close on (4s no-progress), so this can never strand the bot at a wall.
  let best = null;
  if (_unexpCache) {
    const ck = bkey(_unexpCache);
    const still = buckets.some(b => b && (b.count || 0) > 0 && bkey(b) === ck);
    const okDist = Math.hypot(_unexpCache.x - player.gridX, _unexpCache.y - player.gridY) >= 60;   // not yet reached
    const okBl = (_unexpFailed.get(ck) || 0) <= now;                                               // not blacklisted
    const okReach = !anyReachable || reachToward(_unexpCache.x, _unexpCache.y) >= 28;              // corridor still opens toward it
    if (still && okDist && okBl && okReach) best = { x: _unexpCache.x, y: _unexpCache.y };          // keep it committed
  }
  if (!best) best = pickBest();
  // PROGRESS GUARD (the "going nowhere" fix): if we're NOT getting closer to the chosen bucket over ~10s, it's walled off
  // from us -> blacklist it 60s and take the next REACHABLE bucket, so we explore where we CAN instead of lunging at a wall.
  if (best) {
    const key = bkey(best), d = Math.hypot(best.x - player.gridX, best.y - player.gridY);
    if (_unexpTrackKey !== key) { _unexpTrackKey = key; _unexpTrackBestD = d; _unexpTrackAt = now; _unexpTrackPX = player.gridX; _unexpTrackPY = player.gridY; }
    else if (d < _unexpTrackBestD - 45) { _unexpTrackBestD = d; _unexpTrackAt = now; }   // closing FOR REAL (45u) -> reset; slow wall-crawl (~1.5u/s) does NOT
    else if (now - _unexpTrackAt > 4000 && Math.hypot(player.gridX - _unexpTrackPX, player.gridY - _unexpTrackPY) < 12) {
      // LOCAL-JAM guard: the PLAYER hasn't moved at all -- the fault is local (wedged on geometry / movement failing),
      // NOT the bucket. Blacklisting here burned the ENTIRE bucket set in minutes (map-wide cascade) while jammed.
      _unexpTrackAt = now;                                     // keep the bucket; the walker's stuck machinery owns digging out
    }
    else if (!/Explore|Discover/.test(targetName || '')) {
      // OWNED-PROGRESS (commitment discipline): the walker belongs to a landmark/utility/content leg right now --
      // nobody is walking toward this bucket, so "no progress" means NOTHING. The wall-clock guard was banning a
      // dozen buckets in two minutes while the landmark walked elsewhere (the maze-map heading churn).
      _unexpTrackAt = now;
    }
    else if (now - _unexpTrackAt > 4000) {                                               // 2026-07-02: with the 40u crawl a reachable bucket closes the 45u reset well inside 4s -> not-approached-in-4s = walled; blacklist + swap sooner (halves yoyo dwell)
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

// ROUTE-NEAREST unexplored bucket (fog-independent): on a MAZE map the euclidean-nearest bucket is often behind a wall
// (or back in the boss room) while the true route loops the long way -- euclidean picking flips the sweep A->B->A.
// macroPathTo knows the whole tile graph from map load: pick the bucket with the SHORTEST ROUTE from the player, and a
// bucket the router can't reach at all is banned on the spot (no walk wasted probing it).
let discRouteAt = 0, discRouteBest = null;
function pickRouteNearestBucket(player, now) {
  if (now - discRouteAt < 2500) return discRouteBest;
  discRouteAt = now;
  discRouteBest = null;
  if (typeof poe2.getUnexploredBuckets !== 'function' || typeof poe2.macroPathTo !== 'function') {
    return (typeof pickUnexploredHeading === 'function') ? pickUnexploredHeading(player, now) : null;   // pre-rebuild fallback
  }
  let buckets = null;
  try { buckets = poe2.getUnexploredBuckets(8); } catch (_) { buckets = null; }
  if (!buckets || !buckets.length) return null;
  const cands = [];
  for (const b of buckets) {
    if (!b || (b.count || 0) <= 0) continue;
    const dE = Math.hypot((b.x || 0) - player.gridX, (b.y || 0) - player.gridY);
    if (dE < 60) continue;
    const key = Math.round((b.x || 0) / 64) + ':' + Math.round((b.y || 0) / 64);
    if ((_unexpFailed.get(key) || 0) > now) continue;
    cands.push({ x: b.x, y: b.y, dE, key, count: b.count || 0 });
  }
  // UNEXPLORED-MASS scoring (user: 'push the frontier, not graze it'): route-NEAREST crawled the revealed boundary
  // one adjacent bucket at a time (the straight-column march) instead of driving into the big black expanse where
  // content actually sits. Weight each candidate by the unexplored MASS around it (sum of bucket counts within
  // ~260u = its expanse), route the densest few, pick the best mass-per-travel ratio.
  for (const c of cands) {
    let m = 0;
    for (const o of cands) if (Math.hypot(o.x - c.x, o.y - c.y) < 260) m += o.count;
    c.mass = m;
  }
  cands.sort((a, c) => c.mass - a.mass);
  let bestScore = -Infinity;
  for (const c of cands.slice(0, 8)) {                     // cap the router calls (cheap tile Dijkstra, <=8 per 2.5s)
    let route = null;
    try { route = poe2.macroPathTo(Math.floor(player.gridX), Math.floor(player.gridY), Math.floor(c.x), Math.floor(c.y)); } catch (_) {}
    if (!route || route.length < 2) { _unexpFailed.set(c.key, now + 300000); continue; }   // unreachable BY THE GRAPH -> ban, never walk-probe it
    const score = c.mass / (route.length + 20);            // dense expanse wins; travel only discounts, never dominates
    if (score > bestScore) { bestScore = score; discRouteBest = { x: c.x, y: c.y }; }
  }
  return discRouteBest;
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

    // Explore hops are ~40u and trivially reachable (crawl clamp); if we can't move for ONE stuck window (~3s) the corridor
    // is dead -> abandon NOW and let pickUnexploredHeading/frontier re-pick a reachable hop (kills the ~9s yoyo dwell). Real
    // fight/objective targets keep the 3-strike tolerance so we don't prematurely drop a live boss/content target.
    const _exploreTgt = targetName === 'Boss Explore';
    if (stuckCount > 2 || (_exploreTgt && !_exploreBossDirect && stuckCount >= 1)) {   // Reviewer L1: a bearing-committed far arena legitimately takes >3s around fog -> keep the 3-strike for it, 1-strike only for blind/clamped hops
      log('Stuck on target -> abandoning + re-picking a different one');
      // physical dislodge burst: a truly WEDGED player otherwise abandons/re-picks forever without ever moving
      if (_exploreTgt) sendMoveAngleLimited(Math.random() * 360, Math.max(30, currentSettings.stuckMoveDistance || 40));
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
  if (!MB.gate()) return false;
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
  if (!clustered.length) return null;
  // MULTI-BEACON (2026-07-02): a map can have >1 Vaal Beacon (temple). Skip any cluster whose beacon is ALREADY energised
  // (a STREAMED IncursionPedestalEncounter within ~45u reads minimapDone), and return the NEAREST remaining cluster to the
  // player -- so after energising beacon 1 the bot routes to beacon 2 instead of re-picking a fixed clustered[0]. Far
  // (unstreamed) beacons have no pedestal in range -> treated as open (correct). All-appear-done -> fall back to nearest.
  const donePeds = [];
  try {
    const _n = Date.now();
    for (const e of (poe2.getEntities({ nameContains: 'IncursionPedestalEncounter', lightweight: false }) || [])) {
      if (e && /IncursionPedestalEncounter/i.test(e.name || '') && e.address && minimapDoneOf(e.address, _n)) {
        donePeds.push({ x: e.gridX, y: e.gridY });
      }
    }
  } catch (er) {}
  let px = 0, py = 0;
  try { const lp = POE2Cache.getLocalPlayer(); if (lp) { px = lp.gridX; py = lp.gridY; } } catch (e) {}
  const open = clustered.filter(c => !donePeds.some(d => Math.hypot(d.x - c.x, d.y - c.y) < 45));
  const pool = open.length ? open : clustered;   // all appear energised -> fall back to nearest (bit may lag / re-check)
  pool.sort((a, b) => (Math.hypot(a.x - px, a.y - py)) - (Math.hypot(b.x - px, b.y - py)));
  return pool[0] || null;
}

// ===== VAAL-BEACON STATE: single per-map SOURCE OF TRUTH, keyed by POSITION (survives de-stream) ================
// A Vaal Beacon is a fixed terrain location whose lifecycle is discovered(terrain) -> active -> energised(complete).
// The bug this fixes: the two old "done" signals both FORGET once you walk away -- (a) beaconArrivalDwell read the
// whole-map Incursion bit, a single 0/1 that only flips when ALL beacons are done (so beacon 1-of-3 never marked done);
// (b) terrain discovery only excluded a beacon while its pedestal was STREAMED. So an energised beacon de-streamed and
// re-appeared as active -> the bot walked back. FIX: `energisedBeacons` is a per-map STICKY list of {x,y} of beacons
// confirmed energised via a STREAMED pedestal's de-stream-proof done signal (minimapDone / isTargetable=false /
// blacklist). Once recorded it is permanent for the map -> discovery excludes it, the queue marks it complete, and the
// revisit/cleanup skip it, regardless of streaming. Reset per map in resetMapper.
let energisedBeacons = [];
let _energScanAt = 0;
function markBeaconEnergised(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (Math.abs(x) < 40 && Math.abs(y) < 40) return;                          // origin-junk guard
  if (energisedBeacons.some(b => Math.hypot(b.x - x, b.y - y) < 60)) return; // already recorded (same beacon)
  energisedBeacons.push({ x, y });
  log(`[Incursion] Vaal Beacon (${Math.round(x)},${Math.round(y)}) marked ENERGISED (sticky) -> ${energisedBeacons.length} done`);
}
function isBeaconEnergisedAt(x, y) {
  return energisedBeacons.some(b => Math.hypot(b.x - x, b.y - y) < 60);
}
// A Vaal Beacon's TRUE done signal = its IncursionPedestalEncounter QUEST-MARKER iconType (live-verified 2026-07-03,
// filtered by marker PATH so a coincidental TemplePortal(19)/AlvaIncursionWild(4) marker nearby isn't misread): 38 =
// ACTIVE (needs energising), 994 = ENERGISED (done). NOT e.isTargetable (ALWAYS false for the proximity-activated
// variant -> the false-positive that marked active beacons done) and NOT minimapIconDone (read false for both here --
// it lags). An UNKNOWN iconType is logged once + treated as ACTIVE, so we never skip a beacon we can't confirm done.
const VAAL_BEACON_ACTIVE_ICONS = new Set([38]);
const VAAL_BEACON_DONE_ICONS = new Set([994]);
const _beaconIconSeen = new Set();
// Scan the beacon QUEST MARKERS for the de-stream-proof done iconType and record their positions permanently. Throttled
// so the dwell loop + the queue populate share one scan. This is the ONLY place the sticky registry grows -- a positive
// DONE iconType only (never a heuristic), so it can't false-mark an active beacon done.
function scanEnergisedBeacons(now) {
  const t = now || Date.now();
  if (t - _energScanAt < 700) return;
  _energScanAt = t;
  try {
    for (const m of (poe2.getQuestMarkers() || [])) {
      if (!m || !/IncursionPedestalEncounter/i.test(m.path || '')) continue;
      if (VAAL_BEACON_DONE_ICONS.has(m.iconType)) { markBeaconEnergised(m.gridX, m.gridY); continue; }
      if (!VAAL_BEACON_ACTIVE_ICONS.has(m.iconType) && !_beaconIconSeen.has(m.iconType)) {
        _beaconIconSeen.add(m.iconType);
        log(`[Incursion] beacon marker iconType=${m.iconType} @(${Math.round(m.gridX)},${Math.round(m.gridY)}) UNKNOWN -> treated ACTIVE (confirm+add to DONE/ACTIVE set)`);
      }
    }
  } catch (er) {}
}

// ===== TERRAIN VAAL-BEACON DISCOVERY (fog-INDEPENDENT) =========================================================
// Vaal Beacons are the ONLY content whose position is baked into the map-generation terrain (getTgtLocations
// WaygateDevice tiles) -- so we can know EVERY beacon's coords, including FAR ones, BEFORE they stream in as entities.
// That lets the mapper route to each required beacon instead of exploring blind (abyss/breach/verisium are
// entity-spawned: NO terrain tiles, found only by the getEntities finders). getTgtLocations() is ~5.6ms with no
// game-side cache + the terrain is STATIC per map, so read at most 1/10s. Returns ALL beacon cluster centres (energised
// AND not) -- so every beacon stays in the queue for a correct discovered/done COUNT; the energised ones are marked
// complete + skipped for routing downstream (prune + eligibility, via the sticky registry). Entity<->terrain dedup
// happens at the populateContentQueue upsert/prune sites (the streamed entity is authoritative once present).
let _tgtBeaconCache = null, _tgtBeaconAt = 0;
function discoverTerrainBeacons(now) {
  const t = now || Date.now();
  if (_tgtBeaconCache && t - _tgtBeaconAt < 10000) return _tgtBeaconCache;
  let out = [];
  try {
    const tgt = poe2.getTgtLocations();
    if (tgt && tgt.isValid) {
      const tiles = [];
      for (const [name, positions] of Object.entries(tgt.locations)) {
        if (name.toLowerCase().includes(TEMPLE_TGT_PATTERN)) for (const p of positions) tiles.push({ x: p.x + 11.5, y: p.y + 11.5 });
      }
      if (tiles.length) {
        const clustered = clusterPositions(tiles, 100);
        out = clustered.filter(c => Math.abs(c.x) > 40 && Math.abs(c.y) > 40);   // ALL beacons (energised handled downstream)
      }
    }
  } catch (e) {}
  // Cache a non-empty result for the full 10s; retry an EMPTY one (terrain not ready on cold-start) in ~2s.
  _tgtBeaconCache = out; _tgtBeaconAt = out.length ? t : t - 8000;
  return out;
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
    // Pickit loot is a fast, time-sensitive grab -> bias it above plain chests so a nearby chest never
    // starves the loot next to it (the "walked right past loot to fail-open a strongbox" case).
    const lootBonus = c.type === 'loot' ? 20 : 0;
    const score = (c.priority || 0) + shrineBonus + lootBonus - (c.distance || 0) * distWeight;
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
    // Never treat a projectile / skill-daemon / visual effect as an openable -- e.g. a picked-up Eye of Winter
    // shrine spams "ShrineEyeOfWinterProj" projectiles that name-match "shrine" and yoyo the utility selector.
    const _en = (e.name || '').toLowerCase();
    if (_en.includes('projectil') || _en.includes('daemon') || _en.includes('/effect') || _en.includes('/vfx')) continue;
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
    // Ignore obvious visual-only shrine effects + projectiles/skill-daemons (Eye of Winter shrine spam etc.).
    if (path.includes('effect') || path.includes('vfx') || path.includes('decal') || path.includes('projectil') || path.includes('daemon')) continue;
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
  // PRECURSOR RELAY at long range (MAP_COMPLETE only): one per map, spawns at the dead boss, top value -- the
  // 320u sweep radius missed one parked across the arena. Pull it in from map-wide-ish range, top priority.
  if (currentState === STATE.MAP_COMPLETE) {
    try {
      for (const t of (getOpenableCandidatesForMapper(700) || [])) {
        if (!t?.entity) continue;
        const _rn = `${t.entity.renderName || t.entity.name || ''}`;
        if (!/precursor/i.test(_rn)) continue;
        if (t.entity.id && seenIds.has(t.entity.id)) continue;
        const dist = Math.hypot((t.entity.gridX || 0) - player.gridX, (t.entity.gridY || 0) - player.gridY);
        const c = {
          type: 'openable', id: t.entity.id || 0, x: t.entity.gridX, y: t.entity.gridY,
          priority: 40, distance: dist, source: 'opener',
          meta: { openableType: 'PrecursorRelay', name: 'Precursor Relay' }
        };
        if (c.id) seenIds.add(c.id);
        if (!isUtilityTargetIgnored(c)) out.push(c);
      }
    } catch (_) {}
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
    return { hasDefeatObjective: false, isCompleted: false, bossName: '', tokens: [], bossNames: [], tokensByName: [] };
  }
  const main = objectives.mainObjective;
  const text = `${main.text || ''}`;
  const lower = text.toLowerCase();
  // MULTI-BOSS: the main block lists ONE "Defeat X" line PER boss ("Defeat Akthi...\n Defeat Anundr...") and a line
  // VANISHES when that boss dies -- so every outstanding line is a live target, and bossNames[0] is the next primary.
  const bossNames = [], tokensByName = [];
  for (const ln of lower.split(/\n/)) {
    const m = ln.match(/\bdefeat\s+(.+)/);
    if (!m) continue;
    let bn = `${m[1] || ''}`.replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9,'\- ]+/g, ' ').trim();
    if (!bn) continue;
    bossNames.push(bn);
    tokensByName.push(bn.split(/[\s,]+/).map(t => t.trim()).filter(t => t.length >= 4 && t !== 'defeat'));
  }
  if (!bossNames.length) {
    return { hasDefeatObjective: false, isCompleted: !!main.isCompleted, bossName: '', tokens: [], bossNames: [], tokensByName: [] };
  }
  return {
    hasDefeatObjective: true,
    isCompleted: !!main.isCompleted,
    bossName: bossNames[0],       // primary target = first outstanding line
    tokens: tokensByName[0],
    bossNames,
    tokensByName
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
  // Match ANY outstanding "Defeat X" line -- a twin-boss arena has BOTH bosses live at once, and treating the second as
  // "not a likely map boss" dropped its track / excluded it from the melee pick.
  for (let i = 0; i < obj.bossNames.length; i++) {
    const bn = obj.bossNames[i];
    if (bn && (entityName.includes(bn) || bn.includes(entityName))) return true;
    const toks = obj.tokensByName[i] || [];
    if (!toks.length) continue;
    let hits = 0;
    for (const t of toks) if (entityName.includes(t)) hits++;
    if (hits >= (toks.length >= 3 ? 2 : 1)) return true;
  }
  return false;
}
// entity_actions reads this (LoF boss-exempt + the opt-in boss-target-priority) via a typeof-guarded global --
// module scope doesn't cross files, so without this export those checks are silently inert.
try { globalThis.isEntityLikelyMainObjectiveBoss = isEntityLikelyMainObjectiveBoss; } catch (_) {}

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
  // The portal gate re-opens the window (bounded extension) while unopened openables/loot remain in range, so
  // the sweep runs until the area is actually clean instead of a fixed timer.
  return (nowMs >= utilityStartAt && nowMs <= utilityEndAt) || nowMs <= mapCompleteUtilityExtendUntil;
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
    // Settle-window ONLY. During the content SWEEP the utility selector must stay OFF: it preempts the cleanup walk
    // (it runs before the switch) and its wide radius yanks the bot HUNDREDS of units off a required-objective walk
    // (then thrash-loops MAP_COMPLETE<->WALKING_TO_UTILITY). On-the-way chests/loot are the opener/pickit plugins'
    // job -- they handle close targets under the move-lock without stealing the mapper's goal.
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

// Pickit loot yield (user): the ONLY things that should stop the mapper stopping for pickit-eligible loot are
// active danger (boss fight / closing to melee) or a mid content-event override (verisium being ENGAGED, abyss
// loot-dwell, active breach, hive summon/defense, beacon-guardian hold). Mirrors the dodge-arming content set.
function lootYieldSuppressed(now) {
  if (currentState === STATE.FIGHTING_BOSS || currentState === STATE.WALKING_TO_BOSS_MELEE) return true;
  // ANY active verisium engagement (walk/awaitpick/fight/loot) -- a committed remnant we're approaching must be
  // FINISHED, not abandoned for a loot detour. exp2Phase==='idle' (deferred/not engaged) still allows on-path loot.
  if (exp2Phase !== 'idle') return true;
  if (abyssLootDwellAt > 0 && (now - abyssLootDwellAt < 15000)) return true;
  if (rotBreachActivatedAt > 0) return true;
  if (hiveDefStart > 0 || hiveKey !== null) return true;
  if (revisitBeaconKey !== null) return true;
  return false;
}

function tryStartUtilityNavigation(player, now, lootOnly = false) {
  if (!canInterruptForUtility()) return false;
  if (now - _lsActiveAt < 1500) return false;   // a loot sweep owns the movement -- one writer at a time
  // lootOnly (a REQUIRED objective is committed): still yield to pickit loot -- a quick grab never steals a
  // commitment the way a chest detour does -- but not while in danger / mid content-event.
  if (lootOnly && lootYieldSuppressed(now)) return false;
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
  const configuredLootRadius = Math.max(30, currentSettings.lootWalkRadius || 200);
  // Yield to pickit unless danger/override: collect loot up to the full configured radius in any nav state,
  // else (danger / content-event) 0 = don't detour for loot. No graduated boss-approach caps.
  const nearbyBossApproachLootCap = lootYieldSuppressed(now) ? 0 : configuredLootRadius;
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
  if (utilityActiveTarget && !isUtilityTargetIgnored(utilityActiveTarget) && (!lootOnly || activeIsLoot)) {
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
  const candidates = lootOnly ? getLootUtilityCandidates(player) : gatherUtilityCandidates(player);
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
  // Objective-wins does NOT apply once the post-boss cleanup has CONCEDED (mapCompleteCleanupDone): the "live"
  // objective was just ruled unreachable, and refusing openables against it livelocked the portal gate (the gate
  // holds for the openable, the selector refuses it, forever -- the 'NOT OPENABLE' boulder loop).
  if (selectedIsOpenable && !selectedIsShrine && !(currentState === STATE.MAP_COMPLETE && mapCompleteCleanupDone)) {
    const obj = hasLiveObjectiveNear(player, 600);
    if (obj) { logUtility(`Utility skip: openable -> live ${obj} objective in reach (objective wins)`, 'utility:skip:obj', 2000); return false; }
  }
  const findingBossSelectedCap = findingBossExploring
    ? (selectedIsOpenable ? Math.max(120, currentSettings.openableWalkRadius || 200) : (selectedIsShrine ? 95 : 65))
    : 45;
  // Allow wider shrine pickup radius during boss approach; openables during checkpoint/melee approach are
  // ON-THE-WAY only (80u) -- the old 200u cap let a strongbox yank the final boss approach 167u sideways.
  const selectedDistCap = selectedIsOpenable
    ? ((inCheckpointApproach || inMeleeApproach) ? 80 : Math.max(120, currentSettings.openableWalkRadius || 200))
    : (selectedIsLoot ? nearbyBossApproachLootCap : (selectedIsShrine ? Math.max(maxBossApproachUtilityDist + 60, 95) : maxBossApproachUtilityDist));

  // FAR BOSS DRIVE (user 'VERY STUCK'): a far committed boss goal (arena hint / boss-direct explore >250u out)
  // sets NONE of the bossObjectiveCommitted flags, so no cap applied -- a 160-200u openable detour every ~30s
  // turned a 3-minute arena walk into 8. While the walker's goal is a far boss target, openables shrink to
  // on-the-way range; loot keeps the configured radius (quick grabs); the rest is swept post-boss.
  // HIGH-VALUE openables (strongboxes, abyss/league chests, precursor relays) are exempt from the far-drive
  // cap -- an abyssal chest 150u behind must never be skipped for a boss walk; trash chests/jugs/urns stay capped.
  const _hvOpenable = selectedIsOpenable && (selected.meta?.openableType === 'Strongbox'
      || /strongbox|abyss|expedition|precursor|relay|league/i.test(`${selected.meta?.name || ''}`));
  if (currentState === STATE.FINDING_BOSS && selectedIsOpenable && !_hvOpenable
      && /^(Boss Arena Hint|Boss Explore|Boss Arena|Boss Room Anchor|Elite)$/.test(targetName || '')
      && Math.hypot(targetGridX - player.gridX, targetGridY - player.gridY) > 250
      && (selected.distance || Infinity) > (selectedIsShrine ? 95 : 80)) {
    logUtility(`Utility skip: openable ${Math.round(selected.distance || 0)}u off a far boss drive`, 'utility:skip:bossdrive', 2000);
    return false;
  }

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
  MB.set('utility', 4);
  if (!canRunUtilityState()) return false;
  // During MAP_COMPLETE, the window expiring must NOT guillotine an ACTIVE target mid-walk (a Precursor Relay
  // selected in the window's last moment was killed 0.4s in -> portal fired with the relay unopened). An active
  // target finishes through its own bounded machinery (arrival-dwell settle, 5s no-net-progress ban, no-path
  // threshold); the expired window only ends the state once no target is held, and gates NEW picks via
  // canInterruptForUtility as before.
  if (utilityResumeState === STATE.MAP_COMPLETE && !isMapCompleteUtilityWindow(now) && !utilityActiveTarget) {
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
  // Strongboxes get a LONGER loiter (user: min ~15s or until actually opened) -- guards spawn + the opener re-fires;
  // the 12s cap was banning boxes mid-open. The dodge stays armed through the hold.
  const _isStrongbox = utilityActiveTarget?.meta?.openableType === 'Strongbox' || /strongbox/.test(_utName);
  const utilitySessionMaxMs = (utilityResumeState === STATE.MAP_COMPLETE) ? 0 : (_isMonolith ? 5000 : (_isStrongbox ? 45000 : 12000));   // strongbox: walk + full guard event (28s hold) + drop settle

  // DON'T dump the area while Verisium/breach content is still being worked or PENDING nearby. This cap measures the
  // TOTAL utility session incl. content time, so after a long breach it would instantly fire and strand unopened
  // remnants (the "didn't open the pile" bug). exp2NearestRemnant is only probed once we're already over the cap
  // (short-circuited after the cheaper exp2Phase / breach checks). exp2 has its own per-remnant timeout as a backstop.
  if (utilitySessionMaxMs > 0 && utilitySessionStartTime > 0 && (now - utilitySessionStartTime) > utilitySessionMaxMs
      && !(exp2Phase !== 'idle' || rotBreachActivatedAt > 0 || exp2NearestRemnant(player, now))) {
    // USER "opener would yield so it blacklisted it before it could look": the opener fires within its OWN
    // maxDistance (80u) and holds the 'opener' movement lock while it opens/routes, but the mapper only WATCHES
    // for that yield inside the arrival gate (dist<=20u). A chest that we stop short of (large collision / walled
    // last cell) is being actively opened at ~50-80u, yet from out here the session-timeout can't see the yield
    // and it burns to the ceiling -> 'failed:timeout' BAN before the open lands. If the lock is held by opener/pickit
    // RIGHT NOW the target IS being serviced: give it a bounded grace window instead of blacklisting mid-open.
    // RECENCY window: the utility step only runs on UNLOCKED frames, so a live isMovementLocked() here is ALWAYS false
    // (the earlier instantaneous check was dead code -- verified). utilityLastServicedAt is stamped from the movement-lock
    // yield whenever opener/pickit holds the lock during a utility session; within 2.5s (> opener's 300ms cooldown, < its
    // 2s lock hold) => actively servicing this target from outside the 20u dwell gate -> grace, don't blacklist mid-open.
    const _servicing = (now - utilityLastServicedAt) < 2500;
    // Cap the total serviced session so a chest the opener keeps re-firing on (0xC0 walled retry) still gives up.
    if (_servicing && (now - utilitySessionStartTime) < (utilitySessionMaxMs + 4000)) {
      statusMessage = `Utility servicing ${(( now - utilitySessionStartTime)/1000).toFixed(1)}s`;
      return true;   // let stepPathWalker/dwell keep running; opener is actively working this target
    }
    const elapsed = now - utilitySessionStartTime;
    log(`Utility timeout after ${(elapsed / 1000).toFixed(1)}s, resuming ${utilityResumeState}`);
    // Serviced (opener/pickit touched it) -> mark handled (10min) so we don't re-select + re-yoyo; else failed:timeout.
    // COMMITMENT DISCIPLINE: a timeout while STILL CLOSING (low owned-no-progress) is a window problem, not an
    // unreachable target -- 30s ttl re-queues the strongbox/essence/chest; genuinely stuck keeps the long ban.
    if (utilityActiveTarget) {
      const _stillClosing = !_servicing && _utTrack.key === getUtilityTargetKey(utilityActiveTarget) && _utTrack.ownedMs < 4000;
      addIgnoredUtilityTarget(utilityActiveTarget, _servicing ? 'handled:opener-timeout' : 'failed:timeout', _stillClosing ? 30000 : undefined);
    }
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
    if (utilityArrivalWaitStart === 0) { utilityArrivalWaitStart = now; utilityLastYieldAt = 0; utilityYieldCount = 0; _sbChkAt = 0; _sbOpen = false; _sbOpenAt = 0; }   // T0.6: fresh dwell -> reset yield tracking + strongbox state
    const lock = POE2Cache.isMovementLocked();
    const gotYield = lock.locked && (lock.source === 'opener' || lock.source === 'pickit');
    const waitMs = now - utilityArrivalWaitStart;
    const isOpenable = utilityActiveTarget?.type === 'openable';
    const sourceCooldown = isOpenable ? getOpenerCooldownMs() : getPickitCooldownMs();
    // T0.6 DWELL-UNTIL-SETTLED (USER "stand still, don't abandon on the first touch"): count DISTINCT yields -- an essence
    // needs 3 touches, a loot pile drops N items. Don't leave on yield #1: HOLD until the yields SETTLE (no new one for
    // settleMs) after enough of them, OR a hard ceiling, OR (no yield at all) a short arrived-but-nothing timeout.
    if (gotYield && now - utilityLastYieldAt > 120) { utilityYieldCount++; utilityLastYieldAt = now; }
    // STRONGBOX EVENT HOLD (user): the CLICK only ACTIVATES the box -- it stays TARGETABLE until its guard wave
    // dies and it actually OPENS (targetable flips false / entity gone = the real "opened" marker). Leaving on
    // the click-yield walked away mid-event, and PLANTING here died to the on-open AoE: hold until OPEN (28s
    // cap), KITING a small ring around the box; then 3s drop-settle and the utility loot loop collects.
    if (_isStrongbox) {
      if (now - _sbChkAt > 500) {
        _sbChkAt = now;
        _sbOpen = true;   // gone/de-streamed reads as opened
        try { for (const _e of (poe2.getEntities({ lightweight: true, maxDistance: 90 }) || [])) {
          if (_e && _e.id === utilityActiveTarget.id) { _sbOpen = _e.isTargetable !== true; break; }
        } } catch (_) {}
      }
      if (!_sbOpen && waitMs < 28000) {
        const _kp = hiveKiteTarget(player, now, utilityActiveTarget.x, utilityActiveTarget.y, 16);
        if (now >= dodgeMoveSuppressUntil) moveTowardGridPos(player.gridX, player.gridY, _kp.x, _kp.y);
        statusMessage = `Strongbox: event running -- kiting (${(waitMs / 1000).toFixed(0)}s)`;
        return true;
      }
      if (_sbOpen && _sbOpenAt === 0) _sbOpenAt = now;
      if (_sbOpen && now - _sbOpenAt < 3000) {
        sendStopMovementLimited();
        statusMessage = `Strongbox: opened -- drops settling`;
        return true;
      }
      // falls through -> settle/ceiling finishes the target; loot selection takes the contents
    }
    const _nm = ((utilityActiveTarget && (utilityActiveTarget.name || utilityActiveTarget.path || utilityActiveTarget.openableType || utilityActiveTarget.metaName)) || '') + '';
    const isEssence = isOpenable && /essence|monolith/i.test(_nm);
    const minTouches = isEssence ? 3 : 1;
    const settleMs = isEssence ? 900 : 700;
    const ceilingMs = isEssence ? 4000 : Math.max(2500, sourceCooldown + 1200);
    const settled = utilityYieldCount >= minTouches && (now - utilityLastYieldAt) > settleMs;
    const noYield = utilityYieldCount === 0 && waitMs > Math.max(1200, sourceCooldown + 500);
    // Anti-guillotine: don't finish the dwell while pickit still has drops within its own reach -- the settle
    // window (700ms) is shorter than pickit's grab cadence, so a multi-item pile was being left after item #1
    // (and an opened chest's contents after the open). Bounded +20s past the ceiling.
    if ((settled || (waitMs > ceilingMs && utilityYieldCount > 0)) && waitMs < ceilingMs + 20000 && lootStillLeft(65)) {
      statusMessage = `Utility dwell: collecting drops (${(waitMs / 1000).toFixed(1)}s)`;
      return true;
    }
    if (settled || noYield || waitMs > ceilingMs) {
      const served = utilityYieldCount > 0;
      addIgnoredUtilityTarget(utilityActiveTarget, served ? ('handled:' + (lock.source || (isOpenable ? 'opener' : 'pickit'))) : 'handled:arrived', served ? 600000 : 45000);   // serviced -> 10min; arrived-but-nothing -> 45s retry
      utilityActiveTarget = null;
      utilityNoPathCount = 0;
      utilityArrivalWaitStart = 0;
      utilityLastYieldAt = 0; utilityYieldCount = 0;
      utilitySessionStartTime = 0;
      utilityLastProgressDist = Infinity;
      utilityLastProgressTime = 0;
      finishUtilityState();
    }
    statusMessage = `Utility ${isEssence ? 'essence ' : ''}dwell y${utilityYieldCount} (${dist.toFixed(0)}u)`;
    return true;
  }

  // ANTI-YOYO (USER: walled Trunk) under the COMMITMENT DISCIPLINE: unreachable = 5s of no net progress measured
  // ONLY on frames where WE owned the walk (our target name, no dodge suppression; locked frames never reach here).
  // A pickit auto-walk yank / dodge / stolen walk pauses the clock instead of feeding the ban -- an Irradiated
  // Tablet was banned 10min because pickit dragged the player backward mid-walk. Loot failures also ban SHORT
  // (90s): drops are transient obstacles, not walled chests.
  const _utOwned = (targetName === `Utility ${utilityActiveTarget.type}` || targetName === 'Utility Detour')
    && now >= dodgeMoveSuppressUntil;
  const _utNoProg = trackOwnedProgress(_utTrack, getUtilityTargetKey(utilityActiveTarget), dist, _utOwned, now);
  if (_utNoProg > 5000 && (now - utilityLastServicedAt) >= 2500) {
    log(`Utility ${utilityActiveTarget.type} unreachable (owned no-progress 5s at ${dist.toFixed(0)}u) -> blacklist + skip`);
    addIgnoredUtilityTarget(utilityActiveTarget, 'failed:no-net-progress', utilityActiveTarget.type === 'loot' ? 90000 : undefined);
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
  const noProgressTooLong = _utNoProg > 4200;   // owned-frames only (commitment discipline)
  if (noProgressTooLong) {
    addIgnoredUtilityTarget(utilityActiveTarget, 'failed:no-progress', utilityActiveTarget.type === 'loot' ? 90000 : undefined);
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

  // Collect every candidate passing the filters once (approach-candidate + anchor leash + range).
  const cands = [];
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
    if (distSq <= maxDistSq) cands.push({ e, distSq });
  }
  if (!cands.length) return null;

  // IN COMBAT WINS (overrides stickiness): a boss already fighting us (damaged, or running a real action) IS the
  // target -- no more walking toward a farther trigger point; fight the one that's engaged. Nearest engaged first.
  const engaged = cands.filter(c =>
    (Number.isFinite(c.e.healthCurrent) && Number.isFinite(c.e.healthMax) && c.e.healthCurrent < c.e.healthMax)
    || (c.e.hasActiveAction === true && (Number(c.e.currentActionTypeId) || 0) !== 0));
  if (engaged.length) { engaged.sort((a, b) => a.distSq - b.distSq); return engaged[0].e; }

  // Keep existing candidate when possible to avoid target thrash.
  if (bossCandidateId) {
    for (const c of cands) if (c.e.id === bossCandidateId) return c.e;
  }

  // MULTI-BOSS map (2+ outstanding "Defeat X" lines) with 2+ objective bosses streamed and DORMANT: walk to the
  // FARTHEST one -- the route crosses the arena middle and proximity-wakes every boss on the way, so both get
  // triggered without any special activation logic.
  try {
    const obj = getMainDefeatObjectiveInfo();
    if (obj && obj.bossNames && obj.bossNames.length >= 2) {
      const objBosses = cands.filter(c => isEntityLikelyMainObjectiveBoss(c.e));
      if (objBosses.length >= 2) { objBosses.sort((a, b) => b.distSq - a.distSq); return objBosses[0].e; }
    }
  } catch (_) {}

  cands.sort((a, b) => a.distSq - b.distSq);
  return cands[0].e;
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

// STAGED-INTRO boss (live-RE'd on the twin arena): reads isTargetable=TRUE during the intro but carries
// 'phasing_no_visual' while untouched + idle -- can't be damaged until the proximity trigger fires. Engaging it wedges
// the fight; the trigger is DEEPER in the room, so approach states must keep WALKING, not fight.
function isPhasedIntroBoss(e) {
  return !!(e && (e.rarity || 0) === 3
    && e.hasActiveAction !== true
    && Number.isFinite(e.healthCurrent) && e.healthCurrent === e.healthMax
    && e.buffs && e.buffs.some(b => b && b.name === 'phasing_no_visual'));
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
    if (isPhasedIntroBoss(e)) continue;   // intro-phased (isTargetable LIES) -> not engageable; keep walking to the trigger

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
    // SPAWNED-AND-ACTING objective boss: some bosses (seal-triggered) fight UNTARGETABLE phases (fly away + spread
    // poison) -- no targetable/HP signal ever fires, the approach state never enters the fight, and the bot gets worn
    // down outside FIGHTING_BOSS. The named defeat-objective boss ACTING near us IS the fight: enter it; the fight
    // state follows/orbits and the rotation opens up whenever she lands (targetable again).
    const objectiveActing = !nearbyCombatSignal && !hpNotFull && !hpChanging
      && e.hasActiveAction === true && distToPlayer < 130 && isEntityLikelyMainObjectiveBoss(e);
    const engaged = hpNotFull || hpChanging || nearbyCombatSignal || objectiveActing;
    if (!engaged) continue;

    let score = 0;
    if (hpChanging) score += 80;
    if (hpNotFull) score += 70;
    if (nearbyCombatSignal) score += 30;
    if (objectiveActing) score += 40;
    score -= distToPlayer * 0.2;
    if (isLockedCandidate) score += 30;
    if (isLikelyMapBossEntity(e, radarBoss)) score += 20;

    if (score > bestScore) {
      bestScore = score;
      best = {
        entity: e,
        reason: hpChanging ? 'hp-changing' : (hpNotFull ? 'hp-not-full' : (nearbyCombatSignal ? 'targetable' : 'objective-acting')),
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
function pickBehindBossWaypoint(player, boss, radiusOverride) {
  if (!boss) return null;
  const facing = getEntityFacingRad(boss);
  if (facing === null) return null;            // unknown facing -> let the generic orbit handle it
  const backA = normalizeRad(facing + Math.PI);
  // radiusOverride (opt-in): callers may request the flank band; default 55 keeps the orbit-reassign caller byte-identical.
  const radius = (Number.isFinite(radiusOverride) && radiusOverride > 0) ? radiusOverride : 55;
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
// RANGED-KITE (opt-in via currentSettings.kiteBoss, DEFAULT OFF): the stand-off band a bow build holds from the boss.
// Used by BOTH the melee-approach engage range (stop here, don't walk to melee) and the FIGHTING_BOSS kite floor
// (retreat here when the boss closes inside it). Single source so approach + fight can't disagree. ~60-80u = maintain
// bow range, never melee (<45u).
const KITE_STANDOFF_DEFAULT = 75;
function kiteBossOn() { return currentSettings.kiteBoss === true; }
function kiteStandoff() {
  const v = Number(currentSettings.bossKiteRange);
  return (Number.isFinite(v) && v >= 45 && v <= 140) ? v : KITE_STANDOFF_DEFAULT;
}
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
    pressInHpBossId = 0;                    // press-in stall tracker: reset each fresh engage
    pressInLastHpValue = NaN;
    pressInLastDropAt = Date.now();         // seed from engage so STALL_MS measures from engage
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
    lastCheckpointStepAt = 0;                 // CHANGE 2: don't inherit a stale walk-step timestamp from a prior attempt
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
    // objectiveGoalMode: (re)start the HARD content-cleanup budget clock from THIS entry (never reset by runner activity).
    mapCompleteCleanupStartAt = Date.now();
    mapCompleteCleanupNoProgressSince = 0;
    arbBossDeferSpent = false;   // a spent pre-boss budget must NOT keep the post-boss cleanup loot-only (CHANGE 4 leak)
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
  bossCkptX = NaN; bossCkptY = NaN;   // forget the stored boss checkpoint on map change
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
  rotBreachId = 0; rotBreachStart = 0; rotBreachActivatedAt = 0; rotBreachCenterX = 0; rotBreachCenterY = 0; rotBreachLastMobAt = 0; rotBreachSawMob = false; rotBreachStabilised = false; rotBreachStabilisedLogged = false; rotBreachMobCache = null; rotBreachMobScanAt = 0; rotBreachSweepAng = 0; rotBreachSweepUntil = 0; rotBreachOppFlipAt = 0; rotBreachLastMobPX = NaN; rotBreachLastMobPY = NaN; rotBreachMobBL.clear(); rotBreachTgtId = 0; rotBreachTgtSince = 0; rotBreachBlacklist.clear(); breachReturnTgtX = NaN; breachReturnTgtY = NaN;
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
  contentQueue.clear(); revisitSkip.clear(); revisitKey = null; bossGridX = 0; bossGridY = 0;   // drop the spotted-content queue (+ revisit sticky/skip + stale cross-map boss grid) on map change
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
  mapCompleteCleanupStartAt = 0;
  mapCompleteCleanupNoProgressSince = 0;
  preBossHoldStartAt = 0;              // objectiveGoalMode pre-boss content-hold clocks -- fresh per map (else a spent budget disables the hold next map)
  preBossHoldNoProgressSince = 0;
  preBossEnergCount = 0; preBossReqKey = null; preBossReqBestDist = Infinity; preBossReqStuckAt = 0; preBossReqLastFrameAt = 0;   // pre-boss required-pursuit progress/stuck trackers
  arbBossDeferSince = 0; arbBossDeferBestDist = Infinity; arbBossDeferImprovedAt = 0; arbBossDeferEnergCount = 0; arbBossDeferSpent = false;   // CHANGE 3: pre-boss deferral budget -- fresh per map
  lastCheckpointStepAt = 0; bossCheckpointApproachCooldownUntil = 0;   // CHANGE 2/5: checkpoint walk-time watchdog + fog-seal approach cooldown
  discoverExploreSince = 0; discoverConceded = false; discoverLastHeadingAt = 0; discoverTgtX = NaN; discoverTgtY = NaN; discoverBestD = Infinity; discoverProgAt = 0; meleeQueueScanAt = 0; mapCompleteProgressCount = -1; mapCompleteCleanupDone = false; mapCompleteSkipSettle = false; mapCompleteContentDriveAt = 0;   // post-boss discovery + melee content-scan throttle + cleanup progress/done/settle/drive latches -- fresh per map
  _unexpFailed.clear();   // unreachable-bucket bans are keyed by LOCAL grid coords (shared across maps) -> a stale ban from map N would falsely skip map N+1's frontier; drop per map
  _exLmKey = null; _exLmSeen.clear(); _exLmDirX = NaN; _exLmDirY = NaN;   // sticky landmark commit + visited bans are map-local coords too
  _s5EliteId = 0; _s5SwitchAt = 0;
  _lsBan.clear(); _lsTgtKey = ''; _lsActiveAt = 0; _utTrack.key = '';   // loot-sweep bans/latch + utility owned-progress are map-local
  hiveLootX = NaN; hiveLootY = NaN;
  _portalLootHoldAt = 0;  // stale ts from map N reads as an expired loot-hold window in map N+1 -> instant portal with loot on the ground
  _portalOpenChkAt = 0; _portalOpenLeft = 0; mapCompleteUtilityExtendUntil = 0; _cleanupDriveAt = 0;
  abyssNodeX = NaN; abyssNodeY = NaN;
  pbWalkX = NaN; pbWalkY = NaN; pbWalkStartAt = 0; pbAcquireAt = 0; _pbTrack.key = '';
  hiveScanAt = 0; hiveCache = null; hiveIconWarned = new Set(); hiveKey = null; hiveStart = 0; hiveLastMobAt = 0; hiveSummonAt = 0; hiveSummonCount = 0; hiveDefScanAt = 0; hiveDefAilith = null; hiveDefStart = 0; hiveDefPreSummon = false; hiveDefEndAt = 0;   // Breach-Hive scan cache + summon/defend-hold + active-defense hold -- fresh per map
  revisitBeaconKey = null; revisitBeaconDwellStart = 0; revisitBeaconIncDoneAtStart = false; revisitBeaconLastMobAt = 0; revisitBeaconEnergisedAt = 0;   // Vaal-Beacon dwell latch: keyed by contentQueue key (per-map) -> a stale non-null key falsely reads as "in a beacon hold" (lootYieldSuppressed/_contentFight) all of the next map
  hivePieceScanAt = 0; hivePieceStab = null; hivePieceAilith = null; hiveMobScanAt = 0; hiveMobPt = null; beaconMobScanAt = 0; beaconMobPt = null; hiveDefMobAt = 0; hiveDefMobPt = null; swarmScanAt = 0; swarmEscape = null;   // throttled hold-scan caches
  _mapObjDone = {}; _mapObjDoneAt = -99999;   // objective-bit last-good snapshot must not leak across maps
  _objUiEverReq = new Set(); _objUiCache = null;   // UI objective/content split: fresh per map (sticky "ever-required" + cached rows)
  energisedBeacons = []; _energScanAt = 0;         // Vaal-Beacon sticky done registry: fresh per map
  _tgtBeaconCache = null; _tgtBeaconAt = 0;        // terrain-beacon discovery cache: fresh per map
  arbReset();                                      // objective arbiter: fresh commit/route/reach/yoyo state per map
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
    'moment of zen',
    'sun temple',
    'molten vault',
    'vaal city',
    'stronghold',
    'fortress',
    'forge',
    'augury',
    'hive',
    'hive fortress',
    'hive colony',
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
let _bossArenaRetryAt = 0;   // OPTIMIZER T1: throttle the terrain-not-ready getTgtLocations poll (~5.6ms) to ~1/s on cold-start
let _exploreBossDirect = false;   // Reviewer L1: true while committed to a FAR boss arena (direct-route) -> stepPathWalker skips the 1-strike explore-abandon
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
// STICKY landmark commit (signal-less-map thrash fix): on multi-marker maps (e.g. several "Traverse" objectives) a
// nearest-each-call pick FLIPS between markers as the player drifts around the midpoint -- and this feeds the boss
// bearing (conf 0.7), so the bucket picker's same-side reject + the boss-direct commit flip WITH it = the whole
// explore ping-pong. Commit ONE marker and hold it until reached (<90u -> banned for the map) or it leaves the
// marker list, THEN take the next-nearest unvisited. Real boss signals (tgt-centroid/ckpt/radar) still override
// upstream in resolveBossBearing.
let _exLmKey = null, _exLmBestD = Infinity, _exLmProgAt = 0, _exLmCallAt = 0;
let _exLmDirX = NaN, _exLmDirY = NaN;   // previous leg heading -> forward-biased next pick (hold a LINE)
const _exLmSeen = new Set();
function getExploreLandmark(player) {
  try {
    const ms = [];
    for (const m of (poe2.getQuestMarkers() || [])) {
      const gx = m.gridX || 0, gy = m.gridY || 0;
      if (!gx && !gy) continue;
      if (/Checkpoint|Portal|Waypoint|TownPortal|\/Town/i.test(m.path || '')) continue;
      ms.push({ gx, gy, d: Math.hypot(gx - player.gridX, gy - player.gridY), key: Math.round(gx / 32) + ':' + Math.round(gy / 32) });
    }
    const _n = Date.now();
    if (_n - _exLmCallAt > 3000) _exLmProgAt = _n;   // resumed after a content/utility preemption -> restart the progress clock (the detour isn't the landmark's fault)
    _exLmCallAt = _n;
    if (_exLmKey) {
      const held = ms.find(m => m.key === _exLmKey);
      if (held) {
        if (held.d < _exLmBestD - 40) { _exLmBestD = held.d; _exLmProgAt = _n; }
        if (held.d < 90) { _exLmSeen.add(_exLmKey); _exLmKey = null; log(`[Explore] landmark reached -> next`); }
        else if (_n - _exLmProgAt > 25000) { _exLmSeen.add(_exLmKey); _exLmKey = null; log(`[Explore] landmark (${held.gx},${held.gy}) no progress 25s -> ban, next`); }
        else return { gx: held.gx, gy: held.gy };
      } else _exLmKey = null;
    }
    // DIRECTIONAL LEGS (marker-dense maze yoyo): 150u legs on dense maps meant commit->reached every few seconds
    // with nearest-unvisited flipping sides (NE, SW, NE...). Min leg 240u + FORWARD persistence: prefer the
    // nearest candidate within ~78deg of the previous leg's heading, so exploration holds a LINE; fall back to
    // any direction only when nothing lies ahead.
    // ROUTE-AWARE (user: 'you can mark a path 1000u away and NAVIGATE to it'): euclidean-near can be route-far
    // in a maze and vice versa -- order candidates forward-first/nearest, then verify the top few with the
    // fog-independent macro router. Commit the first with a REAL route at ANY length (the walker macro-routes
    // it); a graph-unreachable marker is banned on the spot, never re-picked.
    const _lmCands = [];
    for (const m of ms) {
      if (m.d < 240 || _exLmSeen.has(m.key)) continue;
      let _fwd = 0;
      if (Number.isFinite(_exLmDirX)) _fwd = ((m.gx - player.gridX) * _exLmDirX + (m.gy - player.gridY) * _exLmDirY) / (m.d || 1);
      _lmCands.push({ m, fwd: _fwd });
    }
    _lmCands.sort((a, b) => ((b.fwd > 0.2) - (a.fwd > 0.2)) || (a.m.d - b.m.d));
    let pick = null;
    if (typeof poe2.macroPathTo === 'function') {
      for (const c of _lmCands.slice(0, 5)) {
        let _route = null;
        try { _route = poe2.macroPathTo(Math.floor(player.gridX), Math.floor(player.gridY), Math.floor(c.m.gx), Math.floor(c.m.gy)); } catch (_) {}
        if (!_route || _route.length < 2) { _exLmSeen.add(c.m.key); continue; }
        pick = c.m; break;
      }
    } else if (_lmCands.length) pick = _lmCands[0].m;
    if (pick) {
      _exLmKey = pick.key; _exLmBestD = pick.d; _exLmProgAt = _n;
      _exLmDirX = (pick.gx - player.gridX) / (pick.d || 1); _exLmDirY = (pick.gy - player.gridY) / (pick.d || 1);
      log(`[Explore] landmark commit -> (${pick.gx},${pick.gy})${pick === bestFwd ? ' [forward]' : ''}`);
      return { gx: pick.gx, gy: pick.gy };
    }
    return null;
  } catch (e) {}
  return null;
}

function getBossArenaCentroid() {
  const ac = POE2Cache.getAreaChangeCount();
  if (ac !== _bossArenaArea) { _bossArenaCentroid = null; _bossArenaArea = ac; }
  if (_bossArenaCentroid !== null) return _bossArenaCentroid || null;
  // OPTIMIZER T1: getTgtLocations() is ~5.6ms with NO game-side cache; the FINDING_BOSS caller is unthrottled, so before
  // terrain streams in (map-entry) this would re-scan EVERY tick (5-6ms/frame cold-start stall). Poll at most ~1/s until
  // ready; once computed, the _bossArenaCentroid cache above short-circuits it.
  const _nowBA = Date.now();
  if (_nowBA - _bossArenaRetryAt < 1000) return null;
  _bossArenaRetryAt = _nowBA;
  try {
    const t = poe2.getTgtLocations();
    if (!t || !t.isValid || !t.locations) return null;        // terrain not ready yet -> retry after the ~1s throttle
    const L = t.locations;
    // ExileCore2 Radar method: match this area's BOSS tile patterns (curated TARGETS_DB entry -> generic _default)
    // against the TGT tile paths, collect positions, take the DENSEST cluster = the real arena. The old /boss/-only
    // match missed every "<Map>Arena<NN>" tile (e.g. CenotesArena01) -> null -> blind-explore yoyo. We still UNION the
    // legacy /boss/ match so maps whose arena tiles literally contain "boss" keep working.
    let ai = ''; try { ai = ((poe2.getAreaInfo() || {}).areaId || '').toLowerCase(); } catch (e) {}
    const entry = TARGETS_DB[ai] || TARGETS_DB['_default'];
    const pats = (entry && entry.boss) || ['Arena\\d'];
    let rx = null; try { rx = new RegExp(pats.join('|'), 'i'); } catch (e) {}
    const pts = [];
    for (const k in L) {
      if (rx ? (!rx.test(k) && !/boss/i.test(k)) : !/boss/i.test(k)) continue;
      const a = L[k];
      for (let i = 0; i < a.length; i++) {
        if (Math.abs(a[i].x) < 40 && Math.abs(a[i].y) < 40) continue;   // skip origin-junk tiles (unstreamed -> (0,0))
        pts.push(a[i]);
      }
    }
    const cl = densestClusterCenter(pts, 130);   // ~130u ~ one arena footprint; isolates the real arena from strays
    const c = cl ? { gx: cl.x, gy: cl.y } : null;
    // Reject a near-origin centroid -- a real boss arena is never at the grid corner; that's origin-junk pollution.
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
  // The lock is READ here but enforced AFTER the survival dodge below -- a
  // boss telegraph must still be rolled while the opener/pickit holds it.
  // =====================================================================
  const moveLock = POE2Cache.isMovementLocked();

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
  // SURVIVAL (user 2026-07-03, killed at Verisium): keep the dodge ON during ANY active content FIGHT -- the Verisium
  // post-hammer WAVE / abyss hold / active breach -- not only when a rare happens to be near. Suppressing it there (the
  // old "don't yank off content" rule) facetanked the wave -> death. The dodge biases TOWARD the content goal
  // (autoDodgeCfg.goalX/Y), so a brief roll doesn't abandon the remnant. Only the Verisium awaitpick stays planted (recipe
  // SELECT, area already cleared, no wave yet). Boss mode untouched.
  const _exp2Planted = exp2Phase === 'awaitpick';
  const _contentFight = exp2Phase === 'fighting' || exp2Phase === 'loot'
    || (abyssLootDwellAt > 0 && (now - abyssLootDwellAt < 15000)) || rotBreachActivatedAt > 0
    || hiveDefStart > 0 || hiveKey !== null || revisitBeaconKey !== null;   // hive defense / hive dwell / beacon guardian hold are FIGHTS -- planted with the dodge off is the Verisium facetank death class
  const dodgeMode = inBossDodge ? 'boss' : (((rareUniqueNear(now) || _contentFight || hazardTerrainNear(now)) && !_exp2Planted) ? 'rare' : 'off');
  if (currentSettings.dodgeDebug === true && (inBossDodge || dodgeMode === 'rare')) {   // opt-in diag (off by default): state+mode while a boss/unique is up
    if (now - _dodgeDiagAt > 1500) { _dodgeDiagAt = now; log(`[DodgeDiag] state=${currentState} mode=${dodgeMode} dodgeOn=${currentSettings.autoDodgeEnabled !== false}`); }
  }
  if (currentSettings.autoDodgeEnabled && dodgeMode !== 'off') {
    autoDodgeCfg.mode = dodgeMode;
    autoDodgeCfg.bossEngaged = currentState === STATE.FIGHTING_BOSS;   // gate the boss-proximity dodge safety net to the FIGHT only (not the melee walk-in)
    // Feed the nav target so the dodge biases TOWARD it while approaching (anti-yoyo); null when there's no real target.
    const _hasDodgeGoal = Number.isFinite(targetGridX) && (targetGridX !== 0 || targetGridY !== 0);
    autoDodgeCfg.goalX = _hasDodgeGoal ? targetGridX : null;
    autoDodgeCfg.goalY = _hasDodgeGoal ? targetGridY : null;
    // PERPENDICULAR (kiteBoss only): let chooseDodgeDirection ADD true sidestep candidates for directional threats
    // (projectile lanes / cones). Additive to the 8 fixed samples, picked only if it scores lowest; OFF = 8-dir verbatim.
    // Re-set every active pass so toggling kiteBoss off can't leave it stuck true.
    autoDodgeCfg.perpendicularDodge = (currentSettings.kiteBoss === true);
    autoDodgeCfg.debug = currentSettings.dodgeDebug === true; autoDodgeCfg.log = log;   // opt-in (dodgeDebug): per-scan boss-doing vs dodge-sees diag; OFF by default (builds a per-entity list every scan)
    // THREAD-SAFETY (user): opener/pickit holding the movement lock = an interact auto-walk in flight; a soft-risk
    // roll cancels it (the skipped relay/strongbox). The dodge holds soft risks while the lock is held; hard risks roll.
    autoDodgeCfg.interactLockHeld = moveLock.locked && (moveLock.source === 'opener' || moveLock.source === 'pickit');
    try {
      const _dodged = runAutoDodge(autoDodgeCfg);
      // WALK-OUT is read EVERY pass, not just roll frames (Aurelian ring death: the egress only existed on the
      // exact frame a roll fired, so between rolls the fight loop walked us back INTO the circle). Re-issued
      // each scan until outside; the renewed suppression keeps all other movement writers off it meanwhile.
      const _we = autoDodgeStatus().walkEgress;
      if (_we && Number.isFinite(_we.dx) && !moveLock.locked) {
        MB.set('dodge', 1);                          // survival writer: holds the broker window over everyone
        sendMoveGridLimited(_we.dx, _we.dy, true);   // force past the dodge-suppress
        dodgeMoveSuppressUntil = now + 300;          // renewed every ~150-200ms scan while still inside
      } else if (_dodged) {
        MB.set('dodge', 1);
        MB.gate();                                   // register the roll as the window holder (packet went via auto_dodge)
        dodgeMoveSuppressUntil = now + 520;
      }
      MB.set('nav', 5);                              // back to default until a subsystem declares itself
    } catch (e) { /* auto_dodge_core unavailable */ }
  }

  // MOVEMENT LOCK enforcement: the survival dodge above has already fired; now yield the rest of the frame to opener/pickit.
  if (moveLock.locked) {
    statusMessage = `Yielding to ${moveLock.source}... (${(moveLock.remainingMs / 1000).toFixed(1)}s)`;
    lastPositionChangeTime = now;   // reset stuck detection during the yield
    // OPENER-RACE: this yield is the only code that runs while locked, so stamp servicing-recency (the opener opens a
    // chest from up to 80u, outside the 20u dwell gate) for the utility timeout branch, which runs unlocked.
    if (moveLock.source === 'opener' || moveLock.source === 'pickit') {
      // Collection-in-flight recency: stamped in EVERY state (not just utility) -- the cleanup fast-out and the
      // portal gate read it during MAP_COMPLETE sweeps, and the opener grabs on-the-way chests mid-cleanup-walk.
      utilityLastServicedAt = now;
      // YIELD PAUSES EVERY COLLECT TIMER (user): while opener/pickit actively service, the loot/dwell windows must
      // NOT consume -- fixed timers were expiring mid-vacuum and items got skipped. Advance each live dwell anchor
      // by the serviced frame delta so the window resumes intact when the servicing ends.
      const _dt = (_lockTickAt && now - _lockTickAt < 1000) ? (now - _lockTickAt) : 0;
      if (_dt > 0) {
        if (rotBreachClearedAt) rotBreachClearedAt += _dt;
        if (abyssLootDwellAt) abyssLootDwellAt += _dt;
        if (exp2LootedAt) exp2LootedAt += _dt;
        if (hiveDefEndAt) hiveDefEndAt += _dt;
        if (revisitBeaconEnergisedAt) revisitBeaconEnergisedAt += _dt;
        if (exp2LootWaitAt) exp2LootWaitAt += _dt;
        if (exp2LootReadyAt) exp2LootReadyAt += _dt;
        if (utilityArrivalWaitStart) utilityArrivalWaitStart += _dt;
        if (utilitySessionStartTime) utilitySessionStartTime += _dt;
        if (_portalLootHoldAt) _portalLootHoldAt += _dt;   // the 45s portal-gate cap bounds STUCK holds, not active vacuuming
        // NOTE: this block is THE pattern for every loot-adjacent wait -- any new collect/dwell timer gets its
        // anchor advanced here so opener/pickit servicing never consumes its window.
      }
      _lockTickAt = now;
    }
    return; // Skip the rest of the movement logic this frame
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
  // Keep the persistent spotted-content QUEUE warm (flag-on-spot) -- the arbiter + the HUD counts read it. FIGHTING_BOSS is
  // fully excluded (never peel off an engaged boss + the most FPS-sensitive frames). The melee walk-in is THROTTLED, not
  // skipped: the server streams new content (breach/abyss) as we close on the arena, so we keep re-scanning at ~600ms.
  if (!String(currentState).startsWith('HIDEOUT_') && currentState !== STATE.IDLE && currentState !== STATE.FIGHTING_BOSS) {
    if (currentState !== STATE.WALKING_TO_BOSS_MELEE) {
      try { populateContentQueue(player, now); } catch (e) {}
    } else if (now - meleeQueueScanAt > 3000) {   // slow rate on the FPS-sensitive arena walk-in (content that streams in the final seconds is finished by post-boss cleanup anyway)
      meleeQueueScanAt = now;
      try { populateContentQueue(player, now); } catch (e) {}
    }
  }

  const inBossEngage = currentState === STATE.FIGHTING_BOSS || currentState === STATE.WALKING_TO_BOSS_MELEE;
  if (!inBossEngage && !String(currentState).startsWith('HIDEOUT_')) {
    // VERISIUM far-walk yield (USER 2026-06-27): while only WALKING to a remnant we haven't engaged (>100u away,
    // not reached/opened), let a nearby shrine/utility go FIRST so we don't blow past it. tryStartUtilityNavigation
    // returns true only if it actually took over (-> WALKING_TO_UTILITY, stepped by the switch below); in that case
    // skip the rotation so exp2 doesn't immediately re-preempt. No utility nearby -> rotation runs, verisium walk continues.
    const exp2FarWalkYield = exp2Phase === 'walk' && exp2ClearAt === 0 && exp2CurDist > 100 && tryStartUtilityNavigation(player, now);
    // objectiveGoalMode: once the post-boss cleanup BUDGET is spent, stop letting the (uncapped) content rotation preempt
    // during MAP_COMPLETE -- fall through to the switch so Phase 4 portals out. This is what makes the HARD cap DOMINATE
    // even a stuck-but-reachable runner. Flag OFF => objGoalOn() short-circuits => cleanupBudgetSpent is always false =>
    // byte-parity (the rotation preempts exactly as today, in every state including MAP_COMPLETE).
    const cleanupBudgetSpent = objGoalOn() && currentState === STATE.MAP_COMPLETE
      && mapCompleteCleanupStartAt > 0 && (now - mapCompleteCleanupStartAt) >= OBJ_CLEANUP_BUDGET_MS;
    // objectiveGoalMode CONTENT-BEFORE-BOSS (USER): after the close revisit, run the WIDE pre-boss content pass so FAR
    // incomplete drivable objectives (e.g. the 3 Vaal Beacons scattered across the map) are done BEFORE the boss. It only
    // fires in FINDING_BOSS / WALKING_TO_BOSS_CHECKPOINT (internal state guard) and returns true only while actually
    // walking/working -> holds the boss; best-effort + hard-capped (owns preBossHoldStartAt) so it can never freeze. Flag
    // OFF => objGoalOn() short-circuits inside => false => byte-parity (boss engages exactly as today).
    // OBJECTIVE ARBITER: always shadow-computes + logs its pick; DRIVES only when ARBITER (then it REPLACES the legacy
    // chain below). Shadow mode (default) = log-only, the legacy chain still drives -> byte-parity.
    if (!exp2FarWalkYield && !cleanupBudgetSpent) {
      // MAP_COMPLETE post-boss cleanup is owned by the switch below (it holds the budget + no-progress clock) -> don't
      // double-drive it here. Pre-boss states: arbTick drives (ARBITER on) or shadow-logs (off) then the legacy chain runs.
      // C9: rares live OUTSIDE the arbiter's content selection (pickObjective only picks content/boss). When ARBITER
      // drives, run the nearby rare/unique sweep first so walk-to-rares isn't dropped; the legacy runContentRotation
      // already covers rares when ARBITER is off, so this is gated to the arbiter path to keep flag-off parity.
      // ALSO frozen during utility detours (same yield-freeze rationale as arbTick below): a tanky rare stealing every
      // frame from the utility walk lets the session clock expire and bans the never-attempted target for the map.
      if (ARBITER && currentState !== STATE.MAP_COMPLETE && currentState !== STATE.WALKING_TO_UTILITY
          && currentSettings.clearRares !== false && runClearNearbyRares(player, now)) return;
      // An ACTIVATED breach roams off its CACHED center -- the Brequel despawns on activation, so it leaves the contentQueue
      // and pickObjective can no longer drive it. Handle it OUTSIDE the arbiter under ARBITER=true (legacy runContentRotation
      // owns it when ARBITER=false -> gate to ARBITER for parity + no double-drive), else an opened breach is abandoned.
      if (ARBITER && rotBreachActivatedAt && runBreachRoam(player, now)) return;
      // A SUMMONED hive defense is running -> guard Ailith until it finishes. Above the arbiter + utility so NOTHING
      // (loot detours, re-picks, the boss walk) can pull the bot off her mid-defense.
      if (ARBITER && runHiveDefense(player, now)) return;
      // DELIRIUM MIRROR above the arbiter: it lives in the FINDING_BOSS state case, which the arbiter preempts -- so a
      // committed objective walked STRAIGHT PAST the map-start mirror. The mirror is one-shot + activates the whole
      // map's delirium: walk into it FIRST, then everything else.
      if (ARBITER && (currentState === STATE.FINDING_BOSS || currentState === STATE.WALKING_TO_BOSS_CHECKPOINT)
          && handleDeliriumMirror(player, now)) return;
      // YIELD-FREEZE: while a utility detour owns movement, the arbiter must SLEEP -- not drive (it fights the utility
      // walk for movement), not re-classify, not stuck-ban its committed target. The commitment persists untouched and
      // resumes when the detour ends -- "going to X, yield, return to X". (Pickit/opener move-locks already freeze it:
      // they return above this hook.)
      // TTL freeze accounting: a utility detour must NOT age the commit's TTL (else arbTerminated bans a still-valid
      // target on resume instead of resuming it). Advance the commit epoch by each utility-detour frame's dt so the
      // effective age holds steady across the detour; clear on any non-utility frame. INCREMENTAL (not enter->exit
      // banking) so a resume THROUGH WALKING_TO_BOSS_MELEE -- where this line isn't reached -- can't bank the melee
      // span. ARBITER-only: no effect on the flag-off shadow path.
      if (ARBITER && arbCommittedKey && currentState === STATE.WALKING_TO_UTILITY) {
        if (arbFrozeAt > 0) arbCommittedSince += (now - arbFrozeAt);
        arbFrozeAt = now;
      } else if (arbFrozeAt > 0) {
        arbFrozeAt = 0;
      }
      if (currentState !== STATE.MAP_COMPLETE && currentState !== STATE.WALKING_TO_UTILITY && arbTick(player, now)) return;
      if (!ARBITER && (runContentRotation(player, now) || tryRevisitNearbyContent(player, now) || tryPreBossContentPass(player, now))) return;
    }
  } else if (currentState === STATE.WALKING_TO_BOSS_MELEE) {
    // G1 (user grievance): once we enter boss-melee the content rotation stops, so an OPENED/stabilised breach
    // gets abandoned and a nearby Vaal Beacon gets skipped ("swapped to MELEE too soon cuz they were all
    // compacted"). While APPROACHING the boss, finish content OBJECTIVES first (breach roam + vaal/incursion/
    // abyss/delirium) -- skipRares so we don't chase trash forever instead of reaching the boss. FIGHTING_BOSS
    // stays boss-only (don't leave an engaged boss). When content is clear this returns false -> melee proceeds.
    if (runContentRotation(player, now, /*skipRares=*/true)) return;
    // Position-anchored content RIGHT ON the melee path (queued hive/beacon within 150u): do it now -- walking THROUGH
    // a hive without summoning it is the "walked past it" case (the legacy rotation above only knows entity-streamed
    // types). Bounded by the dwell caps + bans; when none is close this falls through and melee proceeds.
    if (ARBITER) {
      for (const [k, e] of contentQueue) {
        if (!e || e.state !== 'active') continue;
        if (e.type !== 'breach2' && e.type !== 'incursion-beacon') continue;
        if ((revisitSkip.get(k) || 0) > now) continue;
        if (!typeShouldRun(e.type, now) || objectiveTypeComplete(e.type, now) || lockIsDone(e.type, e.id, now)) continue;
        if (e.type === 'incursion-beacon' && isBeaconEnergisedAt(e.gridX, e.gridY)) continue;
        if (Math.hypot(e.gridX - player.gridX, e.gridY - player.gridY) > 150) continue;
        if (arbCoordDrive(k, e, player, now)) return;
      }
    }
  }

  // Priority order:
  // 1) movement lock (handled above)
  // 2) core mapper state machine
  // 3) utility walk state


  // Utility never PREEMPTS a committed REQUIRED objective: the chest detour releases/poisons the commitment (the yield
  // loop the 122u-chest-over-beacon case exposed). Close pickups are the opener/pickit plugins' job under the move-lock.
  const _reqCommitted = ARBITER && arbCommittedKey && (() => {
    const _e = contentQueue.get(arbCommittedKey);
    return !!(_e && _e.state === 'active' && objGoalOn() && isRequiredType(CQTYPE_TO_DRIVE[_e.type] || _e.type, now));
  })();
  // CHANGE 4: extend the loot-only gate to the boss drive. While macro-routing a CONFIDENT boss-direct anchor (>=0.7,
  // >150u away -- bossReachV2), or once the pre-boss content-deferral budget is spent (ARBITER, CHANGE 3), utility goes
  // LOOT-ONLY: a quick pickit grab never steals the boss drive, but full-pass shrine/chest detours do. OFF on both =>
  // false => the original _reqCommitted gate is unchanged (byte-parity).
  const _bossDriveLootOnly = (currentSettings.bossReachV2 !== false
      && (currentState === STATE.FINDING_BOSS || currentState === STATE.WALKING_TO_BOSS_CHECKPOINT)
      && now < fogBlockedAnchorUntil && fogBlockedAnchorConf >= 0.7
      && Number.isFinite(fogBlockedAnchorX) && Math.hypot(fogBlockedAnchorX - player.gridX, fogBlockedAnchorY - player.gridY) > 150)
    || arbBossDeferSpent;
  // Openable/shrine detours never preempt a committed REQUIRED objective (the chest-over-beacon yoyo). Pickit
  // LOOT is exempt: a quick grab doesn't steal the commitment, so run a LOOT-ONLY utility pass while committed
  // (full pass when not). lootYieldSuppressed still holds it off during danger / a content-event.
  if (tryStartUtilityNavigation(player, now, _reqCommitted || _bossDriveLootOnly)) {
    // Utility state can start from any non-critical mapping state.
  }

  // MOVEMENT BROKER writer for the state machine below: the boss FIGHT outranks content/utility (a stale content
  // dwell must never plant us under a boss again); everything else navigates at explore priority.
  MB.set((currentState === STATE.FIGHTING_BOSS || currentState === STATE.WALKING_TO_BOSS_MELEE) ? 'fight' : 'nav',
    (currentState === STATE.FIGHTING_BOSS || currentState === STATE.WALKING_TO_BOSS_MELEE) ? 2 : 5);

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
        mapCompleteSkipSettle = true;   // no fresh kill -> no drops to settle; straight to the sweep/portal phases
        setState(STATE.MAP_COMPLETE);
        break;
      }
      // Boss(es) ALREADY dead (no outstanding "Defeat X" line -- completed lines VANISH from the main block -- e.g.
      // mapper reloaded mid-map) while OTHER required objectives keep isMapObjectiveComplete false -> nothing to find at
      // the arena; go straight to the post-boss sweep. A LIVE defeat line always wins over the MapBoss bit (the bit's
      // per-boss semantics on multi-boss maps are unverified). Skip the loot-settle (no fresh kill = no drops).
      { const _defeat = getMainDefeatObjectiveInfo();
        if (!_defeat.hasDefeatObjective && mapObjectiveComplete('MapBoss', now)) {
          log('Boss objective already complete -> skip boss-find, content cleanup (MAP_COMPLETE)');
          mapCompleteSkipSettle = true;
          setState(STATE.MAP_COMPLETE);
          break;
        } }
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
          } else if (now < fogBlockedAnchorUntil && Math.hypot(cp.gridX - fogBlockedAnchorX, cp.gridY - fogBlockedAnchorY) < 60) {
            // this checkpoint IS the fog-blocked anchor (e.g. a mountain-top boss with no direct path): re-committing it
            // re-enters the 5s fail loop -- keep the explore-around going until the reveal opens a route to it.
          } else {
          if (!bossTgtFound || Math.abs(cp.gridX - bossGridX) > 30 || Math.abs(cp.gridY - bossGridY) > 30) {
            log(`Boss checkpoint entity at (${cp.gridX.toFixed(0)}, ${cp.gridY.toFixed(0)})`);
          }
          bossGridX = cp.gridX;
          bossGridY = cp.gridY;
          bossCkptX = cp.gridX; bossCkptY = cp.gridY;   // USER: store it the moment we see it -> bearing survives the marker de-streaming
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

      // CHANGE 5: during the post-fog-seal approach cooldown (bossReachV2), do NOT re-enter the checkpoint walk -- fall
      // through to the explore strategies (which macro-route the held bearing to reveal a way around the seal). The
      // target is preserved, so once the cooldown expires this re-fires and re-attempts the checkpoint. OFF = no gate.
      if (bossTgtFound && !(currentSettings.bossReachV2 !== false && now < bossCheckpointApproachCooldownUntil)) {
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
        // CHANGE 1 (bossReachV2): seed the fused boss bearing at the TOP of STRATEGY 5 (both branches) so the elite gate
        // below sees a fresh anchor. Shared _bbSeedAt throttle => the else-branch re-seed is a no-op within 1.5s (no double
        // work). OFF => this is skipped and the original else-branch seed runs unchanged (byte-parity).
        if (currentSettings.bossReachV2 !== false && now - _bbSeedAt > 1500) {
          _bbSeedAt = now;
          const _bb0 = resolveBossBearing(player, now);
          if (_bb0 && Number.isFinite(_bb0.x)) { fogBlockedAnchorX = _bb0.x; fogBlockedAnchorY = _bb0.y; fogBlockedAnchorUntil = now + 20000; fogBlockedAnchorConf = _bb0.conf || 0; }
        }
        const elite = findNearestEliteAlive(player.gridX, player.gridY);
        let _eliteOk = !!(elite && Number.isFinite(elite.gridX));
        // CHANGE 1: with a CONFIDENT boss bearing held (>=0.7) that's a genuine macro-route away (>150u), drive the
        // boss-direct route FIRST and only divert to an elite that is ON THE WAY -- forward-projection onto the
        // player->anchor segment (t in [-0.1,1.2], perpendicular detour <=120u, elite within 200u). An off-route elite
        // falls through to the explore branch, which macro-routes the fogged anchor (_bossDirect). conf<0.7 (or OFF) keeps
        // today's elite-first behavior.
        if (_eliteOk && currentSettings.bossReachV2 !== false && now < fogBlockedAnchorUntil && fogBlockedAnchorConf >= 0.7 &&
            Number.isFinite(fogBlockedAnchorX) && (Math.abs(fogBlockedAnchorX) > 1 || Math.abs(fogBlockedAnchorY) > 1)) {
          const _ax = fogBlockedAnchorX - player.gridX, _ay = fogBlockedAnchorY - player.gridY;
          const _al = Math.hypot(_ax, _ay);
          if (_al > 150) {   // matches the _bossDirect macro-route gate; nearer anchors keep elite-first + the crawl/bias
            const _ex = elite.gridX - player.gridX, _ey = elite.gridY - player.gridY;
            const _t = (_ex * _ax + _ey * _ay) / (_al * _al);          // projection along player->anchor
            const _perp = Math.abs(_ex * (-_ay) + _ey * _ax) / _al;    // perpendicular detour from the segment
            const _ed = Math.hypot(_ex, _ey);
            if (!(_t >= -0.1 && _t <= 1.2 && _perp <= 120 && _ed <= 200)) _eliteOk = false;   // off-route -> let boss-direct run
          }
        }
        // STICKY BRANCH LATCH (user 'be STICKY'): a chasing elite hovers exactly at the gate boundary while we
        // walk away -> _eliteOk flips per tick and the walker alternates Elite <-> Boss Explore every second.
        // Strict gate to ENTER an engagement; once ENGAGED (same elite id) only a loose exit unseats it (dead /
        // gone / >260u); and the branch may switch at most once per 3s in either direction.
        if (_s5EliteId && elite && (elite.id || 0) === _s5EliteId) {
          _eliteOk = Math.hypot(player.gridX - elite.gridX, player.gridY - elite.gridY) <= 260;
        }
        if (_eliteOk && (!elite || (elite.id || 0) !== _s5EliteId)) {
          if (now - _s5SwitchAt < 3000) _eliteOk = false;
          else { _s5EliteId = (elite && elite.id) || 0; _s5SwitchAt = now; }
        }
        if (!_eliteOk && _s5EliteId) { _s5EliteId = 0; _s5SwitchAt = now; }
        if (_eliteOk) {
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
            // POSITIONAL SAFETY: don't STAND inside a melee pack. A white/blue trash pack emits NO telegraph, so
            // auto_dodge is blind to it (no hazard -> no walkEgress). And when the engaged elite is only MAGIC (blue)
            // with no Rare/Unique within 75u, rareUniqueNear() is false -> dodgeMode='off' -> the rare-surround dodge
            // net never even runs. In that gap the bot would stand here (sendStopMovementLimited) eating hits until
            // dead. If several hostiles are packed close around us, step OUT (away from the pack centroid) so the body
            // clears the cluster; entity_actions still fires on the way. Only HOLD when it's a clean, un-surrounded
            // target -- preserves 'stand still to kill' for the common case, so no reintroduced constant motion.
            let _packN = 0, _pcx = 0, _pcy = 0;
            try {
              for (const _m of (poe2.getEntities({ type: 'Monster', aliveOnly: true, lightweight: true }) || [])) {
                if (!isHostileAlive(_m)) continue;
                const _md = Math.hypot((_m.gridX || 0) - player.gridX, (_m.gridY || 0) - player.gridY);
                if (_md < 40) { _packN++; _pcx += (_m.gridX || 0); _pcy += (_m.gridY || 0); }
              }
            } catch (_e) {}
            if (_packN >= 3) {
              // Step directly AWAY from the pack centroid. We deliberately do NOT walk toward targetGridX/Y here: in
              // this hold branch the nav goal IS the engaged elite (pack center), so a toward-goal heading would walk
              // us back INTO the cluster. entity_actions keeps damaging the pack from the new spot; this is a
              // reposition, not a flee. sendMoveGridLimited is throttled + yields to an active dodge-roll suppression.
              let _hx = player.gridX - (_pcx / _packN), _hy = player.gridY - (_pcy / _packN);
              if (Math.abs(_hx) < 0.001 && Math.abs(_hy) < 0.001) { _hx = 1; _hy = 0; }   // exactly centred -> pick any dir
              statusMessage = `Stepping OUT of pack (${_packN} <40u) -> not standing still`;
              sendMoveGridLimited(_hx, _hy);
            } else {
              sendStopMovementLimited();   // clean single target -> hold; entity_actions does the killing
            }
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
          // Backward-guard whenever an explore goal is COMMITTED (not just with a locked arena): a mob up to 220u
          // BEHIND the heading yanked the walker backward on signal-less maps = half the breadcrumb ping-pong. Forward
          // mobs and very-close (<50u) mobs still divert (kill-on-the-way + reveal); a backward one is left to
          // entity_actions' ranged attacks while movement keeps closing on the committed point.
          if (nearMob && exploreTgtX !== null && nearMobD > 50) {
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
              // ONE marker policy (signal-less thrash fix): this pick used FARTHEST while the landmark bearing used
              // NEAREST -- on multi-Traverse maps the two aimed at OPPOSITE ends and the walker flipped between them.
              // Route through the STICKY landmark commit so every explore writer aims at the SAME held point; farthest
              // stays as the fallback for maps where the landmark filter yields nothing (single-marker maps unchanged).
              let best = null, bestD = 60;
              try {
                const _lm = getExploreLandmark(player);
                if (_lm && Number.isFinite(_lm.gx)) best = { x: _lm.gx, y: _lm.gy, d: Math.hypot(_lm.gx - player.gridX, _lm.gy - player.gridY) };
              } catch (e) {}
              if (!best) for (const m of markers) { if (m.d > bestD) { bestD = m.d; best = m; } }
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
              // CRAWL THE FRONTIER (2026-07-02): never COMMIT the walker to a far explore target. A >150u target winds
              // through fog ("Terrain path: 64 wp" + "Macro route"), stalls ~70u short and yoyos, and drives the 800ms
              // empty-path computePath churn (~line 3472). Clamp ANY explore target (incl. farthest-marker `best`) to a ~40u
              // hop ALONG its own bearing: directly reachable, re-cast from the new spot each cycle, so we SNAKE toward the
              // far frontier in steps. Boss bias survives (hop is along boss-ward exDir); macroPathTo (>150u gate) never fires.
              // DIRECT-ROUTE to a high-confidence boss arena (ExileCore2 method): resolveBossBearing already fed the
              // bearing into fogBlockedAnchor above. When that bearing is CONFIDENT (>=0.7 -- tgt-centroid / bossroom
              // marker / stored ckpt), COMMIT THE ARENA ITSELF as the walker target and BYPASS the 40u crawl clamp.
              // stepPathWalker's no-fine-path branch then routes it via the fog-INDEPENDENT macro corridor
              // (macroWaypointToward, >150u gate) around walls -- the direct route the crawl clamp was suppressing.
              // The clamp REMAINS the deadlock floor for blind frontier hops (no confident bearing).
              let _clamped = false, _bossDirect = false;
              if (now < fogBlockedAnchorUntil && fogBlockedAnchorConf >= 0.7 &&
                  Number.isFinite(fogBlockedAnchorX) && (Math.abs(fogBlockedAnchorX) > 1 || Math.abs(fogBlockedAnchorY) > 1) &&
                  Math.hypot(fogBlockedAnchorX - player.gridX, fogBlockedAnchorY - player.gridY) > 150) {   // >150u = stepPathWalker's macro-route gate (Reviewer C1); nearer arenas fall to the crawl+bias
                exTarget = { x: fogBlockedAnchorX, y: fogBlockedAnchorY };   // raw arena; stepPathWalker macro-routes it around fog
                _bossDirect = true;
              }
              _exploreBossDirect = _bossDirect;   // Reviewer L1: mark a committed FAR arena so stepPathWalker's stuck-abandon uses the 3-strike tolerance, not 1-strike, while it routes around fog
              if (exTarget && !_bossDirect) {
                const _hdx = exTarget.x - player.gridX, _hdy = exTarget.y - player.gridY, _hl = Math.hypot(_hdx, _hdy);
                if (_hl > 55) { exTarget = { x: Math.round(player.gridX + _hdx / _hl * 40), y: Math.round(player.gridY + _hdy / _hl * 40) }; _clamped = true; }
              }
              // A clamped MARKER hop must be flagged isMarker=FALSE: otherwise the sticky-validity guard (~line 9071
              // `markers.some(<100u)`) fails (the 40u hop is >100u from the far marker) -> the sticky target is cleared and
              // re-picked EVERY tick. The hop is re-derived toward the live marker each cycle anyway, so nothing is lost.
              if (exTarget) { exploreTgtX = exTarget.x; exploreTgtY = exTarget.y; exploreTgtSetAt = now; exploreTgtIsMarker = (!!best && !_clamped && !_bossDirect); }
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

      // CHANGE 2: the anti-freeze watchdog must count CHECKPOINT-WALK frames, not wall-clock. When content/utility/dodge
      // preempted this case (the pre-switch hook returned before the switch), the walk didn't step -- advance the
      // improvement clock by the preempted gap so a legitimate detour doesn't age into a FALSE fog-block on resume.
      if (ARBITER && lastCheckpointStepAt && bossCheckpointLastImprovementTime) {
        const _ckptGap = now - lastCheckpointStepAt;
        if (_ckptGap > 400) bossCheckpointLastImprovementTime += _ckptGap;
      }
      const result = stepPathWalker();
      lastCheckpointStepAt = now;
      const dist = Math.hypot(player.gridX - bossGridX, player.gridY - bossGridY);
      const approachLabel = bossTargetSource === 'arena_object' ? 'Boss Arena Barrier' : 'Boss Checkpoint';
      statusMessage = `Walking to ${approachLabel}... ${dist.toFixed(0)} units`;

      // Reach the boss entry. OR: the arena centroid can sit on an UNWALKABLE cell, so the terrain path ends a
      // few wp SHORT and we never get within 18u -- we just oscillate 2-6 wp out (the yo-yo). So ALSO accept being
      // CLOSE (<=50u) with the path basically spent / stuck, and hand off to the melee state (it chases the actual
      // boss ENTITY, not the centroid, so it engages from there instead of bouncing forever on an unreachable point).
      const pathSpent = currentPath.length <= 3 || result === 'stuck' || (result === 'walking' && currentPath.length === 0);
      // 'arrived' with the player still FAR from the anchor = the SHARED path walker was consumed by a content/
      // utility detour (e.g. a verisium walk overwrote currentPath), NOT a real arrival. Re-issue the checkpoint
      // walk instead of false-arriving from across the map (which force-switched to melee-forward at 700u).
      if (result === 'arrived' && dist > 130) {
        if (now - lastRepathTime > 1500) startWalkingTo(bossGridX, bossGridY, approachLabel, 'boss');
        break;
      }
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
        log(`[Mapper] Boss anchor (${bossGridX.toFixed(0)},${bossGridY.toFixed(0)}) fog-unreachable 5s at ${dist.toFixed(0)}u -> HOLD as bearing + explore to reveal (do NOT run from it)`);
        fogBlockedAnchorX = bossGridX; fogBlockedAnchorY = bossGridY; fogBlockedAnchorUntil = now + 25000; fogBlockedAnchorConf = 0.9;   // USER: commit toward it (reject engages) instead of wandering
        bossCkptX = bossGridX; bossCkptY = bossGridY;   // STORE the seen checkpoint -> resolveBossBearing keeps it as the bearing
        const _sealX = bossGridX, _sealY = bossGridY;   // preserve across setState (WALKING_TO_BOSS_CHECKPOINT -> FINDING_BOSS wipes bossTgtFound/target)
        bossTgtFound = false; bossCheckpointLastImprovementTime = 0; checkpointBestDist = Infinity; bossNoPathCount = 0;
        setState(STATE.FINDING_BOSS);
        // CHANGE 5: split fogBlockedAnchor's dual role. The bearing (resolveBossBearing / fogBlockedAnchor above) stays the
        // DIRECTION; the "don't re-ram the checkpoint" half becomes a SHORT approach cooldown instead of ERASING the target.
        // Keep the confirmed boss target so FINDING_BOSS explores/reveals AROUND the seal for ~10s, then re-attempts the
        // checkpoint (bossReachV2 OFF = legacy: bossTgtFound stays false, no cooldown, re-explore blind).
        if (currentSettings.bossReachV2 !== false) {
          bossGridX = _sealX; bossGridY = _sealY; bossTgtFound = true; bossTargetSource = 'checkpoint';
          bossCheckpointApproachCooldownUntil = now + 10000;
        }
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
          const engageFightDist = kiteBossOn() ? kiteStandoff() : 32;   // RANGED-KITE holds bow range; else 32 (cannotBeDamaged handled by the wait branch above)
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
      const engageRange = selectedIsImmune
        ? IMMUNE_ENGAGE_RANGE
        : (kiteBossOn() ? kiteStandoff() : DAMAGEABLE_ENGAGE_RANGE);   // RANGED-KITE: stop at bow standoff, not melee (30)
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
          if (!isEntityLikelyMainObjectiveBoss(selected)) { statusMessage = `Melee: non-objective unique close (rotation clears it)`; break; }
          bossEntityId = selected.id || bossEntityId;
          const bossName = ((selected.renderName || selected.name || 'Unknown')).split('/').pop();
          log(`Boss "${bossName}" immune-close threshold met (<=5) - entering fight`);
          setState(STATE.FIGHTING_BOSS);
        } else {
          statusMessage = `Holding near immune boss... ${distToBossEntity.toFixed(1)} units`;
        }
        break;
      }

      // FIGHT-ENTRY objective gate: unique TRASH (e.g. the mountain boss's unique hyena adds) reaching engage range must
      // NOT enter FIGHTING_BOSS -- each insta-kill cycles FIGHTING->reacquire->checkpoint->melee (the arena yoyo). The
      // rotation kills them as normal mobs; only the named defeat-objective boss starts the fight.
      if (!isEntityLikelyMainObjectiveBoss(selected)) { statusMessage = `Melee: non-objective unique engaged (rotation clears it)`; break; }
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
        // MULTI-BOSS: iterate EVERY outstanding "Defeat X" line (mirror isEntityLikelyMainObjectiveBoss) so a fresh
        // in-fight identification can lock the 2nd twin (e.g. Anundr) too, not only bossNames[0] (Akthi).
        const names = (mainObjectiveInfo.bossNames && mainObjectiveInfo.bossNames.length)
          ? mainObjectiveInfo.bossNames : [mainObjectiveInfo.bossName];
        const toksBy = (mainObjectiveInfo.tokensByName && mainObjectiveInfo.tokensByName.length)
          ? mainObjectiveInfo.tokensByName : [mainObjectiveInfo.tokens || []];
        for (let i = 0; i < names.length; i++) {
          const bn = names[i];
          if (bn && (entityName.includes(bn) || bn.includes(entityName))) return true;
          const tokens = toksBy[i] || [];
          if (!tokens.length) continue;
          let hits = 0;
          for (const t of tokens) {
            if (entityName.includes(t)) hits++;
          }
          if (hits >= (tokens.length >= 3 ? 2 : 1)) return true;
        }
        return false;
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
                // objectiveGoalMode NO-DEAD-BOSS-LOOP fix (USER): the tracked unique is DEAD but the whole map isn't
                // "Map Completed". Only RE-ACQUIRE when the game still lists a live "Defeat X" objective (a genuine 2nd
                // boss). Otherwise mainObjective has advanced to CONTENT (e.g. "Energise the Vaal Beacons") -- and with no
                // "Defeat X" text isEntityLikelyMainObjectiveBoss() matches EVERY unique, so FINDING_BOSS re-engages the
                // next beacon-guardian in a tight loop ("Boss DEAD x5"). Route to the capped MAP_COMPLETE cleanup instead:
                // it drives the outstanding drivable content (Vaal-Beacon dwell) and portals when only passive/unreachable
                // remains. Flag OFF (or a genuine live 2nd boss) -> fall through to the original reacquire (byte-parity).
                const liveSecondBoss = objGoalOn()
                  && (() => { const d = getMainDefeatObjectiveInfo(); return d.hasDefeatObjective && !d.isCompleted; })();   // read only when flag-on (strict parity)
                if (objGoalOn() && !liveSecondBoss) {
                  log(`Tracked unique died; no live Defeat objective -> content cleanup (MAP_COMPLETE), not boss re-acquire (outstanding=${hasOutstandingObjectives(now)})`);
                  bossEntityId = 0;
                  bossFound = false;
                  bossCandidateId = 0;
                  bossDead = true;
                  sendStopMovementLimited(true);
                  mapCompleteBossDeathX = Number.isFinite(e.gridX) ? e.gridX : player.gridX;
                  mapCompleteBossDeathY = Number.isFinite(e.gridY) ? e.gridY : player.gridY;
                  setState(STATE.MAP_COMPLETE);
                  break;
                }
                // SAME-ARENA HANDOFF (twin-boss): before round-tripping FINDING_BOSS, hand off directly to the nearest
                // still-alive arena unique that matches an outstanding "Defeat X" line (e.g. Akthi dead -> Anundr live in
                // the same room). Stays in FIGHTING_BOSS and re-seeds the intro timers so press-in/orbit re-engage without
                // re-running find/approach for a boss already present.
                const liveHandoff = (arenaBossUniques || [])
                  .filter(b => b && b.id && b.id !== e.id && b.isAlive && isEntityLikelyMainObjectiveBoss(b))
                  .sort((a, b) =>
                    Math.hypot(a.gridX - player.gridX, a.gridY - player.gridY) -
                    Math.hypot(b.gridX - player.gridX, b.gridY - player.gridY))[0];
                if (liveHandoff) {
                  bossEntityId = liveHandoff.id;
                  bossCandidateId = liveHandoff.id;
                  bossFound = true;
                  bossGridX = liveHandoff.gridX;
                  bossGridY = liveHandoff.gridY;
                  bossFightEngagedAt = now;
                  const hn = (liveHandoff.renderName || liveHandoff.name || 'Unknown').split('/').pop();
                  log(`Tracked boss died; same-arena handoff to live objective boss "${hn}" (ID:${bossEntityId}) -- staying in fight`);
                  break;
                }
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
        // PRESS-IN-TO-ACTIVATE: track HP drops (keyed to the tracked id) so a proximity-gated phase can be detected as a
        // stall. One field read + compare per FIGHTING_BOSS tick. NOT kite-gated: staged-intro bosses (Anim-idle at full
        // HP, e.g. Incarnation of Death) need the walk-up regardless of the kite toggle or they never start.
        let needProximityActivation = false;
        let bossDormantForCentre = false;   // idle-loop boss at full HP -> press-in drives to arena centre to aggro it
        if (trackedBossEntity) {
          const _bid = trackedBossEntity.id || 0;
          if (_bid !== pressInHpBossId) {          // boss swap (2-boss / proxy collapse): re-seed, do not diff across ids
            pressInHpBossId = _bid;
            pressInLastHpValue = NaN;
            pressInLastDropAt = now;
          }
          const _hpNow = Number(trackedBossEntity.healthCurrent);
          if (Number.isFinite(_hpNow)) {
            if (Number.isFinite(pressInLastHpValue) && _hpNow < pressInLastHpValue - 1) {
              pressInLastDropAt = now;             // real damage landed -> not stalled
            }
            pressInLastHpValue = _hpNow;
          }
          const STALL_MS = 4500;                   // HP flat this long while engaged == phase-gate suspected
          const engagedFor = now - bossFightEngagedAt;
          const phaseStalled = engagedFor > STALL_MS && (now - pressInLastDropAt) > STALL_MS;
          // DORMANT-IDLE correction: bossIsActing returns TRUE for an idle-loop animation (getEntityActionRemainingSec
          // reads the Anim_NNNN loop's remaining verbatim), which permanently kills the press-in gate for a boss that is
          // standing idle at full HP. When hasActiveAction=false AND currentActionTypeId=0 the boss is genuinely idle (not
          // mid-action), so do not count the idle-loop as "acting". Gated behind fightActivateDormantBoss (default ON).
          const activateDormant = currentSettings.fightActivateDormantBoss !== false;
          const bossGenuinelyIdle = trackedBossEntity.hasActiveAction === false
            && (Number(trackedBossEntity.currentActionTypeId) || 0) === 0;
          const bossActing = bossIsActing(trackedBossEntity, now) && !(activateDormant && bossGenuinelyIdle);
          // Press in ONLY when: boss is (immune past the intro) OR stalled OR intro-idle, NOT mid-action, and a normal
          // engage has had a beat. bossActing=false is the death-guard; auto_dodge (runs earlier, 520ms move-suppress) is the backstop.
          const immuneReady = trackedBossEntity.cannotBeDamaged === true && engagedFor > 3500; // skip un-dodgeable intro
          // STAGED-INTRO fast path: UNTOUCHED (full HP) + idle after 2s of "fighting" = the boss hasn't STARTED (it
          // activates on proximity) -> walk up now instead of waiting out the stall window.
          const introIdle = Number.isFinite(_hpNow) && Number(trackedBossEntity.healthMax) > 0
            && _hpNow === Number(trackedBossEntity.healthMax) && engagedFor > 2000;
          needProximityActivation = (immuneReady || phaseStalled || introIdle) && !bossActing && engagedFor > 1500;
          bossDormantForCentre = activateDormant && bossGenuinelyIdle && introIdle;
        }
        if (trackedBossEntity && !postDodgeLock) {
          const _bd = Math.hypot(player.gridX - trackedBossEntity.gridX, player.gridY - trackedBossEntity.gridY);
          if (needProximityActivation) {
            // PRESS IN: drive toward the boss to a small activation distance. Movement routes through sendMoveGridLimited,
            // which auto_dodge's dodgeMoveSuppressUntil blocks for 520ms after any dodge -- so a telegraph mid-press halts
            // the advance even if this tick's gate was open.
            const PRESS_IN_DIST = 12;
            // DORMANT twins aggro when the player reaches the MIDDLE of the arena, not when it reaches the (off-centre,
            // idle) boss entity -- so for a genuinely-idle full-HP boss, drive to the arena centroid; hand back to the boss
            // once HP starts dropping or it begins acting (bossDormantForCentre goes false). Falls back to the boss entity
            // when the centroid isn't resolvable yet.
            let pgx = trackedBossEntity.gridX, pgy = trackedBossEntity.gridY, pressCentre = false;
            if (bossDormantForCentre) {
              const c = getBossArenaCentroid();
              if (c && Number.isFinite(c.gx) && Number.isFinite(c.gy)) { pgx = c.gx; pgy = c.gy; pressCentre = true; }
            }
            const _pd = pressCentre ? Math.hypot(player.gridX - pgx, player.gridY - pgy) : _bd;
            if (_pd > PRESS_IN_DIST + 2) {
              stepFightDirectMove(player, pgx, pgy, now, PRESS_IN_DIST);
            } else {
              sendStopMovementLimited();
            }
            bossFightOrbitWaypointX = 0; bossFightOrbitWaypointY = 0;
            statusMessage = pressCentre
              ? `Press-in: to arena centre ${Math.round(_pd)}->${PRESS_IN_DIST}u (trigger dormant boss)`
              : (trackedBossEntity.cannotBeDamaged === true
                ? `Press-in: boss IMMUNE ${Math.round(_bd)}->${PRESS_IN_DIST}u (activate phase)`
                : `Press-in: boss STALLED ${((now - pressInLastDropAt) / 1000).toFixed(0)}s ${Math.round(_bd)}->${PRESS_IN_DIST}u`);
            break; // hand this tick to the press-in; kite/orbit resume next tick once the gate clears
          }
          // RANGED-KITE (opt-in): kiteBoss ON raises the floor to the bow stand-off so ANY boss inside bow range triggers
          // the existing radial retreat (sustained -- reassigns each pass while inside, stepFightDirectMove walks it).
          // Because the orbit radius (55-58u) is INSIDE the raised floor, kiteFloorEngaged stays true and suppresses the
          // orbit, so the bot HOLDS at the floor instead of ping-ponging 58<->81. OFF = 46 verbatim (melee: floor below the
          // 58u orbit -- byte-parity).
          const KITE_FLOOR = kiteBossOn() ? kiteStandoff() : 46;
          if (_bd < KITE_FLOOR) {
            // When kiting, retreat to the floor ITSELF (delta 0) so the settle point == stand-off band; the orbit (55-58u)
            // stays inside the floor and remains suppressed, avoiding the 58<->81 radial yoyo. OFF = +12 verbatim.
            const _rt = pickRadialRetreatWaypoint(player.gridX, player.gridY, trackedBossEntity.gridX, trackedBossEntity.gridY, kiteBossOn() ? KITE_FLOOR : KITE_FLOOR + 12);
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
      // SUPPRESSED while the content sweep is actively DRIVING (abyss hover / hive defense / beacon dwell): fight damage
      // there is expected and the holds own their positioning -- escaping mid-abyss ran the bot OFF the node. The dodge
      // still handles real telegraphs; this fallback only owns the walked-into-death-ground case between drives.
      const _contentDriving = now - mapCompleteContentDriveAt < 2500;
      if (hpValid && !_contentDriving) {
        if (mapCompleteLastHp > 0 && hpCur < mapCompleteLastHp) {
          mapCompleteDangerDetectedAt = now;
          // New danger episode: reset attempt counter after a quiet period.
          if (now - mapCompleteDangerLastEscapeAt > 2200) {
            mapCompleteDangerEscapeAttempts = 0;
          }
        }
        mapCompleteLastHp = hpCur;
      }

      if (mapCompleteDangerDetectedAt > 0 && !_contentDriving) {
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

      // No fresh kill (boss was already dead on entry) -> no drops to settle; fast-forward past Phases 1-3 to the sweep.
      if (mapCompleteSkipSettle && !mapCompleteRetreatReachedAt) mapCompleteRetreatReachedAt = now - cfg.waitMs - cfg.utilityMs - 1;
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

      // (Phase 3.5 Precursor Beacon moved BELOW the content cleanup: it is now the FINAL act before the portal,
      // at ANY distance -- see the block after Phase 3.75.)

      // Phase 3.75: objectiveGoalMode CONTENT CLEANUP -- best-effort, HARD time-capped. AFTER the loot/utility window +
      // beacon, BEFORE the portal. Only when: master flag ON, auto-return ON, and the base-game objective checklist still
      // shows an outstanding drivable+enabled objective (breach/abyss/incursion/verisium not yet [x]). Post-boss there is
      // nothing else to do, so tryCleanupContent clears ALL reachable content (wide radius, no boss-route detour), reusing
      // the runners + revisitSkip unreachable-ban + the commit-latch (no yoyo). NEVER traps -- three independent exits:
      //   (a) budget spent (mapCompleteCleanupStartAt seeded at entry, never reset by activity)  -> leave
      //   (b) nothing reachable for OBJ_CLEANUP_NOPROGRESS_MS (unreachable-island fast-out)       -> leave
      //   (c) hasOutstandingObjectives fails OPEN (base-game read fails -> false)                 -> leave
      // Flag OFF => objGoalOn() short-circuits FIRST (hasOutstandingObjectives/readMapObjectiveState never called, timer
      // never read) => control flow falls straight through to Phase 4 => BYTE-PARITY with today's boss-only leave.
      // Boss-on-the-way model: the cleanup owns EVERYTHING left -- required (any distance), deferred optional (queued), and
      // UNFOUND listed content (discovery explore). Gate stays open for any of the three; each has its own bound. Once it
      // CONCEDES (budget spent / nothing reachable) the done-latch keeps it closed -> on to the portal phase, no re-entry.
      // NOT gated on mapCompleteAutoReturnToHideout: the sweep finishes the MAP; auto-return only gates the PORTAL below
      // (otherwise return-disabled silently skips the whole post-boss sweep and deferred objectives never get done).
      if (objGoalOn() && !mapCompleteCleanupDone
          && (hasOutstandingObjectives(now) || (ARBITER && hasPreBossContentToDo(now)) || hasUnfoundListedContent(now))) {
        if (!mapCompleteCleanupStartAt) mapCompleteCleanupStartAt = now;      // defensive lazy seed (normally seeded at MAP_COMPLETE entry)
        // PROGRESS-REFRESH: each completed objective instance buys a fresh budget window (a multi-beacon + breach sweep
        // needs more than one flat budget; a STUCK runner never refreshes -- only completions do, so this can't trap).
        const _outstandingNow = (() => {
          let n = 0;
          try { for (const [k, e] of contentQueue) if (e && e.state === 'active' && typeShouldRun(e.type, now) && !objectiveTypeComplete(e.type, now) && !lockIsDone(e.type, e.id, now) && !(e.type === 'incursion-beacon' && isBeaconEnergisedAt(e.gridX, e.gridY))) n++; } catch (_) {}
          try { const st = readMapObjectiveState(now); const req = getRequiredObjectiveNames(now); for (const nm of req) if (nm !== 'MapBoss' && st[nm] === 0) n++; } catch (_) {}
          return n;
        })();
        if (mapCompleteProgressCount < 0) mapCompleteProgressCount = _outstandingNow;
        else if (_outstandingNow < mapCompleteProgressCount) { mapCompleteProgressCount = _outstandingNow; mapCompleteCleanupStartAt = now; log(`[Cleanup] objective completed (${_outstandingNow} left) -> budget refreshed`); }
        else if (_outstandingNow > mapCompleteProgressCount) mapCompleteProgressCount = _outstandingNow;   // new content discovered/streamed
        const cleanupElapsed = now - mapCompleteCleanupStartAt;
        if (cleanupElapsed < OBJ_CLEANUP_BUDGET_MS) {
          // POST-BOSS always drives with tryCleanupContent (regardless of ARBITER): it owns the walk-to-far-content leg
          // and beaconArrivalDwell (the proximity-variant Vaal Beacon energise) that the arbiter's runners lack -- the
          // arbiter's route-insertion weighting is a PRE-boss concern (there is no boss route to weigh against here).
          if (!ARBITER) arbTick(player, now);   // shadow-log the postboss pick under the legacy flag
          if (tryCleanupContent(player, now)) {
            mapCompleteCleanupNoProgressSince = 0;                           // real progress -> reset the fast-out clock
            mapCompleteContentDriveAt = now;                                 // actively driving -> death-ground escape stands down
            _cleanupDriveAt = now;                                           // cleanup owns the walk -> discover stays out for 5s
            break;                                                           // HOLD in MAP_COMPLETE -- do NOT portal yet
          }
          // Nothing queued is reachable -> if the map still LISTS an unfound drivable type, explore to find it (bounded
          // by DISCOVER_EXPLORE_MS + the discoverConceded latch inside). DISCOVER IS A FALLBACK, NOT A CO-DRIVER: it
          // only gets the frame when cleanup has driven nothing for 5s -- interleaving the two writers livelocked the
          // walk (cleanup toward queued verisium, discover toward an unfound breach, 2s apart, arriving nowhere).
          if (now - _cleanupDriveAt > 5000 && tryDiscoverListedContent(player, now)) {
            mapCompleteCleanupNoProgressSince = 0;
            mapCompleteContentDriveAt = now;                                 // walking-to-reveal IS content-driving: the death-ground escape must not hijack it (it stalls the walk -> buckets get blacklisted)
            break;                                                           // HOLD -- revealing the map for the unfound content
          }
          // Nothing reachable THIS frame. Content may re-stream, so allow a grace before conceding (walk/reveal legs return
          // true, so this only accrues when truly nothing is eligible). REQUIRED outstanding -> much more patient: it must
          // outlast the short required stuck-bans (6-8s) so a fog-blocked beacon gets its retry, not a premature portal.
          // REQUIRED outstanding: be patient enough to outlast any ban currently hiding a required target (the
          // deliberate 60-120s arb-TTL / hive-beacon dwell-cap bans), else a still-retryable required objective is
          // conceded while merely ban-hidden -> premature portal with the objective pending. Bounded by the
          // OBJ_CLEANUP_BUDGET_MS gate above. Optional-only content keeps the short fast-out.
          let _fastOutMs = OBJ_CLEANUP_NOPROGRESS_MS;
          // ACTIVE drivable content still queued (e.g. an un-energised incursion beacon) deserves the same patience
          // as required objectives -- the 4s fast-out was firing mid-walk and portaling out with content outstanding.
          // BAN-HIDDEN active content (user: 'HOW CAN U SAY NOTHING REMAINS with abyss still up'): a 30-90s stuck-ban
          // was hiding the entry while the 20s fast-out left the map. WAIT the ban out; the overall cleanup budget
          // still bounds the tail.
          try {
            let _banExp = 0;
            for (const [k, e] of contentQueue) {
              if (!(e && e.state === 'active' && typeShouldRun(e.type, now) && !objectiveTypeComplete(e.type, now))) continue;
              if (e.type === 'incursion-beacon' && isBeaconEnergisedAt(e.gridX, e.gridY)) continue;
              _fastOutMs = Math.max(_fastOutMs, 20000);
              const _b = revisitSkip.get(k) || 0;
              if (_b > now) _banExp = Math.max(_banExp, _b);
            }
            if (_banExp > now) _fastOutMs = Math.max(_fastOutMs, (_banExp - now) + 1500);
          } catch (_) {}
          if (hasOutstandingObjectives(now)) {
            _fastOutMs = 20000;
            const _reqBanExp = soonestRequiredBanExpiry(now);
            if (_reqBanExp > now) _fastOutMs = Math.max(_fastOutMs, (_reqBanExp - now) + 1500);   // +1.5s so the un-banned target gets an actual retry frame
          }
          if (mapCompleteCleanupNoProgressSince === 0) mapCompleteCleanupNoProgressSince = now;
          // Anti-guillotine: pickit/opener actively collecting (serviced <2.5s ago) or drops still in range =
          // work in flight -> the "nothing reachable" clock must not tick against it.
          if (lootStillLeft(70) || (now - utilityLastServicedAt) < 2500) mapCompleteCleanupNoProgressSince = now;
          // UNFOUND-LISTED content with discover NOT yet conceded: discover's own bounded window (40s optional /
          // 90s required) + concede latch is the authoritative give-up for the unfound case -- the generic 4s
          // fast-out must not race it (it portaled out while discover was still banning arena buckets, leaving
          // the map's Breach undone). Bounded: discoverConceded latches when the window is spent.
          if (!discoverConceded && hasUnfoundListedContent(now)) mapCompleteCleanupNoProgressSince = now;
          if (now - mapCompleteCleanupNoProgressSince < _fastOutMs) {
            const budgetLeft = ((OBJ_CLEANUP_BUDGET_MS - cleanupElapsed) / 1000).toFixed(0);
            statusMessage = `Map complete: content remains, nothing reachable... (${budgetLeft}s budget left)`;
            break;
          }
          log(`[Cleanup] outstanding objectives but nothing reachable for ${(_fastOutMs / 1000).toFixed(0)}s -> leaving anyway`);
        } else {
          log(`[Cleanup] budget ${(OBJ_CLEANUP_BUDGET_MS / 1000) | 0}s spent, content still outstanding -> leaving anyway`);
        }
        // best-effort exhausted -> LATCH done + fall through to Phase 4 (portal). NEVER trap the bot in the map.
        mapCompleteCleanupDone = true;
      }

      // Phase 3.9: Precursor (Tower) Beacon -- the FINAL act before the portal, at ANY DISTANCE (user: 'I don't
      // give a shit if it's 500+, GO TO IT'). Walk the REMEMBERED position with the fog-independent macro route
      // (the entity may de-stream mid-walk), re-acquire to interact when close. Distance is not the risk --
      // getting stuck is: bounded by a 120s leg budget + owned no-progress (12s) + an 8s acquire window.
      if (currentSettings.activatePrecursorBeacon !== false && !precursorBeaconActivatedThisMap) {
        const beacon = findPrecursorBeacon(player, now);
        if (beacon && !Number.isFinite(pbWalkX)) { pbWalkX = beacon.gridX; pbWalkY = beacon.gridY; pbWalkStartAt = now; log(`[Precursor] beacon at (${Math.round(pbWalkX)},${Math.round(pbWalkY)}) ${beacon._d.toFixed(0)}u -> walking (any distance)`); }
        if (Number.isFinite(pbWalkX)) {
          const _pbD = Math.hypot(pbWalkX - player.gridX, pbWalkY - player.gridY);
          const _pbNoProg = trackOwnedProgress(_pbTrack, 'pb', _pbD, targetName === 'Precursor Beacon', now);
          if (now - pbWalkStartAt > 120000 || _pbNoProg > 12000) {
            log(`[Precursor] beacon leg gave up (${now - pbWalkStartAt > 120000 ? 'budget spent' : 'no progress 12s'}) -> portal`);
            precursorBeaconActivatedThisMap = true;
          } else if (_pbD > 22) {
            if ((targetName !== 'Precursor Beacon' || currentPath.length === 0) && now - lastRepathTime > 1500) startWalkingTo(pbWalkX, pbWalkY, 'Precursor Beacon', 'boss');
            const _pbs = stepPathWalker();
            if (_pbs === 'stuck') { addSoftBlock(player.gridX, player.gridY); currentPath = []; }
            statusMessage = `Map complete: -> Precursor Beacon ${_pbD.toFixed(0)}u`;
            break;
          } else if (beacon && beacon._d <= 30) {
            if (now - precursorBeaconInteractAt >= 1400) {
              precursorBeaconInteractAt = now;
              interactWithEntity(beacon);                                       // 01A3 interact (press)
              try { poe2.sendPacket(new Uint8Array([0x01, 0xAA, 0x01])); } catch (_) {}  // 01AA release
              log(`[Precursor] activated Tower Beacon id=${beacon.id}`);
              precursorBeaconActivatedThisMap = true;
            }
            statusMessage = `Map complete: activating Precursor Beacon`;
            break;
          } else {
            // at the remembered spot but the entity isn't resolving -> brief acquire window, then concede
            if (!pbAcquireAt) pbAcquireAt = now;
            if (now - pbAcquireAt > 8000) { log('[Precursor] at beacon spot, entity never resolved -> portal'); precursorBeaconActivatedThisMap = true; }
            sendStopMovementLimited();
            statusMessage = `Map complete: at beacon spot, acquiring...`;
            break;
          }
        }
      }

      // Phase 4: return to hideout by taking nearest portal.
      if (!currentSettings.mapCompleteAutoReturnToHideout) {
        statusMessage = `Map complete: return disabled`;
        break;
      }
      // LOOT+OPENER GATE (user): never portal out while pickit still has matching drops OR the opener still has
      // unopened targets in range (Precursor Relay, strongboxes, chests -- the relay was skipped at 91u because
      // this gate only counted loot). Holding here re-opens the utility window so the selector walks to them.
      // Bounded to 45s so an unpickable/unopenable target can't trap the map forever.
      try {
        if (!_portalLootHoldAt) _portalLootHoldAt = now;
        if (now - _portalLootHoldAt < 45000) {
          const _lootLeft = (getLootCandidatesForMapper(80) || []).length;
          if (now - _portalOpenChkAt > 800) {
            _portalOpenChkAt = now;
            try { _portalOpenLeft = (getOpenableUtilityCandidates(player) || []).length; } catch (_) { _portalOpenLeft = 0; }
          }
          if (_lootLeft > 0 || _portalOpenLeft > 0 || (now - utilityLastServicedAt) < 2500) {
            mapCompleteUtilityExtendUntil = now + 2500;   // let tryStartUtilityNavigation pick them up
            statusMessage = `Map complete: sweeping (${_lootLeft} loot, ${_portalOpenLeft} openable left)`;
            sendStopMovementLimited();
            break;
          }
        }
      } catch (_) {}

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
  const mbEnf = new ImGui.MutableVariable(currentSettings.moveBroker === true);
  if (ImGui.checkbox("Movement broker ENFORCE (one writer at a time; OFF = shadow-log conflicts)", mbEnf)) saveSetting('moveBroker', mbEnf.value);
  const kiteB = new ImGui.MutableVariable(currentSettings.kiteBoss === true);
  if (ImGui.checkbox("Ranged build: kite boss (hold bow range, never melee)", kiteB)) saveSetting('kiteBoss', kiteB.value);
  if (currentSettings.kiteBoss === true) {
    const kr = new ImGui.MutableVariable(Math.max(45, Math.min(140, Math.floor(Number(currentSettings.bossKiteRange) || 75))));
    if (ImGui.sliderInt("  Kite range (u)", kr, 45, 140)) saveSetting('bossKiteRange', kr.value);
  }
  const stopInvFull = new ImGui.MutableVariable(currentSettings.stopWhenInventoryFull !== false);
  if (ImGui.checkbox("Stop in hideout if inventory full (AFK safety)", stopInvFull)) saveSetting('stopWhenInventoryFull', stopInvFull.value);
  const drawLn = new ImGui.MutableVariable(currentSettings.drawLines !== false);
  if (ImGui.checkbox("Draw lines to things (boss + content)", drawLn)) saveSetting('drawLines', drawLn.value);
  const drawCM = new ImGui.MutableVariable(currentSettings.drawContentMarkers !== false);
  if (ImGui.checkbox("Draw content MARKERS on RadarV2 minimap (diamonds; dim=done)", drawCM)) saveSetting('drawContentMarkers', drawCM.value);

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
    // CONTENT-COMPLETION master toggle. The live objective checklist renders INLINE at the bottom (the MAP OBJECTIVES section).
    ImGui.separator();
    const objGoal = new ImGui.MutableVariable(currentSettings.objectiveGoalMode === true);
    if (ImGui.checkbox("Complete ALL objectives (not just the boss)", objGoal)) { saveSetting('objectiveGoalMode', objGoal.value); if (objGoal.value) saveSetting('mapCompleteAutoReturnToHideout', true); }   // objGoalMode REQUIRES auto-return so the post-boss content cleanup runs (else a beacon-incomplete map parks in MAP_COMPLETE)
    ImGui.setItemTooltip("OFF: kill the boss + leave. ON: also complete every present map objective (abyss/vaal/breach/verisium), then the boss. See the MAP OBJECTIVES checklist at the bottom.");
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

  // Info (legacy Temple/Boss-TGT/Boss "found" debug removed -- superseded by the MAP OBJECTIVES section below)
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

  // ---- MAP OBJECTIVES (inline checklist: base-game complete-bit + discovered/completed instance counts; cached 1/s) ----
  {
    const _nowUi = Date.now();
    if (!_objUiCache || _nowUi - _objUiAt > 1000) {   // recompute at most 1/s; the per-frame draw below is trivial
      _objUiAt = _nowUi;
      const _cl = getObjectiveChecklist(_nowUi);
      const _cc = getContentCounts(_nowUi);   // per contentQueue type -> {discovered, completed, active}; aggregate by OBJ_DRIVABLE prefix
      // boss NAME(S) from the "Defeat X" objective lines -> show EVERY outstanding boss (multi-boss maps have 2+
      // Defeat lines; each vanishes from mainObjective when that boss dies) instead of the generic "MapBoss"
      const _bossNm = (() => { try {
        const d = getMainDefeatObjectiveInfo();
        const ns = (d.bossNames && d.bossNames.length) ? d.bossNames : (d.bossName ? [d.bossName] : []);
        return ns.map(n => n.replace(/\b\w/g, c => c.toUpperCase())).join('  +  ');
      } catch (e) { return ''; } })();
      _objUiCache = {
        outstanding: hasOutstandingObjectives(_nowUi),
        rows: _cl.map(o => {
          let disc = 0, done = 0;
          if (o.type) { try { for (const k in _cc) { if (k.indexOf(o.type) === 0) { disc += _cc[k].discovered; done += _cc[k].completed; } } } catch (e) {} }
          const _dispNames = { Breach2: 'Breach Hives', Expedition2: 'Verisium', AbyssDepths: 'Abyss Depths' };
          const label = (o.name === 'MapBoss' && _bossNm) ? _bossNm : (_dispNames[o.name] || o.name);   // "[ ] Viper Napuatzi" instead of "[ ] MapBoss"
          // OBJECTIVE (required-to-leave) vs CONTENT (optional). The boss is ALWAYS an objective (user rule "always kill
          // the boss"). Sticky: once required this map it STAYS an objective in the UI even after mainObjective advances.
          if (o.required || o.name === 'MapBoss') _objUiEverReq.add(o.name);
          const objective = _objUiEverReq.has(o.name);
          return { name: o.name, label, type: o.type, complete: o.complete, drivable: o.drivable, enabled: o.enabled, required: o.required, objective, disc, done };
        }),
      };
    }
    const _ui = _objUiCache;
    if (_ui && _ui.rows.length) {
      const _rowLine = (o) => {
        const col = o.complete ? [0.4, 0.9, 0.4, 1.0] : (o.drivable && o.enabled ? [1.0, 0.8, 0.3, 1.0] : [0.6, 0.6, 0.6, 1.0]);
        ImGui.textColored(col, (o.complete ? '[x] ' : '[ ] ') + (o.label || o.name) + (o.type ? (o.enabled ? '' : ' (off)') : ' (passive)') + ((o.type && !o.complete && o.disc) ? ' -- ' + o.done + '/' + o.disc + ' done' : ''));
      };
      const _objs = _ui.rows.filter(o => o.objective);      // required-to-leave (boss + any content named in the objective block)
      const _content = _ui.rows.filter(o => !o.objective);  // optional mechanics (toggle-driven; do NOT gate leaving)
      // ---- MAP OBJECTIVES: the gate. We do NOT leave until these are complete. ----
      ImGui.separator();
      ImGui.textColored([1.0, 0.85, 0.0, 1.0], "MAP OBJECTIVES");
      ImGui.textColored(_ui.outstanding ? [1.0, 0.7, 0.2, 1.0] : [0.4, 0.9, 0.4, 1.0], _ui.outstanding ? 'Objectives OUTSTANDING' : 'Objectives clear');
      if (_objs.length) { for (const o of _objs) _rowLine(o); }
      else ImGui.textColored([0.6, 0.6, 0.6, 1.0], '(reading...)');
      // ---- MAP CONTENT: optional extras, done opportunistically per the clear* toggles. Never gates leaving. ----
      if (_content.length) {
        ImGui.separator();
        ImGui.textColored([0.3, 0.8, 1.0, 1.0], "MAP CONTENT");
        for (const o of _content) _rowLine(o);
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

  // (TGT Debug tree removed -- superseded by the MAP OBJECTIVES section)

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
// -- RadarV2 content MARKERS: small diamonds, minimap-space via setRadarPaths -> draw_paths (NOT worldToScreen) --
const ML_INC_BEACON = mlColor(0.30, 0.80, 1.00, 0.95);   // incursion Vaal beacon (cyan)
const ML_INC_CHEST  = mlColor(1.00, 0.90, 0.20, 0.95);   // incursion Vaal chest (yellow)
const ML_VERISIUM   = mlColor(1.00, 0.30, 0.60, 0.95);   // Expedition2 / Verisium remnant (magenta)
const ML_CONTENT_COLOR = { boss: ML_BOSS, abyss: ML_ABYSS, breach: ML_BRCH, verisium: ML_VERISIUM, 'incursion-beacon': ML_INC_BEACON, 'incursion-chest': ML_INC_CHEST };
const ML_MARKER_R = 10, ML_MARKER_R_DONE = 6, ML_MARKER_R_BOSS = 14;   // diamond radius in GRID units (scales with zoom; tune to taste)
// Dim a packed ABGR color for the "completed/checked" look: 40% RGB, 55% alpha, hue preserved.
function mlDim(c) {
  const a = (c >>> 24) & 0xff, b = (c >>> 16) & 0xff, g = (c >>> 8) & 0xff, r = c & 0xff;
  const d = v => Math.floor(v * 0.40);
  return (((Math.floor(a * 0.55) & 0xff) << 24) | (d(b) << 16) | (d(g) << 8) | d(r)) >>> 0;
}
// Closed 5-point diamond (grid coords) -- draw_paths renders it as an outline via DeltaInWorldToMapDelta.
function mlDiamond(gx, gy, r) { return [{ x: gx, y: gy - r }, { x: gx + r, y: gy }, { x: gx, y: gy + r }, { x: gx - r, y: gy }, { x: gx, y: gy - r }]; }
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
    // Reuse the throttled breach-mob scan cache (bestBreachMob, ~320ms) instead of a fresh UNCAPPED
    // getAllEntities here: an uncapped scan is ~59ms on a dense breach map (9k+ entities) and this draw
    // path runs every 600ms, so a separate scan just doubled the stutter for a line-persist decision.
    const breachMobsLeft = rotBreachMobCache != null;
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

// Content POSITION markers for RadarV2: read the PERSISTENT contentQueue (survives de-stream) + the boss cascade.
// active -> full type color, completed (.state) -> dimmed. Per-type gated by the clear* toggles (objDriveEnabled).
// Nearest-first + capped so the publish stays bounded (queue is tens; completed persist all map). [] on any failure.
function getContentMarkers(player, now) {
  const out = [];
  try {   // BOSS: best available position -- same cascade the lines use (tracked entity -> radar -> arena centroid).
    let bx = bossGridX, by = bossGridY;
    if (!(Number.isFinite(bx) && Number.isFinite(by) && (bx || by))) { const rb = getRadarBossTarget(); if (rb) { bx = rb.x; by = rb.y; } }
    if (!(Number.isFinite(bx) && Number.isFinite(by) && (bx || by))) { try { const c = getBossArenaCentroid(); if (c && Number.isFinite(c.gx)) { bx = c.gx; by = c.gy; } } catch (e) {} }
    if (Number.isFinite(bx) && Number.isFinite(by) && (bx || by)) out.push({ gx: bx, gy: by, type: 'boss', done: false, d: 0 });
  } catch (e) {}
  try {
    for (const e of contentQueue.values()) {
      if (!e || typeof e.type !== 'string' || !ML_CONTENT_COLOR[e.type]) continue;
      if (objectiveTypeComplete(e.type, now)) continue;                              // objective done -> no stale markers (kills the pink pile)
      const driveKey = e.type.indexOf('incursion') === 0 ? 'incursion' : e.type;   // beacon/chest -> clearIncursion
      if (!objDriveEnabled(driveKey)) continue;                                     // hide a disabled mechanic's markers
      if (!Number.isFinite(e.gridX) || !Number.isFinite(e.gridY)) continue;
      out.push({ gx: e.gridX, gy: e.gridY, type: e.type, done: e.state === 'completed', d: 0 });
    }
  } catch (e) {}
  try {   // active first, then nearest -- so the cap keeps the most relevant markers
    const px = player.gridX, py = player.gridY;
    for (const m of out) m.d = Math.hypot((m.gx || 0) - px, (m.gy || 0) - py);
    out.sort((a, b) => (a.done - b.done) || (a.d - b.d));
  } catch (e) {}
  return out.slice(0, 24);
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
  if (!isMapperMasterEnabled()) { try { poe2.setRadarPaths([]); } catch (e) {} return; }   // mapper off -> clear + release to objective auto-pather
  const linesOn = currentSettings.drawLines !== false;
  const markersOn = currentSettings.drawContentMarkers !== false;
  if (!linesOn && !markersOn) { try { poe2.setRadarPaths([]); } catch (e) {} return; }     // both off -> clear
  let player; try { player = POE2Cache.getLocalPlayer(); } catch (e) { return; }
  if (!player || player.gridX == null) return;
  const px = Math.floor(player.gridX), py = Math.floor(player.gridY);
  const routes = [];
  // (A) content ROUTES: one walkable colored line per active target (boss/breach/abyss/incursion/delirium).
  if (linesOn) {
    let targets; try { targets = gatherMapperLineTargets(player, now); } catch (e) { targets = []; }
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
  }
  // (B) content MARKERS: a small colored diamond per discovered contentQueue instance + the boss. Same minimap-space
  // projection as the lines (draw_paths -> DeltaInWorldToMapDelta -- NOT worldToScreen). active=full color, done=dim.
  // Empty label so draw_paths draws NO text. Budget keeps total routes under the 64 cap.
  if (markersOn) {
    const budget = Math.max(0, 60 - routes.length);
    let marks; try { marks = getContentMarkers(player, now); } catch (e) { marks = []; }
    for (const m of marks.slice(0, budget)) {
      if (!Number.isFinite(m.gx) || !Number.isFinite(m.gy)) continue;
      const base = ML_CONTENT_COLOR[m.type] || ML_INC_CHEST;
      const col = m.done ? mlDim(base) : base;
      const r = m.type === 'boss' ? ML_MARKER_R_BOSS : (m.done ? ML_MARKER_R_DONE : ML_MARKER_R);
      routes.push({ points: mlDiamond(Math.floor(m.gx), Math.floor(m.gy), r), color: (col >>> 0), label: '' });
    }
  }
  try { poe2.setRadarPaths(routes); } catch (e) {}
}

function onDraw() {
  drawUI();
  try { drawMapperLines(); } catch (e) {}
  if (currentSettings.drawDangerZones) { try { const _p = POE2Cache.getLocalPlayer(); if (_p) drawDangerZones(_p.worldZ); } catch (e) {} }
}

export const mapperPlugin = { name: 'Mapper', onDraw };

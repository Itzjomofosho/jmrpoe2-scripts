/**
 * Entity Actions Plugin
 *
 * Shows nearby entities with buttons to move/attack
 * Includes rotation builder for custom skill sequences
 * Settings are persisted per player
 *
 * PERFORMANCE OPTIMIZED: Uses shared POE2Cache for per-frame caching
 * NOTE: Do NOT call POE2Cache.beginFrame() here - it's called once in main.js
 */

import { POE2Cache, poe2 } from './poe2_cache.js';
import { 
  drawRotationTab, 
  executeRotationOnTarget, 
  initialize as initializeRotations,
  buildTargetPacket,
  buildSelfPacket,
  buildDirectionalPacket,
  executeChanneledSkill,
  angleToDeltas,
  findSkillByName,
  getActiveSkills,
  findNearestDeadEntity,
  findEntityNearestToCursor,
  findDeadEntityNearestToCursor,
  lastNoFireReason,
  channelArbiterTick
} from './rotation_builder.js';
import { Settings } from './Settings.js';

// Initialize rotation system
initializeRotations();

// Plugin name for settings
const PLUGIN_NAME = 'entity_actions';

// Default settings
const DEFAULT_SETTINGS = {
  maxDistance: 500,
  maxEntities: 10,
  filterMonsters: false,
  filterChests: false,
  filterNPCs: false,
  filterWorldItems: false,
  autoAttackEnabled: false,
  autoAttackDistance: 100,   // keep engagements local -- 300 default had the toggle-on bot pulling fights from across the screen
  bossTargetPriority: false, // OPT-IN: the map boss owns the target slot even when trash is closer (Snipe/Barrage land on the boss)
  autoAttackKey: ImGui.Key.E,
  autoAttackKeyCtrl: false,
  autoAttackKeyShift: false,
  autoAttackKeyAlt: false,
  autoAttackYByte: 0x01,
  autoAttackPriority: 0,  // TARGET_PRIORITY.CLOSEST
  autoAttackRarityPriority: 0,  // RARITY_PRIORITY.NONE
  autoAttackToggleMode: false,  // false = hold, true = toggle
  autoAttackVisibilityMode: 1,  // 0=Off, 1=Line of Fire, 2=Walkable LoS
  autoAttackRequireLoS: false,  // Require line of sight to target (can be slow with many mobs)
  useAttackExclusions: true,  // Enable/disable the hardcoded exclusion list
  postSuccessLockMs: 200,     // Minimum gap (ms) after a successful attack before another fires
  quickActions: []  // Array of custom quick actions
};

// Quick action targeting modes
const QUICK_ACTION_MODES = {
  TARGET: 'target',           // Cast on target entity (alive)
  DEAD_TARGET: 'dead_target', // Cast on nearest dead entity (corpse skills)
  CURSOR_TARGET: 'cursor_tgt', // Cast on entity nearest to cursor
  DEAD_CURSOR_TARGET: 'dead_cursor_tgt', // Cast on dead entity nearest to cursor
  SELF: 'self',               // Cast on self
  DIRECTION_TO_TARGET: 'dir_target',  // Cast in direction toward target
  CURSOR: 'cursor'            // Cast in cursor direction
};

// Quick action state
let quickActions = [];
let editingQuickActionIndex = -1;
let waitingForQuickActionKey = -1;  // Index of quick action waiting for key bind
const quickActionCooldowns = {};     // Track cooldowns per quick action

// Keybind capture state
let waitingForHotkey = false;

// Current settings (will be loaded from file)
let currentSettings = { ...DEFAULT_SETTINGS };
let currentPlayerName = null;
let settingsLoaded = false;

// Settings - using MutableVariable for ImGui bindings
const maxDistance = new ImGui.MutableVariable(DEFAULT_SETTINGS.maxDistance);
const maxEntities = new ImGui.MutableVariable(DEFAULT_SETTINGS.maxEntities);
const filterMonsters = new ImGui.MutableVariable(DEFAULT_SETTINGS.filterMonsters);
const filterChests = new ImGui.MutableVariable(DEFAULT_SETTINGS.filterChests);
const filterNPCs = new ImGui.MutableVariable(DEFAULT_SETTINGS.filterNPCs);
const filterWorldItems = new ImGui.MutableVariable(DEFAULT_SETTINGS.filterWorldItems);

// Auto-attack settings
const autoAttackEnabled = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackEnabled);
const autoAttackDistance = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackDistance);
const autoAttackKey = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackKey);
const autoAttackKeyCtrl = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackKeyCtrl);
const autoAttackKeyShift = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackKeyShift);
const autoAttackKeyAlt = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackKeyAlt);
const autoAttackYByte = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackYByte);
const autoAttackToggleMode = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackToggleMode);
const autoAttackVisibilityMode = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackVisibilityMode);
const autoAttackRequireLoS = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackRequireLoS);
const postSuccessLockMs = new ImGui.MutableVariable(DEFAULT_SETTINGS.postSuccessLockMs);
let lastAutoAttackTime = 0;
const autoAttackCooldown = 100;  // ms between attacks
let lastTargetName = "";
let lastTargetId = 0;
let lastTargetHP = 0;
let lastTargetMaxHP = 0;
let lastTargetRarity = 0;
let isWaitingForKey = false;
let wasAttackKeyDown = false;  // Track key state for release detection
let autoAttackToggleActive = false;  // Track toggle state
let autoAttackHadTargetLastTick = false;  // Track transition to no-target state for stop packet
// The game REPEATS the last attack action server-side until a stop-action or a replacing action
// arrives. If a target stays selected but NO skill's conditions pass for it (e.g. it sits between
// the skills' distance gates and autoAttackDistance), nothing is cast or logged and no stop is
// sent, so the character keeps firing at nothing until the player moves. The rotation reports WHY
// it didn't cast (lastNoFireReason); 'no-skill-eligible' -> release the repeat immediately.
let idleStopSent = false;     // stop already sent for the current nothing-eligible stretch
let stopResendAt = 0;         // one-shot re-send of the target-loss stop (stop packets can drop too)

// LoS cache to avoid expensive checks every frame
const losCache = new Map();  // entityId -> { result: boolean, timestamp: number }
const LOS_CACHE_TTL = 500;  // Cache LoS results for 500ms

// Hardcoded attack exclusion list - entities matching these patterns will be ignored
// Add patterns here to exclude specific entity types from auto-attack
const ATTACK_EXCLUSION_LIST = [
  'CurseZones',
  'TormentedSpirits',  // roaming neutral spirits (Spirit of the Owl etc). Game marks them isHostile=true,
                       // but touching/attacking one POSSESSES a monster -- don't auto-attack. Path-matched.
  'BossCannon',        // boss-spawned cannon PROPS (Pirates/CaptainRothBossCannon). The MonsterVariety+0x8A
                       // "structural" approach was REVERTED -- that byte is a type/category value, NOT a
                       // targetability flag (read 5 for Vaal mobs, 0 for a real rare -> over-excluded). Name-match is reliable.
  'SkitterMine',       // Vaal skitter MINES (VaalHumanoid...CannonLightningSkitterMine) -- deployed hazards, not real mobs.
  'Metadata/NPC/',     // friendly NPCs. Alva (NPC/League/Incursion/AlvaIncursionAccessSummon) reads as a
                       // full hostile MonsterUnique (reaction=2, entityType Monster, rarity 3) -- the reaction
                       // word is byte-identical to a real enemy, so the PATH is the only reliable friendly signal.
];
const useAttackExclusions = new ImGui.MutableVariable(true);

// Bosses that are permanently un-highlightable but ARE valid targets (large structure/Titan
// bosses). Matched against entity.name (metadata path) and renderName. These bypass ONLY the
// isHighlightable veto - every other gate still applies. Do NOT add normal mobs here: targetable-
// but-not-highlightable is also how floor/burrowed mobs read before they rise, and those must
// stay excluded.
const HIGHLIGHTABLE_OVERRIDE_LIST = [
  'TitanBoss/TitanBoss',  // Zalmarath, the Colossus. NOTE: the TitanBoss/ folder ALSO holds
                          // RoofTarget/VolatileSpawner/shatterXblocking/LootProxy monsters - match
                          // the full base path, NEVER just 'TitanBoss', or those get force-targeted.
  'Zalmarath'
];

// Rarity name helper
function getRarityName(rarity) {
  switch (rarity) {
    case RARITY.UNIQUE: return "Unique";
    case RARITY.RARE: return "Rare";
    case RARITY.MAGIC: return "Magic";
    case RARITY.NORMAL: return "Normal";
    default: return "Unknown";
  }
}

// Rarity color helper (for UI display)
function getRarityColor(rarity) {
  switch (rarity) {
    case RARITY.UNIQUE: return [1.0, 0.5, 0.0, 1.0];   // Orange
    case RARITY.RARE: return [1.0, 1.0, 0.0, 1.0];    // Yellow
    case RARITY.MAGIC: return [0.5, 0.5, 1.0, 1.0];   // Blue
    case RARITY.NORMAL: return [0.8, 0.8, 0.8, 1.0];  // White/Gray
    default: return [0.7, 0.7, 0.7, 1.0];
  }
}

// Target priority modes (secondary sort)
const TARGET_PRIORITY = {
  CLOSEST: 0,
  FURTHEST: 1,
  HIGHEST_MAX_HP: 2,
  HIGHEST_CURRENT_HP: 3,
  LOWEST_CURRENT_HP: 4
};

const TARGET_PRIORITY_NAMES = {
  [TARGET_PRIORITY.CLOSEST]: "Closest",
  [TARGET_PRIORITY.FURTHEST]: "Furthest",
  [TARGET_PRIORITY.HIGHEST_MAX_HP]: "Highest Max HP",
  [TARGET_PRIORITY.HIGHEST_CURRENT_HP]: "Highest Current HP",
  [TARGET_PRIORITY.LOWEST_CURRENT_HP]: "Lowest Current HP"
};

// Visibility check modes for auto-attack filtering.
const AUTO_ATTACK_VISIBILITY_MODE = {
  OFF: 0,
  LINE_OF_FIRE: 1,
  LINE_OF_SIGHT: 2
};

const AUTO_ATTACK_VISIBILITY_MODE_NAMES = {
  [AUTO_ATTACK_VISIBILITY_MODE.OFF]: "Off",
  [AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_FIRE]: "Line of Fire",
  [AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_SIGHT]: "Walkable LoS"
};

// Rarity priority (primary filter/sort)
const RARITY_PRIORITY = {
  NONE: 0,           // No rarity preference
  UNIQUE_FIRST: 1,   // Unique > Rare > Magic > Normal
  RARE_FIRST: 2,     // Rare > Unique > Magic > Normal (skip uniques)
  MAGIC_FIRST: 3,    // Magic > Rare > Unique > Normal
  NORMAL_FIRST: 4    // Normal first (clear trash)
};

const RARITY_PRIORITY_NAMES = {
  [RARITY_PRIORITY.NONE]: "None (ignore rarity)",
  [RARITY_PRIORITY.UNIQUE_FIRST]: "Unique first",
  [RARITY_PRIORITY.RARE_FIRST]: "Rare first",
  [RARITY_PRIORITY.MAGIC_FIRST]: "Magic first",
  [RARITY_PRIORITY.NORMAL_FIRST]: "Normal first (clear trash)"
};

// Rarity values (from game data - higher = rarer)
const RARITY = {
  NORMAL: 0,
  MAGIC: 1,
  RARE: 2,
  UNIQUE: 3
};

// BANK of the boss-invulnerability finding (live-RE, Manassa + others): a boss phasing into its
// out-of-range immunity window carries the buff no_players_in_range_immunity while its HP is frozen.
// When the CURRENT target carries it, the rotation holds fire (throttled log) and prefers any other
// eligible target -- a real "can't damage me" signal that replaces blind-firing + the 3.5s hp-frozen
// waste. Flag off = today's blind-fire + the generic hp-frozen backstop (untouched). Exact-name match.
const INVULN_GATE_ON = true;
const INVULN_IMMUNITY_BUFF = 'no_players_in_range_immunity';

// TASK-37 B1: one-way cast bus. Stamp POE2Cache.lastRotationCastAt on every rotation cast so the mapper's posture
// idle-detector can tell "actively casting" without the player action fields (those read dead mid-attack --
// Vastweld capture: anim=1086 act=0). Publish-only here; the mapper reads it under its own flag.
const IDLE_DETECT_BUS_ON = true;

const autoAttackPriority = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackPriority);
const autoAttackRarityPriority = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackRarityPriority);
const bossTargetPriority = new ImGui.MutableVariable(DEFAULT_SETTINGS.bossTargetPriority);

/**
 * Load settings for the current player
 */
function loadPlayerSettings() {
  const player = POE2Cache.getLocalPlayer();
  if (!player || !player.playerName) {
    return false;
  }
  
  // Check if player changed
  if (currentPlayerName !== player.playerName) {
    currentPlayerName = player.playerName;
    currentSettings = Settings.get(PLUGIN_NAME, DEFAULT_SETTINGS);
    
    // Apply loaded settings to MutableVariables
    maxDistance.value = currentSettings.maxDistance;
    maxEntities.value = currentSettings.maxEntities;
    filterMonsters.value = currentSettings.filterMonsters;
    filterChests.value = currentSettings.filterChests;
    filterNPCs.value = currentSettings.filterNPCs;
    filterWorldItems.value = currentSettings.filterWorldItems;
    autoAttackEnabled.value = currentSettings.autoAttackEnabled;
    autoAttackDistance.value = currentSettings.autoAttackDistance;
    autoAttackKey.value = currentSettings.autoAttackKey;
    autoAttackKeyCtrl.value = currentSettings.autoAttackKeyCtrl || false;
    autoAttackKeyShift.value = currentSettings.autoAttackKeyShift || false;
    autoAttackKeyAlt.value = currentSettings.autoAttackKeyAlt || false;
    autoAttackYByte.value = currentSettings.autoAttackYByte;
    autoAttackPriority.value = currentSettings.autoAttackPriority;
    autoAttackRarityPriority.value = currentSettings.autoAttackRarityPriority;
    bossTargetPriority.value = currentSettings.bossTargetPriority === true;
    autoAttackToggleMode.value = currentSettings.autoAttackToggleMode || false;
    // Backward compatibility:
    // - New setting: autoAttackVisibilityMode
    // - Legacy setting: autoAttackRequireLoS (boolean)
    if (typeof currentSettings.autoAttackVisibilityMode === 'number') {
      autoAttackVisibilityMode.value = currentSettings.autoAttackVisibilityMode;
    } else {
      const legacyRequireLoS = currentSettings.autoAttackRequireLoS || false;
      autoAttackVisibilityMode.value = legacyRequireLoS
        ? AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_FIRE
        : AUTO_ATTACK_VISIBILITY_MODE.OFF;
    }
    autoAttackRequireLoS.value = autoAttackVisibilityMode.value !== AUTO_ATTACK_VISIBILITY_MODE.OFF;

    // Post-success lock (backward-compatible default)
    if (typeof currentSettings.postSuccessLockMs === 'number') {
      postSuccessLockMs.value = currentSettings.postSuccessLockMs;
    }

    // Load quick actions
    quickActions = currentSettings.quickActions || [];
    
    console.log(`[EntityActions] Loaded settings for player: ${player.playerName} (${quickActions.length} quick actions)`);
    settingsLoaded = true;
    return true;
  }
  return false;
}

/**
 * Save a single setting
 */
function saveSetting(key, value) {
  currentSettings[key] = value;
  Settings.set(PLUGIN_NAME, key, value);
}

/**
 * Save all current settings
 */
function saveAllSettings() {
  currentSettings.maxDistance = maxDistance.value;
  currentSettings.maxEntities = maxEntities.value;
  currentSettings.filterMonsters = filterMonsters.value;
  currentSettings.filterChests = filterChests.value;
  currentSettings.filterNPCs = filterNPCs.value;
  currentSettings.filterWorldItems = filterWorldItems.value;
  currentSettings.autoAttackEnabled = autoAttackEnabled.value;
  currentSettings.autoAttackDistance = autoAttackDistance.value;
  currentSettings.autoAttackKey = autoAttackKey.value;
  currentSettings.autoAttackKeyCtrl = autoAttackKeyCtrl.value;
  currentSettings.autoAttackKeyShift = autoAttackKeyShift.value;
  currentSettings.autoAttackKeyAlt = autoAttackKeyAlt.value;
  currentSettings.autoAttackYByte = autoAttackYByte.value;
  currentSettings.autoAttackPriority = autoAttackPriority.value;
  currentSettings.autoAttackRarityPriority = autoAttackRarityPriority.value;
  currentSettings.bossTargetPriority = bossTargetPriority.value;
  currentSettings.autoAttackToggleMode = autoAttackToggleMode.value;
  currentSettings.autoAttackVisibilityMode = autoAttackVisibilityMode.value;
  // Keep legacy key in sync for older config readers.
  currentSettings.autoAttackRequireLoS = autoAttackVisibilityMode.value !== AUTO_ATTACK_VISIBILITY_MODE.OFF;
  currentSettings.postSuccessLockMs = postSuccessLockMs.value;
  currentSettings.quickActions = quickActions;
  
  Settings.setMultiple(PLUGIN_NAME, currentSettings);
}

/**
 * Save quick actions to settings
 */
function saveQuickActions() {
  currentSettings.quickActions = quickActions;
  Settings.set(PLUGIN_NAME, 'quickActions', quickActions);
}

// Key names for display
const KEY_NAMES = {
  [ImGui.Key.Space]: "Space",
  [ImGui.Key.E]: "E",
  [ImGui.Key.T]: "T",
  [ImGui.Key.X]: "X",
  [ImGui.Key.F1]: "F1",
  [ImGui.Key.F2]: "F2",
  [ImGui.Key.F3]: "F3",
  [ImGui.Key.F4]: "F4",
  [ImGui.Key.Q]: "Q",
  [ImGui.Key.R]: "R",
  [ImGui.Key.F]: "F",
  [ImGui.Key.G]: "G",
  [ImGui.Key.V]: "V",
  [ImGui.Key.B]: "B",
  [ImGui.Key.Tab]: "Tab",
  [ImGui.Key.LeftShift]: "Left Shift",
  [ImGui.Key.LeftCtrl]: "Left Ctrl"
};

function getKeyName(key) {
  if (key === 0) return "None";
  return KEY_NAMES[key] || `Key ${key}`;
}

// Colors (ABGR)
const COLOR_WHITE = 0xFFFFFFFF;
const COLOR_GREEN = 0xFF00FF00;
const COLOR_YELLOW = 0xFF00FFFF;
const COLOR_RED = 0xFF0000FF;
const COLOR_CYAN = 0xFFFFFF00;

// Send action packet (BIG ENDIAN for entity ID)
// New format: 01 90 01 85 [type] 00 40 04 00 FF 00 00 00 00 [type] [entityId 4 bytes BE]
// NOTE: appendGridBE retained for the verified entity-targeted packets (sendMoveTo). The 0x85
// ATTACK packets below intentionally do NOT append grid -- that was unverified and crashed the
// game (malformed attack packet on a caster's auto-attack). Revert: original id-only attack form.
function appendGridBE(bytes, gridX, gridY) {
  if (gridX === undefined || gridX === null || gridY === undefined || gridY === null) return bytes;
  const gx = Math.floor(gridX), gy = Math.floor(gridY);
  bytes.push((gx >>> 24) & 0xFF, (gx >>> 16) & 0xFF, (gx >>> 8) & 0xFF, gx & 0xFF);
  bytes.push((gy >>> 24) & 0xFF, (gy >>> 16) & 0xFF, (gy >>> 8) & 0xFF, gy & 0xFF);
  return bytes;
}

function sendAttackBow(entityId) {
  return poe2.sendPacket(new Uint8Array([
    0x01, 0xA3, 0x01, 0x85, 0x01, 0x00, 0x40, 0x04, 0x00, 0xFF, 0x00,
    0x00, 0x00, 0x00, 0x01,
    (entityId >>> 24) & 0xFF,
    (entityId >>> 16) & 0xFF,
    (entityId >>> 8) & 0xFF,
    entityId & 0xFF
  ]));
}

function sendAttackBasic(entityId) {
  return poe2.sendPacket(new Uint8Array([
    0x01, 0xA3, 0x01, 0x85, 0x03, 0x00, 0x40, 0x04, 0x00, 0xFF, 0x00,
    0x00, 0x00, 0x00, 0x03,
    (entityId >>> 24) & 0xFF,
    (entityId >>> 16) & 0xFF,
    (entityId >>> 8) & 0xFF,
    entityId & 0xFF
  ]));
}

function sendMoveTo(entityId, gridX, gridY) {
  // 050b SUBPATCH: move-to-entity now needs the target's INTEGER grid (BE u32) appended
  // after the entity ID. Captured: 01 A3 01 20 00 C2 66 04 .. FF 08 [id BE][gridX BE][gridY BE]
  // (id 0x3B=59, grid 0x605/0x25F = 1541/607, floored from 1541.5/607.5).
  const bytes = [
    0x01, 0xA3, 0x01, 0x20, 0x00, 0xC2, 0x66, 0x04,
    0x02, 0xFF, 0x08,
    (entityId >>> 24) & 0xFF,
    (entityId >>> 16) & 0xFF,
    (entityId >>> 8) & 0xFF,
    entityId & 0xFF
  ];
  if (gridX !== undefined && gridX !== null && gridY !== undefined && gridY !== null) {
    const gx = Math.floor(gridX), gy = Math.floor(gridY);
    bytes.push((gx >>> 24) & 0xFF, (gx >>> 16) & 0xFF, (gx >>> 8) & 0xFF, gx & 0xFF);
    bytes.push((gy >>> 24) & 0xFF, (gy >>> 16) & 0xFF, (gy >>> 8) & 0xFF, gy & 0xFF);
  }
  return poe2.sendPacket(new Uint8Array(bytes));
}

// Send stop/end action packet (called on key release) 01 97 01 in 040f
function sendStopAction() {
  // 050b subpatch: stop-action opcode is 0x01 0xAA 0x01 (was 0xAB here -> invalid -> disconnect
  // on every attack-key release; was 0x97 in 040f).
  const packet = new Uint8Array([0x01, 0xAA, 0x01]);
  return poe2.sendPacket(packet);
}

// Auto-attack logic (runs ALWAYS, even when window is collapsed)
/**
 * Check if an entity has a specific buff by name (partial match)
 */
function hasBuffContaining(entity, buffNamePart) {
  if (!entity || !entity.buffs || entity.buffs.length === 0) return false;
  return entity.buffs.some(b => b.name && b.name.includes(buffNamePart));
}

// Exact-name buff check: the invuln gate needs an EXACT match (a distinct out-of-range immunity
// flag), not the substring family match hasBuffContaining does. Reads the same shared per-frame
// buffs list the diagnostic used to isolate the signal.
function hasInvulnImmunity(entity) {
  if (!entity || !entity.buffs || entity.buffs.length === 0) return false;
  return entity.buffs.some(b => b && b.name === INVULN_IMMUNITY_BUFF);
}

/**
 * Check if player can attack an entity (with caching), based on selected visibility mode.
 */
function checkVisibilityForAttack(player, entity, maxDist, visibilityMode) {
  if (visibilityMode === AUTO_ATTACK_VISIBILITY_MODE.OFF) return true;
  if (!player || !entity || !entity.gridX || !entity.id) return true;
  
  const now = Date.now();
  const entityId = entity.id;
  const cacheKey = `${entityId}:${visibilityMode}`;
  
  // Check cache first
  const cached = losCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < LOS_CACHE_TTL) {
    return cached.result;
  }
  
  // Clean old entries periodically (every ~50 checks)
  if (losCache.size > 100) {
    for (const [id, entry] of losCache) {
      if (now - entry.timestamp > LOS_CACHE_TTL * 2) {
        losCache.delete(id);
      }
    }
  }
  
  try {
    const fromX = Math.floor(player.gridX);
    const fromY = Math.floor(player.gridY);
    const toX = Math.floor(entity.gridX);
    const toY = Math.floor(entity.gridY);
    const distance = maxDist || 300;
    let result = true;

    if (visibilityMode === AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_FIRE) {
      if (typeof poe2.hasLineOfFire === 'function') {
        result = poe2.hasLineOfFire(fromX, fromY, toX, toY, distance);
      } else if (typeof poe2.isWithinLineOfSight === 'function') {
        // Compatibility fallback if Line of Fire is unavailable in this build.
        result = poe2.isWithinLineOfSight(fromX, fromY, toX, toY, distance);
      }
    } else if (visibilityMode === AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_SIGHT) {
      if (typeof poe2.isWithinLineOfSight === 'function') {
        result = poe2.isWithinLineOfSight(fromX, fromY, toX, toY, distance);
      } else if (typeof poe2.hasLineOfFire === 'function') {
        // Compatibility fallback if legacy LoS is unavailable.
        result = poe2.hasLineOfFire(fromX, fromY, toX, toY, distance);
      }
    }
    
    // Cache the result
    losCache.set(cacheKey, { result, timestamp: now });
    return result;
  } catch (err) {
    // Visibility helpers may not be available
    return true;  // Assume visible if can't check
  }
}

// Stale-target guard: drop a target we've fired at for too long with NO hp drop (unreachable / behind a wall /
// off-screen-but-in-range / cached-dead via slab recycle) so we don't stand spamming a skill at nothing.
// TASK-45: damage detection is PER-TICK (last-tick total vs this tick), NOT vs an all-time-low anchor. The old
// anchor compare read banner-zealot packs as 'unhittable' point-blank: granted/regenerating ES keeps the summed
// health+ES pool above the old trough even while every arrow lands, so real fights got banned mid-exchange.
// A drop between consecutive ticks (~100ms) catches every real hit regardless of regen; a RISE (ES grant/heal)
// also resets the clock -- a shielded mob is being supported, not walled off. Bans additionally require that we
// ACTUALLY FIRED during the window: zero casts means the blocker is on our side (gate/cooldown/conditions) and
// banning the target would just mask it -- name the gate instead.
const aaStaleBL = new Map();          // entity id -> expiry ts
const aaStaleRepeat = new Map();      // entity id -> { n: stale-ban count, at: last ban ts } (escalate: 5s first, 30s repeat; forgets after TTL)
const AA_STALE_WINDOW_MS = 5000;      // flat-pool window before a ban (user: 3.5s was too twitchy)
const AA_STALE_MIN_CASTS = 2;         // fires at the target since last observed damage required before a ban
const AA_STALE_REPEAT_TTL_MS = 90000; // repeat-offender memory -- one bad verdict must not poison a pack with 30s bans all map
let aaStaleTid = 0, aaStaleSince = 0, aaStaleHp = 0, aaStaleCasts = 0;
let _staleNoCastLogAt = 0;            // throttle for the zero-casts diagnostic line
// TASK-32 C/D: publish the hp-frozen ban to POE2Cache so the mapper can detect an UNHITTABLE boss (>=2 consecutive
// bans on the same id) and its FIGHTING_BOSS diag can show the aa-ban state. Consecutive count resets when the
// banned id changes or that id takes real damage. Pure JS-side publish (no game memory write).
let _hpFrozenBanId = 0, _hpFrozenBanConsec = 0;
// TASK-32B I (TEMP diag -- remove alongside the mapper [BossFight] D diag once a Vastweld-class gap is captured): name
// WHY casts hold on a targetable objective boss that is in range (the Vastweld 9s cast-gap: zero rotation casts while
// the melee-entry parked at 29u). Throttled ~2s; reuses the shared scan (no new entity read); the LoF raycast fires
// only after the cheaper gates pass. Pure logging -- changes no behavior. Flag off = silent (byte-parity).
const BOSS_CASTGAP_DIAG_ON = true;
let _bossGapDiagAt = 0;
// Invuln-gate hold throttle: once-per-5s cap on the "holding on an out-of-range-immune target" log.
let _invulnHoldLast = 0;
// TASK-29G: ids BANNED while carrying the out-of-range immunity buff -> the ban must be dropped the INSTANT the buff
// clears (not after the 4s expiry -> the observed 1-2s dead air). Populated + drained at the ban filter in the candidate loop.
const _invulnWatch = new Set();
// ESSENCE detection (live-RE 2026-06-27): a rare IMPRISONED by an un-started essence Monolith reads as a plain rare.
// Find un-started essence Monoliths (Metadata/MiscellaneousObjects/Monolith; isTargetable=true = not yet consumed/
// started). The attack SKIPS a rare sitting on one (<=32u) until it's started, so we never waste it killing it
// imprisoned. Capped getEntities (the monolith is co-located with the rare we're already targeting), cached 1.2s.
let _essMonoCache = [], _essMonoAt = -1e9;
const _essSkipSince = new Map();   // entity id -> first ts skipped as imprisoned (12s safety -> never get stuck)
function essenceMonolithsUnstarted() {
  const now = Date.now();
  if (now - _essMonoAt < 1200) return _essMonoCache;
  _essMonoAt = now;
  const out = [];
  try {
    for (const e of (poe2.getEntities({ lightweight: true }) || [])) {
      if (!/MiscellaneousObjects[\/\\]Monolith/i.test(e.name || '')) continue;
      if (e.isTargetable === false) continue;   // consumed / started -> no longer imprisoning
      out.push({ x: e.gridX || 0, y: e.gridY || 0 });
    }
  } catch (_) {}
  _essMonoCache = out;
  return out;
}
function isEssenceImprisoned(entity) {
  const monos = essenceMonolithsUnstarted();
  if (!monos.length) { if (_essSkipSince.size) _essSkipSince.clear(); return false; }
  let near = false;
  for (const m of monos) { if (Math.hypot(m.x - (entity.gridX || 0), m.y - (entity.gridY || 0)) <= 32) { near = true; break; } }
  if (!near) { _essSkipSince.delete(entity.id); return false; }
  const now = Date.now();
  const since = _essSkipSince.get(entity.id);
  if (!since) { _essSkipSince.set(entity.id, now); return true; }
  if (now - since > 25000) return false;   // waited too long, nothing started it -> attack anyway (25s: the opener now needs up to 6 clicks at 500ms + the walk into 40u range)
  return true;
}

function processAutoAttack() {
  if (!autoAttackEnabled.value) {
    if (autoAttackHadTargetLastTick) {
      sendStopAction();
      autoAttackHadTargetLastTick = false;
    }
    wasAttackKeyDown = false;
    autoAttackToggleActive = false;
    // Toggling off clears stale-target bans: gives a manual reset for a stuck
    // target (e.g. a boss banned during an invuln window) WITHOUT the full
    // END-key JS reload the user previously needed.
    aaStaleBL.clear();
    aaStaleRepeat.clear();
    _invulnWatch.clear();
    aaStaleTid = 0;
    return;
  }
  
  // Check modifier keys match (use isKeyDown for modifier detection)
  const ctrlDown = ImGui.isKeyDown(ImGui.Key.LeftCtrl) || ImGui.isKeyDown(ImGui.Key.RightCtrl);
  const shiftDown = ImGui.isKeyDown(ImGui.Key.LeftShift) || ImGui.isKeyDown(ImGui.Key.RightShift);
  const altDown = ImGui.isKeyDown(ImGui.Key.LeftAlt) || ImGui.isKeyDown(ImGui.Key.RightAlt);
  const ctrlOk = !autoAttackKeyCtrl.value || ctrlDown;
  const shiftOk = !autoAttackKeyShift.value || shiftDown;
  const altOk = !autoAttackKeyAlt.value || altDown;
  const modifiersOk = ctrlOk && shiftOk && altOk;
  
  let isAttacking = false;
  
  if (autoAttackToggleMode.value) {
    // Toggle mode: press key to toggle on/off
    const keyPressed = modifiersOk && ImGui.isKeyPressed(autoAttackKey.value, false);
    if (keyPressed) {
      autoAttackToggleActive = !autoAttackToggleActive;
      if (!autoAttackToggleActive) {
        sendStopAction();
      }
    }
    isAttacking = autoAttackToggleActive;
  } else {
    // Hold mode: hold key to attack
    const isKeyDown = modifiersOk && ImGui.isKeyDown(autoAttackKey.value);
    
    // Detect key release: was down, now up -> send stop action
    if (wasAttackKeyDown && !isKeyDown) {
      sendStopAction();
      wasAttackKeyDown = false;
      return;
    }
    
    // Update key state
    wasAttackKeyDown = isKeyDown;
    isAttacking = isKeyDown;
  }
  
  // If not attacking, nothing to do
  if (!isAttacking) {
    autoAttackHadTargetLastTick = false;
    return;
  }
  
  const now = Date.now();
  if (now - lastAutoAttackTime < autoAttackCooldown) return;

  // Claim the gate for THIS scan, not just for a successful shot. Every exit below
  // (no candidates, all banned, stale-target ban, rotation declined) used to leave
  // lastAutoAttackTime untouched, so the scan re-ran at full frame rate -- with a
  // line-of-fire raycast per candidate. Standing in a big pack whose mobs are all
  // banned/unhittable ran the whole thing ~90x/sec instead of 10x/sec. A successful
  // fire overwrites this below with the longer post-success lock.
  lastAutoAttackTime = now;

  // Use cached player and entities for performance
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) return;
  
  // Get all entities - lightweight + includeBuffs so entity.buffs is populated WITHOUT the
  // full-read cost. The auto-attack target flows into executeRotationOnTarget -> checkConditions,
  // and rotation conditions like monster_missing_buff need entity.buffs; includeBuffs gives us
  // those (cheap + 250ms-cached) while still skipping the expensive Stats/Mods/WorldItem reads.
  // Using type filter instead of monstersOnly to avoid missing certain monster types.
  // Shared per-frame scan (the same one ESP uses) filtered to alive monsters in JS. The
  // shared list already includes buffs (needed by rotation conditions) and spans SHARED_RADIUS;
  // the loop below culls to autoAttackDistance. This avoids a second full C++ scan per frame.
  const allEntities = POE2Cache.getSharedEntities().filter(
    e => e.entityType === 'Monster' && e.isAlive
  );
  
  // Find alive monsters within auto-attack distance
  const targets = [];
  const visibilityMode = autoAttackVisibilityMode.value;

  for (const entity of allEntities) {
    if (!entity.gridX || entity.isLocalPlayer) continue;
    if (!entity.isAlive) continue;
    if (!entity.id || entity.id === 0) continue;
    if ((aaStaleBL.get(entity.id) || 0) > now) {           // stale/unreachable target -> skip it briefly
      // TASK-29G(2): a target BANNED while it carries no_players_in_range_immunity must re-engage the INSTANT the buff
      // drops, not after the ban expires. Watch banned+immune ids; when the buff clears, drop the ban + fall through so
      // this entity is eligible again THIS tick. Flag off / never-immune -> plain skip (byte-parity).
      if (INVULN_GATE_ON && hasInvulnImmunity(entity)) { _invulnWatch.add(entity.id); continue; }   // still immune -> keep waiting it out
      if (INVULN_GATE_ON && _invulnWatch.has(entity.id)) { aaStaleBL.delete(entity.id); aaStaleRepeat.delete(entity.id); _invulnWatch.delete(entity.id); }   // buff cleared -> re-engage now
      else continue;
    }

    // Distance check
    const dx = entity.gridX - player.gridX;
    const dy = entity.gridY - player.gridY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > autoAttackDistance.value) continue;

    // Skip friendlies (same team as you: allied NPCs + your own minions/pets) and hidden monsters.
    if (entity.isFriendly) continue;
    if (entity.entitySubtype === 'MonsterFriendly') continue;
    if (hasBuffContaining(entity, 'hidden_monster')) continue;
    // NEVER attack a SHRINE: live-RE -- the Enduring Shrine (Metadata/Shrines/Shrine) is a hostile, targetable,
    // highlightable MonsterNormal (100 HP), so it passes EVERY attack filter, but you ACTIVATE it by walking into it,
    // not by damage -> the rotation spams IceShot at it forever. Match the '/Shrines/' path segment (guardians are
    // under /Monsters/, so this skips only the shrine object).
    if (/\/Shrines?\//i.test(entity.name || '')) continue;
    // ESSENCE-IMPRISONED rare: don't whack it as a normal mob (live-RE 2026-06-27) -- the essence "monster" is a plain
    // rarity-2 rare sitting on an UN-STARTED Monolith (Metadata/MiscellaneousObjects/Monolith, isTargetable=true).
    // Killing it imprisoned WASTES the essence -> SKIP until the opener STARTS the monolith (then it's a normal kill);
    // 12s safety inside so we never get stuck if nothing starts it.
    if ((entity.rarity || 0) >= RARITY.RARE && isEssenceImprisoned(entity)) continue;

    // Skip entities that cannot be targeted or highlighted. Un-highlightable usually means
    // "not yet attackable" (e.g. floor/burrowed mobs before they rise), so it stays a skip -
    // EXCEPT for structure-bosses that are permanently un-highlightable but valid targets.
    if (entity.isTargetable === false) continue;
    // UNIQUE bosses in a PRE-ACTIVATION state (burrowed/animation-locked, e.g. twin arena bosses before the walk-in
    // trigger) have NO Targetable component -> isTargetable reads undefined, not false -> the gate above passes and the
    // rotation stop-casts at an invulnerable boss (stalling the walk to the activation spot). Require a POSITIVE
    // targetable read for uniques; the structure-boss override list below still covers the permanently-untargetable ones.
    if ((entity.rarity || 0) === RARITY.UNIQUE && entity.isTargetable !== true) {
      const idPath = (entity.name || '') + '|' + (entity.renderName || '');
      if (!HIGHLIGHTABLE_OVERRIDE_LIST.some(p => idPath.includes(p))) continue;
    }
    // STAGED-INTRO boss (live-RE'd on the twin arena): the game reads isTargetable=TRUE during the intro, but the boss
    // carries 'phasing_no_visual' while untouched + idle and can't actually be damaged until the proximity trigger
    // fires. Skip it so the rotation doesn't stop-cast at an invulnerable boss (stalling the walk to the activation
    // spot). SELF-UNLOCKING: once activated it acts / takes damage, any of the three conditions breaks, gate opens.
    if ((entity.rarity || 0) === RARITY.UNIQUE
        && entity.hasActiveAction !== true
        && (entity.healthCurrent === entity.healthMax)
        && entity.buffs && entity.buffs.some(b => b && b.name === 'phasing_no_visual')) continue;
    if (entity.isHighlightable === false) {
      // Bypass only for known structure-bosses AND only when Unique, so boss-arena proxy monsters
      // (RoofTarget/VolatileSpawner/etc, all MonsterNormal) can never be force-targeted.
      const idPath = (entity.name || '') + '|' + (entity.renderName || '');
      const highlightOverride = entity.rarity === RARITY.UNIQUE
        && HIGHLIGHTABLE_OVERRIDE_LIST.some(p => idPath.includes(p));
      if (!highlightOverride) continue;
    }
    
    // Skip entities hidden from player (underground, in walls, etc.)
    if (entity.hiddenFromPlayer === true) continue;
    
    // Skip ground effects (burning ground, chilled ground, etc.)
    if (entity.hasGroundEffect) continue;
    // Skip 1-HP marker/daemon dummies that have no Targetable component (e.g. TitanBossFissureLine,
    // the boss's ignited fissure line) - attacking them does nothing. Real targets, including 1-HP
    // "weak points", have isTargetable===true, so this never drops something you can actually kill.
    if (entity.healthMax <= 1 && entity.isTargetable !== true) continue;
    
    // Skip entities with immunity stats
    if (entity.cannotBeDamaged) continue;
    if (entity.isHiddenMonster) continue;
    if (entity.cannotBeDamagedByNonPlayer) continue;
    
    // Skip entities in the hardcoded exclusion list (match against metadata path)
    if (useAttackExclusions.value && ATTACK_EXCLUSION_LIST.length > 0) {
      const entityPath = entity.name || '';
      const isExcluded = ATTACK_EXCLUSION_LIST.some(pattern => entityPath.includes(pattern));
      if (isExcluded) continue;
    }
    
    // LINE-OF-FIRE is now UNCONDITIONAL (USER 'firing at walls'): never waste casts on a target behind a wall,
    // regardless of the visibility toggle. EXEMPT point-blank targets (<=15u: essentially adjacent -- a 1-tile
    // fog/grid glitch shouldn't drop a melee hit). The LoF exemption is for the OBJECTIVE BOSS only (arena walls /
    // destructibles can sample as blockers mid-fight) -- ordinary RARE/UNIQUE trash behind a cliff must NOT be
    // shot at through terrain: the rotation wall-fires for minutes while their HP sits frozen ("attacking shit we
    // can't actually hit"). The visibility setting still upgrades to walkable LoS.
    const _lofExempt = (entity.rarity || 0) === RARITY.UNIQUE
      && typeof isEntityLikelyMainObjectiveBoss === 'function' && isEntityLikelyMainObjectiveBoss(entity);
    // LoF is DEFERRED to selection: raycasting every candidate here, then sorting,
    // then using exactly one, burned N raycasts per scan (they dominate the scan on
    // big packs). Selection below raycasts down the sorted list until one passes,
    // which is ~1 raycast in the common case and picks the identical target.
    targets.push({ entity: entity, distance: dist, needsLoF: dist > 28 && !_lofExempt });
  }

  // TASK-32B I (TEMP diag): a targetable objective boss is in range but casts hold -- name the gate. Reuses allEntities
  // (no new scan); one LoF raycast only after the cheaper gates pass. Silent when we are actually shooting the boss
  // (it passed every gate + made it into targets) or firing at a nearer valid target.
  if (BOSS_CASTGAP_DIAG_ON && (now - _bossGapDiagAt > 2000) && typeof isEntityLikelyMainObjectiveBoss === 'function') {
    try {
      let _gb = null, _gd = Infinity;
      for (const e of allEntities) {
        if ((e.rarity || 0) !== RARITY.UNIQUE) continue;
        if (!isEntityLikelyMainObjectiveBoss(e)) continue;
        const d = Math.hypot((e.gridX || 0) - player.gridX, (e.gridY || 0) - player.gridY);
        if (d <= autoAttackDistance.value && d < _gd) { _gd = d; _gb = e; }
      }
      if (_gb) {
        _bossGapDiagAt = now;   // throttle the WHOLE evaluation (incl. the LoF raycast) to ~2s, not just the log line
        const _inTargets = targets.some(t => t.entity.id === _gb.id);
        let _r = null;
        if (_gb.isTargetable !== true) _r = 'not-targetable(awake-gate)';
        else if (_gb.cannotBeDamaged) _r = 'cannotBeDamaged(immune-phase)';
        // Zar Wali 11:06 standoff: these three loop-gates all fell into the useless 'other-gate' bucket -- name them.
        else if (_gb.cannotBeDamagedByNonPlayer) _r = 'cannotBeDamagedByNonPlayer';
        else if (_gb.isHighlightable === false) _r = 'not-highlightable(pre-activation?)';
        else if (useAttackExclusions.value && ATTACK_EXCLUSION_LIST.some(p => (_gb.name || '').includes(p))) _r = 'exclusion-list';
        else if (_gb.buffs && _gb.buffs.some(b => b && b.name === 'phasing_no_visual')) _r = 'phasing-intro';
        else if ((aaStaleBL.get(_gb.id) || 0) > now) _r = 'aa-banned(hp-frozen)';
        else if (INVULN_GATE_ON && hasInvulnImmunity(_gb)) _r = 'invuln-gate(out-of-range-immunity)';
        else if (_gd > 28) {
          const _lm = (visibilityMode === AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_SIGHT)
            ? AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_SIGHT : AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_FIRE;
          if (!checkVisibilityForAttack(player, _gb, autoAttackDistance.value, _lm)) _r = 'LoF-blocked(wall/elevation)';
          else if (!_inTargets) _r = 'skipped(other-gate)';
        } else if (!_inTargets) _r = 'skipped(other-gate)';
        if (_r) {
          _bossGapDiagAt = now;
          console.log(`[BossFight] cast-gap: boss ${(_gb.renderName || _gb.name || '?').split('/').pop()} ${Math.round(_gd)}u held (${_r})`);
        }
      }
    } catch (_) {}
  }

  if (targets.length > 0) {
    // Helper: get rarity sort value based on rarity priority mode
    const getRaritySortValue = (entity, rarityMode) => {
      const rarity = entity.rarity || 0;
      switch (rarityMode) {
        case RARITY_PRIORITY.UNIQUE_FIRST:
          // Unique=3, Rare=2, Magic=1, Normal=0 -> higher is better
          return rarity;
        case RARITY_PRIORITY.RARE_FIRST:
          // Rare=3, Unique=2, Magic=1, Normal=0
          if (rarity === RARITY.RARE) return 3;
          if (rarity === RARITY.UNIQUE) return 2;
          if (rarity === RARITY.MAGIC) return 1;
          return 0;
        case RARITY_PRIORITY.MAGIC_FIRST:
          // Magic=3, Rare=2, Unique=1, Normal=0
          if (rarity === RARITY.MAGIC) return 3;
          if (rarity === RARITY.RARE) return 2;
          if (rarity === RARITY.UNIQUE) return 1;
          return 0;
        case RARITY_PRIORITY.NORMAL_FIRST:
          // Normal=3, Magic=2, Rare=1, Unique=0 (inverse)
          return 3 - rarity;
        default:
          return 0;  // No rarity preference
      }
    };
    
    // Helper: secondary sort comparison
    const compareByPriority = (a, b, priority) => {
      switch (priority) {
        case TARGET_PRIORITY.CLOSEST:
          return a.distance - b.distance;
        case TARGET_PRIORITY.FURTHEST:
          return b.distance - a.distance;
        case TARGET_PRIORITY.HIGHEST_MAX_HP:
          return (b.entity.healthMax || 0) - (a.entity.healthMax || 0);
        case TARGET_PRIORITY.HIGHEST_CURRENT_HP:
          return (b.entity.healthCurrent || 0) - (a.entity.healthCurrent || 0);
        case TARGET_PRIORITY.LOWEST_CURRENT_HP:
          return (a.entity.healthCurrent || 0) - (b.entity.healthCurrent || 0);
        default:
          return a.distance - b.distance;
      }
    };
    
    // Sort by rarity first (if enabled), then by secondary priority
    const rarityMode = autoAttackRarityPriority.value;
    const priority = autoAttackPriority.value;
    
    targets.sort((a, b) => {
      // Primary sort: rarity (if enabled)
      if (rarityMode !== RARITY_PRIORITY.NONE) {
        const rarityA = getRaritySortValue(a.entity, rarityMode);
        const rarityB = getRaritySortValue(b.entity, rarityMode);
        if (rarityA !== rarityB) {
          return rarityB - rarityA;  // Higher rarity value = higher priority
        }
      }

      // Secondary sort: distance/HP based priority
      return compareByPriority(a, b, priority);
    });

    // OBJECTIVE-BOSS OVERRIDE (OPT-IN toggle, default OFF -- user died to trash-targeting mid-boss): when enabled,
    // the MAP BOSS owns the target slot even when trash stands closer -- the sort fed "decrepit mercenary" to the
    // rotation while the boss free-cast. Nearest passing candidate wins among multiple bosses. Needs the mapper
    // loaded (it exposes the boss check); silently inert otherwise.
    // Lazy line-of-fire: evaluated at most once per candidate, and only for the
    // candidates selection actually reaches (memoized on the candidate record).
    const losMode = (visibilityMode === AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_SIGHT)
      ? AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_SIGHT : AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_FIRE;
    const lofPasses = (t) => {
      if (!t.needsLoF) return true;
      if (t._lofOk === undefined) {
        t._lofOk = checkVisibilityForAttack(player, t.entity, autoAttackDistance.value, losMode);
      }
      return t._lofOk;
    };

    let target = null;
    try {
      if (bossTargetPriority.value && typeof isEntityLikelyMainObjectiveBoss === 'function') {
        let _bb = null;
        for (const t of targets) {
          if ((t.entity.rarity || 0) !== RARITY.UNIQUE) continue;
          if (!isEntityLikelyMainObjectiveBoss(t.entity)) continue;
          if (!lofPasses(t)) continue;
          if (!_bb || t.distance < _bb.distance) _bb = t;
        }
        target = _bb;
      }
    } catch (_) {}
    // Execute rotation on the best target that we can actually shoot.
    if (!target) {
      for (const t of targets) {
        if (lofPasses(t)) { target = t; break; }
      }
    }
    if (!target) {
      // Candidates exist but none is shootable from here (all behind terrain).
      // Mirror the "no candidates at all" handling exactly, resend included --
      // a dropped stop packet means the game repeats our last attack forever.
      if (autoAttackHadTargetLastTick) {
        sendStopAction();
        stopResendAt = now + 300;
        autoAttackHadTargetLastTick = false;
      } else if (stopResendAt && now >= stopResendAt) {
        sendStopAction();
        stopResendAt = 0;
      }
      return;
    }
    // INVULN GATE: a boss phasing into no_players_in_range_immunity has frozen HP and can't be damaged
    // from out of range -- blind-firing wastes the whole window (it only ends via the 3.5s hp-frozen ban).
    // Prefer any OTHER eligible (LoF-passing, non-immune) candidate; if the immune target is the only option,
    // HOLD (throttled 5s) + stop-cast until the window ends. Flag off = today's blind-fire; the hp-frozen ban
    // below is untouched and remains the generic backstop for other invuln flavors.
    if (INVULN_GATE_ON && hasInvulnImmunity(target.entity)) {
      let _alt = null;
      for (const t of targets) {
        if (t.entity.id === target.entity.id) continue;
        if (hasInvulnImmunity(t.entity)) continue;
        if (!lofPasses(t)) continue;
        _alt = t; break;
      }
      if (_alt) {
        target = _alt;
      } else {
        // TASK-29G(1): FREEZE the 3.5s hp-frozen heuristic while the gate holds an out-of-range-immune target -- the
        // clock must not accrue across the invuln window (a 1-tick buff flicker would otherwise ban a boss we are
        // deliberately waiting out -> dead air when it clears). Reset the stale anchor to now each held tick.
        aaStaleTid = target.entity.id; aaStaleSince = now;
        aaStaleHp = (target.entity.healthCurrent || 0) + (target.entity.esCurrent || 0);
        if (now - _invulnHoldLast > 5000) {
          _invulnHoldLast = now;
          console.log(`[Rotation] hold: ${(target.entity.renderName || target.entity.name || '?').split('/').pop()} invulnerable (out-of-range immunity)`);
        }
        // Mirror the LoF-fail stop path: stop the server-side attack repeat, one-shot resend.
        if (autoAttackHadTargetLastTick) {
          sendStopAction();
          stopResendAt = now + 300;
          autoAttackHadTargetLastTick = false;
        } else if (stopResendAt && now >= stopResendAt) {
          sendStopAction();
          stopResendAt = 0;
        }
        return;
      }
    }
    autoAttackHadTargetLastTick = true;
    lastTargetName = target.entity.name || "Unknown";
    lastTargetId = target.entity.id;
    lastTargetHP = target.entity.healthCurrent || 0;
    lastTargetMaxHP = target.entity.healthMax || 0;
    lastTargetRarity = target.entity.rarity || 0;
    // STALE-TARGET GUARD (TASK-45): same target for >AA_STALE_WINDOW_MS with a FLAT pool AND real casts sent =
    // not a real fight (unreachable / behind a wall / cached-dead / immune) -> blacklist + stop. Damage is
    // detected PER-TICK (this tick vs last tick, ~100ms apart) so banner-granted/regenerating ES can't mask
    // landing hits the way the old all-time-low anchor did; a RISING pool (ES grant/heal mid-fight) also resets
    // the clock -- shielded means supported, not unhittable.
    const _tid = target.entity.id, _thp = (target.entity.healthCurrent || 0) + (target.entity.esCurrent || 0);
    if (aaStaleTid !== _tid) { aaStaleTid = _tid; aaStaleSince = now; aaStaleCasts = 0; }
    else if (_thp < aaStaleHp - 1) { aaStaleSince = now; aaStaleCasts = 0; if (_tid === _hpFrozenBanId) _hpFrozenBanConsec = 0; }   // hit landed since last tick -> real fight
    else if (_thp > aaStaleHp + 1) { aaStaleSince = now; }   // pool ROSE (ES grant/recharge/ally heal) -> keep shooting, don't ban
    else if (now - aaStaleSince > AA_STALE_WINDOW_MS && aaStaleCasts < AA_STALE_MIN_CASTS) {
      // Flat pool but WE never actually fired: the blocker is our own cast path (gate/cooldown/conditions),
      // not the target's reachability. Banning here masks the real fault (the old zero-cast ban carousels).
      // Name the gate, restart the window, ban nothing.
      if (now - _staleNoCastLogAt > 2000) {
        _staleNoCastLogAt = now;
        let _nfr = '?'; try { _nfr = lastNoFireReason() || '?'; } catch (_) {}
        console.log(`[Rotation] hp flat ${(AA_STALE_WINDOW_MS / 1000)}s on ${(target.entity.renderName || target.entity.name || '?').split('/').pop()} but ${aaStaleCasts} casts sent (${_nfr}) -> NO ban, cast path blocked`);
      }
      aaStaleSince = now;
    }
    else if (now - aaStaleSince > AA_STALE_WINDOW_MS) {
      // ESCALATE + CLUSTER-BAN (user: 'shooting into wall at mobs' for 30s+): a serial 5s per-target ban loses
      // to a walled PACK -- by the time mob #6 is banned, #1's ban expired and the cycle repeats forever, casts
      // rooting the walk the whole time. The wall blocks the whole cluster: ban every candidate within 25u of
      // the stale target too, and repeat offenders get 30s instead of 5s. TASK-45: repeat memory forgets after
      // AA_STALE_REPEAT_TTL_MS so a transient false verdict can't 30s-poison the pack for the rest of the map.
      const _re = aaStaleRepeat.get(_tid);
      const _rep = ((_re && (now - _re.at) < AA_STALE_REPEAT_TTL_MS) ? _re.n : 0) + 1;
      aaStaleRepeat.set(_tid, { n: _rep, at: now });
      // Rare+ (rares/uniques/bosses) have TRANSIENT invuln/phase windows where HP
      // legitimately freezes -- a long escalating ban strands the bot when the boss
      // is the only target (user: stuck 30s until END-reload). Short, non-escalating
      // ban so we resume damage within a few seconds of the phase ending. Normal
      // mobs keep the 5s->30s escalation (the wall-blocked-pack case this was built
      // for; LoF now filters most walls, so this mainly catches immune bosses).
      const _isRarePlus = (target.entity.rarity || 0) >= RARITY.RARE;
      // Rare+ keeps the short non-escalating ban for TRANSIENT invuln phases -- but 4+ CONSECUTIVE frozen-hp bans
      // on the SAME rare (~35s of zero damage while casts land) is not a phase, it is unreachable ground: the
      // LoftySummit 2026-07-16 death re-acquired a meteor zealot every 4s for 2 MINUTES, which kept combat/posture
      // anchored inside the meteor rain. Repeat-offender RARES escalate to 30s so movement actually leaves;
      // UNIQUES/bosses stay short (the only-target strand risk the original comment warns about).
      const _isUniquePlus = (target.entity.rarity || 0) >= RARITY.UNIQUE;
      const _consecNext = (_tid === _hpFrozenBanId) ? _hpFrozenBanConsec + 1 : 1;
      const _banMs = _isUniquePlus ? 4000 : (_isRarePlus ? (_consecNext >= 4 ? 30000 : 4000) : (_rep >= 2 ? 30000 : 5000));
      aaStaleBL.set(_tid, now + _banMs);
      let _clustered = 0;
      for (const t of targets) {
        if (t.entity.id === _tid) continue;
        if (Math.hypot((t.entity.gridX || 0) - (target.entity.gridX || 0), (t.entity.gridY || 0) - (target.entity.gridY || 0)) < 25) {
          aaStaleBL.set(t.entity.id, now + _banMs);
          _clustered++;
        }
      }
      console.log(`[Rotation] hp frozen ${(AA_STALE_WINDOW_MS / 1000)}s over ${aaStaleCasts} casts on ${(target.entity.renderName || target.entity.name || '?').split('/').pop()} (unhittable from here) -> ban ${(_banMs / 1000)}s + ${_clustered} clustered`);
      // TASK-32 C/D: publish the ban so the mapper's FIGHTING_BOSS can spot a persistently-unhittable boss + diag it.
      _hpFrozenBanConsec = (_tid === _hpFrozenBanId) ? _hpFrozenBanConsec + 1 : 1;
      _hpFrozenBanId = _tid;
      try { POE2Cache.rotationBan = { id: _tid, until: now + _banMs, at: now, consec: _hpFrozenBanConsec, rare: _isRarePlus }; } catch (_) {}
      sendStopAction();
      autoAttackHadTargetLastTick = false;
      aaStaleTid = 0;
      return;
    }
    aaStaleHp = _thp;   // per-tick baseline (TASK-45) -- NOT a trough anchor; next tick compares against this
    // Run the rotation on the selected target. NO fallback attack: the old inline bow/basic
    // attack packet (0x85) fired a weapon attack the player may not have and used an unverified
    // packet format that DISCONNECTED/crashed the game. If no rotation skill matches, do nothing.
    const fired = executeRotationOnTarget(target.entity, target.distance);
    if (fired) {
      aaStaleCasts++;   // TASK-45: a cast actually went out at the stale-guard's current target this tick
      // TASK-37 B1: `fired` is true exactly on the path that logs `[Rotation] Used <skill>` -- the successful-cast site.
      if (IDLE_DETECT_BUS_ON) { try { POE2Cache.lastRotationCastAt = now; } catch (_) {} }
      idleStopSent = false;
      stopResendAt = 0;
    } else if (!idleStopSent && lastNoFireReason() === 'no-skill-eligible') {
      // No skill is WILLING to attack this target (every skill's conditions fail -- classically the
      // target sits between the skills' distance gates and autoAttackDistance). We aren't attacking,
      // but the game is still repeating our LAST attack action: send the missing stop the moment
      // this state is entered (latched until we cast again). Cooldown/throttle holds ('ready-gated')
      // and an armed Snipe channel ('channeling') deliberately do NOT stop -- there the target is
      // attackable and the repeat is wanted filler; a stop mid-channel would release Snipe early.
      sendStopAction();
      idleStopSent = true;
    }

    // Push the next-allowed-attack time forward by the configured post-success lock.
    // The 100ms gate at the top of processAutoAttack enforces this on the next iteration.
    // The lock dominates when postSuccessLockMs.value > autoAttackCooldown (default 200 > 100).
    const lockMs = Math.max(autoAttackCooldown, postSuccessLockMs.value || 0);
    lastAutoAttackTime = now - autoAttackCooldown + lockMs;
  } else if (autoAttackHadTargetLastTick) {
    // We were actively attacking but now have no valid targets (dead/out of range/filtered).
    // Send a stop packet so the game does not keep firing at stale targets; schedule ONE re-send
    // (stop packets can drop like any packet -- a lost stop = silent infinite repeat).
    sendStopAction();
    stopResendAt = now + 300;
    autoAttackHadTargetLastTick = false;
  } else if (stopResendAt && now >= stopResendAt) {
    sendStopAction();
    stopResendAt = 0;
  }
}

/**
 * Process all quick actions - check if their keys are pressed and execute
 */
function processQuickActions() {
  if (!quickActions || quickActions.length === 0) return;
  
  const now = Date.now();
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) return;
  
  // Check modifiers state
  const ctrlDown = ImGui.isKeyDown(ImGui.Key.LeftCtrl) || ImGui.isKeyDown(ImGui.Key.RightCtrl);
  const shiftDown = ImGui.isKeyDown(ImGui.Key.LeftShift) || ImGui.isKeyDown(ImGui.Key.RightShift);
  const altDown = ImGui.isKeyDown(ImGui.Key.LeftAlt) || ImGui.isKeyDown(ImGui.Key.RightAlt);
  
  for (let i = 0; i < quickActions.length; i++) {
    const qa = quickActions[i];
    if (!qa.enabled || !qa.key) continue;
    
    // Check modifiers
    const ctrlOk = !qa.keyCtrl || ctrlDown;
    const shiftOk = !qa.keyShift || shiftDown;
    const altOk = !qa.keyAlt || altDown;
    const modifiersOk = ctrlOk && shiftOk && altOk;
    
    if (!modifiersOk || !ImGui.isKeyPressed(qa.key, false)) continue;
    
    // Check cooldown
    const lastUse = quickActionCooldowns[i] || 0;
    if (now - lastUse < (qa.cooldown || 100)) continue;
    
    // Find the skill
    let skill = null;
    if (qa.skillName) {
      skill = findSkillByName(qa.skillName);
    }
    
    // Fallback to stored packet bytes if skill not found by name
    if (!skill && qa.packetBytes && qa.packetBytes.length >= 4) {
      skill = { packetBytes: qa.packetBytes };
    }
    
    if (!skill || !skill.packetBytes) {
      console.warn(`[QuickAction] Skill "${qa.name}" not found`);
      continue;
    }
    
    const packetBytes = skill.packetBytes;
    let success = false;
    
    // Execute based on mode
    switch (qa.mode) {
      case QUICK_ACTION_MODES.SELF:
        const selfPacket = buildSelfPacket(packetBytes);
        success = poe2.sendPacket(selfPacket);
        break;
        
      case QUICK_ACTION_MODES.DIRECTION_TO_TARGET: {
        // Get target entity and calculate direction toward it.
        // lightweight + includeBuffs so target.buffs is populated for any rotation
        // conditions on the quick action's skill, without the full-read cost.
        const targets = POE2Cache.getEntities({
          monstersOnly: true,
          lightweight: true,
          includeBuffs: true,
          maxDistance: qa.distance || 300
        });
        let target = null;
        for (const e of targets) {
          if (e.isAlive && e.id) {
            target = e;
            break;
          }
        }
        
        if (target) {
          // Calculate angle from player to target
          const dx = target.gridX - player.gridX;
          const dy = target.gridY - player.gridY;
          // Convert grid delta to screen angle (isometric)
          const screenX = (dx - dy);
          const screenY = (dx + dy) / 2;
          let angle = Math.atan2(screenY, screenX) * 180 / Math.PI;
          if (angle < 0) angle += 360;
          
          const deltas = angleToDeltas(angle, qa.distance || 200);
          
          if (qa.channeled) {
            success = executeChanneledSkill(packetBytes, deltas.dx, deltas.dy, 2);
          } else {
            const dirPacket = buildDirectionalPacket(packetBytes, deltas.dx, deltas.dy);
            success = poe2.sendPacket(dirPacket);
          }
        }
        break;
      }
        
      case QUICK_ACTION_MODES.CURSOR: {
        // Get cursor direction from player screen position
        const mousePos = ImGui.getMousePos();
        const playerScreen = poe2.worldToScreen(player.worldX, player.worldY, player.worldZ || 0);
        if (playerScreen && playerScreen.visible) {
          const screenDx = mousePos.x - playerScreen.x;
          const screenDy = playerScreen.y - mousePos.y;
          let cursorAngle = Math.atan2(screenDy, screenDx) * 180 / Math.PI;
          if (cursorAngle < 0) cursorAngle += 360;
          
          const deltas = angleToDeltas(cursorAngle, qa.distance || 200);
          
          if (qa.channeled) {
            success = executeChanneledSkill(packetBytes, deltas.dx, deltas.dy, 2);
          } else {
            const dirPacket = buildDirectionalPacket(packetBytes, deltas.dx, deltas.dy);
            success = poe2.sendPacket(dirPacket);
          }
        }
        break;
      }
        
      case QUICK_ACTION_MODES.DEAD_TARGET: {
        // Find nearest dead entity (for corpse skills)
        const deadTarget = findNearestDeadEntity(qa.distance || 300);
        if (deadTarget && deadTarget.id) {
          const deadPacket = buildTargetPacket(packetBytes, deadTarget.id, deadTarget.gridX, deadTarget.gridY);
          success = poe2.sendPacket(deadPacket);
        }
        break;
      }
        
      case QUICK_ACTION_MODES.CURSOR_TARGET: {
        // Find entity nearest to cursor
        const cursorTarget = findEntityNearestToCursor(qa.distance || 500);
        if (cursorTarget && cursorTarget.id) {
          const cursorTargetPacket = buildTargetPacket(packetBytes, cursorTarget.id, cursorTarget.gridX, cursorTarget.gridY);
          success = poe2.sendPacket(cursorTargetPacket);
        }
        break;
      }
        
      case QUICK_ACTION_MODES.DEAD_CURSOR_TARGET: {
        // Find dead entity nearest to cursor (for precise corpse targeting)
        const deadCursorTarget = findDeadEntityNearestToCursor(qa.distance || 500);
        if (deadCursorTarget && deadCursorTarget.id) {
          const deadCursorPacket = buildTargetPacket(packetBytes, deadCursorTarget.id, deadCursorTarget.gridX, deadCursorTarget.gridY);
          success = poe2.sendPacket(deadCursorPacket);
        }
        break;
      }
        
      case QUICK_ACTION_MODES.TARGET:
      default: {
        // Find target entity (alive). lightweight + includeBuffs so target.buffs is
        // populated for any rotation conditions on the quick action's skill,
        // without the full-read cost.
        const targets = POE2Cache.getEntities({
          monstersOnly: true,
          lightweight: true,
          includeBuffs: true,
          maxDistance: qa.distance || 300
        });
        let target = null;
        for (const e of targets) {
          if (e.isAlive && e.id) {
            target = e;
            break;
          }
        }
        
        if (target) {
          const targetPacket = buildTargetPacket(packetBytes, target.id, target.gridX, target.gridY);
          success = poe2.sendPacket(targetPacket);
        }
        break;
      }
    }
    
    if (success) {
      quickActionCooldowns[i] = now;
      console.log(`[QuickAction] Executed "${qa.name}" (${qa.mode})`);
    }
  }
}

// State for the add/edit quick action UI
const qaNameInput = new ImGui.MutableVariable("New Action");
const qaDistanceInput = new ImGui.MutableVariable(200);
const qaCooldownInput = new ImGui.MutableVariable(100);
let qaSelectedSkillIndex = -1;
let qaSelectedMode = 0;
let qaChanneled = false;

/**
 * Draw the Quick Actions management UI
 */
function drawQuickActionsUI() {
  // Get active skills for selection
  const activeSkills = getActiveSkills();
  
  // --- Existing Quick Actions List ---
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], `Quick Actions (${quickActions.length}):`);
  
  if (quickActions.length === 0) {
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], "No quick actions configured. Add one below.");
  }
  
  for (let i = 0; i < quickActions.length; i++) {
    const qa = quickActions[i];
    ImGui.pushID(`qa${i}`);
    
    // Enable/disable checkbox
    const enabledVar = new ImGui.MutableVariable(qa.enabled);
    if (ImGui.checkbox("##qaen", enabledVar)) {
      qa.enabled = enabledVar.value;
      saveQuickActions();
    }
    ImGui.sameLine();
    
    // Name and key display
    const keyStr = getQuickActionKeyString(qa);
    const modeStr = getModeLabel(qa.mode);
    
    if (qa.enabled) {
      ImGui.textColored([0.5, 1.0, 0.5, 1.0], `${qa.name}`);
    } else {
      ImGui.textColored([0.5, 0.5, 0.5, 1.0], `${qa.name}`);
    }
    ImGui.sameLine();
    ImGui.textColored([0.6, 0.8, 1.0, 1.0], `[${keyStr}]`);
    ImGui.sameLine();
    ImGui.textColored([0.8, 0.8, 0.5, 1.0], `(${modeStr})`);
    if (qa.channeled) {
      ImGui.sameLine();
      ImGui.textColored([0.5, 0.8, 1.0, 1.0], "[Chan]");
    }
    
    // Skill info
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], `   Skill: ${qa.skillName || 'Unknown'}, Distance: ${qa.distance || 200}`);
    
    // Edit controls
    if (waitingForQuickActionKey === i) {
      ImGui.pushStyleColor(ImGui.Col.Button, [0.8, 0.6, 0.0, 1.0]);
      ImGui.button("Press key...", {x: 100, y: 0});
      ImGui.popStyleColor();
      
      // Capture key
      const ctrlDown = ImGui.isKeyDown(ImGui.Key.LeftCtrl) || ImGui.isKeyDown(ImGui.Key.RightCtrl);
      const shiftDown = ImGui.isKeyDown(ImGui.Key.LeftShift) || ImGui.isKeyDown(ImGui.Key.RightShift);
      const altDown = ImGui.isKeyDown(ImGui.Key.LeftAlt) || ImGui.isKeyDown(ImGui.Key.RightAlt);
      
      for (let key = 512; key < 660; key++) {
        if (key === ImGui.Key.LeftCtrl || key === ImGui.Key.RightCtrl ||
            key === ImGui.Key.LeftShift || key === ImGui.Key.RightShift ||
            key === ImGui.Key.LeftAlt || key === ImGui.Key.RightAlt ||
            key === ImGui.Key.LeftSuper || key === ImGui.Key.RightSuper) {
          continue;
        }
        
        if (ImGui.isKeyPressed(key, false)) {
          qa.key = key;
          qa.keyCtrl = ctrlDown;
          qa.keyShift = shiftDown;
          qa.keyAlt = altDown;
          waitingForQuickActionKey = -1;
          saveQuickActions();
          break;
        }
      }
      
      if (ImGui.isKeyPressed(ImGui.Key.Escape, false)) {
        waitingForQuickActionKey = -1;
      }
      
      ImGui.sameLine();
      if (ImGui.button("Cancel##qakc", {x: 60, y: 0})) {
        waitingForQuickActionKey = -1;
      }
    } else {
      if (ImGui.button("Rebind##qak", {x: 60, y: 0})) {
        waitingForQuickActionKey = i;
      }
      ImGui.sameLine();
      if (ImGui.button("Delete##qad", {x: 60, y: 0})) {
        quickActions.splice(i, 1);
        saveQuickActions();
        ImGui.popID();
        break;  // List changed, exit loop
      }
    }
    
    ImGui.separator();
    ImGui.popID();
  }
  
  // --- Add New Quick Action ---
  ImGui.spacing();
  ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Add New Quick Action:");
  
  // Name input
  ImGui.text("Name:");
  ImGui.sameLine();
  ImGui.setNextItemWidth(150);
  ImGui.inputText("##qaname", qaNameInput);
  
  // Skill selection from active skills
  ImGui.text("Skill:");
  ImGui.sameLine();
  
  if (activeSkills.length === 0) {
    ImGui.textColored([1.0, 0.5, 0.5, 1.0], "No active skills found");
  } else {
    // Dropdown for skill selection
    ImGui.setNextItemWidth(200);
    const currentSkillName = qaSelectedSkillIndex >= 0 && qaSelectedSkillIndex < activeSkills.length 
      ? (activeSkills[qaSelectedSkillIndex].skillName || activeSkills[qaSelectedSkillIndex].resolvedName || `TypeID 0x${(activeSkills[qaSelectedSkillIndex].typeId || 0).toString(16).toUpperCase()}`)
      : "Select a skill...";
    
    if (ImGui.beginCombo("##qaskill", currentSkillName)) {
      for (let s = 0; s < activeSkills.length; s++) {
        const skill = activeSkills[s];
        const skillName = skill.skillName || skill.resolvedName || `TypeID 0x${(skill.typeId || 0).toString(16).toUpperCase()}`;
        const hasName = skill.skillName || skill.resolvedName;
        
        if (hasName) {
          if (ImGui.selectable(`${skillName}##qs${s}`, qaSelectedSkillIndex === s)) {
            qaSelectedSkillIndex = s;
          }
        } else {
          ImGui.pushStyleColor(ImGui.Col.Text, [1.0, 0.8, 0.3, 1.0]);
          if (ImGui.selectable(`${skillName}##qs${s}`, qaSelectedSkillIndex === s)) {
            qaSelectedSkillIndex = s;
          }
          ImGui.popStyleColor();
        }
      }
      ImGui.endCombo();
    }
  }
  
  // Mode selection
  ImGui.text("Mode:");
  const modes = [
    { id: QUICK_ACTION_MODES.TARGET, label: "Target (Alive)" },
    { id: QUICK_ACTION_MODES.DEAD_TARGET, label: "Dead Target" },
    { id: QUICK_ACTION_MODES.CURSOR_TARGET, label: "Cursor Target" },
    { id: QUICK_ACTION_MODES.DEAD_CURSOR_TARGET, label: "Dead Cursor Tgt" },
    { id: QUICK_ACTION_MODES.SELF, label: "Self" },
    { id: QUICK_ACTION_MODES.DIRECTION_TO_TARGET, label: "Dir to Target" },
    { id: QUICK_ACTION_MODES.CURSOR, label: "Cursor Dir" }
  ];
  
  for (let m = 0; m < modes.length; m++) {
    if (ImGui.radioButton(modes[m].label + "##qam", qaSelectedMode === m)) {
      qaSelectedMode = m;
    }
    if (m < modes.length - 1) ImGui.sameLine();
  }
  
  // Distance and Channeled (for directional modes: 5=Dir to Target, 6=Cursor Dir)
  if (qaSelectedMode === 5 || qaSelectedMode === 6) {
    ImGui.sliderInt("Distance##qadist", qaDistanceInput, 0, 500);
    
    // Channeled checkbox
    const channeledVar = new ImGui.MutableVariable(qaChanneled);
    if (ImGui.checkbox("Channeled (Blink/Dodge)", channeledVar)) {
      qaChanneled = channeledVar.value;
    }
  }
  
  // Cooldown
  ImGui.sliderInt("Cooldown (ms)##qacd", qaCooldownInput, 0, 2000);
  
  // Add button
  ImGui.spacing();
  if (qaSelectedSkillIndex >= 0 && qaSelectedSkillIndex < activeSkills.length) {
    if (ImGui.button("Add Quick Action", {x: 150, y: 30})) {
      const skill = activeSkills[qaSelectedSkillIndex];
      const newQA = {
        enabled: true,
        name: qaNameInput.value || "Quick Action",
        skillName: skill.skillName || skill.resolvedName || null,
        packetBytes: [...skill.packetBytes],
        typeId: skill.typeId,
        weaponSet: skill.weaponSet || 1,
        mode: modes[qaSelectedMode].id,
        distance: qaDistanceInput.value,
        cooldown: qaCooldownInput.value,
        channeled: qaChanneled,
        key: 0,
        keyCtrl: false,
        keyShift: false,
        keyAlt: false
      };
      
      quickActions.push(newQA);
      saveQuickActions();
      
      // Reset inputs
      qaNameInput.value = "New Action";
      qaSelectedSkillIndex = -1;
      qaSelectedMode = 0;
      qaChanneled = false;
      
      console.log(`[QuickAction] Added: ${newQA.name} (${newQA.mode})`);
    }
    ImGui.sameLine();
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "(Remember to bind a key after adding!)");
  } else {
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Select a skill to add a quick action");
  }
}

/**
 * Get display string for quick action key binding
 */
function getQuickActionKeyString(qa) {
  if (!qa.key || qa.key === 0) return "Not bound";
  let str = "";
  if (qa.keyCtrl) str += "Ctrl+";
  if (qa.keyShift) str += "Shift+";
  if (qa.keyAlt) str += "Alt+";
  str += getKeyName(qa.key);
  return str;
}

/**
 * Get display label for targeting mode
 */
function getModeLabel(mode) {
  switch (mode) {
    case QUICK_ACTION_MODES.TARGET: return "Target";
    case QUICK_ACTION_MODES.DEAD_TARGET: return "Dead";
    case QUICK_ACTION_MODES.CURSOR_TARGET: return "CursorTgt";
    case QUICK_ACTION_MODES.DEAD_CURSOR_TARGET: return "DeadCursor";
    case QUICK_ACTION_MODES.SELF: return "Self";
    case QUICK_ACTION_MODES.DIRECTION_TO_TARGET: return "Dir→Tgt";
    case QUICK_ACTION_MODES.CURSOR: return "CursorDir";
    default: return mode || "Target";
  }
}

function onDraw() {
  // NOTE: Do NOT call POE2Cache.beginFrame() here!
  // It should only be called ONCE per frame in main.js
  // The cache now detects duplicate calls and warns about them
  
  // Load player settings if not loaded or player changed
  loadPlayerSettings();

  // Channel release arbiter: run EVERY frame, before everything, even with zero targets / auto-attack off /
  // UI hidden. A hold-channel armed as its target dies must still release + stop here -- executeRotation
  // (where the release paths live) stops being called once processAutoAttack has no target, which wedged
  // the char channelling Snipe on a corpse for 28s+. O(1) when no channel is armed.
  channelArbiterTick();

  // Auto-attack and quick actions run FIRST, before any window checks (runs even when UI is hidden)
  processAutoAttack();
  processQuickActions();
  
  // Skip UI drawing if UI is hidden (F12 toggle)
  if (!Plugins.isUiVisible()) return;
  
  // Now render the UI window
  ImGui.setNextWindowSize({x: 500, y: 700}, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({x: 800, y: 10}, ImGui.Cond.FirstUseEver);  // After Entity Explorer
  ImGui.setNextWindowCollapsed(true, ImGui.Cond.Once);  // Start collapsed (once per session)
  
  if (!ImGui.begin("Entity Actions", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Get player for UI display (uses cached data)
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) {
    ImGui.textColored([1.0, 0.5, 0.5, 1.0], "Waiting for player...");
    ImGui.end();
    return;
  }

  // Get all entities for UI display - use lightweight mode to skip expensive WorldItem reads
  // Entity type classification still works via path-based detection
  const allEntities = POE2Cache.getEntities({ lightweight: true, maxDistance: maxDistance.value });
  
  // Filter and sort by distance
  const nearbyEntities = [];
  
  for (const entity of allEntities) {
    if (!entity.gridX || entity.isLocalPlayer) continue;
    
    // Calculate distance first
    const dx = entity.gridX - player.gridX;
    const dy = entity.gridY - player.gridY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist > maxDistance.value) continue;
    
    // Filter by type (if any filter is enabled, show ONLY those types)
    const anyFilterEnabled = filterMonsters.value || filterChests.value || filterNPCs.value || filterWorldItems.value;
    if (anyFilterEnabled) {
      let shouldShow = false;
      if (filterMonsters.value && entity.entityType === 'Monster') shouldShow = true;
      if (filterChests.value && entity.entityType === 'Chest') shouldShow = true;
      if (filterNPCs.value && entity.entityType === 'NPC') shouldShow = true;
      if (filterWorldItems.value && entity.name && entity.name.includes('WorldItem')) shouldShow = true;
      
      if (!shouldShow) continue;
    }
    
    nearbyEntities.push({
      entity: entity,
      distance: dist
    });
  }
  
  // Sort by distance
  nearbyEntities.sort((a, b) => a.distance - b.distance);
  
  // Limit count
  const displayEntities = nearbyEntities.slice(0, maxEntities.value);
  
  // Tab bar
  if (!ImGui.beginTabBar("EntityActionsTabs", ImGui.TabBarFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Tab 1: Quick Actions
  if (ImGui.beginTabItem("Quick Actions")) {
    // Auto-attack section
    ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Auto-Attack (Bow):");
    const prevEnabled = autoAttackEnabled.value;
    ImGui.checkbox("Enable Auto-Attack", autoAttackEnabled);
    if (prevEnabled !== autoAttackEnabled.value) {
      saveSetting('autoAttackEnabled', autoAttackEnabled.value);
    }
  
  if (autoAttackEnabled.value) {
    ImGui.indent();
    
    // Toggle mode checkbox
    const prevToggle = autoAttackToggleMode.value;
    ImGui.checkbox("Toggle Mode (press to start/stop)", autoAttackToggleMode);
    if (prevToggle !== autoAttackToggleMode.value) {
      autoAttackToggleActive = false;  // Reset toggle state when mode changes
      saveSetting('autoAttackToggleMode', autoAttackToggleMode.value);
    }
    
    // Visibility mode selection (Off / Line of Fire / Walkable LoS)
    const prevVisibilityMode = autoAttackVisibilityMode.value;
    ImGui.text("Visibility Check:");
    if (ImGui.radioButton("Off##vismode", autoAttackVisibilityMode.value === AUTO_ATTACK_VISIBILITY_MODE.OFF)) {
      autoAttackVisibilityMode.value = AUTO_ATTACK_VISIBILITY_MODE.OFF;
    }
    ImGui.sameLine();
    if (ImGui.radioButton("Line of Fire##vismode", autoAttackVisibilityMode.value === AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_FIRE)) {
      autoAttackVisibilityMode.value = AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_FIRE;
    }
    ImGui.sameLine();
    if (ImGui.radioButton("Walkable LoS##vismode", autoAttackVisibilityMode.value === AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_SIGHT)) {
      autoAttackVisibilityMode.value = AUTO_ATTACK_VISIBILITY_MODE.LINE_OF_SIGHT;
    }
    if (ImGui.isItemHovered()) {
      ImGui.setTooltip("Off: no visibility check\nLine of Fire: projectile blocking (recommended)\nWalkable LoS: walkability-based check");
    }
    if (prevVisibilityMode !== autoAttackVisibilityMode.value) {
      saveSetting('autoAttackVisibilityMode', autoAttackVisibilityMode.value);
      // Keep legacy bool synced for old configs.
      autoAttackRequireLoS.value = autoAttackVisibilityMode.value !== AUTO_ATTACK_VISIBILITY_MODE.OFF;
      saveSetting('autoAttackRequireLoS', autoAttackRequireLoS.value);
      losCache.clear();
    }
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], `Current: ${AUTO_ATTACK_VISIBILITY_MODE_NAMES[autoAttackVisibilityMode.value]}`);

    // Post-success lock (debounce cast rate)
    const prevLock = postSuccessLockMs.value;
    ImGui.sliderInt("Post-Success Lock (ms)##postLock", postSuccessLockMs, 0, 1000);
    if (ImGui.isItemHovered()) {
      ImGui.setTooltip("Minimum gap (ms) after a successful auto-attack cast before the next one can fire.\n100ms cooldown is enforced first; this value only takes effect if it's higher.\nDefault 200ms.");
    }
    if (prevLock !== postSuccessLockMs.value) {
      saveSetting('postSuccessLockMs', postSuccessLockMs.value);
    }

    // Exclusion list toggle
    ImGui.checkbox("Use Exclusion List", useAttackExclusions);
    if (ImGui.isItemHovered()) {
      ImGui.setTooltip("Skip: " + ATTACK_EXCLUSION_LIST.join(", "));
    }
    
    if (autoAttackToggleMode.value) {
      ImGui.text("Press key to toggle auto-attack on/off:");
    } else {
      ImGui.text("While holding key, attack monsters:");
    }
    
    // Key binding UI - Hotkey style like radar plugin
    const getHotkeyDisplayString = () => {
      if (autoAttackKey.value === 0) return "None";
      let str = "";
      if (autoAttackKeyCtrl.value) str += "Ctrl+";
      if (autoAttackKeyShift.value) str += "Shift+";
      if (autoAttackKeyAlt.value) str += "Alt+";
      str += getKeyName(autoAttackKey.value);
      return str;
    };
    
    ImGui.text(`Attack Key: ${getHotkeyDisplayString()}`);
    
    if (waitingForHotkey) {
      ImGui.pushStyleColor(ImGui.Col.Button, [0.8, 0.6, 0.0, 1.0]);
      ImGui.button("Press any key...", {x: 150, y: 0});
      ImGui.popStyleColor();
      
      // Check current modifier states
      const ctrlDown = ImGui.isKeyDown(ImGui.Key.LeftCtrl) || ImGui.isKeyDown(ImGui.Key.RightCtrl);
      const shiftDown = ImGui.isKeyDown(ImGui.Key.LeftShift) || ImGui.isKeyDown(ImGui.Key.RightShift);
      const altDown = ImGui.isKeyDown(ImGui.Key.LeftAlt) || ImGui.isKeyDown(ImGui.Key.RightAlt);
      
      // Capture next key press (skip modifier keys)
      for (let key = 512; key < 660; key++) {  // ImGuiKey_NamedKey_BEGIN to END approx
        // Skip modifier keys and mouse buttons
        if (key === ImGui.Key.LeftCtrl || key === ImGui.Key.RightCtrl ||
            key === ImGui.Key.LeftShift || key === ImGui.Key.RightShift ||
            key === ImGui.Key.LeftAlt || key === ImGui.Key.RightAlt ||
            key === ImGui.Key.LeftSuper || key === ImGui.Key.RightSuper) {
          continue;
        }
        
        if (ImGui.isKeyPressed(key, false)) {
          autoAttackKey.value = key;
          autoAttackKeyCtrl.value = ctrlDown;
          autoAttackKeyShift.value = shiftDown;
          autoAttackKeyAlt.value = altDown;
          waitingForHotkey = false;
          saveSetting('autoAttackKey', autoAttackKey.value);
          saveSetting('autoAttackKeyCtrl', autoAttackKeyCtrl.value);
          saveSetting('autoAttackKeyShift', autoAttackKeyShift.value);
          saveSetting('autoAttackKeyAlt', autoAttackKeyAlt.value);
          break;
        }
      }
      
      // Escape cancels
      if (ImGui.isKeyPressed(ImGui.Key.Escape, false)) {
        waitingForHotkey = false;
      }
      
      ImGui.sameLine();
      if (ImGui.button("Cancel", {x: 60, y: 0})) {
        waitingForHotkey = false;
      }
    } else {
      if (ImGui.button("Bind Key", {x: 80, y: 0})) {
        waitingForHotkey = true;
      }
      ImGui.sameLine();
      if (ImGui.button("Clear", {x: 60, y: 0})) {
        autoAttackKey.value = 0;
        autoAttackKeyCtrl.value = false;
        autoAttackKeyShift.value = false;
        autoAttackKeyAlt.value = false;
        saveSetting('autoAttackKey', 0);
        saveSetting('autoAttackKeyCtrl', false);
        saveSetting('autoAttackKeyShift', false);
        saveSetting('autoAttackKeyAlt', false);
      }
    }
    
    const prevDist = autoAttackDistance.value;
    ImGui.sliderInt("Attack Distance", autoAttackDistance, 50, 1000);
    if (prevDist !== autoAttackDistance.value) {
      saveSetting('autoAttackDistance', autoAttackDistance.value);
    }
    
    // Rarity Priority (primary filter)
    ImGui.text("Rarity Priority (Primary):");
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Target by rarity first, then use secondary sort");
    const prevRarityPrio = autoAttackRarityPriority.value;
    if (ImGui.radioButton("None##rar", autoAttackRarityPriority.value === RARITY_PRIORITY.NONE)) {
      autoAttackRarityPriority.value = RARITY_PRIORITY.NONE;
    }
    ImGui.sameLine();
    if (ImGui.radioButton("Unique First", autoAttackRarityPriority.value === RARITY_PRIORITY.UNIQUE_FIRST)) {
      autoAttackRarityPriority.value = RARITY_PRIORITY.UNIQUE_FIRST;
    }
    ImGui.sameLine();
    if (ImGui.radioButton("Rare First", autoAttackRarityPriority.value === RARITY_PRIORITY.RARE_FIRST)) {
      autoAttackRarityPriority.value = RARITY_PRIORITY.RARE_FIRST;
    }
    if (ImGui.radioButton("Magic First", autoAttackRarityPriority.value === RARITY_PRIORITY.MAGIC_FIRST)) {
      autoAttackRarityPriority.value = RARITY_PRIORITY.MAGIC_FIRST;
    }
    ImGui.sameLine();
    if (ImGui.radioButton("Normal First", autoAttackRarityPriority.value === RARITY_PRIORITY.NORMAL_FIRST)) {
      autoAttackRarityPriority.value = RARITY_PRIORITY.NORMAL_FIRST;
    }
    if (ImGui.checkbox("Boss target priority (map boss wins even when further)", bossTargetPriority)) {
      saveSetting('bossTargetPriority', bossTargetPriority.value);
    }
    if (prevRarityPrio !== autoAttackRarityPriority.value) {
      saveSetting('autoAttackRarityPriority', autoAttackRarityPriority.value);
    }
    
    ImGui.separator();
    
    // Secondary Priority (within same rarity)
    ImGui.text("Secondary Priority (within same rarity):");
    const prevPrio = autoAttackPriority.value;
    // Row 1: Distance-based
    if (ImGui.radioButton("Closest", autoAttackPriority.value === TARGET_PRIORITY.CLOSEST)) {
      autoAttackPriority.value = TARGET_PRIORITY.CLOSEST;
    }
    ImGui.sameLine();
    if (ImGui.radioButton("Furthest", autoAttackPriority.value === TARGET_PRIORITY.FURTHEST)) {
      autoAttackPriority.value = TARGET_PRIORITY.FURTHEST;
    }
    // Row 2: HP-based
    if (ImGui.radioButton("Highest Max HP", autoAttackPriority.value === TARGET_PRIORITY.HIGHEST_MAX_HP)) {
      autoAttackPriority.value = TARGET_PRIORITY.HIGHEST_MAX_HP;
    }
    ImGui.sameLine();
    if (ImGui.radioButton("Highest Current HP", autoAttackPriority.value === TARGET_PRIORITY.HIGHEST_CURRENT_HP)) {
      autoAttackPriority.value = TARGET_PRIORITY.HIGHEST_CURRENT_HP;
    }
    // Row 3: Low HP (finishing off)
    if (ImGui.radioButton("Lowest Current HP", autoAttackPriority.value === TARGET_PRIORITY.LOWEST_CURRENT_HP)) {
      autoAttackPriority.value = TARGET_PRIORITY.LOWEST_CURRENT_HP;
    }
    if (prevPrio !== autoAttackPriority.value) {
      saveSetting('autoAttackPriority', autoAttackPriority.value);
    }
    
    // Show current priority summary
    const rarityStr = autoAttackRarityPriority.value !== RARITY_PRIORITY.NONE 
      ? RARITY_PRIORITY_NAMES[autoAttackRarityPriority.value] 
      : "";
    const priorityStr = TARGET_PRIORITY_NAMES[autoAttackPriority.value];
    if (rarityStr) {
      ImGui.textColored([1.0, 0.8, 0.2, 1.0], `Priority: ${rarityStr}, then ${priorityStr}`);
    } else {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], `Priority: ${priorityStr}`);
    }
    
    ImGui.separator();
    
    ImGui.text(`Attack Byte: 0x${autoAttackYByte.value.toString(16).toUpperCase().padStart(2, '0')} (packet byte 8)`);
    const prevYByte = autoAttackYByte.value;
    ImGui.inputInt("##ybyte", autoAttackYByte, 1, 16);
    if (autoAttackYByte.value < 0) autoAttackYByte.value = 0;
    if (autoAttackYByte.value > 255) autoAttackYByte.value = 255;
    if (prevYByte !== autoAttackYByte.value) {
      saveSetting('autoAttackYByte', autoAttackYByte.value);
    }
    
    // Show status
    const isCurrentlyAttacking = autoAttackToggleMode.value ? autoAttackToggleActive : ImGui.isKeyDown(autoAttackKey.value);
    if (isCurrentlyAttacking) {
      ImGui.textColored([0.5, 1.0, 0.5, 1.0], "** ATTACKING **");
      if (lastTargetName) {
        const shortName = lastTargetName.split('/').pop() || lastTargetName;
        const idHex = lastTargetId ? `0x${lastTargetId.toString(16).toUpperCase()}` : "NO_ID";
        
        // Show rarity with color
        const rarityName = getRarityName(lastTargetRarity);
        const rarityColor = getRarityColor(lastTargetRarity);
        ImGui.textColored(rarityColor, `  [${rarityName}] ${shortName}`);
        ImGui.text(`  ID: ${idHex}`);
        
        // Show HP info if available
        if (lastTargetMaxHP > 0) {
          const hpPercent = ((lastTargetHP / lastTargetMaxHP) * 100).toFixed(1);
          ImGui.text(`  HP: ${lastTargetHP}/${lastTargetMaxHP} (${hpPercent}%)`);
        }
      }
    } else {
      const actionText = autoAttackToggleMode.value ? "press" : "hold";
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], `- Ready (${actionText} ${getKeyName(autoAttackKey.value)})`);
    }
    
    ImGui.unindent();
  }
  
  ImGui.separator();
  
  // Custom Quick Actions Section
  if (ImGui.collapsingHeader("Custom Quick Actions")) {
    drawQuickActionsUI();
  }
  
  ImGui.separator();
  
  // Manual targeting settings
  ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Manual Targeting:");
  ImGui.text("Filters:");
  ImGui.checkbox("Monsters Only", filterMonsters);
  ImGui.sameLine();
  ImGui.checkbox("Chests Only", filterChests);
  ImGui.sameLine();
  ImGui.checkbox("NPCs Only", filterNPCs);
  ImGui.sameLine();
  ImGui.checkbox("WorldItems Only", filterWorldItems);
  
  ImGui.sliderInt("Max Distance", maxDistance, 100, 2000);
  ImGui.sliderInt("Max Entities", maxEntities, 5, 50);
  
  ImGui.separator();
  ImGui.text(`Showing ${displayEntities.length} / ${nearbyEntities.length} nearby entities`);
  
  // Entity list
  ImGui.beginChild("EntityList", {x: 0, y: 0}, true);
  
  for (let i = 0; i < displayEntities.length; i++) {
    const item = displayEntities[i];
    const entity = item.entity;
    const dist = item.distance;
    
    ImGui.pushID(i);
    
    // Entity info
    const name = entity.name || "Unknown";
    const shortName = name.split('/').pop() || name;
    const idHex = entity.id ? `0x${entity.id.toString(16).toUpperCase()}` : "NO_ID";
    
    ImGui.text(`[${dist.toFixed(0)}m] ${shortName}`);
    ImGui.text(`  ID: ${idHex}, Type: ${entity.entityType || 'Unknown'}`);
    
    if (entity.id && entity.id !== 0) {
      // Action buttons
      if (ImGui.button("Move To")) {
        const success = sendMoveTo(entity.id, entity.gridX, entity.gridY);
        console.log(`Move to entity ${idHex} (${shortName}) - success=${success}`);
      }
      ImGui.sameLine();

      if (ImGui.button("Basic Attack")) {
        const success = sendAttackBasic(entity.id, entity.gridX, entity.gridY);
        console.log(`Basic attack entity ${idHex} (${shortName}) - success=${success}`);
      }
      ImGui.sameLine();

      if (ImGui.button("Attack (Bow)")) {
        const success = sendAttackBow(entity.id, entity.gridX, entity.gridY);
        console.log(`Bow attack entity ${idHex} (${shortName}) - success=${success}`);
      }
    } else {
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], "  (No ID - cannot target)");
    }
    
    ImGui.separator();
    ImGui.popID();
  }
  
  ImGui.endChild();
  
  ImGui.endTabItem();  // End Quick Actions tab
  }
  
  // Tab 2: Rotation Builder
  if (ImGui.beginTabItem("Rotation Builder")) {
    drawRotationTab();
    ImGui.endTabItem();
  }
  
  ImGui.endTabBar();
  ImGui.end();
}

export const entityActionsPlugin = {
  onDraw: onDraw
};

console.log("[EntityActions] Plugin loaded (using shared POE2Cache)");


/**
 * Rotation Builder v2
 * 
 * Build custom skill rotations with conditions and save them.
 * Skills are stored by NAME for shareability - rotations work across
 * different characters even if skill slots differ.
 * 
 * Features:
 * - Add skills from Active Skills list (no manual packet copying)
 * - Search skills by name
 * - Multiple targeting modes: Target, Self, Direction, Position
 * - Test Skill feature to try skills before adding
 * - Shareable rotations (skill names, not slot-dependent)
 */

import { poe2, POE2Cache } from './poe2_cache.js';
import { int32ToBytesBE } from './movement.js';

// Rotation data structure - loaded from file
let rotations = [];
let currentRotationName = "default";
let availableRotations = [];
const ROTATIONS_FILE = "rotations_v2.json";
const rotationNameInput = new ImGui.MutableVariable("default");

// UI state
let editingIndex = -1;
let activeTab = 0;  // 0 = Rotation, 1 = Add Skill, 2 = Test Skill, 3 = Entity Skills

// Per-skill inline editor state for the hold-channel timeout. Tracks which skill
// the shared MutableVariable currently mirrors so we re-sync on edit-target switch.
const editChannelTimeoutVar = new ImGui.MutableVariable(1700);
let editChannelTimeoutSkillIdx = -1;

// Entity skills explorer state
const entitySkillsRange = new ImGui.MutableVariable(500);
let selectedEntityIndex = -1;
let expandedEntitySkills = {};  // Track which entities are expanded
const entityTestMode = new ImGui.MutableVariable(0);  // 0=Target, 1=Self, 2=Direction, 3=Cursor
const entityTestDistance = new ImGui.MutableVariable(200);
const entityTestAngle = new ImGui.MutableVariable(0);
const entityTestChanneled = new ImGui.MutableVariable(false);

// Add skill state
const searchSkillName = new ImGui.MutableVariable("");
const manualSkillName = new ImGui.MutableVariable("New Skill");
const manualPacket = new ImGui.MutableVariable("85 06 00 40");
let selectedActiveSkill = -1;
let selectedTargetMode = 0;  // 0=Target, 1=Self, 2=Direction, 3=Position
const directionAngle = new ImGui.MutableVariable(0);
const directionDistance = new ImGui.MutableVariable(0);
const addChanneled = new ImGui.MutableVariable(false);

// Test skill state
let testSkillIndex = -1;
const testTargetMode = new ImGui.MutableVariable(0);
const testDirection = new ImGui.MutableVariable(0);
const testDistance = new ImGui.MutableVariable(200);
const testChanneled = new ImGui.MutableVariable(false);
const testUseCursor = new ImGui.MutableVariable(false);

// Condition editing
let selectedConditionType = 0;
let selectedOperator = 0;
const conditionValue = new ImGui.MutableVariable(0);
const conditionStringValue = new ImGui.MutableVariable("");
const conditionRadius = new ImGui.MutableVariable(30);   // radius slider for 'nearby_monster_count'

// Per-skill last-cast timestamps (ms) for the 'cast_interval_ms' condition.
// Keyed by skill identity (name). Updated when a skill successfully fires.
const _lastCastAt = {};
function _skillKey(skill) {
  return (skill && (skill.skillName || skill.resolvedName || skill.name)) || '?';
}

// Hard floor between casts of the SAME skill, applied even when a skill has no cast_interval_ms
// condition. Prevents the multi-caster double-fire (auto-attack via onDraw + SpikenQOL bot via onTick
// both drive the shared rotation) from spamming ANY skill. 250ms is comfortably below our real cast
// cadence, so it never slows a skill that was already gated, but kills rapid double-fires.
const GLOBAL_MIN_CAST_GAP_MS = 250;
function _skillIntervalMs(skill) {
  const c = skill && skill.conditions && skill.conditions.find(x => x && x.type === 'cast_interval_ms');
  const v = c ? parseFloat(c.value) : 0;
  return Math.max(GLOBAL_MIN_CAST_GAP_MS, v || 0);
}
// One-cast-per-frame arbiter: set to the frame number on a successful cast so a second caller in the
// SAME frame can't double-fire. Shared module state (single module instance, audit-confirmed).
let _lastCastFrame = -1;
let _lastGlobalCastAt = 0;  // wall-clock of the last SUCCESSFUL cast of ANY skill (global post-cast gate)

// Targeting modes
const TARGET_MODES = [
  { id: 'target', label: 'Target Entity', desc: 'Attack the auto-attack target (alive)' },
  { id: 'dead_target', label: 'Dead Target', desc: 'Target nearest dead entity (corpse skills)' },
  { id: 'cursor_target', label: 'Cursor Target', desc: 'Target entity nearest to cursor' },
  { id: 'dead_cursor_target', label: 'Dead Cursor Target', desc: 'Target dead entity nearest to cursor' },
  { id: 'self', label: 'Self', desc: 'Cast on self (no target ID)' },
  { id: 'direction', label: 'Direction', desc: 'Cast in a direction (angle + distance)' },
  { id: 'cursor', label: 'Cursor Position', desc: 'Cast at cursor/mouse position' }
];

// Condition types
const CONDITION_TYPES = [
  { id: 'always', label: 'Always (no condition)', unit: 'none' },
  { id: 'distance', label: 'Distance to target', unit: 'units' },
  { id: 'monster_health_pct', label: 'Monster Health %', unit: '%' },
  { id: 'monster_max_health', label: 'Monster Max HP', unit: 'hp' },
  { id: 'monster_current_health', label: 'Monster Current HP', unit: 'hp' },
  { id: 'monster_rarity', label: 'Monster Rarity', unit: 'rarity' },
  { id: 'monster_has_buff', label: 'Monster has buff', unit: 'buff_name' },
  { id: 'monster_missing_buff', label: 'Monster missing buff', unit: 'buff_name' },
  { id: 'player_health', label: 'Player Health %', unit: '%' },
  { id: 'player_mana', label: 'Player Mana', unit: 'points' },
  { id: 'player_mana_pct', label: 'Player Mana %', unit: '%' },
  { id: 'player_es', label: 'Player ES %', unit: '%' },
  { id: 'player_rage', label: 'Player Rage', unit: 'points' },
  { id: 'player_rage_pct', label: 'Player Rage %', unit: '%' },
  { id: 'player_has_buff', label: 'Player has buff', unit: 'buff_name' },
  { id: 'player_missing_buff', label: 'Player missing buff', unit: 'buff_name' },
  { id: 'monster_cullable', label: 'Monster is cullable', unit: 'bool' },
  { id: 'monster_stunnable', label: 'Monster is stunnable (stagger)', unit: 'bool' },
  // Throttle: only fire this skill if at least N ms have passed since it last fired (per-skill timer).
  // Operator is ignored (always a "min elapsed" gate). e.g. cast Lightning Rod every 6000ms.
  { id: 'cast_interval_ms', label: 'Cast interval (min ms between casts)', unit: 'ms' },
  // AoE-at-packs: count of alive monsters within `radius` grid units of the target (else player),
  // compared via operator/value. e.g. >= 3 monsters within 30. Adds a radius slider.
  { id: 'nearby_monster_count', label: 'Nearby monster count (radius)', unit: 'count' },
  // Maintain-a-deployable: count entities whose metadata path contains `stringValue` (e.g. your own
  // "TornadoShotTornado" / "LightningRod") within `radius` of the target (else player). e.g. < 1 =
  // "none of mine up near the target" -> recast. Pair with cast_interval_ms to throttle re-placement.
  { id: 'nearby_deployable_count', label: 'Nearby deployable count (by path, radius)', unit: 'count' },
  // Channel-release condition (only ChannelledSnipe tested): on a channelled skill, release the hold the
  // instant the perfect-strike window opens (anim stage > 20). Does NOT gate casting — it's a release marker.
  { id: 'perfectWindow', label: 'Perfect Window release (channelled — Snipe)', unit: 'none' }
];

const RARITY_VALUES = { NORMAL: 0, MAGIC: 1, RARE: 2, UNIQUE: 3 };
const RARITY_LABELS = ['Normal', 'Magic', 'Rare', 'Unique'];
const OPERATORS = ['>', '<', '>=', '<=', '==', '!='];

// Direction presets for easy selection
const DIRECTION_PRESETS = [
  { angle: 0, label: 'E (Right)' },
  { angle: 45, label: 'NE' },
  { angle: 90, label: 'N (Up)' },
  { angle: 135, label: 'NW' },
  { angle: 180, label: 'W (Left)' },
  { angle: 225, label: 'SW' },
  { angle: 270, label: 'S (Down)' },
  { angle: 315, label: 'SE' }
];

// ============================================================================
// SKILL LOOKUP - Find skill packet by name from active skills
// ============================================================================

// Per-frame caches. Workflow finding: getActiveSkills was the dominant per-cast
// cost -- raw poe2.getLocalPlayer() called once per skill lookup in findSkillByName,
// hitting the shared player-component mutex 36-60x/sec during a 6-skill rotation
// firing at 3-5 casts/sec. Cache the active-skills list per frame and memoize
// findSkillByName per (frame, name) so repeated lookups within a frame are O(1).
let _activeSkillsCache = null;
let _activeSkillsCacheFrame = -1;
const _skillLookupCache = new Map();
let _skillLookupCacheFrame = -1;
let _cooldownsCache = null;
let _cooldownsCacheFrame = -1;
let _nearbyMonstersCache = null;
let _nearbyMonstersCacheFrame = -1;
let _nearbyDeployCache = null;
let _nearbyDeployCacheFrame = -1;

// Alive monsters near the player (per-frame cached). Used by the 'nearby_monster_count'
// condition to count a pack around the target. maxDistance is player-centred but generous
// enough to include any monster near the (in-range) target.
function getNearbyMonsters() {
  const frame = POE2Cache.getFrameNumber();
  if (_nearbyMonstersCacheFrame === frame) return _nearbyMonstersCache || [];
  let list = [];
  try {
    list = poe2.getEntities({ monstersOnly: true, lightweight: true, maxDistance: 250 }) || [];
  } catch (e) { list = []; }
  _nearbyMonstersCache = list;
  _nearbyMonstersCacheFrame = frame;
  return list;
}

// Non-monster entities near the player (per-frame cached) for the 'nearby_deployable_count'
// condition — counts your placed objects/NPCs by metadata-path substring (e.g. "TornadoShotTornado",
// "LightningRod"). monstersOnly is OFF so NPC/object-typed deployables are included (the deployed
// tornado reads as type NPC); lightweight + bounded distance keeps it cheap, and it only runs when a
// skill actually carries this condition. Solo-only assumption: every match is yours (no owner check),
// same as SkillFlow counting LightningRod entities without ownership.
function getNearbyDeployables() {
  const frame = POE2Cache.getFrameNumber();
  if (_nearbyDeployCacheFrame === frame) return _nearbyDeployCache || [];
  let list = [];
  try {
    list = poe2.getEntities({ lightweight: true, maxDistance: 200 }) || [];
  } catch (e) { list = []; }
  _nearbyDeployCache = list;
  _nearbyDeployCacheFrame = frame;
  return list;
}

/**
 * Get the player's active skills from Actor component (per-frame cached)
 */
function getActiveSkills() {
  const frame = POE2Cache.getFrameNumber();
  if (_activeSkillsCacheFrame === frame) return _activeSkillsCache || [];
  const player = POE2Cache.getLocalPlayer();
  _activeSkillsCache = (player && player.activeSkills) || [];
  _activeSkillsCacheFrame = frame;
  return _activeSkillsCache;
}

/**
 * Find a skill by name in active skills (case-insensitive partial match)
 * Checks both skillName (from memory) and resolvedName (from TypeID hash)
 * Memoized per-frame on the skill-name key.
 */
function findSkillByName(skillName) {
  if (!skillName) return null;
  const frame = POE2Cache.getFrameNumber();
  if (_skillLookupCacheFrame !== frame) {
    _skillLookupCache.clear();
    _skillLookupCacheFrame = frame;
  }
  if (_skillLookupCache.has(skillName)) return _skillLookupCache.get(skillName);

  const skills = getActiveSkills();
  const searchLower = skillName.toLowerCase();

  // Prefer the REAL hotbar cast (packet marker 0x85, slots 0-7) over meta / weapon-set / mirage-
  // SOCKETED duplicates (marker 0x80, slot 128). Socketing a gem (e.g. Ice Shot) into Mirage
  // Deadeye adds duplicate same-name skills that sort BEFORE the hotbar one; their 0x80 packet
  // casts nothing, so a plain first-match grabbed the dead copy and the bot "stopped attacking".
  // pick() takes the 0x85 match when present, else falls back to the first match (skills with
  // unique names like DodgeRoll/Blink have a single match and are unaffected).
  const isHotbar = s => s.packetBytes && s.packetBytes[0] === 0x85;
  const pick = (arr) => arr.find(isHotbar) || arr[0] || null;

  // Tiers: exact skillName, exact resolvedName, partial skillName, partial resolvedName.
  let found = pick(skills.filter(s => s.skillName && s.skillName.toLowerCase() === searchLower));
  if (!found) found = pick(skills.filter(s => s.resolvedName && s.resolvedName.toLowerCase() === searchLower));
  if (!found) found = pick(skills.filter(s => s.skillName && s.skillName.toLowerCase().includes(searchLower)));
  if (!found) found = pick(skills.filter(s => s.resolvedName && s.resolvedName.toLowerCase().includes(searchLower)));

  const result = found || null;
  _skillLookupCache.set(skillName, result);
  return result;
}

/**
 * Find the nearest dead entity (for corpse skills)
 * @param {number} maxDistance - Maximum distance to search
 * @returns {object|null} - Dead entity or null
 */
function findNearestDeadEntity(maxDistance = 300) {
  const player = poe2.getLocalPlayer();
  if (!player || player.gridX === undefined) return null;
  
  // Use lightweight + monstersOnly since we only care about monster corpses
  const entities = poe2.getEntities({ maxDistance: maxDistance, monstersOnly: true, lightweight: true });
  let nearest = null;
  let nearestDist = Infinity;
  
  for (const entity of entities) {
    if (entity.isLocalPlayer) continue;
    if (!entity.id || entity.id === 0) continue;
    
    // Check if entity is dead (isAlive === false and had health)
    if (entity.isAlive !== false) continue;
    
    const dx = entity.gridX - player.gridX;
    const dy = entity.gridY - player.gridY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = entity;
    }
  }
  
  return nearest;
}

/**
 * Find entity nearest to cursor position
 * @param {number} maxDistance - Maximum distance from player to consider
 * @returns {object|null} - Entity nearest to cursor or null
 */
function findEntityNearestToCursor(maxDistance = 500) {
  const player = poe2.getLocalPlayer();
  if (!player || player.worldX === undefined) return null;
  
  const mousePos = ImGui.getMousePos();
  // Use lightweight mode - we don't need WorldItem data for cursor targeting
  const entities = poe2.getEntities({ maxDistance: maxDistance, lightweight: true });
  
  let nearest = null;
  let nearestScreenDist = Infinity;
  
  for (const entity of entities) {
    if (entity.isLocalPlayer) continue;
    if (!entity.id || entity.id === 0) continue;
    if (!entity.worldX) continue;
    
    // Convert entity world position to screen position
    const entityScreen = poe2.worldToScreen(entity.worldX, entity.worldY, entity.worldZ || 0);
    if (!entityScreen || !entityScreen.visible) continue;
    
    // Calculate screen distance from cursor to entity
    const screenDx = mousePos.x - entityScreen.x;
    const screenDy = mousePos.y - entityScreen.y;
    const screenDist = Math.sqrt(screenDx * screenDx + screenDy * screenDy);
    
    if (screenDist < nearestScreenDist) {
      nearestScreenDist = screenDist;
      nearest = entity;
    }
  }
  
  return nearest;
}

/**
 * Find entity nearest to cursor position (alive only)
 * @param {number} maxDistance - Maximum distance from player to consider
 * @returns {object|null} - Alive entity nearest to cursor or null
 */
function findAliveEntityNearestToCursor(maxDistance = 500) {
  const player = poe2.getLocalPlayer();
  if (!player || player.worldX === undefined) return null;
  
  const mousePos = ImGui.getMousePos();
  // Use lightweight mode - we don't need WorldItem data for cursor targeting
  const entities = poe2.getEntities({ maxDistance: maxDistance, lightweight: true });
  
  let nearest = null;
  let nearestScreenDist = Infinity;
  
  for (const entity of entities) {
    if (entity.isLocalPlayer) continue;
    if (!entity.id || entity.id === 0) continue;
    if (!entity.worldX) continue;
    if (entity.isAlive === false) continue;  // Skip dead entities
    
    // Convert entity world position to screen position
    const entityScreen = poe2.worldToScreen(entity.worldX, entity.worldY, entity.worldZ || 0);
    if (!entityScreen || !entityScreen.visible) continue;
    
    // Calculate screen distance from cursor to entity
    const screenDx = mousePos.x - entityScreen.x;
    const screenDy = mousePos.y - entityScreen.y;
    const screenDist = Math.sqrt(screenDx * screenDx + screenDy * screenDy);
    
    if (screenDist < nearestScreenDist) {
      nearestScreenDist = screenDist;
      nearest = entity;
    }
  }
  
  return nearest;
}

/**
 * Find dead entity nearest to cursor position (for corpse skills)
 * @param {number} maxDistance - Maximum distance from player to consider
 * @returns {object|null} - Dead entity nearest to cursor or null
 */
function findDeadEntityNearestToCursor(maxDistance = 500) {
  const player = poe2.getLocalPlayer();
  if (!player || player.worldX === undefined) return null;
  
  const mousePos = ImGui.getMousePos();
  // Use lightweight + monstersOnly since we only care about monster corpses
  const entities = poe2.getEntities({ maxDistance: maxDistance, monstersOnly: true, lightweight: true });
  
  let nearest = null;
  let nearestScreenDist = Infinity;
  
  for (const entity of entities) {
    if (entity.isLocalPlayer) continue;
    if (!entity.id || entity.id === 0) continue;
    if (!entity.worldX) continue;
    if (entity.isAlive !== false) continue;  // Only dead entities
    
    // Convert entity world position to screen position
    const entityScreen = poe2.worldToScreen(entity.worldX, entity.worldY, entity.worldZ || 0);
    if (!entityScreen || !entityScreen.visible) continue;
    
    // Calculate screen distance from cursor to entity
    const screenDx = mousePos.x - entityScreen.x;
    const screenDy = mousePos.y - entityScreen.y;
    const screenDist = Math.sqrt(screenDx * screenDx + screenDy * screenDy);
    
    if (screenDist < nearestScreenDist) {
      nearestScreenDist = screenDist;
      nearest = entity;
    }
  }
  
  return nearest;
}

/**
 * Build packet bytes for a skill from its name
 * Returns null if skill not found
 */
function getSkillPacketByName(skillName) {
  const skill = findSkillByName(skillName);
  if (!skill || !skill.packetBytes) return null;
  return skill.packetBytes;
}

// ============================================================================
// PACKET BUILDING
// ============================================================================

/**
 * Build a skill packet for target-based skills
 * @param {number[]} packetBytes - The 4 skill identifier bytes [marker, slot, typeHi, typeLo]
 * @param {number} targetId - Entity ID to target (big-endian)
 */
function buildTargetPacket(packetBytes, targetId, gridX, gridY) {
  const bytes = [
    0x01, 0xA3, 0x01,           // Opcode + header
    packetBytes[0],             // Marker (0x85, etc.)
    packetBytes[1],             // Slot
    packetBytes[2],             // TypeID high
    packetBytes[3],             // TypeID low
    0x04, 0x00, 0xFF, 0x08,     // Flags
    (targetId >> 24) & 0xFF,    // Target ID (big-endian)
    (targetId >> 16) & 0xFF,
    (targetId >> 8) & 0xFF,
    targetId & 0xFF
  ];
  // 050b SUBPATCH: entity-targeted packets now require the target's INTEGER grid (BE u32)
  // appended after the entity ID. Captured interact packet: [..][id BE][gridX BE][gridY BE]
  // (e.g. id 0x3B, grid 0x605/0x25F = 1541/607, floored from 1541.5/607.5). Without the
  // grid the server ignores the target. Pass undefined grid to keep the legacy short form.
  if (gridX !== undefined && gridX !== null && gridY !== undefined && gridY !== null) {
    const gx = Math.floor(gridX), gy = Math.floor(gridY);
    bytes.push((gx >>> 24) & 0xFF, (gx >>> 16) & 0xFF, (gx >>> 8) & 0xFF, gx & 0xFF);
    bytes.push((gy >>> 24) & 0xFF, (gy >>> 16) & 0xFF, (gy >>> 8) & 0xFF, gy & 0xFF);
  }
  return new Uint8Array(bytes);
}

/**
 * Build a skill packet for self-cast (no target)
 */
function buildSelfPacket(packetBytes) {
  return new Uint8Array([
    0x01, 0xA3, 0x01,
    packetBytes[0], packetBytes[1], packetBytes[2], packetBytes[3],
    0x04, 0x00, 0xFF, 0x00      // Self-cast flags
  ]);
}

/**
 * Build a skill packet for directional casting
 * @param {number[]} packetBytes - Skill identifier bytes
 * @param {number} deltaX - X offset
 * @param {number} deltaY - Y offset
 */
function buildDirectionalPacket(packetBytes, deltaX, deltaY) {
  // Convert to big-endian bytes
  const xBytes = int32ToBytesBE(Math.round(deltaX));
  const yBytes = int32ToBytesBE(Math.round(deltaY));
  
  return new Uint8Array([
    0x01, 0xA3, 0x01,
    packetBytes[0], packetBytes[1], packetBytes[2], packetBytes[3],
    0x04, 0x00, 0xFF, 0x00,
    ...xBytes,
    ...yBytes
  ]);
}

// ============================================================================
// CHANNELING PACKETS (for Blink, Dodge Roll, etc.)
// ============================================================================

/**
 * Send channel start packet (02 D0 01 01)
 * Required before channeled/movement skills
 */
function sendChannelStart() {
  return poe2.sendPacket(new Uint8Array([0x02, 0xD0, 0x01, 0x01]));
}

/**
 * Send channel end packet (02 D0 01 00)
 * Required after channeled/movement skills
 */
function sendChannelEnd() {
  return poe2.sendPacket(new Uint8Array([0x02, 0xD0, 0x01, 0x00]));
}

/**
 * Send stop action packet (01 97 01)
 */
function sendStopAction() {
  // 050b subpatch: stop-action opcode is 0x01 0xAA 0x01 (was 0xA3 here = the cast opcode, wrong).
  return poe2.sendPacket(new Uint8Array([0x01, 0xAA, 0x01]));
}

/**
 * Build continuation packet (01 93 01) for channeled skills (Blink, etc.)
 * Format: 01 93 01 [int32 X BE] [int32 Y BE] [4 skill bytes]
 * @param {number[]} packetBytes - Skill identifier bytes
 * @param {number} deltaX - X offset
 * @param {number} deltaY - Y offset
 */
function buildContinuationPacket(packetBytes, deltaX, deltaY) {
  const xBytes = int32ToBytesBE(Math.round(deltaX));
  const yBytes = int32ToBytesBE(Math.round(deltaY));
  
  return new Uint8Array([
    0x01, 0x93, 0x01,
    ...xBytes,
    ...yBytes,
    packetBytes[0], packetBytes[1], packetBytes[2], packetBytes[3]
  ]);
}

/**
 * Encode a signed integer as zigzag varint bytes (for movement input system)
 * Zigzag: (n << 1) ^ (n >> 31) maps signed to unsigned
 * Varint: 7 bits per byte, high bit = continuation
 */
function encodeZigzagVarint(value) {
  let zigzag = (value << 1) ^ (value >> 31);
  zigzag = zigzag >>> 0;
  
  const bytes = [];
  while (zigzag >= 0x80) {
    bytes.push((zigzag & 0x7F) | 0x80);
    zigzag >>>= 7;
  }
  bytes.push(zigzag & 0x7F);
  return bytes;
}

/**
 * Build a sprint/movement continuation packet (00 5A 01)
 * Used for sprint and movement input, NOT for skill channeling.
 * Format: 00 5A 01 [varint X] [varint Y] 00 00 01
 * @param {number} deltaX - X offset 
 * @param {number} deltaY - Y offset
 */
function buildMovementPacket(deltaX, deltaY) {
  const xBytes = encodeZigzagVarint(Math.round(deltaX));
  const yBytes = encodeZigzagVarint(Math.round(deltaY));
  
  return new Uint8Array([
    0x00, 0x5A, 0x01,
    ...xBytes,
    ...yBytes,
    0x00, 0x00, 0x01
  ]);
}

/**
 * Build a movement stop packet (zero-coord movement input)
 * Format: 00 5A 01 00 00 00 00 00
 */
function buildMovementStop() {
  return new Uint8Array([0x00, 0x5A, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

/**
 * Execute a channeled skill (Blink, Dodge Roll, etc.)
 * Packet sequence (Jan 2026 update):
 *   02 D0 01 01                                       <- channel start
 *   01 90 01 [skill] 04 00 FF 00 [X BE] [Y BE]       <- directional main skill
 *   01 93 01 [X BE] [Y BE] [skill]                    <- continuation (repeated)
 *   02 D0 01 00                                       <- channel end
 *   01 97 01                                          <- stop action
 *
 * @param {number[]} packetBytes - Skill identifier bytes
 * @param {number} deltaX - X offset
 * @param {number} deltaY - Y offset
 * @param {number} continuationCount - Number of continuation packets (default 2)
 */
function executeChanneledSkill(packetBytes, deltaX, deltaY, continuationCount = 2) {
  // 1. Channel start
  sendChannelStart();
  
  // 2. Main directional skill packet
  const mainPacket = buildDirectionalPacket(packetBytes, deltaX, deltaY);
  poe2.sendPacket(mainPacket);
  
  // 3. Continuation packets
  const contPacket = buildContinuationPacket(packetBytes, deltaX, deltaY);
  for (let i = 0; i < continuationCount; i++) {
    poe2.sendPacket(contPacket);
  }
  
  // 4. Channel end
  sendChannelEnd();
  
  // 5. Stop action (comes AFTER channel end now)
  sendStopAction();
  
  return true;
}

/**
 * Calculate direction deltas from angle and distance
 */
function angleToDeltas(angleDegrees, distance) {
  // Handle zero distance - return zeros
  if (distance === 0) {
    return { dx: 0, dy: 0 };
  }
  
  const radians = angleDegrees * Math.PI / 180;
  const screenX = Math.cos(radians);
  const screenY = Math.sin(radians);
  
  // Convert screen to isometric
  const isoX = screenX + screenY;
  const isoY = -screenX + screenY;
  
  const magnitude = Math.sqrt(isoX * isoX + isoY * isoY);
  const dx = Math.round((isoX / magnitude) * distance);
  const dy = Math.round((isoY / magnitude) * distance);
  
  return { dx, dy };
}

// ============================================================================
// ROTATION STORAGE
// ============================================================================

function loadRotations() {
  try {
    const data = fs.readFile(ROTATIONS_FILE);
    if (data) {
      const parsed = JSON.parse(data);
      availableRotations = Object.keys(parsed);
      rotations = parsed[currentRotationName] || [];
      console.log(`[Rotation] Loaded ${rotations.length} skills for rotation: ${currentRotationName}`);
    }
  } catch (e) {
    console.log("[Rotation] No saved rotations, starting fresh");
    rotations = [];
    availableRotations = [];
  }
}

function saveRotations() {
  try {
    let allRotations = {};
    try {
      const existing = fs.readFile(ROTATIONS_FILE);
      if (existing) allRotations = JSON.parse(existing);
    } catch (e) {}
    
    allRotations[currentRotationName] = rotations;
    fs.writeFile(ROTATIONS_FILE, JSON.stringify(allRotations, null, 2));
    console.log(`[Rotation] Saved ${rotations.length} skills`);
  } catch (e) {
    console.error("[Rotation] Failed to save:", e);
  }
}

function switchRotation(rotationName) {
  saveRotations();
  currentRotationName = rotationName;
  loadRotations();
}

// ============================================================================
// CONDITION EVALUATION
// ============================================================================

function evaluateCondition(condition, player, target, distance, skill, now) {
  const { type, operator, value, stringValue } = condition;
  if (now === undefined) now = Date.now();

  if (type === 'always') return true;
  // Release marker, not a cast gate — never blocks casting. The hold-channel arbiter reads its presence
  // (via _hasPerfectWindowCond) to release the channel at the perfect window. See _activeChannel.
  if (type === 'perfectWindow') return true;

  let actual = 0;
  
  switch (type) {
    case 'distance':
      actual = distance;
      break;
    case 'monster_health_pct':
      if (!target || !target.healthMax || target.healthMax === 0) return false;
      actual = (target.healthCurrent / target.healthMax) * 100;
      break;
    case 'monster_max_health':
      if (!target) return false;
      actual = target.healthMax || 0;
      break;
    case 'monster_current_health':
      if (!target) return false;
      actual = target.healthCurrent || 0;
      break;
    case 'monster_rarity':
      if (!target) return false;
      actual = target.rarity || 0;
      break;
    case 'monster_has_buff':
      if (!target || !target.buffs) return false;
      return target.buffs.some(b => b.name && b.name.includes(stringValue || ''));
    case 'monster_missing_buff':
      if (!target || !target.buffs) return true;  // No buffs = missing
      return !target.buffs.some(b => b.name && b.name.includes(stringValue || ''));
    case 'player_health':
      if (!player || !player.healthMax || player.healthMax === 0) return false;
      actual = (player.healthCurrent / player.healthMax) * 100;
      break;
    case 'player_mana':
      if (!player) return false;
      actual = player.manaCurrent || 0;
      break;
    case 'player_mana_pct':
      if (!player || !player.manaMax || player.manaMax === 0) return false;
      actual = (player.manaCurrent / player.manaMax) * 100;
      break;
    case 'player_es':
      if (!player || !player.esMax || player.esMax === 0) return false;
      actual = (player.esCurrent / player.esMax) * 100;
      break;
    case 'player_rage':
      if (!player) return false;
      actual = player.rageCurrent || 0;
      break;
    case 'player_rage_pct':
      if (!player || !player.rageMax || player.rageMax === 0) return false;
      actual = (player.rageCurrent / player.rageMax) * 100;
      break;
    case 'player_has_buff':
      if (!player || !player.buffs) return false;
      return player.buffs.some(b => b.name && b.name.includes(stringValue || ''));
    case 'player_missing_buff':
      if (!player || !player.buffs) return true;  // No buffs = missing
      return !player.buffs.some(b => b.name && b.name.includes(stringValue || ''));
    case 'monster_cullable': {
      if (!target || !target.healthMax || target.healthMax === 0) return false;
      const hpFrac = target.healthCurrent / target.healthMax;
      const cullThresh = [0.35, 0.20, 0.10, 0.05];
      const cullRarity = target.rarity !== undefined ? target.rarity : 0;
      return hpFrac <= cullThresh[cullRarity < 4 ? cullRarity : 0];
    }
    case 'cast_interval_ms': {
      // Throttle gate: pass only if at least `value` ms elapsed since this skill last fired.
      // Operator ignored. Without a skill key (e.g. preview) treat as not-yet-cast -> pass.
      const intervalMs = parseFloat(value) || 0;
      if (!skill) return true;
      const last = _lastCastAt[_skillKey(skill)] || 0;
      return (now - last) >= intervalMs;
    }
    case 'nearby_monster_count': {
      // Count alive monsters within `radius` grid units of the target (else the player),
      // then compare via operator/value. Radius defaults to 30 if unset (old configs).
      const radius = parseFloat(condition.radius) || 30;
      const cx = target && target.gridX !== undefined ? target.gridX : (player ? player.gridX : undefined);
      const cy = target && target.gridY !== undefined ? target.gridY : (player ? player.gridY : undefined);
      if (cx === undefined || cy === undefined) return false;
      const r2 = radius * radius;
      let cnt = 0;
      for (const m of getNearbyMonsters()) {
        if (!m.isAlive || m.gridX === undefined) continue;
        const dx = m.gridX - cx, dy = m.gridY - cy;
        if (dx * dx + dy * dy <= r2) cnt++;
      }
      actual = cnt;
      break;
    }
    case 'nearby_deployable_count': {
      // Count entities whose metadata path contains `stringValue` within `radius` grid units of the
      // target (else player), then compare via operator/value. "Maintain a deployable": e.g. recast
      // Tornado Shot only when count of "TornadoShotTornado" near the target is < 1. Anchor follows
      // the target (the boss/pack you're firing at). Pair with cast_interval_ms to throttle.
      const needle = (stringValue || '').toLowerCase();
      if (!needle) return false;
      const radius = parseFloat(condition.radius) || 60;
      const cx = target && target.gridX !== undefined ? target.gridX : (player ? player.gridX : undefined);
      const cy = target && target.gridY !== undefined ? target.gridY : (player ? player.gridY : undefined);
      if (cx === undefined || cy === undefined) return false;
      const r2 = radius * radius;
      let cnt = 0;
      for (const e of getNearbyDeployables()) {
        if (e.gridX === undefined || !e.name) continue;
        if (e.name.toLowerCase().indexOf(needle) === -1) continue;
        const dx = e.gridX - cx, dy = e.gridY - cy;
        if (dx * dx + dy * dy <= r2) cnt++;
      }
      actual = cnt;
      break;
    }
    case 'monster_stunnable': {
      if (!target) return false;
      let staggerPct = 0;
      if (target.staggerPct !== undefined) {
        staggerPct = target.staggerPct;
      } else if (target.staggerCurrent !== undefined && target.staggerMax > 0) {
        staggerPct = target.staggerCurrent / target.staggerMax;
      } else {
        return false;
      }
      const stunThresh = [0.40, 0.50, 0.60, 0.70];
      const stunRarity = target.rarity !== undefined ? target.rarity : 0;
      return staggerPct >= stunThresh[stunRarity < 4 ? stunRarity : 0];
    }
    default:
      return false;
  }
  
  const threshold = parseFloat(value) || 0;
  switch (operator) {
    case '>': return actual > threshold;
    case '<': return actual < threshold;
    case '>=': return actual >= threshold;
    case '<=': return actual <= threshold;
    case '==': return Math.abs(actual - threshold) < 0.01;
    case '!=': return Math.abs(actual - threshold) >= 0.01;
    default: return false;
  }
}

function checkConditions(skill, player, target, distance) {
  if (!skill.conditions || skill.conditions.length === 0) return true;
  const now = Date.now();
  for (const condition of skill.conditions) {
    if (!evaluateCondition(condition, player, target, distance, skill, now)) return false;
  }
  return true;
}

// ============================================================================
// ROTATION EXECUTION
// ============================================================================

/**
 * Execute rotation on target
 * Skills are looked up by NAME at runtime for shareability
 */
// Hold-channel state (for skills like ChannelledSnipe). Set when a skill with
// channelUntilBuff is cast; cleared when the per-skill timeout (jittered ±100ms)
// elapses. While set, executeRotation blocks new skill casts.
let _activeChannel = null;
// shape: { startedAt: ms, timeoutMs: int, skillName: str }

// Defensive caps. If a channel survives this long, something is wrong (zone change,
// rotation paused, executeRotation not called) — nuke without sending a stale stop.
const _CHANNEL_STALE_MS = 5000;
// Hard ceiling on per-skill channelTimeoutMs in case rotation JSON has garbage.
const _CHANNEL_TIMEOUT_CAP_MS = 3000;
const _CHANNEL_TIMEOUT_DEFAULT_MS = 1700;
const _CHANNEL_TIMEOUT_JITTER_MS = 100;

// Perfect-window detector (ChannelledSnipe). The AnimationController @ actor+0x228 holds
// CurrentAnimationStage at +0x1A8 — it sits at 0 while idle and only exceeds the threshold (default 20)
// during the perfect-strike window. Returns true the instant the window opens (= optimal release moment).
// 0.5.4: REMOVED the old `animId == 1084 (SnipeChannel)` gate. The patch made the player's top-level anim
// id read 1086 BOTH idle AND while channelling (it no longer flips to a distinct SnipeChannel id), so the
// gate bailed before ever reading the stage -> "we don't grab it on the flash". Anim ids also drift every
// patch. The STAGE is the real, drift-proof channel/window signal (live-confirmed: 0 idle -> 23 in-window),
// and _activeChannel.perfectWindow (armed ONLY for Snipe) + the 300ms cast guard already scope this read to
// the Snipe channel. Pure offset reads: no hooks.
function _perfectWindowOpen(player, ch) {
  try {
    const actor = player && player.actorComponentPtr;
    if (!actor) return false;
    const ctrl = poe2.readMemory(actor + 0x228, 'int64');
    if (!ctrl || ctrl < 0x10000) return false;
    const stage = poe2.readMemory(ctrl + 0x1A8, 'int32');
    return typeof stage === 'number' && stage > (ch.stageThreshold || 20);
  } catch (e) { return false; }
}

// A skill opts into perfect-window release by carrying a 'perfectWindow' condition (shown as a regular
// condition in the builder). Read once at cast time to arm the channel.
function _hasPerfectWindowCond(skill) {
  return !!(skill && skill.conditions && skill.conditions.some(c => c && c.type === 'perfectWindow'));
}

function executeRotation(targetEntity, distance) {
  // Per-frame cached: ReadBuffsComponent holds a global mutex contended by the
  // render-thread marker emitter; calling raw poe2.getLocalPlayer() every tick
  // during _activeChannel hammered it and exposed a game-side SRW race.
  const player = POE2Cache.getLocalPlayer();
  if (!player) return false;

  // Hold-channel arbiter: timeout-only release (buff check was unreliable). Stale-state
  // short-circuit prevents a 20s-old armed channel from sending a stop packet now.
  if (_activeChannel) {
    const elapsed = Date.now() - _activeChannel.startedAt;
    if (elapsed > _CHANNEL_STALE_MS) {
      console.warn(`[Rotation] Channel STALE (${elapsed}ms), nuking without stop: ${_activeChannel.skillName}`);
      _activeChannel = null;
      // Fall through.
    } else if (_activeChannel.perfectWindow && elapsed > 300 && _perfectWindowOpen(player, _activeChannel)) {
      // Release the instant the perfect window opens (optimal). 300ms guard avoids a stale
      // stage read from a previous channel firing immediately at cast.
      sendStopAction();
      console.log(`[Rotation] Channel released: ${_activeChannel.skillName} (PERFECT WINDOW @${elapsed}ms)`);
      _activeChannel = null;
      // Fall through to let the next eligible skill cast this tick.
    } else if (elapsed >= _activeChannel.timeoutMs) {
      sendStopAction();
      console.log(`[Rotation] Channel released: ${_activeChannel.skillName} (timeout@${elapsed}ms)`);
      _activeChannel = null;
      // Fall through to let the next eligible skill cast this tick.
    } else {
      return false;  // still channeling — don't start anything new
    }
  }

  // PRIORITY FALL-THROUGH support: fetch this actor's real cooldowns once. A skill is "on
  // cooldown" if any timer in its cooldown group (matched by marker+slot = high 16 bits of
  // packetData) still has remaining > 0. Lets the loop skip a recharging top skill and try
  // the next one in the priority list. Memoized per frame to avoid the native RPC + mutex
  // contention on every cast during sustained combat.
  const _cdsFrame = POE2Cache.getFrameNumber();
  let _cds;
  if (_cooldownsCacheFrame === _cdsFrame) {
    _cds = _cooldownsCache || [];
  } else {
    _cds = player.actorComponentPtr ? (poe2.getCooldowns(player.actorComponentPtr) || []) : [];
    _cooldownsCache = _cds;
    _cooldownsCacheFrame = _cdsFrame;
  }
  const _isOnCd = (pb) => {
    if (!pb) return false;
    const key = (((pb[0] & 0xFF) << 8) | (pb[1] & 0xFF)) & 0xFFFF;  // marker<<8 | slot
    for (const g of _cds) {
      if (g && g.packetData !== undefined &&
          (((g.packetData >>> 16) & 0xFFFF) === key) &&
          g.timers && g.timers.some(t => t.remaining > 0.05)) return true;
    }
    return false;
  };

  // ONE-CAST-PER-FRAME: if another caller (auto-attack vs SpikenQOL bot) already cast this frame,
  // don't let a second caller double-fire. Channel maintenance above still runs every call.
  if (_cdsFrame === _lastCastFrame) return false;

  // GLOBAL post-cast gate: don't fire ANY skill within GLOBAL_MIN_CAST_GAP_MS of the last successful
  // cast. The per-skill floor below only spaces the SAME skill; this spaces the WHOLE rotation so
  // different skills (e.g. IceShot right after Barrage) can't fire back-to-back faster than this.
  if (Date.now() - _lastGlobalCastAt < GLOBAL_MIN_CAST_GAP_MS) return false;

  for (const skill of rotations) {
    if (!skill.enabled) continue;
    if (!checkConditions(skill, player, targetEntity, distance)) continue;

    // Look up skill packet by name (runtime lookup for shareability)
    // Try skillName first, then resolvedName
    let packetBytes = null;

    if (skill.skillName) {
      packetBytes = getSkillPacketByName(skill.skillName);
    }

    if (!packetBytes && skill.resolvedName) {
      packetBytes = getSkillPacketByName(skill.resolvedName);
    }

    // Fallback to stored packet bytes if name lookup fails
    if (!packetBytes && skill.packetBytes) {
      packetBytes = skill.packetBytes;
    }

    if (!packetBytes) {
      console.warn(`[Rotation] Skill "${skill.name}" not found in active skills`);
      continue;
    }

    // PRIORITY FALL-THROUGH: if this skill is on cooldown, skip it and try the NEXT skill
    // in the priority list (previously the rotation stuck on the top ability while it recharged).
    if (_isOnCd(packetBytes)) continue;

    // ATOMIC CLAIM the throttle BEFORE the (slow) sendPacket, not after. The old post-send write at
    // L~1058 left a wide window where a second caller read a stale last-cast time and double-fired
    // (the sub-2s spam). Claiming at selection serializes both casters against the same clock, and
    // _skillIntervalMs floors EVERY skill (incl. those with no cast_interval_ms condition).
    const _k = _skillKey(skill);
    const _prevCast = _lastCastAt[_k] || 0;
    if ((Date.now() - _prevCast) < _skillIntervalMs(skill)) continue;
    _lastCastAt[_k] = Date.now();

    // Build and send packet based on target mode
    const targetMode = skill.targetMode || 'target';
    let success = false;
    
    switch (targetMode) {
      case 'self':
        const selfPacket = buildSelfPacket(packetBytes);
        success = poe2.sendPacket(selfPacket);
        break;
        
      case 'direction':
        const { dx, dy } = angleToDeltas(skill.directionAngle || 0, skill.directionDistance || 0);
        
        if (skill.channeled) {
          // Use full channeling sequence for movement skills (Blink, Dodge, etc.)
          success = executeChanneledSkill(packetBytes, dx, dy, 2);
        } else {
          const dirPacket = buildDirectionalPacket(packetBytes, dx, dy);
          success = poe2.sendPacket(dirPacket);
        }
        break;
        
      case 'cursor':
        // Get cursor position relative to player for directional skills
        const mousePos = ImGui.getMousePos();
        const player = poe2.getLocalPlayer();
        if (player && player.worldX !== undefined) {
          const playerScreen = poe2.worldToScreen(player.worldX, player.worldY, player.worldZ || 0);
          if (playerScreen && playerScreen.visible) {
            const screenDx = mousePos.x - playerScreen.x;
            const screenDy = playerScreen.y - mousePos.y;
            let cursorAngle = Math.round(Math.atan2(screenDy, screenDx) * 180 / Math.PI);
            if (cursorAngle < 0) cursorAngle += 360;
            
            const cursorDeltas = angleToDeltas(cursorAngle, skill.directionDistance || 200);
            
            if (skill.channeled) {
              success = executeChanneledSkill(packetBytes, cursorDeltas.dx, cursorDeltas.dy, 2);
            } else {
              const cursorPacket = buildDirectionalPacket(packetBytes, cursorDeltas.dx, cursorDeltas.dy);
              success = poe2.sendPacket(cursorPacket);
            }
          }
        }
        break;
        
      case 'dead_target': {
        // Find nearest dead entity (for corpse skills)
        const deadTarget = findNearestDeadEntity(skill.directionDistance || 300);
        if (deadTarget && deadTarget.id) {
          const deadPacket = buildTargetPacket(packetBytes, deadTarget.id, deadTarget.gridX, deadTarget.gridY);
          success = poe2.sendPacket(deadPacket);
          console.log(`[Rotation] Targeting corpse: ${(deadTarget.name || 'Unknown').split('/').pop()}`);
        } else {
          console.log(`[Rotation] No dead entities nearby for corpse skill`);
        }
        break;
      }
        
      case 'cursor_target': {
        // Find entity nearest to cursor position
        const cursorTarget = findEntityNearestToCursor(skill.directionDistance || 500);
        if (cursorTarget && cursorTarget.id) {
          const cursorTargetPacket = buildTargetPacket(packetBytes, cursorTarget.id, cursorTarget.gridX, cursorTarget.gridY);
          success = poe2.sendPacket(cursorTargetPacket);
          console.log(`[Rotation] Targeting near cursor: ${(cursorTarget.name || 'Unknown').split('/').pop()}`);
        } else {
          console.log(`[Rotation] No entities near cursor`);
        }
        break;
      }
        
      case 'dead_cursor_target': {
        // Find dead entity nearest to cursor position (for corpse skills)
        const deadCursorTarget = findDeadEntityNearestToCursor(skill.directionDistance || 500);
        if (deadCursorTarget && deadCursorTarget.id) {
          const deadCursorPacket = buildTargetPacket(packetBytes, deadCursorTarget.id, deadCursorTarget.gridX, deadCursorTarget.gridY);
          success = poe2.sendPacket(deadCursorPacket);
          console.log(`[Rotation] Targeting corpse near cursor: ${(deadCursorTarget.name || 'Unknown').split('/').pop()}`);
        } else {
          console.log(`[Rotation] No corpses near cursor`);
        }
        break;
      }
        
      case 'target':
      default:
        if (!targetEntity || !targetEntity.id) continue;
        const targetPacket = buildTargetPacket(packetBytes, targetEntity.id, targetEntity.gridX, targetEntity.gridY);
        success = poe2.sendPacket(targetPacket);
        break;
    }
    
    console.log(`[Rotation] Used ${skill.name} (${targetMode}${skill.channeled ? ', channeled' : ''}) - success=${success}`);

    // Throttle was CLAIMED at selection (before sendPacket). Mark the frame consumed on success so a
    // second caller can't double-fire this frame; on a FAILED send, roll the claim back so a real
    // failure doesn't lock the skill out for a whole interval.
    if (success) { _lastCastFrame = _cdsFrame; _lastGlobalCastAt = Date.now(); }
    else _lastCastAt[_k] = _prevCast;

    // Hold-channel: arm the arbiter so the next tick waits for the timeout (with
    // ±100ms jitter to avoid lock-step rhythms) before sending stop.
    if (success && skill.channelUntilBuff) {
      const base = (skill.channelTimeoutMs > 0) ? skill.channelTimeoutMs : _CHANNEL_TIMEOUT_DEFAULT_MS;
      const capped = Math.min(base, _CHANNEL_TIMEOUT_CAP_MS);
      const jitter = Math.floor(Math.random() * (2 * _CHANNEL_TIMEOUT_JITTER_MS + 1)) - _CHANNEL_TIMEOUT_JITTER_MS;
      _activeChannel = {
        startedAt: Date.now(),
        timeoutMs: capped + jitter,
        skillName: skill.name,
        perfectWindow: _hasPerfectWindowCond(skill),           // 'perfectWindow' condition => release at window
        channelAnimId: skill.channelAnimId || 1084,            // SnipeChannel anim id (default)
        stageThreshold: (skill.perfectWindowStage > 0) ? skill.perfectWindowStage : 20,
      };
      console.log(`[Rotation] Channel armed: ${_activeChannel.skillName} (timeout ${_activeChannel.timeoutMs}ms${_activeChannel.perfectWindow ? ', perfect-window release' : ''})`);
    }

    return true;
  }

  return false;
}

/**
 * Test cast a skill with specified parameters
 * @param {object} skill - Skill info object with packetBytes
 * @param {number} targetMode - 0=Target, 1=Self, 2=Direction
 * @param {number} angle - Direction angle in degrees
 * @param {number} distance - Direction distance
 * @param {object} targetEntity - Target entity for target mode
 * @param {boolean} channeled - Use channeling packet sequence (for Blink, Dodge, etc.)
 */
function testCastSkill(skill, targetMode, angle, distance, targetEntity, channeled = false) {
  const packetBytes = skill.packetBytes;
  if (!packetBytes) {
    console.error("[Rotation] No packet bytes for test skill");
    return false;
  }
  
  switch (targetMode) {
    case 1:  // Self
      const selfPacket = buildSelfPacket(packetBytes);
      const selfSuccess = poe2.sendPacket(selfPacket);
      console.log(`[Rotation] Test self-cast - success=${selfSuccess}`);
      return selfSuccess;
      
    case 2:  // Direction
      const { dx, dy } = angleToDeltas(angle, distance);
      console.log(`[Rotation] Test: Direction ${angle}°, distance ${distance}, deltas: ${dx}, ${dy}`);
      
      if (channeled) {
        // Use full channeling sequence for movement skills
        console.log(`[Rotation] Using channeled sequence`);
        return executeChanneledSkill(packetBytes, dx, dy, 2);
      } else {
        // Simple directional packet
        const dirPacket = buildDirectionalPacket(packetBytes, dx, dy);
        const dirSuccess = poe2.sendPacket(dirPacket);
        console.log(`[Rotation] Test directional - success=${dirSuccess}`);
        return dirSuccess;
      }
      
    case 0:  // Target
    default:
      if (!targetEntity || !targetEntity.id) {
        console.error("[Rotation] No target for test skill");
        return false;
      }
      const targetPacket = buildTargetPacket(packetBytes, targetEntity.id);
      const targetSuccess = poe2.sendPacket(targetPacket);
      console.log(`[Rotation] Test target cast - success=${targetSuccess}`);
      return targetSuccess;
  }
}

// ============================================================================
// PARSING HELPERS
// ============================================================================

function parsePacketString(str) {
  const hex = str.replace(/\s+/g, '');
  const bytes = [];
  for (let i = 0; i < hex.length && bytes.length < 4; i += 2) {
    const byte = parseInt(hex.substr(i, 2), 16);
    if (!isNaN(byte)) bytes.push(byte);
  }
  return bytes;
}

// ============================================================================
// UI DRAWING
// ============================================================================

function drawRotationBuilder() {
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Rotation Builder v2");
  ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Skills stored by NAME for shareability");
  ImGui.separator();
  
  // Sub-tabs
  if (ImGui.beginTabBar("RotationSubTabs")) {
    
    // ========== ROTATION TAB ==========
    if (ImGui.beginTabItem("Rotation")) {
      drawRotationList();
      ImGui.endTabItem();
    }
    
    // ========== ADD SKILL TAB ==========
    if (ImGui.beginTabItem("Add Skill")) {
      drawAddSkillUI();
      ImGui.endTabItem();
    }
    
    // ========== TEST SKILL TAB ==========
    if (ImGui.beginTabItem("Test Skill")) {
      drawTestSkillUI();
      ImGui.endTabItem();
    }
    
    // ========== ENTITY SKILLS TAB ==========
    if (ImGui.beginTabItem("Entity Skills")) {
      drawEntitySkillsUI();
      ImGui.endTabItem();
    }
    
    // ========== MANAGE TAB ==========
    if (ImGui.beginTabItem("Manage")) {
      drawManageUI();
      ImGui.endTabItem();
    }

    // ========== INSPECT TAB ==========
    if (ImGui.beginTabItem("Inspect")) {
      drawInspectUI();
      ImGui.endTabItem();
    }

    ImGui.endTabBar();
  }
}

function drawRotationList() {
  ImGui.text(`Rotation: ${currentRotationName} (${rotations.length} skills)`);
  ImGui.separator();
  
  if (rotations.length === 0) {
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "No skills in rotation. Go to 'Add Skill' tab.");
    return;
  }
  
  ImGui.beginChild("RotationList", {x: 0, y: 350}, true);
  
  for (let i = 0; i < rotations.length; i++) {
    const skill = rotations[i];
    ImGui.pushID(i);
    
    // Enable toggle
    const enabledColor = skill.enabled ? [0.2, 0.7, 0.2, 1.0] : [0.5, 0.5, 0.5, 1.0];
    ImGui.pushStyleColor(ImGui.Col.Button, enabledColor);
    if (ImGui.button(skill.enabled ? "ON" : "OFF", {x: 35, y: 0})) {
      skill.enabled = !skill.enabled;
      saveRotations();
    }
    ImGui.popStyleColor();
    ImGui.sameLine();
    
    // Skill name and info
    const targetModeLabel = TARGET_MODES.find(m => m.id === (skill.targetMode || 'target'))?.label || 'Target';
    const weaponSetStr = skill.weaponSet ? `W${skill.weaponSet}` : '';
    if (skill.enabled) {
      ImGui.textColored([0.5, 1.0, 0.5, 1.0], `${i+1}. ${skill.name}`);
    } else {
      ImGui.textColored([0.5, 0.5, 0.5, 1.0], `${i+1}. ${skill.name}`);
    }
    ImGui.sameLine();
    ImGui.textColored([0.6, 0.6, 0.8, 1.0], `[${targetModeLabel}]`);
    if (weaponSetStr) {
      ImGui.sameLine();
      ImGui.textColored([0.8, 0.8, 0.5, 1.0], `[${weaponSetStr}]`);
    }
    if (skill.channeled) {
      ImGui.sameLine();
      ImGui.textColored([0.5, 0.8, 1.0, 1.0], `[Channeled]`);
    }
    if (skill.channelUntilBuff) {
      const ms = skill.channelTimeoutMs || _CHANNEL_TIMEOUT_DEFAULT_MS;
      ImGui.sameLine();
      ImGui.textColored([0.9, 0.7, 0.4, 1.0], `[Hold ${ms}ms]`);
    }
    
    // Show skill lookup status
    const lookupName = skill.skillName || skill.resolvedName;
    if (lookupName) {
      const found = findSkillByName(lookupName);
      if (found) {
        ImGui.textColored([0.4, 0.8, 0.4, 1.0], `   Skill: ${lookupName} (found)`);
      } else {
        ImGui.textColored([0.8, 0.4, 0.4, 1.0], `   Skill: ${lookupName} (NOT FOUND - check skills!)`);
      }
    } else if (skill.typeId) {
      // No name - show typeId and indicate it uses stored bytes
      ImGui.textColored([1.0, 0.8, 0.3, 1.0], `   TypeID: 0x${skill.typeId.toString(16).toUpperCase()} (uses stored packet)`);
    } else if (skill.packetBytes) {
      // No name or typeId - show packet bytes
      const packetStr = skill.packetBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], `   Packet: ${packetStr}`);
    }
    
    // Show conditions
    if (skill.conditions && skill.conditions.length > 0) {
      for (let c = 0; c < skill.conditions.length; c++) {
        const cond = skill.conditions[c];
        const condType = CONDITION_TYPES.find(t => t.id === cond.type);
        const label = condType ? condType.label : cond.type;
        
        ImGui.pushID(`cond${c}`);
        if (ImGui.smallButton("X")) {
          skill.conditions.splice(c, 1);
          saveRotations();
        }
        ImGui.popID();
        ImGui.sameLine();
        
        let condDisplay;
        if (cond.type === 'cast_interval_ms') {
          condDisplay = `   IF ${cond.value}ms since last cast`;
        } else if (cond.type === 'nearby_monster_count') {
          condDisplay = `   IF monsters ${cond.operator} ${cond.value} within ${cond.radius || 30}`;
        } else if (cond.type === 'nearby_deployable_count') {
          condDisplay = `   IF "${cond.stringValue}" ${cond.operator} ${cond.value} within ${cond.radius || 60}`;
        } else if (condType?.unit === 'bool') {
          condDisplay = `   IF ${label}`;
        } else {
          let valueStr = cond.stringValue || cond.value;
          if (condType?.unit === 'rarity') valueStr = RARITY_LABELS[cond.value] || cond.value;
          condDisplay = `   IF ${label} ${cond.operator} ${valueStr}`;
        }
        ImGui.textColored([0.7, 0.7, 0.7, 1.0], condDisplay);
      }
    } else {
      ImGui.textColored([0.5, 0.5, 0.5, 1.0], "   (No conditions - always use)");
    }
    
    // Buttons
    const isEditing = (editingIndex === i);
    if (ImGui.button(isEditing ? "Done" : "+Cond", {x: 50, y: 0})) {
      editingIndex = isEditing ? -1 : i;
    }
    ImGui.sameLine();
    if (ImGui.button("Del", {x: 35, y: 0})) {
      rotations.splice(i, 1);
      if (editingIndex === i) editingIndex = -1;
      saveRotations();
    }
    ImGui.sameLine();
    if (i > 0 && ImGui.button("Up", {x: 30, y: 0})) {
      [rotations[i], rotations[i-1]] = [rotations[i-1], rotations[i]];
      saveRotations();
    }
    ImGui.sameLine();
    if (i < rotations.length - 1 && ImGui.button("Dn", {x: 30, y: 0})) {
      [rotations[i], rotations[i+1]] = [rotations[i+1], rotations[i]];
      saveRotations();
    }
    
    // Condition editor
    if (isEditing) {
      ImGui.indent();
      // Hold-channel timeout editor — shown only for skills with channelUntilBuff set.
      // Lets the user tune the per-cast timeout in ms without editing rotations_v2.json.
      // Value is clamped to [100, _CHANNEL_TIMEOUT_CAP_MS] and persisted on change.
      if (skill.channelUntilBuff) {
        if (editChannelTimeoutSkillIdx !== i) {
          editChannelTimeoutSkillIdx = i;
          editChannelTimeoutVar.value = skill.channelTimeoutMs || _CHANNEL_TIMEOUT_DEFAULT_MS;
        }
        ImGui.setNextItemWidth(120);
        if (ImGui.inputInt(`Channel Timeout (ms)##chTmo${i}`, editChannelTimeoutVar)) {
          skill.channelTimeoutMs = Math.max(100, Math.min(_CHANNEL_TIMEOUT_CAP_MS, editChannelTimeoutVar.value));
          editChannelTimeoutVar.value = skill.channelTimeoutMs;
          saveRotations();
        }
        ImGui.sameLine();
        ImGui.textColored([0.6, 0.6, 0.6, 1.0], `(buff: ${skill.channelUntilBuff}, ±${_CHANNEL_TIMEOUT_JITTER_MS}ms jitter at cast)`);
      }
      drawConditionEditor(skill);
      ImGui.unindent();
    }
    
    ImGui.separator();
    ImGui.popID();
  }
  
  ImGui.endChild();
}

function drawConditionEditor(skill) {
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Add Condition:");
  
  // Condition type
  ImGui.text("Type:");
  for (let ct = 0; ct < CONDITION_TYPES.length; ct++) {
    if (ImGui.radioButton(CONDITION_TYPES[ct].label + "##ct" + ct, selectedConditionType === ct)) {
      selectedConditionType = ct;
    }
  }
  
  const selectedType = CONDITION_TYPES[selectedConditionType];
  
  const needsValue = selectedType.unit !== 'none' && selectedType.unit !== 'bool';
  // cast_interval_ms is a "min elapsed" gate — no operator (always >=).
  const needsOperator = needsValue && selectedType.id !== 'cast_interval_ms';

  if (needsOperator) {
    ImGui.text("Operator:");
    for (let op = 0; op < OPERATORS.length; op++) {
      if (ImGui.radioButton(OPERATORS[op] + "##op" + op, selectedOperator === op)) {
        selectedOperator = op;
      }
      if (op < OPERATORS.length - 1) ImGui.sameLine();
    }
  }

  if (needsValue) {
    ImGui.text(selectedType.id === 'cast_interval_ms' ? "Interval (ms):" : "Value:");
    if (selectedType.unit === 'buff_name') {
      ImGui.inputText("##condvalue", conditionStringValue);
    } else if (selectedType.unit === 'rarity') {
      for (let r = 0; r < RARITY_LABELS.length; r++) {
        if (ImGui.radioButton(RARITY_LABELS[r] + "##rar" + r, conditionValue.value === r)) {
          conditionValue.value = r;
        }
        if (r < RARITY_LABELS.length - 1) ImGui.sameLine();
      }
    } else {
      ImGui.inputFloat("##condvalue", conditionValue, 1, 10);
    }

    // Path substring for the maintain-a-deployable condition (e.g. "TornadoShotTornado").
    if (selectedType.id === 'nearby_deployable_count') {
      ImGui.text("Path contains:");
      ImGui.inputText("##conddeploypath", conditionStringValue);
    }

    // Second slider: radius (grid units) for the nearby-count conditions.
    if (selectedType.id === 'nearby_monster_count' || selectedType.id === 'nearby_deployable_count') {
      ImGui.text("Radius (grid units):");
      ImGui.inputFloat("##condradius", conditionRadius, 1, 10);
    }
  }

  if (ImGui.button("Add Condition")) {
    const newCond = {
      type: selectedType.id,
      operator: OPERATORS[selectedOperator],
      value: conditionValue.value,
      stringValue: conditionStringValue.value
    };
    if (selectedType.id === 'nearby_monster_count' || selectedType.id === 'nearby_deployable_count') newCond.radius = conditionRadius.value;
    if (!skill.conditions) skill.conditions = [];
    skill.conditions.push(newCond);
    saveRotations();
  }
}

// ============================================================================
// Skill Inspector  (Rotation Builder -> "Inspect" tab)
// Dumps every active skill (real name, typeId, weapon set, slot, packet bytes,
// and the +0x48/+0x58 name candidates) to the console. Button-triggered only,
// so it costs nothing per frame. Console lines are tagged [SkillFinder].
// ============================================================================
function _rbIsPtr(v) {
  return typeof v === 'number' && isFinite(v) && v > 0x10000 && v < 0x7FFFFFFFFFFF;
}
function _rbSafe(fn) { try { return fn(); } catch (e) { return null; } }
function _rbU64(addr) { return _rbIsPtr(addr) ? (_rbSafe(() => poe2.readMemory(addr, 'int64')) || 0) : 0; }
function _rbLooksName(s) {
  return !!s && s.length >= 2 && s.length <= 80 && /^[\x20-\x7E]+$/.test(s) && /[A-Za-z]/.test(s);
}
function _sfLog(m) { console.log('[SkillFinder] ' + m); }
// name = wstring reachable by following `derefs` pointer hops from inst+off.
function _rbNameAt(inst, off, derefs) {
  let p = _rbU64(inst + off);
  for (let d = 0; d < derefs; d++) p = _rbU64(p);
  if (!_rbIsPtr(p)) return null;
  const s = _rbSafe(() => poe2.readWideString(p));
  return _rbLooksName(s) ? s : null;
}
// Logs ONCE per call (button-triggered, never per-frame). All lines tagged [SkillFinder].
// Compact one-line-per-skill table of ALL active skills + the candidate name offsets.
function dumpSkillStructs() {
  const skills = getActiveSkills();
  _sfLog('========== SKILL DUMP (all) ==========');
  _sfLog(`activeSkills count: ${skills.length}`);
  _sfLog(`fmt: [idx] tid=typeId ws/slot | best=(proposed) cur=resolvedName | +48=base +58/+70=variant`);
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    const inst = s.skillPtr || 0;
    const n48 = _rbNameAt(inst, 0x48, 1);   // canonical skill id (universal)
    const n58 = _rbNameAt(inst, 0x58, 2);   // gem variant (runic etc.)
    const n70 = _rbNameAt(inst, 0x70, 2);
    const best = n58 || n70 || n48 || s.resolvedName || null;   // proposed display name
    const tid = '0x' + (s.typeId || 0).toString(16).toUpperCase().padStart(4, '0');
    _sfLog(`[${String(i).padStart(2)}] tid=${tid} ws${s.weaponSet}/sl${s.skillSlot} | best=${JSON.stringify(best)} cur=${JSON.stringify(s.resolvedName || null)} | +48=${JSON.stringify(n48)} +58=${JSON.stringify(n58)} +70=${JSON.stringify(n70)}`);
  }
  _sfLog('========== END DUMP ==========');
}

// Rotation Builder -> "Inspect" tab. Just a label + button; the dump runs only on click.
function drawInspectUI() {
  ImGui.textColored([0.6, 0.9, 1.0, 1.0], "Skill Inspector");
  ImGui.separator();
  ImGui.textColored([0.8, 0.8, 0.8, 1.0], "Dumps every active skill to the console: real name, typeId,");
  ImGui.textColored([0.8, 0.8, 0.8, 1.0], "weapon set, slot, packet bytes, and the +0x48/+0x58 name candidates.");
  ImGui.separator();
  if (ImGui.button("Dump Active Skills -> console", {x: 260, y: 0})) {
    try { dumpSkillStructs(); } catch (e) { _sfLog('error: ' + e); }
  }
  ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Filter the console by [SkillFinder]. Runs only on click (no per-frame cost).");
}

function drawAddSkillUI() {
  const activeSkills = getActiveSkills();
  
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Add Skill from Active Skills");
  ImGui.separator();
  
  if (activeSkills.length === 0) {
    ImGui.textColored([0.8, 0.4, 0.4, 1.0], "No active skills found!");
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Make sure you're in-game with skills equipped.");
    ImGui.separator();
  } else {
    // Search filter
    ImGui.text("Search:");
    ImGui.sameLine();
    ImGui.inputText("##searchskill", searchSkillName);
    
    ImGui.separator();
    ImGui.textColored([0.5, 1.0, 1.0, 1.0], `Found ${activeSkills.length} active skills:`);
    
    ImGui.beginChild("ActiveSkillsList", {x: 0, y: 200}, true);
    
    const search = searchSkillName.value.toLowerCase();
    let idx = 0;
    for (const skill of activeSkills) {
      // Build display name - use skillName if available, then resolvedName, then TypeID
      const displayName = skill.skillName || skill.resolvedName || `TypeID 0x${(skill.typeId || 0).toString(16).toUpperCase()}`;
      
      // Filter by search (search in name OR typeId hex)
      if (search) {
        const nameMatch = skill.skillName && skill.skillName.toLowerCase().includes(search);
        const typeIdMatch = skill.typeId && skill.typeId.toString(16).toLowerCase().includes(search);
        if (!nameMatch && !typeIdMatch) {
          idx++;
          continue;
        }
      }
      
      ImGui.pushID(`skill${idx}`);
      
      const isSelected = (selectedActiveSkill === idx);
      const packetStr = skill.packetBytes ? 
        skill.packetBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ') : 
        'N/A';
      
      // Show skills with names in green, without names in yellow
      const hasName = (skill.skillName && skill.skillName.length > 0) || (skill.resolvedName && skill.resolvedName.length > 0);
      if (hasName) {
        if (ImGui.selectable(`${displayName}##sel`, isSelected)) {
          selectedActiveSkill = idx;
        }
      } else {
        // No name - show in different color with indicator
        ImGui.pushStyleColor(ImGui.Col.Text, [1.0, 0.8, 0.3, 1.0]);
        if (ImGui.selectable(`${displayName} (no name)##sel`, isSelected)) {
          selectedActiveSkill = idx;
        }
        ImGui.popStyleColor();
      }
      
      if (ImGui.isItemHovered()) {
        ImGui.beginTooltip();
        if (skill.skillName) {
          ImGui.text(`Name: ${skill.skillName}`);
        }
        if (skill.resolvedName) {
          ImGui.text(`Action: ${skill.resolvedName}`);
        }
        ImGui.text(`TypeID: 0x${(skill.typeId || 0).toString(16).toUpperCase()}`);
        ImGui.text(`Level: ${skill.skillLevel || '?'}`);
        ImGui.text(`Slot: ${skill.skillSlot}`);
        ImGui.text(`Weapon Set: ${skill.weaponSet || 1}`);
        ImGui.text(`Packet: ${packetStr}`);
        if (!hasName) {
          ImGui.separator();
          ImGui.textColored([1.0, 0.8, 0.3, 1.0], "Unknown action - not shareable");
          ImGui.textColored([0.7, 0.7, 0.7, 1.0], "Will use stored packet bytes");
        }
        ImGui.endTooltip();
      }
      
      ImGui.popID();
      idx++;
    }
    
    ImGui.endChild();
  }
  
  ImGui.separator();

  // Target mode selection
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Targeting Mode:");
  for (let tm = 0; tm < TARGET_MODES.length; tm++) {
    if (ImGui.radioButton(TARGET_MODES[tm].label + "##tm" + tm, selectedTargetMode === tm)) {
      selectedTargetMode = tm;
    }
    if (tm < TARGET_MODES.length - 1) ImGui.sameLine();
  }
  ImGui.textColored([0.6, 0.6, 0.6, 1.0], TARGET_MODES[selectedTargetMode].desc);
  
  // Direction settings (if direction mode = 5, or cursor position mode = 6)
  const isDirectionMode = selectedTargetMode === 5 || selectedTargetMode === 6;
  if (isDirectionMode) {
    ImGui.separator();
    ImGui.text("Direction Settings:");
    
    // Preset buttons (only for fixed direction mode, not cursor position)
    if (selectedTargetMode === 5) {
      for (let d = 0; d < DIRECTION_PRESETS.length; d++) {
        if (ImGui.button(DIRECTION_PRESETS[d].label, {x: 50, y: 0})) {
          directionAngle.value = DIRECTION_PRESETS[d].angle;
        }
        if (d < DIRECTION_PRESETS.length - 1 && (d + 1) % 4 !== 0) ImGui.sameLine();
      }
      ImGui.sliderInt("Angle (degrees)", directionAngle, 0, 359);
    }
    
    ImGui.sliderInt("Distance", directionDistance, 0, 500);
    
    ImGui.separator();
    ImGui.checkbox("Channeled Skill (Blink/Dodge/Roll)", addChanneled);
    if (addChanneled.value) {
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], "Sends: Start -> Skill -> Continuation -> Stop -> End");
    }
  }
  
  ImGui.separator();
  
  // Add button
  if (selectedActiveSkill >= 0 && selectedActiveSkill < activeSkills.length) {
    const skill = activeSkills[selectedActiveSkill];
    const hasName = (skill.skillName && skill.skillName.length > 0) || (skill.resolvedName && skill.resolvedName.length > 0);
    const displayName = skill.skillName || skill.resolvedName || `TypeID 0x${(skill.typeId || 0).toString(16).toUpperCase()}`;
    
    if (hasName) {
      ImGui.textColored([0.5, 1.0, 0.5, 1.0], `Selected: ${displayName}`);
    } else {
      ImGui.textColored([1.0, 0.8, 0.3, 1.0], `Selected: ${displayName} (not shareable)`);
    }
    
    if (ImGui.button("Add to Rotation", {x: 150, y: 30})) {
      const newSkill = {
        enabled: true,
        name: displayName,
        skillName: skill.skillName || null,           // Store skill name if available
        resolvedName: skill.resolvedName || null,     // Store resolved name if available
        packetBytes: [...skill.packetBytes],          // Always store packet bytes as fallback
        typeId: skill.typeId,                         // Store typeId for display
        weaponSet: skill.weaponSet || 1,              // Store weapon set (1 or 2)
        targetMode: TARGET_MODES[selectedTargetMode].id,
        conditions: []
      };
      
      // Save direction settings for direction (5) and cursor position (6) modes
      if (selectedTargetMode === 5 || selectedTargetMode === 6) {
        newSkill.directionAngle = directionAngle.value;
        newSkill.directionDistance = directionDistance.value;
        newSkill.channeled = addChanneled.value;      // Store channeled flag
      }
      
      rotations.push(newSkill);
      saveRotations();
      console.log(`[Rotation] Added skill: ${displayName}${newSkill.channeled ? ' (channeled)' : ''}`);
      selectedActiveSkill = -1;
    }
  } else {
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Select a skill above to add it");
  }
  
  // Manual add section
  ImGui.separator();
  if (ImGui.collapsingHeader("Manual Add (Advanced)")) {
    ImGui.text("Skill Name:");
    ImGui.inputText("##manualname", manualSkillName);
    
    ImGui.text("Packet Bytes (4 bytes hex):");
    ImGui.inputText("##manualpacket", manualPacket);
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Format: 85 06 00 40 (marker slot typeHi typeLo)");
    
    if (ImGui.button("Add Manual Skill")) {
      const bytes = parsePacketString(manualPacket.value);
      if (bytes.length === 4) {
        rotations.push({
          enabled: true,
          name: manualSkillName.value,
          skillName: null,  // No lookup - use stored bytes
          packetBytes: bytes,
          targetMode: TARGET_MODES[selectedTargetMode].id,
          directionAngle: directionAngle.value,
          directionDistance: directionDistance.value,
          conditions: []
        });
        saveRotations();
        console.log(`[Rotation] Added manual skill: ${manualSkillName.value}`);
      } else {
        console.error(`[Rotation] Invalid packet - expected 4 bytes, got ${bytes.length}`);
      }
    }
  }
}

function drawTestSkillUI() {
  const activeSkills = getActiveSkills();
  
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Test Skill");
  ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Try casting a skill before adding to rotation");
  ImGui.separator();
  
  if (activeSkills.length === 0) {
    ImGui.textColored([0.8, 0.4, 0.4, 1.0], "No active skills found!");
    return;
  }
  
  // Skill selector
  ImGui.text("Select Skill:");
  ImGui.beginChild("TestSkillList", {x: 0, y: 150}, true);
  
  for (let i = 0; i < activeSkills.length; i++) {
    const skill = activeSkills[i];
    const hasName = (skill.skillName && skill.skillName.length > 0) || (skill.resolvedName && skill.resolvedName.length > 0);
    const displayName = skill.skillName || skill.resolvedName || `TypeID 0x${(skill.typeId || 0).toString(16).toUpperCase()}`;
    
    const isSelected = (testSkillIndex === i);
    
    if (hasName) {
      if (ImGui.selectable(`${displayName}##test${i}`, isSelected)) {
        testSkillIndex = i;
      }
    } else {
      ImGui.pushStyleColor(ImGui.Col.Text, [1.0, 0.8, 0.3, 1.0]);
      if (ImGui.selectable(`${displayName}##test${i}`, isSelected)) {
        testSkillIndex = i;
      }
      ImGui.popStyleColor();
    }
  }
  
  ImGui.endChild();
  
  ImGui.separator();
  
  // Target mode
  ImGui.text("Test Mode:");
  if (ImGui.radioButton("Target##test", testTargetMode.value === 0)) testTargetMode.value = 0;
  ImGui.sameLine();
  if (ImGui.radioButton("Dead##test", testTargetMode.value === 1)) testTargetMode.value = 1;
  ImGui.sameLine();
  if (ImGui.radioButton("CursorTgt##test", testTargetMode.value === 2)) testTargetMode.value = 2;
  ImGui.sameLine();
  if (ImGui.radioButton("DeadCursor##test", testTargetMode.value === 3)) testTargetMode.value = 3;
  
  if (ImGui.radioButton("Self##test", testTargetMode.value === 4)) testTargetMode.value = 4;
  ImGui.sameLine();
  if (ImGui.radioButton("Direction##test", testTargetMode.value === 5)) testTargetMode.value = 5;
  
  // Show info about dead target mode
  if (testTargetMode.value === 1) {
    const deadTarget = findNearestDeadEntity(300);
    if (deadTarget) {
      const shortName = (deadTarget.name || 'Unknown').split('/').pop();
      ImGui.textColored([0.8, 0.5, 0.5, 1.0], `Nearest corpse: ${shortName}`);
    } else {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "No corpses nearby");
    }
  }
  
  // Show info about cursor target mode
  if (testTargetMode.value === 2) {
    const cursorTarget = findEntityNearestToCursor(500);
    if (cursorTarget) {
      const shortName = (cursorTarget.name || 'Unknown').split('/').pop();
      const aliveStr = cursorTarget.isAlive === false ? " (dead)" : "";
      ImGui.textColored([0.5, 1.0, 1.0, 1.0], `Near cursor: ${shortName}${aliveStr}`);
    } else {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "No entities near cursor");
    }
  }
  
  // Show info about dead cursor target mode
  if (testTargetMode.value === 3) {
    const deadCursorTarget = findDeadEntityNearestToCursor(500);
    if (deadCursorTarget) {
      const shortName = (deadCursorTarget.name || 'Unknown').split('/').pop();
      ImGui.textColored([0.8, 0.5, 0.8, 1.0], `Corpse near cursor: ${shortName}`);
    } else {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "No corpses near cursor");
    }
  }
  
  if (testTargetMode.value === 5) {
    // Cursor direction option
    ImGui.checkbox("Use Cursor Direction", testUseCursor);
    
    if (!testUseCursor.value) {
      // Manual direction presets
      for (let d = 0; d < DIRECTION_PRESETS.length; d++) {
        if (ImGui.button(DIRECTION_PRESETS[d].label + "##td", {x: 50, y: 0})) {
          testDirection.value = DIRECTION_PRESETS[d].angle;
        }
        if (d < DIRECTION_PRESETS.length - 1 && (d + 1) % 4 !== 0) ImGui.sameLine();
      }
      ImGui.sliderInt("Angle##test", testDirection, 0, 359);
    } else {
      // Show cursor info
      const mousePos = ImGui.getMousePos();
      const player = poe2.getLocalPlayer();
      if (player && player.worldX !== undefined) {
        const playerScreen = poe2.worldToScreen(player.worldX, player.worldY, player.worldZ || 0);
        if (playerScreen && playerScreen.visible) {
          const dx = mousePos.x - playerScreen.x;
          const dy = playerScreen.y - mousePos.y;  // Flip Y (screen Y is inverted)
          const cursorAngle = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
          ImGui.textColored([0.5, 1.0, 1.0, 1.0], `Cursor Angle: ${cursorAngle < 0 ? cursorAngle + 360 : cursorAngle}°`);
        }
      }
    }
    
    ImGui.sliderInt("Distance##test", testDistance, 0, 500);
    
    ImGui.separator();
    
    // Channeled skill option (for Blink, Dodge Roll, etc.)
    ImGui.checkbox("Channeled Skill (Blink/Dodge)", testChanneled);
    if (testChanneled.value) {
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], "Will send: Start -> Skill -> Continuation -> Stop -> End");
    }
  }
  
  ImGui.separator();
  
  // Test button
  if (testSkillIndex >= 0 && testSkillIndex < activeSkills.length) {
    const skill = activeSkills[testSkillIndex];
    const displayName = skill.skillName || skill.resolvedName || `TypeID 0x${(skill.typeId || 0).toString(16).toUpperCase()}`;
    ImGui.textColored([0.5, 1.0, 0.5, 1.0], `Ready to test: ${displayName}`);
    
    if (ImGui.button("CAST TEST SKILL", {x: 200, y: 40})) {
      // Get appropriate target based on mode
      let target = null;
      
      switch (testTargetMode.value) {
        case 0:  // Target (alive)
          const aliveEntities = poe2.getEntities({ monstersOnly: true, maxDistance: 300, lightweight: true });
          if (aliveEntities.length > 0) {
            target = aliveEntities[0];
          }
          break;
          
        case 1:  // Dead Target
          target = findNearestDeadEntity(300);
          break;
          
        case 2:  // Cursor Target
          target = findEntityNearestToCursor(500);
          break;
          
        case 3:  // Dead Cursor Target
          target = findDeadEntityNearestToCursor(500);
          break;
      }
      
      // Calculate direction for direction mode with cursor option
      let angle = testDirection.value;
      if (testTargetMode.value === 5 && testUseCursor.value) {
        const mousePos = ImGui.getMousePos();
        const player = poe2.getLocalPlayer();
        if (player && player.worldX !== undefined) {
          const playerScreen = poe2.worldToScreen(player.worldX, player.worldY, player.worldZ || 0);
          if (playerScreen && playerScreen.visible) {
            const dx = mousePos.x - playerScreen.x;
            const dy = playerScreen.y - mousePos.y;
            angle = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
            if (angle < 0) angle += 360;
          }
        }
      }
      
      // Map UI mode to testCastSkill mode
      // 0-3 = targeting modes (use mode 0 with the target we found)
      // 4 = self (mode 1)
      // 5 = direction (mode 2)
      const castMode = testTargetMode.value <= 3 ? 0 : (testTargetMode.value === 4 ? 1 : 2);
      testCastSkill(skill, castMode, angle, testDistance.value, target, testChanneled.value);
    }
    
    if (testTargetMode.value === 0) {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "(Will target nearest alive monster within 300 units)");
    } else if (testTargetMode.value === 1) {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "(Will target nearest corpse within 300 units)");
    } else if (testTargetMode.value === 2) {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "(Will target entity nearest to cursor)");
    } else if (testTargetMode.value === 3) {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "(Will target corpse nearest to cursor)");
    }
  } else {
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Select a skill above to test");
  }
}

// ============================================================================
// ENTITY SKILLS EXPLORER
// ============================================================================

function drawEntitySkillsUI() {
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Entity Skills Explorer");
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], "View and test skills from nearby entities");
  
  ImGui.separator();
  
  // Range slider
  ImGui.sliderInt("Search Range", entitySkillsRange, 0, 2000);
  
  // Test casting options
  ImGui.separator();
  ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Test Cast Settings:");
  
  ImGui.text("Mode:");
  if (ImGui.radioButton("Target##etm", entityTestMode.value === 0)) entityTestMode.value = 0;
  ImGui.sameLine();
  if (ImGui.radioButton("Self##etm", entityTestMode.value === 1)) entityTestMode.value = 1;
  ImGui.sameLine();
  if (ImGui.radioButton("Direction##etm", entityTestMode.value === 2)) entityTestMode.value = 2;
  ImGui.sameLine();
  if (ImGui.radioButton("Cursor##etm", entityTestMode.value === 3)) entityTestMode.value = 3;
  
  if (entityTestMode.value === 2) {
    // Direction presets
    for (let d = 0; d < DIRECTION_PRESETS.length; d++) {
      if (ImGui.button(DIRECTION_PRESETS[d].label + "##etd", {x: 40, y: 0})) {
        entityTestAngle.value = DIRECTION_PRESETS[d].angle;
      }
      if (d < DIRECTION_PRESETS.length - 1 && (d + 1) % 4 !== 0) ImGui.sameLine();
    }
    ImGui.sliderInt("Angle##etdir", entityTestAngle, 0, 359);
  }
  
  if (entityTestMode.value >= 2) {
    ImGui.sliderInt("Distance##etdist", entityTestDistance, 0, 500);
    ImGui.checkbox("Channeled##etch", entityTestChanneled);
  }
  
  ImGui.separator();
  
  // Get player for distance calculations
  const player = poe2.getLocalPlayer();
  if (!player || player.gridX === undefined) {
    ImGui.textColored([1.0, 0.5, 0.5, 1.0], "Waiting for player...");
    return;
  }
  
  // Get all entities within range - use lightweight mode (Actor component still read)
  const allEntities = poe2.getEntities({ maxDistance: entitySkillsRange.value, lightweight: true });
  
  // Filter to entities that have activeSkills
  const entitiesWithSkills = [];
  for (const entity of allEntities) {
    if (entity.isLocalPlayer) continue;  // Skip self
    if (entity.activeSkills && entity.activeSkills.length > 0) {
      // Calculate distance
      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      entitiesWithSkills.push({
        entity: entity,
        distance: dist,
        skillCount: entity.activeSkills.length
      });
    }
  }
  
  // Sort by distance
  entitiesWithSkills.sort((a, b) => a.distance - b.distance);
  
  ImGui.text(`Found ${entitiesWithSkills.length} entities with active skills within ${entitySkillsRange.value} units`);
  
  ImGui.separator();
  
  if (entitiesWithSkills.length === 0) {
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "No entities with Actor component found nearby.");
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Try increasing the range or moving closer to monsters/players.");
    return;
  }
  
  // Entity list with skills
  ImGui.beginChild("EntitySkillsList", {x: 0, y: 0}, true);
  
  for (let i = 0; i < entitiesWithSkills.length; i++) {
    const item = entitiesWithSkills[i];
    const entity = item.entity;
    const skills = entity.activeSkills;
    
    ImGui.pushID(`ent${i}`);
    
    // Entity header
    const shortName = (entity.name || "Unknown").split('/').pop();
    const typeColor = getEntityTypeColor(entity.entityType);
    const distStr = item.distance.toFixed(0);
    const isExpanded = expandedEntitySkills[entity.id] || false;
    
    // Expandable header
    const headerLabel = `[${distStr}m] ${shortName} (${skills.length} skills)##eh${i}`;
    
    if (ImGui.collapsingHeader(headerLabel)) {
      expandedEntitySkills[entity.id] = true;
      
      ImGui.indent();
      
      // Entity info
      ImGui.textColored(typeColor, `Type: ${entity.entityType || 'Unknown'}`);
      if (entity.entitySubtype && entity.entitySubtype !== 'None') {
        ImGui.sameLine();
        ImGui.textColored([0.7, 0.7, 0.7, 1.0], `(${entity.entitySubtype})`);
      }
      ImGui.text(`ID: 0x${entity.id.toString(16).toUpperCase()}`);
      
      if (entity.healthMax && entity.healthMax > 0) {
        const hpPercent = ((entity.healthCurrent / entity.healthMax) * 100).toFixed(1);
        ImGui.textColored([0.5, 1.0, 0.5, 1.0], `HP: ${entity.healthCurrent}/${entity.healthMax} (${hpPercent}%)`);
      }
      
      ImGui.separator();
      
      // Skills list
      ImGui.textColored([1.0, 0.8, 0.5, 1.0], "Active Skills:");
      
      for (let s = 0; s < skills.length; s++) {
        const skill = skills[s];
        const skillName = skill.skillName || skill.resolvedName || null;
        const typeIdHex = `0x${(skill.typeId || 0).toString(16).toUpperCase().padStart(4, '0')}`;
        const packetStr = skill.packetBytes ? skill.packetBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ') : '??';
        const wsStr = skill.weaponSet ? `W${skill.weaponSet}` : '';
        
        ImGui.pushID(`sk${s}`);
        
        // Skill display
        if (skillName) {
          ImGui.textColored([0.5, 1.0, 0.5, 1.0], `  ${s+1}. ${skillName}`);
        } else {
          ImGui.textColored([1.0, 0.8, 0.3, 1.0], `  ${s+1}. TypeID ${typeIdHex}`);
        }
        
        ImGui.sameLine();
        ImGui.textColored([0.6, 0.6, 0.6, 1.0], `[${typeIdHex}]`);
        
        if (wsStr) {
          ImGui.sameLine();
          ImGui.textColored([0.8, 0.8, 0.5, 1.0], `[${wsStr}]`);
        }
        
        if (skill.skillLevel && skill.skillLevel > 0) {
          ImGui.sameLine();
          ImGui.textColored([0.5, 0.8, 1.0, 1.0], `Lv${skill.skillLevel}`);
        }
        
        // Test cast button
        ImGui.sameLine();
        if (skill.packetBytes && skill.packetBytes.length >= 4) {
          if (ImGui.smallButton("Test##tsk")) {
            testEntitySkill(skill, entity);
          }
          
          // Tooltip with full info on button hover or skill text hover
          if (ImGui.isItemHovered()) {
            ImGui.beginTooltip();
            ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Click to test cast this skill");
            ImGui.separator();
            ImGui.text(`Skill Name: ${skillName || '(none)'}`);
            ImGui.text(`Resolved Name: ${skill.resolvedName || '(none)'}`);
            ImGui.text(`TypeID: ${typeIdHex}`);
            ImGui.text(`PacketID: 0x${(skill.packetId || 0).toString(16).toUpperCase()}`);
            ImGui.text(`Level: ${skill.skillLevel || '?'}`);
            ImGui.text(`Slot: ${skill.skillSlot}`);
            ImGui.text(`Weapon Set: ${skill.weaponSet || 1}`);
            ImGui.text(`Packet: ${packetStr}`);
            if (skill.skillType) {
              ImGui.text(`Skill Type: ${skill.skillType}`);
            }
            ImGui.endTooltip();
          }
        } else {
          ImGui.textColored([0.5, 0.5, 0.5, 1.0], "(no packet)");
        }
        
        ImGui.popID();
      }
      
      ImGui.unindent();
    } else {
      expandedEntitySkills[entity.id] = false;
    }
    
    ImGui.popID();
  }
  
  ImGui.endChild();
}

/**
 * Get color for entity type display
 */
function getEntityTypeColor(type) {
  switch (type) {
    case 'Monster': return [1.0, 0.4, 0.4, 1.0];
    case 'Player': return [0.4, 0.8, 1.0, 1.0];
    case 'NPC': return [0.4, 1.0, 0.4, 1.0];
    default: return [0.7, 0.7, 0.7, 1.0];
  }
}

/**
 * Test cast a skill from another entity
 * Uses the skill's packet bytes with current test mode settings
 */
function testEntitySkill(skill, sourceEntity) {
  const packetBytes = skill.packetBytes;
  if (!packetBytes || packetBytes.length < 4) {
    console.error("[EntitySkills] Skill has no packet bytes");
    return false;
  }
  
  const skillName = skill.skillName || skill.resolvedName || `TypeID 0x${(skill.typeId || 0).toString(16).toUpperCase()}`;
  const mode = entityTestMode.value;
  let success = false;
  
  switch (mode) {
    case 1:  // Self
      const selfPacket = buildSelfPacket(packetBytes);
      success = poe2.sendPacket(selfPacket);
      console.log(`[EntitySkills] Test cast ${skillName} (Self) - success=${success}`);
      break;
      
    case 2:  // Direction
      const dirDeltas = angleToDeltas(entityTestAngle.value, entityTestDistance.value);
      if (entityTestChanneled.value) {
        success = executeChanneledSkill(packetBytes, dirDeltas.dx, dirDeltas.dy, 2);
      } else {
        const dirPacket = buildDirectionalPacket(packetBytes, dirDeltas.dx, dirDeltas.dy);
        success = poe2.sendPacket(dirPacket);
      }
      console.log(`[EntitySkills] Test cast ${skillName} (Direction ${entityTestAngle.value}°) - success=${success}`);
      break;
      
    case 3:  // Cursor
      const mousePos = ImGui.getMousePos();
      const player = poe2.getLocalPlayer();
      if (player && player.worldX !== undefined) {
        const playerScreen = poe2.worldToScreen(player.worldX, player.worldY, player.worldZ || 0);
        if (playerScreen && playerScreen.visible) {
          const screenDx = mousePos.x - playerScreen.x;
          const screenDy = playerScreen.y - mousePos.y;
          let cursorAngle = Math.atan2(screenDy, screenDx) * 180 / Math.PI;
          if (cursorAngle < 0) cursorAngle += 360;
          
          const cursorDeltas = angleToDeltas(cursorAngle, entityTestDistance.value);
          if (entityTestChanneled.value) {
            success = executeChanneledSkill(packetBytes, cursorDeltas.dx, cursorDeltas.dy, 2);
          } else {
            const cursorPacket = buildDirectionalPacket(packetBytes, cursorDeltas.dx, cursorDeltas.dy);
            success = poe2.sendPacket(cursorPacket);
          }
          console.log(`[EntitySkills] Test cast ${skillName} (Cursor angle ${cursorAngle.toFixed(0)}°) - success=${success}`);
        }
      }
      break;
      
    case 0:  // Target
    default:
      // Find a target (use the source entity if alive, otherwise nearest monster)
      let target = null;
      if (sourceEntity && sourceEntity.id && sourceEntity.isAlive) {
        target = sourceEntity;
      } else {
        const monsters = poe2.getEntities({ monstersOnly: true, maxDistance: 300, lightweight: true });
        if (monsters.length > 0) {
          target = monsters[0];
        }
      }
      
      if (target && target.id) {
        const targetPacket = buildTargetPacket(packetBytes, target.id, target.gridX, target.gridY);
        success = poe2.sendPacket(targetPacket);
        const targetName = (target.name || "Unknown").split('/').pop();
        console.log(`[EntitySkills] Test cast ${skillName} on ${targetName} - success=${success}`);
      } else {
        console.warn("[EntitySkills] No valid target for skill test");
      }
      break;
  }
  
  return success;
}

// Import v1 rotations and convert to v2 format
function importV1Rotations() {
  const V1_FILE = "rotations.json";
  try {
    const data = fs.readFile(V1_FILE);
    if (!data) {
      console.log("[Rotation] No v1 rotations file found");
      return { found: false, rotations: {} };
    }
    
    const v1Data = JSON.parse(data);
    const v2Data = {};
    let totalImported = 0;
    
    for (const [rotName, skills] of Object.entries(v1Data)) {
      v2Data[rotName] = [];
      
      for (const v1Skill of skills) {
        // V1 format: 11-byte packetBytes array
        // [0-2]: 01 84 01 (header)
        // [3]: marker (0x85, etc.)
        // [4]: slot
        // [5]: b1 (usually 0x00)
        // [6]: b0 (0x40 or 0x41 for weapon set)
        // [7-10]: 04 XX FF XX (flags)
        
        const v1Bytes = v1Skill.packetBytes || [];
        
        // Extract the 4-byte skill identifier from v1 format
        let packetBytes = [0, 0, 0, 0];
        if (v1Bytes.length >= 7) {
          packetBytes[0] = v1Bytes[3];  // marker
          packetBytes[1] = v1Bytes[4];  // slot
          packetBytes[2] = v1Bytes[5];  // b1
          packetBytes[3] = v1Bytes[6];  // b0 (weapon set)
        }
        
        // Determine weapon set from last byte
        const weaponSet = (packetBytes[3] === 0x41) ? 2 : 1;
        
        // Create v2 skill entry
        const v2Skill = {
          enabled: v1Skill.enabled !== false,
          name: v1Skill.name || 'Imported Skill',
          skillName: null,  // V1 didn't have skill name lookup
          packetBytes: packetBytes,
          typeId: 0,  // Unknown from v1 format
          weaponSet: weaponSet,
          targetMode: 'target',  // V1 was always target mode
          conditions: v1Skill.conditions || []
        };
        
        v2Data[rotName].push(v2Skill);
        totalImported++;
      }
    }
    
    console.log(`[Rotation] Found ${totalImported} skills in v1 format`);
    return { found: true, rotations: v2Data, count: totalImported };
    
  } catch (e) {
    console.error("[Rotation] Failed to read v1 rotations:", e);
    return { found: false, rotations: {} };
  }
}

// State for import UI
let v1ImportResult = null;
let showImportPreview = false;

function drawManageUI() {
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Rotation Management");
  ImGui.separator();
  
  ImGui.text(`Current Rotation: ${currentRotationName}`);
  
  // Save as
  ImGui.text("Save Current Rotation As:");
  ImGui.inputText("##rotname", rotationNameInput);
  ImGui.sameLine();
  if (ImGui.button("Save")) {
    currentRotationName = rotationNameInput.value || "default";
    saveRotations();
    if (!availableRotations.includes(currentRotationName)) {
      availableRotations.push(currentRotationName);
    }
  }
  
  ImGui.separator();
  ImGui.text("Available Rotations:");
  
  if (availableRotations.length > 0) {
    for (const rotName of availableRotations) {
      const isCurrent = (rotName === currentRotationName);
      if (isCurrent) {
        ImGui.textColored([0.5, 1.0, 0.5, 1.0], `> ${rotName} (current)`);
      } else {
        if (ImGui.button(`Load: ${rotName}`)) {
          switchRotation(rotName);
          rotationNameInput.value = rotName;
        }
      }
    }
  } else {
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], "(No saved rotations)");
  }
  
  ImGui.separator();
  
  // Import V1 Rotations section
  ImGui.textColored([1.0, 0.8, 0.3, 1.0], "Import from Rotation Builder v1:");
  ImGui.textWrapped("Import rotations from the old rotations.json file.");
  
  if (ImGui.button("Scan for V1 Rotations")) {
    v1ImportResult = importV1Rotations();
    showImportPreview = v1ImportResult.found;
  }
  
  if (v1ImportResult) {
    if (v1ImportResult.found) {
      const rotNames = Object.keys(v1ImportResult.rotations);
      ImGui.textColored([0.5, 1.0, 0.5, 1.0], `Found ${v1ImportResult.count} skills in ${rotNames.length} rotation(s)`);
      
      if (showImportPreview) {
        ImGui.text("Rotations to import:");
        for (const rotName of rotNames) {
          const skillCount = v1ImportResult.rotations[rotName].length;
          ImGui.bulletText(`${rotName}: ${skillCount} skills`);
        }
        
        ImGui.separator();
        
        if (ImGui.button("Import All to V2", {x: 150, y: 0})) {
          // Merge v1 rotations into v2 file
          try {
            let existingV2 = {};
            try {
              const existing = fs.readFile(ROTATIONS_FILE);
              if (existing) existingV2 = JSON.parse(existing);
            } catch (e) {}
            
            // Merge - v1 rotations get "_v1" suffix if name exists
            for (const [rotName, skills] of Object.entries(v1ImportResult.rotations)) {
              let newName = rotName;
              if (existingV2[rotName]) {
                newName = `${rotName}_v1`;
              }
              existingV2[newName] = skills;
              if (!availableRotations.includes(newName)) {
                availableRotations.push(newName);
              }
            }
            
            fs.writeFile(ROTATIONS_FILE, JSON.stringify(existingV2, null, 2));
            console.log(`[Rotation] Imported ${v1ImportResult.count} skills from v1`);
            
            // Reload current rotation
            loadRotations();
            
            showImportPreview = false;
            v1ImportResult = { found: true, imported: true };
            
          } catch (e) {
            console.error("[Rotation] Failed to import:", e);
          }
        }
        
        ImGui.sameLine();
        if (ImGui.button("Cancel", {x: 80, y: 0})) {
          showImportPreview = false;
        }
      }
    } else {
      ImGui.textColored([0.8, 0.5, 0.5, 1.0], "No v1 rotations.json found");
    }
    
    if (v1ImportResult.imported) {
      ImGui.textColored([0.5, 1.0, 0.5, 1.0], "Import complete! Check Available Rotations above.");
    }
  }
  
  ImGui.separator();
  ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Sharing Rotations:");
  ImGui.textWrapped("Rotations are stored by skill NAME, not slot. Share the rotations_v2.json file with others - it will work as long as they have the same skills equipped (any slot).");
  
  ImGui.separator();
  if (ImGui.button("Clear Current Rotation")) {
    rotations = [];
    saveRotations();
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export function drawRotationTab() {
  drawRotationBuilder();
}

export function executeRotationOnTarget(targetEntity, distance) {
  return executeRotation(targetEntity, distance);
}

// Export packet building functions for use by quick actions
export { 
  buildTargetPacket,
  buildSelfPacket,
  buildDirectionalPacket,
  buildContinuationPacket,
  buildMovementPacket,
  buildMovementStop,
  encodeZigzagVarint,
  sendChannelStart,
  sendChannelEnd,
  sendStopAction,
  executeChanneledSkill,
  angleToDeltas,
  findSkillByName,
  getActiveSkills,
  findNearestDeadEntity,
  findEntityNearestToCursor,
  findAliveEntityNearestToCursor,
  findDeadEntityNearestToCursor
};

let initialized = false;
export function initialize() {
  if (!initialized) {
    loadRotations();
    initialized = true;
  }
}

console.log("[Rotation] Builder v2 loaded (skill name-based for shareability)");

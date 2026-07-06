/**
 * Opener Plugin
 * 
 * Automatically opens nearby chests (and later doors/objects) when within range.
 * Uses shared POE2Cache for per-frame caching.
 * Settings are persisted per player.
 * 
 * PERFORMANCE OPTIMIZED: Uses shared POE2Cache for per-frame caching
 * NOTE: Do NOT call POE2Cache.beginFrame() here - it's called once in main.js
 */

import { POE2Cache, poe2 } from './poe2_cache.js';
import { Settings } from './Settings.js';

// Plugin name for settings
const PLUGIN_NAME = 'opener';

// Default settings
const DEFAULT_SETTINGS = {
  enabled: false,              // Auto-open disabled by default (user must opt-in)
  maxDistance: 80,             // Max distance to auto-open
  openCooldownMs: 300,         // Cooldown between open attempts (ms)
  visibilityMode: 1,           // 0=Off, 1=Line of Fire, 2=Walkable LoS
  openStrongboxes: false,      // Don't auto-open strongboxes by default (dangerous!)
  openNormalChests: true,      // Open normal chests
  openEssences: true,          // Open essence monoliths
  openShrines: true,           // Open shrines (default ON)
  openDoors: true,             // Open doors (default ON)
  openPrecursorRelay: true,    // Click the Precursor Relay (Atlas Points console) -- default ON
  excludeChestNames: "Royal Trove, Atziri's Vault",  // Exclude these chests by name
  showLastOpened: true         // Show last opened chest info
};

// Current settings (will be loaded from file)
let currentSettings = { ...DEFAULT_SETTINGS };
let currentPlayerName = null;
let settingsLoaded = false;

// Settings - using MutableVariable for ImGui bindings
const enabled = new ImGui.MutableVariable(DEFAULT_SETTINGS.enabled);
const maxDistance = new ImGui.MutableVariable(DEFAULT_SETTINGS.maxDistance);
const openCooldownMs = new ImGui.MutableVariable(DEFAULT_SETTINGS.openCooldownMs);
const visibilityMode = new ImGui.MutableVariable(DEFAULT_SETTINGS.visibilityMode);
const openStrongboxes = new ImGui.MutableVariable(DEFAULT_SETTINGS.openStrongboxes);
const openNormalChests = new ImGui.MutableVariable(DEFAULT_SETTINGS.openNormalChests);
const openEssences = new ImGui.MutableVariable(DEFAULT_SETTINGS.openEssences);
const openShrines = new ImGui.MutableVariable(DEFAULT_SETTINGS.openShrines);
const openDoors = new ImGui.MutableVariable(DEFAULT_SETTINGS.openDoors);
const openPrecursorRelay = new ImGui.MutableVariable(DEFAULT_SETTINGS.openPrecursorRelay);
const excludeChestNames = new ImGui.MutableVariable(DEFAULT_SETTINGS.excludeChestNames);
const showLastOpened = new ImGui.MutableVariable(DEFAULT_SETTINGS.showLastOpened);

// Auto-open state
let lastOpenTime = 0;
let lastOpenedChestName = "";
let lastOpenedChestId = 0;
let lastOpenedChestDistance = 0;
const visibilityCache = new Map();  // key -> { result, timestamp }
const VISIBILITY_CACHE_TTL = 500;
const doorSkipUntil = new Map(); // key -> timestamp ms

// General anti-repeat blacklist for EVERY opener target type (mirrors pickit's
// pickupAttempts). Doors keep their own smart pre-skip above; this is the universal
// backstop. After OPEN_MAX_ATTEMPTS opens that didn't make a target go away (chest ->
// opened / shrine|essence -> non-targetable), the target is banned so the opener AND the
// mapper stop hammering it -- e.g. StoneCircle runes that never consume on a plain
// interact. Keyed by position+name so it survives entity-id slab recycle.
const openBlacklist = new Map(); // key -> { attempts, lastAttemptTime, banned, until }
const OPEN_RETRY_DELAY_MS = 2500; // min gap between attempts on the same target
const OPEN_MAX_ATTEMPTS = 3;      // attempts before a long ban
const OPEN_BAN_MS = 600000;       // 10 min: effectively the rest of the map
let lastBlacklistPrune = 0;

// Scan throttle + cached result (perf):
// processAutoOpen used to run a full collectOpenTargets() every frame whenever
// the open-cooldown had elapsed, which meant 60Hz scans in empty rooms (the
// cooldown only advances on a SUCCESSFUL open). lastScanTime floors scan
// frequency at min(openCooldownMs, 150ms). cachedScanTargets/cachedScanFrame
// let the UI "Targets in range: N" label reuse the same scan result instead
// of running collectOpenTargets a second time per frame.
let lastScanTime = 0;
let cachedScanTargets = [];
let cachedScanFrame = -1;

const VISIBILITY_MODE = {
  OFF: 0,
  LINE_OF_FIRE: 1,
  LINE_OF_SIGHT: 2
};

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
    enabled.value = currentSettings.enabled;
    maxDistance.value = currentSettings.maxDistance;
    openCooldownMs.value = currentSettings.openCooldownMs;
    visibilityMode.value = (typeof currentSettings.visibilityMode === 'number')
      ? currentSettings.visibilityMode
      : DEFAULT_SETTINGS.visibilityMode;
    openStrongboxes.value = currentSettings.openStrongboxes;
    openNormalChests.value = currentSettings.openNormalChests;
    openEssences.value = currentSettings.openEssences !== undefined ? currentSettings.openEssences : DEFAULT_SETTINGS.openEssences;
    openShrines.value = currentSettings.openShrines;
    openDoors.value = currentSettings.openDoors !== undefined ? currentSettings.openDoors : DEFAULT_SETTINGS.openDoors;
    openPrecursorRelay.value = currentSettings.openPrecursorRelay !== undefined ? currentSettings.openPrecursorRelay : DEFAULT_SETTINGS.openPrecursorRelay;
    excludeChestNames.value = currentSettings.excludeChestNames;
    showLastOpened.value = currentSettings.showLastOpened;
    
    console.log(`[Opener] Loaded settings for player: ${player.playerName}`);
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
  currentSettings.enabled = enabled.value;
  currentSettings.maxDistance = maxDistance.value;
  currentSettings.openCooldownMs = openCooldownMs.value;
  currentSettings.visibilityMode = visibilityMode.value;
  currentSettings.openStrongboxes = openStrongboxes.value;
  currentSettings.openNormalChests = openNormalChests.value;
  currentSettings.openEssences = openEssences.value;
  currentSettings.openShrines = openShrines.value;
  currentSettings.openDoors = openDoors.value;
  currentSettings.openPrecursorRelay = openPrecursorRelay.value;
  currentSettings.excludeChestNames = excludeChestNames.value;
  currentSettings.showLastOpened = showLastOpened.value;
  
  Settings.setMultiple(PLUGIN_NAME, currentSettings);
}

/**
 * Check if chest/object name is excluded
 */
function isExcludedByName(entity) {
  if (!excludeChestNames.value || excludeChestNames.value.trim().length === 0) {
    return false;
  }
  
  // Get render name (human-readable name)
  const renderName = (entity.renderName || "").toLowerCase();
  if (!renderName) return false;
  
  // Parse exclusion list (comma-separated)
  const excludes = excludeChestNames.value.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
  
  // Check if render name contains any excluded name
  for (const exclude of excludes) {
    if (renderName.includes(exclude)) {
      return true;
    }
  }
  
  return false;
}

function isDoorEntity(entity) {
  const name = (entity.name || "").toLowerCase();
  const renderName = (entity.renderName || "").toLowerCase();
  return name.includes('door') || renderName.includes('door');
}

function getDoorKey(entity) {
  if (!entity) return '';
  if (entity.id && entity.id !== 0) return `id:${entity.id}`;
  const gx = Number.isFinite(entity.gridX) ? Math.floor(entity.gridX) : 0;
  const gy = Number.isFinite(entity.gridY) ? Math.floor(entity.gridY) : 0;
  return `sig:${(entity.name || '').toLowerCase()}:${gx}:${gy}`;
}

function shouldSkipDoor(entity, now) {
  const key = getDoorKey(entity);
  if (!key) return false;
  const until = doorSkipUntil.get(key) || 0;
  return until > now;
}

function markSkipDoor(entity, now, ttlMs = 7000) {
  const key = getDoorKey(entity);
  if (!key) return;
  doorSkipUntil.set(key, now + Math.max(500, Math.floor(ttlMs)));
}

function isLikelyAlreadyOpenDoor(entity) {
  if (!entity) return false;
  const name = `${entity.name || ''}`.toLowerCase();
  const renderName = `${entity.renderName || ''}`.toLowerCase();
  const anim = `${entity.animationName || ''}`.toLowerCase();

  // Transition-like objects can include "door" in metadata but are not door opens.
  if (name.includes('transition') || renderName.includes('transition') || name.includes('areatransition')) return true;

  // Common opened/opening animation labels.
  if (anim.includes('opened') || anim.includes('open_idle') || anim === 'open') return true;
  if (anim.includes('open') && !anim.includes('close')) return true;

  return false;
}

// --- General anti-repeat blacklist (all target types) ---
function getOpenKey(entity) {
  if (!entity) return '';
  const gx = Number.isFinite(entity.gridX) ? Math.floor(entity.gridX) : null;
  const gy = Number.isFinite(entity.gridY) ? Math.floor(entity.gridY) : null;
  const nm = (entity.name || entity.renderName || '').toLowerCase();
  // Position+name is stable for static openables and survives entity-id slab recycle.
  if (gx !== null && gy !== null && nm) return `o:${nm}:${gx}:${gy}`;
  if (entity.id) return `id:${entity.id}`;
  return '';
}

// banOnly=true ignores the short per-attempt cooldown and only hides hard-banned targets
// (used for the mapper candidate path so it doesn't thrash walking toward a target that is
// merely mid-cooldown between opener attempts).
function shouldSkipOpenTarget(entity, now, banOnly) {
  const key = getOpenKey(entity);
  if (!key) return false;
  const rec = openBlacklist.get(key);
  if (!rec) return false;
  if (rec.banned) return rec.until > now;
  if (banOnly) return false;
  return (now - rec.lastAttemptTime) < OPEN_RETRY_DELAY_MS;
}

// A strongbox's contents are gated until its GUARD pack dies: clicking while guards live is a no-op that burns
// an anti-repeat attempt (3 no-ops = 10-min ban -> contents stranded) AND takes the 2s movement lock (plants the
// player inside the guard fight). Skip guarded boxes each scan until the pack is dead. 500ms-cached per box.
let _sbGuardAt = 0, _sbGuardVal = false, _sbGuardKey = '';
function strongboxGuardsNear(entity) {
  const now = Date.now();
  const key = getOpenKey(entity);
  if (key === _sbGuardKey && now - _sbGuardAt < 500) return _sbGuardVal;
  _sbGuardKey = key; _sbGuardAt = now; _sbGuardVal = false;
  try {
    for (const m of (poe2.getEntities({ type: 'Monster', aliveOnly: true, lightweight: true, maxDistance: 160 }) || [])) {
      if (!m.isHostile || m.isTargetable === false) continue;
      if (Math.hypot((m.gridX || 0) - entity.gridX, (m.gridY || 0) - entity.gridY) < 60) { _sbGuardVal = true; break; }
    }
  } catch (_) {}
  return _sbGuardVal;
}

// Returns true only on the attempt that escalates the target to a hard ban (for logging).
function markOpenAttempt(entity, now) {
  const key = getOpenKey(entity);
  if (!key) return false;
  let rec = openBlacklist.get(key);
  if (!rec) { rec = { attempts: 0, lastAttemptTime: 0, banned: false, until: 0 }; openBlacklist.set(key, rec); }
  rec.attempts++;
  rec.lastAttemptTime = now;
  if (!rec.banned && rec.attempts >= OPEN_MAX_ATTEMPTS) {
    rec.banned = true;
    rec.until = now + OPEN_BAN_MS;
    return true;
  }
  return false;
}

function pruneOpenBlacklist(now) {
  for (const [key, rec] of openBlacklist) {
    if (rec.banned) { if (rec.until <= now) openBlacklist.delete(key); }
    else if (now - rec.lastAttemptTime > 60000) openBlacklist.delete(key); // stale, never escalated
  }
}

// Portals/teleporters must NEVER be auto-opened: interacting warps the player out of
// the area. PoE2's MultiplexPortal lives under the Monolith metadata dir, so the
// Essence bucket (isEssenceEntity) classified it as a monolith and the opener logged
// "Opened Essence: MultiplexPortal" right next to the player. A per-classifier guard
// isn't enough -- this is also enforced as a hard final filter in collectOpenTargets,
// which is the single chokepoint for both processAutoOpen() and the mapper candidates.
function isWarpOrPortalEntity(entity) {
  const name = (entity?.name || "").toLowerCase();
  const renderName = (entity?.renderName || "").toLowerCase();
  if (!name && !renderName) return false;
  if (name.includes('multiplexportal') || renderName.includes('multiplexportal')) return true;
  if (name.includes('portal') || renderName.includes('portal')) return true;
  return false;
}

function isShrineEntity(entity) {
  const name = (entity?.name || "").toLowerCase();
  const renderName = (entity?.renderName || "").toLowerCase();
  if (!name && !renderName) return false;

  // Never treat a portal/teleporter as a shrine (interacting warps the player).
  // Shared guard; also applied as a hard final filter in collectOpenTargets.
  if (isWarpOrPortalEntity(entity)) return false;

  // Common direct matches.
  if (name.includes('shrine') || renderName.includes('shrine')) return true;

  // Metadata fallback for shrine-like openables.
  if ((name.includes('/shrines/') || name.includes('\\shrines\\')) && !name.includes('waypoint')) return true;
  return false;
}

function isSpecialInteractableEntity(entity) {
  const name = (entity?.name || "").toLowerCase();
  const renderName = (entity?.renderName || "").toLowerCase();
  if (!name && !renderName) return false;

  // Known anomaly/hengestone interactables (example: Draiocht Hengestone).
  if (renderName.includes('hengestone')) return true;
  // Monolith is handled in Essence bucket, not generic Special.
  if (name.includes('/miscellaneousobjects/monolith') || name.includes('\\miscellaneousobjects\\monolith')) return false;
  if ((name.includes('/endgame/anomalyobject') || name.includes('\\endgame\\anomalyobject')) && !name.includes('effect')) return true;
  // Precursor Relay (Atlas Points console) -- optional toggle, default ON. render "Precursor Relay" /
  // name Metadata/MiscellaneousObjects/AtlasPointDoodad. (Special bucket is always-on; gate per-setting.)
  if (openPrecursorRelay.value && (renderName.includes('precursor relay') || name.includes('atlaspointdoodad'))) return true;
  return false;
}

function isEssenceEntity(entity) {
  const name = (entity?.name || "").toLowerCase();
  const renderName = (entity?.renderName || "").toLowerCase();
  if (!name && !renderName) return false;

  // NOTE: StoneCircle "Runed Monolith" (Metadata/Terrain/.../StoneCircle/Objects/RuneRock)
  // matches via renderName "monolith" even though it's a terrain rune-puzzle, not a loot
  // essence. We deliberately do NOT hard-exclude it: live-RE found no "spent" flag beyond
  // Targetable+0x69 (consumed -> non-targetable, already skipped). Un-consumed runes that a
  // plain interact can't trigger are handled by the general anti-repeat blacklist
  // (markOpenAttempt/OPEN_MAX_ATTEMPTS) -- attempt a few times, then ban for the map.
  return (
    name.includes('/miscellaneousobjects/monolith') ||
    name.includes('\\miscellaneousobjects\\monolith') ||
    renderName.includes('monolith')
  );
}

function passesVisibilityCheck(player, entity, maxDist) {
  if (visibilityMode.value === VISIBILITY_MODE.OFF) return true;
  if (!player || !entity || player.gridX === undefined || entity.gridX === undefined) return true;

  const fromX = Math.floor(player.gridX);
  const fromY = Math.floor(player.gridY);
  const toX = Math.floor(entity.gridX);
  const toY = Math.floor(entity.gridY);
  const checkDist = maxDist || maxDistance.value || DEFAULT_SETTINGS.maxDistance;
  const entityId = entity.id || 0;
  const cacheKey = `${entityId}:${visibilityMode.value}:${checkDist}`;
  const now = Date.now();

  const cached = visibilityCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < VISIBILITY_CACHE_TTL) {
    return cached.result;
  }

  let result = true;
  try {
    if (visibilityMode.value === VISIBILITY_MODE.LINE_OF_FIRE) {
      if (typeof poe2.hasLineOfFire === 'function') {
        result = poe2.hasLineOfFire(fromX, fromY, toX, toY, checkDist);
      } else if (typeof poe2.isWithinLineOfSight === 'function') {
        result = poe2.isWithinLineOfSight(fromX, fromY, toX, toY, checkDist);
      }
    } else if (visibilityMode.value === VISIBILITY_MODE.LINE_OF_SIGHT) {
      if (typeof poe2.isWithinLineOfSight === 'function') {
        result = poe2.isWithinLineOfSight(fromX, fromY, toX, toY, checkDist);
      } else if (typeof poe2.hasLineOfFire === 'function') {
        result = poe2.hasLineOfFire(fromX, fromY, toX, toY, checkDist);
      }
    }
  } catch (e) {
    result = true;  // fail open to avoid blocking opener due to api/read issues
  }

  visibilityCache.set(cacheKey, { result, timestamp: now });
  return result;
}

function collectOpenTargets(maxDist, includeDoors, allowBlockedVisibility = false) {
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) return [];

  const targetsToOpen = [];
  const seenIds = new Set();
  const now = Date.now();

  if (openNormalChests.value || openStrongboxes.value) {
    const chests = POE2Cache.getEntities({ type: "Chest", maxDistance: maxDist, lightweight: true });
    for (const entity of chests) {
      if (!entity.gridX || entity.isLocalPlayer) continue;
      if (!entity.id || entity.id === 0) continue;
      if (entity.chestIsOpened === true) continue;
      if (entity.isTargetable !== true) continue;
      if (isExcludedByName(entity)) continue;

      let shouldOpen = false;
      let objectType = "Unknown";
      if (entity.chestIsStrongbox === true && openStrongboxes.value) {
        shouldOpen = true;
        objectType = "Strongbox";
      } else if (entity.chestIsStrongbox === false && openNormalChests.value) {
        shouldOpen = true;
        objectType = "Chest";
      }
      if (!shouldOpen) continue;

      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!allowBlockedVisibility && !passesVisibilityCheck(player, entity, maxDist)) continue;
      targetsToOpen.push({ entity: entity, distance: dist, type: objectType });
      seenIds.add(entity.id);
    }
  }

  if (openShrines.value) {
    // Do not restrict shrine scan by entity type; shrine objects may appear
    // as non-monster entities depending on area/version.
    // lightweight=true: opener only reads name/renderName/grid/id/isTargetable/
    // chestIs*/animationName/entityType -- all populated under lightweight, which
    // skips Buffs/Stats/Mods/WorldItem (the expensive buff_cache_mutex_ path).
    const nearby = POE2Cache.getEntities({ maxDistance: maxDist, lightweight: true });
    for (const entity of nearby) {
      if (!Number.isFinite(entity.gridX) || !Number.isFinite(entity.gridY) || entity.isLocalPlayer) continue;
      if (!entity.id || entity.id === 0) continue;
      if (seenIds.has(entity.id)) continue;
      if (!isShrineEntity(entity)) continue;
      if (entity.isTargetable !== true) continue;

      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Shrines frequently report blocked LoS/LoF in tight layouts even when
      // they are valid/targetable. Keep chest visibility behavior unchanged,
      // but relax shrine gating so opener/mapper can still interact.
      if (!allowBlockedVisibility && !passesVisibilityCheck(player, entity, maxDist) && dist > 34) continue;
      targetsToOpen.push({ entity: entity, distance: dist, type: "Shrine" });
      seenIds.add(entity.id);
    }
  }

  // Essence interactables (Monolith) - explicit bucket so mapper/opener logs
  // show these as "Essence" instead of generic special objects.
  if (openEssences.value) {
    const nearby = POE2Cache.getEntities({ maxDistance: maxDist, lightweight: true });
    for (const entity of nearby) {
      if (!Number.isFinite(entity.gridX) || !Number.isFinite(entity.gridY) || entity.isLocalPlayer) continue;
      if (!entity.id || entity.id === 0) continue;
      if (seenIds.has(entity.id)) continue;
      if (!isEssenceEntity(entity)) continue;
      if (entity.isTargetable !== true) continue;
      if (isExcludedByName(entity)) continue;

      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!allowBlockedVisibility && !passesVisibilityCheck(player, entity, maxDist) && dist > 40) continue;
      targetsToOpen.push({ entity: entity, distance: dist, type: "Essence" });
      seenIds.add(entity.id);
    }
  }

  // Special clickable objects (e.g. Draiocht Hengestone anomaly objects).
  // These can be mission/map progression interactables that should be opened like shrines.
  {
    const nearby = POE2Cache.getEntities({ maxDistance: maxDist, lightweight: true });
    for (const entity of nearby) {
      if (!Number.isFinite(entity.gridX) || !Number.isFinite(entity.gridY) || entity.isLocalPlayer) continue;
      if (!entity.id || entity.id === 0) continue;
      if (seenIds.has(entity.id)) continue;
      if (!isSpecialInteractableEntity(entity)) continue;
      if (entity.isTargetable !== true) continue;
      if (isExcludedByName(entity)) continue;

      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!allowBlockedVisibility && !passesVisibilityCheck(player, entity, maxDist) && dist > 40) continue;
      targetsToOpen.push({ entity: entity, distance: dist, type: "Special" });
      seenIds.add(entity.id);
    }
  }

  if (includeDoors && openDoors.value) {
    const allNearby = POE2Cache.getEntities({ maxDistance: maxDist, lightweight: true });
    for (const entity of allNearby) {
      if (!entity.gridX || entity.isLocalPlayer) continue;
      if (!entity.id || entity.id === 0) continue;
      if (seenIds.has(entity.id)) continue;
      if (shouldSkipDoor(entity, now)) continue;
      if (entity.isTargetable !== true) continue;
      if (!isDoorEntity(entity)) continue;
      if (isLikelyAlreadyOpenDoor(entity)) {
        markSkipDoor(entity, now, 12000);
        continue;
      }
      if (entity.entityType === 'Chest') continue;
      if ((entity.name || "").toLowerCase().includes('shrine')) continue;
      if (isExcludedByName(entity)) continue;

      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Doors often report blocked LoS/LoF while still being valid interactables
      // in narrow tiles/corridors. Keep far-distance visibility checks, but allow
      // close door opens to avoid getting stuck at map doors.
      if (!allowBlockedVisibility && !passesVisibilityCheck(player, entity, maxDist) && dist > 36) continue;
      targetsToOpen.push({ entity: entity, distance: dist, type: "Door" });
      seenIds.add(entity.id);
    }
  }

  // HARD GUARD (always-on, covers EVERY bucket above + the mapper candidate path):
  // strip any warp/teleporter. MultiplexPortal classifies as an Essence monolith, so
  // the essence bucket would otherwise open it ("Opened Essence: MultiplexPortal") and
  // warp the player out of the map. This is the single chokepoint shared by
  // processAutoOpen() and getOpenableCandidatesForMapper(), so filtering here is
  // sufficient no matter which bucket classified the entity.
  // allowBlockedVisibility is the mapper candidate path -> banOnly so the mapper won't
  // thrash on a target that is only mid-cooldown between opener attempts; the opener path
  // (allowBlockedVisibility=false) honors the short cooldown too.
  return targetsToOpen.filter(t =>
    !isWarpOrPortalEntity(t.entity) &&
    !shouldSkipOpenTarget(t.entity, now, allowBlockedVisibility));
}

function getOpenableCandidatesForMapper(maxDist) {
  loadPlayerSettings();
  const effectiveDist = Math.max(20, Math.floor(maxDist || maxDistance.value || 200));
  // Mapper needs walk-target candidates even when LoF/LoS is currently blocked,
  // so it can path to the object and let opener interact once in range.
  const targets = collectOpenTargets(effectiveDist, false, true);
  if (targets.length === 0) return [];
  targets.sort((a, b) => a.distance - b.distance);
  return targets;
}

function getOpenerCooldownMs() {
  loadPlayerSettings();
  const v = Math.floor(openCooldownMs.value || DEFAULT_SETTINGS.openCooldownMs || 300);
  return Math.max(0, v);
}

/**
 * Send open/interact packet
 * Packet: 01 A3 01 20 00 C2 66 04 00 FF 08 [ID: 4 bytes BE] [gridX: 4 bytes BE] [gridY: 4 bytes BE]
 *
 * 050b game-patch update: entity-targeted packets now require the target's
 * INTEGER grid (BE u32) appended after the entity ID. Normal chests sometimes
 * tolerate the legacy 15-byte form (server ignores or accepts), but special
 * interactables (ScarabAmbushLandmarkChest, etc.) DC on the truncated packet.
 * Rotation_builder.buildTargetPacket already does this; opener was missed.
 */
function sendOpenPacket(entityId, gridX, gridY) {
  const id = entityId | 0;
  const bytes = [
    0x01, 0xA3, 0x01, 0x20, 0x00, 0xC2, 0x66, 0x04,
    0x00, 0xFF, 0x08,  // 0x00 = interact/open action
    (id >> 24) & 0xFF,  // Big endian: MSB first
    (id >> 16) & 0xFF,
    (id >> 8) & 0xFF,
    id & 0xFF           // LSB last
  ];
  if (gridX !== undefined && gridX !== null && gridY !== undefined && gridY !== null) {
    const gx = Math.floor(gridX);
    const gy = Math.floor(gridY);
    bytes.push((gx >>> 24) & 0xFF, (gx >>> 16) & 0xFF, (gx >>> 8) & 0xFF, gx & 0xFF);
    bytes.push((gy >>> 24) & 0xFF, (gy >>> 16) & 0xFF, (gy >>> 8) & 0xFF, gy & 0xFF);
  }
  return poe2.sendPacket(new Uint8Array(bytes));
}

/**
 * Auto-open logic (runs ALWAYS, even when window is collapsed)
 */
function processAutoOpen() {
  if (!enabled.value) {
    return;
  }

  const now = Date.now();

  // Prune the anti-repeat blacklist (expired bans + stale un-escalated entries).
  if (now - lastBlacklistPrune > 5000) { lastBlacklistPrune = now; pruneOpenBlacklist(now); }

  // ONE ACTION SLOT: a live claim means an interaction is already in flight -- pickit walking an item down,
  // or our OWN previous open still auto-walking. Firing now would REPLACE that action server-side (the open
  // that "never opened" / the item that never got picked), and the cancelled target still burned one of its
  // retry attempts toward its map-ban. Waiting the claim out costs <=2.5s and makes every attempt real.
  // Ordering effect: loot drains before chests open (chests drop MORE loot into the same dwell).
  if (POE2Cache.interactionClaim && POE2Cache.interactionClaim()) return;

  if (now - lastOpenTime < openCooldownMs.value) {
    return;
  }

  // Throttle the SCAN itself (not just successful opens). lastOpenTime only
  // advances on a successful sendOpenPacket, so empty rooms previously scanned
  // every frame. Scan rate now follows the cooldown slider directly -- bump
  // openCooldownMs in the UI to reduce scan frequency further. Default 300ms
  // = 3.3Hz scans; raise to 500-1000ms for noticeably less CPU work in juiced
  // maps if reaction latency is acceptable.
  const scanInterval = openCooldownMs.value;
  if (now - lastScanTime < scanInterval) {
    return;
  }
  lastScanTime = now;

  const targetsToOpen = collectOpenTargets(maxDistance.value, true);
  cachedScanTargets = targetsToOpen;
  cachedScanFrame = POE2Cache.getFrameNumber();

  if (targetsToOpen.length > 0) {
    // Sort by distance (closest first)
    targetsToOpen.sort((a, b) => a.distance - b.distance);
    
    // WALKABLE GATE (USER): only open a target we can actually REACH -- skip any whose straight line is wall-blocked
    // (isWithinLineOfSight = walkable-grid line). UNCONDITIONAL (independent of the visibilityMode toggle, which is
    // OFF here) so a walled chest can't be 're-opened' forever (the 0xC0 spam). Picks the nearest REACHABLE target;
    // if every in-range target is wall-blocked this scan, skip (the mapper's no-progress watchdog moves us on).
    // Fail-open if the binding/read is unavailable.
    const _pl = POE2Cache.getLocalPlayer();
    let target = null;
    // ESSENCE is TIME-SENSITIVE: the attack side skips the imprisoned rare only ~12s waiting for us to START the
    // monolith, so open essences FIRST and EXEMPT them from the walkable-LoS gate -- you stand adjacent + sendOpenPacket
    // auto-walks/routes via the GAME pathfinder. REGRESSION CAUSE: once the mapper stopped engaging the imprisoned rare,
    // the bot sits FARTHER from the monolith, its straight-line LoS reads wall-blocked, the gate skipped it, and the
    // essence was never started (then the 12s safety let the rare get attacked imprisoned = wasted). The anti-repeat
    // blacklist (markOpenAttempt/OPEN_MAX_ATTEMPTS) still bounds a genuinely-unreachable monolith to a few attempts.
    const ordered = targetsToOpen.filter(t => t.type === 'Essence').concat(targetsToOpen.filter(t => t.type !== 'Essence'));
    for (const t of ordered) {
      if (t.type === 'Essence') { target = t; break; }   // priority + gate-exempt (auto-walk via the open packet)
      if (t.type === 'Strongbox' && strongboxGuardsNear(t.entity)) continue;   // guards alive -> wait, don't burn attempts/locks
      let reachable = true;
      try {
        if (_pl && t.entity && typeof poe2.isWithinLineOfSight === 'function') {
          const tx = Math.floor(t.entity.gridX), ty = Math.floor(t.entity.gridY);
          // ONLY gate openables whose OWN cell is WALKABLE (ground chests). A SHRINE sits on an UNWALKABLE cell (you
          // stand ADJACENT) -> a cell-LOS ALWAYS fails for it (live-RE: shrineCellWalkable=false), so don't gate
          // those (the mapper's no-progress blacklist catches a genuinely unreachable one). The 0xC0 walled chest
          // has a WALKABLE cell, so the wall-on-the-line check still skips it.
          const cellWalkable = (typeof poe2.isWalkable === 'function') ? poe2.isWalkable(tx, ty) : true;
          if (cellWalkable) {
            reachable = poe2.isWithinLineOfSight(Math.floor(_pl.gridX), Math.floor(_pl.gridY), tx, ty, (t.distance || 0) + 12);
          }
        }
      } catch (_) { reachable = true; }
      if (reachable) { target = t; break; }
    }
    if (!target) return;
    const success = sendOpenPacket(target.entity.id, target.entity.gridX, target.entity.gridY);
    
    if (success) {
      lastOpenedChestName = target.entity.name || "Unknown";
      lastOpenedChestId = target.entity.id;
      lastOpenedChestDistance = target.distance;
      lastOpenTime = now;
      // Universal anti-repeat: count this attempt; a target that won't go away gets banned.
      const justBanned = markOpenAttempt(target.entity, now);
      if (target.type === "Door") {
        // Even when a door is already open, interaction can report success.
        // Suppress quick retries to avoid repeated opener-yield loops.
        markSkipDoor(target.entity, now, 9000);
      }

      // Request movement lock so mapper yields while game auto-walks to open. Q1 (USER): 2s dwell on a successful open
      // -> stand still + let pickit grab the drop, don't run off (1500 -> 2000).
      POE2Cache.requestMovementLock('opener', 2000);
      // Hold the action slot for the walk+open so pickit / the next open can't cancel it (TTL scales with the walk).
      if (POE2Cache.claimInteraction) POE2Cache.claimInteraction('opener', target.entity.id, Math.min(2500, 600 + (target.distance || 0) * 30));

      const shortName = lastOpenedChestName.split('/').pop() || lastOpenedChestName;
      const idHex = `0x${lastOpenedChestId.toString(16).toUpperCase()}`;

      console.log(`[Opener] Opened ${target.type}: ${shortName} (ID: ${idHex}, Dist: ${target.distance.toFixed(1)})`);
      if (justBanned) {
        console.log(`[Opener] Blacklisted ${target.type}: ${shortName} after ${OPEN_MAX_ATTEMPTS} attempts (won't retry this map)`);
      }
    }
  }
}

function onDraw() {
  // NOTE: Do NOT call POE2Cache.beginFrame() here!
  // It should only be called ONCE per frame in main.js
  
  // Load player settings if not loaded or player changed
  loadPlayerSettings();
  
  // Auto-open runs FIRST, before any window checks (runs even when UI is hidden)
  processAutoOpen();
  
  // Skip UI drawing if UI is hidden (F12 toggle)
  if (!Plugins.isUiVisible()) return;
  
  // Now render the UI window
  ImGui.setNextWindowSize({x: 400, y: 350}, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({x: 1300, y: 10}, ImGui.Cond.FirstUseEver);  // Position after other plugins
  ImGui.setNextWindowCollapsed(true, ImGui.Cond.Once);  // Start collapsed
  
  if (!ImGui.begin("Auto Opener", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Get player for UI display
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) {
    ImGui.textColored([1.0, 0.5, 0.5, 1.0], "Waiting for player...");
    ImGui.end();
    return;
  }
  
  // Header
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Auto Chest/Object Opener");
  ImGui.separator();
  
  // Enable/Disable toggle
  const prevEnabled = enabled.value;
  ImGui.checkbox("Enable Auto-Open", enabled);
  if (prevEnabled !== enabled.value) {
    saveSetting('enabled', enabled.value);
  }
  
  if (enabled.value) {
    ImGui.sameLine();
    ImGui.textColored([0.5, 1.0, 0.5, 1.0], "** ACTIVE **");
  } else {
    ImGui.sameLine();
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "(Disabled)");
  }
  
  ImGui.separator();
  
  // Settings
  ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Settings:");
  
  const prevDist = maxDistance.value;
  ImGui.sliderInt("Max Distance", maxDistance, 20, 200);
  if (prevDist !== maxDistance.value) {
    saveSetting('maxDistance', maxDistance.value);
  }
  
  const prevCooldown = openCooldownMs.value;
  ImGui.sliderInt("Cooldown (ms)", openCooldownMs, 100, 1000);
  if (prevCooldown !== openCooldownMs.value) {
    saveSetting('openCooldownMs', openCooldownMs.value);
  }

  ImGui.text("Visibility Check:");
  const prevVisibilityMode = visibilityMode.value;
  if (ImGui.radioButton("Off##openervis", visibilityMode.value === VISIBILITY_MODE.OFF)) {
    visibilityMode.value = VISIBILITY_MODE.OFF;
  }
  ImGui.sameLine();
  if (ImGui.radioButton("Line of Fire##openervis", visibilityMode.value === VISIBILITY_MODE.LINE_OF_FIRE)) {
    visibilityMode.value = VISIBILITY_MODE.LINE_OF_FIRE;
  }
  ImGui.sameLine();
  if (ImGui.radioButton("Walkable LoS##openervis", visibilityMode.value === VISIBILITY_MODE.LINE_OF_SIGHT)) {
    visibilityMode.value = VISIBILITY_MODE.LINE_OF_SIGHT;
  }
  if (prevVisibilityMode !== visibilityMode.value) {
    saveSetting('visibilityMode', visibilityMode.value);
    visibilityCache.clear();
  }
  if (ImGui.isItemHovered()) {
    ImGui.setTooltip("Off: no visibility check\nLine of Fire: projectile blocking\nWalkable LoS: walkability-based");
  }
  
  ImGui.separator();
  
  // Object type filters
  ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Open:");
  
  const prevStrongboxes = openStrongboxes.value;
  ImGui.checkbox("Strongboxes", openStrongboxes);
  if (prevStrongboxes !== openStrongboxes.value) {
    saveSetting('openStrongboxes', openStrongboxes.value);
  }
  
  ImGui.sameLine();
  const prevNormalChests = openNormalChests.value;
  ImGui.checkbox("Normal Chests", openNormalChests);
  if (prevNormalChests !== openNormalChests.value) {
    saveSetting('openNormalChests', openNormalChests.value);
  }
  
  const prevShrines = openShrines.value;
  ImGui.checkbox("Shrines (targetable)", openShrines);
  if (prevShrines !== openShrines.value) {
    saveSetting('openShrines', openShrines.value);
  }

  ImGui.sameLine();
  const prevEssences = openEssences.value;
  ImGui.checkbox("Essences", openEssences);
  if (prevEssences !== openEssences.value) {
    saveSetting('openEssences', openEssences.value);
  }
  
  const prevDoors = openDoors.value;
  ImGui.checkbox("Doors", openDoors);
  if (prevDoors !== openDoors.value) {
    saveSetting('openDoors', openDoors.value);
  }

  const prevRelay = openPrecursorRelay.value;
  ImGui.checkbox("Precursor Relay", openPrecursorRelay);
  if (prevRelay !== openPrecursorRelay.value) {
    saveSetting('openPrecursorRelay', openPrecursorRelay.value);
  }

  ImGui.separator();
  
  // Name exclusion filter
  ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Exclude by Name:");
  ImGui.textColored([0.6, 0.6, 0.6, 1.0], "(Comma-separated, partial match)");
  
  const prevExcludeNames = excludeChestNames.value;
  ImGui.inputText("##excludenames", excludeChestNames, 256);
  if (prevExcludeNames !== excludeChestNames.value) {
    saveSetting('excludeChestNames', excludeChestNames.value);
  }
  
  ImGui.separator();
  
  // Display options
  const prevShowLast = showLastOpened.value;
  ImGui.checkbox("Show Last Opened", showLastOpened);
  if (prevShowLast !== showLastOpened.value) {
    saveSetting('showLastOpened', showLastOpened.value);
  }
  
  // Status display
  ImGui.separator();
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Status:");
  
  if (enabled.value) {
    const timeSinceLastOpen = Date.now() - lastOpenTime;
    const cooldownRemaining = Math.max(0, openCooldownMs.value - timeSinceLastOpen);
    
    if (cooldownRemaining > 0) {
      ImGui.textColored([1.0, 0.5, 0.0, 1.0], `Cooldown: ${cooldownRemaining}ms`);
    } else {
      ImGui.textColored([0.5, 1.0, 0.5, 1.0], "Ready to open");
    }
    
    // Show last opened chest info
    if (showLastOpened.value && lastOpenedChestName && lastOpenTime > 0) {
      ImGui.separator();
      ImGui.textColored([0.8, 0.8, 1.0, 1.0], "Last Opened:");
      
      const shortName = lastOpenedChestName.split('/').pop() || lastOpenedChestName;
      const idHex = `0x${lastOpenedChestId.toString(16).toUpperCase()}`;
      
      ImGui.text(`  Name: ${shortName}`);
      ImGui.text(`  ID: ${idHex}`);
      ImGui.text(`  Distance: ${lastOpenedChestDistance.toFixed(1)}`);
      
      const timeAgo = ((Date.now() - lastOpenTime) / 1000).toFixed(1);
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], `  (${timeAgo}s ago)`);
    }
  } else {
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "Auto-open is disabled");
  }
  
  // Count nearby targets (for info). Reuses the scan result populated by
  // processAutoOpen so the UI doesn't re-scan the entire entity list per frame.
  // If the cached scan is from this frame, use exact count; otherwise fall back
  // to the last known count (up to ~150ms stale -- cosmetic only).
  if (enabled.value) {
    const targetCount = (cachedScanFrame === POE2Cache.getFrameNumber())
      ? cachedScanTargets.length
      : (cachedScanTargets ? cachedScanTargets.length : 0);
    
    ImGui.separator();
    if (targetCount > 0) {
      ImGui.textColored([1.0, 1.0, 0.5, 1.0], `Targets in range: ${targetCount}`);
    } else {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "No targets in range");
    }
  }
  
  ImGui.end();
}

export const openerPlugin = {
  onDraw: onDraw
};

export { getOpenableCandidatesForMapper, getOpenerCooldownMs, isExcludedByName };

console.log("[Opener] Plugin loaded (using shared POE2Cache)");


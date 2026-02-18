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
const excludeChestNames = new ImGui.MutableVariable(DEFAULT_SETTINGS.excludeChestNames);
const showLastOpened = new ImGui.MutableVariable(DEFAULT_SETTINGS.showLastOpened);

// Auto-open state
let lastOpenTime = 0;
let lastOpenedChestName = "";
let lastOpenedChestId = 0;
let lastOpenedChestDistance = 0;
const visibilityCache = new Map();  // key -> { result, timestamp }
const VISIBILITY_CACHE_TTL = 500;

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

function isShrineEntity(entity) {
  const name = (entity?.name || "").toLowerCase();
  const renderName = (entity?.renderName || "").toLowerCase();
  if (!name && !renderName) return false;

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
  return false;
}

function isEssenceEntity(entity) {
  const name = (entity?.name || "").toLowerCase();
  const renderName = (entity?.renderName || "").toLowerCase();
  if (!name && !renderName) return false;
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

  if (openNormalChests.value || openStrongboxes.value) {
    const chests = POE2Cache.getEntities({ type: "Chest", maxDistance: maxDist });
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
    const nearby = POE2Cache.getEntities({ maxDistance: maxDist });
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
    const nearby = POE2Cache.getEntities({ maxDistance: maxDist });
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
    const nearby = POE2Cache.getEntities({ maxDistance: maxDist });
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
    const allNearby = POE2Cache.getEntities({ maxDistance: maxDist });
    for (const entity of allNearby) {
      if (!entity.gridX || entity.isLocalPlayer) continue;
      if (!entity.id || entity.id === 0) continue;
      if (seenIds.has(entity.id)) continue;
      if (entity.isTargetable !== true) continue;
      if (!isDoorEntity(entity)) continue;
      if (entity.entityType === 'Chest') continue;
      if ((entity.name || "").toLowerCase().includes('shrine')) continue;
      if (isExcludedByName(entity)) continue;

      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!allowBlockedVisibility && !passesVisibilityCheck(player, entity, maxDist)) continue;
      targetsToOpen.push({ entity: entity, distance: dist, type: "Door" });
      seenIds.add(entity.id);
    }
  }

  return targetsToOpen;
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
 * Packet: 01 84 01 20 00 C2 66 04 00 FF 08 [ID: 4 bytes big-endian]
 * Byte 8 = 0x00 for interact/open action
 * 
 * NOTE: This works when not channeling. Game blocks interactions while actively channeling.
 */
function sendOpenPacket(entityId) {
  const packet = new Uint8Array([
    0x01, 0x90, 0x01, 0x20, 0x00, 0xC2, 0x66, 0x04,
    0x00, 0xFF, 0x08,  // 0x00 = interact/open action
    (entityId >> 24) & 0xFF,  // Big endian: MSB first
    (entityId >> 16) & 0xFF,
    (entityId >> 8) & 0xFF,
    entityId & 0xFF           // LSB last
  ]);
  
  return poe2.sendPacket(packet);
}

/**
 * Auto-open logic (runs ALWAYS, even when window is collapsed)
 */
function processAutoOpen() {
  if (!enabled.value) {
    return;
  }
  
  const now = Date.now();
  if (now - lastOpenTime < openCooldownMs.value) {
    return;
  }
  
  const targetsToOpen = collectOpenTargets(maxDistance.value, true);
  
  if (targetsToOpen.length > 0) {
    // Sort by distance (closest first)
    targetsToOpen.sort((a, b) => a.distance - b.distance);
    
    // Open the closest target
    const target = targetsToOpen[0];
    const success = sendOpenPacket(target.entity.id);
    
    if (success) {
      lastOpenedChestName = target.entity.name || "Unknown";
      lastOpenedChestId = target.entity.id;
      lastOpenedChestDistance = target.distance;
      lastOpenTime = now;
      
      // Request movement lock so mapper yields while game auto-walks to open
      POE2Cache.requestMovementLock('opener', 1500);
      
      const shortName = lastOpenedChestName.split('/').pop() || lastOpenedChestName;
      const idHex = `0x${lastOpenedChestId.toString(16).toUpperCase()}`;
      
      console.log(`[Opener] Opened ${target.type}: ${shortName} (ID: ${idHex}, Dist: ${target.distance.toFixed(1)})`);
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
  
  // Count nearby targets (for info) - use same targeted queries
  if (enabled.value) {
    const targetCount = collectOpenTargets(maxDistance.value, true).length;
    
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


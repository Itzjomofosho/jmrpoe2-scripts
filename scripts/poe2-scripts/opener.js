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
  openStrongboxes: false,      // Don't auto-open strongboxes by default (dangerous!)
  openNormalChests: true,      // Open normal chests
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
const openStrongboxes = new ImGui.MutableVariable(DEFAULT_SETTINGS.openStrongboxes);
const openNormalChests = new ImGui.MutableVariable(DEFAULT_SETTINGS.openNormalChests);
const showLastOpened = new ImGui.MutableVariable(DEFAULT_SETTINGS.showLastOpened);

// Auto-open state
let lastOpenTime = 0;
let lastOpenedChestName = "";
let lastOpenedChestId = 0;
let lastOpenedChestDistance = 0;

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
    openStrongboxes.value = currentSettings.openStrongboxes;
    openNormalChests.value = currentSettings.openNormalChests;
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
  currentSettings.openStrongboxes = openStrongboxes.value;
  currentSettings.openNormalChests = openNormalChests.value;
  currentSettings.showLastOpened = showLastOpened.value;
  
  Settings.setMultiple(PLUGIN_NAME, currentSettings);
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
    0x01, 0x84, 0x01, 0x20, 0x00, 0xC2, 0x66, 0x04, 
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
  
  // Use cached player and entities for performance
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) {
    return;
  }
  
  // Get all entities (use distance filter for performance)
  const allEntities = POE2Cache.getEntities(maxDistance.value * 1.2); // Add 20% buffer
  
  // Find unopened chests within range
  const unopenedChests = [];
  
  for (const entity of allEntities) {
    if (!entity.gridX || entity.isLocalPlayer) continue;
    if (entity.entityType !== 'Chest') continue;
    if (entity.chestIsOpened === true) continue;  // Skip opened chests
    if (!entity.id || entity.id === 0) continue;
    
    // Check strongbox/normal chest filters
    if (entity.chestIsStrongbox === true && !openStrongboxes.value) continue;
    if (entity.chestIsStrongbox === false && !openNormalChests.value) continue;
    
    // Calculate distance
    const dx = entity.gridX - player.gridX;
    const dy = entity.gridY - player.gridY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist > maxDistance.value) continue;
    
    unopenedChests.push({ entity: entity, distance: dist });
  }
  
  if (unopenedChests.length > 0) {
    // Sort by distance (closest first)
    unopenedChests.sort((a, b) => a.distance - b.distance);
    
    // Open the closest chest
    const target = unopenedChests[0];
    const success = sendOpenPacket(target.entity.id);
    
    if (success) {
      lastOpenedChestName = target.entity.name || "Unknown";
      lastOpenedChestId = target.entity.id;
      lastOpenedChestDistance = target.distance;
      lastOpenTime = now;
      
      const shortName = lastOpenedChestName.split('/').pop() || lastOpenedChestName;
      const idHex = `0x${lastOpenedChestId.toString(16).toUpperCase()}`;
      const chestType = target.entity.chestIsStrongbox ? "Strongbox" : "Chest";
      
      console.log(`[Opener] Opened ${chestType}: ${shortName} (ID: ${idHex}, Dist: ${target.distance.toFixed(1)})`);
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
  
  ImGui.separator();
  
  // Chest type filters
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
  
  // Count nearby unopened chests (for info)
  if (enabled.value) {
    const allEntities = POE2Cache.getEntities(maxDistance.value * 1.2);
    let unopenedCount = 0;
    
    for (const entity of allEntities) {
      if (!entity.gridX || entity.isLocalPlayer) continue;
      if (entity.entityType !== 'Chest') continue;
      if (entity.chestIsOpened === true) continue;
      if (!entity.id || entity.id === 0) continue;
      
      // Check filters
      if (entity.chestIsStrongbox === true && !openStrongboxes.value) continue;
      if (entity.chestIsStrongbox === false && !openNormalChests.value) continue;
      
      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist <= maxDistance.value) {
        unopenedCount++;
      }
    }
    
    ImGui.separator();
    if (unopenedCount > 0) {
      ImGui.textColored([1.0, 1.0, 0.5, 1.0], `Unopened chests in range: ${unopenedCount}`);
    } else {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "No unopened chests in range");
    }
  }
  
  ImGui.end();
}

export const openerPlugin = {
  onDraw: onDraw
};

console.log("[Opener] Plugin loaded (using shared POE2Cache)");


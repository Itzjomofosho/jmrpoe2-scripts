/**
 * Pickit Plugin
 * 
 * Automatically picks up items based on filters and rules.
 * Uses retry logic with attempt tracking per item ID.
 * Settings are persisted per player.
 * 
 * PERFORMANCE OPTIMIZED: Uses shared POE2Cache for per-frame caching
 * NOTE: Do NOT call POE2Cache.beginFrame() here - it's called once in main.js
 */

import { POE2Cache, poe2 } from './poe2_cache.js';
import { Settings } from './Settings.js';

// Plugin name for settings
const PLUGIN_NAME = 'pickit';

// Default settings
const DEFAULT_SETTINGS = {
  enabled: false,              // Auto-pickup disabled by default (user must opt-in)
  maxDistance: 50,             // Max distance to auto-pickup
  retryDelayMs: 2000,          // Delay between pickup attempts per item (ms)
  maxAttempts: 3,              // Max pickup attempts per item before giving up
  nameFilter: "",              // Filter by name (comma-separated includes)
  excludeFilter: "",           // Exclude by name (comma-separated excludes)
  showLastPickup: true         // Show last pickup attempt info
};

// Current settings (will be loaded from file)
let currentSettings = { ...DEFAULT_SETTINGS };
let currentPlayerName = null;
let settingsLoaded = false;

// Settings - using MutableVariable for ImGui bindings
const enabled = new ImGui.MutableVariable(DEFAULT_SETTINGS.enabled);
const maxDistance = new ImGui.MutableVariable(DEFAULT_SETTINGS.maxDistance);
const retryDelayMs = new ImGui.MutableVariable(DEFAULT_SETTINGS.retryDelayMs);
const maxAttempts = new ImGui.MutableVariable(DEFAULT_SETTINGS.maxAttempts);
const nameFilter = new ImGui.MutableVariable(DEFAULT_SETTINGS.nameFilter);
const excludeFilter = new ImGui.MutableVariable(DEFAULT_SETTINGS.excludeFilter);
const showLastPickup = new ImGui.MutableVariable(DEFAULT_SETTINGS.showLastPickup);

// Pickup attempt tracking
// Map: itemId -> { attempts: number, lastAttemptTime: number, name: string }
let pickupAttempts = new Map();

// Last pickup info for UI
let lastPickupName = "";
let lastPickupId = 0;
let lastPickupDistance = 0;
let lastPickupAttempt = 0;
let lastPickupTime = 0;

// Area tracking for cache flushing
let lastAreaHash = null;

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
    retryDelayMs.value = currentSettings.retryDelayMs;
    maxAttempts.value = currentSettings.maxAttempts;
    nameFilter.value = currentSettings.nameFilter;
    excludeFilter.value = currentSettings.excludeFilter;
    showLastPickup.value = currentSettings.showLastPickup;
    
    console.log(`[Pickit] Loaded settings for player: ${player.playerName}`);
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
  currentSettings.retryDelayMs = retryDelayMs.value;
  currentSettings.maxAttempts = maxAttempts.value;
  currentSettings.nameFilter = nameFilter.value;
  currentSettings.excludeFilter = excludeFilter.value;
  currentSettings.showLastPickup = showLastPickup.value;
  
  Settings.setMultiple(PLUGIN_NAME, currentSettings);
}

/**
 * Check for area change and flush cache if needed
 */
function checkAreaChange() {
  const areaChangeCount = POE2Cache.getAreaChangeCount();
  const newHash = `area_${areaChangeCount}`;
  
  if (lastAreaHash !== newHash) {
    if (lastAreaHash !== null) {
      console.log(`[Pickit] Area changed, flushing pickup attempt cache (${pickupAttempts.size} items)`);
      pickupAttempts.clear();
    }
    lastAreaHash = newHash;
  }
}

/**
 * Clean up cache - remove items that no longer exist or exceeded max attempts
 */
function cleanupCache(currentEntities) {
  const entityIds = new Set(currentEntities.map(e => e.id));
  const toRemove = [];
  
  for (const [itemId, data] of pickupAttempts.entries()) {
    // Remove if item no longer exists
    if (!entityIds.has(itemId)) {
      toRemove.push(itemId);
    }
    // Remove if exceeded max attempts
    else if (data.attempts >= maxAttempts.value) {
      toRemove.push(itemId);
    }
  }
  
  for (const itemId of toRemove) {
    pickupAttempts.delete(itemId);
  }
}

/**
 * Send pickup packet (MoveTo packet - same as opening chests but with 0x02)
 * Packet: 01 84 01 20 00 C2 66 04 02 FF 08 [ID: 4 bytes big-endian]
 */
function sendPickupPacket(entityId) {
  const packet = new Uint8Array([
    0x01, 0x84, 0x01, 0x20, 0x00, 0xC2, 0x66, 0x04, 
    0x02, 0xFF, 0x08,  // 0x02 = MoveTo action
    (entityId >> 24) & 0xFF,  // Big endian: MSB first
    (entityId >> 16) & 0xFF,
    (entityId >> 8) & 0xFF,
    entityId & 0xFF           // LSB last
  ]);
  
  return poe2.sendPacket(packet);
}

/**
 * Check if item name matches include/exclude filters
 */
function matchesNameFilter(itemName) {
  const name = (itemName || "").toLowerCase();
  
  // Check exclude filter first
  if (excludeFilter.value && excludeFilter.value.trim().length > 0) {
    const excludes = excludeFilter.value.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
    for (const exclude of excludes) {
      if (name.includes(exclude)) {
        return false;
      }
    }
  }
  
  // Check include filter
  if (nameFilter.value && nameFilter.value.trim().length > 0) {
    const includes = nameFilter.value.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
    let matched = false;
    for (const include of includes) {
      if (name.includes(include)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  
  return true;
}

/**
 * Check if item should be picked up
 * 
 * Items must have:
 * 1. "WorldItem" in their metadata path (actual pickable items)
 * 2. isTargetable === true (can interact with it)
 * 
 * The game's loot filter hides items from the loot filter, so we only see what's visible.
 */
function shouldPickupItem(entity) {
  // Must have valid name (metadata path)
  if (!entity.name || entity.name.trim().length === 0) {
    return false;
  }
  
  // Must contain "WorldItem" in metadata path (case-insensitive)
  if (!entity.name.toLowerCase().includes('worlditem')) {
    return false;
  }
  
  // Must be targetable (can interact with it)
  if (entity.isTargetable !== true) {
    return false;
  }
  
  // Check name filters (for additional user control)
  if (!matchesNameFilter(entity.name)) {
    return false;
  }
  
  // If we got here, it's a valid pickable item
  return true;
}

/**
 * Auto-pickup logic (runs ALWAYS, even when window is collapsed)
 */
function processAutoPickup() {
  if (!enabled.value) {
    return;
  }
  
  // Check for area change
  checkAreaChange();
  
  const now = Date.now();
  
  // Use cached player and entities for performance
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) {
    return;
  }
  
  // Get all entities (use distance filter for performance)
  const allEntities = POE2Cache.getEntities(maxDistance.value * 1.5); // Add 50% buffer
  
  // Clean up cache periodically (every 60 frames = ~1 second at 60fps)
  if (POE2Cache.getFrameNumber() % 60 === 0) {
    cleanupCache(allEntities);
  }
  
  // Find items to pickup
  const itemsToPickup = [];
  
  for (const entity of allEntities) {
    if (!entity.gridX || entity.isLocalPlayer) continue;
    if (!entity.id || entity.id === 0) continue;
    
    // Check if item should be picked up
    if (!shouldPickupItem(entity)) continue;
    
    // Calculate distance
    const dx = entity.gridX - player.gridX;
    const dy = entity.gridY - player.gridY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist > maxDistance.value) continue;
    
    // Check attempt tracking
    const attemptData = pickupAttempts.get(entity.id);
    
    if (attemptData) {
      // Check if max attempts reached
      if (attemptData.attempts >= maxAttempts.value) {
        continue; // Give up on this item
      }
      
      // Check if retry delay has passed
      if (now - attemptData.lastAttemptTime < retryDelayMs.value) {
        continue; // Too soon to retry
      }
    }
    
    itemsToPickup.push({ entity: entity, distance: dist });
  }
  
  if (itemsToPickup.length > 0) {
    // Sort by distance (closest first)
    itemsToPickup.sort((a, b) => a.distance - b.distance);
    
    // Pickup the closest item
    const target = itemsToPickup[0];
    const itemId = target.entity.id;
    
    // Get or create attempt data
    let attemptData = pickupAttempts.get(itemId);
    if (!attemptData) {
      attemptData = {
        attempts: 0,
        lastAttemptTime: 0,
        name: target.entity.name
      };
      pickupAttempts.set(itemId, attemptData);
    }
    
    // Update tracking and log BEFORE sending packet
    attemptData.attempts++;
    attemptData.lastAttemptTime = now;
    
    // Update UI info
    lastPickupName = target.entity.name || "Unknown";
    lastPickupId = itemId;
    lastPickupDistance = target.distance;
    lastPickupAttempt = attemptData.attempts;
    lastPickupTime = now;
    
    const idHex = `0x${itemId.toString(16).toUpperCase()}`;
    const renderName = target.entity.renderName || "No Render Name";
    
    // Log with full details - show ACTUAL names
    console.log(`[Pickit] Attempt ${attemptData.attempts}/${maxAttempts.value}:`);
    console.log(`  Metadata Path: ${lastPickupName}`);
    console.log(`  Render Name: ${renderName}`);
    console.log(`  ID: ${idHex}, Distance: ${target.distance.toFixed(1)}`);
    
    // Send pickup packet
    sendPickupPacket(itemId);
  }
}

function onDraw() {
  // NOTE: Do NOT call POE2Cache.beginFrame() here!
  // It should only be called ONCE per frame in main.js
  
  // Load player settings if not loaded or player changed
  loadPlayerSettings();
  
  // Auto-pickup runs FIRST, before any window checks (runs even when UI is hidden)
  processAutoPickup();
  
  // Skip UI drawing if UI is hidden (F12 toggle)
  if (!Plugins.isUiVisible()) return;
  
  // Now render the UI window
  ImGui.setNextWindowSize({x: 450, y: 450}, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({x: 1350, y: 370}, ImGui.Cond.FirstUseEver);  // Position after opener
  ImGui.setNextWindowCollapsed(true, ImGui.Cond.Once);  // Start collapsed
  
  if (!ImGui.begin("Auto Pickit", null, ImGui.WindowFlags.None)) {
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
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Auto Item Pickup");
  ImGui.separator();
  
  // Enable/Disable toggle
  const prevEnabled = enabled.value;
  ImGui.checkbox("Enable Auto-Pickup", enabled);
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
  ImGui.sliderInt("Max Distance", maxDistance, 20, 150);
  if (prevDist !== maxDistance.value) {
    saveSetting('maxDistance', maxDistance.value);
  }
  
  const prevRetryDelay = retryDelayMs.value;
  ImGui.sliderInt("Retry Delay (ms)", retryDelayMs, 500, 5000);
  if (prevRetryDelay !== retryDelayMs.value) {
    saveSetting('retryDelayMs', retryDelayMs.value);
  }
  
  const prevMaxAttempts = maxAttempts.value;
  ImGui.sliderInt("Max Attempts", maxAttempts, 1, 10);
  if (prevMaxAttempts !== maxAttempts.value) {
    saveSetting('maxAttempts', maxAttempts.value);
  }
  
  ImGui.separator();
  
  // Info about loot filter
  ImGui.textColored([0.8, 0.8, 1.0, 1.0], "Item Detection:");
  ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Picks up WorldItem entities that are targetable.");
  ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Uses game's loot filter automatically.");
  
  ImGui.separator();
  
  // Name filters
  ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Name Filters:");
  ImGui.textColored([0.6, 0.6, 0.6, 1.0], "(Comma-separated, partial match)");
  
  ImGui.text("Include:");
  ImGui.sameLine();
  const prevNameFilter = nameFilter.value;
  ImGui.inputText("##namefilter", nameFilter, 256);
  if (prevNameFilter !== nameFilter.value) {
    saveSetting('nameFilter', nameFilter.value);
  }
  
  ImGui.text("Exclude:");
  ImGui.sameLine();
  const prevExcludeFilter = excludeFilter.value;
  ImGui.inputText("##excludefilter", excludeFilter, 256);
  if (prevExcludeFilter !== excludeFilter.value) {
    saveSetting('excludeFilter', excludeFilter.value);
  }
  
  ImGui.separator();
  
  // Display options
  const prevShowLast = showLastPickup.value;
  ImGui.checkbox("Show Last Pickup", showLastPickup);
  if (prevShowLast !== showLastPickup.value) {
    saveSetting('showLastPickup', showLastPickup.value);
  }
  
  // Status display
  ImGui.separator();
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Status:");
  
  if (enabled.value) {
    ImGui.text(`Tracked items: ${pickupAttempts.size}`);
    
    // Show last pickup attempt info
    if (showLastPickup.value && lastPickupName && lastPickupTime > 0) {
      ImGui.separator();
      ImGui.textColored([0.8, 0.8, 1.0, 1.0], "Last Pickup Attempt:");
      
      const shortName = lastPickupName.split('/').pop() || lastPickupName;
      const idHex = `0x${lastPickupId.toString(16).toUpperCase()}`;
      
      ImGui.text(`  Name: ${shortName}`);
      ImGui.text(`  ID: ${idHex}`);
      ImGui.text(`  Distance: ${lastPickupDistance.toFixed(1)}`);
      ImGui.text(`  Attempt: ${lastPickupAttempt}/${maxAttempts.value}`);
      
      const timeAgo = ((Date.now() - lastPickupTime) / 1000).toFixed(1);
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], `  (${timeAgo}s ago)`);
    }
  } else {
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "Auto-pickup is disabled");
  }
  
  // Utility buttons
  ImGui.separator();
  if (ImGui.button("Clear Cache", {x: 100, y: 0})) {
    const count = pickupAttempts.size;
    pickupAttempts.clear();
    console.log(`[Pickit] Manually cleared cache (${count} items)`);
  }
  
  ImGui.end();
}

export const pickitPlugin = {
  onDraw: onDraw
};

console.log("[Pickit] Plugin loaded (using shared POE2Cache)");

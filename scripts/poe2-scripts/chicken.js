/**
 * Chicken Plugin - Auto-Disconnect on Low Health
 *
 * Automatically sends disconnect packet when health drops below threshold.
 * Settings are persisted per player in ../data/settings.json
 *
 * PERFORMANCE OPTIMIZED: Uses shared POE2Cache for per-frame caching
 * NOTE: Do NOT call POE2Cache.beginFrame() here - it's called once in main.js
 */

import { Settings } from './Settings.js';
import { POE2Cache, poe2 } from './poe2_cache.js';

// Plugin name for settings
const PLUGIN_NAME = 'chicken';

// Default settings
const DEFAULT_SETTINGS = {
  potionEnabled: true,      // Enable health potion use
  manaPotionEnabled: true, // Enable mana potion use (disabled by default)
  disconnectEnabled: false, // Enable disconnect/exit (disabled by default for safety)
  threshold: 75,            // Health % threshold (default 75%)
  manaThreshold: 30,        // Mana % threshold (default 30%)
  panicThreshold: 20,       // Emergency threshold (20%)
  potionCooldown: 1500,     // 1.5 second cooldown between potion uses
  manaPotionCooldown: 1500, // 1.5 second cooldown between mana potion uses
  exitCooldown: 5000        // 5 second cooldown for exit (safety)
};

// Current settings (loaded from file or defaults)
let currentSettings = { ...DEFAULT_SETTINGS };

// Runtime state (not persisted)
let lastHealthPercent = 100;
let lastManaPercent = 100;
let lastPotionTime = 0;
let lastManaPotionTime = 0;
let lastExitTime = 0;
let currentPlayerName = null;

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
    console.log(`[Chicken] Loaded settings for player: ${player.playerName}`);
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

// Send health potion packet
function useHealthPotion() {
  if (!currentSettings.potionEnabled) return false;  // Potion disabled
  const now = Date.now();
  if (now - lastPotionTime < currentSettings.potionCooldown) return false;  // Still on cooldown
  
  const packet = new Uint8Array([0x00, 0x82, 0x01, 0x00, 0x00, 0x00, 0x00]);
  const success = poe2.sendPacket(packet);
  console.log(`[Chicken] Health potion used at ${currentSettings.threshold}% threshold (success=${success})`);
  lastPotionTime = now;
  return true;
}

// Send mana potion packet
function useManaPotion() {
  if (!currentSettings.manaPotionEnabled) return false;  // Mana potion disabled
  const now = Date.now();
  if (now - lastManaPotionTime < currentSettings.manaPotionCooldown) return false;  // Still on cooldown
  
  const manaPacket = new Uint8Array([0x00, 0x82, 0x01, 0x00, 0x00, 0x00, 0x01]);
  const success = poe2.sendPacket(manaPacket);
  console.log(`[Chicken] Mana potion used at ${currentSettings.manaThreshold}% threshold (success=${success})`);
  lastManaPotionTime = now;
  return true;
}

// Send exit to character select packet
function exitToCharacterSelect() {
  if (!currentSettings.disconnectEnabled) return false;  // Disconnect disabled
  const now = Date.now();
  if (now - lastExitTime < currentSettings.exitCooldown) return false;  // Still on cooldown
  
  const packet = new Uint8Array([0x01, 0x58, 0x00]);
  const success = poe2.sendPacket(packet);
  console.log(`[Chicken] EMERGENCY EXIT at ${currentSettings.panicThreshold}% (success=${success})`);
  lastExitTime = now;
  return true;
}

// Update health and mana monitoring (uses cached player data)
function updateHealth() {
  // Only monitor if at least one feature is enabled
  if (!currentSettings.potionEnabled && !currentSettings.manaPotionEnabled && !currentSettings.disconnectEnabled) return;
  
  try {
    const player = POE2Cache.getLocalPlayer();  // Use cached player
    if (!player || !player.healthMax || player.healthMax <= 0) {
      return;
    }
    
    const healthCurrent = player.healthCurrent || 0;
    const healthMax = player.healthMax;
    const healthPercent = (healthCurrent / healthMax) * 100;
    
    lastHealthPercent = healthPercent;
    
    // Check health thresholds (cooldown is handled inside each function)
    if (healthCurrent > 0) {
      // Emergency threshold (20%) - exit to character select
      if (healthPercent < currentSettings.panicThreshold) {
        exitToCharacterSelect();
      }
      // Normal threshold (configurable, default 75%) - use health potion
      else if (healthPercent < currentSettings.threshold && !POE2Cache.isHealthFlaskActive()) {
        useHealthPotion();
      }
    }
    
    // Check mana thresholds
    if (player.manaMax && player.manaMax > 0) {
      const manaCurrent = player.manaCurrent || 0;
      const manaMax = player.manaMax;
      const manaPercent = (manaCurrent / manaMax) * 100;
      
      lastManaPercent = manaPercent;
      
      // Use mana potion if below threshold
      if (manaPercent < currentSettings.manaThreshold && !POE2Cache.isManaFlaskActive()) {
        useManaPotion();
      }
    }
    
  } catch (e) {
    console.error('[Chicken] Error:', e);
  }
}

// Core logic - always runs
function onDraw() {
  // NOTE: Do NOT call POE2Cache.beginFrame() here!
  // It should only be called ONCE per frame in main.js
  // The cache now detects duplicate calls and warns about them
  
  // Try to load player settings if not loaded or player changed
  loadPlayerSettings();
  
  updateHealth();
}

// Settings UI - only runs when UI is visible (F12 toggle)
function onDrawUI() {
  ImGui.setNextWindowSize({x: 380, y: 550}, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({x: 660, y: 10}, ImGui.Cond.FirstUseEver);  // After Packet Viewer
  ImGui.setNextWindowCollapsed(true, ImGui.Cond.Once);  // Start collapsed (once per session)
  if (!ImGui.begin("Chicken (Auto-Potion/Disconnect)", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Show current player
  if (currentPlayerName) {
    ImGui.textColored([0.5, 0.8, 1.0, 1.0], `Player: ${currentPlayerName}`);
  } else {
    ImGui.textColored([0.5, 0.5, 0.5, 1.0], "Player: Not in game");
  }
  
  ImGui.separator();
  
  // Feature toggles
  ImGui.text("Feature Toggles:");
  
  // Health Potion Enable toggle (Green when ON, Gray when OFF)
  const potionColor = currentSettings.potionEnabled ? [0.2, 0.7, 0.2, 1.0] : [0.5, 0.5, 0.5, 1.0];
  ImGui.pushStyleColor(ImGui.Col.Button, potionColor);
  if (ImGui.button(currentSettings.potionEnabled ? 'Health Potion: ON' : 'Health Potion: OFF', {x: 170, y: 25})) {
    currentSettings.potionEnabled = !currentSettings.potionEnabled;
    saveSetting('potionEnabled', currentSettings.potionEnabled);
    console.log(`[Chicken] Health Potion ${currentSettings.potionEnabled ? 'ENABLED' : 'DISABLED'}`);
  }
  ImGui.popStyleColor(1);
  
  ImGui.sameLine();
  
  // Mana Potion Enable toggle (Blue when ON, Gray when OFF)
  const manaPotionColor = currentSettings.manaPotionEnabled ? [0.2, 0.4, 0.8, 1.0] : [0.5, 0.5, 0.5, 1.0];
  ImGui.pushStyleColor(ImGui.Col.Button, manaPotionColor);
  if (ImGui.button(currentSettings.manaPotionEnabled ? 'Mana Potion: ON' : 'Mana Potion: OFF', {x: 170, y: 25})) {
    currentSettings.manaPotionEnabled = !currentSettings.manaPotionEnabled;
    saveSetting('manaPotionEnabled', currentSettings.manaPotionEnabled);
    console.log(`[Chicken] Mana Potion ${currentSettings.manaPotionEnabled ? 'ENABLED' : 'DISABLED'}`);
  }
  ImGui.popStyleColor(1);
  
  // Disconnect Enable toggle (Red when ON, Gray when OFF)
  const disconnectColor = currentSettings.disconnectEnabled ? [0.8, 0.2, 0.2, 1.0] : [0.5, 0.5, 0.5, 1.0];
  ImGui.pushStyleColor(ImGui.Col.Button, disconnectColor);
  if (ImGui.button(currentSettings.disconnectEnabled ? 'Disconnect: ON' : 'Disconnect: OFF', {x: 350, y: 25})) {
    currentSettings.disconnectEnabled = !currentSettings.disconnectEnabled;
    saveSetting('disconnectEnabled', currentSettings.disconnectEnabled);
    console.log(`[Chicken] Disconnect ${currentSettings.disconnectEnabled ? 'ENABLED' : 'DISABLED'}`);
    // Reset cooldown when disabling
    if (!currentSettings.disconnectEnabled) {
      lastExitTime = 0;
    }
  }
  ImGui.popStyleColor(1);
  
  // Warning when disconnect is enabled
  if (currentSettings.disconnectEnabled) {
    ImGui.textColored([1.0, 0.3, 0.3, 1.0], "WARNING: Auto-disconnect is ON!");
  }
  
  ImGui.separator();
  
  // Current health display (use cached player)
  const player = POE2Cache.getLocalPlayer();
  if (player && player.healthMax > 0) {
    const healthCurrent = player.healthCurrent || 0;
    const healthMax = player.healthMax;
    const healthPercent = (healthCurrent / healthMax) * 100;
    
    ImGui.text(`Current Health: ${healthCurrent}/${healthMax}`);
    ImGui.text(`Health %: ${healthPercent.toFixed(1)}%`);
    
    // Color based on health
    let healthColor = [0.3, 1.0, 0.3, 1.0];  // Green
    if (healthPercent < currentSettings.panicThreshold) {
      healthColor = [1.0, 0.0, 0.0, 1.0];  // Red
    } else if (healthPercent < currentSettings.threshold) {
      healthColor = [1.0, 0.5, 0.0, 1.0];  // Orange
    }
    
    ImGui.textColored(healthColor, `Status: ${healthPercent < currentSettings.panicThreshold ? 'EMERGENCY!' : healthPercent < currentSettings.threshold ? 'DANGER' : 'Safe'}`);
    ImGui.textColored(healthColor, `Health Flask Active: ${POE2Cache.isHealthFlaskActive() ? 'YES' : 'NO'}`);
    
    // Mana display
    if (player.manaMax && player.manaMax > 0) {
      const manaCurrent = player.manaCurrent || 0;
      const manaMax = player.manaMax;
      const manaPercent = (manaCurrent / manaMax) * 100;
      
      ImGui.separator();
      ImGui.text(`Current Mana: ${manaCurrent}/${manaMax}`);
      ImGui.text(`Mana %: ${manaPercent.toFixed(1)}%`);
      
      // Color based on mana
      let manaColor = [0.3, 0.5, 1.0, 1.0];  // Blue
      if (manaPercent < currentSettings.manaThreshold) {
        manaColor = [1.0, 0.5, 0.0, 1.0];  // Orange
      }
      
      ImGui.textColored(manaColor, `Mana Status: ${manaPercent < currentSettings.manaThreshold ? 'LOW' : 'Good'}`);
      ImGui.textColored(manaColor, `Mana Flask Active: ${POE2Cache.isManaFlaskActive() ? 'YES' : 'NO'}`);
    }
  } else {
    ImGui.textColored([0.5, 0.5, 0.5, 1.0], "Not in game or no health data");
  }
  
  ImGui.separator();
  
  // Threshold controls
  ImGui.text(`Potion Threshold: ${currentSettings.threshold}%`);
  ImGui.sameLine();
  if (ImGui.button("-##thresh")) {
    currentSettings.threshold = Math.max(10, currentSettings.threshold - 5);
    saveSetting('threshold', currentSettings.threshold);
  }
  ImGui.sameLine();
  if (ImGui.button("+##thresh")) {
    currentSettings.threshold = Math.min(95, currentSettings.threshold + 5);
    saveSetting('threshold', currentSettings.threshold);
  }
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], `(Use health potion if HP < ${currentSettings.threshold}%)`);
  
  ImGui.separator();
  
  // Mana threshold controls
  ImGui.text(`Mana Potion Threshold: ${currentSettings.manaThreshold}%`);
  ImGui.sameLine();
  if (ImGui.button("-##manathresh")) {
    currentSettings.manaThreshold = Math.max(5, currentSettings.manaThreshold - 5);
    saveSetting('manaThreshold', currentSettings.manaThreshold);
  }
  ImGui.sameLine();
  if (ImGui.button("+##manathresh")) {
    currentSettings.manaThreshold = Math.min(95, currentSettings.manaThreshold + 5);
    saveSetting('manaThreshold', currentSettings.manaThreshold);
  }
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], `(Use mana potion if Mana < ${currentSettings.manaThreshold}%)`);
  
  ImGui.separator();
  
  ImGui.text(`Panic Threshold: ${currentSettings.panicThreshold}%`);
  ImGui.sameLine();
  if (ImGui.button("-##panic")) {
    currentSettings.panicThreshold = Math.max(5, currentSettings.panicThreshold - 5);
    saveSetting('panicThreshold', currentSettings.panicThreshold);
  }
  ImGui.sameLine();
  if (ImGui.button("+##panic")) {
    currentSettings.panicThreshold = Math.min(50, currentSettings.panicThreshold + 5);
    saveSetting('panicThreshold', currentSettings.panicThreshold);
  }
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], `(Emergency disconnect if HP < ${currentSettings.panicThreshold}%)`);
  
  ImGui.separator();
  
  // Cooldown controls
  ImGui.text("Cooldown Settings:");
  
  // Potion cooldown (increments of 100ms)
  ImGui.text(`Potion Cooldown: ${currentSettings.potionCooldown}ms`);
  ImGui.sameLine();
  if (ImGui.button("-##potioncd")) {
    currentSettings.potionCooldown = Math.max(100, currentSettings.potionCooldown - 100);
    saveSetting('potionCooldown', currentSettings.potionCooldown);
  }
  ImGui.sameLine();
  if (ImGui.button("+##potioncd")) {
    currentSettings.potionCooldown = Math.min(10000, currentSettings.potionCooldown + 100);
    saveSetting('potionCooldown', currentSettings.potionCooldown);
  }
  
  // Mana potion cooldown (increments of 100ms)
  ImGui.text(`Mana Potion Cooldown: ${currentSettings.manaPotionCooldown}ms`);
  ImGui.sameLine();
  if (ImGui.button("-##manapotioncd")) {
    currentSettings.manaPotionCooldown = Math.max(100, currentSettings.manaPotionCooldown - 100);
    saveSetting('manaPotionCooldown', currentSettings.manaPotionCooldown);
  }
  ImGui.sameLine();
  if (ImGui.button("+##manapotioncd")) {
    currentSettings.manaPotionCooldown = Math.min(10000, currentSettings.manaPotionCooldown + 100);
    saveSetting('manaPotionCooldown', currentSettings.manaPotionCooldown);
  }
  
  // Exit cooldown (increments of 100ms)
  ImGui.text(`Exit Cooldown: ${currentSettings.exitCooldown}ms`);
  ImGui.sameLine();
  if (ImGui.button("-##exitcd")) {
    currentSettings.exitCooldown = Math.max(100, currentSettings.exitCooldown - 100);
    saveSetting('exitCooldown', currentSettings.exitCooldown);
  }
  ImGui.sameLine();
  if (ImGui.button("+##exitcd")) {
    currentSettings.exitCooldown = Math.min(30000, currentSettings.exitCooldown + 100);
    saveSetting('exitCooldown', currentSettings.exitCooldown);
  }
  
  ImGui.separator();
  
  // Status - show cooldown status
  const now = Date.now();
  const potionOnCooldown = (now - lastPotionTime) < currentSettings.potionCooldown;
  const manaPotionOnCooldown = (now - lastManaPotionTime) < currentSettings.manaPotionCooldown;
  const exitOnCooldown = (now - lastExitTime) < currentSettings.exitCooldown;
  
  if (exitOnCooldown) {
    ImGui.textColored([1.0, 0.0, 0.0, 1.0], "EMERGENCY EXIT TRIGGERED!");
  } else if (potionOnCooldown) {
    ImGui.textColored([1.0, 0.5, 0.0, 1.0], "Health potion used (on cooldown)");
  } else if (manaPotionOnCooldown) {
    ImGui.textColored([0.3, 0.5, 1.0, 1.0], "Mana potion used (on cooldown)");
  } else if (currentSettings.potionEnabled || currentSettings.manaPotionEnabled || currentSettings.disconnectEnabled) {
    ImGui.textColored([0.3, 1.0, 0.3, 1.0], "Monitoring...");
  }
  
  ImGui.separator();
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], `At ${currentSettings.threshold}% HP: Use Health Potion ${currentSettings.potionEnabled ? '' : '(DISABLED)'}`);
  ImGui.textColored([0.5, 0.7, 1.0, 1.0], `At ${currentSettings.manaThreshold}% Mana: Use Mana Potion ${currentSettings.manaPotionEnabled ? '' : '(DISABLED)'}`);
  ImGui.textColored([1.0, 0.3, 0.3, 1.0], `At ${currentSettings.panicThreshold}% HP: EXIT TO CHARACTER SELECT ${currentSettings.disconnectEnabled ? '' : '(DISABLED)'}`);
  
  ImGui.end();
}

// Export plugin
export const chickenPlugin = {
  onDraw: onDraw,
  onDrawUI: onDrawUI
};

console.log("[Chicken] Plugin loaded (using shared POE2Cache)");

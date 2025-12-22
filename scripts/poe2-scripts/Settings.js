/**
 * Settings Manager for POE2 Scripts
 *
 * Provides persistent settings storage per player and plugin.
 * Settings are stored in ../data/settings.json
 *
 * Structure:
 * {
 *   "players": {
 *     "PlayerName": {
 *       "pluginName": {
 *         "settingKey": value
 *       }
 *     }
 *   }
 * }
 */

// POE2 instance for getting local player
const poe2 = new POE2();

// Path to settings file (relative to poe2-scripts folder, goes up to scripts then into data)
const settingsPath = '../../data/settings.json';

// In-memory settings cache
let settings = {
  players: {}
};

// Track if settings have been loaded
let loaded = false;

/**
 * Check if a file exists
 */
function fileExists(path) {
  try {
    fs.access(path, 0);  // F_OK = 0
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Load settings from file
 */
function loadSettings() {
  if (loaded) return;
  
  // Check if file exists first
  if (fileExists(settingsPath)) {
    try {
      const data = fs.readFile(settingsPath);
      if (data) {
        settings = JSON.parse(data);
        console.log('[Settings] Loaded settings from file');
      }
    } catch (error) {
      console.error('[Settings] Error parsing settings file:', error);
    }
  } else {
    // File doesn't exist, create it
    console.log('[Settings] Creating new settings file');
    saveSettings();
  }
  loaded = true;
}

/**
 * Save settings to file
 */
function saveSettings() {
  try {
    fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    console.log('[Settings] Saved successfully');
  } catch (error) {
    console.error('[Settings] Error saving:', error);
  }
}

/**
 * Get settings for a specific player and plugin
 * @param {string} playerName - The player's name
 * @param {string} pluginName - The plugin name (e.g., 'chicken')
 * @param {object} defaults - Default values if no settings exist
 * @returns {object} The settings object for this player/plugin
 */
function getPluginSettings(playerName, pluginName, defaults = {}) {
  loadSettings();
  
  if (!playerName) {
    console.warn('[Settings] No player name provided, returning defaults');
    return { ...defaults };
  }
  
  // Ensure player entry exists
  if (!settings.players[playerName]) {
    settings.players[playerName] = {};
  }
  
  // Ensure plugin entry exists with defaults
  if (!settings.players[playerName][pluginName]) {
    settings.players[playerName][pluginName] = { ...defaults };
    saveSettings();
  } else {
    // Merge with defaults for any missing keys
    let updated = false;
    for (const key in defaults) {
      if (!(key in settings.players[playerName][pluginName])) {
        settings.players[playerName][pluginName][key] = defaults[key];
        updated = true;
      }
    }
    if (updated) {
      saveSettings();
    }
  }
  
  return settings.players[playerName][pluginName];
}

/**
 * Set a specific setting for a player and plugin
 * @param {string} playerName - The player's name
 * @param {string} pluginName - The plugin name
 * @param {string} key - The setting key
 * @param {any} value - The value to set
 */
function setSetting(playerName, pluginName, key, value) {
  loadSettings();
  
  if (!playerName) {
    console.warn('[Settings] No player name provided, cannot save setting');
    return;
  }
  
  // Ensure player entry exists
  if (!settings.players[playerName]) {
    settings.players[playerName] = {};
  }
  
  // Ensure plugin entry exists
  if (!settings.players[playerName][pluginName]) {
    settings.players[playerName][pluginName] = {};
  }
  
  // Set the value
  settings.players[playerName][pluginName][key] = value;
  saveSettings();
}

/**
 * Set multiple settings at once for a player and plugin
 * @param {string} playerName - The player's name
 * @param {string} pluginName - The plugin name
 * @param {object} values - Object with key-value pairs to set
 */
function setSettings(playerName, pluginName, values) {
  loadSettings();
  
  if (!playerName) {
    console.warn('[Settings] No player name provided, cannot save settings');
    return;
  }
  
  // Ensure player entry exists
  if (!settings.players[playerName]) {
    settings.players[playerName] = {};
  }
  
  // Ensure plugin entry exists
  if (!settings.players[playerName][pluginName]) {
    settings.players[playerName][pluginName] = {};
  }
  
  // Set all values
  for (const key in values) {
    settings.players[playerName][pluginName][key] = values[key];
  }
  saveSettings();
}

/**
 * Get all settings (for debugging)
 */
function getAllSettings() {
  loadSettings();
  return settings;
}

/**
 * Get settings for current player and plugin (auto-detects player internally)
 * @param {string} pluginName - The plugin name (e.g., 'chicken')
 * @param {object} defaults - Default values if no settings exist
 * @returns {object} The settings object for this player/plugin
 */
function get(pluginName, defaults = {}) {
  const player = poe2.getLocalPlayer();
  return getPluginSettings(player.playerName, pluginName, defaults);
}

/**
 * Set a setting for current player (auto-detects player internally)
 * @param {string} pluginName - The plugin name
 * @param {string} key - The setting key
 * @param {any} value - The value to set
 */
function set(pluginName, key, value) {
  const player = poe2.getLocalPlayer();
  setSetting(player.playerName, pluginName, key, value);
}

/**
 * Set multiple settings for current player (auto-detects player internally)
 * @param {string} pluginName - The plugin name
 * @param {object} values - Object with key-value pairs to set
 */
function setMultiple(pluginName, values) {
  const player = poe2.getLocalPlayer();
  setSettings(player.playerName, pluginName, values);
}

// Export the settings API
export const Settings = {
  // Auto-detect player versions (preferred)
  get,
  set,
  setMultiple,
  
  // Explicit player versions (for edge cases)
  getPluginSettings,
  setSetting,
  setSettings,
  
  // Utility
  saveSettings,
  loadSettings,
  getAllSettings
};

console.log('[Settings] Settings module loaded');

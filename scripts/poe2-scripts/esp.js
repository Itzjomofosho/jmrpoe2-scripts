/**
 * ESP (Extra Sensory Perception) Plugin v4
 *
 * Per-category rendering with granular control.
 */

import { POE2Cache, poe2 } from './poe2_cache.js';
import { Settings } from './Settings.js';

const PLUGIN_NAME = 'esp';

// Render modes per category
const RENDER = {
  NONE: 0,
  CIRCLE_2D: 1,
  CIRCLE_3D: 2,
  CIRCLE_3D_FILLED: 3,
  BOX_3D: 4,
  BOX_2D: 5,
  DOT: 6,
  HP_BAR_ONLY: 7
};

const RENDER_NAMES = [
  "None", "Circle (2D)", "Circle (3D)", "Circle (3D Filled)",
  "Box (3D)", "Box (2D)", "Dot", "HP Bar Only"
];

// Category definitions
const CATEGORIES = {
  effects: { label: "Effects", defaultColor: [0.8, 0.8, 0.2, 0.7] },
  monsters: { label: "Monsters", defaultColor: [1.0, 0.3, 0.3, 0.9] },
  monstersMagic: { label: "Monsters (Magic)", defaultColor: [0.3, 0.5, 1.0, 0.9] },
  monstersRare: { label: "Monsters (Rare)", defaultColor: [1.0, 0.8, 0.2, 0.9] },
  monstersUnique: { label: "Monsters (Unique)", defaultColor: [1.0, 0.5, 0.0, 0.9] },
  monstersFriendly: { label: "Monsters (Friendly)", defaultColor: [0.2, 0.8, 0.2, 0.7] },
  players: { label: "Players", defaultColor: [0.2, 0.8, 1.0, 0.9] },
  npcs: { label: "NPCs", defaultColor: [0.6, 0.6, 0.9, 0.7] },
  chests: { label: "Chests (Normal)", defaultColor: [0.9, 0.7, 0.2, 0.8] },
  chestsMagic: { label: "Chests (Magic)", defaultColor: [0.3, 0.5, 1.0, 0.9] },
  chestsRare: { label: "Chests (Rare)", defaultColor: [1.0, 0.8, 0.2, 0.9] },
  chestsUnique: { label: "Chests (Unique)", defaultColor: [1.0, 0.5, 0.0, 1.0] },
  strongboxes: { label: "Strongboxes", defaultColor: [1.0, 0.4, 0.1, 1.0] },
  shrines: { label: "Shrines", defaultColor: [0.5, 1.0, 0.5, 0.9] },
  items: { label: "Items", defaultColor: [1.0, 1.0, 1.0, 0.8] },
  other: { label: "Other", defaultColor: [0.5, 0.5, 0.5, 0.5] }
};

// Default category settings
function getDefaultCategorySettings(cat) {
  // Per-category defaults based on tested settings
  const CATEGORY_DEFAULTS = {
    effects: {
      enabled: true, renderMode: RENDER.CIRCLE_3D_FILLED, opacity: 0.1,
      color: [0.8, 0.8, 0.2, 0.27], showName: true, showHealth: false, showES: false, showMana: false, showRage: false,
      showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: false,
      useTerrainHeight: false, groundZOffset: 0, sizeMultiplier: 17.0,
      showLine: false, lineColor: [0.8, 0.8, 0.2, 0.5],
      includeFilter: "chill, frozen, burning, igni, shock, caus", excludeFilter: "",
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    monsters: {
      enabled: true, renderMode: RENDER.HP_BAR_ONLY, opacity: 1.0,
      color: [1.0, 0.3, 0.3, 0.9], showName: true, showHealth: true, showES: true, showMana: true, showRage: false,
      showDistance: false, onlyAlive: true, onlyUnopened: false, onlyTargetable: true,
      useTerrainHeight: true, groundZOffset: 0,
      showLine: false, lineColor: [1.0, 0.3, 0.3, 0.6],
      includeFilter: "", excludeFilter: "",
      colorHP: [1.0, 0.58, 0.49, 0.74], colorES: [1.0, 1.0, 1.0, 0.75], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    monstersMagic: {
      enabled: true, renderMode: RENDER.HP_BAR_ONLY, opacity: 1.0,
      color: [0.3, 0.5, 1.0, 0.9], showName: true, showHealth: true, showES: true, showMana: false, showRage: false,
      showDistance: false, onlyAlive: true, onlyUnopened: false, onlyTargetable: true,
      useTerrainHeight: true, groundZOffset: 0,
      showLine: false, lineColor: [0.3, 0.5, 1.0, 0.7],
      includeFilter: "", excludeFilter: "",
      colorHP: [0.9, 0.27, 0.2, 0.69], colorES: [0.7, 0.82, 0.98, 0.69], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    monstersRare: {
      enabled: true, renderMode: RENDER.HP_BAR_ONLY, opacity: 1.0,
      color: [1.0, 0.8, 0.2, 0.9], showName: true, showHealth: true, showES: true, showMana: false, showRage: false,
      showDistance: false, onlyAlive: true, onlyUnopened: false, onlyTargetable: true,
      useTerrainHeight: true, groundZOffset: 0,
      showLine: true, lineColor: [1.0, 0.8, 0.2, 0.8],
      includeFilter: "", excludeFilter: "",
      colorHP: [0.82, 0.17, 0.17, 0.83], colorES: [0.63, 0.78, 0.98, 0.83], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    monstersUnique: {
      enabled: true, renderMode: RENDER.HP_BAR_ONLY, opacity: 1.0,
      color: [1.0, 0.5, 0.0, 0.9], showName: true, showHealth: true, showES: true, showMana: false, showRage: false,
      showDistance: false, onlyAlive: true, onlyUnopened: false, onlyTargetable: true,
      useTerrainHeight: true, groundZOffset: 0,
      showLine: true, lineColor: [1.0, 0.5, 0.0, 1.0],
      includeFilter: "", excludeFilter: "",
      colorHP: [1.0, 0.0, 0.0, 1.0], colorES: [0.58, 0.75, 0.97, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    monstersFriendly: {
      enabled: false, renderMode: RENDER.HP_BAR_ONLY, opacity: 1.0,
      color: [0.2, 0.8, 0.2, 0.7], showName: true, showHealth: true, showES: false, showMana: false, showRage: false,
      showDistance: false, onlyAlive: true, onlyUnopened: false, onlyTargetable: false,
      useTerrainHeight: true, groundZOffset: 0,
      showLine: false, lineColor: [0.2, 0.8, 0.2, 0.5],
      includeFilter: "", excludeFilter: "",
      colorHP: [0.2, 0.9, 0.2, 0.36], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    players: {
      enabled: false, renderMode: RENDER.HP_BAR_ONLY, opacity: 0.67,
      color: [0.2, 0.8, 1.0, 0.9], showName: true, showHealth: true, showES: true, showMana: true, showRage: true,
      showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: false,
      useTerrainHeight: true, groundZOffset: 0,
      showLine: false, lineColor: [0.2, 0.8, 1.0, 0.6],
      includeFilter: "", excludeFilter: "",
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [1.0, 1.0, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    npcs: {
      enabled: false, renderMode: RENDER.CIRCLE_3D_FILLED, opacity: 0.3,
      color: [0.71, 1.0, 0.33, 0.14], showName: false, showHealth: false, showES: true, showMana: true, showRage: false,
      showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: false,
      useTerrainHeight: true, groundZOffset: 0,
      showLine: false, lineColor: [0.71, 1.0, 0.33, 0.16],
      includeFilter: "", excludeFilter: "",
      colorHP: [0.59, 0.9, 0.2, 0.34], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    chests: {
      enabled: false, renderMode: RENDER.CIRCLE_3D, opacity: 0.14,
      color: [1.0, 1.0, 1.0, 0.9], showName: true, showHealth: false, showES: false, showMana: false, showRage: false,
      showDistance: false, onlyAlive: false, onlyUnopened: true, onlyTargetable: true,
      useTerrainHeight: false, groundZOffset: 0,
      showLine: false, lineColor: [1.0, 1.0, 1.0, 0.4],
      includeFilter: "", excludeFilter: "",
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    chestsMagic: {
      enabled: false, renderMode: RENDER.BOX_3D, opacity: 0.82,
      color: [0.3, 0.5, 1.0, 0.9], showName: true, showHealth: false, showES: false, showMana: false, showRage: false,
      showDistance: false, onlyAlive: false, onlyUnopened: true, onlyTargetable: true,
      useTerrainHeight: false, groundZOffset: 0,
      showLine: true, lineColor: [0.3, 0.5, 1.0, 0.5],
      includeFilter: "", excludeFilter: "",
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    chestsRare: {
      enabled: true, renderMode: RENDER.BOX_3D, opacity: 1.0,
      color: [1.0, 0.8, 0.2, 0.9], showName: true, showHealth: false, showES: false, showMana: false, showRage: false,
      showDistance: false, onlyAlive: false, onlyUnopened: true, onlyTargetable: true,
      useTerrainHeight: false, groundZOffset: 0,
      showLine: true, lineColor: [1.0, 0.8, 0.2, 0.6],
      includeFilter: "", excludeFilter: "",
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    chestsUnique: {
      enabled: true, renderMode: RENDER.BOX_3D, opacity: 1.0,
      color: [1.0, 0.5, 0.0, 1.0], showName: true, showHealth: false, showES: false, showMana: false, showRage: false,
      showDistance: false, onlyAlive: false, onlyUnopened: true, onlyTargetable: true,
      useTerrainHeight: false, groundZOffset: 0,
      showLine: true, lineColor: [1.0, 0.5, 0.0, 0.8],
      includeFilter: "", excludeFilter: "",
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    strongboxes: {
      enabled: true, renderMode: RENDER.CIRCLE_3D_FILLED, opacity: 1.0,
      color: [1.0, 0.4, 0.1, 1.0], showName: true, showHealth: false, showES: false, showMana: false, showRage: false,
      showDistance: false, onlyAlive: false, onlyUnopened: true, onlyTargetable: false,
      useTerrainHeight: true, groundZOffset: 0,
      showLine: true, lineColor: [1.0, 0.4, 0.1, 0.8],
      includeFilter: "", excludeFilter: "",
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    shrines: {
      enabled: false, renderMode: RENDER.CIRCLE_3D, opacity: 1.0,
      color: [0.5, 1.0, 0.5, 0.9], showName: true, showHealth: false, showES: false, showMana: false, showRage: false,
      showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: true,
      useTerrainHeight: true, groundZOffset: 0,
      showLine: false, lineColor: [0.5, 1.0, 0.5, 0.7],
      includeFilter: "", excludeFilter: "",
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    items: {
      enabled: false, renderMode: RENDER.DOT, opacity: 1.0,
      color: [1.0, 1.0, 1.0, 0.8], showName: false, showHealth: false, showES: false, showMana: false, showRage: false,
      showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: false,
      useTerrainHeight: true, groundZOffset: 0,
      showLine: false, lineColor: [1.0, 1.0, 1.0, 0.4],
      includeFilter: "", excludeFilter: "",
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    other: {
      enabled: true, renderMode: RENDER.CIRCLE_3D, opacity: 1.0,
      color: [0.93, 0.0, 1.0, 0.36], showName: true, showHealth: false, showES: false, showMana: false, showRage: false,
      showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: false,
      useTerrainHeight: false, groundZOffset: 0,
      showLine: true, lineColor: [0.93, 0.0, 1.0, 0.35],
      includeFilter: "vaal, breach, incursionpedestalencounter", excludeFilter: "",
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    }
  };
  
  // Return the specific defaults if available, otherwise a generic fallback
  if (CATEGORY_DEFAULTS[cat]) {
    return { ...CATEGORY_DEFAULTS[cat] };
  }
  
  // Fallback for any unknown categories
  return {
    enabled: false, renderMode: RENDER.CIRCLE_3D, opacity: 1.0,
    color: [...CATEGORIES[cat].defaultColor], showName: false, showHealth: false, showES: false, showMana: false, showRage: false,
    showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: false,
    useTerrainHeight: true, groundZOffset: 0,
    colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorRage: [1.0, 0.5, 0.2, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
  };
}

// Build default settings
function buildDefaultSettings() {
  const settings = {
    enabled: true,
    maxDistance: 205,
    
    // Metadata filters (global - per-category filters are preferred)
    includeFilters: "",
    excludeFilters: "",
    filterMode: 0,  // 0=Disabled (use per-category filters instead)
    
    // Visual defaults
    circleRadius: 32,
    circleSegments: 16,
    boxHeight: 80,
    lineThickness: 1,
    useBoundsForSize: true,
    useRotation: true,
    useTerrainHeight: true,
    
    // Health bar settings
    healthBarWidth: 50,
    healthBarHeight: 6,
    colorHealthBar: [0.08, 0.52, 0.08, 0.52],
    colorHealthBarBg: [0.2, 0.2, 0.2, 0.35],
    colorEnergyShield: [0.59, 0.77, 1.0, 0.28],
    colorMana: [0.2, 0.3, 0.9, 0.3],
    
    // Local player overlay (HUD)
    showLocalPlayerBars: true,
    localPlayerBarX: 700,
    localPlayerBarY: 900,
    localPlayerBarWidth: 500,
    localPlayerBarHeight: 10,
    showLocalHP: true,
    showLocalES: true,
    showLocalMana: true,
    
    // Local player world-position bars
    showLocalPlayerWorldBars: true,
    localWorldBarWidth: 60,
    localWorldBarHeight: 8,
    localWorldShowHP: true,
    localWorldShowES: true,
    localWorldShowMana: true,
    localWorldUseTerrainHeight: true,
    localWorldZOffset: 80,
    colorLocalHP: [0.2, 0.9, 0.2, 1.0],
    colorLocalES: [0.59, 0.77, 1.0, 0.28],
    colorLocalMana: [0.2, 0.3, 0.9, 0.3],
    
    // Line ESP settings
    lineEnabled: true,           // Master toggle for line ESP
    espLineThickness: 0.8,       // Line ESP thickness in pixels
    lineFadeStart: 10,           // Distance where fade begins
    lineFadeEnd: 5000,           // Distance where fully faded
    lineStartOffset: 14,         // Offset from player center (avoid clutter)
    lineArrowSize: 13,           // Size of arrow head at end
    lineShowOffscreen: true,     // Show direction lines for offscreen entities
    lineOffscreenLength: 200,    // Length of offscreen indicator lines
    lineStyle: 0,                // 0=Solid, 1=Gradient fade, 2=Dashed
    
    // Per-category settings (will be populated)
    categories: {}
  };
  
  for (const cat of Object.keys(CATEGORIES)) {
    settings.categories[cat] = getDefaultCategorySettings(cat);
  }
  
  return settings;
}

const DEFAULT_SETTINGS = buildDefaultSettings();
let currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let currentPlayerName = null;

// Filter buffers
let includeFilterBuffer = "";
let excludeFilterBuffer = "";
const FILTER_MODE_NAMES = ["Disabled", "Include Only", "Exclude Only", "Include + Exclude"];

// Debug
let debugStats = { total: 0, filtered: 0, drawn: 0, types: {}, errors: [] };
let frameCount = 0;

//=============================================================================
// Settings
//=============================================================================

function loadSettings() {
  const player = POE2Cache.getLocalPlayer();
  if (!player || !player.playerName) return false;
  
  if (currentPlayerName !== player.playerName) {
    currentPlayerName = player.playerName;
    
    // Always start with fresh defaults
    currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    
    // Try to load saved settings
    try {
      const saved = Settings.get(PLUGIN_NAME, null);
      if (saved && typeof saved === 'object') {
        // Merge top-level settings (except categories)
        for (const key of Object.keys(saved)) {
          if (key !== 'categories' && key in DEFAULT_SETTINGS) {
            currentSettings[key] = saved[key];
          }
        }
        // Merge category settings
        if (saved.categories && typeof saved.categories === 'object') {
          for (const cat of Object.keys(CATEGORIES)) {
            if (saved.categories[cat]) {
              currentSettings.categories[cat] = { 
                ...getDefaultCategorySettings(cat), 
                ...saved.categories[cat] 
              };
            }
          }
        }
      }
    } catch (e) {
      console.log(`[ESP] Error loading settings: ${e}`);
    }
    
    includeFilterBuffer = currentSettings.includeFilters || "";
    excludeFilterBuffer = currentSettings.excludeFilters || "";
    console.log(`[ESP] Loaded settings for: ${player.playerName}`);
    console.log(`[ESP] Categories enabled: ${Object.keys(CATEGORIES).filter(c => getCategorySettings(c).enabled).join(', ')}`);
    return true;
  }
  return false;
}

function saveSetting(key, value) {
  currentSettings[key] = value;
  Settings.set(PLUGIN_NAME, key, value);
}

function saveCategorySetting(cat, key, value) {
  if (!currentSettings.categories[cat]) {
    currentSettings.categories[cat] = getDefaultCategorySettings(cat);
  }
  currentSettings.categories[cat][key] = value;
  Settings.set(PLUGIN_NAME, 'categories', currentSettings.categories);
}

function getCategorySettings(cat) {
  return currentSettings.categories[cat] || getDefaultCategorySettings(cat);
}

//=============================================================================
// Filtering
//=============================================================================

function parseFilters(str) {
  if (!str || str.trim() === "") return [];
  return str.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
}

// Get the best name for filtering (prefer specific names over metadata path)
function getFilterableName(entity) {
  // Priority: groundEffectName > playerName > renderName > metadata path
  if (entity.groundEffectName) return entity.groundEffectName.toLowerCase();
  if (entity.playerName) return entity.playerName.toLowerCase();
  if (entity.renderName) return entity.renderName.toLowerCase();
  return (entity.name || "").toLowerCase();
}

function matchesFilter(name, filters) {
  for (const f of filters) {
    if (name.includes(f)) return true;
  }
  return false;
}

// Check if entity matches filters (checks both best name AND metadata path)
function matchesAnyFilter(entity, filters) {
  if (filters.length === 0) return false;
  const bestName = getFilterableName(entity);
  const metadataPath = (entity.name || "").toLowerCase();
  
  for (const f of filters) {
    if (bestName.includes(f) || metadataPath.includes(f)) return true;
  }
  return false;
}

// Check if entity matches filters using ONLY the best name (not metadata path)
function matchesBestNameFilter(entity, filters) {
  if (filters.length === 0) return false;
  const bestName = getFilterableName(entity);
  for (const f of filters) {
    if (bestName.includes(f)) return true;
  }
  return false;
}

// Check if entity passes per-category include/exclude filters
// Include takes priority: if entity matches include, it passes
// Otherwise, if entity matches exclude, it fails
// If no filters set, entity passes
function passesCategoryFilter(entity, catSettings) {
  const includeStr = catSettings.includeFilter || "";
  const excludeStr = catSettings.excludeFilter || "";
  
  // No filters = pass
  if (!includeStr && !excludeStr) return true;
  
  // Parse filters (comma-separated, trimmed, lowercased)
  const includes = includeStr ? includeStr.split(',').map(s => s.trim().toLowerCase()).filter(s => s) : [];
  const excludes = excludeStr ? excludeStr.split(',').map(s => s.trim().toLowerCase()).filter(s => s) : [];
  
  // Get entity name for matching (best name + metadata path)
  const bestName = getFilterableName(entity);
  const metadataPath = (entity.name || "").toLowerCase();
  
  // Include filter takes priority
  if (includes.length > 0) {
    for (const f of includes) {
      if (bestName.includes(f) || metadataPath.includes(f)) return true;
    }
    // Has include filters but didn't match any - fail
    return false;
  }
  
  // Exclude filter (only if no include filter)
  if (excludes.length > 0) {
    for (const f of excludes) {
      if (bestName.includes(f) || metadataPath.includes(f)) return false;
    }
  }
  
  return true;
}

function passesMetadataFilter(entity) {
  const mode = currentSettings.filterMode;
  if (mode === 0) return true;
  
  const inc = parseFilters(currentSettings.includeFilters);
  const exc = parseFilters(currentSettings.excludeFilters);
  
  // Mode 1: Include only
  if (mode === 1) return inc.length === 0 || matchesAnyFilter(entity, inc);
  
  // Mode 2: Exclude only
  if (mode === 2) return exc.length === 0 || !matchesAnyFilter(entity, exc);
  
  // Mode 3: Include + Exclude (smart logic)
  // - If entity has a specific name (groundEffectName), use that for matching
  // - If matches include filter → PASS (include takes precedence)
  // - If matches exclude filter (and didn't match include) → FAIL
  // - Otherwise → PASS
  if (mode === 3) {
    const hasSpecificName = !!entity.groundEffectName || !!entity.playerName || !!entity.renderName;
    
    // Check include using best name first
    if (inc.length > 0) {
      if (matchesBestNameFilter(entity, inc)) {
        return true;  // Include match takes precedence!
      }
      // If we have include filters but entity doesn't match, and no specific name, fail
      if (!hasSpecificName && !matchesAnyFilter(entity, inc)) {
        return false;
      }
    }
    
    // Check exclude - for entities with specific names, only check the specific name
    // For generic entities, check the metadata path too
    if (exc.length > 0) {
      if (hasSpecificName) {
        // Only exclude if the SPECIFIC name matches exclude (not metadata path)
        if (matchesBestNameFilter(entity, exc)) {
          return false;
        }
      } else {
        // No specific name - check metadata path for exclusion
        if (matchesAnyFilter(entity, exc)) {
          return false;
        }
      }
    }
    
    return true;
  }
  
  return true;
}

function isEffect(entity) {
  const path = (entity.name || "").toLowerCase();  // entity.name is metadata path
  return path.includes('effect') || path.includes('projectile');
}

// Get display name for entity (same priority as entity_explorer)
function getEntityDisplayName(entity) {
  // For effects, prefer groundEffectName from GroundEffect component
  if (entity.groundEffectName) return entity.groundEffectName;
  if (entity.playerName) return entity.playerName;
  if (entity.renderName) return entity.renderName;
  if (entity.name) {
    const parts = entity.name.split('/');
    return parts[parts.length - 1] || entity.name;
  }
  return '?';
}

function getEntityCategory(entity) {
  if (isEffect(entity)) return 'effects';
  
  switch (entity.entityType) {
    case 'Monster':
      if (entity.entitySubtype === 'MonsterFriendly') return 'monstersFriendly';
      switch (entity.rarity) {
        case 3: return 'monstersUnique';
        case 2: return 'monstersRare';
        case 1: return 'monstersMagic';
        default: return 'monsters';
      }
    case 'Player': return 'players';
    case 'NPC': return 'npcs';
    case 'Chest':
      // Strongbox check first
      if (entity.chestIsStrongbox) return 'strongboxes';
      // Then by rarity
      switch (entity.rarity) {
        case 3: return 'chestsUnique';
        case 2: return 'chestsRare';
        case 1: return 'chestsMagic';
        default: return 'chests';
      }
    case 'Shrine': return 'shrines';
    case 'Item': return 'items';
    default: return 'other';
  }
}

function shouldDrawEntity(entity, player) {
  if (!entity || !entity.worldX) return false;
  if (entity.isLocalPlayer || entity.address === player.address) return false;
  
  // Distance
  if (entity.gridX && player.gridX) {
    const dx = entity.gridX - player.gridX;
    const dy = entity.gridY - player.gridY;
    if (dx * dx + dy * dy > currentSettings.maxDistance * currentSettings.maxDistance) return false;
  }
  
  if (!passesMetadataFilter(entity)) return false;
  
  const cat = getEntityCategory(entity);
  const catSettings = getCategorySettings(cat);
  
  if (!catSettings.enabled) return false;
  if (catSettings.renderMode === RENDER.NONE) return false;
  if (catSettings.onlyAlive && !entity.isAlive) return false;
  
  // Chest filters: only unopened
  if (catSettings.onlyUnopened && entity.chestIsOpened === true) return false;
  
  // Targetable filter
  if (catSettings.onlyTargetable && entity.isTargetable === false) return false;
  
  return true;
}

//=============================================================================
// Drawing Utils
//=============================================================================

function w2s(x, y, z) {
  const r = poe2.worldToScreen(x, y, z);
  if (!r || r.x < -500 || r.x > 2500 || r.y < -500 || r.y > 1800) return null;
  return r;
}

function colorToU32(rgba, opacityMult = 1.0) {
  const a = (rgba[3] || 1.0) * opacityMult;
  return ImGui.colorConvertFloat4ToU32([rgba[0], rgba[1], rgba[2], a]);
}

function rotatePoint(x, y, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: x * c - y * s, y: x * s + y * c };
}

//=============================================================================
// 3D Shapes
//=============================================================================

// Get the Z coordinate to use for an entity (terrain height for ground level)
function getEntityZ(entity, catSettings = null) {
  const useTerrain = catSettings ? catSettings.useTerrainHeight : currentSettings.useTerrainHeight;
  const zOffset = catSettings ? (catSettings.groundZOffset || 0) : 0;
  
  let baseZ;
  
  if (useTerrain && typeof entity.terrainHeight === 'number') {
    // Use terrain height for ground-level rendering (0 is valid!)
    baseZ = entity.terrainHeight;
  } else {
    // Use entity's world Z directly
    baseZ = entity.worldZ || 0;
  }
  
  return baseZ + zOffset;
}

// Check if entity is a ground effect (name contains "Ground")
function isGroundEffect(entity) {
  const name = entity.groundEffectName || entity.renderName || entity.name || "";
  return name.toLowerCase().includes("ground");
}

// Get automatic color for ground effects based on type
// Alpha here is the BASE alpha - it gets multiplied by the category opacity setting
function getGroundEffectColor(entity, catSettings = null) {
  const name = (entity.groundEffectName || entity.renderName || entity.name || "").toLowerCase();
  
  // Use category color's alpha as base, default to 0.5 for ground effects
  const baseAlpha = catSettings?.color?.[3] ?? 0.5;
  
  if (name.includes("chill")) {
    return [0.0, 0.75, 1.0, baseAlpha];  // Light blue for Chilled
  } else if (name.includes("burn") || name.includes("fire") || name.includes("ignit")) {
    return [1.0, 0.5, 0.0, baseAlpha];   // Orange for Burning/Ignited
  } else if (name.includes("shock") || name.includes("lightning")) {
    return [1.0, 1.0, 0.0, baseAlpha];   // Yellow for Shocked
  } else if (name.includes("poison") || name.includes("caustic")) {
    return [0.0, 0.8, 0.2, baseAlpha];   // Green for Poison
  } else if (name.includes("consecrat")) {
    return [1.0, 1.0, 1.0, baseAlpha];   // White for Consecrated
  } else if (name.includes("desecrat")) {
    return [0.5, 0.0, 0.5, baseAlpha];   // Purple for Desecrated
  }
  return null;  // No override, use default color
}

function draw3DCircle(dl, entity, color, opacity, filled = false, catSettings = null) {
  const wx = entity.worldX, wy = entity.worldY, wz = getEntityZ(entity, catSettings);
  // Only apply size multiplier for ground effects
  const sizeMultiplier = isGroundEffect(entity) ? (catSettings?.sizeMultiplier || 1.0) : 1.0;
  let radius = currentSettings.useBoundsForSize && entity.boundsX > 0
    ? Math.max(entity.boundsX, entity.boundsY) / 2 : currentSettings.circleRadius;
  radius *= sizeMultiplier;
  
  const segments = currentSettings.circleSegments;
  const rot = currentSettings.useRotation ? (entity.rotationZ || 0) : 0;
  
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const ang = (i / segments) * Math.PI * 2 + rot;
    const s = w2s(wx + Math.cos(ang) * radius, wy + Math.sin(ang) * radius, wz);
    if (s) pts.push(s);
  }
  
  if (pts.length < 3) return null;
  const col = colorToU32(color, opacity);
  
  if (filled) {
    // Use path API for clean filled polygon without center lines
    dl.pathClear();
    for (const p of pts) {
      dl.pathLineTo(p);
    }
    dl.pathFillConvex(col);
  } else {
    for (let i = 0; i < pts.length; i++) {
      dl.addLine(pts[i], pts[(i + 1) % pts.length], col, currentSettings.lineThickness);
    }
  }
  
  return w2s(wx, wy, wz + (entity.boundsZ || currentSettings.boxHeight));
}

function draw3DBox(dl, entity, color, opacity, catSettings = null) {
  const wx = entity.worldX, wy = entity.worldY, wz = getEntityZ(entity, catSettings);
  // Only apply size multiplier for ground effects
  const sizeMultiplier = isGroundEffect(entity) ? (catSettings?.sizeMultiplier || 1.0) : 1.0;
  const hw = (currentSettings.useBoundsForSize && entity.boundsX > 0 ? entity.boundsX / 2 : 15) * sizeMultiplier;
  const hd = (currentSettings.useBoundsForSize && entity.boundsY > 0 ? entity.boundsY / 2 : 15) * sizeMultiplier;
  const h = (currentSettings.useBoundsForSize && entity.boundsZ > 0 ? entity.boundsZ : currentSettings.boxHeight) * sizeMultiplier;
  const rot = currentSettings.useRotation ? (entity.rotationZ || 0) : 0;
  
  const corners = [{ x: -hw, y: -hd }, { x: hw, y: -hd }, { x: hw, y: hd }, { x: -hw, y: hd }];
  const bottom = [], top = [];
  
  for (const c of corners) {
    const r = rotatePoint(c.x, c.y, rot);
    bottom.push(w2s(wx + r.x, wy + r.y, wz));
    top.push(w2s(wx + r.x, wy + r.y, wz + h));
  }
  
  const col = colorToU32(color, opacity);
  const thick = currentSettings.lineThickness;
  
  for (let i = 0; i < 4; i++) {
    if (bottom[i] && bottom[(i + 1) % 4]) dl.addLine(bottom[i], bottom[(i + 1) % 4], col, thick);
    if (top[i] && top[(i + 1) % 4]) dl.addLine(top[i], top[(i + 1) % 4], col, thick);
    if (bottom[i] && top[i]) dl.addLine(bottom[i], top[i], col, thick);
  }
  
  return top.find(t => t) || bottom.find(b => b);
}

function draw2DCircle(dl, pos, entity, color, opacity) {
  let r = currentSettings.circleRadius;
  if (currentSettings.useBoundsForSize && entity.boundsZ > 0) {
    r = Math.max(8, Math.min(50, entity.boundsZ * 0.4));
  }
  dl.addCircle(pos, r, colorToU32(color, opacity), 16, currentSettings.lineThickness);
  return { x: pos.x, y: pos.y - r - 5 };
}

function draw2DBox(dl, pos, entity, color, opacity) {
  let w = currentSettings.circleRadius * 2;
  let h = currentSettings.useBoundsForSize && entity.boundsZ > 0 
    ? Math.max(30, Math.min(150, entity.boundsZ * 1.5)) : currentSettings.boxHeight;
  
  dl.addRect({ x: pos.x - w / 2, y: pos.y - h }, { x: pos.x + w / 2, y: pos.y }, 
    colorToU32(color, opacity), 0, 0, currentSettings.lineThickness);
  return { x: pos.x, y: pos.y - h - 5 };
}

function drawDot(dl, pos, color, opacity) {
  dl.addCircleFilled(pos, 5, colorToU32(color, opacity), 8);
  return { x: pos.x, y: pos.y - 10 };
}

//=============================================================================
// Line ESP - Direction lines from player to entities
//=============================================================================

function drawLineToEntity(dl, player, entity, catSettings) {
  if (!currentSettings.lineEnabled || !catSettings.showLine) return;
  
  const lineColor = catSettings.lineColor || catSettings.color;
  const playerPos = w2s(player.worldX, player.worldY, player.worldZ || player.terrainHeight || 0);
  if (!playerPos) return;
  
  // Get screen dimensions for offscreen detection
  const screenW = 1920;  // TODO: Get actual screen size
  const screenH = 1080;
  const margin = 50;
  
  // Get entity position
  const entityZ = getEntityZ(entity, catSettings);
  const entityScreenPos = w2s(entity.worldX, entity.worldY, entityZ);
  
  // Calculate world distance
  const dx = entity.worldX - player.worldX;
  const dy = entity.worldY - player.worldY;
  const worldDist = Math.sqrt(dx * dx + dy * dy);
  
  // Calculate fade based on distance
  const fadeStart = currentSettings.lineFadeStart;
  const fadeEnd = currentSettings.lineFadeEnd;
  let fadeMult = 1.0;
  if (worldDist > fadeStart) {
    fadeMult = Math.max(0, 1.0 - (worldDist - fadeStart) / (fadeEnd - fadeStart));
  }
  if (fadeMult <= 0.01) return;
  
  const thickness = currentSettings.espLineThickness || 1.5;
  const startOffset = currentSettings.lineStartOffset;
  
  // Determine if entity is offscreen
  const isOffscreen = !entityScreenPos || 
    entityScreenPos.x < margin || entityScreenPos.x > screenW - margin ||
    entityScreenPos.y < margin || entityScreenPos.y > screenH - margin;
  
  if (isOffscreen && currentSettings.lineShowOffscreen) {
    // Draw direction indicator towards offscreen entity
    const angle = Math.atan2(dy, dx);
    const lineLen = currentSettings.lineOffscreenLength;
    
    // Calculate screen-space direction from player
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    
    // Project a point in that direction to get screen direction
    const testDist = 50;
    const testWorld = w2s(
      player.worldX + dirX * testDist,
      player.worldY + dirY * testDist,
      player.worldZ || player.terrainHeight || 0
    );
    
    if (testWorld && playerPos) {
      const screenDirX = testWorld.x - playerPos.x;
      const screenDirY = testWorld.y - playerPos.y;
      const screenDirLen = Math.sqrt(screenDirX * screenDirX + screenDirY * screenDirY);
      
      if (screenDirLen > 0) {
        const normX = screenDirX / screenDirLen;
        const normY = screenDirY / screenDirLen;
        
        const startX = playerPos.x + normX * startOffset;
        const startY = playerPos.y + normY * startOffset;
        const endX = playerPos.x + normX * (startOffset + lineLen);
        const endY = playerPos.y + normY * (startOffset + lineLen);
        
        const col = colorToU32(lineColor, fadeMult);
        
        // Draw main line
        dl.addLine({ x: startX, y: startY }, { x: endX, y: endY }, col, thickness);
        
        // Draw arrow head
        const arrowSize = currentSettings.lineArrowSize;
        const arrowAngle = 0.5;  // ~30 degrees
        const ax1 = endX - normX * arrowSize + normY * arrowSize * arrowAngle;
        const ay1 = endY - normY * arrowSize - normX * arrowSize * arrowAngle;
        const ax2 = endX - normX * arrowSize - normY * arrowSize * arrowAngle;
        const ay2 = endY - normY * arrowSize + normX * arrowSize * arrowAngle;
        
        dl.addLine({ x: endX, y: endY }, { x: ax1, y: ay1 }, col, thickness);
        dl.addLine({ x: endX, y: endY }, { x: ax2, y: ay2 }, col, thickness);
        
        // Draw distance text near arrow
        const distText = Math.round(worldDist).toString();
        dl.addText(distText, { x: endX + 10, y: endY - 5 }, col);
      }
    }
  } else if (entityScreenPos) {
    // Entity is on screen - draw line from player to entity
    const sdx = entityScreenPos.x - playerPos.x;
    const sdy = entityScreenPos.y - playerPos.y;
    const screenDist = Math.sqrt(sdx * sdx + sdy * sdy);
    
    if (screenDist > startOffset + 10) {
      const normX = sdx / screenDist;
      const normY = sdy / screenDist;
      
      const startX = playerPos.x + normX * startOffset;
      const startY = playerPos.y + normY * startOffset;
      
      const col = colorToU32(lineColor, fadeMult);
      
      if (currentSettings.lineStyle === 1) {
        // Gradient fade style - draw multiple segments with fading alpha
        const segments = 8;
        for (let i = 0; i < segments; i++) {
          const t1 = i / segments;
          const t2 = (i + 1) / segments;
          const x1 = startX + (entityScreenPos.x - startX) * t1;
          const y1 = startY + (entityScreenPos.y - startY) * t1;
          const x2 = startX + (entityScreenPos.x - startX) * t2;
          const y2 = startY + (entityScreenPos.y - startY) * t2;
          const segAlpha = 1.0 - t1 * 0.7;  // Fade towards entity
          const segCol = colorToU32(lineColor, fadeMult * segAlpha);
          dl.addLine({ x: x1, y: y1 }, { x: x2, y: y2 }, segCol, thickness);
        }
      } else if (currentSettings.lineStyle === 2) {
        // Dashed style
        const dashLen = 10;
        const gapLen = 5;
        let pos = 0;
        let drawing = true;
        while (pos < screenDist - startOffset) {
          const len = drawing ? dashLen : gapLen;
          const nextPos = Math.min(pos + len, screenDist - startOffset);
          if (drawing) {
            const x1 = startX + normX * pos;
            const y1 = startY + normY * pos;
            const x2 = startX + normX * nextPos;
            const y2 = startY + normY * nextPos;
            dl.addLine({ x: x1, y: y1 }, { x: x2, y: y2 }, col, thickness);
          }
          pos = nextPos;
          drawing = !drawing;
        }
      } else {
        // Solid line
        dl.addLine({ x: startX, y: startY }, entityScreenPos, col, thickness);
      }
    }
  }
}

//=============================================================================
// Health Bars
//=============================================================================

// Draw resource bars for an entity using per-category colors
// ES overlays on HP (damage hits ES first, then HP)
function drawEntityBars(dl, x, y, w, h, entity, catSettings) {
  let currentY = y;
  const barSpacing = 2;
  
  // HP Bar with ES overlay
  if (catSettings.showHealth && entity.healthMax > 0) {
    const hpPct = Math.min(1, (entity.healthCurrent || 0) / entity.healthMax);
    
    // Background
    dl.addRectFilled({ x, y: currentY }, { x: x + w, y: currentY + h }, colorToU32(catSettings.colorBarBg));
    
    // HP fill
    dl.addRectFilled({ x, y: currentY }, { x: x + w * hpPct, y: currentY + h }, colorToU32(catSettings.colorHP));
    
    // ES overlay on top of HP (if enabled and has ES)
    if (catSettings.showES && entity.esMax > 0 && entity.esCurrent > 0) {
      const esPct = Math.min(1, entity.esCurrent / entity.esMax);
      // ES overlays the full bar width based on ES percentage
      // Use ES color with reduced opacity for overlay effect
      const esColor = [...catSettings.colorES];
      esColor[3] = (esColor[3] || 1.0) * 0.7;  // 70% opacity overlay
      dl.addRectFilled({ x, y: currentY }, { x: x + w * esPct, y: currentY + h }, colorToU32(esColor));
    }
    
    // Border
    dl.addRect({ x, y: currentY }, { x: x + w, y: currentY + h }, colorToU32([0.3, 0.3, 0.3, 1]), 0, 0, 1);
    currentY += h + barSpacing;
  } else if (catSettings.showES && entity.esMax > 0) {
    // ES-only bar (no HP shown, just ES)
    const esPct = Math.min(1, (entity.esCurrent || 0) / entity.esMax);
    dl.addRectFilled({ x, y: currentY }, { x: x + w, y: currentY + h }, colorToU32(catSettings.colorBarBg));
    dl.addRectFilled({ x, y: currentY }, { x: x + w * esPct, y: currentY + h }, colorToU32(catSettings.colorES));
    dl.addRect({ x, y: currentY }, { x: x + w, y: currentY + h }, colorToU32([0.3, 0.3, 0.3, 1]), 0, 0, 1);
    currentY += h + barSpacing;
  }
  
  // Mana Bar (separate, below HP/ES)
  if (catSettings.showMana && entity.manaMax > 0) {
    const manaPct = Math.min(1, (entity.manaCurrent || 0) / entity.manaMax);
    const manaH = h * 0.6;  // Slightly smaller
    dl.addRectFilled({ x, y: currentY }, { x: x + w, y: currentY + manaH }, colorToU32(catSettings.colorBarBg));
    dl.addRectFilled({ x, y: currentY }, { x: x + w * manaPct, y: currentY + manaH }, colorToU32(catSettings.colorMana));
    dl.addRect({ x, y: currentY }, { x: x + w, y: currentY + manaH }, colorToU32([0.3, 0.3, 0.3, 1]), 0, 0, 1);
    currentY += manaH + barSpacing;
  }
  
  // Rage Bar (separate, below Mana)
  if (catSettings.showRage && entity.rageMax > 0) {
    const ragePct = Math.min(1, (entity.rageCurrent || 0) / entity.rageMax);
    const rageH = h * 0.6;  // Slightly smaller
    dl.addRectFilled({ x, y: currentY }, { x: x + w, y: currentY + rageH }, colorToU32(catSettings.colorBarBg));
    dl.addRectFilled({ x, y: currentY }, { x: x + w * ragePct, y: currentY + rageH }, colorToU32(catSettings.colorRage || [1.0, 0.5, 0.2, 1.0]));
    dl.addRect({ x, y: currentY }, { x: x + w, y: currentY + rageH }, colorToU32([0.3, 0.3, 0.3, 1]), 0, 0, 1);
    currentY += rageH + barSpacing;
  }
  
  return currentY;
}

//=============================================================================
// Entity ESP
//=============================================================================

function drawEntityESP(entity, player, dl) {
  const cat = getEntityCategory(entity);
  const catSettings = getCategorySettings(cat);
  
  // Use automatic ground effect color if available, otherwise use category color
  // Ground effect colors inherit the category color's alpha for consistency
  const groundColor = getGroundEffectColor(entity, catSettings);
  const color = groundColor || catSettings.color;
  const opacity = catSettings.opacity;
  const mode = catSettings.renderMode;
  
  // Use per-category terrain height setting
  const wz = getEntityZ(entity, catSettings);
  const screenPos = w2s(entity.worldX, entity.worldY, wz);
  if (!screenPos) {
    debugStats.errors.push(`W2S fail: ${getEntityDisplayName(entity)}`);
    return;
  }
  
  let labelPos = screenPos;
  
  // Draw shape based on render mode
  switch (mode) {
    case RENDER.CIRCLE_3D:
      labelPos = draw3DCircle(dl, entity, color, opacity, false, catSettings) || screenPos;
      break;
    case RENDER.CIRCLE_3D_FILLED:
      labelPos = draw3DCircle(dl, entity, color, opacity, true, catSettings) || screenPos;
      break;
    case RENDER.BOX_3D:
      labelPos = draw3DBox(dl, entity, color, opacity, catSettings) || screenPos;
      break;
    case RENDER.BOX_2D:
      labelPos = draw2DBox(dl, screenPos, entity, color, opacity);
      break;
    case RENDER.CIRCLE_2D:
      labelPos = draw2DCircle(dl, screenPos, entity, color, opacity);
      break;
    case RENDER.DOT:
      labelPos = drawDot(dl, screenPos, color, opacity);
      break;
    case RENDER.HP_BAR_ONLY:
      // Just position for HP bar
      labelPos = { x: screenPos.x, y: screenPos.y - 20 };
      break;
  }
  
  // Resource bars (HP/ES/Mana/Rage) using per-category colors
  const hasBars = catSettings.showHealth || catSettings.showES || catSettings.showMana || catSettings.showRage;
  if (hasBars && (entity.healthMax > 0 || entity.esMax > 0 || entity.manaMax > 0 || entity.rageMax > 0)) {
    const barW = currentSettings.healthBarWidth;
    const barH = currentSettings.healthBarHeight;
    const barX = screenPos.x - barW / 2;
    const barY = labelPos.y - barH - 2;
    const newY = drawEntityBars(dl, barX, barY, barW, barH, entity, catSettings);
    labelPos = { x: labelPos.x, y: barY - 2 };
  }
  
  // Name
  if (catSettings.showName) {
    const name = getEntityDisplayName(entity);
    const textX = screenPos.x - name.length * 3;
    dl.addText(name, { x: textX, y: labelPos.y - 14 }, colorToU32([1, 1, 1, 1]));
  }
  
  // Distance
  if (catSettings.showDistance && player.gridX) {
    const dx = entity.gridX - player.gridX;
    const dy = entity.gridY - player.gridY;
    const dist = Math.sqrt(dx * dx + dy * dy).toFixed(0);
    dl.addText(dist, { x: screenPos.x + 30, y: screenPos.y }, colorToU32([0.7, 0.7, 0.7, 1]));
  }
  
  debugStats.drawn++;
}

// Optimized version that takes pre-computed catSettings to avoid repeated lookups
function drawEntityESPFast(entity, player, dl, catSettings) {
  // Use automatic ground effect color if available, otherwise use category color
  const groundColor = getGroundEffectColor(entity, catSettings);
  const color = groundColor || catSettings.color;
  const opacity = catSettings.opacity;
  const mode = catSettings.renderMode;
  
  // Use per-category terrain height setting
  const wz = getEntityZ(entity, catSettings);
  const screenPos = w2s(entity.worldX, entity.worldY, wz);
  if (!screenPos) return;
  
  let labelPos = screenPos;
  
  // Draw shape based on render mode
  switch (mode) {
    case RENDER.CIRCLE_3D:
      labelPos = draw3DCircle(dl, entity, color, opacity, false, catSettings) || screenPos;
      break;
    case RENDER.CIRCLE_3D_FILLED:
      labelPos = draw3DCircle(dl, entity, color, opacity, true, catSettings) || screenPos;
      break;
    case RENDER.BOX_3D:
      labelPos = draw3DBox(dl, entity, color, opacity, catSettings) || screenPos;
      break;
    case RENDER.BOX_2D:
      labelPos = draw2DBox(dl, screenPos, entity, color, opacity);
      break;
    case RENDER.CIRCLE_2D:
      labelPos = draw2DCircle(dl, screenPos, entity, color, opacity);
      break;
    case RENDER.DOT:
      labelPos = drawDot(dl, screenPos, color, opacity);
      break;
    case RENDER.HP_BAR_ONLY:
      labelPos = { x: screenPos.x, y: screenPos.y - 20 };
      break;
  }
  
  // Resource bars (HP/ES/Mana/Rage) using per-category colors
  const hasBars = catSettings.showHealth || catSettings.showES || catSettings.showMana || catSettings.showRage;
  if (hasBars && (entity.healthMax > 0 || entity.esMax > 0 || entity.manaMax > 0 || entity.rageMax > 0)) {
    const barW = currentSettings.healthBarWidth;
    const barH = currentSettings.healthBarHeight;
    const barX = screenPos.x - barW / 2;
    const barY = labelPos.y - barH - 2;
    drawEntityBars(dl, barX, barY, barW, barH, entity, catSettings);
    labelPos = { x: labelPos.x, y: barY - 2 };
  }
  
  // Name
  if (catSettings.showName) {
    const name = getEntityDisplayName(entity);
    const textX = screenPos.x - name.length * 3;
    dl.addText(name, { x: textX, y: labelPos.y - 14 }, colorToU32([1, 1, 1, 1]));
  }
  
  // Distance
  if (catSettings.showDistance && player.gridX) {
    const dx = entity.gridX - player.gridX;
    const dy = entity.gridY - player.gridY;
    const dist = Math.sqrt(dx * dx + dy * dy).toFixed(0);
    dl.addText(dist, { x: screenPos.x + 30, y: screenPos.y }, colorToU32([0.7, 0.7, 0.7, 1]));
  }
}

//=============================================================================
// Local Player Bars
//=============================================================================

// Draw text with shadow for better contrast
function drawTextWithShadow(dl, text, x, y, color) {
  dl.addText(text, { x: x + 1, y: y + 1 }, colorToU32([0, 0, 0, 0.8]));  // Shadow
  dl.addText(text, { x: x, y: y }, colorToU32(color));
}

// Screen-position local player bars (HUD style)
function drawLocalPlayerBars(player, dl) {
  if (!currentSettings.showLocalPlayerBars) return;
  
  let x = currentSettings.localPlayerBarX;
  let y = currentSettings.localPlayerBarY;
  const w = currentSettings.localPlayerBarWidth;
  const h = currentSettings.localPlayerBarHeight;
  
  // HP
  if (currentSettings.showLocalHP && player.healthMax > 0) {
    const hpPct = Math.min(1, (player.healthCurrent || 0) / player.healthMax);
    dl.addRectFilled({ x, y }, { x: x + w, y: y + h }, colorToU32(currentSettings.colorHealthBarBg));
    dl.addRectFilled({ x, y }, { x: x + w * hpPct, y: y + h }, colorToU32(currentSettings.colorHealthBar));
    dl.addRect({ x, y }, { x: x + w, y: y + h }, colorToU32([0.4, 0.4, 0.4, 1]), 0, 0, 1);
    drawTextWithShadow(dl, `HP: ${player.healthCurrent || 0}/${player.healthMax}`, x + 4, y + 3, [1, 1, 1, 1]);
    y += h + 4;
  }
  
  // ES
  if (currentSettings.showLocalES && player.esMax > 0) {
    const esPct = Math.min(1, (player.esCurrent || 0) / player.esMax);
    dl.addRectFilled({ x, y }, { x: x + w, y: y + h }, colorToU32(currentSettings.colorHealthBarBg));
    dl.addRectFilled({ x, y }, { x: x + w * esPct, y: y + h }, colorToU32(currentSettings.colorEnergyShield));
    dl.addRect({ x, y }, { x: x + w, y: y + h }, colorToU32([0.4, 0.4, 0.4, 1]), 0, 0, 1);
    drawTextWithShadow(dl, `ES: ${player.esCurrent || 0}/${player.esMax}`, x + 4, y + 3, [1, 1, 1, 1]);
    y += h + 4;
  }
  
  // Mana
  if (currentSettings.showLocalMana && player.manaMax > 0) {
    const manaPct = Math.min(1, (player.manaCurrent || 0) / player.manaMax);
    dl.addRectFilled({ x, y }, { x: x + w, y: y + h }, colorToU32(currentSettings.colorHealthBarBg));
    dl.addRectFilled({ x, y }, { x: x + w * manaPct, y: y + h }, colorToU32(currentSettings.colorMana));
    dl.addRect({ x, y }, { x: x + w, y: y + h }, colorToU32([0.4, 0.4, 0.4, 1]), 0, 0, 1);
    drawTextWithShadow(dl, `Mana: ${player.manaCurrent || 0}/${player.manaMax}`, x + 4, y + 3, [1, 1, 1, 1]);
  }
}

// World-position local player bars (above player's head, like other entities)
function drawLocalPlayerWorldBars(player, dl) {
  if (!currentSettings.showLocalPlayerWorldBars) return;
  if (!player.worldX) return;
  
  // Calculate Z position
  let wz;
  if (currentSettings.localWorldUseTerrainHeight && typeof player.terrainHeight === 'number') {
    wz = player.terrainHeight;
  } else {
    wz = player.worldZ || 0;
  }
  wz += currentSettings.localWorldZOffset;  // Offset above player
  
  const screenPos = w2s(player.worldX, player.worldY, wz);
  if (!screenPos) return;
  
  const w = currentSettings.localWorldBarWidth;
  const h = currentSettings.localWorldBarHeight;
  let x = screenPos.x - w / 2;
  let y = screenPos.y;
  const barSpacing = 2;
  
  // HP with ES overlay
  if (currentSettings.localWorldShowHP && player.healthMax > 0) {
    const hpPct = Math.min(1, (player.healthCurrent || 0) / player.healthMax);
    dl.addRectFilled({ x, y }, { x: x + w, y: y + h }, colorToU32(currentSettings.colorHealthBarBg));
    dl.addRectFilled({ x, y }, { x: x + w * hpPct, y: y + h }, colorToU32(currentSettings.colorLocalHP));
    
    // ES overlay
    if (currentSettings.localWorldShowES && player.esMax > 0 && player.esCurrent > 0) {
      const esPct = Math.min(1, player.esCurrent / player.esMax);
      const esColor = [...currentSettings.colorLocalES];
      esColor[3] = (esColor[3] || 1.0) * 0.7;
      dl.addRectFilled({ x, y }, { x: x + w * esPct, y: y + h }, colorToU32(esColor));
    }
    
    dl.addRect({ x, y }, { x: x + w, y: y + h }, colorToU32([0.3, 0.3, 0.3, 1]), 0, 0, 1);
    y += h + barSpacing;
  } else if (currentSettings.localWorldShowES && player.esMax > 0) {
    // ES only
    const esPct = Math.min(1, (player.esCurrent || 0) / player.esMax);
    dl.addRectFilled({ x, y }, { x: x + w, y: y + h }, colorToU32(currentSettings.colorHealthBarBg));
    dl.addRectFilled({ x, y }, { x: x + w * esPct, y: y + h }, colorToU32(currentSettings.colorLocalES));
    dl.addRect({ x, y }, { x: x + w, y: y + h }, colorToU32([0.3, 0.3, 0.3, 1]), 0, 0, 1);
    y += h + barSpacing;
  }
  
  // Mana
  if (currentSettings.localWorldShowMana && player.manaMax > 0) {
    const manaPct = Math.min(1, (player.manaCurrent || 0) / player.manaMax);
    const manaH = h * 0.6;
    dl.addRectFilled({ x, y }, { x: x + w, y: y + manaH }, colorToU32(currentSettings.colorHealthBarBg));
    dl.addRectFilled({ x, y }, { x: x + w * manaPct, y: y + manaH }, colorToU32(currentSettings.colorLocalMana));
    dl.addRect({ x, y }, { x: x + w, y: y + manaH }, colorToU32([0.3, 0.3, 0.3, 1]), 0, 0, 1);
  }
}

//=============================================================================
// Main ESP Loop
//=============================================================================

// Cache for category settings lookups (avoid repeated getCategorySettings calls)
const categorySettingsCache = new Map();
let cacheFrame = -1;

function getCachedCategorySettings(cat) {
  // Reset cache each frame
  if (cacheFrame !== frameCount) {
    categorySettingsCache.clear();
    cacheFrame = frameCount;
  }
  
  let settings = categorySettingsCache.get(cat);
  if (!settings) {
    settings = getCategorySettings(cat);
    categorySettingsCache.set(cat, settings);
  }
  return settings;
}

// Pre-filter and categorize entities once per frame
// Note: Distance filtering is now done in C++ before component reading for performance
function filterEntities(entities, player) {
  const filtered = [];
  const playerAddr = player.address;
  
  for (let i = 0, len = entities.length; i < len; i++) {
    const e = entities[i];
    
    // Quick rejections first (no function calls)
    if (!e || !e.worldX) continue;
    if (e.isLocalPlayer || e.address === playerAddr) continue;
    
    // Metadata filter (only if enabled)
    if (currentSettings.filterMode !== 0 && !passesMetadataFilter(e)) continue;
    
    // Get category and settings (cached)
    const cat = getEntityCategory(e);
    const catSettings = getCachedCategorySettings(cat);
    
    // Category checks
    if (!catSettings.enabled) continue;
    if (catSettings.renderMode === RENDER.NONE) continue;
    if (catSettings.onlyAlive && !e.isAlive) continue;
    if (catSettings.onlyUnopened && e.chestIsOpened === true) continue;
    if (catSettings.onlyTargetable && e.isTargetable === false) continue;
    
    // Per-category include/exclude filter
    if (!passesCategoryFilter(e, catSettings)) continue;
    
    // Entity passed all filters - add with cached data
    filtered.push({ entity: e, cat, catSettings });
  }
  
  return filtered;
}

function drawESP() {
  frameCount++;
  
  if (!currentSettings.enabled) return;
  
  const player = POE2Cache.getLocalPlayer();
  if (!player || !player.worldX) return;
  
  // Use lightweight mode to skip expensive component reads (buffs, stats, mods)
  // Also pass maxDistance so C++ can filter by distance BEFORE reading components
  const entities = poe2.getEntities({ 
    lightweight: true,
    maxDistance: currentSettings.maxDistance
  });
  if (!entities || entities.length === 0) return;
  
  const dl = ImGui.getBackgroundDrawList();
  if (!dl) return;
  
  // Draw local player overlays
  drawLocalPlayerBars(player, dl);
  drawLocalPlayerWorldBars(player, dl);
  
  // Filter entities ONCE with cached category lookups
  const filtered = filterEntities(entities, player);
  const filteredLen = filtered.length;
  
  // Draw lines first (behind everything) - single pass through filtered list
  if (currentSettings.lineEnabled) {
    for (let i = 0; i < filteredLen; i++) {
      const { entity, catSettings } = filtered[i];
      if (catSettings.showLine) {
        drawLineToEntity(dl, player, entity, catSettings);
      }
    }
  }
  
  // Draw entity shapes, bars, names - single pass through filtered list
  for (let i = 0; i < filteredLen; i++) {
    const { entity, cat, catSettings } = filtered[i];
    drawEntityESPFast(entity, player, dl, catSettings);
  }
  
  // Update debug stats only occasionally (every 60 frames) to reduce overhead
  if (frameCount % 60 === 0) {
    debugStats.total = entities.length;
    debugStats.filtered = filteredLen;
    debugStats.drawn = filteredLen;
    debugStats.errors = [];
    
    // Count entity types (only when updating stats)
    debugStats.types = {};
    for (let i = 0, len = entities.length; i < len; i++) {
      const t = entities[i].entityType || 'Unknown';
      debugStats.types[t] = (debugStats.types[t] || 0) + 1;
    }
  }
  
  // Log only every 300 frames
  if (frameCount % 300 === 1) {
    console.log(`[ESP] Frame ${frameCount}: ${entities.length} entities, ${filteredLen} drawn`);
  }
}

//=============================================================================
// Settings UI
//=============================================================================

// Convert color from any ImGui format to array [r, g, b, a]
function colorToArray(val) {
  if (!val) return null;
  if (Array.isArray(val)) {
    return [val[0], val[1], val[2], val[3] !== undefined ? val[3] : 1.0];
  }
  if (typeof val === 'object') {
    // ImColor object {r, g, b, a} or ImVec4 {x, y, z, w}
    if ('r' in val) return [val.r, val.g, val.b, val.a !== undefined ? val.a : 1.0];
    if ('x' in val) return [val.x, val.y, val.z, val.w !== undefined ? val.w : 1.0];
  }
  if (typeof val === 'number') {
    // Packed U32 color
    const conv = ImGui.colorConvertU32ToFloat4(val);
    if (conv) return [conv.r, conv.g, conv.b, conv.a];
  }
  return null;
}

function drawColorPicker(label, settingKey) {
  const color = currentSettings[settingKey] || [1, 1, 1, 1];
  const colorVar = new ImGui.MutableVariable([...color]);
  if (ImGui.colorEdit4(label, colorVar)) {
    const newColor = colorToArray(colorVar.value);
    if (newColor) {
      saveSetting(settingKey, newColor);
    }
  }
}

function drawCategorySettings(cat) {
  const info = CATEGORIES[cat];
  const catSettings = getCategorySettings(cat);
  
  // Enable checkbox
  const enabledVar = new ImGui.MutableVariable(catSettings.enabled);
  if (ImGui.checkbox(`##en${cat}`, enabledVar)) {
    saveCategorySetting(cat, 'enabled', enabledVar.value);
  }
  ImGui.sameLine();
  
  // If disabled, just show label text (not expandable)
  if (!catSettings.enabled) {
    ImGui.textColored([0.5, 0.5, 0.5, 1], info.label);
    return;
  }
  
  // If enabled, use treeNode for expandable options
  const isOpen = ImGui.treeNode(`${info.label}##tree${cat}`);
  
  if (isOpen) {
    // Row 1: Render mode + Opacity + Terrain
    ImGui.setNextItemWidth(110);
    const modeVar = new ImGui.MutableVariable(catSettings.renderMode);
    if (ImGui.combo(`Mode##${cat}`, modeVar, RENDER_NAMES)) {
      saveCategorySetting(cat, 'renderMode', modeVar.value);
    }
    
    ImGui.sameLine();
    ImGui.setNextItemWidth(60);
    const opacityVar = new ImGui.MutableVariable(catSettings.opacity);
    if (ImGui.sliderFloat(`Op##${cat}`, opacityVar, 0.1, 1.0)) {
      saveCategorySetting(cat, 'opacity', opacityVar.value);
    }
    
    ImGui.sameLine();
    const terrainVar = new ImGui.MutableVariable(catSettings.useTerrainHeight);
    if (ImGui.checkbox(`Ground##${cat}`, terrainVar)) {
      saveCategorySetting(cat, 'useTerrainHeight', terrainVar.value);
    }
    
    ImGui.sameLine();
    ImGui.setNextItemWidth(50);
    const zOffsetVar = new ImGui.MutableVariable(catSettings.groundZOffset || 0);
    if (ImGui.inputFloat(`Z##${cat}`, zOffsetVar)) {
      saveCategorySetting(cat, 'groundZOffset', zOffsetVar.value);
    }
    if (ImGui.isItemHovered()) {
      ImGui.setTooltip("Z offset for ground shapes");
    }
    
    // Size multiplier (especially useful for effects which need 5x)
    ImGui.sameLine();
    ImGui.setNextItemWidth(50);
    const sizeMultVar = new ImGui.MutableVariable(catSettings.sizeMultiplier || 1.0);
    if (ImGui.inputFloat(`Size##${cat}`, sizeMultVar)) {
      saveCategorySetting(cat, 'sizeMultiplier', Math.max(0.1, sizeMultVar.value));
    }
    if (ImGui.isItemHovered()) {
      ImGui.setTooltip("Size multiplier (only applies to 'Ground' effects)");
    }
    
    // Row 2: Shape color picker
    const colorVar = new ImGui.MutableVariable([...catSettings.color]);
    if (ImGui.colorEdit4(`Shape Color##${cat}`, colorVar)) {
      const newColor = colorToArray(colorVar.value);
      if (newColor) saveCategorySetting(cat, 'color', newColor);
    }
    
    // Row 3: Show options
    const nameVar = new ImGui.MutableVariable(catSettings.showName);
    if (ImGui.checkbox(`Name##${cat}`, nameVar)) {
      saveCategorySetting(cat, 'showName', nameVar.value);
    }
    
    ImGui.sameLine();
    const distVar = new ImGui.MutableVariable(catSettings.showDistance);
    if (ImGui.checkbox(`Dist##${cat}`, distVar)) {
      saveCategorySetting(cat, 'showDistance', distVar.value);
    }
    
    // Only alive (for monsters)
    if (cat.startsWith('monsters')) {
      ImGui.sameLine();
      const aliveVar = new ImGui.MutableVariable(catSettings.onlyAlive);
      if (ImGui.checkbox(`Alive##${cat}`, aliveVar)) {
        saveCategorySetting(cat, 'onlyAlive', aliveVar.value);
      }
    }
    
    // Only unopened (for chests)
    if (cat.startsWith('chests') || cat === 'strongboxes') {
      ImGui.sameLine();
      const unopenedVar = new ImGui.MutableVariable(catSettings.onlyUnopened);
      if (ImGui.checkbox(`Unopened##${cat}`, unopenedVar)) {
        saveCategorySetting(cat, 'onlyUnopened', unopenedVar.value);
      }
    }
    
    // Targetable filter (available for all)
    const targetableVar = new ImGui.MutableVariable(catSettings.onlyTargetable);
    if (ImGui.checkbox(`Targetable##${cat}`, targetableVar)) {
      saveCategorySetting(cat, 'onlyTargetable', targetableVar.value);
    }
    
    // Row 4: Bar toggles
    const hpVar = new ImGui.MutableVariable(catSettings.showHealth);
    if (ImGui.checkbox(`HP Bar##${cat}`, hpVar)) {
      saveCategorySetting(cat, 'showHealth', hpVar.value);
    }
    
    ImGui.sameLine();
    const esVar = new ImGui.MutableVariable(catSettings.showES);
    if (ImGui.checkbox(`ES Bar##${cat}`, esVar)) {
      saveCategorySetting(cat, 'showES', esVar.value);
    }
    
    ImGui.sameLine();
    const manaVar = new ImGui.MutableVariable(catSettings.showMana);
    if (ImGui.checkbox(`Mana Bar##${cat}`, manaVar)) {
      saveCategorySetting(cat, 'showMana', manaVar.value);
    }
    
    ImGui.sameLine();
    const rageVar2 = new ImGui.MutableVariable(catSettings.showRage);
    if (ImGui.checkbox(`Rage Bar##${cat}`, rageVar2)) {
      saveCategorySetting(cat, 'showRage', rageVar2.value);
    }
    
    // Row 5: Bar colors (only if any bar is enabled)
    if (catSettings.showHealth || catSettings.showES || catSettings.showMana || catSettings.showRage) {
      if (catSettings.showHealth) {
        const hpColorVar = new ImGui.MutableVariable([...catSettings.colorHP]);
        if (ImGui.colorEdit4(`HP Color##${cat}`, hpColorVar)) {
          const c = colorToArray(hpColorVar.value);
          if (c) saveCategorySetting(cat, 'colorHP', c);
        }
      }
      
      if (catSettings.showES) {
        const esColorVar = new ImGui.MutableVariable([...catSettings.colorES]);
        if (ImGui.colorEdit4(`ES Color##${cat}`, esColorVar)) {
          const c = colorToArray(esColorVar.value);
          if (c) saveCategorySetting(cat, 'colorES', c);
        }
      }
      
      if (catSettings.showMana) {
        const manaColorVar = new ImGui.MutableVariable([...catSettings.colorMana]);
        if (ImGui.colorEdit4(`Mana Color##${cat}`, manaColorVar)) {
          const c = colorToArray(manaColorVar.value);
          if (c) saveCategorySetting(cat, 'colorMana', c);
        }
      }
      
      if (catSettings.showRage) {
        const rageColorVar = new ImGui.MutableVariable([...(catSettings.colorRage || [1.0, 0.5, 0.2, 1.0])]);
        if (ImGui.colorEdit4(`Rage Color##${cat}`, rageColorVar)) {
          const c = colorToArray(rageColorVar.value);
          if (c) saveCategorySetting(cat, 'colorRage', c);
        }
      }
      
      const bgColorVar = new ImGui.MutableVariable([...catSettings.colorBarBg]);
      if (ImGui.colorEdit4(`Bar BG##${cat}`, bgColorVar)) {
        const c = colorToArray(bgColorVar.value);
        if (c) saveCategorySetting(cat, 'colorBarBg', c);
      }
    }
    
    // Row 6: Line ESP
    ImGui.separator();
    const lineVar = new ImGui.MutableVariable(catSettings.showLine || false);
    if (ImGui.checkbox(`Line##${cat}`, lineVar)) {
      saveCategorySetting(cat, 'showLine', lineVar.value);
    }
    if (ImGui.isItemHovered()) {
      ImGui.setTooltip("Draw direction line from player to this entity");
    }
    
    if (catSettings.showLine) {
      ImGui.sameLine();
      const lineColorVar = new ImGui.MutableVariable([...(catSettings.lineColor || catSettings.color)]);
      if (ImGui.colorEdit4(`Line##${cat}`, lineColorVar)) {
        const c = colorToArray(lineColorVar.value);
        if (c) saveCategorySetting(cat, 'lineColor', c);
      }
    }
    
    // Per-category filters
    ImGui.separator();
    ImGui.textColored([0.7, 0.7, 0.7, 1], "Filters (comma-separated):");
    
    ImGui.setNextItemWidth(180);
    const includeVar = new ImGui.MutableVariable(catSettings.includeFilter || "");
    if (ImGui.inputText(`Include##inc${cat}`, includeVar)) {
      saveCategorySetting(cat, 'includeFilter', includeVar.value);
    }
    if (ImGui.isItemHovered()) {
      ImGui.setTooltip("Only show entities matching these (comma-separated). Takes priority over exclude.");
    }
    
    ImGui.sameLine();
    ImGui.setNextItemWidth(180);
    const excludeVar = new ImGui.MutableVariable(catSettings.excludeFilter || "");
    if (ImGui.inputText(`Exclude##exc${cat}`, excludeVar)) {
      saveCategorySetting(cat, 'excludeFilter', excludeVar.value);
    }
    if (ImGui.isItemHovered()) {
      ImGui.setTooltip("Hide entities matching these (comma-separated). Ignored if Include has matches.");
    }
    
    ImGui.treePop();
  }
}

function drawSettingsUI() {
  ImGui.setNextWindowSize({ x: 500, y: 700 }, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({ x: 10, y: 200 }, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowCollapsed(true, ImGui.Cond.Once);
  
  if (!ImGui.begin("ESP Settings", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Master toggle
  const enabledVar = new ImGui.MutableVariable(currentSettings.enabled);
  if (ImGui.checkbox("ESP Enabled", enabledVar)) {
    saveSetting('enabled', enabledVar.value);
  }
  
  ImGui.sameLine();
  ImGui.text("Distance:");
  ImGui.sameLine();
  ImGui.setNextItemWidth(100);
  const distVar = new ImGui.MutableVariable(currentSettings.maxDistance);
  if (ImGui.sliderInt("##dist", distVar, 50, 1000)) {
    saveSetting('maxDistance', distVar.value);
  }
  
  ImGui.sameLine();
  if (ImGui.button("Reset All")) {
    currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    includeFilterBuffer = "";
    excludeFilterBuffer = "";
    Settings.setMultiple(PLUGIN_NAME, currentSettings);
    console.log("[ESP] Settings reset to defaults");
  }
  
  ImGui.separator();
  
  // Category settings
  if (ImGui.collapsingHeader("Entity Categories", ImGui.TreeNodeFlags.DefaultOpen)) {
    for (const cat of Object.keys(CATEGORIES)) {
      drawCategorySettings(cat);
    }
  }
  
  // Local player bars
  if (ImGui.collapsingHeader("Local Player Overlay")) {
    // HUD-style bars (fixed screen position)
    ImGui.textColored([0.8, 0.8, 0.2, 1], "Screen Position (HUD):");
    const showBarsVar = new ImGui.MutableVariable(currentSettings.showLocalPlayerBars);
    if (ImGui.checkbox("Enable HUD Bars", showBarsVar)) {
      saveSetting('showLocalPlayerBars', showBarsVar.value);
    }
    
    if (currentSettings.showLocalPlayerBars) {
      const hpVar = new ImGui.MutableVariable(currentSettings.showLocalHP);
      if (ImGui.checkbox("HP##hud", hpVar)) saveSetting('showLocalHP', hpVar.value);
      
      ImGui.sameLine();
      const esVar = new ImGui.MutableVariable(currentSettings.showLocalES);
      if (ImGui.checkbox("ES##hud", esVar)) saveSetting('showLocalES', esVar.value);
      
      ImGui.sameLine();
      const manaVar = new ImGui.MutableVariable(currentSettings.showLocalMana);
      if (ImGui.checkbox("Mana##hud", manaVar)) saveSetting('showLocalMana', manaVar.value);
      
      ImGui.setNextItemWidth(60);
      const xVar = new ImGui.MutableVariable(currentSettings.localPlayerBarX);
      if (ImGui.inputInt("X##hudX", xVar)) saveSetting('localPlayerBarX', xVar.value);
      
      ImGui.sameLine();
      ImGui.setNextItemWidth(60);
      const yVar = new ImGui.MutableVariable(currentSettings.localPlayerBarY);
      if (ImGui.inputInt("Y##hudY", yVar)) saveSetting('localPlayerBarY', yVar.value);
      
      ImGui.sameLine();
      ImGui.setNextItemWidth(60);
      const wVar = new ImGui.MutableVariable(currentSettings.localPlayerBarWidth);
      if (ImGui.inputInt("W##hudW", wVar)) saveSetting('localPlayerBarWidth', wVar.value);
      
      ImGui.sameLine();
      ImGui.setNextItemWidth(60);
      const hVar = new ImGui.MutableVariable(currentSettings.localPlayerBarHeight);
      if (ImGui.inputInt("H##hudH", hVar)) saveSetting('localPlayerBarHeight', hVar.value);
    }
    
    ImGui.separator();
    
    // World-position bars (above player's head)
    ImGui.textColored([0.2, 0.8, 0.8, 1], "World Position (Above Head):");
    const showWorldVar = new ImGui.MutableVariable(currentSettings.showLocalPlayerWorldBars);
    if (ImGui.checkbox("Enable World Bars", showWorldVar)) {
      saveSetting('showLocalPlayerWorldBars', showWorldVar.value);
    }
    
    if (currentSettings.showLocalPlayerWorldBars) {
      const hpVar2 = new ImGui.MutableVariable(currentSettings.localWorldShowHP);
      if (ImGui.checkbox("HP##world", hpVar2)) saveSetting('localWorldShowHP', hpVar2.value);
      
      ImGui.sameLine();
      const esVar2 = new ImGui.MutableVariable(currentSettings.localWorldShowES);
      if (ImGui.checkbox("ES##world", esVar2)) saveSetting('localWorldShowES', esVar2.value);
      
      ImGui.sameLine();
      const manaVar2 = new ImGui.MutableVariable(currentSettings.localWorldShowMana);
      if (ImGui.checkbox("Mana##world", manaVar2)) saveSetting('localWorldShowMana', manaVar2.value);
      
      ImGui.sameLine();
      const terrainVar = new ImGui.MutableVariable(currentSettings.localWorldUseTerrainHeight);
      if (ImGui.checkbox("Ground##world", terrainVar)) saveSetting('localWorldUseTerrainHeight', terrainVar.value);
      
      ImGui.setNextItemWidth(60);
      const wVar2 = new ImGui.MutableVariable(currentSettings.localWorldBarWidth);
      if (ImGui.inputInt("W##worldW", wVar2)) saveSetting('localWorldBarWidth', wVar2.value);
      
      ImGui.sameLine();
      ImGui.setNextItemWidth(60);
      const hVar2 = new ImGui.MutableVariable(currentSettings.localWorldBarHeight);
      if (ImGui.inputInt("H##worldH", hVar2)) saveSetting('localWorldBarHeight', hVar2.value);
      
      ImGui.sameLine();
      ImGui.setNextItemWidth(60);
      const zVar = new ImGui.MutableVariable(currentSettings.localWorldZOffset);
      if (ImGui.inputFloat("Z Off##worldZ", zVar)) saveSetting('localWorldZOffset', zVar.value);
      
      // Colors
      drawColorPicker("HP Color##localHP", 'colorLocalHP');
      drawColorPicker("ES Color##localES", 'colorLocalES');
      drawColorPicker("Mana Color##localMana", 'colorLocalMana');
    }
  }
  
  // Metadata filters
  if (ImGui.collapsingHeader("Metadata Filters")) {
    ImGui.text("Mode:");
    const modeVar = new ImGui.MutableVariable(currentSettings.filterMode);
    if (ImGui.combo("##filterMode", modeVar, FILTER_MODE_NAMES)) {
      saveSetting('filterMode', modeVar.value);
    }
    
    const mode = currentSettings.filterMode;
    
    if (mode === 1 || mode === 3) {
      ImGui.textColored([0.4, 1.0, 0.4, 1], "Include (comma-sep):");
      const incVar = new ImGui.MutableVariable(includeFilterBuffer);
      if (ImGui.inputText("##inc", incVar)) {
        includeFilterBuffer = incVar.value;
        saveSetting('includeFilters', incVar.value);
      }
    }
    
    if (mode === 2 || mode === 3) {
      ImGui.textColored([1.0, 0.4, 0.4, 1], "Exclude (comma-sep):");
      const excVar = new ImGui.MutableVariable(excludeFilterBuffer);
      if (ImGui.inputText("##exc", excVar)) {
        excludeFilterBuffer = excVar.value;
        saveSetting('excludeFilters', excVar.value);
      }
    }
  }
  
  // Visual options
  if (ImGui.collapsingHeader("Visual Options")) {
    const boundsVar = new ImGui.MutableVariable(currentSettings.useBoundsForSize);
    if (ImGui.checkbox("Use Entity Bounds", boundsVar)) saveSetting('useBoundsForSize', boundsVar.value);
    
    ImGui.sameLine();
    const rotVar = new ImGui.MutableVariable(currentSettings.useRotation);
    if (ImGui.checkbox("Use Rotation", rotVar)) saveSetting('useRotation', rotVar.value);
    
    ImGui.sameLine();
    const terrainVar = new ImGui.MutableVariable(currentSettings.useTerrainHeight);
    if (ImGui.checkbox("Ground Level", terrainVar)) saveSetting('useTerrainHeight', terrainVar.value);
    ImGui.sameLine();
    ImGui.textColored([0.5, 0.5, 0.5, 1], "(?)");
    if (ImGui.isItemHovered()) {
      ImGui.setTooltip("Use terrain height for ground-level rendering");
    }
    
    ImGui.text("Circle:");
    ImGui.setNextItemWidth(60);
    const radVar = new ImGui.MutableVariable(currentSettings.circleRadius);
    if (ImGui.inputInt("Radius", radVar)) saveSetting('circleRadius', radVar.value);
    
    ImGui.sameLine();
    ImGui.setNextItemWidth(60);
    const segVar = new ImGui.MutableVariable(currentSettings.circleSegments);
    if (ImGui.inputInt("Segments", segVar)) saveSetting('circleSegments', segVar.value);
    
    ImGui.text("Box Height:");
    ImGui.setNextItemWidth(60);
    const boxVar = new ImGui.MutableVariable(currentSettings.boxHeight);
    if (ImGui.inputInt("##boxH", boxVar)) saveSetting('boxHeight', boxVar.value);
    
    ImGui.sameLine();
    ImGui.text("Line:");
    ImGui.sameLine();
    ImGui.setNextItemWidth(60);
    const shapeLineVal = Math.round(currentSettings.lineThickness) || 1;
    const shapeLineVar = new ImGui.MutableVariable(shapeLineVal);
    if (ImGui.inputInt("##lineT", shapeLineVar)) saveSetting('lineThickness', Math.round(shapeLineVar.value));
    
    ImGui.separator();
    ImGui.text("Health Bar:");
    ImGui.setNextItemWidth(60);
    const hbwVar = new ImGui.MutableVariable(currentSettings.healthBarWidth);
    if (ImGui.inputInt("W##hbw", hbwVar)) saveSetting('healthBarWidth', hbwVar.value);
    
    ImGui.sameLine();
    ImGui.setNextItemWidth(60);
    const hbhVar = new ImGui.MutableVariable(currentSettings.healthBarHeight);
    if (ImGui.inputInt("H##hbh", hbhVar)) saveSetting('healthBarHeight', hbhVar.value);
    
    ImGui.separator();
    drawColorPicker("HP Bar", 'colorHealthBar');
    drawColorPicker("ES Bar", 'colorEnergyShield');
    drawColorPicker("Mana Bar", 'colorMana');
    drawColorPicker("Bar BG", 'colorHealthBarBg');
  }
  
  // Line ESP
  if (ImGui.collapsingHeader("Line ESP")) {
    const lineEnVar = new ImGui.MutableVariable(currentSettings.lineEnabled);
    if (ImGui.checkbox("Enable Line ESP", lineEnVar)) {
      saveSetting('lineEnabled', lineEnVar.value);
    }
    if (ImGui.isItemHovered()) {
      ImGui.setTooltip("Draw direction lines from player to entities");
    }
    
    if (currentSettings.lineEnabled) {
      // Line style
      const LINE_STYLES = ["Solid", "Gradient Fade", "Dashed"];
      ImGui.setNextItemWidth(100);
      const styleVar = new ImGui.MutableVariable(currentSettings.lineStyle || 0);
      if (ImGui.combo("Style##line", styleVar, LINE_STYLES)) {
        saveSetting('lineStyle', styleVar.value);
      }
      
      ImGui.sameLine();
      ImGui.setNextItemWidth(60);
      const thickVar = new ImGui.MutableVariable(currentSettings.espLineThickness || 1.5);
      if (ImGui.sliderFloat("Thick##line", thickVar, 0.5, 5.0)) {
        saveSetting('espLineThickness', thickVar.value);
      }
      
      // Fade distance
      ImGui.text("Distance Fade:");
      ImGui.setNextItemWidth(80);
      const fadeStartVar = new ImGui.MutableVariable(currentSettings.lineFadeStart);
      if (ImGui.inputInt("Start##fade", fadeStartVar)) {
        saveSetting('lineFadeStart', Math.max(0, fadeStartVar.value));
      }
      if (ImGui.isItemHovered()) {
        ImGui.setTooltip("Distance where fade begins");
      }
      
      ImGui.sameLine();
      ImGui.setNextItemWidth(80);
      const fadeEndVar = new ImGui.MutableVariable(currentSettings.lineFadeEnd);
      if (ImGui.inputInt("End##fade", fadeEndVar)) {
        saveSetting('lineFadeEnd', Math.max(fadeStartVar.value + 10, fadeEndVar.value));
      }
      if (ImGui.isItemHovered()) {
        ImGui.setTooltip("Distance where fully faded out");
      }
      
      // Offscreen settings
      ImGui.separator();
      const offscreenVar = new ImGui.MutableVariable(currentSettings.lineShowOffscreen);
      if (ImGui.checkbox("Show Offscreen Indicators", offscreenVar)) {
        saveSetting('lineShowOffscreen', offscreenVar.value);
      }
      if (ImGui.isItemHovered()) {
        ImGui.setTooltip("Show direction arrows pointing to offscreen entities");
      }
      
      if (currentSettings.lineShowOffscreen) {
        ImGui.setNextItemWidth(80);
        const offLenVar = new ImGui.MutableVariable(currentSettings.lineOffscreenLength);
        if (ImGui.sliderInt("Arrow Length##off", offLenVar, 30, 200)) {
          saveSetting('lineOffscreenLength', offLenVar.value);
        }
      }
      
      // Other options
      ImGui.separator();
      ImGui.setNextItemWidth(80);
      const startOffVar = new ImGui.MutableVariable(currentSettings.lineStartOffset);
      if (ImGui.sliderInt("Start Offset##line", startOffVar, 0, 100)) {
        saveSetting('lineStartOffset', startOffVar.value);
      }
      if (ImGui.isItemHovered()) {
        ImGui.setTooltip("Offset from player center to avoid clutter");
      }
      
      ImGui.sameLine();
      ImGui.setNextItemWidth(60);
      const arrowVar = new ImGui.MutableVariable(currentSettings.lineArrowSize);
      if (ImGui.sliderInt("Arrow##line", arrowVar, 0, 20)) {
        saveSetting('lineArrowSize', arrowVar.value);
      }
    }
  }
  
  // Debug
  if (ImGui.collapsingHeader("Debug", ImGui.TreeNodeFlags.DefaultOpen)) {
    ImGui.text(`Frame: ${frameCount}`);
    ImGui.text(`Entities: ${debugStats.total} total, ${debugStats.filtered} passed filter, ${debugStats.drawn} drawn`);
    
    // Show enabled categories
    const enabledCats = Object.keys(CATEGORIES).filter(c => getCategorySettings(c).enabled);
    ImGui.text(`Enabled: ${enabledCats.join(', ') || 'none'}`);
    
    // Entity type breakdown
    if (Object.keys(debugStats.types).length > 0) {
      ImGui.separator();
      ImGui.text("Entity types:");
      for (const [t, c] of Object.entries(debugStats.types)) {
        ImGui.text(`  ${t}: ${c}`);
      }
    }
    
    // Errors
    if (debugStats.errors.length > 0) {
      ImGui.separator();
      ImGui.textColored([1, 0.3, 0.3, 1], "Errors:");
      for (const err of debugStats.errors.slice(0, 5)) {
        ImGui.text(`  ${err}`);
      }
    }
    
    const player = POE2Cache.getLocalPlayer();
    if (player) {
      ImGui.separator();
      ImGui.text(`Player: ${player.playerName || '?'}`);
      ImGui.text(`World: ${(player.worldX || 0).toFixed(0)}, ${(player.worldY || 0).toFixed(0)}, ${(player.worldZ || 0).toFixed(0)}`);
      ImGui.text(`Terrain H: ${(player.terrainHeight || 0).toFixed(0)}`);
      ImGui.text(`HP: ${player.healthCurrent}/${player.healthMax}`);
      ImGui.text(`ES: ${player.esCurrent}/${player.esMax}`);
      ImGui.text(`Mana: ${player.manaCurrent}/${player.manaMax}`);
      ImGui.text(`Rage: ${player.rageCurrent || 0}/${player.rageMax || 0}`);
    } else {
      ImGui.textColored([1, 0.3, 0.3, 1], "No player data!");
    }
  }
  
  ImGui.end();
}

//=============================================================================
// Entry Point
//=============================================================================

// Core logic + ESP overlay - always runs
function onDraw() {
  loadSettings();
  drawESP();
}

// Settings UI - only runs when UI is visible (F12 toggle)
function onDrawUI() {
  drawSettingsUI();
}

export const espPlugin = { onDraw, onDrawUI };

console.log("[ESP] Plugin v4 loaded");


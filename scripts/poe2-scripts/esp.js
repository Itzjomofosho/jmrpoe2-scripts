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
      enabled: true, renderMode: RENDER.CIRCLE_3D_FILLED, opacity: 0.35,
      color: [0.8, 0.8, 0.2, 0.7], showName: false, showHealth: false, showES: false, showMana: false,
      showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: false,
      useTerrainHeight: true, groundZOffset: 0,
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    monsters: {
      enabled: true, renderMode: RENDER.HP_BAR_ONLY, opacity: 1.0,
      color: [1.0, 0.3, 0.3, 0.9], showName: true, showHealth: true, showES: true, showMana: true,
      showDistance: false, onlyAlive: true, onlyUnopened: false, onlyTargetable: true,
      useTerrainHeight: true, groundZOffset: 0,
      colorHP: [1.0, 0.58, 0.49, 0.74], colorES: [1.0, 1.0, 1.0, 0.75], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    monstersMagic: {
      enabled: true, renderMode: RENDER.HP_BAR_ONLY, opacity: 1.0,
      color: [0.3, 0.5, 1.0, 0.9], showName: true, showHealth: true, showES: true, showMana: false,
      showDistance: false, onlyAlive: true, onlyUnopened: false, onlyTargetable: true,
      useTerrainHeight: true, groundZOffset: 0,
      colorHP: [0.9, 0.27, 0.2, 0.69], colorES: [0.7, 0.82, 0.98, 0.69], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    monstersRare: {
      enabled: true, renderMode: RENDER.HP_BAR_ONLY, opacity: 1.0,
      color: [1.0, 0.8, 0.2, 0.9], showName: true, showHealth: true, showES: true, showMana: false,
      showDistance: false, onlyAlive: true, onlyUnopened: false, onlyTargetable: true,
      useTerrainHeight: true, groundZOffset: 0,
      colorHP: [0.82, 0.17, 0.17, 0.83], colorES: [0.63, 0.78, 0.98, 0.83], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    monstersUnique: {
      enabled: true, renderMode: RENDER.HP_BAR_ONLY, opacity: 1.0,
      color: [1.0, 0.5, 0.0, 0.9], showName: true, showHealth: true, showES: true, showMana: false,
      showDistance: false, onlyAlive: true, onlyUnopened: false, onlyTargetable: true,
      useTerrainHeight: true, groundZOffset: 0,
      colorHP: [1.0, 0.0, 0.0, 1.0], colorES: [0.58, 0.75, 0.97, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    monstersFriendly: {
      enabled: true, renderMode: RENDER.HP_BAR_ONLY, opacity: 1.0,
      color: [0.2, 0.8, 0.2, 0.7], showName: true, showHealth: true, showES: false, showMana: false,
      showDistance: false, onlyAlive: true, onlyUnopened: false, onlyTargetable: false,
      useTerrainHeight: true, groundZOffset: 0,
      colorHP: [0.2, 0.9, 0.2, 0.36], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    players: {
      enabled: true, renderMode: RENDER.HP_BAR_ONLY, opacity: 0.67,
      color: [0.2, 0.8, 1.0, 0.9], showName: true, showHealth: true, showES: true, showMana: true,
      showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: false,
      useTerrainHeight: true, groundZOffset: 0,
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [1.0, 1.0, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    npcs: {
      enabled: true, renderMode: RENDER.CIRCLE_3D, opacity: 0.52,
      color: [0.71, 1.0, 0.33, 0.7], showName: false, showHealth: false, showES: true, showMana: true,
      showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: false,
      useTerrainHeight: true, groundZOffset: 0,
      colorHP: [0.59, 0.9, 0.2, 0.34], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    chests: {
      enabled: true, renderMode: RENDER.CIRCLE_3D, opacity: 0.14,
      color: [1.0, 1.0, 1.0, 0.9], showName: true, showHealth: false, showES: false, showMana: false,
      showDistance: false, onlyAlive: false, onlyUnopened: true, onlyTargetable: true,
      useTerrainHeight: false, groundZOffset: 0,
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    chestsMagic: {
      enabled: true, renderMode: RENDER.BOX_3D, opacity: 0.82,
      color: [0.3, 0.5, 1.0, 0.9], showName: true, showHealth: false, showES: false, showMana: false,
      showDistance: false, onlyAlive: false, onlyUnopened: true, onlyTargetable: true,
      useTerrainHeight: false, groundZOffset: 0,
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    chestsRare: {
      enabled: true, renderMode: RENDER.BOX_3D, opacity: 1.0,
      color: [1.0, 0.8, 0.2, 0.9], showName: true, showHealth: false, showES: false, showMana: false,
      showDistance: false, onlyAlive: false, onlyUnopened: true, onlyTargetable: true,
      useTerrainHeight: false, groundZOffset: 0,
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    chestsUnique: {
      enabled: true, renderMode: RENDER.BOX_3D, opacity: 1.0,
      color: [1.0, 0.5, 0.0, 1.0], showName: true, showHealth: false, showES: false, showMana: false,
      showDistance: false, onlyAlive: false, onlyUnopened: true, onlyTargetable: true,
      useTerrainHeight: false, groundZOffset: 0,
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    strongboxes: {
      enabled: true, renderMode: RENDER.BOX_3D, opacity: 1.0,
      color: [1.0, 0.4, 0.1, 1.0], showName: true, showHealth: false, showES: false, showMana: false,
      showDistance: false, onlyAlive: false, onlyUnopened: true, onlyTargetable: false,
      useTerrainHeight: true, groundZOffset: 0,
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    shrines: {
      enabled: true, renderMode: RENDER.CIRCLE_3D, opacity: 1.0,
      color: [0.5, 1.0, 0.5, 0.9], showName: true, showHealth: false, showES: false, showMana: false,
      showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: true,
      useTerrainHeight: true, groundZOffset: 0,
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    items: {
      enabled: true, renderMode: RENDER.DOT, opacity: 1.0,
      color: [1.0, 1.0, 1.0, 0.8], showName: false, showHealth: false, showES: false, showMana: false,
      showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: false,
      useTerrainHeight: true, groundZOffset: 0,
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    },
    other: {
      enabled: false, renderMode: RENDER.BOX_3D, opacity: 0.33,
      color: [0.5, 0.5, 0.5, 0.5], showName: false, showHealth: false, showES: false, showMana: false,
      showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: false,
      useTerrainHeight: false, groundZOffset: 0,
      colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
    }
  };
  
  // Return the specific defaults if available, otherwise a generic fallback
  if (CATEGORY_DEFAULTS[cat]) {
    return { ...CATEGORY_DEFAULTS[cat] };
  }
  
  // Fallback for any unknown categories
  return {
    enabled: false, renderMode: RENDER.CIRCLE_3D, opacity: 1.0,
    color: [...CATEGORIES[cat].defaultColor], showName: false, showHealth: false, showES: false, showMana: false,
    showDistance: false, onlyAlive: false, onlyUnopened: false, onlyTargetable: false,
    useTerrainHeight: true, groundZOffset: 0,
    colorHP: [0.2, 0.9, 0.2, 1.0], colorES: [0.3, 0.6, 1.0, 1.0], colorMana: [0.2, 0.3, 0.9, 1.0], colorBarBg: [0.1, 0.1, 0.1, 0.8]
  };
}

// Build default settings
function buildDefaultSettings() {
  const settings = {
    enabled: true,
    maxDistance: 163,
    
    // Metadata filters
    includeFilters: "",
    excludeFilters: "permanent, rendered, Effect",
    filterMode: 3,  // Include + Exclude
    
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
    colorHealthBar: [0.2, 0.9, 0.2, 1.0],
    colorHealthBarBg: [0.2, 0.2, 0.2, 0.8],
    colorEnergyShield: [0.3, 0.6, 1.0, 1.0],
    colorMana: [0.2, 0.3, 0.9, 1.0],
    
    // Local player overlay (HUD)
    showLocalPlayerBars: true,
    localPlayerBarX: 700,
    localPlayerBarY: 950,
    localPlayerBarWidth: 500,
    localPlayerBarHeight: 20,
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
    colorLocalES: [0.3, 0.6, 1.0, 0.8],
    colorLocalMana: [0.2, 0.3, 0.9, 1.0],
    
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

function matchesAnyFilter(entity, filters) {
  if (filters.length === 0) return false;
  const path = (entity.name || "").toLowerCase();  // entity.name is metadata path
  const displayName = (entity.renderName || entity.playerName || "").toLowerCase();
  for (const f of filters) {
    if (path.includes(f) || displayName.includes(f)) return true;
  }
  return false;
}

function passesMetadataFilter(entity) {
  const mode = currentSettings.filterMode;
  if (mode === 0) return true;
  
  const inc = parseFilters(currentSettings.includeFilters);
  const exc = parseFilters(currentSettings.excludeFilters);
  
  if (mode === 1) return inc.length === 0 || matchesAnyFilter(entity, inc);
  if (mode === 2) return exc.length === 0 || !matchesAnyFilter(entity, exc);
  if (mode === 3) {
    const passInc = inc.length === 0 || matchesAnyFilter(entity, inc);
    const passExc = exc.length === 0 || !matchesAnyFilter(entity, exc);
    return passInc && passExc;
  }
  return true;
}

function isEffect(entity) {
  const path = (entity.name || "").toLowerCase();  // entity.name is metadata path
  return path.includes('effect') || path.includes('projectile');
}

// Get display name for entity (same priority as entity_explorer)
function getEntityDisplayName(entity) {
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

function draw3DCircle(dl, entity, color, opacity, filled = false, catSettings = null) {
  const wx = entity.worldX, wy = entity.worldY, wz = getEntityZ(entity, catSettings);
  const radius = currentSettings.useBoundsForSize && entity.boundsX > 0
    ? Math.max(entity.boundsX, entity.boundsY) / 2 : currentSettings.circleRadius;
  
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
    const center = w2s(wx, wy, wz);
    if (center) {
      for (let i = 0; i < pts.length; i++) {
        dl.addTriangleFilled(center, pts[i], pts[(i + 1) % pts.length], col);
      }
    }
  } else {
    for (let i = 0; i < pts.length; i++) {
      dl.addLine(pts[i], pts[(i + 1) % pts.length], col, currentSettings.lineThickness);
    }
  }
  
  return w2s(wx, wy, wz + (entity.boundsZ || currentSettings.boxHeight));
}

function draw3DBox(dl, entity, color, opacity, catSettings = null) {
  const wx = entity.worldX, wy = entity.worldY, wz = getEntityZ(entity, catSettings);
  const hw = currentSettings.useBoundsForSize && entity.boundsX > 0 ? entity.boundsX / 2 : 15;
  const hd = currentSettings.useBoundsForSize && entity.boundsY > 0 ? entity.boundsY / 2 : 15;
  const h = currentSettings.useBoundsForSize && entity.boundsZ > 0 ? entity.boundsZ : currentSettings.boxHeight;
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
  
  return currentY;
}

//=============================================================================
// Entity ESP
//=============================================================================

function drawEntityESP(entity, player, dl) {
  const cat = getEntityCategory(entity);
  const catSettings = getCategorySettings(cat);
  const color = catSettings.color;
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
  
  // Resource bars (HP/ES/Mana) using per-category colors
  const hasBars = catSettings.showHealth || catSettings.showES || catSettings.showMana;
  if (hasBars && (entity.healthMax > 0 || entity.esMax > 0 || entity.manaMax > 0)) {
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

function drawESP() {
  frameCount++;
  debugStats = { total: 0, filtered: 0, drawn: 0, types: {}, errors: [], skippedReasons: {} };
  
  if (!currentSettings.enabled) {
    debugStats.errors.push("ESP disabled");
    return;
  }
  
  const player = POE2Cache.getLocalPlayer();
  if (!player) {
    debugStats.errors.push("No player from cache");
    return;
  }
  if (!player.worldX) {
    debugStats.errors.push("Player has no worldX");
    return;
  }
  
  const entities = poe2.getEntities();
  if (!entities) {
    debugStats.errors.push("No entities from poe2.getEntities()");
    return;
  }
  
  debugStats.total = entities.length;
  const dl = ImGui.getBackgroundDrawList();
  if (!dl) {
    debugStats.errors.push("No draw list");
    return;
  }
  
  // Draw local player bars (HUD)
  drawLocalPlayerBars(player, dl);
  
  // Draw local player world-position bars (above head)
  drawLocalPlayerWorldBars(player, dl);
  
  // Draw entities
  for (const e of entities) {
    const t = e.entityType || 'Unknown';
    debugStats.types[t] = (debugStats.types[t] || 0) + 1;
    
    if (shouldDrawEntity(e, player)) {
      debugStats.filtered++;
      drawEntityESP(e, player, dl);
    }
  }
  
  // Log once every 300 frames (~5 seconds)
  if (frameCount % 300 === 1 && debugStats.total > 0) {
    console.log(`[ESP] Frame ${frameCount}: ${debugStats.total} entities, ${debugStats.filtered} filtered, ${debugStats.drawn} drawn`);
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
    
    // Row 5: Bar colors (only if any bar is enabled)
    if (catSettings.showHealth || catSettings.showES || catSettings.showMana) {
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
      
      const bgColorVar = new ImGui.MutableVariable([...catSettings.colorBarBg]);
      if (ImGui.colorEdit4(`Bar BG##${cat}`, bgColorVar)) {
        const c = colorToArray(bgColorVar.value);
        if (c) saveCategorySetting(cat, 'colorBarBg', c);
      }
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
    const lineVar = new ImGui.MutableVariable(currentSettings.lineThickness);
    if (ImGui.inputInt("##lineT", lineVar)) saveSetting('lineThickness', lineVar.value);
    
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
    } else {
      ImGui.textColored([1, 0.3, 0.3, 1], "No player data!");
    }
  }
  
  ImGui.end();
}

//=============================================================================
// Entry Point
//=============================================================================

function onDraw() {
  loadSettings();
  drawESP();
  drawSettingsUI();
}

export const espPlugin = { onDraw };

console.log("[ESP] Plugin v4 loaded");

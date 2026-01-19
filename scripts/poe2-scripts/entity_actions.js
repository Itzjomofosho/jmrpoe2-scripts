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
  getActiveSkills
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
  autoAttackDistance: 300,
  autoAttackKey: ImGui.Key.E,
  autoAttackKeyCtrl: false,
  autoAttackKeyShift: false,
  autoAttackKeyAlt: false,
  autoAttackYByte: 0x01,
  autoAttackPriority: 0,  // TARGET_PRIORITY.CLOSEST
  autoAttackRarityPriority: 0,  // RARITY_PRIORITY.NONE
  quickActions: []  // Array of custom quick actions
};

// Quick action targeting modes
const QUICK_ACTION_MODES = {
  TARGET: 'target',           // Cast on target entity
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
let lastAutoAttackTime = 0;
const autoAttackCooldown = 100;  // ms between attacks
let lastTargetName = "";
let lastTargetId = 0;
let lastTargetHP = 0;
let lastTargetMaxHP = 0;
let lastTargetRarity = 0;
let isWaitingForKey = false;
let wasAttackKeyDown = false;  // Track key state for release detection

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

const autoAttackPriority = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackPriority);
const autoAttackRarityPriority = new ImGui.MutableVariable(DEFAULT_SETTINGS.autoAttackRarityPriority);

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
function sendAttackBow(entityId) {
  // 01 84 01 80 40 00 40 04 01 FF 08 [ID: 4 bytes big-endian]
  const packet = new Uint8Array([
    0x01, 0x84, 0x01, 0x80, 0x40, 0x00, 0x40, 0x04, 
    0x01, 0xFF, 0x08,
    (entityId >> 24) & 0xFF,  // Big endian: MSB first
    (entityId >> 16) & 0xFF,
    (entityId >> 8) & 0xFF,
    entityId & 0xFF           // LSB last
  ]);
  return poe2.sendPacket(packet);
}

function sendAttackBasic(entityId) {
  // 01 84 01 80 40 00 40 04 03 FF 00 [ID: 4 bytes big-endian]
  const packet = new Uint8Array([
    0x01, 0x84, 0x01, 0x80, 0x40, 0x00, 0x40, 0x04, 
    0x03, 0xFF, 0x00,
    (entityId >> 24) & 0xFF,
    (entityId >> 16) & 0xFF,
    (entityId >> 8) & 0xFF,
    entityId & 0xFF
  ]);
  return poe2.sendPacket(packet);
}

function sendMoveTo(entityId) {
  // 01 84 01 20 00 C2 66 04 02 FF 08 [ID: 4 bytes big-endian]
  // Example: ID=110 (0x6E) = 01 84 01 20 00 C2 66 04 02 FF 08 00 00 00 6E
  const packet = new Uint8Array([
    0x01, 0x84, 0x01, 0x20, 0x00, 0xC2, 0x66, 0x04, 
    0x02, 0xFF, 0x08,
    (entityId >> 24) & 0xFF,  // Big endian: 00 00 00 6E for ID=110
    (entityId >> 16) & 0xFF,
    (entityId >> 8) & 0xFF,
    entityId & 0xFF
  ]);
  return poe2.sendPacket(packet);
}

// Send stop/end action packet (called on key release)
function sendStopAction() {
  const packet = new Uint8Array([0x01, 0x8B, 0x01]);
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

function processAutoAttack() {
  if (!autoAttackEnabled.value) {
    wasAttackKeyDown = false;
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
  
  const isKeyDown = modifiersOk && ImGui.isKeyDown(autoAttackKey.value);
  
  // Detect key release: was down, now up -> send stop action
  if (wasAttackKeyDown && !isKeyDown) {
    sendStopAction();
    wasAttackKeyDown = false;
    return;
  }
  
  // Update key state
  wasAttackKeyDown = isKeyDown;
  
  // If key not down, nothing to do
  if (!isKeyDown) return;
  
  const now = Date.now();
  if (now - lastAutoAttackTime < autoAttackCooldown) return;
  
  // Use cached player and entities for performance
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) return;
  
  // Get all entities (no distance filter for now - debug why filtering fails)
  const allEntities = POE2Cache.getEntities(0);
  
  // Find alive monsters within auto-attack distance
  const targets = [];
  
  for (const entity of allEntities) {
    if (!entity.gridX || entity.isLocalPlayer) continue;
    if (entity.entityType !== 'Monster') continue;
    if (!entity.isAlive) continue;
    if (!entity.id || entity.id === 0) continue;
    
    // Distance check
    const dx = entity.gridX - player.gridX;
    const dy = entity.gridY - player.gridY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > autoAttackDistance.value) continue;
    
    // Skip friendly and hidden monsters
    if (entity.entitySubtype === 'MonsterFriendly') continue;
    if (hasBuffContaining(entity, 'hidden_monster')) continue;
    
    targets.push({ entity: entity, distance: dist });
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
    
    // Execute rotation on selected target
    const target = targets[0];
    lastTargetName = target.entity.name || "Unknown";
    lastTargetId = target.entity.id;
    lastTargetHP = target.entity.healthCurrent || 0;
    lastTargetMaxHP = target.entity.healthMax || 0;
    lastTargetRarity = target.entity.rarity || 0;
    
    // Try rotation builder first (if any rotations exist)
    const usedRotation = executeRotationOnTarget(target.entity, target.distance);
    
    // Fallback to simple bow attack if no rotation matched
    if (!usedRotation) {
      const yByte = autoAttackYByte.value;
      const packet = new Uint8Array([
        0x01, 0x84, 0x01, 0x80, 0x40, 0x00, 0x40, 0x04, 
        yByte & 0xFF, 0xFF, 0x08,
        (target.entity.id >> 24) & 0xFF,
        (target.entity.id >> 16) & 0xFF,
        (target.entity.id >> 8) & 0xFF,
        target.entity.id & 0xFF
      ]);
      
      poe2.sendPacket(packet);
    }
    
    lastAutoAttackTime = now;
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
        // Get target entity and calculate direction toward it
        const targets = POE2Cache.getEntities(qa.distance || 300);
        let target = null;
        for (const e of targets) {
          if (e.entityType === 'Monster' && e.isAlive && e.id) {
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
        
      case QUICK_ACTION_MODES.TARGET:
      default: {
        // Find target entity
        const targets = POE2Cache.getEntities(qa.distance || 300);
        let target = null;
        for (const e of targets) {
          if (e.entityType === 'Monster' && e.isAlive && e.id) {
            target = e;
            break;
          }
        }
        
        if (target) {
          const targetPacket = buildTargetPacket(packetBytes, target.id);
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
    { id: QUICK_ACTION_MODES.TARGET, label: "Target Entity" },
    { id: QUICK_ACTION_MODES.SELF, label: "Self" },
    { id: QUICK_ACTION_MODES.DIRECTION_TO_TARGET, label: "Direction to Target" },
    { id: QUICK_ACTION_MODES.CURSOR, label: "Cursor Direction" }
  ];
  
  for (let m = 0; m < modes.length; m++) {
    if (ImGui.radioButton(modes[m].label + "##qam", qaSelectedMode === m)) {
      qaSelectedMode = m;
    }
    if (m < modes.length - 1) ImGui.sameLine();
  }
  
  // Distance (for directional modes)
  if (qaSelectedMode === 2 || qaSelectedMode === 3) {
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
    case QUICK_ACTION_MODES.SELF: return "Self";
    case QUICK_ACTION_MODES.DIRECTION_TO_TARGET: return "Dir→Target";
    case QUICK_ACTION_MODES.CURSOR: return "Cursor";
    default: return mode || "Target";
  }
}

function onDraw() {
  // NOTE: Do NOT call POE2Cache.beginFrame() here!
  // It should only be called ONCE per frame in main.js
  // The cache now detects duplicate calls and warns about them
  
  // Load player settings if not loaded or player changed
  loadPlayerSettings();
  
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
  
  // Get all entities for UI display (no distance filter - let JS handle it)
  const allEntities = POE2Cache.getEntities(0);
  
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
    
    ImGui.text("While holding key, attack monsters:");
    
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
    if (ImGui.isKeyDown(autoAttackKey.value)) {
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
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], `- Ready (hold ${getKeyName(autoAttackKey.value)})`);
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
        const success = sendMoveTo(entity.id);
        console.log(`Move to entity ${idHex} (${shortName}) - success=${success}`);
      }
      ImGui.sameLine();
      
      if (ImGui.button("Basic Attack")) {
        const success = sendAttackBasic(entity.id);
        console.log(`Basic attack entity ${idHex} (${shortName}) - success=${success}`);
      }
      ImGui.sameLine();
      
      if (ImGui.button("Attack (Bow)")) {
        const success = sendAttackBow(entity.id);
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


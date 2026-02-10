/**
 * Pickit Plugin - Advanced Item Filter
 * 
 * Automatically picks up items based on customizable filter rules.
 * Features:
 * - Rule-based filtering (similar to Rotation Builder)
 * - Inventory space checking before pickup
 * - Filter by path, base name, rarity, stack size, grid size
 * - Persistent settings per player
 * 
 * PERFORMANCE OPTIMIZED: Uses shared POE2Cache for per-frame caching
 */

import { POE2Cache, poe2 } from './poe2_cache.js';
import { Settings } from './Settings.js';

// Plugin name for settings
const PLUGIN_NAME = 'pickit';
const FILTERS_FILE = 'pickit_filters.json';

// Rarity values
const RARITY = {
  NORMAL: 0,
  MAGIC: 1,
  RARE: 2,
  UNIQUE: 3
};

const RARITY_LABELS = ['Normal', 'Magic', 'Rare', 'Unique'];
const RARITY_COLORS = [
  [0.8, 0.8, 0.8, 1.0],  // Normal - White/Gray
  [0.5, 0.5, 1.0, 1.0],  // Magic - Blue
  [1.0, 1.0, 0.0, 1.0],  // Rare - Yellow
  [1.0, 0.5, 0.0, 1.0]   // Unique - Orange
];

// Condition types for item filtering
const CONDITION_TYPES = [
  { id: 'path_contains', label: 'Path contains', valueType: 'string', hint: 'currency, maps, weapons' },
  { id: 'path_not_contains', label: 'Path NOT contains', valueType: 'string', hint: 'flask, gem' },
  { id: 'base_name_contains', label: 'Base name contains', valueType: 'string', hint: 'Tier 15, Gold Ring' },
  { id: 'base_name_not_contains', label: 'Base name NOT contains', valueType: 'string', hint: 'Crude, Rusted' },
  { id: 'unique_name_contains', label: 'Unique name contains', valueType: 'string', hint: 'Headhunter' },
  { id: 'rarity', label: 'Rarity', valueType: 'rarity', hint: '' },
  { id: 'rarity_min', label: 'Rarity at least', valueType: 'rarity', hint: '' },
  { id: 'stack_size_min', label: 'Stack size at least', valueType: 'number', hint: '5' },
  { id: 'grid_size_max', label: 'Grid size at most (w*h)', valueType: 'number', hint: '4' },
];

const OPERATORS = ['==', '!=', '>=', '<=', '>', '<', 'contains', 'not contains'];

// Default settings
const DEFAULT_SETTINGS = {
  enabled: false,
  maxDistance: 50,
  retryDelayMs: 2000,
  maxAttempts: 3,
  checkInventorySpace: true,
  showDebugInfo: false
};

// Current settings
let currentSettings = { ...DEFAULT_SETTINGS };
let currentPlayerName = null;
let settingsLoaded = false;

// Filter rules (loaded from file)
let filterRules = [];
let currentFilterSetName = "default";
let availableFilterSets = [];

// UI state
let editingRuleIndex = -1;
let selectedConditionType = 0;
const newRuleName = new ImGui.MutableVariable("New Rule");
const conditionStringValue = new ImGui.MutableVariable("");
const conditionNumberValue = new ImGui.MutableVariable(0);
let selectedRarityValue = 0;
const filterSetNameInput = new ImGui.MutableVariable("default");

// Settings MutableVariables
const enabled = new ImGui.MutableVariable(DEFAULT_SETTINGS.enabled);
const maxDistance = new ImGui.MutableVariable(DEFAULT_SETTINGS.maxDistance);
const retryDelayMs = new ImGui.MutableVariable(DEFAULT_SETTINGS.retryDelayMs);
const maxAttempts = new ImGui.MutableVariable(DEFAULT_SETTINGS.maxAttempts);
const checkInventorySpace = new ImGui.MutableVariable(DEFAULT_SETTINGS.checkInventorySpace);
const showDebugInfo = new ImGui.MutableVariable(DEFAULT_SETTINGS.showDebugInfo);

// Pickup tracking
let pickupAttempts = new Map();
let lastAreaHash = null;

// Last pickup info
let lastPickupInfo = {
  name: "",
  path: "",
  id: 0,
  distance: 0,
  attempt: 0,
  time: 0,
  ruleName: "",
  blocked: false,
  blockReason: ""
};

// Stats
let stats = {
  itemsPickedUp: 0,
  itemsBlocked: 0,
  inventoryFullCount: 0
};

/**
 * Load filter rules from file
 */
function loadFilterRules() {
  try {
    const data = fs.readFile(FILTERS_FILE);
    if (data) {
      const parsed = JSON.parse(data);
      availableFilterSets = Object.keys(parsed);
      filterRules = parsed[currentFilterSetName] || [];
      console.log(`[Pickit] Loaded ${filterRules.length} filter rules for set: ${currentFilterSetName}`);
    }
  } catch (e) {
    console.log("[Pickit] No saved filters, starting with defaults");
    filterRules = getDefaultFilters();
    availableFilterSets = [];
  }
}

/**
 * Save filter rules to file
 */
function saveFilterRules() {
  try {
    let allFilterSets = {};
    try {
      const existing = fs.readFile(FILTERS_FILE);
      if (existing) {
        allFilterSets = JSON.parse(existing);
      }
    } catch (e) {}
    
    allFilterSets[currentFilterSetName] = filterRules;
    fs.writeFile(FILTERS_FILE, JSON.stringify(allFilterSets, null, 2));
    
    // Update available list
    availableFilterSets = Object.keys(allFilterSets);
    console.log(`[Pickit] Saved ${filterRules.length} filter rules`);
  } catch (e) {
    console.error("[Pickit] Failed to save filters:", e);
  }
}

/**
 * Switch filter set
 */
function switchFilterSet(setName) {
  saveFilterRules();
  currentFilterSetName = setName;
  loadFilterRules();
}

/**
 * Get default filter rules for common use cases
 */
function getDefaultFilters() {
  return [
    {
      enabled: true,
      name: "Currency Items",
      conditions: [
        { type: 'path_contains', value: 'currency' }
      ]
    },
    {
      enabled: false,
      name: "Maps (Any)",
      conditions: [
        { type: 'path_contains', value: 'maps' }
      ]
    },
    {
      enabled: false,
      name: "Maps T15+ Only",
      conditions: [
        { type: 'path_contains', value: 'maps' },
        { type: 'base_name_contains', value: 'Tier 15' }
      ]
    },
    {
      enabled: false,
      name: "Rare+ Items",
      conditions: [
        { type: 'rarity_min', value: RARITY.RARE }
      ]
    },
    {
      enabled: false,
      name: "Unique Items",
      conditions: [
        { type: 'rarity', value: RARITY.UNIQUE }
      ]
    }
  ];
}

/**
 * Load player settings
 */
function loadPlayerSettings() {
  const player = POE2Cache.getLocalPlayer();
  if (!player || !player.playerName) return false;
  
  if (currentPlayerName !== player.playerName) {
    currentPlayerName = player.playerName;
    currentSettings = Settings.get(PLUGIN_NAME, DEFAULT_SETTINGS);
    
    enabled.value = currentSettings.enabled;
    maxDistance.value = currentSettings.maxDistance;
    retryDelayMs.value = currentSettings.retryDelayMs;
    maxAttempts.value = currentSettings.maxAttempts;
    checkInventorySpace.value = currentSettings.checkInventorySpace;
    showDebugInfo.value = currentSettings.showDebugInfo;
    
    // Load filter rules
    loadFilterRules();
    
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
 * Check for area change
 */
function checkAreaChange() {
  const areaChangeCount = POE2Cache.getAreaChangeCount();
  const newHash = `area_${areaChangeCount}`;
  
  if (lastAreaHash !== newHash) {
    if (lastAreaHash !== null) {
      console.log(`[Pickit] Area changed, clearing pickup cache`);
      pickupAttempts.clear();
    }
    lastAreaHash = newHash;
  }
}

/**
 * Check if inventory has space for an item
 */
function canFitItem(gridWidth, gridHeight) {
  if (!checkInventorySpace.value) return true;
  
  try {
    // Get main inventory (ID 1)
    const inv = poe2.getInventory(1);
    if (!inv || !inv.isValid) {
      // Try alternate IDs
      const inv2 = poe2.getMainInventory();
      if (!inv2 || !inv2.isValid) return true; // Assume can fit if can't read
    }
    
    const inventory = inv && inv.isValid ? inv : poe2.getMainInventory();
    if (!inventory || !inventory.isValid) return true;
    
    const width = inventory.totalBoxesX || 12;
    const height = inventory.totalBoxesY || 5;
    
    // Build occupancy grid
    const occupied = new Array(width * height).fill(false);
    
    for (const item of inventory.items || []) {
      if (!item.hasItem) continue;
      for (let y = item.slotY; y < item.slotEndY && y < height; y++) {
        for (let x = item.slotX; x < item.slotEndX && x < width; x++) {
          occupied[y * width + x] = true;
        }
      }
    }
    
    // Try to find space for the new item
    for (let y = 0; y <= height - gridHeight; y++) {
      for (let x = 0; x <= width - gridWidth; x++) {
        let canPlace = true;
        for (let dy = 0; dy < gridHeight && canPlace; dy++) {
          for (let dx = 0; dx < gridWidth && canPlace; dx++) {
            if (occupied[(y + dy) * width + (x + dx)]) {
              canPlace = false;
            }
          }
        }
        if (canPlace) return true;
      }
    }
    
    return false;
  } catch (e) {
    console.error("[Pickit] Error checking inventory:", e);
    return true; // Assume can fit on error
  }
}

/**
 * Evaluate a single condition against an item
 */
function evaluateCondition(condition, item) {
  const { type, value } = condition;
  const strValue = (value || "").toString().toLowerCase();
  
  switch (type) {
    case 'path_contains':
      return (item.path || item.name || "").toLowerCase().includes(strValue);
      
    case 'path_not_contains':
      return !(item.path || item.name || "").toLowerCase().includes(strValue);
      
    case 'base_name_contains':
      return (item.baseName || "").toLowerCase().includes(strValue);
      
    case 'base_name_not_contains':
      return !(item.baseName || "").toLowerCase().includes(strValue);
      
    case 'unique_name_contains':
      return (item.uniqueName || "").toLowerCase().includes(strValue);
      
    case 'rarity':
      return item.rarity === value;
      
    case 'rarity_min':
      return item.rarity >= value;
      
    case 'stack_size_min':
      return (item.stackSize || 0) >= value;
      
    case 'grid_size_max':
      const gridSize = (item.gridWidth || 1) * (item.gridHeight || 1);
      return gridSize <= value;
      
    default:
      return false;
  }
}

/**
 * Check if an item matches any enabled filter rule
 */
function matchesFilterRules(item) {
  // Must be a WorldItem entity with valid item data
  // Check entityPath for "WorldItem" OR hasWorldItem flag OR non-empty worldItemName path
  const isWorldItem = (item.entityPath || "").toLowerCase().includes('worlditem') || 
                      item.hasWorldItem || 
                      (item.path && item.path.length > 0);
  
  if (!isWorldItem) return { matches: false };
  
  // Check each enabled rule
  for (const rule of filterRules) {
    if (!rule.enabled) continue;
    
    // Rules with no conditions = match everything (pick all)
    if (!rule.conditions || rule.conditions.length === 0) {
      return { matches: true, ruleName: rule.name };
    }
    
    // All conditions in a rule must match (AND logic)
    let allMatch = true;
    for (const condition of rule.conditions) {
      if (!evaluateCondition(condition, item)) {
        allMatch = false;
        break;
      }
    }
    
    if (allMatch) {
      return { matches: true, ruleName: rule.name };
    }
  }
  
  return { matches: false };
}

/**
 * Get item data from entity (WorldItem properties)
 */
function getItemData(entity) {
  return {
    // worldItemName is the actual item path from WorldItem component (e.g., "Metadata/Items/Currency/...")
    // entity.name is just "Metadata/MiscellaneousObjects/WorldItem"
    path: entity.worldItemName || "",
    entityPath: entity.name || "",
    baseName: entity.worldItemBaseName || "",
    uniqueName: entity.worldItemUniqueName || "",
    rarity: entity.worldItemRarity !== undefined ? entity.worldItemRarity : -1,
    stackSize: entity.worldItemStackSize || 0,
    gridWidth: entity.worldItemGridWidth || 1,
    gridHeight: entity.worldItemGridHeight || 1,
    hasWorldItem: entity.hasWorldItem || false
  };
}

/**
 * Get display name for an item
 */
function getItemDisplayName(item) {
  if (item.uniqueName) return item.uniqueName;
  if (item.baseName) {
    if (item.stackSize > 1) return `${item.stackSize}x ${item.baseName}`;
    return item.baseName;
  }
  // Extract name from item path (worldItemName)
  const parts = (item.path || "Unknown").split('/');
  return parts[parts.length - 1];
}

/**
 * Validate that an entity is still valid and targetable
 * This prevents crashes from sending packets for stale/despawned entities
 */
function isEntityStillValid(entity) {
  // Basic null/undefined checks
  if (!entity) return false;
  if (!entity.id || entity.id === 0) return false;
  
  // Check if entity has valid position data
  if (entity.gridX === undefined || entity.gridY === undefined) return false;
  if (isNaN(entity.gridX) || isNaN(entity.gridY)) return false;
  
  // Check targetable flag - if entity is no longer targetable, it may have despawned
  // or been picked up by another player
  if (entity.isTargetable === false) return false;
  
  // Check if entity address is still valid (non-zero)
  if (entity.address === 0 || entity.address === undefined) return false;
  
  return true;
}

/**
 * Check if item is reachable via line of sight
 * Uses terrain walkability data to prevent picking items behind walls
 */
function isItemReachable(player, entity, maxDist) {
  // If line of sight function is available, use it
  if (typeof poe2.isWithinLineOfSight === 'function') {
    try {
      const playerGridX = Math.floor(player.gridX);
      const playerGridY = Math.floor(player.gridY);
      const entityGridX = Math.floor(entity.gridX);
      const entityGridY = Math.floor(entity.gridY);
      
      return poe2.isWithinLineOfSight(
        playerGridX, 
        playerGridY, 
        entityGridX, 
        entityGridY, 
        maxDist
      );
    } catch (e) {
      // If line of sight check fails, assume reachable to avoid blocking valid pickups
      if (showDebugInfo.value) {
        console.log(`[Pickit] Line of sight check failed: ${e}`);
      }
      return true;
    }
  }
  
  // Fallback: if function not available, assume reachable
  return true;
}

/**
 * Send pickup packet
 */
function sendPickupPacket(entityId) {
  // Ensure entityId is a valid 32-bit unsigned integer
  const safeId = entityId >>> 0;  // Convert to unsigned 32-bit
  
  const packet = new Uint8Array([
    0x01, 0x90, 0x01, 0x20, 0x00, 0xC2, 0x66, 0x04,
    0x00, 0xFF, 0x08,
    (safeId >> 24) & 0xFF,
    (safeId >> 16) & 0xFF,
    (safeId >> 8) & 0xFF,
    safeId & 0xFF
  ]);
  return poe2.sendPacket(packet);
}

/**
 * Process auto-pickup logic
 */
function processAutoPickup() {
  if (!enabled.value) return;
  
  checkAreaChange();
  
  const now = Date.now();
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) return;
  
  // PERFORMANCE: Only query Item-type entities - dramatically reduces processing in juiced maps
  // This skips reading WorldItem components for monsters, NPCs, chests, etc.
  const allEntities = POE2Cache.getEntities({ 
    type: "Item", 
    maxDistance: maxDistance.value * 1.5 
  });
  
  // Build a set of currently valid entity IDs for quick lookup
  const currentEntityIds = new Set();
  for (const e of allEntities) {
    if (e.id && e.id !== 0) {
      currentEntityIds.add(e.id);
    }
  }
  
  // Clean up stale tracking entries - entities that no longer exist or have max attempts
  if (POE2Cache.getFrameNumber() % 30 === 0) {  // More frequent cleanup (every 0.5s at 60fps)
    for (const [itemId, data] of pickupAttempts.entries()) {
      // Remove tracking for entities that no longer exist in the current entity list
      if (!currentEntityIds.has(itemId)) {
        pickupAttempts.delete(itemId);
        continue;
      }
      // Remove entries that have exceeded max attempts
      if (data.attempts >= maxAttempts.value) {
        pickupAttempts.delete(itemId);
      }
    }
  }
  
  // Find items to pickup
  const itemsToPickup = [];
  
  for (const entity of allEntities) {
    if (!entity.gridX || entity.isLocalPlayer) continue;
    if (!entity.id || entity.id === 0) continue;
    if (entity.isTargetable !== true) continue;
    
    // Get item data
    const itemData = getItemData(entity);
    
    // Check filter rules
    const result = matchesFilterRules(itemData);
    if (!result.matches) continue;
    
    // Calculate distance
    const dx = entity.gridX - player.gridX;
    const dy = entity.gridY - player.gridY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxDistance.value) continue;
    
    // Check attempt tracking
    const attemptData = pickupAttempts.get(entity.id);
    if (attemptData) {
      if (attemptData.attempts >= maxAttempts.value) continue;
      if (now - attemptData.lastAttemptTime < retryDelayMs.value) continue;
    }
    
    itemsToPickup.push({
      entity,
      itemData,
      distance: dist,
      ruleName: result.ruleName
    });
  }
  
  if (itemsToPickup.length === 0) return;
  
  // Sort by distance (closest first)
  itemsToPickup.sort((a, b) => a.distance - b.distance);
  
  // Try to pickup items, starting with the closest
  for (const target of itemsToPickup) {
    const entity = target.entity;
    const itemId = entity.id;
    const itemData = target.itemData;
    
    // CRITICAL: Validate entity is still valid before sending packet
    // This prevents crashes from sending packets for stale/despawned entities
    if (!isEntityStillValid(entity)) {
      if (showDebugInfo.value) {
        console.log(`[Pickit] Entity ${itemId} no longer valid, skipping`);
      }
      pickupAttempts.delete(itemId);
      continue;  // Try next item
    }
    
    // Check line of sight / reachability (soft check - don't permanently block items)
    // Terrain data may not be 100% accurate, so we just add a delay rather than blocking forever
    if (!isItemReachable(player, entity, maxDistance.value)) {
      if (showDebugInfo.value) {
        console.log(`[Pickit] Item ${getItemDisplayName(itemData)} may not be reachable - will retry after delay`);
      }
      // Add a longer delay before retrying this item, but don't mark as permanently unreachable
      let attemptData = pickupAttempts.get(itemId);
      if (!attemptData) {
        attemptData = { attempts: 0, lastAttemptTime: 0, unreachable: false };
        pickupAttempts.set(itemId, attemptData);
      }
      // Set a longer delay (2x normal) but don't mark as unreachable
      attemptData.lastAttemptTime = now + retryDelayMs.value;  // Extra delay
      continue;  // Try next item
    }
    
    // Check inventory space
    if (checkInventorySpace.value) {
      const canFit = canFitItem(itemData.gridWidth, itemData.gridHeight);
      if (!canFit) {
        lastPickupInfo = {
          name: getItemDisplayName(itemData),
          path: itemData.path,
          id: itemId,
          distance: target.distance,
          attempt: 0,
          time: now,
          ruleName: target.ruleName,
          blocked: true,
          blockReason: `No space for ${itemData.gridWidth}x${itemData.gridHeight} item`
        };
        stats.inventoryFullCount++;
        return;  // Stop processing - inventory is full
      }
    }
    
    // Final validation right before sending packet
    // Re-check that entity still exists in current frame's entity list
    if (!currentEntityIds.has(itemId)) {
      if (showDebugInfo.value) {
        console.log(`[Pickit] Entity ${itemId} disappeared before pickup, skipping`);
      }
      continue;
    }
    
    // Get or create attempt data
    let attemptData = pickupAttempts.get(itemId);
    if (!attemptData) {
      attemptData = { attempts: 0, lastAttemptTime: 0, unreachable: false };
      pickupAttempts.set(itemId, attemptData);
    }
    
    attemptData.attempts++;
    attemptData.lastAttemptTime = now;
    
    // Update last pickup info
    lastPickupInfo = {
      name: getItemDisplayName(itemData),
      path: itemData.path,
      id: itemId,
      distance: target.distance,
      attempt: attemptData.attempts,
      time: now,
      ruleName: target.ruleName,
      blocked: false,
      blockReason: ""
    };
    
    if (showDebugInfo.value) {
      console.log(`[Pickit] Picking up: ${lastPickupInfo.name} (Rule: ${target.ruleName})`);
      console.log(`[Pickit]   Item path: ${itemData.path}`);
      console.log(`[Pickit]   Entity ID: ${itemId}, Address: 0x${entity.address?.toString(16) || 'N/A'}`);
      console.log(`[Pickit]   Base: ${itemData.baseName}, Rarity: ${itemData.rarity}, Stack: ${itemData.stackSize}`);
    }
    
    sendPickupPacket(itemId);
    stats.itemsPickedUp++;
    
    // Only pickup one item per frame to avoid spam
    return;
  }
}

/**
 * Draw the filter rules UI
 */
function drawFilterRulesUI() {
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Filter Rules");
  ImGui.separator();
  
  // Filter set management
  ImGui.text(`Current Filter Set: ${currentFilterSetName}`);
  
  if (ImGui.collapsingHeader("Filter Set Management")) {
    ImGui.text("Save As:");
    ImGui.inputText("##filtername", filterSetNameInput);
    ImGui.sameLine();
    if (ImGui.button("Save")) {
      currentFilterSetName = filterSetNameInput.value || "default";
      saveFilterRules();
    }
    
    ImGui.separator();
    ImGui.text("Load Filter Set:");
    
    if (availableFilterSets.length > 0) {
      for (const setName of availableFilterSets) {
        const isCurrent = (setName === currentFilterSetName);
        if (isCurrent) {
          ImGui.textColored([0.5, 1.0, 0.5, 1.0], `- ${setName} (current)`);
        } else {
          if (ImGui.button(setName + "##load")) {
            switchFilterSet(setName);
          }
        }
      }
    } else {
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], "(No saved filter sets)");
    }
    
    ImGui.separator();
    if (ImGui.button("Reset to Defaults")) {
      filterRules = getDefaultFilters();
      saveFilterRules();
    }
  }
  
  ImGui.separator();
  
  // Add new rule
  if (ImGui.collapsingHeader("Add New Rule")) {
    ImGui.text("Rule Name:");
    ImGui.inputText("##newrulename", newRuleName);
    
    if (ImGui.button("Add Rule")) {
      filterRules.push({
        enabled: true,
        name: newRuleName.value || `Rule ${filterRules.length + 1}`,
        conditions: []
      });
      saveFilterRules();
      newRuleName.value = "New Rule";
    }
  }
  
  ImGui.separator();
  
  // Rules list
  ImGui.text(`Filter Rules (${filterRules.length}):`);
  ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Items matching ANY enabled rule will be picked up");
  
  ImGui.beginChild("RulesList", {x: 0, y: 350}, ImGui.ChildFlags.Border);
  
  for (let i = 0; i < filterRules.length; i++) {
    const rule = filterRules[i];
    
    ImGui.pushID(i);
    
    // Enable/disable toggle
    const enabledColor = rule.enabled ? [0.2, 0.7, 0.2, 1.0] : [0.5, 0.5, 0.5, 1.0];
    ImGui.pushStyleColor(ImGui.Col.Button, enabledColor);
    if (ImGui.button(rule.enabled ? "ON" : "OFF", {x: 35, y: 0})) {
      rule.enabled = !rule.enabled;
      saveFilterRules();
    }
    ImGui.popStyleColor(1);
    ImGui.sameLine();
    
    // Rule name
    const nameColor = rule.enabled ? [0.5, 1.0, 0.5, 1.0] : [0.5, 0.5, 0.5, 1.0];
    ImGui.textColored(nameColor, `${i + 1}. ${rule.name}`);
    
    // Show conditions
    if (rule.conditions && rule.conditions.length > 0) {
      for (let c = 0; c < rule.conditions.length; c++) {
        const cond = rule.conditions[c];
        const condType = CONDITION_TYPES.find(t => t.id === cond.type);
        const label = condType ? condType.label : cond.type;
        
        let valueStr = cond.value;
        if (cond.type === 'rarity' || cond.type === 'rarity_min') {
          valueStr = RARITY_LABELS[cond.value] || cond.value;
        }
        
        ImGui.pushID(`cond${c}`);
        ImGui.text("   ");
        ImGui.sameLine();
        if (ImGui.button("X", {x: 20, y: 0})) {
          rule.conditions.splice(c, 1);
          saveFilterRules();
        }
        ImGui.sameLine();
        ImGui.textColored([0.8, 0.8, 0.8, 1.0], `${label}: ${valueStr}`);
        ImGui.popID();
      }
    } else {
      ImGui.textColored([0.5, 1.0, 0.5, 1.0], "   (No conditions = PICK ALL)");
    }
    
    // Action buttons
    const isEditing = (editingRuleIndex === i);
    if (ImGui.button(isEditing ? "Done" : "Edit")) {
      editingRuleIndex = isEditing ? -1 : i;
    }
    ImGui.sameLine();
    if (ImGui.button("Delete")) {
      filterRules.splice(i, 1);
      if (editingRuleIndex === i) editingRuleIndex = -1;
      saveFilterRules();
    }
    ImGui.sameLine();
    if (i > 0 && ImGui.button("Up")) {
      [filterRules[i], filterRules[i-1]] = [filterRules[i-1], filterRules[i]];
      if (editingRuleIndex === i) editingRuleIndex = i - 1;
      saveFilterRules();
    }
    ImGui.sameLine();
    if (i < filterRules.length - 1 && ImGui.button("Down")) {
      [filterRules[i], filterRules[i+1]] = [filterRules[i+1], filterRules[i]];
      if (editingRuleIndex === i) editingRuleIndex = i + 1;
      saveFilterRules();
    }
    
    // Condition editor
    if (isEditing) {
      ImGui.indent();
      ImGui.separator();
      ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Add Condition:");
      
      // Condition type
      ImGui.text("Type:");
      for (let ct = 0; ct < CONDITION_TYPES.length; ct++) {
        if (ImGui.radioButton(CONDITION_TYPES[ct].label + "##ct", selectedConditionType === ct)) {
          selectedConditionType = ct;
        }
      }
      
      // Value input based on type
      const selectedType = CONDITION_TYPES[selectedConditionType];
      ImGui.text("Value:");
      
      if (selectedType.valueType === 'string') {
        ImGui.inputTextWithHint("##condval", conditionStringValue, selectedType.hint);
      } else if (selectedType.valueType === 'rarity') {
        for (let r = 0; r < RARITY_LABELS.length; r++) {
          if (ImGui.radioButton(RARITY_LABELS[r] + "##rar", selectedRarityValue === r)) {
            selectedRarityValue = r;
          }
          if (r < RARITY_LABELS.length - 1) ImGui.sameLine();
        }
      } else if (selectedType.valueType === 'number') {
        ImGui.inputInt("##condnum", conditionNumberValue);
      }
      
      if (ImGui.button("Add Condition")) {
        let value;
        if (selectedType.valueType === 'string') {
          value = conditionStringValue.value;
        } else if (selectedType.valueType === 'rarity') {
          value = selectedRarityValue;
        } else {
          value = conditionNumberValue.value;
        }
        
        if (!rule.conditions) rule.conditions = [];
        rule.conditions.push({
          type: selectedType.id,
          value: value
        });
        saveFilterRules();
      }
      
      ImGui.unindent();
    }
    
    ImGui.separator();
    ImGui.popID();
  }
  
  ImGui.endChild();
}

/**
 * Main draw function
 */
function onDraw() {
  loadPlayerSettings();
  processAutoPickup();
  
  if (!Plugins.isUiVisible()) return;
  
  ImGui.setNextWindowSize({x: 500, y: 650}, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({x: 1350, y: 370}, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowCollapsed(true, ImGui.Cond.Once);
  
  if (!ImGui.begin("Auto Pickit", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) {
    ImGui.textColored([1.0, 0.5, 0.5, 1.0], "Waiting for player...");
    ImGui.end();
    return;
  }
  
  // Tab bar
  if (!ImGui.beginTabBar("PickitTabs", ImGui.TabBarFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Tab 1: Settings
  if (ImGui.beginTabItem("Settings")) {
    ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Auto Item Pickup");
    ImGui.separator();
    
    // Enable toggle
    const prevEnabled = enabled.value;
    ImGui.checkbox("Enable Auto-Pickup", enabled);
    if (prevEnabled !== enabled.value) {
      saveSetting('enabled', enabled.value);
    }
    
    if (enabled.value) {
      ImGui.sameLine();
      ImGui.textColored([0.5, 1.0, 0.5, 1.0], "** ACTIVE **");
    }
    
    ImGui.separator();
    ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Settings:");
    
    const prevDist = maxDistance.value;
    ImGui.sliderInt("Max Distance", maxDistance, 20, 150);
    if (prevDist !== maxDistance.value) saveSetting('maxDistance', maxDistance.value);
    
    const prevRetry = retryDelayMs.value;
    ImGui.sliderInt("Retry Delay (ms)", retryDelayMs, 500, 5000);
    if (prevRetry !== retryDelayMs.value) saveSetting('retryDelayMs', retryDelayMs.value);
    
    const prevAttempts = maxAttempts.value;
    ImGui.sliderInt("Max Attempts", maxAttempts, 1, 10);
    if (prevAttempts !== maxAttempts.value) saveSetting('maxAttempts', maxAttempts.value);
    
    const prevCheckInv = checkInventorySpace.value;
    ImGui.checkbox("Check Inventory Space", checkInventorySpace);
    if (prevCheckInv !== checkInventorySpace.value) saveSetting('checkInventorySpace', checkInventorySpace.value);
    
    const prevDebug = showDebugInfo.value;
    ImGui.checkbox("Show Debug Info", showDebugInfo);
    if (prevDebug !== showDebugInfo.value) saveSetting('showDebugInfo', showDebugInfo.value);
    
    ImGui.separator();
    ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Status:");
    
    ImGui.text(`Tracked items: ${pickupAttempts.size}`);
    ImGui.text(`Items picked up: ${stats.itemsPickedUp}`);
    ImGui.text(`Inventory full blocks: ${stats.inventoryFullCount}`);
    
    // Last pickup info
    if (lastPickupInfo.time > 0) {
      ImGui.separator();
      ImGui.textColored([0.8, 0.8, 1.0, 1.0], "Last Pickup:");
      ImGui.text(`  ${lastPickupInfo.name}`);
      ImGui.text(`  Rule: ${lastPickupInfo.ruleName}`);
      ImGui.text(`  Distance: ${lastPickupInfo.distance.toFixed(1)}`);
      
      if (lastPickupInfo.blocked) {
        ImGui.textColored([1.0, 0.5, 0.5, 1.0], `  BLOCKED: ${lastPickupInfo.blockReason}`);
      } else {
        ImGui.text(`  Attempt: ${lastPickupInfo.attempt}/${maxAttempts.value}`);
      }
      
      // Show item path for debugging
      if (showDebugInfo.value && lastPickupInfo.path) {
        ImGui.textColored([0.6, 0.6, 0.8, 1.0], `  Path: ${lastPickupInfo.path}`);
      }
      
      const timeAgo = ((Date.now() - lastPickupInfo.time) / 1000).toFixed(1);
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], `  (${timeAgo}s ago)`);
    }
    
    ImGui.separator();
    if (ImGui.button("Clear Cache")) {
      pickupAttempts.clear();
      console.log("[Pickit] Cache cleared");
    }
    ImGui.sameLine();
    if (ImGui.button("Reset Stats")) {
      stats = { itemsPickedUp: 0, itemsBlocked: 0, inventoryFullCount: 0 };
    }
    
    ImGui.endTabItem();
  }
  
  // Tab 2: Filter Rules
  if (ImGui.beginTabItem("Filter Rules")) {
    drawFilterRulesUI();
    ImGui.endTabItem();
  }
  
  // Tab 3: Inventory
  if (ImGui.beginTabItem("Inventory")) {
    ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Inventory Space Check");
    ImGui.separator();
    
    try {
      const inv = poe2.getInventory(1);
      const mainInv = poe2.getMainInventory();
      const useInv = (inv && inv.isValid) ? inv : mainInv;
      
      if (useInv && useInv.isValid) {
        const width = useInv.totalBoxesX || 12;
        const height = useInv.totalBoxesY || 5;
        
        ImGui.text(`Inventory Size: ${width}x${height}`);
        ImGui.text(`Items: ${(useInv.items || []).length}`);
        
        // Count free slots
        const occupied = new Array(width * height).fill(false);
        for (const item of useInv.items || []) {
          if (!item.hasItem) continue;
          for (let y = item.slotY; y < item.slotEndY && y < height; y++) {
            for (let x = item.slotX; x < item.slotEndX && x < width; x++) {
              occupied[y * width + x] = true;
            }
          }
        }
        
        const freeSlots = occupied.filter(o => !o).length;
        ImGui.text(`Free slots: ${freeSlots}/${width * height}`);
        
        // Test space for common sizes
        ImGui.separator();
        ImGui.text("Can fit:");
        for (const [w, h, label] of [[1, 1, "1x1"], [2, 1, "2x1"], [1, 2, "1x2"], [2, 2, "2x2"], [2, 3, "2x3"], [2, 4, "2x4"]]) {
          const canFit = canFitItem(w, h);
          const color = canFit ? [0.5, 1.0, 0.5, 1.0] : [1.0, 0.5, 0.5, 1.0];
          ImGui.textColored(color, `  ${label}: ${canFit ? 'Yes' : 'No'}`);
        }
      } else {
        ImGui.textColored([1.0, 0.5, 0.5, 1.0], "Could not read inventory");
      }
    } catch (e) {
      ImGui.textColored([1.0, 0.5, 0.5, 1.0], `Error: ${e}`);
    }
    
    ImGui.endTabItem();
  }
  
  ImGui.endTabBar();
  ImGui.end();
}

export const pickitPlugin = {
  onDraw: onDraw
};

console.log("[Pickit] Plugin loaded with filter rules system");

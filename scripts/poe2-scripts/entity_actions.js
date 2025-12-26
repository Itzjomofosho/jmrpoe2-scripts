/**
 * Entity Actions Plugin
 * 
 * Shows nearby entities with buttons to move/attack
 * Includes rotation builder for custom skill sequences
 * 
 * PERFORMANCE OPTIMIZED: Uses shared POE2Cache for per-frame caching
 */

import { POE2Cache, poe2 } from './poe2_cache.js';
import { drawRotationTab, executeRotationOnTarget, initialize as initializeRotations } from './rotation_builder.js';

// Initialize rotation system
initializeRotations();

// Settings
const maxDistance = new ImGui.MutableVariable(500);
const maxEntities = new ImGui.MutableVariable(10);
const filterMonsters = new ImGui.MutableVariable(false);  // Start with all filters OFF
const filterChests = new ImGui.MutableVariable(false);
const filterNPCs = new ImGui.MutableVariable(false);
const filterWorldItems = new ImGui.MutableVariable(false);

// Auto-attack settings
const autoAttackEnabled = new ImGui.MutableVariable(false);
const autoAttackDistance = new ImGui.MutableVariable(300);
const autoAttackClosest = new ImGui.MutableVariable(true);  // true = closest, false = furthest
const autoAttackKey = new ImGui.MutableVariable(ImGui.Key.E);  // Default to E
const autoAttackYByte = new ImGui.MutableVariable(0x01);  // Default y byte value
let lastAutoAttackTime = 0;
const autoAttackCooldown = 100;  // ms between attacks
let lastTargetName = "";
let lastTargetId = 0;
let isWaitingForKey = false;

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

// Common bindable keys for easy selection
const COMMON_KEYS = [
  ImGui.Key.E, ImGui.Key.Space, ImGui.Key.T, ImGui.Key.X,
  ImGui.Key.F1, ImGui.Key.F2, ImGui.Key.F3, ImGui.Key.F4,
  ImGui.Key.Q, ImGui.Key.R, ImGui.Key.F, ImGui.Key.G
];

function getKeyName(key) {
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
  // Example: ID=110 (0x6E) → 01 84 01 20 00 C2 66 04 02 FF 08 00 00 00 6E
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

// Auto-attack logic (runs ALWAYS, even when window is collapsed)
// Uses cached player and entities data for performance
function processAutoAttack(player, allEntities) {
  if (!autoAttackEnabled.value) return;
  if (!ImGui.isKeyDown(autoAttackKey.value)) return;
  
  const now = Date.now();
  if (now - lastAutoAttackTime < autoAttackCooldown) return;
  
  if (!player || player.gridX === undefined) return;
  if (!allEntities) return;
  
  // Find alive monsters within auto-attack distance
  const targets = [];
  
  for (const entity of allEntities) {
    if (!entity.gridX || entity.isLocalPlayer) continue;
    if (entity.entityType !== 'Monster') continue;
    if (!entity.isAlive) continue;
    if (!entity.id || entity.id === 0) continue;
    
    const dx = entity.gridX - player.gridX;
    const dy = entity.gridY - player.gridY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist <= autoAttackDistance.value) {
      targets.push({ entity: entity, distance: dist });
    }
  }
  
  if (targets.length > 0) {
    // Sort by distance (closest or furthest based on preference)
    targets.sort((a, b) => autoAttackClosest.value ? 
      a.distance - b.distance :  // Closest first
      b.distance - a.distance);  // Furthest first
    
    // Execute rotation on selected target
    const target = targets[0];
    lastTargetName = target.entity.name || "Unknown";
    lastTargetId = target.entity.id;
    
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

function onDraw() {
  // Begin frame - invalidates all per-frame caches
  POE2Cache.beginFrame();
  
  // Get player and entities ONCE per frame using cache
  const player = POE2Cache.getLocalPlayer();
  const allEntities = POE2Cache.getEntities();
  
  // Auto-attack runs FIRST, before any window checks
  // Pass cached data to avoid redundant calls
  processAutoAttack(player, allEntities);
  
  // Now render the UI window
  ImGui.setNextWindowSize({x: 500, y: 700}, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({x: 10, y: 100}, ImGui.Cond.FirstUseEver);
  
  if (!ImGui.begin("Entity Actions", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Use cached player for UI display
  if (!player || player.gridX === undefined) {
    ImGui.textColored([1.0, 0.5, 0.5, 1.0], "Waiting for player...");
    ImGui.end();
    return;
  }
  
  // Filter and sort by distance (using cached entities)
  const nearbyEntities = [];
  
  if (allEntities) {
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
    ImGui.checkbox("Enable Auto-Attack", autoAttackEnabled);
  
  if (autoAttackEnabled.value) {
    ImGui.indent();
    
    ImGui.text("While holding key, attack monsters:");
    
    // Key binding UI
    ImGui.text(`Attack Key: ${getKeyName(autoAttackKey.value)}`);
    ImGui.text("Quick Select:");
    for (let k = 0; k < COMMON_KEYS.length; k++) {
      if (ImGui.button(getKeyName(COMMON_KEYS[k]) + "##key" + k, {x: 50, y: 20})) {
        autoAttackKey.value = COMMON_KEYS[k];
      }
      if ((k + 1) % 4 !== 0 && k < COMMON_KEYS.length - 1) {
        ImGui.sameLine();
      }
    }
    
    ImGui.sliderInt("Attack Distance", autoAttackDistance, 50, 1000);
    
    ImGui.text("Target Priority:");
    if (ImGui.radioButton("Closest First", autoAttackClosest.value)) {
      autoAttackClosest.value = true;
    }
    ImGui.sameLine();
    if (ImGui.radioButton("Furthest First", !autoAttackClosest.value)) {
      autoAttackClosest.value = false;
    }
    
    ImGui.text(`Attack Byte: 0x${autoAttackYByte.value.toString(16).toUpperCase().padStart(2, '0')} (packet byte 8)`);
    ImGui.inputInt("##ybyte", autoAttackYByte, 1, 16);
    if (autoAttackYByte.value < 0) autoAttackYByte.value = 0;
    if (autoAttackYByte.value > 255) autoAttackYByte.value = 255;
    
    // Show status
    if (ImGui.isKeyDown(autoAttackKey.value)) {
      ImGui.textColored([0.5, 1.0, 0.5, 1.0], "** ATTACKING **");
      if (lastTargetName) {
        const shortName = lastTargetName.split('/').pop() || lastTargetName;
        const idHex = lastTargetId ? `0x${lastTargetId.toString(16).toUpperCase()}` : "NO_ID";
        ImGui.text(`  Target: ${shortName} (${idHex})`);
      }
    } else {
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], `- Ready (hold ${getKeyName(autoAttackKey.value)})`);
    }
    
    ImGui.unindent();
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

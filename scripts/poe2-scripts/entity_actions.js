/**
 * Entity Actions Plugin
 * 
 * Shows nearby entities with buttons to move/attack
 */

const poe2 = new POE2();

// Settings
const maxDistance = new ImGui.MutableVariable(500);
const maxEntities = new ImGui.MutableVariable(10);
const filterMonsters = new ImGui.MutableVariable(false);  // Start with all filters OFF
const filterChests = new ImGui.MutableVariable(false);
const filterNPCs = new ImGui.MutableVariable(false);
const filterWorldItems = new ImGui.MutableVariable(false);

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

function onDraw() {
  ImGui.setNextWindowSize({x: 500, y: 600}, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({x: 10, y: 100}, ImGui.Cond.FirstUseEver);
  
  if (!ImGui.begin("Entity Actions", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Get player
  const player = poe2.getLocalPlayer();
  if (!player || player.gridX === undefined) {
    ImGui.textColored([1.0, 0.5, 0.5, 1.0], "Waiting for player...");
    ImGui.end();
    return;
  }
  
  // Get all entities
  const allEntities = poe2.getEntities();
  
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
  
  // Settings
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
  ImGui.end();
}

export const entityActionsPlugin = {
  onDraw: onDraw
};

console.log("Entity Actions plugin loaded");


/**
 * Inventory Viewer
 * 
 * Displays player inventory contents with item information.
 * Useful for debugging and developing pickit plugins.
 */

const poe2 = new POE2();

// Rarity names
const RARITY_NAMES = ['Normal', 'Magic', 'Rare', 'Unique'];
const RARITY_COLORS = [
  [0.8, 0.8, 0.8, 1.0],   // Normal - white/gray
  [0.2, 0.4, 1.0, 1.0],   // Magic - blue
  [1.0, 1.0, 0.2, 1.0],   // Rare - yellow
  [1.0, 0.5, 0.0, 1.0],   // Unique - orange
];

// Configuration
let showInventoryViewer = true;
let selectedInventoryId = 2; // Main inventory
let selectedItemAddress = 0;
let lastInventoryInfo = null;

// Extract short name from path
function getShortName(path) {
  if (!path) return '<unknown>';
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

// Draw inventory grid
function drawInventoryGrid(inventory) {
  if (!inventory.isValid) {
    ImGui.textColored([1.0, 0.3, 0.3, 1.0], "Invalid inventory");
    return;
  }
  
  const boxSize = 28;
  const spacing = 2;
  
  ImGui.text(`Grid: ${inventory.totalBoxesX} x ${inventory.totalBoxesY}`);
  ImGui.text(`Items: ${inventory.items ? inventory.items.length : 0}`);
  
  // Build a quick lookup of items by position
  const itemAtSlot = {};
  if (inventory.items) {
    for (const item of inventory.items) {
      const key = `${item.slotX},${item.slotY}`;
      itemAtSlot[key] = item;
    }
  }
  
  // Draw grid
  const startPos = ImGui.getCursorScreenPos();
  const drawList = ImGui.getWindowDrawList();
  
  for (let y = 0; y < inventory.totalBoxesY; y++) {
    for (let x = 0; x < inventory.totalBoxesX; x++) {
      const posX = startPos.x + x * (boxSize + spacing);
      const posY = startPos.y + y * (boxSize + spacing);
      const key = `${x},${y}`;
      const item = itemAtSlot[key];
      
      // Determine box color based on item
      let fillColor, borderColor;
      if (item) {
        const rarity = item.rarity || 0;
        fillColor = makeColorABGR(RARITY_COLORS[rarity][0] * 0.3, RARITY_COLORS[rarity][1] * 0.3, RARITY_COLORS[rarity][2] * 0.3, 0.8);
        borderColor = makeColorABGR(RARITY_COLORS[rarity][0], RARITY_COLORS[rarity][1], RARITY_COLORS[rarity][2], 1.0);
      } else {
        fillColor = makeColorABGR(0.2, 0.2, 0.2, 0.5);
        borderColor = makeColorABGR(0.4, 0.4, 0.4, 1.0);
      }
      
      // Draw slot
      drawList.addRectFilled({ x: posX, y: posY }, { x: posX + boxSize, y: posY + boxSize }, fillColor);
      drawList.addRect({ x: posX, y: posY }, { x: posX + boxSize, y: posY + boxSize }, borderColor, 0, 0, 1.0);
      
      // Check if slot is clicked
      if (item && ImGui.isMouseClicked(0)) {
        const mousePos = ImGui.getMousePos();
        if (mousePos.x >= posX && mousePos.x <= posX + boxSize &&
            mousePos.y >= posY && mousePos.y <= posY + boxSize) {
          selectedItemAddress = item.itemAddress;
        }
      }
    }
  }
  
  // Reserve space for grid
  ImGui.dummy({ x: inventory.totalBoxesX * (boxSize + spacing), y: inventory.totalBoxesY * (boxSize + spacing) });
}

// Create ABGR color for ImGui
function makeColorABGR(r, g, b, a) {
  return ((Math.floor(a * 255) << 24) | (Math.floor(b * 255) << 16) | (Math.floor(g * 255) << 8) | Math.floor(r * 255)) >>> 0;
}

// Draw item details
function drawItemDetails(item) {
  ImGui.separator();
  ImGui.text("Selected Item:");
  
  const rarityColor = RARITY_COLORS[item.rarity || 0];
  ImGui.textColored(rarityColor, `${RARITY_NAMES[item.rarity || 0]} Item`);
  
  ImGui.text(`Path: ${item.itemPath}`);
  ImGui.text(`Short Name: ${getShortName(item.itemPath)}`);
  ImGui.text(`Slot: (${item.slotX}, ${item.slotY})`);
  ImGui.text(`Address: 0x${item.itemAddress.toString(16).toUpperCase()}`);
  
  // Try to read mods
  const mods = poe2.getItemMods(item.itemAddress);
  if (mods && mods.isValid) {
    ImGui.separator();
    ImGui.text(`Rarity: ${mods.rarityName || RARITY_NAMES[mods.rarity]}`);
    
    if (mods.implicitMods && mods.implicitMods.length > 0) {
      ImGui.text("Implicit Mods:");
      for (const mod of mods.implicitMods) {
        ImGui.textColored([0.6, 0.6, 1.0, 1.0], `  ${mod.name}: ${mod.value0}`);
      }
    }
    
    if (mods.explicitMods && mods.explicitMods.length > 0) {
      ImGui.text("Explicit Mods:");
      for (const mod of mods.explicitMods) {
        ImGui.textColored([0.2, 0.8, 1.0, 1.0], `  ${mod.name}: ${mod.value0}`);
      }
    }
    
    if (mods.enchantMods && mods.enchantMods.length > 0) {
      ImGui.text("Enchant Mods:");
      for (const mod of mods.enchantMods) {
        ImGui.textColored([1.0, 0.5, 1.0, 1.0], `  ${mod.name}: ${mod.value0}`);
      }
    }
  }
}

// Main draw function
function onDraw() {
  if (!showInventoryViewer) return;
  
  ImGui.setNextWindowSize({ x: 400, y: 500 }, ImGui.Cond.FirstUseEver);
  
  if (!ImGui.begin("Inventory Viewer", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Inventory type selector
  ImGui.text("Inventory:");
  ImGui.sameLine();
  if (ImGui.button("Flasks (1)")) selectedInventoryId = 1;
  ImGui.sameLine();
  if (ImGui.button("Main 1 (2)")) selectedInventoryId = 2;
  ImGui.sameLine();
  if (ImGui.button("Main 2 (3)")) selectedInventoryId = 3;
  
  ImGui.separator();
  
  // Get inventory data
  let inventory;
  if (selectedInventoryId === 1) {
    inventory = poe2.getFlaskInventory();
  } else {
    inventory = poe2.getInventory(selectedInventoryId);
  }
  lastInventoryInfo = inventory;
  
  if (!inventory || !inventory.isValid) {
    ImGui.textColored([1.0, 0.5, 0.2, 1.0], "No inventory data available");
    ImGui.text("(Open your inventory in-game)");
    ImGui.end();
    return;
  }
  
  // Draw inventory grid
  drawInventoryGrid(inventory);
  
  // Draw item list
  ImGui.separator();
  ImGui.text("Items:");
  
  if (inventory.items && inventory.items.length > 0) {
    if (ImGui.beginChild("ItemList", { x: 0, y: 200 }, true, ImGui.WindowFlags.None)) {
      for (const item of inventory.items) {
        const rarityColor = RARITY_COLORS[item.rarity || 0];
        const shortName = getShortName(item.itemPath);
        const isSelected = item.itemAddress === selectedItemAddress;
        
        if (isSelected) {
          ImGui.pushStyleColor(ImGui.Col.Text, [1.0, 1.0, 1.0, 1.0]);
        }
        
        const selectableFlags = isSelected ? ImGui.SelectableFlags.None : ImGui.SelectableFlags.None;
        if (ImGui.selectable(`[${item.slotX},${item.slotY}] ${shortName}##${item.itemAddress}`, isSelected, selectableFlags, { x: 0, y: 0 })) {
          selectedItemAddress = item.itemAddress;
        }
        
        if (isSelected) {
          ImGui.popStyleColor(1);
        }
        
        // Show rarity color indicator
        ImGui.sameLine(280);
        ImGui.textColored(rarityColor, RARITY_NAMES[item.rarity || 0]);
      }
      ImGui.endChild();
    }
  } else {
    ImGui.text("(No items)");
  }
  
  // Show selected item details
  if (selectedItemAddress && inventory.items) {
    const selectedItem = inventory.items.find(i => i.itemAddress === selectedItemAddress);
    if (selectedItem) {
      drawItemDetails(selectedItem);
    }
  }
  
  ImGui.end();
}

// Export plugin
export const inventoryViewerPlugin = {
  onDraw: onDraw
};

console.log("Inventory Viewer loaded");


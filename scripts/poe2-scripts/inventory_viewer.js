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

// Inventory names (from GameHelper2's Inventories.dat)
const INVENTORY_NAMES = {
  0: "NoInvSelected",
  1: "MainInventory1",
  2: "BodyArmour1",
  3: "Weapon1",
  4: "Offhand1",
  5: "Helm1",
  6: "Amulet1",
  7: "Ring1",
  8: "Ring2",
  9: "Gloves1",
  10: "Boots1",
  11: "Belt1",
  12: "Flask1",
  13: "Cursor1",
  14: "Map1",
  15: "Weapon2",
  16: "Offhand2",
  24: "PassiveJewels1",
  27: "StashInventoryId",
  112: "Tower1",
  113: "ExpandedInventory1",
};

// Configuration
let showInventoryViewer = true;
let selectedInventoryId = 1; // MainInventory1
let selectedItemAddress = 0;
let lastInventoryInfo = null;
let cachedInventories = [];
let lastCacheTime = 0;
const CACHE_INTERVAL = 500; // ms

// Extract short name from path (fallback only)
function getShortNameFromPath(path) {
  if (!path) return '<unknown>';
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

// Get best display name for an item
// Priority: uniqueName > baseName > extracted from path
function getItemDisplayName(item) {
  if (item.uniqueName && item.uniqueName.length > 0) {
    return item.uniqueName;  // e.g., "Zerphis Genesis"
  }
  if (item.baseName && item.baseName.length > 0) {
    return item.baseName;  // e.g., "Armoured Vest"
  }
  return getShortNameFromPath(item.itemPath);
}

// Get item grid size - always use slot-based size which is reliable
function getItemGridSize(item) {
  // Slot-based size is always reliable (from InventoryItemStruct: slotEndX - slotX)
  return {
    width: item.width || 1,
    height: item.height || 1
  };
}

// Draw inventory grid
function drawInventoryGrid(inventory) {
  if (!inventory.isValid) {
    ImGui.textColored([1.0, 0.3, 0.3, 1.0], "Invalid inventory");
    return;
  }
  
  const cellSize = 28;
  const cellSpacing = 2;
  const itemPadding = 2;  // Padding inside item border
  
  ImGui.text(`Grid: ${inventory.totalBoxesX} x ${inventory.totalBoxesY}`);
  ImGui.text(`Items: ${inventory.items ? inventory.items.length : 0}`);
  
  const startPos = ImGui.getCursorScreenPos();
  const drawList = ImGui.getWindowDrawList();
  
  // Calculate total grid size
  const gridWidth = inventory.totalBoxesX * (cellSize + cellSpacing) - cellSpacing;
  const gridHeight = inventory.totalBoxesY * (cellSize + cellSpacing) - cellSpacing;
  
  // Draw background grid (empty slots)
  for (let y = 0; y < inventory.totalBoxesY; y++) {
    for (let x = 0; x < inventory.totalBoxesX; x++) {
      const posX = startPos.x + x * (cellSize + cellSpacing);
      const posY = startPos.y + y * (cellSize + cellSpacing);
      
      // Empty slot background
      const bgColor = makeColorABGR(0.15, 0.15, 0.15, 0.6);
      const borderColor = makeColorABGR(0.3, 0.3, 0.3, 0.8);
      
      drawList.addRectFilled(
        { x: posX, y: posY }, 
        { x: posX + cellSize, y: posY + cellSize }, 
        bgColor
      );
      drawList.addRect(
        { x: posX, y: posY }, 
        { x: posX + cellSize, y: posY + cellSize }, 
        borderColor, 0, 0, 1.0
      );
    }
  }
  
  // Draw items as single rectangles spanning their full size
  if (inventory.items) {
    for (const item of inventory.items) {
      const w = item.width || 1;
      const h = item.height || 1;
      const rarity = item.rarity || 0;
      const isSelected = item.itemAddress === selectedItemAddress;
      
      // Calculate item rectangle position (spanning multiple cells)
      const itemX = startPos.x + item.slotX * (cellSize + cellSpacing);
      const itemY = startPos.y + item.slotY * (cellSize + cellSpacing);
      const itemW = w * cellSize + (w - 1) * cellSpacing;
      const itemH = h * cellSize + (h - 1) * cellSpacing;
      
      // Item colors
      const rarityColor = RARITY_COLORS[rarity];
      const fillColor = makeColorABGR(
        rarityColor[0] * 0.25, 
        rarityColor[1] * 0.25, 
        rarityColor[2] * 0.25, 
        0.9
      );
      const borderColor = makeColorABGR(
        rarityColor[0], 
        rarityColor[1], 
        rarityColor[2], 
        1.0
      );
      const highlightColor = makeColorABGR(1.0, 1.0, 1.0, 0.3);
      
      // Draw item fill
      drawList.addRectFilled(
        { x: itemX + itemPadding, y: itemY + itemPadding }, 
        { x: itemX + itemW - itemPadding, y: itemY + itemH - itemPadding }, 
        fillColor
      );
      
      // Draw item border (thicker for selected)
      const borderThickness = isSelected ? 3.0 : 2.0;
      drawList.addRect(
        { x: itemX + itemPadding, y: itemY + itemPadding }, 
        { x: itemX + itemW - itemPadding, y: itemY + itemH - itemPadding }, 
        isSelected ? makeColorABGR(1.0, 1.0, 1.0, 1.0) : borderColor,
        2.0,  // rounding
        0,
        borderThickness
      );
      
      // Draw item size indicator in corner for multi-slot items
      if (w > 1 || h > 1) {
        const sizeText = `${w}x${h}`;
        const textX = itemX + itemW - itemPadding - 18;
        const textY = itemY + itemH - itemPadding - 14;
        // Background for text
        drawList.addRectFilled(
          { x: textX - 2, y: textY - 1 },
          { x: textX + 18, y: textY + 12 },
          makeColorABGR(0, 0, 0, 0.7)
        );
        // addText signature: (text, pos, col)
        drawList.addText(sizeText, { x: textX, y: textY }, makeColorABGR(0.7, 0.7, 0.7, 1.0));
      }
      
      // Draw stack size in top-left corner
      if (item.stackSize && item.stackSize > 1) {
        const stackText = String(item.stackSize);
        const textX = itemX + itemPadding + 3;
        const textY = itemY + itemPadding + 1;
        // Background for text
        drawList.addRectFilled(
          { x: textX - 2, y: textY - 1 },
          { x: textX + stackText.length * 7 + 4, y: textY + 12 },
          makeColorABGR(0, 0, 0, 0.7)
        );
        // addText signature: (text, pos, col)
        drawList.addText(stackText, { x: textX, y: textY }, makeColorABGR(0.5, 1.0, 0.5, 1.0));
      }
      
      // Check if item is clicked
      if (ImGui.isMouseClicked(0)) {
        const mousePos = ImGui.getMousePos();
        if (mousePos.x >= itemX && mousePos.x <= itemX + itemW &&
            mousePos.y >= itemY && mousePos.y <= itemY + itemH) {
          selectedItemAddress = item.itemAddress;
        }
      }
      
      // Hover highlight
      const mousePos = ImGui.getMousePos();
      if (mousePos.x >= itemX && mousePos.x <= itemX + itemW &&
          mousePos.y >= itemY && mousePos.y <= itemY + itemH) {
        drawList.addRectFilled(
          { x: itemX + itemPadding, y: itemY + itemPadding }, 
          { x: itemX + itemW - itemPadding, y: itemY + itemH - itemPadding }, 
          highlightColor
        );
        
        // Show tooltip with item name
        ImGui.beginTooltip();
        const displayName = getItemDisplayName(item) || '<unknown>';
        ImGui.textColored(RARITY_COLORS[rarity], displayName);
        if (item.stackSize && item.stackSize > 1) {
          ImGui.text(`Stack: ${item.stackSize}`);
        }
        ImGui.endTooltip();
      }
    }
  }
  
  // Reserve space for grid
  ImGui.dummy({ x: gridWidth + cellSpacing, y: gridHeight + cellSpacing });
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
  const displayName = getItemDisplayName(item);
  const { width, height } = getItemGridSize(item);
  
  // Show item name with rarity color
  ImGui.textColored(rarityColor, `${RARITY_NAMES[item.rarity || 0]} Item`);
  
  // Debug: Log to console what we're getting from C++
  console.log(`[InvViewer] Item at ${item.slotX},${item.slotY}: baseName="${item.baseName}" uniqueName="${item.uniqueName}" baseGrid=${item.baseGridWidth}x${item.baseGridHeight}`);
  
  // Show unique name if available (for unique items)
  if (item.uniqueName && item.uniqueName.length > 0) {
    ImGui.textColored(RARITY_COLORS[3], `Unique Name: ${item.uniqueName}`);
  }
  
  // Show base name if available
  if (item.baseName && item.baseName.length > 0) {
    ImGui.text(`Base Type: ${item.baseName}`);
  }
  
  // Debug: Always show these lines in UI so we can see what C++ is sending
  ImGui.text(`baseName: "${item.baseName !== undefined ? item.baseName : 'UNDEFINED'}"`);
  ImGui.text(`uniqueName: "${item.uniqueName !== undefined ? item.uniqueName : 'UNDEFINED'}"`);
  ImGui.text(`baseGrid: ${item.baseGridWidth}x${item.baseGridHeight}`);
  
  ImGui.text(`Path: ${item.itemPath}`);
  ImGui.text(`Short Name: ${getShortNameFromPath(item.itemPath)}`);
  ImGui.text(`Slot: (${item.slotX}, ${item.slotY}) - Size: ${width}x${height}`);
  
  // Show stack size if item is stackable
  if (item.stackSize && item.stackSize > 0) {
    ImGui.textColored([0.5, 1.0, 0.5, 1.0], `Stack: ${item.stackSize}`);
  }
  
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

// Get inventory name for display
function getInventoryDisplayName(id, name) {
  if (name && name !== "Unknown") {
    return `${id}: ${name}`;
  }
  return INVENTORY_NAMES[id] || `Inventory ${id}`;
}

// Debug info
let lastError = "";
let debugInfo = "";

// Refresh inventory cache
function refreshInventoryCache() {
  const now = Date.now();
  if (now - lastCacheTime < CACHE_INTERVAL) {
    return;
  }
  lastCacheTime = now;
  
  try {
    cachedInventories = poe2.getAllInventories() || [];
    lastError = "";
    debugInfo = `getAllInventories returned ${cachedInventories.length} inventories`;
  } catch (e) {
    cachedInventories = [];
    lastError = String(e);
    debugInfo = "Exception in getAllInventories";
  }
}

// Main draw function
function onDraw() {
  if (!showInventoryViewer) return;
  
  ImGui.setNextWindowSize({ x: 450, y: 600 }, ImGui.Cond.FirstUseEver);
  
  if (!ImGui.begin("Inventory Viewer", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Refresh cache periodically
  refreshInventoryCache();
  
  // Quick access buttons
  ImGui.text("Quick Access:");
  if (ImGui.button("Main Inv")) selectedInventoryId = 1;
  ImGui.sameLine();
  if (ImGui.button("Flasks")) selectedInventoryId = 12;
  ImGui.sameLine();
  if (ImGui.button("Weapon1")) selectedInventoryId = 3;
  ImGui.sameLine();
  if (ImGui.button("Helm")) selectedInventoryId = 5;
  ImGui.sameLine();
  if (ImGui.button("Body")) selectedInventoryId = 2;
  
  ImGui.separator();
  
  // Inventory dropdown selector
  if (cachedInventories.length > 0) {
    ImGui.text("Available Inventories:");
    
    // Build combo items
    const currentInvIndex = cachedInventories.findIndex(inv => inv.inventoryId === selectedInventoryId);
    const currentLabel = currentInvIndex >= 0 
      ? getInventoryDisplayName(cachedInventories[currentInvIndex].inventoryId, cachedInventories[currentInvIndex].inventoryName)
      : `Select (current: ${selectedInventoryId})`;
    
    if (ImGui.beginCombo("##invSelector", currentLabel, ImGui.ComboFlags.None)) {
      for (const inv of cachedInventories) {
        const label = getInventoryDisplayName(inv.inventoryId, inv.inventoryName);
        const isSelected = inv.inventoryId === selectedInventoryId;
        if (ImGui.selectable(`${label}##${inv.inventoryId}`, isSelected)) {
          selectedInventoryId = inv.inventoryId;
        }
      }
      ImGui.endCombo();
    }
    
    ImGui.text(`Total inventories found: ${cachedInventories.length}`);
  } else {
    ImGui.textColored([1.0, 0.5, 0.2, 1.0], "No inventories available");
    ImGui.text("(Are you in-game?)");
    
    // Debug info
    ImGui.separator();
    ImGui.textColored([0.5, 0.5, 0.5, 1.0], "Debug Info:");
    ImGui.text(`Debug: ${debugInfo}`);
    if (lastError) {
      ImGui.textColored([1.0, 0.3, 0.3, 1.0], `Error: ${lastError}`);
    }
    
    // Try to get more diagnostic info
    try {
      const mainInv = poe2.getMainInventory();
      ImGui.text(`getMainInventory: isValid=${mainInv ? mainInv.isValid : 'null'}`);
    } catch (e) {
      ImGui.text(`getMainInventory error: ${e}`);
    }
    
    try {
      const flaskInv = poe2.getFlaskInventory();
      ImGui.text(`getFlaskInventory: isValid=${flaskInv ? flaskInv.isValid : 'null'}`);
    } catch (e) {
      ImGui.text(`getFlaskInventory error: ${e}`);
    }
    
    // Check game state
    try {
      const areaInfo = poe2.getAreaInfo();
      ImGui.text(`getAreaInfo: isValid=${areaInfo ? areaInfo.isValid : 'null'}`);
      if (areaInfo && areaInfo.isValid) {
        ImGui.text(`Area: ${areaInfo.areaName || 'unknown'}`);
      }
    } catch (e) {
      ImGui.text(`getAreaInfo error: ${e}`);
    }
    
    try {
      const stateIdx = poe2.getGameStateIndex();
      ImGui.text(`getGameStateIndex: ${stateIdx}`);
    } catch (e) {
      ImGui.text(`getGameStateIndex error: ${e}`);
    }
  }
  
  ImGui.separator();
  
  // Get selected inventory data
  let inventory = cachedInventories.find(inv => inv.inventoryId === selectedInventoryId);
  
  // Fallback to direct fetch if not in cache
  if (!inventory) {
    inventory = poe2.getInventory(selectedInventoryId);
  }
  lastInventoryInfo = inventory;
  
  if (!inventory || !inventory.isValid) {
    ImGui.textColored([1.0, 0.5, 0.2, 1.0], `Inventory ${selectedInventoryId} not available`);
    ImGui.end();
    return;
  }
  
  // Show inventory info
  const invName = inventory.inventoryName || INVENTORY_NAMES[inventory.inventoryId] || "Unknown";
  ImGui.textColored([0.4, 0.8, 1.0, 1.0], `${invName} (ID: ${inventory.inventoryId})`);
  
  // Draw inventory grid
  drawInventoryGrid(inventory);
  
  // Draw slot grid visualization
  if (inventory.slotGrid && inventory.slotGrid.length > 0) {
    ImGui.separator();
    if (ImGui.treeNode("Slot Grid (Raw)")) {
      let gridStr = "";
      for (let y = 0; y < inventory.totalBoxesY; y++) {
        let row = "";
        for (let x = 0; x < inventory.totalBoxesX; x++) {
          const idx = y * inventory.totalBoxesX + x;
          row += inventory.slotGrid[idx] ? "1 " : "0 ";
        }
        gridStr += row + "\n";
      }
      ImGui.text(gridStr);
      ImGui.treePop();
    }
  }
  
  // Draw item list
  ImGui.separator();
  ImGui.text(`Items: ${inventory.items ? inventory.items.length : 0}`);
  
  if (inventory.items && inventory.items.length > 0) {
    if (ImGui.beginChild("ItemList", { x: 0, y: 180 }, ImGui.ChildFlags.Border)) {
      for (const item of inventory.items) {
        const rarityColor = RARITY_COLORS[item.rarity || 0];
        const displayName = getItemDisplayName(item);
        const isSelected = item.itemAddress === selectedItemAddress;
        
        if (isSelected) {
          ImGui.pushStyleColor(ImGui.Col.Text, [1.0, 1.0, 1.0, 1.0]);
        }
        
        // Include stack size in display if stackable
        const stackText = (item.stackSize && item.stackSize > 0) ? ` (x${item.stackSize})` : '';
        
        if (ImGui.selectable(`[${item.slotX},${item.slotY}] ${displayName}${stackText}##${item.itemAddress}`, isSelected)) {
          selectedItemAddress = item.itemAddress;
        }
        
        if (isSelected) {
          ImGui.popStyleColor(1);
        }
        
        // Show rarity color indicator
        ImGui.sameLine(300);
        ImGui.textColored(rarityColor, RARITY_NAMES[item.rarity || 0]);
      }
      ImGui.endChild();
    }
  } else {
    ImGui.text("(No items in this inventory)");
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

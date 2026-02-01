/**
 * Inventory Viewer
 * 
 * Displays player inventory contents with item information.
 * Useful for debugging and developing pickit plugins.
 */

import { Settings } from './Settings.js';

const poe2 = new POE2();
const PLUGIN_NAME = 'inventory_viewer';

// Window state persistence
let windowCollapsed = true;  // Start collapsed by default
let settingsLoaded = false;

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
  ////console.log(`[InvViewer] Item at ${item.slotX},${item.slotY}: baseName="${item.baseName}" uniqueName="${item.uniqueName}" baseGrid=${item.baseGridWidth}x${item.baseGridHeight}`);
  
  // Show unique name if available (for unique items)
  if (item.uniqueName && item.uniqueName.length > 0) {
    ImGui.textColored(RARITY_COLORS[3], `Unique Name: ${item.uniqueName}`);
  }
  
  // Show base name if available
  if (item.baseName && item.baseName.length > 0) {
    ImGui.text(`Base Type: ${item.baseName}`);
  }
  
  ImGui.text(`Path: ${item.itemPath}`);
  ImGui.text(`Short Name: ${getShortNameFromPath(item.itemPath)}`);
  ImGui.text(`Slot: (${item.slotX}, ${item.slotY}) - Size: ${width}x${height}`);
  
  // Show stack size if item is stackable
  if (item.stackSize && item.stackSize > 0) {
    ImGui.textColored([0.5, 1.0, 0.5, 1.0], `Stack: ${item.stackSize}`);
  }
  
  // Item Slot Handle - the network packet identifier!
  const slotHandle = item.itemSlotHandle || 0;
  ImGui.textColored([1.0, 1.0, 0.0, 1.0], `Slot Handle: 0x${slotHandle.toString(16).toUpperCase()} (${slotHandle})`);
  
  ImGui.text(`Address: 0x${item.itemAddress.toString(16).toUpperCase()}`);
  
  // =====================================================
  // ITEM HANDLE HOOK SECTION
  // =====================================================
  ImGui.separator();
  ImGui.textColored([1.0, 1.0, 0.0, 1.0], "Item Handle Hook:");
  
  const addr = item.itemAddress;
  ImGui.text(`Item Address: 0x${addr.toString(16).toUpperCase()}`);
  ImGui.text(`Current Slot: (${item.slotX}, ${item.slotY})`);
  
  // Hook status and controls
  const hookActive = poe2.isItemHandleHookActive();
  if (hookActive) {
    ImGui.textColored([0.0, 1.0, 0.0, 1.0], "Hook Status: ACTIVE");
  } else {
    ImGui.textColored([1.0, 0.5, 0.0, 1.0], "Hook Status: Not Active");
    if (ImGui.button("Initialize Hook")) {
      const success = poe2.initItemHandleHook();
      if (success) {
        //console.log("[ItemHandleHook] Hook initialized successfully!");
      } else {
        //console.log("[ItemHandleHook] Failed to initialize hook - check logs");
      }
    }
  }
  
  // Show last pickup info
  ImGui.separator();
  ImGui.textColored([0.0, 1.0, 1.0, 1.0], "Last Pickup Captured:");
  
  const lastPickup = poe2.getLastPickup();
  if (lastPickup && lastPickup.timestamp > 0) {
    ImGui.text(`Inventory: ${lastPickup.inventoryId}`);
    ImGui.text(`Slot Index: ${lastPickup.slotIndex}`);
    ImGui.textColored([0.0, 1.0, 0.0, 1.0], `HANDLE: ${lastPickup.itemHandleHex || '0x' + lastPickup.itemHandle.toString(16).toUpperCase().padStart(8, '0')}`);
    ImGui.text(`Stack Count: ${lastPickup.stackCount}`);
    ImGui.text(`Shift Held: ${lastPickup.shiftHeld}`);
    
    // Show pointer chain
    if (ImGui.collapsingHeader("Pointer Details##pickup")) {
      ImGui.text(`Game Object: 0x${lastPickup.gameObject.toString(16).toUpperCase()}`);
      ImGui.text(`Handle Array Ptr (+776): 0x${lastPickup.handleArrayPtr.toString(16).toUpperCase()}`);
      ImGui.text(`Handle Ptr (*+776): 0x${lastPickup.handlePtr.toString(16).toUpperCase()}`);
    }
  } else {
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], "No pickups captured yet");
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Pick up an item to capture its handle!");
  }
  
  // Pickup history
  if (ImGui.collapsingHeader("Pickup History##history")) {
    const history = poe2.getPickupHistory(10);
    if (history && history.length > 0) {
      ImGui.text("Slot | Handle     | Inv");
      ImGui.separator();
      for (let i = history.length - 1; i >= 0; i--) {
        const p = history[i];
        ImGui.text(`${p.slotIndex.toString().padStart(4)} | ${p.itemHandleHex || '0x'+p.itemHandle.toString(16).padStart(8,'0')} | ${p.inventoryId}`);
      }
    } else {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "No pickup history");
    }
  }
  
  // Memory dump button
  ImGui.separator();
  if (ImGui.button("DUMP ITEM MEMORY")) {
    //console.log("===============================================");
    //console.log("ITEM MEMORY DUMP");
    //console.log("===============================================");
    //console.log(`Item Address: 0x${addr.toString(16)}`);
    //console.log(`Slot: (${item.slotX}, ${item.slotY})`);
    //console.log(`Inventory ID: ${selectedInventoryId}`);
    //console.log("");
    
    // Item Slot Handle - THE KEY IDENTIFIER
    const slotHandle = item.itemSlotHandle || 0;
    //console.log(`*** ITEM SLOT HANDLE: 0x${slotHandle.toString(16).toUpperCase()} (${slotHandle}) ***`);
    //console.log("(This value appears at byte offset 10 in pickup packets)");
    //console.log("");
    
    // Dump Item structure (256 bytes)
    //console.log("--- Item Structure (256 bytes) ---");
    if (item.itemDump && item.itemDump.length > 0) {
      for (let i = 0; i < item.itemDump.length; i++) {
        const val = item.itemDump[i] >>> 0;
        //console.log(`+0x${(i*4).toString(16).padStart(3,'0')}: 0x${val.toString(16).padStart(8,'0')}`);
      }
    } else {
      //console.log("No itemDump data!");
    }
    
    //console.log("");
    //console.log("--- InventoryItemStruct (64 bytes) ---");
    //console.log(`Address: 0x${(item.invItemStructAddr || 0).toString(16)}`);
    if (item.invItemDump && item.invItemDump.length > 0) {
      for (let i = 0; i < item.invItemDump.length; i++) {
        const val = item.invItemDump[i] >>> 0;
        //console.log(`+0x${(i*4).toString(16).padStart(2,'0')}: 0x${val.toString(16).padStart(8,'0')}`);
      }
    } else {
      //console.log("No invItemDump data!");
    }
    
    //console.log("");
    //console.log("--- EntityData (256 bytes) ---");
    if (item.entityDataDump && item.entityDataDump.length > 0) {
      for (let i = 0; i < item.entityDataDump.length; i++) {
        const val = item.entityDataDump[i] >>> 0;
        //console.log(`+0x${(i*4).toString(16).padStart(3,'0')}: 0x${val.toString(16).padStart(8,'0')}`);
      }
    } else {
      //console.log("No entityDataDump data!");
    }
    
    //console.log("===============================================");
    
    // Also dump inventory-level data
    const inv = lastInventoryInfo;
    if (inv && inv.inventoryDump) {
      //console.log("");
      //console.log("===============================================");
      //console.log("INVENTORY STRUCT DUMP");
      //console.log("===============================================");
      //console.log(`Inventory Struct Address: 0x${(inv.inventoryStructAddr || 0).toString(16)}`);
      //console.log(`Server Request Counter: ${inv.serverRequestCounter}`);
      //console.log("");
      //console.log("--- InventoryStruct (512 bytes from +0x140) ---");
      //console.log("Note: server_request_counter is at struct+0x1E8, which is dump index 42 (0x1E8-0x140)/4");
      for (let i = 0; i < inv.inventoryDump.length; i++) {
        const offset = 0x140 + (i * 4);
        const val = inv.inventoryDump[i] >>> 0;
        const marker = (offset === 0x1E8) ? " <-- server_request_counter" : "";
        //console.log(`+0x${offset.toString(16).padStart(3,'0')}: 0x${val.toString(16).padStart(8,'0')}${marker}`);
      }
      
      // Dump ServerData
      if (inv.serverDataDump && inv.serverDataAddr) {
        //console.log("");
        //console.log("===============================================");
        //console.log("SERVER DATA DUMP (for session token)");
        //console.log("===============================================");
        //console.log(`ServerData Address: 0x${inv.serverDataAddr.toString(16)}`);
        //console.log("--- ServerData (256 bytes from start) ---");
        for (let i = 0; i < inv.serverDataDump.length; i++) {
          const val = inv.serverDataDump[i] >>> 0;
          //console.log(`+0x${(i*4).toString(16).padStart(3,'0')}: 0x${val.toString(16).padStart(8,'0')}`);
        }
      }
      
      // Dump PlayerServerData
      if (inv.playerServerDataDump && inv.playerServerDataAddr) {
        //console.log("");
        //console.log("===============================================");
        //console.log("PLAYER SERVER DATA DUMP");
        //console.log("===============================================");
        //console.log(`PlayerServerData Address: 0x${inv.playerServerDataAddr.toString(16)}`);
        //console.log("--- PlayerServerData (512 bytes from start) ---");
        for (let i = 0; i < inv.playerServerDataDump.length; i++) {
          const val = inv.playerServerDataDump[i] >>> 0;
          //console.log(`+0x${(i*4).toString(16).padStart(3,'0')}: 0x${val.toString(16).padStart(8,'0')}`);
        }
      }
      
      //console.log("===============================================");
    }
  }
  ImGui.sameLine();
  ImGui.textColored([0.6, 0.6, 0.6, 1.0], "<- Click, then pick up item & capture packet")
  
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

// Load window settings
function loadWindowSettings() {
  if (settingsLoaded) return;
  try {
    const player = poe2.getLocalPlayer();
    if (!player || !player.playerName) return;
    
    const saved = Settings.get(PLUGIN_NAME, { windowCollapsed: true });
    windowCollapsed = saved.windowCollapsed !== false;  // Default to collapsed
    settingsLoaded = true;
    //console.log(`[InvViewer] Loaded settings: collapsed=${windowCollapsed}`);
  } catch (e) {
    //console.log('[InvViewer] Error loading settings:', e);
  }
}

// Save window settings
function saveWindowSettings() {
  try {
    Settings.set(PLUGIN_NAME, 'windowCollapsed', windowCollapsed);
  } catch (e) {
    // Ignore save errors
  }
}

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
    
    // Auto-discover inventory contexts (scans UI tree for inventory panels)
    // This finds contexts automatically without needing manual Ctrl+clicks
    if (cachedInventories.length > 0) {
      poe2.discoverInventoryContexts();
    }
  } catch (e) {
    cachedInventories = [];
    lastError = String(e);
    debugInfo = "Exception in getAllInventories";
  }
}

// Main draw function
function onDraw() {
  if (!showInventoryViewer) return;
  
  // Load settings once when player is available
  loadWindowSettings();
  
  ImGui.setNextWindowSize({ x: 450, y: 600 }, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowCollapsed(windowCollapsed, ImGui.Cond.Once);
  
  if (!ImGui.begin("Inventory Viewer", null, ImGui.WindowFlags.None)) {
    // Window is collapsed - track state change
    if (!windowCollapsed) {
      windowCollapsed = true;
      saveWindowSettings();
    }
    ImGui.end();
    return;
  }
  
  // Window is expanded - track state change
  if (windowCollapsed) {
    windowCollapsed = false;
    saveWindowSettings();
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
        const addr = inv.inventoryStructAddr || 0;
        const addrStr = addr ? ` [0x${addr.toString(16).toUpperCase()}]` : '';
        const isSelected = inv.inventoryId === selectedInventoryId;
        if (ImGui.selectable(`${label}${addrStr}##${inv.inventoryId}`, isSelected)) {
          selectedInventoryId = inv.inventoryId;
        }
      }
      ImGui.endCombo();
    }
    
    ImGui.text(`Total inventories found: ${cachedInventories.length}`);
    
    // Collapsible section showing all inventory addresses for correlation
    if (ImGui.collapsingHeader("All Inventory Addresses")) {
      ImGui.textColored([1.0, 1.0, 0.0, 1.0], "Use these to match Action Logger context addresses:");
      ImGui.separator();
      for (const inv of cachedInventories) {
        const name = getInventoryDisplayName(inv.inventoryId, inv.inventoryName);
        const addr = inv.inventoryStructAddr || 0;
        if (addr) {
          ImGui.text(`${name.padEnd(25)} 0x${addr.toString(16).toUpperCase()}`);
        } else {
          ImGui.textColored([0.5, 0.5, 0.5, 1.0], `${name.padEnd(25)} (no address)`);
        }
      }
    }
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
  
  // Show inventory info with address
  const invName = inventory.inventoryName || INVENTORY_NAMES[inventory.inventoryId] || "Unknown";
  ImGui.textColored([0.4, 0.8, 1.0, 1.0], `${invName} (ID: ${inventory.inventoryId})`);
  
  // Show inventory address - useful for correlating with Action Logger context
  const invAddr = inventory.inventoryStructAddr || 0;
  if (invAddr) {
    ImGui.textColored([1.0, 1.0, 0.0, 1.0], `Address: 0x${invAddr.toString(16).toUpperCase()}`);
  }
  
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
  
  // =====================================================
  // PACKET DEBUG / RE TOOLS SECTION
  // =====================================================
  ImGui.separator();
  if (ImGui.collapsingHeader("Packet Debug Tools")) {
    ImGui.textColored([0.0, 1.0, 1.0, 1.0], "Known Function Addresses (for CE/IDA):");
    
    // Memory.imageBase returns BigInt, need to handle it properly
    let baseBigInt;
    try {
      baseBigInt = Memory.imageBase;
    } catch (e) {
      ImGui.textColored([1.0, 0.3, 0.3, 1.0], `Error getting imageBase: ${e}`);
      baseBigInt = BigInt(0);
    }
    
    if (!baseBigInt) {
      ImGui.textColored([1.0, 0.3, 0.3, 1.0], "Memory.imageBase returned null/undefined");
      baseBigInt = BigInt(0);
    }
    
    const knownFuncs = [
      { name: "DoLiftItem", rva: 0x39DB50 },
      { name: "PacketDispatcher", rva: 0x1DD9D70 },
      { name: "PacketBuilder149", rva: 0x1DD9CD0 },
      { name: "PacketBuilder147", rva: 0x38F9A0 },
      { name: "PacketSender", rva: 0x1DE7090 },
      { name: "SendFlush", rva: 0x1E4FB50 },
      { name: "ReceiveBuffer", rva: 0x1E4FE20 },
    ];
    
    // Convert BigInt to hex string
    const baseHex = baseBigInt.toString(16).toUpperCase();
    ImGui.text(`Image Base: 0x${baseHex}`);
    ImGui.separator();
    
    for (const func of knownFuncs) {
      // Use BigInt arithmetic
      const addr = baseBigInt + BigInt(func.rva);
      ImGui.text(`${func.name.padEnd(18)}: 0x${addr.toString(16).toUpperCase()}`);
    }
    
    ImGui.separator();
    if (ImGui.button("Copy All to Console")) {
      //console.log("=".repeat(50));
      //console.log("PACKET FUNCTION ADDRESSES");
      //console.log("=".repeat(50));
      //console.log(`Image Base: 0x${baseHex}`);
      //console.log("");
      for (const func of knownFuncs) {
        const addr = baseBigInt + BigInt(func.rva);
        //console.log(`${func.name}: 0x${addr.toString(16).toUpperCase()} (RVA: 0x${func.rva.toString(16).toUpperCase()})`);
      }
      //console.log("");
      //console.log("For Cheat Engine:");
      const packetSenderAddr = baseBigInt + BigInt(0x1DE7090);
      //console.log(`  1. Break on PacketSender: 0x${packetSenderAddr.toString(16).toUpperCase()}`);
      //console.log("  2. When break hits, RDX = packet data pointer");
      //console.log("  3. Set write breakpoint on RDX to find opcode writer");
      //console.log("=".repeat(50));
    }
    
    ImGui.sameLine();
    if (ImGui.button("Pattern Scan")) {
      //console.log("=".repeat(50));
      //console.log("PATTERN SCANNING...");
      //console.log("=".repeat(50));
      
      // Get base fresh for the scan
      const scanBase = Memory.imageBase || BigInt(0);
      const size = Memory.imageSize;
      
      // SendFlush pattern
      const sendFlushPattern = "48 89 5C 24 10 48 89 74 24 18 55 57 41 54 41 56 41 57 48 8D AC 24 ?? ?? ?? ?? 48 81 EC ?? ?? ?? ?? 44 8B FA 48 8B D9 45 33 E4 44 38 A1 C8 00 00 00";
      //console.log("Searching for SendFlush...");
      try {
        const results = Memory.findSignature(sendFlushPattern, scanBase, size);
        if (results && results.length > 0) {
          for (const offset of results) {
            const addr = scanBase + BigInt(offset);
            //console.log(`  Found: 0x${addr.toString(16).toUpperCase()} (RVA: 0x${BigInt(offset).toString(16).toUpperCase()})`);
          }
        } else {
          //console.log("  Not found");
        }
      } catch (e) {
        //console.log(`  Error: ${e}`);
      }
      
      // ReceiveBuffer pattern
      const receivePattern = "48 8B C4 53 48 81 EC ?? ?? ?? ?? 80 B9 D1 01 00 00 00 48 8B D9";
      //console.log("Searching for ReceiveBuffer...");
      try {
        const results = Memory.findSignature(receivePattern, scanBase, size);
        if (results && results.length > 0) {
          for (const offset of results) {
            const addr = scanBase + BigInt(offset);
            //console.log(`  Found: 0x${addr.toString(16).toUpperCase()} (RVA: 0x${BigInt(offset).toString(16).toUpperCase()})`);
          }
        } else {
          //console.log("  Not found");
        }
      } catch (e) {
        //console.log(`  Error: ${e}`);
      }
      
      //console.log("=".repeat(50));
    }
    
    // Show Tcpstream address if available
    ImGui.separator();
    ImGui.textColored([1.0, 1.0, 0.0, 1.0], "Tcpstream (send buffer):");
    ImGui.text("Use packet_viewer.cc 'Dump Tcpstream' button");
    ImGui.text("Then set CE write breakpoint on send_buffer");
  }
  
  // =====================================================
  // QUICK MOVER - Visual grid, click items to move
  // =====================================================
  ImGui.separator();
  if (ImGui.collapsingHeader("Quick Mover")) {
    // Get only visible inventories (auto-discovers contexts too)
    const visibleInvs = poe2.getVisibleInventories();
    
    if (visibleInvs.length === 0) {
      ImGui.textColored([1.0, 0.5, 0.2, 1.0], "No inventory panels open");
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Open inventory or stash to see items here");
    } else {
      // Scrollable container for all inventory grids
      if (ImGui.beginChild("##QuickMoverScroll", { x: 0, y: 350 }, ImGui.ChildFlags.Border)) {
        
        for (let invIdx = 0; invIdx < visibleInvs.length; invIdx++) {
          const inv = visibleInvs[invIdx];
          const invName = INVENTORY_NAMES[inv.inventoryId] || `Inventory ${inv.inventoryId}`;
          
          if (invIdx > 0) {
            ImGui.spacing();
            ImGui.separator();
            ImGui.spacing();
          }
          
          // Header
          ImGui.textColored([0.4, 0.8, 1.0, 1.0], `${invName} (${inv.items.length} items)`);
          if (ImGui.isItemHovered() && inv.uiPath) {
            ImGui.beginTooltip();
            ImGui.textColored([0.6, 0.6, 0.6, 1.0], "UI Path:");
            ImGui.text(inv.uiPath);
            ImGui.endTooltip();
          }
          ImGui.sameLine();
          if (ImGui.smallButton(`Move All##mv${inv.inventoryId}`)) {
            let moved = 0;
            for (const item of inv.items) {
              if (item.slotId > 0 && poe2.ctrlClickItem(inv.inventoryId, item.slotId)) moved++;
            }
            //console.log(`[QuickMover] Moved ${moved}/${inv.items.length} from ${invName}`);
          }
          
          // Draw inventory grid
          const cellSize = 26;
          const cellSpacing = 2;
          const itemPadding = 2;
          
          const startPos = ImGui.getCursorScreenPos();
          const drawList = ImGui.getWindowDrawList();
          
          const gridWidth = inv.gridWidth * (cellSize + cellSpacing) - cellSpacing;
          const gridHeight = inv.gridHeight * (cellSize + cellSpacing) - cellSpacing;
          
          // Draw empty grid background
          for (let y = 0; y < inv.gridHeight; y++) {
            for (let x = 0; x < inv.gridWidth; x++) {
              const posX = startPos.x + x * (cellSize + cellSpacing);
              const posY = startPos.y + y * (cellSize + cellSpacing);
              
              drawList.addRectFilled(
                { x: posX, y: posY },
                { x: posX + cellSize, y: posY + cellSize },
                makeColorABGR(0.12, 0.12, 0.12, 0.8)
              );
              drawList.addRect(
                { x: posX, y: posY },
                { x: posX + cellSize, y: posY + cellSize },
                makeColorABGR(0.25, 0.25, 0.25, 0.8), 0, 0, 1.0
              );
            }
          }
          
          // Track which item is hovered for click handling
          let hoveredItem = null;
          
          // Draw items
          for (const item of inv.items) {
            const w = item.width || 1;
            const h = item.height || 1;
            const rarity = item.rarity || 0;
            
            const itemX = startPos.x + item.slotX * (cellSize + cellSpacing);
            const itemY = startPos.y + item.slotY * (cellSize + cellSpacing);
            const itemW = w * cellSize + (w - 1) * cellSpacing;
            const itemH = h * cellSize + (h - 1) * cellSpacing;
            
            const rarityColor = RARITY_COLORS[rarity];
            
            // Check hover
            const mousePos = ImGui.getMousePos();
            const isHovered = mousePos.x >= itemX && mousePos.x < itemX + itemW &&
                             mousePos.y >= itemY && mousePos.y < itemY + itemH;
            
            if (isHovered) hoveredItem = item;
            
            // Item fill color
            const brightness = isHovered ? 0.4 : 0.25;
            const fillColor = makeColorABGR(
              rarityColor[0] * brightness,
              rarityColor[1] * brightness,
              rarityColor[2] * brightness,
              0.95
            );
            
            // Border color
            const borderColor = makeColorABGR(
              rarityColor[0], rarityColor[1], rarityColor[2], 1.0
            );
            
            // Draw item background
            drawList.addRectFilled(
              { x: itemX + itemPadding, y: itemY + itemPadding },
              { x: itemX + itemW - itemPadding, y: itemY + itemH - itemPadding },
              fillColor
            );
            
            // Draw border (thicker when hovered)
            drawList.addRect(
              { x: itemX + itemPadding, y: itemY + itemPadding },
              { x: itemX + itemW - itemPadding, y: itemY + itemH - itemPadding },
              borderColor, 2.0, 0, isHovered ? 2.5 : 1.5
            );
            
            // Draw size indicator for multi-slot items
            if (w > 1 || h > 1) {
              const sizeText = `${w}x${h}`;
              drawList.addText(
                sizeText,
                { x: itemX + itemW - 18, y: itemY + itemH - 14 },
                makeColorABGR(0.6, 0.6, 0.6, 0.9)
              );
            }
          }
          
          // Reserve space for the grid (makes it part of the layout)
          ImGui.dummy({ x: gridWidth, y: gridHeight });
          
          // Handle click on hovered item (after dummy to not interfere)
          if (hoveredItem && ImGui.isMouseClicked(0) && hoveredItem.slotId > 0) {
            // Check if mouse is within our grid area (not on other widgets)
            const mousePos = ImGui.getMousePos();
            if (mousePos.x >= startPos.x && mousePos.x < startPos.x + gridWidth &&
                mousePos.y >= startPos.y && mousePos.y < startPos.y + gridHeight) {
              const displayName = hoveredItem.uniqueName || hoveredItem.baseName || 'item';
              //console.log(`[QuickMover] Moving: ${displayName}`);
              poe2.ctrlClickItem(inv.inventoryId, hoveredItem.slotId);
            }
          }
          
          // Tooltip for hovered item
          if (hoveredItem) {
            const mousePos = ImGui.getMousePos();
            if (mousePos.x >= startPos.x && mousePos.x < startPos.x + gridWidth &&
                mousePos.y >= startPos.y && mousePos.y < startPos.y + gridHeight) {
              ImGui.beginTooltip();
              const displayName = hoveredItem.uniqueName || hoveredItem.baseName || 'Unknown';
              const rarityColor = RARITY_COLORS[hoveredItem.rarity || 0];
              ImGui.textColored(rarityColor, displayName);
              ImGui.textColored([0.7, 0.7, 0.7, 1.0], "Click to move");
              ImGui.endTooltip();
            }
          }
        }
        
        ImGui.endChild();
      }
    }
  }
  
  // =====================================================
  // ITEM DATA SECTION (for packet/API reference)
  // =====================================================
  ImGui.separator();
  if (ImGui.collapsingHeader("Item Slot Data")) {
    ImGui.textColored([1.0, 1.0, 0.0, 1.0], "Slot IDs for Network Packets");
    ImGui.text("The 'Slot ID' is used in network packets to identify items.");
    ImGui.separator();
    
    if (inventory.items && inventory.items.length > 0) {
      if (ImGui.beginChild("##SlotDataList", { x: 0, y: 180 }, ImGui.ChildFlags.Border)) {
        // Table header
        ImGui.textColored([0.6, 0.6, 0.6, 1.0], "Grid     Slot ID    Item Name");
        ImGui.separator();
        
        for (const item of inventory.items) {
          const slotHandle = item.itemSlotHandle || 0;
          const displayName = getItemDisplayName(item);
          const rarityColor = RARITY_COLORS[item.rarity || 0];
          
          const gridStr = `(${item.slotX},${item.slotY})`.padEnd(8);
          const slotStr = slotHandle > 0 ? slotHandle.toString().padStart(6) : "  N/A ";
          
          const isSelected = item.itemAddress === selectedItemAddress;
          if (isSelected) {
            ImGui.textColored([0.2, 1.0, 0.2, 1.0], `${gridStr} ${slotStr}    ${displayName}`);
          } else {
            // Show grid and slot in default color, name in rarity color
            ImGui.text(`${gridStr} ${slotStr}    `);
            ImGui.sameLine(0, 0);
            ImGui.textColored(rarityColor, displayName);
          }
        }
        ImGui.endChild();
      }
      
      ImGui.separator();
      if (ImGui.button("Log to Console")) {
        //console.log("=== ITEM SLOT DATA ===");
        //console.log(`Inventory: ${selectedInventoryId} (${INVENTORY_NAMES[selectedInventoryId] || 'Unknown'})`);
        //console.log("Grid     | Slot ID | Item");
        //console.log("---------|---------|---------------------------");
        for (const item of inventory.items) {
          const slotHandle = item.itemSlotHandle || 0;
          const displayName = getItemDisplayName(item);
          //console.log(`(${item.slotX},${item.slotY})`.padEnd(9) + 
            //`| ${slotHandle.toString().padStart(7)} | ${displayName}`);
        }
        //console.log("======================");
      }
    } else {
      ImGui.text("No items in inventory");
    }
  }
  
  ImGui.end();
}

// Export plugin
export const inventoryViewerPlugin = {
  onDraw: onDraw
};

//console.log("Inventory Viewer loaded");

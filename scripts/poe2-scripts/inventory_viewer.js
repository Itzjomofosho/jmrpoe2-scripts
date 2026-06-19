/**
 * Inventory Viewer
 * 
 * Displays player inventory contents with item information.
 * Useful for debugging and developing pickit plugins.
 */

import { Settings } from './Settings.js';
import { readInventory, moveByHandle, findStashTabs, getStashTabs, INV } from './inventory.js';

const poe2 = new POE2();
const PLUGIN_NAME = 'inventory_viewer';

// Quick Mover: which stash tab the BACKPACK sends items to (stash->bag moves auto-use each tab's
// own id). tabId is the move-packet [3,4] value = the tab's dense index (from getStashTabs).
let quickMoverTargetTabId = 0;
let qmCache = [];
let qmCacheTime = 0;
function qmTabs() { return getStashTabs() || []; }   // getStashTabs has its own ~800ms TTL cache
function qmTargetName() {
  const t = qmTabs().filter(function (x) { return x.tabId === quickMoverTargetTabId; })[0];
  return t ? t.name : '?';
}
function qmCycleTarget(dir) {
  const tabs = qmTabs(); if (!tabs.length) return;
  let idx = 0;
  for (let i = 0; i < tabs.length; i++) if (tabs[i].tabId === quickMoverTargetTabId) { idx = i; break; }
  idx = (idx + dir + tabs.length) % tabs.length;
  quickMoverTargetTabId = tabs[idx].tabId;
}

// Main bag + stash tabs as Quick Mover grid data; each inv carries its move tabId + name, each
// item its move handle (as slotId).
function enumerateInventories() {
  const list = [{ invId: INV.MAIN, tabId: null, name: 'Backpack' }];
  const tabs = findStashTabs();   // loaded stash tabs, enriched with tabId + name
  for (let i = 0; i < tabs.length; i++) list.push({ invId: tabs[i].invId, tabId: tabs[i].tabId, name: tabs[i].name });
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const inv = readInventory(list[i].invId);
    if (!inv || !inv.items || inv.items.length === 0) continue;
    out.push({
      inventoryId: list[i].invId, tabId: list[i].tabId, tabName: list[i].name,
      gridWidth: inv.width, gridHeight: inv.height,
      items: inv.items.map(function (it) {
        return {
          slotX: it.x, slotY: it.y, width: it.w, height: it.h,
          rarity: it.rarity || 0, slotId: it.handle, baseName: it.base, uniqueName: it.unique,
        };
      }),
    });
  }
  return out;
}

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
  
  // Move handle — the value move packets carry (== InventoryItemStruct+0x18; live-verified).
  const slotHandle = item.itemSlotHandle || 0;
  ImGui.textColored([1.0, 1.0, 0.0, 1.0], `Move Handle: ${slotHandle}  (0x${slotHandle.toString(16).toUpperCase()})`);
  
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
  
  // Mods + flags
  const mods = poe2.getItemMods(item.itemAddress);
  if (mods && mods.isValid) {
    ImGui.separator();
    ImGui.text(`Rarity: ${mods.rarityName || RARITY_NAMES[mods.rarity]}   Req Lvl: ${mods.requiredLevel || 0}`);

    const flags = [];
    if (!mods.identified) flags.push('Unidentified');
    if (mods.corrupted) flags.push(mods.twiceCorrupted ? 'Twice-Corrupted' : 'Corrupted');
    if (mods.fractured) flags.push('Fractured');
    if (mods.synthetic) flags.push('Synthetic');
    if (mods.relic) flags.push('Relic');
    if (mods.shaperItem) flags.push('Shaper');
    if (mods.elderItem) flags.push('Elder');
    if (mods.duplicated) flags.push('Mirrored');
    if (mods.split) flags.push('Split');
    if (flags.length) ImGui.textColored([1.0, 0.6, 0.2, 1.0], flags.join('  '));

    const drawMods = (label, list, color) => {
      if (!list || !list.length) return;
      ImGui.text(label);
      for (const mod of list) {
        const v = (mod.value1 && mod.value1 !== mod.value0) ? `${mod.value0}-${mod.value1}` : `${mod.value0}`;
        ImGui.textColored(color, `  ${mod.name}: ${v}`);
      }
    };
    drawMods('Implicit:', mods.implicitMods, [0.6, 0.6, 1.0, 1.0]);
    drawMods('Enchant:', mods.enchantMods, [1.0, 0.5, 1.0, 1.0]);
    drawMods('Explicit:', mods.explicitMods, [0.2, 0.8, 1.0, 1.0]);
    drawMods('Hellscape:', mods.hellscapeMods, [1.0, 0.8, 0.3, 1.0]);
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
  // QUICK MOVER - Visual grid, click items to move
  // =====================================================
  ImGui.separator();
  if (ImGui.collapsingHeader("Quick Mover")) {
    // Destination tab for BACKPACK -> stash moves (stash -> bag auto-uses each tab's own id).
    ImGui.text(`Backpack -> stash tab: ${qmTargetName()} [id ${quickMoverTargetTabId}]`);
    ImGui.sameLine();
    if (ImGui.smallButton("<##qmtab")) qmCycleTarget(-1);
    ImGui.sameLine();
    if (ImGui.smallButton(">##qmtab")) qmCycleTarget(1);
    ImGui.textColored([0.6, 0.6, 0.6, 1.0], "click an item: bag -> the tab above; stash tab -> bag");

    // Read main bag + stash tabs (cached ~400ms).
    const _now = Date.now();
    if (_now - qmCacheTime > 400) { qmCache = enumerateInventories(); qmCacheTime = _now; }
    const visibleInvs = qmCache;

    if (visibleInvs.length === 0) {
      ImGui.textColored([1.0, 0.5, 0.2, 1.0], "No readable inventories (not in game?)");
    } else {
      // Scrollable container for all inventory grids
      if (ImGui.beginChild("##QuickMoverScroll", { x: 0, y: 350 }, ImGui.ChildFlags.Border)) {
        
        for (let invIdx = 0; invIdx < visibleInvs.length; invIdx++) {
          const inv = visibleInvs[invIdx];
          const invName = inv.tabName || INVENTORY_NAMES[inv.inventoryId] || `Inventory ${inv.inventoryId}`;
          
          if (invIdx > 0) {
            ImGui.spacing();
            ImGui.separator();
            ImGui.spacing();
          }
          
          // Header (stash tabs show their move id)
          const hdr = inv.tabId != null ? `${invName}  [tab ${inv.tabId}]  (${inv.items.length})` : `${invName}  (${inv.items.length})`;
          ImGui.textColored([0.4, 0.8, 1.0, 1.0], hdr);
          if (ImGui.isItemHovered() && inv.uiPath) {
            ImGui.beginTooltip();
            ImGui.textColored([0.6, 0.6, 0.6, 1.0], "UI Path:");
            ImGui.text(inv.uiPath);
            ImGui.endTooltip();
          }
          ImGui.sameLine();
          if (ImGui.smallButton(`Move All##mv${inv.inventoryId}`)) {
            const isMain = inv.inventoryId === INV.MAIN;
            const tId = isMain ? quickMoverTargetTabId : inv.tabId;
            if (tId != null) for (const item of inv.items) { if (item.slotId != null) moveByHandle(isMain ? 'in' : 'out', tId, item.slotId); }
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
          if (hoveredItem && ImGui.isMouseClicked(0) && hoveredItem.slotId != null) {
            const mousePos = ImGui.getMousePos();
            if (mousePos.x >= startPos.x && mousePos.x < startPos.x + gridWidth &&
                mousePos.y >= startPos.y && mousePos.y < startPos.y + gridHeight) {
              const isMain = inv.inventoryId === INV.MAIN;
              const tId = isMain ? quickMoverTargetTabId : inv.tabId;
              if (tId != null) moveByHandle(isMain ? 'in' : 'out', tId, hoveredItem.slotId);
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

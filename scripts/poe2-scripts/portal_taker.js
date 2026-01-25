// portal_taker.js - Portal Taker Plugin for POE2
// Finds nearby portals and provides quick interaction via packet

import { Settings } from './Settings.js';

const poe2 = new POE2();

// Settings
let currentSettings = {
  enabled: true,
  searchRadius: 50,        // Grid units
  autoShowOnPortal: true,  // Show button automatically when portal found
  
  // Settings window (separate from button)
  settingsWindowX: 400,
  settingsWindowY: 100,
  showSettingsWindow: true,  // Show by default so users can configure
  settingsWindowCollapsed: true,  // Start collapsed
  
  // Portal button (separate, moveable)
  buttonX: 100,
  buttonY: 100,
  buttonOpacity: 0.20,     // 20% opacity by default - affects button itself
  buttonLocked: false,     // Lock position when true
  
  // Hotkey
  hotkeyEnabled: true,
  hotkeyKey: ImGui.Key.F9,
  hotkeyCtrl: false,
  hotkeyShift: false,
  hotkeyAlt: false
};

// State
let nearbyPortals = [];
let lastSearchTime = 0;
let searchIntervalMs = 500;
let lastPlayerX = 0;
let lastPlayerY = 0;
let waitingForHotkey = false;
let settingsLoaded = false;  // Track if settings have been loaded with valid player

// Key names for display
const KEY_NAMES = {
  [ImGui.Key.Space]: "Space",
  [ImGui.Key.E]: "E", [ImGui.Key.T]: "T", [ImGui.Key.X]: "X",
  [ImGui.Key.Q]: "Q", [ImGui.Key.R]: "R", [ImGui.Key.F]: "F",
  [ImGui.Key.G]: "G", [ImGui.Key.V]: "V", [ImGui.Key.B]: "B",
  [ImGui.Key.Tab]: "Tab",
  [ImGui.Key.F1]: "F1", [ImGui.Key.F2]: "F2", [ImGui.Key.F3]: "F3", [ImGui.Key.F4]: "F4",
  [ImGui.Key.F5]: "F5", [ImGui.Key.F6]: "F6", [ImGui.Key.F7]: "F7", [ImGui.Key.F8]: "F8",
  [ImGui.Key.F9]: "F9", [ImGui.Key.F10]: "F10", [ImGui.Key.F11]: "F11"
};

function getKeyName(key) {
  if (key === 0) return "None";
  return KEY_NAMES[key] || `Key ${key}`;
}

function getHotkeyDisplayString() {
  if (currentSettings.hotkeyKey === 0) return "None";
  let str = "";
  if (currentSettings.hotkeyCtrl) str += "Ctrl+";
  if (currentSettings.hotkeyShift) str += "Shift+";
  if (currentSettings.hotkeyAlt) str += "Alt+";
  str += getKeyName(currentSettings.hotkeyKey);
  return str;
}

// Default settings for reference and merging
const DEFAULT_SETTINGS = {
  enabled: true,
  searchRadius: 50,
  autoShowOnPortal: true,
  settingsWindowX: 400,
  settingsWindowY: 100,
  showSettingsWindow: true,
  settingsWindowCollapsed: true,
  buttonX: 100,
  buttonY: 100,
  buttonOpacity: 0.20,
  buttonLocked: false,
  hotkeyEnabled: true,
  hotkeyKey: ImGui.Key.F9,
  hotkeyCtrl: false,
  hotkeyShift: false,
  hotkeyAlt: false
};

/**
 * Load settings from storage
 * Returns true if settings were loaded with a valid player, false otherwise
 */
function loadSettings() {
  try {
    // Check if we have a valid player first
    const player = poe2.getLocalPlayer();
    if (!player || !player.playerName) {
      console.log('[PortalTaker] No player yet, will load settings when in-game');
      return false;
    }
    
    // Settings.get returns settings merged with defaults
    const saved = Settings.get('portal_taker', DEFAULT_SETTINGS);
    if (saved) {
      Object.assign(currentSettings, saved);
    }
    console.log(`[PortalTaker] Settings loaded for player: ${player.playerName}`);
    console.log(`[PortalTaker]   hotkeyKey: ${currentSettings.hotkeyKey}, buttonLocked: ${currentSettings.buttonLocked}`);
    settingsLoaded = true;
    return true;
  } catch (e) {
    console.log('[PortalTaker] Error loading settings:', e);
    return false;
  }
}

/**
 * Save settings to storage
 */
function saveSettings() {
  try {
    // Check if we have a valid player first
    const player = poe2.getLocalPlayer();
    if (!player || !player.playerName) {
      console.log('[PortalTaker] Cannot save settings - no player');
      return;
    }
    
    // Use setMultiple to save all settings at once
    Settings.setMultiple('portal_taker', currentSettings);
    console.log('[PortalTaker] Settings saved');
  } catch (e) {
    console.log('[PortalTaker] Failed to save settings:', e);
  }
}

/**
 * Get a friendly name for a portal from its metadata path
 */
function getPortalDisplayName(entity) {
  if (entity.renderName && entity.renderName.length > 0) {
    return entity.renderName;
  }
  
  const path = entity.name || '';
  const parts = path.split('/');
  const lastPart = parts[parts.length - 1] || 'Portal';
  
  let name = lastPart
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  
  if (path.includes('TownPortal')) {
    name = 'Town Portal';
  }
  
  return name || 'Portal';
}

/**
 * Search for portals near the player
 */
function searchForPortals() {
  const player = poe2.getLocalPlayer();
  if (!player) {
    nearbyPortals = [];
    return;
  }

  lastPlayerX = player.gridX;
  lastPlayerY = player.gridY;

  // Use lightweight mode - we only need entity names and positions for portal detection
  const entities = poe2.getEntities({ maxDistance: currentSettings.searchRadius, lightweight: true });
  
  nearbyPortals = [];
  
  for (const entity of entities) {
    const path = (entity.name || '').toLowerCase();
    const renderName = (entity.renderName || '').toLowerCase();
    
    const hasPortalInPath = path.includes('portal');
    const hasPortalInName = renderName.includes('portal');
    const isWaypoint = path.includes('waypoint');
    const isPortal = (hasPortalInPath || hasPortalInName) && !isWaypoint;
    
    if (isPortal) {
      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      nearbyPortals.push({
        id: entity.id,
        name: getPortalDisplayName(entity),
        path: entity.name,
        distance: distance,
        gridX: entity.gridX,
        gridY: entity.gridY,
        worldX: entity.worldX,
        worldY: entity.worldY,
        worldZ: entity.worldZ
      });
    }
  }
  
  nearbyPortals.sort((a, b) => a.distance - b.distance);
}

/**
 * Send the portal interaction packet
 */
function takePortal(portalId) {
  const packet = new Uint8Array([
    0x01, 0x84, 0x01, 0x20, 0x00, 0xC2, 0x66, 0x04, 0x00, 0xFF, 0x08, 0x00, 0x00,
    (portalId >> 8) & 0xFF,
    portalId & 0xFF
  ]);
  
  const hexStr = Array.from(packet).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  console.log(`[PortalTaker] Sending packet for ID ${portalId}: ${hexStr}`);
  
  const success = poe2.sendPacket(packet);
  if (success) {
    console.log('[PortalTaker] Packet sent successfully');
  } else {
    console.log('[PortalTaker] Failed to send packet');
  }
  
  return success;
}

/**
 * Take the nearest portal
 */
function takeNearestPortal() {
  if (nearbyPortals.length > 0) {
    console.log(`[PortalTaker] Taking nearest portal: ${nearbyPortals[0].name} (ID: ${nearbyPortals[0].id})`);
    return takePortal(nearbyPortals[0].id);
  }
  console.log('[PortalTaker] No nearby portals found');
  return false;
}

function colorToU32(r, g, b, a) {
  return ((a * 255) << 24) | ((b * 255) << 16) | ((g * 255) << 8) | (r * 255);
}

/**
 * Check hotkey (runs always)
 */
function checkHotkey() {
  if (!currentSettings.hotkeyEnabled || currentSettings.hotkeyKey === 0) return;
  
  // Check modifier keys
  const ctrlDown = ImGui.isKeyDown(ImGui.Key.LeftCtrl) || ImGui.isKeyDown(ImGui.Key.RightCtrl);
  const shiftDown = ImGui.isKeyDown(ImGui.Key.LeftShift) || ImGui.isKeyDown(ImGui.Key.RightShift);
  const altDown = ImGui.isKeyDown(ImGui.Key.LeftAlt) || ImGui.isKeyDown(ImGui.Key.RightAlt);
  
  const ctrlOk = !currentSettings.hotkeyCtrl || ctrlDown;
  const shiftOk = !currentSettings.hotkeyShift || shiftDown;
  const altOk = !currentSettings.hotkeyAlt || altDown;
  
  if (ctrlOk && shiftOk && altOk && ImGui.isKeyPressed(currentSettings.hotkeyKey, false)) {
    takeNearestPortal();
  }
}

/**
 * Draw the portal button (always visible, ignores F12)
 */
function drawPortalButton() {
  if (nearbyPortals.length === 0) return;
  if (!currentSettings.autoShowOnPortal) return;
  
  const portal = nearbyPortals[0];
  const opacity = currentSettings.buttonOpacity;
  
  // Window flags
  let flags = ImGui.WindowFlags.NoTitleBar | 
              ImGui.WindowFlags.NoScrollbar | 
              ImGui.WindowFlags.NoCollapse |
              ImGui.WindowFlags.NoResize;
  
  // Only use NoBackground and NoMove when locked
  if (currentSettings.buttonLocked) {
    flags |= ImGui.WindowFlags.NoMove | ImGui.WindowFlags.NoBackground | ImGui.WindowFlags.AlwaysAutoResize;
  }
  
  ImGui.setNextWindowPos({ x: currentSettings.buttonX, y: currentSettings.buttonY }, ImGui.Cond.FirstUseEver);
  
  // When unlocked, set a minimum size so there's space to drag
  if (!currentSettings.buttonLocked) {
    ImGui.setNextWindowSize({ x: 200, y: 50 }, ImGui.Cond.Always);
  }
  
  // Style the window - add visible background when unlocked for dragging
  if (!currentSettings.buttonLocked) {
    // Visible dark background with bright border when moveable
    ImGui.pushStyleColor(ImGui.Col.WindowBg, colorToU32(0.12, 0.12, 0.18, 0.95));
    ImGui.pushStyleColor(ImGui.Col.Border, colorToU32(0.4, 0.6, 1.0, 0.9));
    ImGui.pushStyleVar(ImGui.StyleVar.WindowPadding, { x: 10, y: 8 });
    ImGui.pushStyleVar(ImGui.StyleVar.WindowBorderSize, 2);
    ImGui.pushStyleVar(ImGui.StyleVar.FramePadding, { x: 8, y: 4 });
  } else {
    // Remove all padding/borders when locked
    ImGui.pushStyleVar(ImGui.StyleVar.WindowPadding, { x: 0, y: 0 });
    ImGui.pushStyleVar(ImGui.StyleVar.WindowBorderSize, 0);
    ImGui.pushStyleVar(ImGui.StyleVar.FramePadding, { x: 8, y: 4 });
  }
  
  const openVar = new ImGui.MutableVariable(true);
  if (ImGui.begin('##PortalButton', openVar, flags)) {
    // Save position if moved
    if (!currentSettings.buttonLocked) {
      const pos = ImGui.getWindowPos();
      if (pos.x !== currentSettings.buttonX || pos.y !== currentSettings.buttonY) {
        currentSettings.buttonX = pos.x;
        currentSettings.buttonY = pos.y;
        saveSettings();
      }
      
      // Show drag hint when unlocked
      ImGui.textColored({ x: 0.6, y: 0.7, z: 0.9, w: 0.8 }, ':: Drag to move ::');
    }
    
    // Button with user-configured opacity
    ImGui.pushStyleColor(ImGui.Col.Button, colorToU32(0.1, 0.4, 0.8, opacity));
    ImGui.pushStyleColor(ImGui.Col.ButtonHovered, colorToU32(0.2, 0.5, 0.95, Math.min(opacity + 0.4, 1.0)));
    ImGui.pushStyleColor(ImGui.Col.ButtonActive, colorToU32(0.05, 0.3, 0.7, Math.min(opacity + 0.6, 1.0)));
    ImGui.pushStyleColor(ImGui.Col.Text, colorToU32(1.0, 1.0, 1.0, Math.min(opacity * 2 + 0.3, 1.0)));
    
    const buttonText = `Take: ${portal.name}`;
    if (ImGui.button(buttonText)) {
      takePortal(portal.id);
    }
    
    ImGui.popStyleColor(4);
    
    if (ImGui.isItemHovered()) {
      const hotkeyText = currentSettings.hotkeyEnabled ? `\nHotkey: ${getHotkeyDisplayString()}` : '';
      ImGui.setTooltip(`Distance: ${portal.distance.toFixed(1)}\nID: ${portal.id}${hotkeyText}`);
    }
  }
  ImGui.end();
  
  // Pop styles (3 vars always, plus 2 colors when unlocked)
  ImGui.popStyleVar(3);
  if (!currentSettings.buttonLocked) {
    ImGui.popStyleColor(2);
  }
}

/**
 * Draw the settings window (respects F12)
 */
function drawSettingsWindow() {
  if (!currentSettings.showSettingsWindow) return;
  if (!Plugins.isUiVisible()) return;
  
  ImGui.setNextWindowPos({ x: currentSettings.settingsWindowX, y: currentSettings.settingsWindowY }, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowSize({ x: 320, y: 400 }, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowCollapsed(currentSettings.settingsWindowCollapsed, ImGui.Cond.Once);
  
  const openVar = new ImGui.MutableVariable(currentSettings.showSettingsWindow);
  if (ImGui.begin('Portal Taker Settings', openVar)) {
    // Track collapsed state change (window is expanded)
    if (currentSettings.settingsWindowCollapsed) {
      currentSettings.settingsWindowCollapsed = false;
      saveSettings();
    }
    const pos = ImGui.getWindowPos();
    if (pos.x !== currentSettings.settingsWindowX || pos.y !== currentSettings.settingsWindowY) {
      currentSettings.settingsWindowX = pos.x;
      currentSettings.settingsWindowY = pos.y;
      saveSettings();
    }
    
    // Enable/Disable
    const enabledVar = new ImGui.MutableVariable(currentSettings.enabled);
    if (ImGui.checkbox('Enabled', enabledVar)) {
      currentSettings.enabled = enabledVar.value;
      saveSettings();
    }
    
    ImGui.separator();
    ImGui.text('Detection');
    
    const radiusVar = new ImGui.MutableVariable(currentSettings.searchRadius);
    ImGui.setNextItemWidth(150);
    if (ImGui.sliderInt('Search Radius', radiusVar, 20, 100)) {
      currentSettings.searchRadius = radiusVar.value;
      saveSettings();
    }
    
    const autoShowVar = new ImGui.MutableVariable(currentSettings.autoShowOnPortal);
    if (ImGui.checkbox('Show button when portal nearby', autoShowVar)) {
      currentSettings.autoShowOnPortal = autoShowVar.value;
      saveSettings();
    }
    
    ImGui.separator();
    ImGui.text('Button');
    
    const opacityVar = new ImGui.MutableVariable(currentSettings.buttonOpacity);
    ImGui.setNextItemWidth(150);
    if (ImGui.sliderFloat('Opacity', opacityVar, 0.1, 1.0)) {
      currentSettings.buttonOpacity = opacityVar.value;
      saveSettings();
    }
    
    const lockedVar = new ImGui.MutableVariable(currentSettings.buttonLocked);
    if (ImGui.checkbox('Lock button position', lockedVar)) {
      currentSettings.buttonLocked = lockedVar.value;
      saveSettings();
    }
    
    ImGui.separator();
    ImGui.text('Hotkey');
    
    const hotkeyEnabledVar = new ImGui.MutableVariable(currentSettings.hotkeyEnabled);
    if (ImGui.checkbox('Enable hotkey', hotkeyEnabledVar)) {
      currentSettings.hotkeyEnabled = hotkeyEnabledVar.value;
      saveSettings();
    }
    
    if (currentSettings.hotkeyEnabled) {
      ImGui.text(`Current: ${getHotkeyDisplayString()}`);
      
      if (waitingForHotkey) {
        ImGui.pushStyleColor(ImGui.Col.Button, colorToU32(0.8, 0.6, 0.0, 1.0));
        ImGui.button("Press any key...", {x: 150, y: 0});
        ImGui.popStyleColor();
        
        // Check current modifier states
        const ctrlDown = ImGui.isKeyDown(ImGui.Key.LeftCtrl) || ImGui.isKeyDown(ImGui.Key.RightCtrl);
        const shiftDown = ImGui.isKeyDown(ImGui.Key.LeftShift) || ImGui.isKeyDown(ImGui.Key.RightShift);
        const altDown = ImGui.isKeyDown(ImGui.Key.LeftAlt) || ImGui.isKeyDown(ImGui.Key.RightAlt);
        
        // Capture next key press (skip modifier keys)
        for (let key = 512; key < 660; key++) {
          if (key === ImGui.Key.LeftCtrl || key === ImGui.Key.RightCtrl ||
              key === ImGui.Key.LeftShift || key === ImGui.Key.RightShift ||
              key === ImGui.Key.LeftAlt || key === ImGui.Key.RightAlt ||
              key === ImGui.Key.LeftSuper || key === ImGui.Key.RightSuper) {
            continue;
          }
          
          if (ImGui.isKeyPressed(key, false)) {
            currentSettings.hotkeyKey = key;
            currentSettings.hotkeyCtrl = ctrlDown;
            currentSettings.hotkeyShift = shiftDown;
            currentSettings.hotkeyAlt = altDown;
            waitingForHotkey = false;
            saveSettings();
            break;
          }
        }
        
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
          currentSettings.hotkeyKey = 0;
          currentSettings.hotkeyCtrl = false;
          currentSettings.hotkeyShift = false;
          currentSettings.hotkeyAlt = false;
          saveSettings();
        }
      }
    }
    
    ImGui.separator();
    
    // Status
    if (nearbyPortals.length > 0) {
      ImGui.textColored({ x: 0.3, y: 1.0, z: 0.3, w: 1.0 }, `Portals found: ${nearbyPortals.length}`);
      for (const p of nearbyPortals) {
        ImGui.text(`  - ${p.name} (${p.distance.toFixed(0)} units)`);
      }
    } else {
      ImGui.textColored({ x: 0.7, y: 0.7, z: 0.7, w: 1.0 }, 'No portals nearby');
    }
    
    ImGui.separator();
    
    if (nearbyPortals.length > 0) {
      if (ImGui.button('Take Nearest Portal', { x: -1, y: 30 })) {
        takeNearestPortal();
      }
    }
  } else {
    // Window is collapsed (begin returned false but window is still "shown")
    if (!currentSettings.settingsWindowCollapsed) {
      currentSettings.settingsWindowCollapsed = true;
      saveSettings();
    }
  }
  ImGui.end();
  
  if (!openVar.value) {
    currentSettings.showSettingsWindow = false;
    saveSettings();
  }
}

/**
 * Plugin draw callback
 */
function onDraw() {
  checkHotkey();
  
  if (poe2.getGameStateIndex() !== 4) {
    nearbyPortals = [];
    return;
  }
  
  // Load settings once when we first enter the game with a valid player
  if (!settingsLoaded) {
    loadSettings();
  }

  const now = Date.now();
  if (now - lastSearchTime > searchIntervalMs) {
    searchForPortals();
    lastSearchTime = now;
  }

  // Portal button ALWAYS shows (ignores F12)
  drawPortalButton();
  
  // Settings window respects F12
  drawSettingsWindow();
}

// Initialize
loadSettings();
console.log('[PortalTaker] Plugin loaded');

// Export plugin
export const portalTakerPlugin = {
  onDraw: onDraw,
  onLoad() {
    loadSettings();
  },
  // Allow opening settings from Plugin Manager or other scripts
  showSettings() {
    currentSettings.showSettingsWindow = true;
  }
};

export const PortalTaker = {
  getNearbyPortals() { return nearbyPortals; },
  searchNow() {
    lastSearchTime = 0;
    searchForPortals();
    return nearbyPortals;
  },
  takePortal: takePortal,
  takeNearestPortal: takeNearestPortal,
  showSettings() { currentSettings.showSettingsWindow = true; }
};

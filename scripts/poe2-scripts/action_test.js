/**
 * Action Wrapper Test Script
 * 
 * Tests the ActionWrapper hooks and action execution.
 * Includes movement packet testing.
 * 
 * Usage:
 * 1. Load this script in-game
 * 2. Move your character around - the hooks will capture player context
 * 3. Check the captured data in the UI
 * 4. Try the experimental move/dodge functions
 * 5. Use the Movement tab to test directional movement packets
 */

import { move, sendMoveRaw, stopMovement, moveNorth, moveSouth, moveEast, moveWest } from './movement.js';

const PLUGIN_NAME = "Action Test";

// State
let isInitialized = false;
let lastAction = null;
let actionLog = [];
const MAX_LOG_ENTRIES = 20;

// Packet capture state
let capturedPackets = [];
const MAX_PACKET_DISPLAY = 50;

// Initialize on load
function init() {
  console.log(`[${PLUGIN_NAME}] Initializing...`);
  
  if (typeof Actions === 'undefined') {
    console.error(`[${PLUGIN_NAME}] Actions API not available!`);
    return false;
  }
  
  const result = Actions.initialize();
  console.log(`[${PLUGIN_NAME}] Initialize result: ${result}`);
  console.log(`[${PLUGIN_NAME}] Is hooked: ${Actions.isHooked()}`);
  console.log(`[${PLUGIN_NAME}] Move handler: 0x${Actions.getMoveHandlerAddress().toString(16)}`);
  console.log(`[${PLUGIN_NAME}] Dodge handler: 0x${Actions.getDodgeHandlerAddress().toString(16)}`);
  
  isInitialized = result;
  return result;
}

// Poll for new action data
function pollActionData() {
  if (!isInitialized) return;
  
  const action = Actions.getLastCapturedAction();
  if (action && action.timestamp !== (lastAction?.timestamp || 0)) {
    lastAction = action;
    
    // Add to log
    actionLog.unshift({
      time: new Date().toLocaleTimeString(),
      typeId: action.actionTypeId,
      coords: `(${action.coordX.toFixed(2)}, ${action.coordY.toFixed(2)})`,
      context: `0x${action.playerContext.toString(16)}`
    });
    
    // Trim log
    if (actionLog.length > MAX_LOG_ENTRIES) {
      actionLog.pop();
    }
  }
}

// Main draw function
function draw() {
  // Poll for new data
  pollActionData();
  
  // Window setup
  ImGui.setNextWindowSize({x: 500, y: 400}, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({x: 50, y: 400}, ImGui.Cond.FirstUseEver);
  
  if (!ImGui.begin(PLUGIN_NAME, null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Status section
  if (ImGui.collapsingHeader("Status", ImGui.TreeNodeFlags.DefaultOpen)) {
    ImGui.text(`Initialized: ${isInitialized}`);
    ImGui.text(`Hooked: ${isInitialized ? Actions.isHooked() : 'N/A'}`);
    
    if (isInitialized) {
      const ctx = Actions.getPlayerContext();
      ImGui.text(`Player Context: 0x${ctx.toString(16)}`);
      
      if (ctx === 0n) {
        ImGui.textColored({x: 1, y: 0.5, z: 0, w: 1}, 
          "Move your character to capture player context!");
      }
    }
    
    if (!isInitialized) {
      if (ImGui.button("Initialize")) {
        init();
      }
    }
  }
  
  // Last captured action
  if (ImGui.collapsingHeader("Last Captured Action", ImGui.TreeNodeFlags.DefaultOpen)) {
    if (lastAction) {
      ImGui.text(`Action Type ID: ${lastAction.actionTypeId}`);
      ImGui.text(`Coordinates: (${lastAction.coordX.toFixed(2)}, ${lastAction.coordY.toFixed(2)})`);
      ImGui.text(`Player Context: 0x${lastAction.playerContext.toString(16)}`);
      ImGui.text(`Target Data Ptr: 0x${lastAction.targetDataPtr.toString(16)}`);
      ImGui.text(`Target Data[0]: 0x${lastAction.targetData[0].toString(16)}`);
      ImGui.text(`Target Data[1]: 0x${lastAction.targetData[1].toString(16)}`);
    } else {
      ImGui.text("No action captured yet. Move around!");
    }
  }
  
  // Action log
  if (ImGui.collapsingHeader("Action Log")) {
    for (const entry of actionLog) {
      ImGui.text(`[${entry.time}] Type: ${entry.typeId} ${entry.coords}`);
    }
    
    if (actionLog.length === 0) {
      ImGui.text("No actions logged yet.");
    }
  }
  
  // Experimental actions
  if (ImGui.collapsingHeader("Experimental Actions")) {
    ImGui.textColored({x: 1, y: 0.5, z: 0, w: 1}, 
      "WARNING: These may crash the game!");
    
    const ctx = isInitialized ? Actions.getPlayerContext() : 0n;
    const canTry = ctx !== 0n;
    
    if (!canTry) {
      ImGui.textDisabled("Move around first to capture player context");
    }
    
    ImGui.separator();
    
    // Try Move
    ImGui.text("Try Move:");
    ImGui.sameLine();
    
    if (ImGui.button("Move +100X") && canTry) {
      const current = lastAction || {coordX: 0, coordY: 0};
      const result = Actions.tryMove(current.coordX + 100, current.coordY);
      console.log(`TryMove result: ${result}`);
    }
    ImGui.sameLine();
    if (ImGui.button("Move +100Y") && canTry) {
      const current = lastAction || {coordX: 0, coordY: 0};
      const result = Actions.tryMove(current.coordX, current.coordY + 100);
      console.log(`TryMove result: ${result}`);
    }
    
    // Try Dodge
    ImGui.text("Try Dodge:");
    ImGui.sameLine();
    
    if (ImGui.button("Dodge Right") && canTry) {
      const result = Actions.tryDodgeRoll(1, 0);
      console.log(`TryDodgeRoll result: ${result}`);
    }
    ImGui.sameLine();
    if (ImGui.button("Dodge Left") && canTry) {
      const result = Actions.tryDodgeRoll(-1, 0);
      console.log(`TryDodgeRoll result: ${result}`);
    }
  }
  
  // Packet capture
  if (ImGui.collapsingHeader("Packet Capture", ImGui.TreeNodeFlags.DefaultOpen)) {
    if (!isInitialized) {
      ImGui.text("Initialize first to enable packet capture.");
    } else {
      const captureEnabled = Actions.isPacketCaptureEnabled();
      const packetCount = Actions.getCapturedPacketCount();
      
      ImGui.text(`Capture Enabled: ${captureEnabled}`);
      ImGui.text(`Pending Packets: ${packetCount}`);
      
      ImGui.sameLine();
      if (ImGui.button(captureEnabled ? "Stop Capture" : "Start Capture")) {
        Actions.setPacketCaptureEnabled(!captureEnabled);
        console.log(`[${PLUGIN_NAME}] Packet capture ${!captureEnabled ? 'enabled' : 'disabled'}`);
      }
      
      ImGui.sameLine();
      if (ImGui.button("Fetch Packets")) {
        const newPackets = Actions.getCapturedPackets();
        console.log(`[${PLUGIN_NAME}] Fetched ${newPackets.length} packets`);
        capturedPackets = newPackets.concat(capturedPackets).slice(0, MAX_PACKET_DISPLAY);
      }
      
      ImGui.sameLine();
      if (ImGui.button("Clear")) {
        capturedPackets = [];
        Actions.clearCapturedPackets();
      }
      
      ImGui.separator();
      
      // Display captured packets
      if (capturedPackets.length > 0) {
        ImGui.text(`Displaying ${capturedPackets.length} packets:`);
        
        // Create a scrollable child region
        ImGui.beginChild("PacketList", {x: 0, y: 200}, true);
        
        for (let i = 0; i < capturedPackets.length; i++) {
          const pkt = capturedPackets[i];
          
          // Collapsible header for each packet
          if (ImGui.treeNode(`Pkt ${i}: ${pkt.size} bytes @ ${pkt.timestamp}`)) {
            // Show first few bytes as preview
            const preview = pkt.hex.substring(0, 80);
            ImGui.textWrapped(`Hex: ${preview}`);
            
            // Try to parse as action packet
            if (pkt.data && pkt.data.length >= 2) {
              // First 2 bytes after serialization might be packet type
              const byte0 = pkt.data[0];
              const byte1 = pkt.data[1];
              ImGui.text(`First bytes: 0x${byte0.toString(16).padStart(2, '0')} 0x${byte1.toString(16).padStart(2, '0')}`);
              
              // Check for known action type bytes
              if (pkt.data.length >= 4) {
                // Try reading as big-endian uint16 (after htons)
                const packetType = (pkt.data[0] << 8) | pkt.data[1];
                ImGui.text(`Packet Type (BE): ${packetType} (0x${packetType.toString(16)})`);
              }
            }
            
            ImGui.treePop();
          }
        }
        
        ImGui.endChild();
      } else {
        ImGui.textColored({x: 0.5, y: 0.5, z: 0.5, w: 1}, 
          "No packets captured. Enable capture and perform actions.");
      }
    }
  }

  // Known action types
  if (ImGui.collapsingHeader("Known Action Types")) {
    if (isInitialized) {
      const types = Actions.getKnownActionTypes();
      for (const t of types) {
        ImGui.text(`${t.name}: ID=${t.typeId}, Offset=0x${t.handlerOffset.toString(16)}, Size=${t.objectSize}`);
      }
    } else {
      ImGui.text("Initialize first to see action types.");
    }
  }
  
  // Registered Actions (from hook)
  if (ImGui.collapsingHeader("Registered Actions (Hook Capture)", ImGui.TreeNodeFlags.DefaultOpen)) {
    if (!isInitialized) {
      ImGui.text("Initialize first to enable action registration capture.");
      ImGui.textColored({x: 1, y: 0.7, z: 0, w: 1}, 
        "NOTE: Hook must be active BEFORE game registers actions.");
      ImGui.textColored({x: 1, y: 0.7, z: 0, w: 1}, 
        "Inject early (before entering game) to capture all registrations.");
    } else {
      const regCount = Actions.getRegisteredActionCount();
      ImGui.text(`Captured Registrations: ${regCount}`);
      
      if (ImGui.button("Refresh")) {
        // Just triggers re-render
      }
      ImGui.sameLine();
      if (ImGui.button("Save to JSON")) {
        const path = "registered_actions.json";
        const ok = Actions.saveRegisteredActionsToJson(path);
        console.log(`[${PLUGIN_NAME}] Save to ${path}: ${ok}`);
      }
      
      ImGui.separator();
      
      if (regCount > 0) {
        const actions = Actions.getRegisteredActions();
        
        ImGui.beginChild("RegActionsList", {x: 0, y: 200}, true);
        for (const action of actions) {
          ImGui.text(`${action.name}: ID=${action.typeId}, handler=0x${action.handler1.toString(16)}, p4=${action.param4}, p5=${action.param5}`);
        }
        ImGui.endChild();
      } else {
        ImGui.textColored({x: 0.5, y: 0.5, z: 0.5, w: 1}, 
          "No registrations captured yet.");
        ImGui.textColored({x: 0.5, y: 0.5, z: 0.5, w: 1}, 
          "Actions are registered at game startup.");
        ImGui.textColored({x: 0.5, y: 0.5, z: 0.5, w: 1}, 
          "Re-inject before entering game to capture them.");
      }
    }
  }
  
  // Movement Testing
  if (ImGui.collapsingHeader("Movement Testing", ImGui.TreeNodeFlags.DefaultOpen)) {
    ImGui.textColored({x: 0.5, y: 1, z: 0.5, w: 1}, "Direct Packet Movement");
    ImGui.text("Isometric: +X=NE, +Y=NW, -X=SW, -Y=SE");
    
    ImGui.separator();
    
    // Compass-style directional buttons
    //        NW    N    NE
    //        W    STOP   E
    //        SW    S    SE
    
    ImGui.text("Directions:");
    
    // Row 1: NW, N, NE
    ImGui.dummy({x: 40, y: 0});  // Left padding
    ImGui.sameLine();
    if (ImGui.button("NW", {x: 50, y: 30})) {
      const ok = move('nw', 100);
      console.log(`[${PLUGIN_NAME}] Move NW: ${ok}`);
    }
    ImGui.sameLine();
    if (ImGui.button("N", {x: 50, y: 30})) {
      const ok = moveNorth(100);
      console.log(`[${PLUGIN_NAME}] Move North: ${ok}`);
    }
    ImGui.sameLine();
    if (ImGui.button("NE", {x: 50, y: 30})) {
      const ok = move('ne', 100);
      console.log(`[${PLUGIN_NAME}] Move NE: ${ok}`);
    }
    
    // Row 2: W, STOP, E
    ImGui.dummy({x: 40, y: 0});
    ImGui.sameLine();
    if (ImGui.button("W", {x: 50, y: 30})) {
      const ok = moveWest(100);
      console.log(`[${PLUGIN_NAME}] Move West: ${ok}`);
    }
    ImGui.sameLine();
    if (ImGui.button("STOP", {x: 50, y: 30})) {
      const ok = stopMovement();
      console.log(`[${PLUGIN_NAME}] Stop: ${ok}`);
    }
    ImGui.sameLine();
    if (ImGui.button("E", {x: 50, y: 30})) {
      const ok = moveEast(100);
      console.log(`[${PLUGIN_NAME}] Move East: ${ok}`);
    }
    
    // Row 3: SW, S, SE
    ImGui.dummy({x: 40, y: 0});
    ImGui.sameLine();
    if (ImGui.button("SW", {x: 50, y: 30})) {
      const ok = move('sw', 100);
      console.log(`[${PLUGIN_NAME}] Move SW: ${ok}`);
    }
    ImGui.sameLine();
    if (ImGui.button("S", {x: 50, y: 30})) {
      const ok = moveSouth(100);
      console.log(`[${PLUGIN_NAME}] Move South: ${ok}`);
    }
    ImGui.sameLine();
    if (ImGui.button("SE", {x: 50, y: 30})) {
      const ok = move('se', 100);
      console.log(`[${PLUGIN_NAME}] Move SE: ${ok}`);
    }
    
    ImGui.separator();
    
    // Custom movement input
    ImGui.text("Custom Move (raw deltas):");
    if (ImGui.button("Raw +100X")) {
      sendMoveRaw(100, 0);
    }
    ImGui.sameLine();
    if (ImGui.button("Raw +100Y")) {
      sendMoveRaw(0, 100);
    }
    ImGui.sameLine();
    if (ImGui.button("Raw -100X")) {
      sendMoveRaw(-100, 0);
    }
    ImGui.sameLine();
    if (ImGui.button("Raw -100Y")) {
      sendMoveRaw(0, -100);
    }
    
    ImGui.separator();
    
    // Distance testing - find the real cap
    ImGui.text("Distance Test (North) - find the cap:");
    
    // Row 1: small values
    if (ImGui.button("100##d")) { moveNorth(100); }
    ImGui.sameLine();
    if (ImGui.button("200##d")) { moveNorth(200); }
    ImGui.sameLine();
    if (ImGui.button("300##d")) { moveNorth(300); }
    ImGui.sameLine();
    if (ImGui.button("400##d")) { moveNorth(400); }
    ImGui.sameLine();
    if (ImGui.button("500##d")) { moveNorth(500); }
    
    // Row 2: medium values
    if (ImGui.button("600##d")) { moveNorth(600); }
    ImGui.sameLine();
    if (ImGui.button("700##d")) { moveNorth(700); }
    ImGui.sameLine();
    if (ImGui.button("800##d")) { moveNorth(800); }
    ImGui.sameLine();
    if (ImGui.button("900##d")) { moveNorth(900); }
    ImGui.sameLine();
    if (ImGui.button("1000##d")) { moveNorth(1000); }
    
    // Row 3: large values
    if (ImGui.button("1500##d")) { moveNorth(1500); }
    ImGui.sameLine();
    if (ImGui.button("2000##d")) { moveNorth(2000); }
    ImGui.sameLine();
    if (ImGui.button("3000##d")) { moveNorth(3000); }
    ImGui.sameLine();
    if (ImGui.button("5000##d")) { moveNorth(5000); }
    ImGui.sameLine();
    if (ImGui.button("10000##d")) { moveNorth(10000); }
  }
  
  ImGui.end();
}

// onDraw function for plugin system
function onDraw() {
  // Initialize on first draw if not already done
  if (!isInitialized && typeof Actions !== 'undefined') {
    init();
  }
  draw();
}

// Export plugin
export const actionTestPlugin = {
  onDraw: onDraw
};

console.log("[Action Test] Plugin loaded");


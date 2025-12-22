/**
 * POE2 Main Script
 * 
 * Loads plugins and sets up packet interception.
 */

import { POE2 } from 'poe2';
// Import the entity radar plugin
import { entityRadarPlugin } from './entity_radar.js';

let receivedCount = 0;
let sentCount = 0;

console.log("========================================");
console.log("POE2 Packet Interceptor Started!");
console.log("========================================");

// Register the entity radar plugin
console.log("Registering entity_radar plugin...");
try {
  Plugins.register("entity_radar", entityRadarPlugin, true);
  console.log("✓ entity_radar plugin registered successfully");
} catch (e) {
  console.error("✗ Failed to register entity_radar:", e);
}

console.log("Installing packet listeners...");

// Add receive listener
POE2.addReceiveListener((data) => {
  receivedCount++;
  
  // Log first 5 packets in detail
  if (receivedCount <= 5) {
    let hex = "";
    for (let i = 0; i < Math.min(data.length, 16); i++) {
      hex += data[i].toString(16).padStart(2, '0') + " ";
    }
    console.log(`[RECV #${receivedCount}] ${data.length} bytes: ${hex}`);
  }
  
  // Log every 100th packet after that
  if (receivedCount % 100 === 0) {
    console.log(`[RECV] Total packets received: ${receivedCount}`);
  }
});

// Add send listener
POE2.addSendListener((data) => {
  sentCount++;
  
  // Log first 5 packets in detail
  if (sentCount <= 5) {
    let hex = "";
    for (let i = 0; i < Math.min(data.length, 16); i++) {
      hex += data[i].toString(16).padStart(2, '0') + " ";
    }
    console.log(`[SEND #${sentCount}] ${data.length} bytes: ${hex}`);
  }
  
  // Log every 100th packet after that
  if (sentCount % 100 === 0) {
    console.log(`[SEND] Total packets sent: ${sentCount}`);
  }
});

console.log("Packet listeners installed!");
console.log("Waiting for network traffic...");
console.log("(Move around in-game to generate packets)");

// Required tick function (even though we're not using ImGui)
export function tick() {
  // No ImGui UI since D3D12 renderer doesn't work with POE2's D3D11
  // All logging happens via console.log which goes to logs/jmrd2r.log
}

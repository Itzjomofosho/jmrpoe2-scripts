/**
 * POE2 Packet Logger Example
 * 
 * This example demonstrates how to intercept and log POE2 network packets.
 * It shows both incoming (receive) and outgoing (send) packets.
 */

import { ImGui } from 'imgui';
import { POE2 } from 'poe2';

// Packet statistics
let receivedCount = 0;
let sentCount = 0;
let receivedBytes = 0;
let sentBytes = 0;

// Recent packets (keep last 100)
let recentReceived = [];
let recentSent = [];
const MAX_RECENT = 100;

// Helper to convert Uint8Array to hex string
function toHexString(arr, maxBytes = 16) {
  if (arr.length === 0) return "";
  
  const bytesToShow = Math.min(arr.length, maxBytes);
  let hex = "";
  for (let i = 0; i < bytesToShow; i++) {
    hex += arr[i].toString(16).padStart(2, '0') + " ";
  }
  if (arr.length > maxBytes) {
    hex += "...";
  }
  return hex.trim();
}

// Add packet listeners
POE2.addReceiveListener((data) => {
  receivedCount++;
  receivedBytes += data.length;
  
  // Store recent packet info
  recentReceived.push({
    size: data.length,
    hex: toHexString(data),
    timestamp: Date.now()
  });
  
  // Keep only recent packets
  if (recentReceived.length > MAX_RECENT) {
    recentReceived.shift();
  }
  
  // Log to console (disable if too spammy)
  // console.log(`[RECV] ${data.length} bytes: ${toHexString(data)}`);
});

POE2.addSendListener((data) => {
  sentCount++;
  sentBytes += data.length;
  
  // Store recent packet info
  recentSent.push({
    size: data.length,
    hex: toHexString(data),
    timestamp: Date.now()
  });
  
  // Keep only recent packets
  if (recentSent.length > MAX_RECENT) {
    recentSent.shift();
  }
  
  // Log to console (disable if too spammy)
  // console.log(`[SEND] ${data.length} bytes: ${toHexString(data)}`);
});

export function tick() {
  ImGui.Begin("POE2 Packet Logger");
  
  // Statistics
  ImGui.Text("Packet Statistics");
  ImGui.Separator();
  ImGui.Text(`Received: ${receivedCount} packets (${receivedBytes} bytes)`);
  ImGui.Text(`Sent: ${sentCount} packets (${sentBytes} bytes)`);
  
  ImGui.Separator();
  
  // Control buttons
  if (ImGui.Button("Clear Statistics")) {
    receivedCount = 0;
    sentCount = 0;
    receivedBytes = 0;
    sentBytes = 0;
    recentReceived = [];
    recentSent = [];
  }
  
  ImGui.SameLine();
  
  if (ImGui.Button("Clear Listeners")) {
    POE2.clearListeners();
    console.log("Cleared all packet listeners");
  }
  
  ImGui.Separator();
  
  // Recent packets tabs
  if (ImGui.BeginTabBar("PacketTabs")) {
    if (ImGui.BeginTabItem("Recent Received")) {
      ImGui.Text(`Last ${recentReceived.length} packets:`);
      ImGui.Separator();
      
      if (ImGui.BeginChild("ReceivedList", [0, 300])) {
        for (let i = recentReceived.length - 1; i >= 0; i--) {
          const packet = recentReceived[i];
          ImGui.Text(`[${packet.size} bytes] ${packet.hex}`);
        }
      }
      ImGui.EndChild();
      
      ImGui.EndTabItem();
    }
    
    if (ImGui.BeginTabItem("Recent Sent")) {
      ImGui.Text(`Last ${recentSent.length} packets:`);
      ImGui.Separator();
      
      if (ImGui.BeginChild("SentList", [0, 300])) {
        for (let i = recentSent.length - 1; i >= 0; i--) {
          const packet = recentSent[i];
          ImGui.Text(`[${packet.size} bytes] ${packet.hex}`);
        }
      }
      ImGui.EndChild();
      
      ImGui.EndTabItem();
    }
    
    ImGui.EndTabBar();
  }
  
  ImGui.End();
}


/**
 * Entity Radar - Simple Test Version
 */

import { ImGui } from 'imgui';

// Core logic - always runs
function onDraw() {
  // Core logic can go here if needed
}

// UI drawing - only runs when UI is visible (F12 toggle)
function onDrawUI() {
  ImGui.Begin("Entity Radar (Test)", null, 0);
  
  ImGui.Text("Plugin is working!");
  ImGui.Text("This is a test version.");
  
  ImGui.End();
}

// Export the plugin object for registration
export const entityRadarPlugin = {
  onDraw: onDraw,
  onDrawUI: onDrawUI
};

console.log("Entity Radar (simple) module loaded");


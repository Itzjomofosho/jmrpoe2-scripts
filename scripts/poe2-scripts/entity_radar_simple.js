/**
 * Entity Radar - Simple Test Version
 */

import { ImGui } from 'imgui';

function onDraw() {
  ImGui.Begin("Entity Radar (Test)", null, 0);
  
  ImGui.Text("Plugin is working!");
  ImGui.Text("This is a test version.");
  
  ImGui.End();
}

// Export the plugin object for registration
export const entityRadarPlugin = {
  onDraw: onDraw
};

console.log("Entity Radar (simple) module loaded");


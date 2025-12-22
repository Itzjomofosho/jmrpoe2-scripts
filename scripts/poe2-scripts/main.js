/**
 * POE2 Main Script
 * 
 * Loads Entity Radar plugin for position tracking
 */

import { chickenPlugin } from './chicken.js';
import { entityExplorerPlugin } from './entity_explorer.js';
import { entityActionsPlugin } from './entity_actions.js';

console.log("========================================");
console.log("POE2 Main Script Starting!");
console.log("========================================");

// Register plugins
console.log("Registering plugins...");
try {
  Plugins.register("chicken", chickenPlugin, true);
  Plugins.register("entity_explorer", entityExplorerPlugin, false);
  Plugins.register("entity_actions", entityActionsPlugin, false);
  console.log("✓ Plugins registered");
} catch (e) {
  console.error("✗ Failed to register plugins:", e);
}

console.log("Main script initialization complete");
console.log("========================================");

// Required tick function
export function tick() {
  // Framework calls this every frame
}

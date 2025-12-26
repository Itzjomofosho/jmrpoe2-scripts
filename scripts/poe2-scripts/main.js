/**
 * POE2 Main Script
 * 
 * Loads Entity Radar plugin for position tracking
 * 
 * IMPORTANT: This is the ONLY place where POE2Cache.beginFrame() should be called!
 * Individual plugins should NOT call beginFrame() - they use the shared cache.
 */

import { POE2Cache } from './poe2_cache.js';
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

// Required tick function - called every frame
// NOTE: Must be assigned to globalThis for the framework to find it!
function tick() {
  // IMPORTANT: Call beginFrame() ONCE per frame, BEFORE any plugin code runs
  // This invalidates per-frame caches and checks for area changes
  POE2Cache.beginFrame();
  
  // Framework calls plugin onDraw() functions after this
}

// Assign to global scope so the framework can find it
// (ES modules don't automatically expose exports as globals)
globalThis.tick = tick;

// Also export for module compatibility
export { tick };

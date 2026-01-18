/**
 * POE2 Main Script
 * 
 * Loads plugins for POE2 overlay functionality.
 * 
 * IMPORTANT: This is the ONLY place where POE2Cache.beginFrame() should be called!
 * Individual plugins should NOT call beginFrame() - they use the shared cache.
 * 
 * NOTE: All imported plugin files MUST exist or the script will fail to load.
 * Comment out any imports for plugins you want to disable.
 */

import { POE2Cache } from './poe2_cache.js';
import { chickenPlugin } from './chicken.js';
import { entityExplorerPlugin } from './entity_explorer.js';
import { entityActionsPlugin } from './entity_actions.js';
import { espPlugin } from './esp.js';
import { portalTakerPlugin } from './portal_taker.js';
import { openerPlugin } from './opener.js';
import { pickitPlugin } from './pickit.js';
import { atlasPlugin } from './atlas_plugin.js';

console.log("========================================");
console.log("POE2 Main Script Starting!");
console.log("========================================");

// Register plugins - each in its own try/catch so one failure doesn't stop others
console.log("Registering plugins...");
let registered = 0;

try { Plugins.register("chicken", chickenPlugin, true); registered++; }
catch (e) { console.error("✗ Failed to register chicken:", e); }

try { Plugins.register("entity_explorer", entityExplorerPlugin, false); registered++; }
catch (e) { console.error("✗ Failed to register entity_explorer:", e); }

try { Plugins.register("entity_actions", entityActionsPlugin, false); registered++; }
catch (e) { console.error("✗ Failed to register entity_actions:", e); }

try { Plugins.register("esp", espPlugin, true); registered++; }
catch (e) { console.error("✗ Failed to register esp:", e); }

try { Plugins.register("portal_taker", portalTakerPlugin, true); registered++; }
catch (e) { console.error("✗ Failed to register portal_taker:", e); }

try { Plugins.register("opener", openerPlugin, false); registered++; }
catch (e) { console.error("✗ Failed to register opener:", e); }

try { Plugins.register("pickit", pickitPlugin, false); registered++; }
catch (e) { console.error("✗ Failed to register pickit:", e); }

try { Plugins.register("atlas_explorer", atlasPlugin, false); registered++; }
catch (e) { console.error("✗ Failed to register atlas_explorer:", e); }

console.log(`✓ ${registered} plugins registered`);
console.log("Main script initialization complete");
console.log("========================================");

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

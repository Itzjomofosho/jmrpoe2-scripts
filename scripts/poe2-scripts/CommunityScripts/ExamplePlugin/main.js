/**
 * Example Community Plugin
 * 
 * This shows the minimum structure for a community script.
 * Place your plugin folder inside CommunityScripts/ and it will
 * be auto-discovered and registered on startup.
 * 
 * Your main.js must default-export an object with:
 *   name        - Unique plugin name (used for enable/disable)
 *   author      - Your name (shown in plugin browser)
 *   description - Short description (shown on hover in plugin browser)
 *   plugin      - Object with lifecycle callbacks
 * 
 * Available callbacks:
 *   onEnable()  - Called when plugin is enabled
 *   onDisable() - Called when plugin is disabled
 *   onTick()    - Called every frame (read phase - read game memory here)
 *   onDraw()    - Called every frame (draw phase - render overlays here)
 *   onDrawUI()  - Called every frame when UI is visible (F12) - ImGui panels
 */

let enabled = false;

const plugin = {
  onEnable() {
    enabled = true;
    console.log('[ExamplePlugin] Enabled!');
  },

  onDisable() {
    enabled = false;
    console.log('[ExamplePlugin] Disabled!');
  },

  onDrawUI() {
    if (!enabled) return;
    ImGui.begin('Example Community Plugin');
    ImGui.text('Hello from a community plugin!');
    ImGui.text('Edit CommunityScripts/ExamplePlugin/main.js to customize.');
    ImGui.end();
  }
};

export default {
  name: 'example_community',
  author: 'Jmr',
  description: 'A minimal example showing how to create a community plugin.',
  plugin
};

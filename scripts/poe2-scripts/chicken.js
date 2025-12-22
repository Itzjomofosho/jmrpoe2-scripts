/**
 * Chicken Plugin - Auto-Disconnect on Low Health
 * 
 * Automatically sends disconnect packet when health drops below threshold.
 */

const poe2 = new POE2();

// Settings
let enabled = true;  // Start disabled for safety
let threshold = 75;   // Health % threshold (default 75%)
let panicThreshold = 20;  // Emergency threshold (20%)
let lastHealthPercent = 100;
let triggeredAt75 = false;
let triggeredAt20 = false;

// Send health potion packet
function useHealthPotion() {
  const packet = new Uint8Array([0x00, 0x76, 0x01, 0x00, 0x00, 0x00, 0x00]);
  const success = poe2.sendPacket(packet);
  console.log(`[Chicken] Health potion used at ${threshold}% threshold (success=${success})`);
  triggeredAt75 = true;
}

// Send exit to character select packet
function exitToCharacterSelect() {
  const packet = new Uint8Array([0x01, 0x58, 0x00]);
  const success = poe2.sendPacket(packet);
  console.log(`[Chicken] EMERGENCY EXIT at ${panicThreshold}% (success=${success})`);
  triggeredAt20 = true;
}

// Update health monitoring
function updateHealth() {
  if (!enabled) return;
  
  try {
    const player = poe2.getLocalPlayer();
    if (!player || !player.healthMax || player.healthMax <= 0) {
      return;
    }
    
    const healthCurrent = player.healthCurrent || 0;
    const healthMax = player.healthMax;
    const healthPercent = (healthCurrent / healthMax) * 100;
    
    lastHealthPercent = healthPercent;
    
    // Reset triggers if health recovers above threshold
    if (healthPercent > threshold) {
      triggeredAt75 = false;
    }
    if (healthPercent > panicThreshold) {
      triggeredAt20 = false;
    }
    
    // Check thresholds
    if (healthCurrent > 0) {
      // Emergency threshold (20%) - exit to character select
      if (healthPercent < panicThreshold && !triggeredAt20) {
        exitToCharacterSelect();
      }
      // Normal threshold (configurable, default 75%) - use health potion
      else if (healthPercent < threshold && !triggeredAt75) {
        useHealthPotion();
      }
    }
    
  } catch (e) {
    console.error('[Chicken] Error:', e);
  }
}

// Draw UI
function onDraw() {
  updateHealth();
  
  ImGui.setNextWindowSize({x: 350, y: 200}, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({x: 750, y: 10}, ImGui.Cond.FirstUseEver);  // Top, offset from zoom
  ImGui.setNextWindowCollapsed(true, ImGui.Cond.FirstUseEver);  // Start collapsed
  
  if (!ImGui.begin("Chicken (Auto-Disconnect)", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Enable/Disable
  const enableColor = enabled ? [0.2, 0.6, 0.2, 1.0] : [0.8, 0.2, 0.2, 1.0];
  ImGui.pushStyleColor(ImGui.Col.Button, enableColor);
  if (ImGui.button(enabled ? 'ENABLED (CLICK TO DISABLE)' : 'DISABLED (Click to Enable)', {x: 320, y: 30})) {
    enabled = !enabled;
    if (enabled) {
      console.log('[Chicken] Plugin ENABLED');
    } else {
      console.log('[Chicken] Plugin DISABLED');
      triggeredAt75 = false;
      triggeredAt20 = false;
    }
  }
  ImGui.popStyleColor(1);
  
  if (enabled) {
    ImGui.textColored([1.0, 0.3, 0.3, 1.0], "WARNING: Auto-disconnect active!");
  }
  
  ImGui.separator();
  
  // Current health display
  const player = poe2.getLocalPlayer();
  if (player && player.healthMax > 0) {
    const healthCurrent = player.healthCurrent || 0;
    const healthMax = player.healthMax;
    const healthPercent = (healthCurrent / healthMax) * 100;
    
    ImGui.text(`Current Health: ${healthCurrent}/${healthMax}`);
    ImGui.text(`Health %: ${healthPercent.toFixed(1)}%`);
    
    // Color based on health
    let healthColor = [0.3, 1.0, 0.3, 1.0];  // Green
    if (healthPercent < panicThreshold) {
      healthColor = [1.0, 0.0, 0.0, 1.0];  // Red
    } else if (healthPercent < threshold) {
      healthColor = [1.0, 0.5, 0.0, 1.0];  // Orange
    }
    
    ImGui.textColored(healthColor, `Status: ${healthPercent < panicThreshold ? 'EMERGENCY!' : healthPercent < threshold ? 'DANGER' : 'Safe'}`);
  } else {
    ImGui.textColored([0.5, 0.5, 0.5, 1.0], "Not in game or no health data");
  }
  
  ImGui.separator();
  
  // Threshold controls
  ImGui.text(`Main Threshold: ${threshold}%`);
  ImGui.sameLine();
  if (ImGui.button("-##thresh")) threshold = Math.max(10, threshold - 5);
  ImGui.sameLine();
  if (ImGui.button("+##thresh")) threshold = Math.min(95, threshold + 5);
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], `(Disconnect if HP < ${threshold}%)`);
  
  ImGui.separator();
  
  ImGui.text(`Panic Threshold: ${panicThreshold}%`);
  ImGui.sameLine();
  if (ImGui.button("-##panic")) panicThreshold = Math.max(5, panicThreshold - 5);
  ImGui.sameLine();
  if (ImGui.button("+##panic")) panicThreshold = Math.min(50, panicThreshold + 5);
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], `(Emergency disconnect if HP < ${panicThreshold}%)`);
  
  ImGui.separator();
  
  // Status
  if (triggeredAt20) {
    ImGui.textColored([1.0, 0.0, 0.0, 1.0], "EMERGENCY DISCONNECT TRIGGERED!");
  } else if (triggeredAt75) {
    ImGui.textColored([1.0, 0.5, 0.0, 1.0], "Disconnect triggered at threshold");
  } else if (enabled) {
    ImGui.textColored([0.3, 1.0, 0.3, 1.0], "Monitoring...");
  }
  
  ImGui.separator();
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], `At ${threshold}%: Use Health Potion`);
  ImGui.textColored([1.0, 0.3, 0.3, 1.0], `At ${panicThreshold}%: EXIT TO CHARACTER SELECT`);
  
  ImGui.end();
}

// Export plugin
export const chickenPlugin = {
  onDraw: onDraw
};

console.log("Chicken plugin loaded");


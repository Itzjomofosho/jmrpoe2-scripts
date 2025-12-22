/**
 * Entity Radar - Position Tracking Plugin
 * 
 * Tracks player position and calculates distances to nearby entities.
 * Uses the grid coordinates at Entity+0x3FC (grid_x) and Entity+0x400 (grid_y)
 * discovered through reverse engineering.
 */

import { ImGui } from 'imgui';
import { POE2 } from 'poe2';

// State
let entities = [];
let playerEntity = null;
let lastUpdate = 0;
let updateInterval = 100; // ms

// Settings
let maxDistance = 100;
let showMonsters = true;
let showCharacters = true;
let showMiscellaneous = true;
let sortByDistance = true;
let maxDisplayCount = 50;

// Distance calculation (simple 2D grid distance)
function calculateDistance(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

// Get category from metadata path
function getCategory(path) {
  if (!path) return "Unknown";
  const match = path.match(/Metadata\/([^\/]+)\//);
  return match ? match[1] : "Unknown";
}

// Get short name from path
function getShortName(path) {
  if (!path) return "<unknown>";
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

// Update entity data
function updateEntities() {
  const now = Date.now();
  if (now - lastUpdate < updateInterval) {
    return;
  }
  lastUpdate = now;
  
  // Get entities from POE2 API
  try {
    const allEntities = POE2.getEntities();
    
    // Find player (Characters category)
    playerEntity = allEntities.find(e => 
      e.name && e.name.includes('Characters/') && 
      e.name.includes('Dex') || e.name.includes('Str') || e.name.includes('Int')
    );
    
    if (!playerEntity) {
      entities = [];
      return;
    }
    
    // Calculate distances and filter
    entities = allEntities
      .filter(e => e !== playerEntity) // Exclude player
      .map(e => {
        const dist = calculateDistance(
          playerEntity.gridX, playerEntity.gridY,
          e.gridX, e.gridY
        );
        
        return {
          ...e,
          distance: dist,
          category: getCategory(e.name),
          shortName: getShortName(e.name)
        };
      })
      .filter(e => {
        // Apply distance filter
        if (e.distance > maxDistance) return false;
        
        // Apply category filters
        if (!showMonsters && e.category === 'Monsters') return false;
        if (!showCharacters && e.category === 'Characters') return false;
        if (!showMiscellaneous && e.category === 'MiscellaneousObjects') return false;
        
        return true;
      });
    
    // Sort by distance
    if (sortByDistance) {
      entities.sort((a, b) => a.distance - b.distance);
    }
    
    // Limit display count
    if (entities.length > maxDisplayCount) {
      entities = entities.slice(0, maxDisplayCount);
    }
    
  } catch (e) {
    console.error("Failed to get entities:", e);
  }
}

function onDraw() {
  updateEntities();
  
  ImGui.Begin("Entity Radar", null, 0);
  
  // Player info
  if (playerEntity) {
    ImGui.TextColored([0.5, 1.0, 0.5, 1.0], "Player Position:");
    ImGui.Text(`  Grid: (${playerEntity.gridX}, ${playerEntity.gridY})`);
    ImGui.Text(`  Name: ${getShortName(playerEntity.name)}`);
  } else {
    ImGui.TextColored([1.0, 0.5, 0.5, 1.0], "Player not found");
    ImGui.Text("(Character entity with 'Dex/Str/Int' not detected)");
  }
  
  ImGui.Separator();
  
  // Settings
  if (ImGui.CollapsingHeader("Settings")) {
    ImGui.SliderInt("Max Distance", maxDistance, 10, 500);
    maxDistance = ImGui.GetSliderIntValue();
    
    ImGui.SliderInt("Update Interval (ms)", updateInterval, 50, 1000);
    updateInterval = ImGui.GetSliderIntValue();
    
    ImGui.SliderInt("Max Display", maxDisplayCount, 10, 200);
    maxDisplayCount = ImGui.GetSliderIntValue();
    
    ImGui.Separator();
    
    ImGui.Checkbox("Show Monsters", showMonsters);
    showMonsters = ImGui.GetCheckboxValue();
    
    ImGui.Checkbox("Show Characters", showCharacters);
    showCharacters = ImGui.GetCheckboxValue();
    
    ImGui.Checkbox("Show Miscellaneous", showMiscellaneous);
    showMiscellaneous = ImGui.GetCheckboxValue();
    
    ImGui.Separator();
    
    ImGui.Checkbox("Sort by Distance", sortByDistance);
    sortByDistance = ImGui.GetCheckboxValue();
  }
  
  ImGui.Separator();
  
  // Entity list header
  ImGui.Text(`Nearby Entities: ${entities.length}`);
  
  ImGui.BeginChild("EntityRadarList", [0, 400], true);
  
  // Table header
  ImGui.Columns(5, "RadarColumns");
  ImGui.Separator();
  ImGui.Text("Name"); ImGui.NextColumn();
  ImGui.Text("Category"); ImGui.NextColumn();
  ImGui.Text("Distance"); ImGui.NextColumn();
  ImGui.Text("Grid X"); ImGui.NextColumn();
  ImGui.Text("Grid Y"); ImGui.NextColumn();
  ImGui.Separator();
  
  // Entity rows
  for (const entity of entities) {
    // Color based on category
    let color = [1.0, 1.0, 1.0, 1.0]; // White default
    if (entity.category === 'Monsters') {
      color = [1.0, 0.7, 0.3, 1.0]; // Orange
    } else if (entity.category === 'Characters') {
      color = [0.5, 1.0, 0.5, 1.0]; // Green
    } else if (entity.category === 'Chests') {
      color = [1.0, 1.0, 0.5, 1.0]; // Yellow
    }
    
    ImGui.TextColored(color, entity.shortName);
    ImGui.NextColumn();
    
    ImGui.Text(entity.category);
    ImGui.NextColumn();
    
    // Distance with color gradient (close = red, far = blue)
    const distRatio = Math.min(entity.distance / maxDistance, 1.0);
    const distColor = [1.0 - distRatio, 0.5, distRatio, 1.0];
    ImGui.TextColored(distColor, entity.distance.toFixed(1));
    ImGui.NextColumn();
    
    ImGui.Text(entity.gridX.toString());
    ImGui.NextColumn();
    
    ImGui.Text(entity.gridY.toString());
    ImGui.NextColumn();
  }
  
  ImGui.Columns(1);
  ImGui.EndChild();
  
  ImGui.Separator();
  
  // Statistics
  if (ImGui.CollapsingHeader("Statistics")) {
    const monsterCount = entities.filter(e => e.category === 'Monsters').length;
    const charCount = entities.filter(e => e.category === 'Characters').length;
    const chestCount = entities.filter(e => e.category === 'Chests').length;
    
    ImGui.Text(`Monsters nearby: ${monsterCount}`);
    ImGui.Text(`Characters nearby: ${charCount}`);
    ImGui.Text(`Chests nearby: ${chestCount}`);
    
    if (entities.length > 0) {
      const closestEntity = entities[0];
      ImGui.Separator();
      ImGui.TextColored([1.0, 1.0, 0.0, 1.0], "Closest Entity:");
      ImGui.Text(`  ${closestEntity.shortName} (${closestEntity.category})`);
      ImGui.Text(`  Distance: ${closestEntity.distance.toFixed(1)} units`);
      ImGui.Text(`  Position: (${closestEntity.gridX}, ${closestEntity.gridY})`);
    }
  }
  
  ImGui.End();
}

// Export the plugin object for registration
export const entityRadarPlugin = {
  onDraw: onDraw
};

console.log("Entity Radar plugin module loaded");


/**
 * Entity Radar - Position Tracking Plugin
 * 
 * Tracks player position and calculates distances to nearby entities.
 * Uses the grid coordinates at Entity+0x3FC (grid_x) and Entity+0x400 (grid_y)
 * discovered through reverse engineering.
 */

// Create POE2 instance
const poe2 = new POE2();

// State
let entities = [];
let playerEntity = null;
let lastUpdate = 0;
let updateInterval = 16; // ms (~60 FPS updates)

// Settings
let maxDistance = 100;
let sortByDistance = true;
let maxDisplayCount = 50;
let showOnlyZeroCoords = false;  // Filter to show only entities at (0, 0)

// Dynamic category filters - populated from entity data
let categoryFilters = {};  // { "Monsters": true, "Characters": false, ... }
let availableCategories = [];  // ["Monsters", "Characters", ...]

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
    const allEntities = poe2.getEntities();
    
    if (!allEntities || allEntities.length === 0) {
      entities = [];
      playerEntity = null;
      return;
    }
    
    // Find player (Characters category with Dex/Str/Int in name)
    playerEntity = allEntities.find(e => 
      e.name && e.name.includes('Characters/') && 
      (e.name.includes('Dex') || e.name.includes('Str') || e.name.includes('Int'))
    );
    
    if (!playerEntity) {
      entities = [];
      return;
    }
    
    // Build list of available categories
    const categoriesFound = new Set();
    
    // Calculate distances and filter
    entities = allEntities
      .filter(e => e !== playerEntity) // Exclude player
      .map(e => {
        const dist = calculateDistance(
          playerEntity.gridX, playerEntity.gridY,
          e.gridX, e.gridY
        );
        
        const category = getCategory(e.name);
        categoriesFound.add(category);
        
        // Initialize category filter if not exists (default to true)
        if (!(category in categoryFilters)) {
          categoryFilters[category] = true;
        }
        
        return {
          ...e,
          distance: dist,
          category: category,
          shortName: getShortName(e.name)
        };
      })
      .filter(e => {
        // Special filter: show only entities at (0, 0)
        if (showOnlyZeroCoords) {
          return e.gridX === 0 && e.gridY === 0;
        }
        
        // Apply distance filter
        if (e.distance > maxDistance) return false;
        
        // Apply dynamic category filter
        if (categoryFilters[e.category] === false) return false;
        
        return true;
      });
    
    // Sort by distance
    if (sortByDistance) {
      entities.sort((a, b) => a.distance - b.distance);
    }
    
    // Update available categories list (sorted alphabetically)
    availableCategories = Array.from(categoriesFound).sort();
    
    // Limit display count
    if (entities.length > maxDisplayCount) {
      entities = entities.slice(0, maxDisplayCount);
    }
    
  } catch (e) {
    console.error("Failed to get entities:", e);
  }
}

function onDraw() {
  // Debug: Log that onDraw is being called (only once per reload)
  if (!globalThis.entityRadarDrawCalled) {
    console.log("[EntityRadar] onDraw is being called");
    globalThis.entityRadarDrawCalled = true;
  }
  
  updateEntities();
  
  // Use NoSavedSettings flag so window reopens after hot-reload
  // ImGui won't remember if the window was closed
  const flags = ImGui.WindowFlags ? ImGui.WindowFlags.NoSavedSettings : 0;
  const isOpen = ImGui.begin("Entity Radar", null, flags);
  
  // Debug: Log window open state (only once per reload)
  if (!globalThis.entityRadarWindowStateLogged) {
    console.log(`[EntityRadar] ImGui.begin returned: ${isOpen}, flags: ${flags}`);
    globalThis.entityRadarWindowStateLogged = true;
  }
  
  if (!isOpen) {
    ImGui.end();
    return;
  }
  
  // Player info
  if (playerEntity) {
    ImGui.textColored([0.5, 1.0, 0.5, 1.0], "Player Position:");
    ImGui.text(`  Grid: (${playerEntity.gridX}, ${playerEntity.gridY})`);
    ImGui.text(`  Name: ${getShortName(playerEntity.name)}`);
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "  (Grid units - walk around to see values change)");
  } else {
    ImGui.textColored([1.0, 0.5, 0.5, 1.0], "Player not found");
    ImGui.text("(Make sure Entity Inspector is enabled and refreshed)");
  }
  
  ImGui.separator();
  
  // Settings
  if (ImGui.collapsingHeader("Settings")) {
    ImGui.text("Update Interval (ms):");
    ImGui.sameLine();
    ImGui.text(updateInterval.toString());
    if (ImGui.button("-##interval")) updateInterval = Math.max(1, updateInterval - 10);
    ImGui.sameLine();
    if (ImGui.button("+##interval")) updateInterval = Math.min(1000, updateInterval + 10);
    ImGui.sameLine();
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], `(${(1000/updateInterval).toFixed(0)} updates/sec)`);
    
    ImGui.text("Max Distance:");
    ImGui.sameLine();
    ImGui.text(maxDistance.toString());
    if (ImGui.button("-##dist")) maxDistance = Math.max(10, maxDistance - 10);
    ImGui.sameLine();
    if (ImGui.button("+##dist")) maxDistance = Math.min(500, maxDistance + 10);
    
    ImGui.text("Max Display Count:");
    ImGui.sameLine();
    ImGui.text(maxDisplayCount.toString());
    if (ImGui.button("-##count")) maxDisplayCount = Math.max(10, maxDisplayCount - 10);
    ImGui.sameLine();
    if (ImGui.button("+##count")) maxDisplayCount = Math.min(200, maxDisplayCount + 10);
    
    ImGui.separator();
    
    // Dynamic category filters
    ImGui.text(`Entity Categories (${availableCategories.length} found):`);
    if (availableCategories.length === 0) {
      ImGui.textColored([0.5, 0.5, 0.5, 1.0], "  (No entities found - refresh Entity Inspector)");
    } else {
      // Quick toggle buttons
      if (ImGui.button("Show All##categories")) {
        for (const cat of availableCategories) {
          categoryFilters[cat] = true;
        }
      }
      ImGui.sameLine();
      if (ImGui.button("Hide All##categories")) {
        for (const cat of availableCategories) {
          categoryFilters[cat] = false;
        }
      }
      
      ImGui.separator();
      
      // Debug: Show what categories we found
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], `Categories: ${availableCategories.join(", ")}`);
      
      ImGui.separator();
      
      // Individual category toggle buttons (using buttons since checkbox needs MutableVariable)
      for (let i = 0; i < availableCategories.length; i++) {
        const category = availableCategories[i];
        if (!category || category === "" || category === "Unknown") continue;  // Skip empty/unknown
        
        // Get current state (default to true)
        const isEnabled = (category in categoryFilters) ? categoryFilters[category] : true;
        
        // Color the button based on state
        if (isEnabled) {
          ImGui.pushStyleColor(0, [0.2, 0.6, 0.2, 1.0]);  // Green when enabled
        } else {
          ImGui.pushStyleColor(0, [0.4, 0.2, 0.2, 1.0]);  // Dark red when disabled
        }
        
        // Button to toggle (shows checkbox icon)
        const icon = isEnabled ? '[X]' : '[ ]';
        const buttonLabel = `${icon} ${category}##cat${i}`;
        if (ImGui.button(buttonLabel)) {
          categoryFilters[category] = !isEnabled;
        }
        
        ImGui.popStyleColor(1);
        
        // Show count for this category
        ImGui.sameLine();
        const categoryCount = entities.filter(e => e.category === category).length;
        ImGui.textColored([0.7, 0.7, 0.7, 1.0], `(${categoryCount})`);
      }
    }
    
    ImGui.separator();
    
    // Debug filter: Show only entities at (0, 0)
    if (showOnlyZeroCoords) {
      ImGui.pushStyleColor(0, [1.0, 0.5, 0.0, 1.0]);  // Orange when active
    } else {
      ImGui.pushStyleColor(0, [0.3, 0.3, 0.3, 1.0]);  // Gray when inactive
    }
    
    const zeroIcon = showOnlyZeroCoords ? '[X]' : '[ ]';
    if (ImGui.button(`${zeroIcon} Show Only (0,0) Coords (Debug)`)) {
      showOnlyZeroCoords = !showOnlyZeroCoords;
    }
    
    ImGui.popStyleColor(1);
    
    if (showOnlyZeroCoords) {
      ImGui.sameLine();
      ImGui.textColored([1.0, 1.0, 0.0, 1.0], "ACTIVE - showing only entities at grid (0, 0)");
    }
    
    ImGui.separator();
    
    // Sort by distance toggle button
    if (sortByDistance) {
      ImGui.pushStyleColor(0, [0.2, 0.6, 0.2, 1.0]);  // Green when enabled
    } else {
      ImGui.pushStyleColor(0, [0.4, 0.2, 0.2, 1.0]);  // Dark red when disabled
    }
    
    const sortIcon = sortByDistance ? '[X]' : '[ ]';
    if (ImGui.button(`${sortIcon} Sort by Distance`)) {
      sortByDistance = !sortByDistance;
    }
    
    ImGui.popStyleColor(1);
    
    ImGui.separator();
    const timeSinceUpdate = Date.now() - lastUpdate;
    ImGui.textColored([0.5, 0.5, 0.5, 1.0], `Last update: ${timeSinceUpdate}ms ago`);
  }
  
  ImGui.separator();
  
  // Entity list header
  ImGui.text(`Nearby Entities: ${entities.length}`);
  
  // Test W2S with player position
  if (playerEntity) {
    try {
      const screenPos = poe2.worldToScreen(playerEntity.gridX, playerEntity.gridY, 0);
      if (screenPos && screenPos.visible) {
        ImGui.textColored([1.0, 1.0, 0.0, 1.0], 
          `W2S Test: Player at screen (${screenPos.x.toFixed(0)}, ${screenPos.y.toFixed(0)})`);
      } else {
        ImGui.textColored([0.5, 0.5, 0.5, 1.0], "W2S Test: Player not visible or W2S failed");
      }
    } catch (e) {
      ImGui.textColored([1.0, 0.5, 0.5, 1.0], "W2S not available");
    }
  }
  
  ImGui.separator();
  
  ImGui.beginChild("EntityRadarList", [0, 350], true);
  
  // Table header
  ImGui.columns(6, "RadarColumns");
  ImGui.separator();
  ImGui.text("Name"); ImGui.nextColumn();
  ImGui.text("Category"); ImGui.nextColumn();
  ImGui.text("Distance"); ImGui.nextColumn();
  ImGui.text("Grid X"); ImGui.nextColumn();
  ImGui.text("Grid Y"); ImGui.nextColumn();
  ImGui.text("Screen XY"); ImGui.nextColumn();
  ImGui.separator();
  
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
    
    ImGui.textColored(color, entity.shortName);
    ImGui.nextColumn();
    
    ImGui.text(entity.category);
    ImGui.nextColumn();
    
    // Distance with color gradient (close = red, far = blue)
    const distRatio = Math.min(entity.distance / maxDistance, 1.0);
    const distColor = [1.0 - distRatio, 0.5, distRatio, 1.0];
    ImGui.textColored(distColor, entity.distance.toFixed(1));
    ImGui.nextColumn();
    
    ImGui.text(entity.gridX.toString());
    ImGui.nextColumn();
    
    ImGui.text(entity.gridY.toString());
    ImGui.nextColumn();
    
    // Try W2S projection
    try {
      const screenPos = poe2.worldToScreen(entity.gridX, entity.gridY, 0);
      if (screenPos && screenPos.visible) {
        ImGui.textColored([0.5, 1.0, 0.5, 1.0], `${screenPos.x.toFixed(0)}, ${screenPos.y.toFixed(0)}`);
      } else {
        ImGui.textColored([0.5, 0.5, 0.5, 1.0], "N/A");
      }
    } catch (e) {
      ImGui.text("-");
    }
    ImGui.nextColumn();
  }
  
  ImGui.columns(1);
  ImGui.endChild();
  
  ImGui.separator();
  
  // Statistics
  if (ImGui.collapsingHeader("Statistics")) {
    // Count entities by category
    const categoryCounts = {};
    for (const entity of entities) {
      categoryCounts[entity.category] = (categoryCounts[entity.category] || 0) + 1;
    }
    
    // Display counts for each category
    for (const category of availableCategories) {
      const count = categoryCounts[category] || 0;
      if (count > 0) {
        // Color based on category
        let color = [1.0, 1.0, 1.0, 1.0];
        if (category === 'Monsters') color = [1.0, 0.7, 0.3, 1.0];
        else if (category === 'Characters') color = [0.5, 1.0, 0.5, 1.0];
        else if (category === 'Chests') color = [1.0, 1.0, 0.5, 1.0];
        
        ImGui.textColored(color, `${category}: ${count}`);
      }
    }
    
    if (entities.length > 0) {
      const closestEntity = entities[0];
      ImGui.separator();
      ImGui.textColored([1.0, 1.0, 0.0, 1.0], "Closest Entity:");
      ImGui.text(`  ${closestEntity.shortName} (${closestEntity.category})`);
      ImGui.text(`  Distance: ${closestEntity.distance.toFixed(1)} grid units`);
      ImGui.text(`  Position: (${closestEntity.gridX}, ${closestEntity.gridY})`);
      
      // Show coordinate delta from player
      const deltaX = closestEntity.gridX - playerEntity.gridX;
      const deltaY = closestEntity.gridY - playerEntity.gridY;
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], `  Delta: (${deltaX > 0 ? '+' : ''}${deltaX}, ${deltaY > 0 ? '+' : ''}${deltaY})`);
    }
  }
  
  ImGui.end();
}

// Reset debug flags so we get fresh logs after reload
if (typeof globalThis.entityRadarDrawCalled !== 'undefined') {
  globalThis.entityRadarDrawCalled = false;
  globalThis.entityRadarWindowStateLogged = false;
}

// Export the plugin object
export const entityRadarPlugin = {
  onDraw: onDraw
};

console.log("Entity Radar plugin loaded");

/**
 * Atlas Plugin - Displays atlas node information
 * 
 * Screen position = Rel * Zoom
 * Square size = 37.03703703704 * Zoom
 */

const poe2 = new POE2();

// Plugin state
let lastAtlasData = null;
let lastPopupRect = null;
let selectedNodeIndex = -1;

// Settings
const showOnlyVisible = new ImGui.MutableVariable(false);
const showTraits = new ImGui.MutableVariable(true);
const highlightSelected = new ImGui.MutableVariable(true);
const highlightAll = new ImGui.MutableVariable(true);
const sortByDistance = new ImGui.MutableVariable(false);

// Filter
let filterText = "";

// Special trait colors (ABGR format for ImGui)
const COLOR_DEFAULT = 0xFF00FF00;       // Green
const COLOR_SELECTED = 0xFF00FFFF;      // Yellow/Cyan
const COLOR_UNIQUE = 0xFFFF00FF;        // Magenta (unique maps)
const COLOR_BOSS = 0xFF0000FF;          // Red (deadly boss)
const COLOR_ABYSS = 0xFFFF8800;         // Orange (abyss overrun)
const COLOR_MOMENT = 0xFFFFFF00;        // Cyan (moment of zen)
const COLOR_NEXUS = 0xFF8800FF;         // Purple (corrupted nexus)
const COLOR_CLEANSE = 0xFF88FF88;       // Light green (cleansed)
const COLOR_ARROW = 0xFF00FFFF;         // Yellow for off-screen arrow

// Base square size (will be multiplied by zoom)
const BASE_SQUARE_SIZE = 37.03703703704;

function getSpecialTraitFlags(node) {
  const flags = {
    unique: false,
    boss: false,
    abyss: false,
    moment: false,
    nexus: false,
    cleanse: false
  };
  
  if (!node.traits) return flags;
  
  for (const trait of node.traits) {
    const name = (trait.name || "").toLowerCase();
    if (name.includes("unique")) flags.unique = true;
    if (name.includes("boss")) flags.boss = true;
    if (name.includes("abyss")) flags.abyss = true;
    if (name.includes("moment")) flags.moment = true;
    if (name.includes("nexus")) flags.nexus = true;
    if (name.includes("cleanse")) flags.cleanse = true;
  }
  
  // Also check fullName for special indicators
  const fullName = (node.fullName || "").toLowerCase();
  if (fullName.includes("unique")) flags.unique = true;
  
  return flags;
}

function hasAnySpecialTrait(flags) {
  return flags.unique || flags.boss || flags.abyss || flags.moment || flags.nexus || flags.cleanse;
}

function getSpecialTraitString(flags) {
  const parts = [];
  if (flags.unique) parts.push("unique");
  if (flags.boss) parts.push("boss");
  if (flags.abyss) parts.push("abyss");
  if (flags.moment) parts.push("moment");
  if (flags.nexus) parts.push("nexus");
  if (flags.cleanse) parts.push("cleanse");
  return parts.join(" ");
}

function nodeMatchesFilter(node, filter) {
  if (!filter || filter.length === 0) return true;
  
  const lowerFilter = filter.toLowerCase();
  const flags = getSpecialTraitFlags(node);
  
  // Check name
  const shortName = (node.shortName || "").toLowerCase();
  const fullName = (node.fullName || "").toLowerCase();
  if (shortName.includes(lowerFilter) || fullName.includes(lowerFilter)) return true;
  
  // Check traits
  if (node.traits) {
    for (const trait of node.traits) {
      const traitName = (trait.name || "").toLowerCase();
      if (traitName.includes(lowerFilter)) return true;
    }
  }
  
  // Check special trait keywords
  const specialStr = getSpecialTraitString(flags);
  if (specialStr.includes(lowerFilter)) return true;
  
  return false;
}

function rectsOverlap(rect1, rect2) {
  return !(rect1.x + rect1.width < rect2.x ||
           rect2.x + rect2.width < rect1.x ||
           rect1.y + rect1.height < rect2.y ||
           rect2.y + rect2.height < rect1.y);
}

function onDraw() {
  // ALWAYS refresh atlas data regardless of UI visibility
  const atlas = poe2.getAtlasNodes();
  if (atlas && atlas.isValid) {
    lastAtlasData = atlas;
  }

  if (!atlas) return;
  
  // Get popup rect to avoid drawing over it
  lastPopupRect = poe2.getAtlasPopupRect();
  
  // Get viewport size for off-screen detection
  const viewport = ImGui.getMainViewport();
  const screenWidth = viewport ? viewport.size.x : 1920;
  const screenHeight = viewport ? viewport.size.y : 1080;
  
  // ALWAYS draw overlays (even when UI is hidden with F12)
  drawOverlays(screenWidth, screenHeight);
  
  // Only draw UI window if UI is visible
  if (!Plugins.isUiVisible()) return;
  
  ImGui.setNextWindowSize({ x: 480, y: 500 }, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({ x: 10, y: 250 }, ImGui.Cond.FirstUseEver);
  
  if (ImGui.begin("Atlas Explorer")) {
    if (ImGui.button("Refresh")) {
      lastAtlasData = poe2.getAtlasNodes();
    }
    ImGui.sameLine();
    
    ImGui.checkbox("Visible Only", showOnlyVisible);
    ImGui.sameLine();
    ImGui.checkbox("Traits", showTraits);
    
    ImGui.checkbox("Highlight Selected", highlightSelected);
    ImGui.sameLine();
    ImGui.checkbox("Highlight All", highlightAll);
    ImGui.sameLine();
    ImGui.checkbox("Sort by Distance", sortByDistance);
    
    // Filter input
    ImGui.text("Filter:");
    ImGui.sameLine();
    ImGui.setNextItemWidth(200);
    const filterVar = new ImGui.MutableVariable(filterText);
    if (ImGui.inputText("##filter", filterVar)) {
      filterText = filterVar.value;
    }
    ImGui.sameLine();
    if (ImGui.button("Clear")) {
      filterText = "";
    }
    
    ImGui.separator();
    
    if (!lastAtlasData || !lastAtlasData.isValid) {
      ImGui.textColored([1.0, 0.5, 0.0, 1.0], "Atlas panel not visible");
      ImGui.text("Open the atlas in-game to see node data.");
      ImGui.end();
      return;
    }
    
    const visibleCount = lastAtlasData.nodes.filter(n => n.isVisible).length;
    const filteredCount = lastAtlasData.nodes.filter(n => nodeMatchesFilter(n, filterText)).length;
    ImGui.text(`Nodes: ${lastAtlasData.nodeCount} total, ${visibleCount} visible, ${filteredCount} match`);
    
    // Legend
    ImGui.textColored([1.0, 0.0, 0.0, 1.0], "Boss");
    ImGui.sameLine();
    ImGui.textColored([1.0, 0.0, 1.0, 1.0], "Unique");
    ImGui.sameLine();
    ImGui.textColored([1.0, 0.0, 0.53, 1.0], "Nexus");
    ImGui.sameLine();
    ImGui.textColored([0.0, 0.53, 1.0, 1.0], "Abyss");
    ImGui.sameLine();
    ImGui.textColored([0.0, 1.0, 1.0, 1.0], "Moment");
    ImGui.sameLine();
    ImGui.textColored([0.53, 1.0, 0.53, 1.0], "Cleanse");
    
    ImGui.separator();
    
    const availWidth = ImGui.getContentRegionAvail().x;
    const leftPaneWidth = availWidth * 0.4;
    
    // Left pane - Node list
    ImGui.beginChild("NodeList", { x: leftPaneWidth, y: 0 }, ImGui.ChildFlags.Border);
    
    // Build filtered list with indices
    const screenCenterX = screenWidth / 2;
    const screenCenterY = screenHeight / 2;
    
    let filteredNodes = [];
    for (let i = 0; i < lastAtlasData.nodes.length; i++) {
      const node = lastAtlasData.nodes[i];
      
      if (showOnlyVisible.value && !node.isVisible) continue;
      if (!nodeMatchesFilter(node, filterText)) continue;
      
      // Calculate distance from screen center
      const dx = (node.screenX || 0) - screenCenterX;
      const dy = (node.screenY || 0) - screenCenterY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      filteredNodes.push({ index: i, node: node, distance: distance });
    }
    
    // Sort by distance if enabled
    if (sortByDistance.value) {
      filteredNodes.sort((a, b) => a.distance - b.distance);
    }
    
    // Render the list
    for (const item of filteredNodes) {
      const node = item.node;
      const i = item.index;
      const flags = getSpecialTraitFlags(node);
      
      // Color based on special traits
      let textColor = null;
      if (flags.boss) textColor = [1.0, 0.0, 0.0, 1.0];
      else if (flags.unique) textColor = [1.0, 0.0, 1.0, 1.0];
      else if (flags.nexus) textColor = [1.0, 0.0, 0.53, 1.0];
      else if (flags.abyss) textColor = [0.0, 0.53, 1.0, 1.0];
      else if (flags.moment) textColor = [0.0, 1.0, 1.0, 1.0];
      else if (flags.cleanse) textColor = [0.53, 1.0, 0.53, 1.0];
      else if (!node.isVisible) textColor = [0.5, 0.5, 0.5, 1.0];
      
      if (textColor) {
        ImGui.pushStyleColor(ImGui.Col.Text, textColor);
      }
      
      const displayName = node.shortName || node.fullName || "<unnamed>";
      const distLabel = sortByDistance.value ? ` (${item.distance.toFixed(0)})` : "";
      const label = `[${i}] ${displayName}${distLabel}`;
      
      if (ImGui.selectable(label, selectedNodeIndex === i)) {
        selectedNodeIndex = i;
      }
      
      if (textColor) {
        ImGui.popStyleColor();
      }
    }
    
    ImGui.endChild();
    ImGui.sameLine();
    
    // Right pane - Details
    ImGui.beginChild("NodeDetails", { x: 0, y: 0 }, ImGui.ChildFlags.Border);
    
    if (selectedNodeIndex >= 0 && selectedNodeIndex < lastAtlasData.nodes.length) {
      const node = lastAtlasData.nodes[selectedNodeIndex];
      const flags = getSpecialTraitFlags(node);
      
      ImGui.text(`Index: ${selectedNodeIndex}`);
      
      ImGui.separator();
      
      if (node.shortName) ImGui.text(`Name: ${node.shortName}`);
      if (node.fullName) ImGui.textWrapped(`Full: ${node.fullName}`);
      
      ImGui.separator();
      
      // Coords (formerly Rel*Zoom)
      ImGui.textColored([1.0, 1.0, 0.5, 1.0], 
        `Coords: ${node.screenX?.toFixed(1)}, ${node.screenY?.toFixed(1)}`);
      
      ImGui.text(`Visible: ${node.isVisible ? "Yes" : "No"}`);
      
      // Check if off-screen
      const pos = { x: node.screenX || 0, y: node.screenY || 0 };
      const isOffScreen = pos.x < 0 || pos.y < 0 || pos.x > screenWidth || pos.y > screenHeight;
      if (isOffScreen) {
        ImGui.textColored([1.0, 0.5, 0.0, 1.0], "Off-screen (arrow shown)");
      }
      
      // Show special flags
      if (hasAnySpecialTrait(flags)) {
        ImGui.separator();
        ImGui.text("Special:");
        if (flags.unique) ImGui.sameLine(), ImGui.textColored([1.0, 0.0, 1.0, 1.0], "[Unique]");
        if (flags.boss) ImGui.sameLine(), ImGui.textColored([1.0, 0.0, 0.0, 1.0], "[Boss]");
        if (flags.abyss) ImGui.sameLine(), ImGui.textColored([0.0, 0.53, 1.0, 1.0], "[Abyss]");
        if (flags.moment) ImGui.sameLine(), ImGui.textColored([0.0, 1.0, 1.0, 1.0], "[Moment]");
        if (flags.nexus) ImGui.sameLine(), ImGui.textColored([1.0, 0.0, 0.53, 1.0], "[Nexus]");
        if (flags.cleanse) ImGui.sameLine(), ImGui.textColored([0.53, 1.0, 0.53, 1.0], "[Cleanse]");
      }
      
      if (showTraits.value && node.traits && node.traits.length > 0) {
        ImGui.separator();
        ImGui.textColored([1.0, 0.8, 0.2, 1.0], `Traits (${node.traits.length}):`);
        
        for (const trait of node.traits) {
          ImGui.bulletText(`[${trait.index}] ${trait.name || "<unknown>"}`);
        }
      }
    } else {
      ImGui.textDisabled("Select a node");
    }
    
    ImGui.endChild();
  }
  ImGui.end();
}

function drawOverlays(screenWidth, screenHeight) {
  if (!lastAtlasData) return;
  
  const dl = ImGui.getBackgroundDrawList();
  if (!dl) return;
  
  const screenCenter = { x: screenWidth / 2, y: screenHeight / 2 };
  
  // Draw all nodes
  for (let i = 0; i < lastAtlasData.nodes.length; i++) {
    const node = lastAtlasData.nodes[i];
    
    const pos = { x: node.screenX || 0, y: node.screenY || 0 };
    const zoom = node.zoomX || 1;
    const squareSize = BASE_SQUARE_SIZE * zoom;
    
    const isSelected = (i === selectedNodeIndex);
    const flags = getSpecialTraitFlags(node);
    const hasSpecial = hasAnySpecialTrait(flags);
    
    // Check if on-screen
    const margin = 50;
    const isOnScreen = pos.x > -margin && pos.y > -margin && 
                       pos.x < screenWidth + margin && pos.y < screenHeight + margin;
    
    // Determine if we should draw this node
    const shouldDraw = (highlightAll.value) || 
                       (highlightSelected.value && isSelected) ||
                       hasSpecial;
    
    if (!shouldDraw) continue;
    
    // If selected and off-screen, draw arrow
    if (isSelected && !isOnScreen) {
      drawArrowToTarget(dl, screenCenter, pos, screenWidth, screenHeight, COLOR_ARROW);
      continue;
    }
    
    if (!isOnScreen) continue;
    
    // Check if this square would overlap with the popup
    if (lastPopupRect) {
      const squareRect = {
        x: pos.x,
        y: pos.y,
        width: squareSize,
        height: squareSize
      };
      if (rectsOverlap(squareRect, lastPopupRect)) {
        continue;
      }
    }
    
    // Determine color and thickness based on traits
    let color = COLOR_DEFAULT;
    let thickness = 1;
    
    if (flags.boss) { color = COLOR_BOSS; thickness = 2; }
    else if (flags.unique) { color = COLOR_UNIQUE; thickness = 2; }
    else if (flags.nexus) { color = COLOR_NEXUS; thickness = 2; }
    else if (flags.abyss) { color = COLOR_ABYSS; thickness = 2; }
    else if (flags.moment) { color = COLOR_MOMENT; thickness = 2; }
    else if (flags.cleanse) { color = COLOR_CLEANSE; thickness = 2; }
    
    // Dim non-visible nodes
    if (!node.isVisible && !hasSpecial) {
      color = 0x80808080;
      thickness = 1;
    }
    
    // Selected node gets extra highlight
    if (isSelected) {
      color = COLOR_SELECTED;
      thickness = 3;
    }
    
    // Draw square
    const topLeft = { x: pos.x, y: pos.y };
    const bottomRight = { x: pos.x + squareSize, y: pos.y + squareSize };
    
    dl.addRect(topLeft, bottomRight, color, 0, 0, thickness);
    
    // Draw extra ring for special nodes
    if (hasSpecial && !isSelected) {
      const offset = 3;
      const outerTopLeft = { x: pos.x - offset, y: pos.y - offset };
      const outerBottomRight = { x: pos.x + squareSize + offset, y: pos.y + squareSize + offset };
      dl.addRect(outerTopLeft, outerBottomRight, color, 0, 0, 1);
    }
    
    // Draw label for selected node
    if (isSelected) {
      const label = node.shortName || `Node ${i}`;
      dl.addText(label, { x: pos.x + squareSize + 5, y: pos.y }, 0xFF00FFFF);
      
      if (node.traits && node.traits.length > 0) {
        const traitText = node.traits.map(t => t.name || "?").join(", ");
        dl.addText(traitText, { x: pos.x + squareSize + 5, y: pos.y + 16 }, 0xFF88CCFF);
      }
    }
  }
}

function drawArrowToTarget(dl, screenCenter, targetPos, screenWidth, screenHeight, color) {
  const dx = targetPos.x - screenCenter.x;
  const dy = targetPos.y - screenCenter.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  if (dist < 1) return;
  
  const dirX = dx / dist;
  const dirY = dy / dist;
  
  const margin = 40;
  let t = 10000;
  
  if (Math.abs(dirX) > 0.001) {
    const tx1 = (margin - screenCenter.x) / dirX;
    const tx2 = ((screenWidth - margin) - screenCenter.x) / dirX;
    if (tx1 > 0) t = Math.min(t, tx1);
    if (tx2 > 0) t = Math.min(t, tx2);
  }
  if (Math.abs(dirY) > 0.001) {
    const ty1 = (margin - screenCenter.y) / dirY;
    const ty2 = ((screenHeight - margin) - screenCenter.y) / dirY;
    if (ty1 > 0) t = Math.min(t, ty1);
    if (ty2 > 0) t = Math.min(t, ty2);
  }
  
  const tipX = screenCenter.x + dirX * t;
  const tipY = screenCenter.y + dirY * t;
  
  const lineStart = { x: screenCenter.x + dirX * 50, y: screenCenter.y + dirY * 50 };
  const lineEnd = { x: tipX, y: tipY };
  
  dl.addLine(lineStart, lineEnd, color, 3);
  
  const arrowSize = 15;
  const perpX = -dirY;
  const perpY = dirX;
  
  const p1 = { x: tipX, y: tipY };
  const p2 = { x: tipX - dirX * arrowSize + perpX * arrowSize * 0.5, 
               y: tipY - dirY * arrowSize + perpY * arrowSize * 0.5 };
  const p3 = { x: tipX - dirX * arrowSize - perpX * arrowSize * 0.5, 
               y: tipY - dirY * arrowSize - perpY * arrowSize * 0.5 };
  
  dl.addTriangleFilled(p1, p2, p3, color);
  
  if (lastAtlasData && selectedNodeIndex >= 0 && selectedNodeIndex < lastAtlasData.nodes.length) {
    const node = lastAtlasData.nodes[selectedNodeIndex];
    const label = node.shortName || `Node ${selectedNodeIndex}`;
    const labelX = tipX - dirX * 25;
    const labelY = tipY - dirY * 25;
    dl.addText(label, { x: labelX, y: labelY }, color);
  }
}

export const atlasPlugin = {
  onDraw: onDraw
};

console.log("Atlas Explorer plugin loaded");

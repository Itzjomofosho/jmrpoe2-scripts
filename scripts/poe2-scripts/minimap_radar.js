/**
 * Minimap Radar Overlay
 * 
 * Draws entity markers overlaid on the game's minimap/large map.
 * Uses GameHelper2's coordinate conversion algorithm for accurate positioning.
 */

const poe2 = new POE2();

// Configuration
let radarEnabled = true;
let showMonsters = true;
let showItems = true;
let showChests = true;
let showNPCs = true;
let showPlayers = true;
let showDirection = true;

// Points of Interest toggles
let showWaypoints = true;
let showPortals = true;
let showShrines = true;
let showTransitions = true;
let showQuestMarkers = true;
let showStash = true;

// Performance settings
let simplifyBorder = true;         // Simplify border during generation (fewer segments)
let borderSimplifyFactor = 2;      // Skip every Nth pixel during border generation (1 = no skip)
let cullOffscreenSegments = true;  // Don't draw segments outside visible area

// Performance tracking
let frameCounter = 0;

// Center offset adjustments (tune these if entities are offset)
// Defaults tuned for 1920x1080 resolution
// Note: Large map center is now calculated as window center, so offsets should be smaller
let minimapOffsetX = 0;      // Now automatic - set to 0
let minimapOffsetY = 0;
let largemapOffsetX = 0;     // Now automatic - set to 0
let largemapOffsetY = 0;

// Icon scale multipliers (adjust size of entity markers)
let minimapIconScale = 2.5;   // Tuned for visibility
let largemapIconScale = 0.5;  // Tuned for large map

// Map border drawing
let showMapBorder = true;
let mapBorderColor = { r: 100, g: 100, b: 100, a: 200 };
let mapBorderOpacity = 0.1;  // 0.0 - 1.0
let mapBorderOffsetX = -1;   // Additional offset for map border
let mapBorderOffsetY = -1;
let mapBorderThickness = 5.0; // Line thickness
let cachedMapBorder = null;
let lastAreaHash = null;
let wasInGame = false;       // Track game state for cache invalidation

// Diagnostic mode
let showDiagnostics = false;
let lastMinimapInfo = null;
let lastLargeMapInfo = null;
let lastTerrainInfo = null;
let lastGameCullInfo = null;

// GameHelper2 constants
// Camera angle: 38.7 degrees in radians
const CAMERA_ANGLE = 38.7 * Math.PI / 180;
const REFERENCE_HEIGHT = 677; // Reference screen height from GameHelper2
const TERRAIN_DIVISOR = 10.86957; // For height-based calculations

// Pre-calculated cos/sin (will be updated based on scale)
let cachedCos = Math.cos(CAMERA_ANGLE);
let cachedSin = Math.sin(CAMERA_ANGLE);
let cachedMapScale = 0;

// Entity type colors (ABGR format for ImGui)
function makeColor(r, g, b, a = 1.0) {
  return ((Math.floor(a * 255) << 24) | (Math.floor(b * 255) << 16) | (Math.floor(g * 255) << 8) | Math.floor(r * 255)) >>> 0;
}

const COLORS = {
  player: makeColor(0.2, 1.0, 0.2, 1.0),       // Green
  otherPlayer: makeColor(0.2, 0.8, 1.0, 1.0),  // Cyan
  monster: makeColor(1.0, 0.3, 0.3, 1.0),      // Red
  monsterRare: makeColor(1.0, 1.0, 0.0, 1.0),  // Yellow
  monsterUnique: makeColor(1.0, 0.5, 0.0, 1.0), // Orange
  npc: makeColor(0.4, 0.8, 1.0, 1.0),          // Light blue
  item: makeColor(0.8, 0.4, 1.0, 1.0),         // Purple
  itemRare: makeColor(1.0, 1.0, 0.0, 1.0),     // Yellow
  itemUnique: makeColor(1.0, 0.5, 0.0, 1.0),   // Orange
  chest: makeColor(1.0, 0.8, 0.2, 1.0),        // Gold
  strongbox: makeColor(1.0, 0.5, 0.0, 1.0),    // Orange
  diagGood: [0.2, 1.0, 0.2, 1.0],
  diagBad: [1.0, 0.3, 0.3, 1.0],
  
  // POI colors
  waypoint: makeColor(0.5, 1.0, 1.0, 1.0),     // Bright cyan
  portal: makeColor(0.3, 0.5, 1.0, 1.0),       // Blue
  shrine: makeColor(0.6, 1.0, 0.6, 1.0),       // Light green
  transition: makeColor(1.0, 1.0, 0.5, 1.0),   // Light yellow
  quest: makeColor(1.0, 0.8, 0.2, 1.0),        // Gold
  stash: makeColor(0.9, 0.7, 0.3, 1.0),        // Brown/gold
};

// POI path patterns for identification
const POI_PATTERNS = {
  waypoint: ['/Waypoint', 'WaypointMarker', 'Objects/Waypoint'],
  portal: ['/Portal', 'TownPortal', 'Objects/Portal', 'Objects/MiscellaneousObjects/Portal'],
  shrine: ['/Shrine', 'Objects/Shrine', 'Shrines/'],
  transition: ['AreaTransition', 'TransitionDoor', 'Transition/', 'Door/'],
  quest: ['Quest', 'QuestMarker', 'QuestObject'],
  stash: ['/Stash', 'PlayerStash', 'GuildStash', 'Objects/Stash'],
};

/**
 * Check if entity is a Point of Interest based on its path
 */
function getPOIType(entity) {
  const name = entity.name || '';
  
  for (const [poiType, patterns] of Object.entries(POI_PATTERNS)) {
    for (const pattern of patterns) {
      if (name.includes(pattern)) {
        return poiType;
      }
    }
  }
  
  return null;
}

/**
 * Check if POI should be shown based on settings
 */
function shouldShowPOI(poiType) {
  switch (poiType) {
    case 'waypoint': return showWaypoints;
    case 'portal': return showPortals;
    case 'shrine': return showShrines;
    case 'transition': return showTransitions;
    case 'quest': return showQuestMarkers;
    case 'stash': return showStash;
    default: return false;
  }
}

/**
 * Get color for POI type
 */
function getPOIColor(poiType) {
  switch (poiType) {
    case 'waypoint': return COLORS.waypoint;
    case 'portal': return COLORS.portal;
    case 'shrine': return COLORS.shrine;
    case 'transition': return COLORS.transition;
    case 'quest': return COLORS.quest;
    case 'stash': return COLORS.stash;
    default: return makeColor(0.5, 0.5, 0.5, 0.8);
  }
}

/**
 * Get size for POI type
 */
function getPOISize(poiType, isLargeMap) {
  const baseSize = isLargeMap ? 1.0 : 0.8;
  
  switch (poiType) {
    case 'waypoint': return 5 * baseSize;
    case 'portal': return 4 * baseSize;
    case 'transition': return 4 * baseSize;
    case 'shrine': return 3.5 * baseSize;
    case 'quest': return 4 * baseSize;
    case 'stash': return 4 * baseSize;
    default: return 3 * baseSize;
  }
}

/**
 * Generate map border data (cached per area)
 * Cache is invalidated when leaving InGame state or area changes
 */
function generateMapBorder() {
  // Check if we need to regenerate
  const terrainInfo = poe2.getTerrainInfo();
  lastTerrainInfo = terrainInfo;
  
  // Check game state for cache invalidation
  const isInGame = terrainInfo.isValid;
  
  // Clear cache when transitioning out of InGame
  if (wasInGame && !isInGame) {
    console.log("[Radar] Left InGame - clearing map border cache");
    cachedMapBorder = null;
    lastAreaHash = null;
  }
  wasInGame = isInGame;
  
  if (!isInGame) {
    cachedMapBorder = null;
    return null;
  }
  
  // Generate unique area hash from terrain dimensions
  const areaHash = `${terrainInfo.width}x${terrainInfo.height}`;
  
  // Return cached data if area hasn't changed
  if (areaHash === lastAreaHash && cachedMapBorder) {
    return cachedMapBorder;
  }
  
  console.log(`[Radar] Generating map border for area ${areaHash}...`);
  
  const borderData = poe2.generateMapBorderTexture(
    mapBorderColor.r, 
    mapBorderColor.g, 
    mapBorderColor.b, 
    mapBorderColor.a
  );
  
  if (!borderData.isValid || !borderData.pixels) {
    console.log("[Radar] Failed to generate map border");
    cachedMapBorder = null;
    return null;
  }
  
  // Extract non-zero pixel positions
  const borderSet = new Set();
  const stride = 4; // RGBA
  for (let y = 0; y < borderData.height; y++) {
    for (let x = 0; x < borderData.width; x++) {
      const idx = (y * borderData.width + x) * stride;
      const a = borderData.pixels[idx + 3];
      if (a > 0) {
        borderSet.add(`${x},${y}`);
      }
    }
  }
  
  // Pre-compute line segments by connecting adjacent border pixels
  const lineSegments = [];
  for (const key of borderSet) {
    const [x, y] = key.split(',').map(Number);
    
    // Check right neighbor
    if (borderSet.has(`${x + 1},${y}`)) {
      lineSegments.push({ x1: x, y1: y, x2: x + 1, y2: y });
    }
    
    // Check down neighbor
    if (borderSet.has(`${x},${y + 1}`)) {
      lineSegments.push({ x1: x, y1: y, x2: x, y2: y + 1 });
    }
    
    // Check diagonal for smoother corners (only if no direct neighbor)
    if (borderSet.has(`${x + 1},${y + 1}`) && !borderSet.has(`${x + 1},${y}`) && !borderSet.has(`${x},${y + 1}`)) {
      lineSegments.push({ x1: x, y1: y, x2: x + 1, y2: y + 1 });
    }
    if (borderSet.has(`${x - 1},${y + 1}`) && !borderSet.has(`${x - 1},${y}`) && !borderSet.has(`${x},${y + 1}`)) {
      lineSegments.push({ x1: x, y1: y, x2: x - 1, y2: y + 1 });
    }
  }
  
  console.log(`[Radar] Generated ${borderSet.size} border pixels, ${lineSegments.length} line segments`);
  
  cachedMapBorder = {
    width: borderData.width,
    height: borderData.height,
    pixelCount: borderSet.size,
    lines: lineSegments
  };
  lastAreaHash = areaHash;
  
  return cachedMapBorder;
}

/**
 * Draw map border on the map using pre-computed line segments
 * Optimized with off-screen culling (no frame skipping to avoid flicker)
 */
function drawMapBorder(drawList, mapCenter, player, isLargeMap) {
  if (!showMapBorder) return;
  if (!cachedMapBorder || !cachedMapBorder.lines || cachedMapBorder.lines.length === 0) return;
  
  const playerGridX = player.gridX || 0;
  const playerGridY = player.gridY || 0;
  
  // Apply opacity setting
  const color = makeColor(
    mapBorderColor.r / 255, 
    mapBorderColor.g / 255, 
    mapBorderColor.b / 255, 
    mapBorderOpacity
  );
  
  // Use configured thickness, slightly smaller for minimap
  const lineThickness = isLargeMap ? mapBorderThickness : mapBorderThickness * 0.75;
  
  // Pre-calculate for performance
  const centerX = mapCenter.x + mapBorderOffsetX;
  const centerY = mapCenter.y + mapBorderOffsetY;
  const cos = cachedCos;
  const sin = cachedSin;
  
  // Screen bounds for culling (with margin)
  const screenWidth = 1920;  // TODO: Get actual screen size
  const screenHeight = 1080;
  const margin = 100;
  const minX = -margin;
  const maxX = screenWidth + margin;
  const minY = -margin;
  const maxY = screenHeight + margin;
  
  const lines = cachedMapBorder.lines;
  const totalLines = lines.length;
  let drawnCount = 0;
  
  // Draw line segments with off-screen culling
  for (let i = 0; i < totalLines; i++) {
    const line = lines[i];
    
    // Convert both endpoints (inline for performance)
    const dx1 = line.x1 - playerGridX;
    const dy1 = line.y1 - playerGridY;
    const screenX1 = centerX + (dx1 - dy1) * cos;
    const screenY1 = centerY + (-(dx1 + dy1)) * sin;
    
    // Quick culling check on first point
    if (cullOffscreenSegments) {
      if (screenX1 < minX || screenX1 > maxX || screenY1 < minY || screenY1 > maxY) {
        // Check second point too before skipping
        const dx2 = line.x2 - playerGridX;
        const dy2 = line.y2 - playerGridY;
        const screenX2 = centerX + (dx2 - dy2) * cos;
        const screenY2 = centerY + (-(dx2 + dy2)) * sin;
        
        if (screenX2 < minX || screenX2 > maxX || screenY2 < minY || screenY2 > maxY) {
          continue; // Both points off-screen, skip this segment
        }
        
        // Second point is on-screen, draw it
        drawList.addLine({ x: screenX1, y: screenY1 }, { x: screenX2, y: screenY2 }, color, lineThickness);
        drawnCount++;
        continue;
      }
    }
    
    const dx2 = line.x2 - playerGridX;
    const dy2 = line.y2 - playerGridY;
    const screenX2 = centerX + (dx2 - dy2) * cos;
    const screenY2 = centerY + (-(dx2 + dy2)) * sin;
    
    drawList.addLine({ x: screenX1, y: screenY1 }, { x: screenX2, y: screenY2 }, color, lineThickness);
    drawnCount++;
  }
}

/**
 * Update the cos/sin values based on map scale
 * GameHelper2: mapScale = Scale / 677 where Scale = screenHeight * zoom
 */
function updateMapScale(screenHeight, zoom) {
  const scale = screenHeight * zoom;
  if (scale !== cachedMapScale && scale > 0) {
    cachedMapScale = scale;
    const mapScale = scale / REFERENCE_HEIGHT;
    cachedCos = Math.cos(CAMERA_ANGLE) * mapScale;
    cachedSin = Math.sin(CAMERA_ANGLE) * mapScale;
  }
}

/**
 * Convert world position delta to map pixel delta
 * Matches GameHelper2's DeltaInWorldToMapDelta function
 * 
 * @param dx - Grid X delta (entity.gridX - player.gridX)
 * @param dy - Grid Y delta (entity.gridY - player.gridY)
 * @param dz - Terrain height delta (entity.terrainHeight - player.terrainHeight)
 */
function deltaInWorldToMapDelta(dx, dy, dz) {
  // Convert terrain height difference
  const adjustedDz = (dz || 0) / TERRAIN_DIVISOR;
  
  // GameHelper2 formula:
  // result.x = (delta.X - delta.Y) * cos
  // result.y = (deltaZ - (delta.X + delta.Y)) * sin
  return {
    x: (dx - dy) * cachedCos,
    y: (adjustedDz - (dx + dy)) * cachedSin
  };
}

// Determine entity category from derived entityType
function getEntityCategory(entity) {
  if (entity.entityType) {
    switch (entity.entityType) {
      case 'Player': return 'player';
      case 'Monster': return 'monster';
      case 'NPC': return 'npc';
      case 'Chest': return 'chest';
      case 'Item': return 'item';
      case 'Shrine': return 'shrine';
      case 'Renderable': return 'renderable';
    }
  }
  return 'other';
}

// Get color for entity
function getEntityColor(entity) {
  const category = getEntityCategory(entity);
  
  switch (category) {
    case 'player':
      return entity.entitySubtype === 'PlayerSelf' ? COLORS.player : COLORS.otherPlayer;
    case 'monster':
      switch (entity.entitySubtype) {
        case 'MonsterUnique': return COLORS.monsterUnique;
        case 'MonsterRare': return COLORS.monsterRare;
        case 'MonsterMagic': return COLORS.monsterRare;
        case 'MonsterFriendly': return COLORS.npc;
        default: return COLORS.monster;
      }
    case 'npc':
      return COLORS.npc;
    case 'item':
      if (entity.rarity === 3) return COLORS.itemUnique;
      if (entity.rarity === 2) return COLORS.itemRare;
      return COLORS.item;
    case 'chest':
      return entity.entitySubtype === 'Strongbox' ? COLORS.strongbox : COLORS.chest;
    default:
      return makeColor(0.5, 0.5, 0.5, 0.8);
  }
}

// Get marker size for entity
function getEntitySize(entity, isLargeMap) {
  const category = getEntityCategory(entity);
  // Smaller sizes - adjust these as needed
  const baseSize = isLargeMap ? 0.8 : 0.6;
  
  switch (category) {
    case 'player': return 4 * baseSize;
    case 'monster': return (entity.rarity >= 2 ? 3 : 2.5) * baseSize;
    case 'chest': return (entity.chestIsStrongbox ? 3.5 : 3) * baseSize;
    case 'item': return (entity.rarity >= 2 ? 2.5 : 2) * baseSize;
    case 'npc': return 2.5 * baseSize;
    default: return 2 * baseSize;
  }
}

// Should show this entity?
function shouldShowEntity(entity) {
  // Check if it's a POI first
  const poiType = getPOIType(entity);
  if (poiType) {
    return shouldShowPOI(poiType);
  }
  
  const category = getEntityCategory(entity);
  
  switch (category) {
    case 'player':
      if (entity.isLocalPlayer || entity.entitySubtype === 'PlayerSelf') return false;
      return showPlayers;
    case 'monster':
      if (entity.isAlive === false) return false;
      if (entity.entitySubtype === 'MonsterFriendly') return false;
      return showMonsters;
    case 'npc': return showNPCs;
    case 'item': return showItems;
    case 'chest': return showChests && !entity.chestIsOpened;
    case 'shrine': return showShrines;
    default: return false;
  }
}

/**
 * Draw a diamond/rhombus shape (for POIs like waypoints)
 */
function drawDiamond(drawList, center, size, color) {
  const points = [
    { x: center.x, y: center.y - size },     // Top
    { x: center.x + size, y: center.y },     // Right
    { x: center.x, y: center.y + size },     // Bottom
    { x: center.x - size, y: center.y },     // Left
  ];
  drawList.addQuadFilled(points[0], points[1], points[2], points[3], color);
}

/**
 * Draw a triangle shape (for portals/transitions)
 */
function drawTriangle(drawList, center, size, color, pointUp = true) {
  const height = size * 1.5;
  if (pointUp) {
    const p1 = { x: center.x, y: center.y - height * 0.6 };
    const p2 = { x: center.x - size, y: center.y + height * 0.4 };
    const p3 = { x: center.x + size, y: center.y + height * 0.4 };
    drawList.addTriangleFilled(p1, p2, p3, color);
  } else {
    const p1 = { x: center.x, y: center.y + height * 0.6 };
    const p2 = { x: center.x - size, y: center.y - height * 0.4 };
    const p3 = { x: center.x + size, y: center.y - height * 0.4 };
    drawList.addTriangleFilled(p1, p2, p3, color);
  }
}

/**
 * Draw a star shape (for quest markers)
 */
function drawStar(drawList, center, size, color) {
  // Draw as overlapping triangles for a star effect
  drawTriangle(drawList, center, size * 0.8, color, true);
  drawTriangle(drawList, center, size * 0.8, color, false);
}

/**
 * Draw a square shape (for stash/vendors)
 */
function drawSquare(drawList, center, size, color) {
  const half = size * 0.7;
  drawList.addRectFilled(
    { x: center.x - half, y: center.y - half },
    { x: center.x + half, y: center.y + half },
    color
  );
}

// Draw entities on minimap (optimized with inlined calculations)
function drawOnMap(drawList, mapCenter, player, entities, isLargeMap, iconMultiplier) {
  if (!player) return;
  
  const playerGridX = player.gridX || 0;
  const playerGridY = player.gridY || 0;
  const playerTerrainHeight = player.terrainHeight || 0;
  
  // Pre-calculate values for performance
  const centerX = mapCenter.x;
  const centerY = mapCenter.y;
  const cos = cachedCos;
  const sin = cachedSin;
  const terrainDiv = TERRAIN_DIVISOR;
  
  // Draw entities
  for (let i = 0, len = entities.length; i < len; i++) {
    const entity = entities[i];
    if (!shouldShowEntity(entity)) continue;
    if (entity.gridX === undefined || entity.gridY === undefined) continue;
    
    // Calculate grid delta (inline for performance)
    const dx = entity.gridX - playerGridX;
    const dy = entity.gridY - playerGridY;
    const dz = ((entity.terrainHeight || 0) - playerTerrainHeight) / terrainDiv;
    
    // Convert to map coordinates (inline)
    const screenX = centerX + (dx - dy) * cos;
    const screenY = centerY + (dz - (dx + dy)) * sin;
    const pos = { x: screenX, y: screenY };
    
    // Check if this is a POI
    const poiType = getPOIType(entity);
    
    if (poiType) {
      // Draw POI with special shape
      const color = getPOIColor(poiType);
      const size = getPOISize(poiType, isLargeMap) * iconMultiplier;
      
      switch (poiType) {
        case 'waypoint':
          drawDiamond(drawList, pos, size, color);
          drawDiamond(drawList, pos, size * 0.5, makeColor(1, 1, 1, 0.8));
          break;
        case 'portal':
        case 'transition':
          drawTriangle(drawList, pos, size, color, true);
          break;
        case 'shrine':
          drawList.addCircleFilled(pos, size, color, 8);
          drawList.addCircle(pos, size * 1.3, makeColor(1, 1, 1, 0.4), 8, 2.0);
          break;
        case 'quest':
          drawStar(drawList, pos, size, color);
          break;
        case 'stash':
          drawSquare(drawList, pos, size, color);
          break;
        default:
          drawList.addCircleFilled(pos, size, color, 8);
      }
    } else {
      // Regular entity - draw as circle
      const color = getEntityColor(entity);
      const size = getEntitySize(entity, isLargeMap) * iconMultiplier;
      drawList.addCircleFilled(pos, size, color, 8);
    }
  }
  
  // Draw player marker (center)
  drawList.addCircleFilled(mapCenter, 2.5 * iconMultiplier, COLORS.player, 12);
  
  // Draw player direction indicator
  if (showDirection && player.rotationZ !== undefined) {
    const angle = -player.rotationZ - CAMERA_ANGLE;
    const dirLen = 8 * iconMultiplier;
    const dirEnd = {
      x: centerX + Math.cos(angle) * dirLen,
      y: centerY + Math.sin(angle) * dirLen
    };
    drawList.addLine(mapCenter, dirEnd, COLORS.player, 2.0);
  }
}

// Draw the radar overlay
function drawRadar() {
  if (!radarEnabled) return;
  
  frameCounter++;
  
  // Get fresh data every frame (no caching - prevents delay)
  const player = poe2.getLocalPlayer();
  if (!player || player.gridX === undefined) return;
  
  const entities = poe2.getEntities();
  
  // Get map info from game (always needed for visibility/position)
  const minimap = poe2.getMinimap();
  const largemap = poe2.getLargeMap();
  const gameCull = poe2.getGameCull();
  
  // Store for diagnostics
  lastMinimapInfo = minimap;
  lastLargeMapInfo = largemap;
  lastGameCullInfo = gameCull;
  
  // Generate map border (cached)
  if (showMapBorder) {
    generateMapBorder();
  }
  
  // Draw on large map if visible
  if (largemap && largemap.isValid && largemap.isVisible) {
    // Calculate large map center (GameHelper2: Center + Shift + DefaultShift)
    // The game's shift values already account for UI panel adjustments
    // Add user offset for fine-tuning only
    const mapCenter = {
      x: largemap.centerX + largemap.shiftX + largemap.defaultShiftX + largemapOffsetX,
      y: largemap.centerY + largemap.shiftY + largemap.defaultShiftY + largemapOffsetY
    };
    
    // Update scale based on large map height and zoom
    updateMapScale(largemap.sizeHeight, largemap.zoom);
    
    // Get foreground draw list
    const drawList = ImGui.getForegroundDrawList();
    if (drawList) {
      // Draw map border first (underneath entities)
      drawMapBorder(drawList, mapCenter, player, true);
      // Draw entities with large map scale
      drawOnMap(drawList, mapCenter, player, entities, true, largemap.zoom * 5 * largemapIconScale);
    }
  }
  
  // Draw on minimap if visible
  if (minimap && minimap.isValid && minimap.isVisible) {
    // Calculate minimap center (GameHelper2: Position + Size/2 + DefaultShift + Shift)
    // The game's shift values already account for UI panel adjustments
    // Add user offset for fine-tuning only
    const mapCenter = {
      x: minimap.positionX + (minimap.sizeWidth / 2) + minimap.defaultShiftX + minimap.shiftX + minimapOffsetX,
      y: minimap.positionY + (minimap.sizeHeight / 2) + minimap.defaultShiftY + minimap.shiftY + minimapOffsetY
    };
    
    // For minimap, we still use the large map height for scale calculation
    // (GameHelper2 does this: Helper.Scale = largeMap.Size.Y * largeMap.Zoom)
    if (largemap && largemap.isValid) {
      updateMapScale(largemap.sizeHeight, largemap.zoom);
    } else {
      // Fallback if large map data not available
      updateMapScale(minimap.sizeHeight * 2, minimap.zoom);
    }
    
    // Draw directly on foreground draw list (no clipping window to avoid rendering issues)
    const drawList = ImGui.getForegroundDrawList();
    if (drawList) {
      // Draw map border first (underneath entities)
      drawMapBorder(drawList, mapCenter, player, false);
      // Draw entities with minimap scale
      drawOnMap(drawList, mapCenter, player, entities, false, minimap.zoom * minimapIconScale);
    }
  }
}

// Settings window
function drawSettings() {
  ImGui.setNextWindowSize({ x: 520, y: 550 }, ImGui.Cond.FirstUseEver);
  
  if (!ImGui.begin("Radar Settings", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Enable/disable toggle
  const enabledColor = radarEnabled ? [0.2, 0.8, 0.2, 1.0] : [0.4, 0.2, 0.2, 1.0];
  ImGui.pushStyleColor(ImGui.Col.Button, enabledColor);
  if (ImGui.button(radarEnabled ? "[X] Radar Enabled" : "[ ] Radar Disabled", { x: 250, y: 0 })) {
    radarEnabled = !radarEnabled;
  }
  ImGui.popStyleColor(1);
  
  ImGui.separator();
  ImGui.text("Entity Filters");
  
  // Filter toggles - entities
  const entityFilters = [
    { name: "Monsters", value: showMonsters, toggle: () => showMonsters = !showMonsters },
    { name: "Items", value: showItems, toggle: () => showItems = !showItems },
    { name: "Chests", value: showChests, toggle: () => showChests = !showChests },
    { name: "NPCs", value: showNPCs, toggle: () => showNPCs = !showNPCs },
    { name: "Players", value: showPlayers, toggle: () => showPlayers = !showPlayers },
  ];
  
  for (const filter of entityFilters) {
    const color = filter.value ? [0.2, 0.6, 0.2, 1.0] : [0.4, 0.2, 0.2, 1.0];
    ImGui.pushStyleColor(ImGui.Col.Button, color);
    if (ImGui.button(`${filter.value ? '[X]' : '[ ]'} ${filter.name}`, { x: 140, y: 0 })) {
      filter.toggle();
    }
    ImGui.popStyleColor(1);
    ImGui.sameLine();
  }
  ImGui.newLine();
  
  ImGui.separator();
  ImGui.text("Points of Interest");
  
  // POI filter toggles
  const poiFilters = [
    { name: "Waypoints", value: showWaypoints, toggle: () => showWaypoints = !showWaypoints, color: [0.5, 1.0, 1.0, 1.0] },
    { name: "Portals", value: showPortals, toggle: () => showPortals = !showPortals, color: [0.3, 0.5, 1.0, 1.0] },
    { name: "Shrines", value: showShrines, toggle: () => showShrines = !showShrines, color: [0.6, 1.0, 0.6, 1.0] },
    { name: "Transitions", value: showTransitions, toggle: () => showTransitions = !showTransitions, color: [1.0, 1.0, 0.5, 1.0] },
    { name: "Quest", value: showQuestMarkers, toggle: () => showQuestMarkers = !showQuestMarkers, color: [1.0, 0.8, 0.2, 1.0] },
    { name: "Stash", value: showStash, toggle: () => showStash = !showStash, color: [0.9, 0.7, 0.3, 1.0] },
  ];
  
  let poiCount = 0;
  for (const filter of poiFilters) {
    const btnColor = filter.value ? filter.color : [0.3, 0.3, 0.3, 1.0];
    ImGui.pushStyleColor(ImGui.Col.Button, btnColor);
    if (ImGui.button(`${filter.value ? '[X]' : '[ ]'} ${filter.name}`, { x: 120, y: 0 })) {
      filter.toggle();
    }
    ImGui.popStyleColor(1);
    poiCount++;
    if (poiCount < poiFilters.length && poiCount % 3 !== 0) {
      ImGui.sameLine();
    }
  }
  
  ImGui.separator();
  ImGui.text("Map Display");
  
  // Map display toggles
  const mapFilters = [
    { name: "Map Border", value: showMapBorder, toggle: () => { showMapBorder = !showMapBorder; if (showMapBorder) generateMapBorder(); } },
    { name: "Direction Arrow", value: showDirection, toggle: () => showDirection = !showDirection },
  ];
  
  for (const filter of mapFilters) {
    const color = filter.value ? [0.2, 0.6, 0.2, 1.0] : [0.4, 0.2, 0.2, 1.0];
    ImGui.pushStyleColor(ImGui.Col.Button, color);
    if (ImGui.button(`${filter.value ? '[X]' : '[ ]'} ${filter.name}`, { x: 160, y: 0 })) {
      filter.toggle();
    }
    ImGui.popStyleColor(1);
    ImGui.sameLine();
  }
  ImGui.newLine();
  
  ImGui.separator();
  
  // Diagnostics toggle
  const diagColor = showDiagnostics ? [0.2, 0.6, 0.2, 1.0] : [0.3, 0.3, 0.3, 1.0];
  ImGui.pushStyleColor(ImGui.Col.Button, diagColor);
  if (ImGui.button(`${showDiagnostics ? '[X]' : '[ ]'} Show Diagnostics`, { x: 180, y: 0 })) {
    showDiagnostics = !showDiagnostics;
  }
  ImGui.popStyleColor(1);
  
  if (showDiagnostics) {
    ImGui.separator();
    ImGui.text("Center Offset Adjustment:");
    
    // Minimap X offset
    ImGui.text("Minimap X:");
    ImGui.sameLine();
    if (ImGui.button("-50##mmx")) minimapOffsetX -= 50;
    ImGui.sameLine();
    if (ImGui.button("-10##mmx")) minimapOffsetX -= 10;
    ImGui.sameLine();
    if (ImGui.button("-1##mmx")) minimapOffsetX -= 1;
    ImGui.sameLine();
    ImGui.text(`[${minimapOffsetX}]`);
    ImGui.sameLine();
    if (ImGui.button("+1##mmx")) minimapOffsetX += 1;
    ImGui.sameLine();
    if (ImGui.button("+10##mmx")) minimapOffsetX += 10;
    ImGui.sameLine();
    if (ImGui.button("+50##mmx")) minimapOffsetX += 50;
    
    // Minimap Y offset
    ImGui.text("Minimap Y:");
    ImGui.sameLine();
    if (ImGui.button("-50##mmy")) minimapOffsetY -= 50;
    ImGui.sameLine();
    if (ImGui.button("-10##mmy")) minimapOffsetY -= 10;
    ImGui.sameLine();
    if (ImGui.button("-1##mmy")) minimapOffsetY -= 1;
    ImGui.sameLine();
    ImGui.text(`[${minimapOffsetY}]`);
    ImGui.sameLine();
    if (ImGui.button("+1##mmy")) minimapOffsetY += 1;
    ImGui.sameLine();
    if (ImGui.button("+10##mmy")) minimapOffsetY += 10;
    ImGui.sameLine();
    if (ImGui.button("+50##mmy")) minimapOffsetY += 50;
    
    ImGui.separator();
    
    // Large map X offset
    ImGui.text("LargeMap X:");
    ImGui.sameLine();
    if (ImGui.button("-50##lmx")) largemapOffsetX -= 50;
    ImGui.sameLine();
    if (ImGui.button("-10##lmx")) largemapOffsetX -= 10;
    ImGui.sameLine();
    if (ImGui.button("-1##lmx")) largemapOffsetX -= 1;
    ImGui.sameLine();
    ImGui.text(`[${largemapOffsetX}]`);
    ImGui.sameLine();
    if (ImGui.button("+1##lmx")) largemapOffsetX += 1;
    ImGui.sameLine();
    if (ImGui.button("+10##lmx")) largemapOffsetX += 10;
    ImGui.sameLine();
    if (ImGui.button("+50##lmx")) largemapOffsetX += 50;
    
    // Large map Y offset
    ImGui.text("LargeMap Y:");
    ImGui.sameLine();
    if (ImGui.button("-50##lmy")) largemapOffsetY -= 50;
    ImGui.sameLine();
    if (ImGui.button("-10##lmy")) largemapOffsetY -= 10;
    ImGui.sameLine();
    if (ImGui.button("-1##lmy")) largemapOffsetY -= 1;
    ImGui.sameLine();
    ImGui.text(`[${largemapOffsetY}]`);
    ImGui.sameLine();
    if (ImGui.button("+1##lmy")) largemapOffsetY += 1;
    ImGui.sameLine();
    if (ImGui.button("+10##lmy")) largemapOffsetY += 10;
    ImGui.sameLine();
    if (ImGui.button("+50##lmy")) largemapOffsetY += 50;
    
    ImGui.separator();
    ImGui.text("Icon Scale:");
    
    // Minimap icon scale
    ImGui.text("Minimap Scale:");
    ImGui.sameLine();
    if (ImGui.button("-0.1##mms")) minimapIconScale = Math.max(0.1, minimapIconScale - 0.1);
    ImGui.sameLine();
    ImGui.text(`[${minimapIconScale.toFixed(1)}]`);
    ImGui.sameLine();
    if (ImGui.button("+0.1##mms")) minimapIconScale += 0.1;
    
    // Large map icon scale
    ImGui.text("LargeMap Scale:");
    ImGui.sameLine();
    if (ImGui.button("-0.1##lms")) largemapIconScale = Math.max(0.1, largemapIconScale - 0.1);
    ImGui.sameLine();
    ImGui.text(`[${largemapIconScale.toFixed(1)}]`);
    ImGui.sameLine();
    if (ImGui.button("+0.1##lms")) largemapIconScale += 0.1;
    
    ImGui.separator();
    
    // Reset button
    if (ImGui.button("Reset All##reset")) {
      minimapOffsetX = 0;
      minimapOffsetY = 0;
      largemapOffsetX = 0;
      largemapOffsetY = 0;
      minimapIconScale = 2.5;
      largemapIconScale = 0.5;
    }
    
    ImGui.separator();
    ImGui.text("Map Border Settings:");
    
    // Opacity control
    ImGui.text("Opacity:");
    ImGui.sameLine();
    if (ImGui.button("-0.1##opa")) mapBorderOpacity = Math.max(0.05, mapBorderOpacity - 0.1);
    ImGui.sameLine();
    if (ImGui.button("-.01##opa")) mapBorderOpacity = Math.max(0.01, mapBorderOpacity - 0.01);
    ImGui.sameLine();
    ImGui.text(`[${mapBorderOpacity.toFixed(2)}]`);
    ImGui.sameLine();
    if (ImGui.button("+.01##opa")) mapBorderOpacity = Math.min(1.0, mapBorderOpacity + 0.01);
    ImGui.sameLine();
    if (ImGui.button("+0.1##opa")) mapBorderOpacity = Math.min(1.0, mapBorderOpacity + 0.1);
    
    // Thickness control
    ImGui.text("Thickness:");
    ImGui.sameLine();
    if (ImGui.button("-0.5##thk")) mapBorderThickness = Math.max(0.5, mapBorderThickness - 0.5);
    ImGui.sameLine();
    ImGui.text(`[${mapBorderThickness.toFixed(1)}]`);
    ImGui.sameLine();
    if (ImGui.button("+0.5##thk")) mapBorderThickness = Math.min(10.0, mapBorderThickness + 0.5);
    
    // Border X offset
    ImGui.text("Border X:");
    ImGui.sameLine();
    if (ImGui.button("-10##bx")) mapBorderOffsetX -= 10;
    ImGui.sameLine();
    if (ImGui.button("-1##bx")) mapBorderOffsetX -= 1;
    ImGui.sameLine();
    ImGui.text(`[${mapBorderOffsetX}]`);
    ImGui.sameLine();
    if (ImGui.button("+1##bx")) mapBorderOffsetX += 1;
    ImGui.sameLine();
    if (ImGui.button("+10##bx")) mapBorderOffsetX += 10;
    
    // Border Y offset
    ImGui.text("Border Y:");
    ImGui.sameLine();
    if (ImGui.button("-10##by")) mapBorderOffsetY -= 10;
    ImGui.sameLine();
    if (ImGui.button("-1##by")) mapBorderOffsetY -= 1;
    ImGui.sameLine();
    ImGui.text(`[${mapBorderOffsetY}]`);
    ImGui.sameLine();
    if (ImGui.button("+1##by")) mapBorderOffsetY += 1;
    ImGui.sameLine();
    if (ImGui.button("+10##by")) mapBorderOffsetY += 10;
    
    // Color controls (R, G, B)
    ImGui.text("Color R:");
    ImGui.sameLine();
    if (ImGui.button("-10##cr")) mapBorderColor.r = Math.max(0, mapBorderColor.r - 10);
    ImGui.sameLine();
    ImGui.text(`[${mapBorderColor.r}]`);
    ImGui.sameLine();
    if (ImGui.button("+10##cr")) mapBorderColor.r = Math.min(255, mapBorderColor.r + 10);
    
    ImGui.text("Color G:");
    ImGui.sameLine();
    if (ImGui.button("-10##cg")) mapBorderColor.g = Math.max(0, mapBorderColor.g - 10);
    ImGui.sameLine();
    ImGui.text(`[${mapBorderColor.g}]`);
    ImGui.sameLine();
    if (ImGui.button("+10##cg")) mapBorderColor.g = Math.min(255, mapBorderColor.g + 10);
    
    ImGui.text("Color B:");
    ImGui.sameLine();
    if (ImGui.button("-10##cb")) mapBorderColor.b = Math.max(0, mapBorderColor.b - 10);
    ImGui.sameLine();
    ImGui.text(`[${mapBorderColor.b}]`);
    ImGui.sameLine();
    if (ImGui.button("+10##cb")) mapBorderColor.b = Math.min(255, mapBorderColor.b + 10);
    
    ImGui.separator();
    
    if (ImGui.button("Regenerate Border##regen")) {
      lastAreaHash = null;
      cachedMapBorder = null;
      generateMapBorder();
    }
    ImGui.sameLine();
    if (ImGui.button("Reset Border Settings##resetborder")) {
      mapBorderOpacity = 0.1;
      mapBorderOffsetX = -1;
      mapBorderOffsetY = -1;
      mapBorderThickness = 5.0;
      mapBorderColor = { r: 100, g: 100, b: 100, a: 200 };
    }
    
    if (cachedMapBorder) {
      ImGui.text(`  Border pixels: ${cachedMapBorder.pixelCount}`);
      ImGui.text(`  Line segments: ${cachedMapBorder.lines.length}`);
      ImGui.text(`  Grid size: ${cachedMapBorder.width} x ${cachedMapBorder.height}`);
      ImGui.text(`  Off-screen culling: ${cullOffscreenSegments ? 'enabled' : 'disabled'}`);
    } else {
      ImGui.text("  No border data");
    }
    if (lastTerrainInfo) {
      ImGui.text(`  Terrain valid: ${lastTerrainInfo.isValid}`);
      ImGui.text(`  Tiles: ${lastTerrainInfo.totalTilesX} x ${lastTerrainInfo.totalTilesY}`);
    }
    
    ImGui.separator();
    ImGui.text("Debug Info:");
    ImGui.text(`  Scale: ${cachedMapScale.toFixed(2)}, Cos: ${cachedCos.toFixed(4)}, Sin: ${cachedSin.toFixed(4)}`);
    
    // Game cull info
    if (lastGameCullInfo) {
      ImGui.text(`  Game Cull: X=${lastGameCullInfo.cullX}, Y=${lastGameCullInfo.cullY} (valid: ${lastGameCullInfo.isValid})`);
    }
    
    if (lastMinimapInfo) {
      ImGui.separator();
      ImGui.text("Minimap:");
      const mm = lastMinimapInfo;
      ImGui.textColored(mm.isValid ? COLORS.diagGood : COLORS.diagBad, `  Valid: ${mm.isValid}`);
      ImGui.textColored(mm.isVisible ? COLORS.diagGood : COLORS.diagBad, `  Visible: ${mm.isVisible}`);
      ImGui.text(`  Pos: (${mm.positionX?.toFixed(0)}, ${mm.positionY?.toFixed(0)})`);
      ImGui.text(`  Size: ${mm.sizeWidth?.toFixed(0)} x ${mm.sizeHeight?.toFixed(0)}`);
      ImGui.text(`  Shift: (${mm.shiftX?.toFixed(1)}, ${mm.shiftY?.toFixed(1)})`);
      ImGui.text(`  Default: (${mm.defaultShiftX?.toFixed(1)}, ${mm.defaultShiftY?.toFixed(1)})`);
      ImGui.text(`  Zoom: ${mm.zoom?.toFixed(3)}`);
    }
    
    if (lastLargeMapInfo) {
      ImGui.separator();
      ImGui.text("Large Map:");
      const lm = lastLargeMapInfo;
      ImGui.textColored(lm.isValid ? COLORS.diagGood : COLORS.diagBad, `  Valid: ${lm.isValid}`);
      ImGui.textColored(lm.isVisible ? COLORS.diagGood : COLORS.diagBad, `  Visible: ${lm.isVisible}`);
      ImGui.text(`  Center: (${lm.centerX?.toFixed(0)}, ${lm.centerY?.toFixed(0)})`);
      ImGui.text(`  Raw Pos: (${lm.rawPosX?.toFixed(1)}, ${lm.rawPosY?.toFixed(1)})`);
      ImGui.text(`  Size: ${lm.sizeWidth?.toFixed(0)} x ${lm.sizeHeight?.toFixed(0)}`);
      ImGui.text(`  Shift: (${lm.shiftX?.toFixed(1)}, ${lm.shiftY?.toFixed(1)})`);
      ImGui.text(`  Zoom: ${lm.zoom?.toFixed(3)}`);
      ImGui.textColored(lm.leftPanelOpen ? [1.0, 1.0, 0.2, 1.0] : [0.5, 0.5, 0.5, 1.0], 
        `  Left Panel: ${lm.leftPanelOpen ? 'OPEN' : 'closed'}`);
      ImGui.textColored(lm.rightPanelOpen ? [1.0, 1.0, 0.2, 1.0] : [0.5, 0.5, 0.5, 1.0], 
        `  Right Panel: ${lm.rightPanelOpen ? 'OPEN' : 'closed'}`);
    }
  }
  
  ImGui.separator();
  
  // Legend
  if (ImGui.collapsingHeader("Legend")) {
    ImGui.text("Entities:");
    ImGui.textColored([0.2, 1.0, 0.2, 1.0], "  O Player (You)");
    ImGui.textColored([0.2, 0.8, 1.0, 1.0], "  O Other Players");
    ImGui.textColored([1.0, 0.3, 0.3, 1.0], "  O Monsters");
    ImGui.textColored([1.0, 1.0, 0.0, 1.0], "  O Rare/Magic Monsters");
    ImGui.textColored([1.0, 0.5, 0.0, 1.0], "  O Unique Monsters");
    ImGui.textColored([0.4, 0.8, 1.0, 1.0], "  O NPCs");
    ImGui.textColored([0.8, 0.4, 1.0, 1.0], "  O Items");
    ImGui.textColored([1.0, 0.8, 0.2, 1.0], "  O Chests");
    ImGui.textColored([1.0, 0.5, 0.0, 1.0], "  O Strongboxes");
    
    ImGui.separator();
    ImGui.text("Points of Interest:");
    ImGui.textColored([0.5, 1.0, 1.0, 1.0], "  <> Waypoints (diamond)");
    ImGui.textColored([0.3, 0.5, 1.0, 1.0], "  /\\ Portals (triangle up)");
    ImGui.textColored([1.0, 1.0, 0.5, 1.0], "  /\\ Transitions (triangle)");
    ImGui.textColored([0.6, 1.0, 0.6, 1.0], "  O  Shrines (glowing circle)");
    ImGui.textColored([1.0, 0.8, 0.2, 1.0], "  *  Quest Markers (star)");
    ImGui.textColored([0.9, 0.7, 0.3, 1.0], "  [] Stash (square)");
  }
  
  ImGui.end();
}

// Main draw function
function onDraw() {
  drawRadar();
  drawSettings();
}

// Export plugin
export const minimapRadarPlugin = {
  onDraw: onDraw
};

console.log("Minimap Radar loaded (GameHelper2-style coordinate conversion)");

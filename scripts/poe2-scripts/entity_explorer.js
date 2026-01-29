/**
 * Entity Explorer - Advanced Entity Browser
 *
 * Browse all entities in the area with advanced filtering, sorting, and detailed component inspection.
 */

const poe2 = new POE2();

// Stat names lookup (loaded from game_stats.json)
let statNames = {};
let statNamesLoaded = false;

// Load stat names from JSON file
function loadStatNames() {
  if (statNamesLoaded) return;
  
  try {
    const jsonPath = './game_stats.json';
    const content = fs.readFile(jsonPath);
    if (content) {
      statNames = JSON.parse(content);
      statNamesLoaded = true;
      console.log(`[EntityExplorer] Loaded ${Object.keys(statNames).length} stat names`);
    }
  } catch (e) {
    console.log(`[EntityExplorer] Could not load stat names: ${e}`);
    statNamesLoaded = true; // Don't try again
  }
}

// Get stat name by index (or return index if not found)
function getStatName(statIndex) {
  if (statNames[statIndex]) {
    return statNames[statIndex];
  }
  return `stat_${statIndex}`;
}

// State
let entities = [];
let selectedEntity = null;
let sortColumn = 'distance';  // 'name', 'distance', 'type', 'health', 'rarity'
let sortAscending = true;
let filterText = '';
let showOnlyAlive = false;
let showOnlyTargetable = false;
let showOnlyItems = false;
let showOnlyInLoS = false;  // Filter to show only entities in line of sight

// Category filters
const categoryFilters = {
  'Monsters': true,
  'Characters': true,
  'Chests': true,
  'Items': true,
  'NPCs': true,
  'Objects': true,
  'Other': true
};

// Extract category from metadata path or entity properties
function getCategory(path, entity) {
  if (path) {
    const match = path.match(/Metadata\/([^\/]+)/);
    if (match) {
      const category = match[1];
      if (category === 'Monsters') return 'Monsters';
      if (category === 'Characters') return 'Characters';
      if (category === 'Chests') return 'Chests';
      if (category === 'Items') return 'Items';
      if (category === 'NPC') return 'NPCs';
      return 'Objects';
    }
  }

  // Categorize by components if no path
  if (entity) {
    if (entity.playerName) return 'Characters';
    if (entity.chestIsOpened !== undefined) return 'Chests';
    if (entity.healthMax > 0) return 'Monsters';
    if (entity.rarity !== undefined) return 'Items';
  }

  return 'Other';
}

// Get short name with priority for WorldItems: Unique Name > Stack+BaseName > BaseName
function getShortName(path, entity) {
  // Priority 1: Character name from Player component
  if (entity && entity.playerName) {
    return entity.playerName;
  }

  // Priority 2: WorldItem unique name (for unique items like "Zerphis Genesis")
  if (entity && entity.worldItemUniqueName) {
    return entity.worldItemUniqueName;
  }

  // Priority 3: WorldItem with stack size (e.g., "6x Exalted Orb")
  if (entity && entity.worldItemBaseName) {
    if (entity.worldItemStackSize && entity.worldItemStackSize > 1) {
      return `${entity.worldItemStackSize}x ${entity.worldItemBaseName}`;
    }
    return entity.worldItemBaseName;
  }

  // Priority 4: Render name from Render component
  if (entity && entity.renderName) {
    return entity.renderName;
  }

  // Priority 5: Short name from metadata path
  if (path) {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  }

  // Fallback
  if (entity && entity.chestIsOpened !== undefined) {
    return entity.chestIsStrongbox ? 'Strongbox' : 'Chest';
  }
  return entity ? `Entity_${entity.address.toString(16).slice(-6)}` : '<unknown>';
}

// Get name source for display
function getNameSource(entity) {
  if (!entity) return 'Unknown';
  if (entity.playerName) return 'Player Component';
  if (entity.worldItemUniqueName) return 'WorldItem Unique';
  if (entity.worldItemBaseName) return 'WorldItem Base';
  if (entity.renderName) return 'Render Component';
  if (entity.name) return 'Metadata Path';
  return 'Generated';
}

// Calculate 2D distance
function distance2D(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

// Get color for category
function getCategoryColor(category) {
  const colors = {
    'Monsters': [1.0, 0.4, 0.4, 1.0],    // Red
    'Characters': [0.4, 1.0, 0.4, 1.0],  // Green
    'Chests': [1.0, 1.0, 0.4, 1.0],      // Yellow
    'Items': [0.6, 0.4, 1.0, 1.0],       // Purple
    'NPCs': [0.4, 0.8, 1.0, 1.0],        // Cyan
    'Objects': [0.8, 0.8, 0.8, 1.0],     // Light gray
    'Other': [0.5, 0.5, 0.5, 1.0]        // Gray
  };
  return colors[category] || colors['Other'];
}

// Get rarity name and color
function getRarityInfo(rarity) {
  const rarities = [
    { name: 'Normal', color: [0.8, 0.8, 0.8, 1.0] },
    { name: 'Magic', color: [0.4, 0.4, 1.0, 1.0] },
    { name: 'Rare', color: [1.0, 1.0, 0.0, 1.0] },
    { name: 'Unique', color: [1.0, 0.5, 0.0, 1.0] }
  ];
  return rarities[rarity] || rarities[0];
}

// Update and process entities
function updateEntities() {
  try {
    const player = poe2.getLocalPlayer();
    if (!player) {
      entities = [];
      return;
    }

    // Use lightweight mode to skip expensive WorldItem reads (entity types still detected via path)
    const allEntities = poe2.getEntities({ lightweight: true });

    // Debug logging (only first few times)
    if (!globalThis.entityExplorerDebugCount) {
      globalThis.entityExplorerDebugCount = 0;
    }
    if (globalThis.entityExplorerDebugCount < 3) {
      console.log(`[EntityExplorer] Got ${allEntities ? allEntities.length : 0} entities from C++`);
      if (allEntities && allEntities.length > 0) {
        const first = allEntities[0];
        console.log(`[EntityExplorer] First entity name: ${first.name}`);
        console.log(`[EntityExplorer] First entity pos: (${first.gridX}, ${first.gridY})`);
        console.log(`[EntityExplorer] First entity isValid: ${first.isValid}`);
        console.log(`[EntityExplorer] Player pos: (${player.gridX}, ${player.gridY})`);

        // Calculate distance to first entity
        const dist = distance2D(player.gridX, player.gridY, first.gridX, first.gridY);
        console.log(`[EntityExplorer] Distance to first entity: ${dist.toFixed(1)}`);
      }
      globalThis.entityExplorerDebugCount++;
    }

    if (!allEntities || allEntities.length === 0) {
      entities = [];
      return;
    }

    // Process and filter entities
    entities = allEntities
      .map(e => {
        // Check if entity has valid position
        const hasPos = (e.gridX !== undefined && e.gridX !== 0) || (e.gridY !== undefined && e.gridY !== 0);

        // Calculate distance (or set to max for entities without position)
        const dist = hasPos ? distance2D(player.gridX, player.gridY, e.gridX, e.gridY) : 999999;

        // Check line of sight (only for entities with position and within reasonable range)
        let inLineOfSight = false;
        if (hasPos && dist < 150) {  // Only check LoS for entities within network bubble
          try {
            inLineOfSight = poe2.isWithinLineOfSight(
              Math.floor(player.gridX),
              Math.floor(player.gridY),
              Math.floor(e.gridX),
              Math.floor(e.gridY),
              150  // Max distance for LoS check
            );
          } catch (err) {
            // LoS function may not be available yet
            inLineOfSight = false;  // Assume invisible if can't check
          }
        }

        const category = getCategory(e.name, e);
        const shortName = getShortName(e.name, e);

        return {
          ...e,
          category: category,
          shortName: shortName,
          distance: dist,
          hasPosition: hasPos,
          inLineOfSight: inLineOfSight
        };
      })
      .filter(e => {
        // Filter by category
        if (categoryFilters[e.category] === false) return false;

        // Filter by alive status
        if (showOnlyAlive && !e.isAlive) return false;

        // Filter by targetable
        if (showOnlyTargetable && !e.isTargetable) return false;

        // Filter by items (has rarity)
        if (showOnlyItems && typeof e.rarity === 'undefined') return false;

        // Filter by line of sight
        if (showOnlyInLoS && !e.inLineOfSight) return false;

        return true;
      })
      .sort((a, b) => {
        let result = 0;

        switch (sortColumn) {
          case 'name':
            result = a.shortName.localeCompare(b.shortName);
            break;
          case 'distance':
            result = a.distance - b.distance;
            break;
          case 'type':
            result = a.category.localeCompare(b.category);
            break;
          case 'health':
            const aHealth = a.healthMax || 0;
            const bHealth = b.healthMax || 0;
            result = aHealth - bHealth;
            break;
          case 'rarity':
            const aRarity = a.rarity || 0;
            const bRarity = b.rarity || 0;
            result = aRarity - bRarity;
            break;
          default:
            result = a.distance - b.distance;
        }

        return sortAscending ? result : -result;
      });

  } catch (e) {
    console.error("Entity Explorer update error:", e);
  }
}

// Draw entity details panel
function drawEntityDetails(entity) {
  ImGui.separator();
  ImGui.textColored([0.4, 0.8, 1.0, 1.0], "Entity Details");
  ImGui.separator();

  // Basic info
  ImGui.text(`Name: ${entity.shortName || '<unnamed>'}`);
  const nameSource = getNameSource(entity);
  ImGui.sameLine();
  ImGui.textColored([0.5, 0.5, 0.5, 1.0], `(${nameSource})`);

  if (entity.name) {
    ImGui.text(`Metadata Path: ${entity.name}`);
  }
  if (entity.playerName) {
    ImGui.text(`Character Name: ${entity.playerName}`);
  }
  if (entity.renderName) {
    ImGui.text(`Render Name: ${entity.renderName}`);
  }

  ImGui.text(`Category: ${entity.category}`);
  if (entity.hasPosition) {
    ImGui.text(`Distance: ${entity.distance.toFixed(1)} units`);
    // Line of Sight status
    ImGui.text("Line of Sight: ");
    ImGui.sameLine();
    if (entity.distance < 150) {
      if (entity.inLineOfSight) {
        ImGui.textColored([0.3, 1.0, 0.3, 1.0], "Clear");
      } else {
        ImGui.textColored([1.0, 0.3, 0.3, 1.0], "Blocked");
      }
    } else {
      ImGui.textColored([0.5, 0.5, 0.5, 1.0], "Too far");
    }
  } else {
    ImGui.textColored([0.5, 0.5, 0.5, 1.0], "Distance: N/A");
  }
  ImGui.text(`Address: 0x${entity.address.toString(16).toUpperCase()}`);
  ImGui.text(`ID: ${entity.id || 0}`);

  // Derived type information (from components, like GameHelper2)
  if (entity.entityType) {
    const typeColor = entity.entityType === 'Player' ? [0.4, 1.0, 0.4, 1.0] :
                      entity.entityType === 'Monster' ? [1.0, 0.4, 0.4, 1.0] :
                      entity.entityType === 'Chest' ? [1.0, 0.8, 0.2, 1.0] :
                      entity.entityType === 'NPC' ? [0.4, 0.8, 1.0, 1.0] :
                      [0.7, 0.7, 0.7, 1.0];
    ImGui.text("Type: ");
    ImGui.sameLine();
    ImGui.textColored(typeColor, entity.entityType);
  }
  if (entity.entitySubtype && entity.entitySubtype !== 'None' && entity.entitySubtype !== 'Unidentified') {
    ImGui.text(`Subtype: ${entity.entitySubtype}`);
  }
  if (entity.isLocalPlayer) {
    ImGui.textColored([0.2, 1.0, 0.2, 1.0], "(LOCAL PLAYER)");
  }

  ImGui.separator();

  // Position
  if (ImGui.collapsingHeader("Position & Render")) {
    if (entity.hasPosition) {
      ImGui.textColored([0.4, 1.0, 0.4, 1.0], "Component Position (Render):");
      ImGui.text(`  Grid: (${entity.gridX.toFixed(1)}, ${entity.gridY.toFixed(1)})`);
      ImGui.text(`  World: (${entity.worldX.toFixed(1)}, ${entity.worldY.toFixed(1)}, ${entity.worldZ.toFixed(1)})`);
      if (entity.terrainHeight !== undefined) {
        ImGui.text(`  Terrain Height: ${entity.terrainHeight.toFixed(2)}`);
      }
      if (entity.rotationX !== undefined) {
        ImGui.text(`  Rotation: (${entity.rotationX.toFixed(2)}, ${entity.rotationY.toFixed(2)}, ${entity.rotationZ.toFixed(2)})`);
      }
      // Model Bounds (from Render component)
      if (entity.boundsX !== undefined || entity.boundsY !== undefined || entity.boundsZ !== undefined) {
        ImGui.textColored([0.8, 0.6, 1.0, 1.0], "Model Bounds:");
        ImGui.text(`  X: ${(entity.boundsX || 0).toFixed(2)}, Y: ${(entity.boundsY || 0).toFixed(2)}, Z: ${(entity.boundsZ || 0).toFixed(2)}`);
      }
    } else {
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], "No Render Component");
    }

    // Legacy position (from entity struct, not component)
    if (entity.legacyGridX !== undefined && entity.legacyGridY !== undefined) {
      const hasLegacyPos = (entity.legacyGridX !== 0 || entity.legacyGridY !== 0);
      if (hasLegacyPos) {
        ImGui.separator();
        ImGui.textColored([0.8, 0.8, 0.4, 1.0], "Non-Component Position:");
        ImGui.text(`  Grid: (${entity.legacyGridX.toFixed(1)}, ${entity.legacyGridY.toFixed(1)})`);
      }
    }
  }

  // Life component
  if (entity.healthMax !== undefined && ImGui.collapsingHeader("Life & Resources")) {
    ImGui.text(`Alive: ${entity.isAlive ? 'Yes' : 'No'}`);

    // Health
    const hpPercent = entity.healthMax > 0 ? (entity.healthCurrent / entity.healthMax * 100).toFixed(0) : 0;
    const hpColor = entity.healthCurrent < entity.healthMax * 0.3 ? [1.0, 0.3, 0.3, 1.0] :
                    entity.healthCurrent < entity.healthMax * 0.7 ? [1.0, 1.0, 0.3, 1.0] :
                    [0.3, 1.0, 0.3, 1.0];
    ImGui.text("Health:");
    ImGui.sameLine();
    ImGui.textColored(hpColor, `${entity.healthCurrent}/${entity.healthMax} (${hpPercent}%)`);

    // Energy Shield
    if (entity.esMax > 0) {
      const esPercent = (entity.esCurrent / entity.esMax * 100).toFixed(0);
      ImGui.text("Energy Shield:");
      ImGui.sameLine();
      ImGui.textColored([0.4, 0.4, 1.0, 1.0], `${entity.esCurrent}/${entity.esMax} (${esPercent}%)`);
    }

    // Mana
    if (entity.manaMax > 0) {
      const manaPercent = (entity.manaCurrent / entity.manaMax * 100).toFixed(0);
      ImGui.text("Mana:");
      ImGui.sameLine();
      ImGui.textColored([0.4, 0.8, 1.0, 1.0], `${entity.manaCurrent}/${entity.manaMax} (${manaPercent}%)`);
    }

    // Rage
    if (entity.rageMax > 0) {
      const ragePercent = (entity.rageCurrent / entity.rageMax * 100).toFixed(0);
      ImGui.text("Rage:");
      ImGui.sameLine();
      ImGui.textColored([1.0, 0.5, 0.2, 1.0], `${entity.rageCurrent}/${entity.rageMax} (${ragePercent}%)`);
    }
  }

  // Player component
  if (entity.level !== undefined && ImGui.collapsingHeader("Player Info")) {
    if (entity.playerName) {
      ImGui.text(`Character Name: ${entity.playerName}`);
    }
    ImGui.text(`Level: ${entity.level}`);
    ImGui.text(`Experience: ${entity.xp}`);
  }

  // Targetable component
  if (entity.isTargetable !== undefined && ImGui.collapsingHeader("Targetable")) {
    ImGui.text(`Can Target: ${entity.isTargetable ? 'Yes' : 'No'}`);
    ImGui.text(`Can Highlight: ${entity.isHighlightable ? 'Yes' : 'No'}`);
    ImGui.text(`Hidden: ${entity.hiddenFromPlayer ? 'Yes' : 'No'}`);
  }

  // Immunity flags (from Stats component - lightweight mode reads these)
  const hasAnyImmunity = entity.cannotBeDamaged || entity.isHiddenMonster || 
                         entity.cannotBeDamagedOutsideRadius || entity.cannotBeDamagedByNonPlayer ||
                         entity.hasGroundEffect;
  if (hasAnyImmunity && ImGui.collapsingHeader("Immunity Flags")) {
    if (entity.cannotBeDamaged) {
      ImGui.textColored([1.0, 0.3, 0.3, 1.0], "Cannot Be Damaged: Yes");
    }
    if (entity.isHiddenMonster) {
      ImGui.textColored([1.0, 0.6, 0.0, 1.0], "Is Hidden Monster: Yes");
    }
    if (entity.cannotBeDamagedOutsideRadius) {
      ImGui.textColored([1.0, 1.0, 0.0, 1.0], "Cannot Be Damaged Outside Radius: Yes");
    }
    if (entity.cannotBeDamagedByNonPlayer) {
      ImGui.textColored([0.5, 0.5, 1.0, 1.0], "Cannot Be Damaged By Non-Player: Yes");
    }
    if (entity.hasGroundEffect) {
      ImGui.textColored([0.0, 1.0, 1.0, 1.0], `Ground Effect: ${entity.groundEffectName || 'Yes'}`);
    }
  }

  // Item properties (rarity & WorldItem data)
  if ((entity.rarity !== undefined || entity.hasWorldItem) && ImGui.collapsingHeader("Item Properties")) {
    // Unique name (only for actual unique items - validated via art path)
    if (entity.worldItemUniqueName) {
      ImGui.text("Unique Name:");
      ImGui.sameLine();
      ImGui.textColored([1.0, 0.5, 0.0, 1.0], entity.worldItemUniqueName);
    }
    
    // Base type name
    if (entity.worldItemBaseName) {
      ImGui.text("Base Type:");
      ImGui.sameLine();
      ImGui.textColored([0.8, 0.8, 0.8, 1.0], entity.worldItemBaseName);
    }
    
    // Rarity - prefer worldItemRarity for ground items
    const itemRarity = entity.worldItemRarity !== undefined ? entity.worldItemRarity : entity.rarity;
    if (itemRarity !== undefined) {
      const rarityInfo = getRarityInfo(itemRarity);
      ImGui.text("Rarity:");
      ImGui.sameLine();
      ImGui.textColored(rarityInfo.color, rarityInfo.name);
    }
    
    // Grid size
    if (entity.worldItemGridWidth !== undefined && entity.worldItemGridHeight !== undefined) {
      const w = entity.worldItemGridWidth || 1;
      const h = entity.worldItemGridHeight || 1;
      if (w > 0 && h > 0) {
        ImGui.text(`Grid Size: ${w}x${h}`);
      }
    }
    
    // Stack size
    if (entity.worldItemStackSize !== undefined && entity.worldItemStackSize > 0) {
      ImGui.text(`Stack Size: ${entity.worldItemStackSize}`);
    }
    
    // WorldItem indicator
    if (entity.hasWorldItem) {
      ImGui.textColored([0.5, 0.8, 0.5, 1.0], "(Dropped Item)");
    }
  }

  // Chest component
  if (entity.chestIsOpened !== undefined && ImGui.collapsingHeader("Chest")) {
    ImGui.text(`Opened: ${entity.chestIsOpened ? 'Yes' : 'No'}`);
    if (entity.chestIsStrongbox) {
      ImGui.textColored([1.0, 0.5, 0.0, 1.0], "STRONGBOX");
    }
  }

  // Positioned component
  if (entity.reaction !== undefined && ImGui.collapsingHeader("Faction")) {
    const reactions = ['Neutral', 'Friendly', 'Enemy'];
    const reactionColors = [
      [0.8, 0.8, 0.8, 1.0],  // Neutral
      [0.4, 1.0, 0.4, 1.0],  // Friendly
      [1.0, 0.4, 0.4, 1.0]   // Enemy
    ];
    ImGui.text("Reaction:");
    ImGui.sameLine();
    ImGui.textColored(reactionColors[entity.reaction] || reactionColors[0], reactions[entity.reaction] || 'Unknown');
    ImGui.text(`Is Friendly: ${entity.isFriendly ? 'Yes' : 'No'}`);
  }

  // Buffs
  if (entity.buffsCount !== undefined && ImGui.collapsingHeader("Buffs & Effects")) {
    ImGui.text(`Active Buffs: ${entity.buffsCount}`);

    if (entity.buffs && entity.buffs.length > 0) {
      ImGui.separator();
      for (const buff of entity.buffs) {
        if (ImGui.treeNode(`${buff.name}##${buff.name}`)) {
          if (buff.timeLeft > 0) {
            const percent = buff.totalTime > 0 ? (buff.timeLeft / buff.totalTime * 100).toFixed(0) : 0;
            ImGui.text(`Time: ${buff.timeLeft.toFixed(1)}s / ${buff.totalTime.toFixed(1)}s (${percent}%)`);
          }
          if (buff.charges > 0) {
            ImGui.text(`Charges: ${buff.charges}`);
          }
          if (buff.flaskSlot >= 0 && buff.flaskSlot < 5) {
            ImGui.text(`Flask Slot: ${buff.flaskSlot + 1}`);
          }
          if (buff.effectiveness !== 0) {
            ImGui.text(`Effectiveness: ${100 + buff.effectiveness}%`);
          }
          ImGui.treePop();
        }
      }
    }
  }

  // Entity Stats
  if (entity.currentWeaponIndex !== undefined && ImGui.collapsingHeader("Entity Stats")) {
    // Load stat names on first use
    loadStatNames();
    
    ImGui.text(`Weapon Set: ${entity.currentWeaponIndex + 1}`);

    if (entity.statsFromItems && entity.statsFromItems.length > 0) {
      ImGui.separator();
      ImGui.textColored([0.4, 0.8, 1.0, 1.0], `Stats (${entity.statsFromItems.length}):`);
      
      // Display all stats directly - parent window handles scrolling
      for (let i = 0; i < entity.statsFromItems.length; i++) {
        const stat = entity.statsFromItems[i];
        const statName = getStatName(stat.key);
        ImGui.text(`  ${statName}: ${stat.value}`);
      }
    }

    // Note: Stats from Buffs reading appears to have incorrect offsets - disabled for now
    // The values shown are garbage data, likely reading from wrong memory location
    // TODO: Find correct offset for stats_by_buffs_ptr (currently using 0x198)
  }
}

// Main draw function
function onDraw() {
  updateEntities();

  const player = poe2.getLocalPlayer();

  // Main window
  ImGui.setNextWindowSize({x: 900, y: 700}, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({x: 1110, y: 10}, ImGui.Cond.FirstUseEver);  // Top, offset from chicken
  ImGui.setNextWindowCollapsed(true, ImGui.Cond.Once);  // Start collapsed (once per session)

  if (!ImGui.begin("Entity Explorer", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }

  // Player info header
  if (player) {
    // Debug: log player data once
    if (!globalThis.playerDebugLogged) {
      console.log('[EntityExplorer] Player data:');
      console.log('  playerName:', player.playerName);
      console.log('  level:', player.level);
      console.log('  gridX:', player.gridX);
      console.log('  gridY:', player.gridY);
      console.log('  healthCurrent:', player.healthCurrent);
      console.log('  healthMax:', player.healthMax);
      console.log('  name (path):', player.name);
      globalThis.playerDebugLogged = true;
    }

    const playerName = player.playerName || player.name || 'Unknown';
    const playerLevel = player.level !== undefined ? player.level : '?';
    const gridX = player.gridX !== undefined ? player.gridX.toFixed(0) : '?';
    const gridY = player.gridY !== undefined ? player.gridY.toFixed(0) : '?';

    ImGui.textColored([0.4, 1.0, 0.4, 1.0], `Player: ${playerName}`);
    ImGui.sameLine();
    ImGui.text(`Level ${playerLevel}`);
    ImGui.sameLine();
    ImGui.text(`(${gridX}, ${gridY})`);

    if (player.healthMax && player.healthMax > 0) {
      ImGui.sameLine();
      ImGui.text(`HP: ${player.healthCurrent}/${player.healthMax}`);
    }
  } else {
    ImGui.textColored([1.0, 0.5, 0.5, 1.0], "Not in game");
  }

  ImGui.separator();

  // Controls
  if (ImGui.collapsingHeader("Filters & Settings", ImGui.TreeNodeFlags.DefaultOpen)) {
    // Quick filter toggles (using buttons since checkbox needs MutableVariable)
    const aliveColor = showOnlyAlive ? [0.2, 0.8, 0.2, 1.0] : [0.3, 0.3, 0.3, 1.0];
    ImGui.pushStyleColor(ImGui.Col.Button, aliveColor);
    if (ImGui.button(showOnlyAlive ? '[X] Alive Only' : '[ ] Alive Only')) {
      showOnlyAlive = !showOnlyAlive;
    }
    ImGui.popStyleColor(1);

    ImGui.sameLine();
    const targetableColor = showOnlyTargetable ? [0.2, 0.8, 0.2, 1.0] : [0.3, 0.3, 0.3, 1.0];
    ImGui.pushStyleColor(ImGui.Col.Button, targetableColor);
    if (ImGui.button(showOnlyTargetable ? '[X] Targetable' : '[ ] Targetable')) {
      showOnlyTargetable = !showOnlyTargetable;
    }
    ImGui.popStyleColor(1);

    ImGui.sameLine();
    const itemsColor = showOnlyItems ? [0.2, 0.8, 0.2, 1.0] : [0.3, 0.3, 0.3, 1.0];
    ImGui.pushStyleColor(ImGui.Col.Button, itemsColor);
    if (ImGui.button(showOnlyItems ? '[X] Items Only' : '[ ] Items Only')) {
      showOnlyItems = !showOnlyItems;
    }
    ImGui.popStyleColor(1);

    ImGui.sameLine();
    const losColor = showOnlyInLoS ? [0.2, 0.8, 0.2, 1.0] : [0.3, 0.3, 0.3, 1.0];
    ImGui.pushStyleColor(ImGui.Col.Button, losColor);
    if (ImGui.button(showOnlyInLoS ? '[X] In LoS' : '[ ] In LoS')) {
      showOnlyInLoS = !showOnlyInLoS;
    }
    ImGui.popStyleColor(1);

    ImGui.separator();

    // Category filters
    ImGui.text("Categories:");
    const categories = Object.keys(categoryFilters);
    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const isEnabled = categoryFilters[cat];
      const color = isEnabled ? [0.2, 0.6, 0.2, 1.0] : [0.4, 0.2, 0.2, 1.0];
      ImGui.pushStyleColor(ImGui.Col.Button, color);
      if (ImGui.button(`${isEnabled ? '[X]' : '[ ]'} ${cat}##catfilter`)) {
        categoryFilters[cat] = !isEnabled;
      }
      ImGui.popStyleColor(1);
      if ((i + 1) % 4 !== 0) ImGui.sameLine();
    }

  }

  ImGui.separator();

  // Entity count and sort controls
  ImGui.text(`Entities: ${entities.length}`);
  ImGui.sameLine();
  ImGui.text("Sort by:");
  ImGui.sameLine();

  const sortOptions = ['name', 'distance', 'type', 'health', 'rarity'];
  for (const opt of sortOptions) {
    if (sortColumn === opt) {
      ImGui.pushStyleColor(ImGui.Col.Button, [0.2, 0.6, 0.2, 1.0]);
    }
    if (ImGui.button(opt.charAt(0).toUpperCase() + opt.slice(1))) {
      if (sortColumn === opt) {
        sortAscending = !sortAscending;
      } else {
        sortColumn = opt;
        sortAscending = true;
      }
    }
    if (sortColumn === opt) {
      ImGui.popStyleColor(1);
      ImGui.sameLine();
      ImGui.text(sortAscending ? '^' : 'v');
    }
    ImGui.sameLine();
  }

  ImGui.newLine();
  ImGui.separator();

  // Split view: list on left, details on right
  ImGui.beginChild("EntityList", {x: 500, y: 0}, ImGui.ChildFlags.Border);

  // Table header
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], "Name");
  ImGui.sameLine(220);
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], "Type");
  ImGui.sameLine(300);
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], "Dist");
  ImGui.sameLine(350);
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], "LoS");
  ImGui.sameLine(400);
  ImGui.textColored([0.7, 0.7, 0.7, 1.0], "HP");
  ImGui.separator();

  // Entity list
  for (const entity of entities) {
    const color = getCategoryColor(entity.category);
    const isSelected = selectedEntity && selectedEntity.address === entity.address;

    if (isSelected) {
      ImGui.pushStyleColor(ImGui.Col.Button, [0.3, 0.3, 0.8, 1.0]);
    }

    // Clickable entity row
    if (ImGui.button(`${entity.shortName}##${entity.address}`, {x: 210, y: 0})) {
      selectedEntity = entity;
    }

    if (isSelected) {
      ImGui.popStyleColor(1);
    }

    // Type
    ImGui.sameLine(220);
    ImGui.textColored(color, entity.category.substring(0, 7));

    // Distance
    ImGui.sameLine(300);
    if (entity.hasPosition) {
      const distColor = entity.distance < 30 ? [1.0, 0.3, 0.3, 1.0] : [0.7, 0.7, 0.7, 1.0];
      ImGui.textColored(distColor, entity.distance.toFixed(0));
    } else {
      ImGui.textColored([0.4, 0.4, 0.4, 1.0], "-");
    }

    // Line of Sight indicator
    ImGui.sameLine(350);
    if (entity.hasPosition && entity.distance < 150) {
      if (entity.inLineOfSight) {
        ImGui.textColored([0.3, 1.0, 0.3, 1.0], "Yes");
      } else {
        ImGui.textColored([1.0, 0.3, 0.3, 1.0], "No");
      }
    } else {
      ImGui.textColored([0.4, 0.4, 0.4, 1.0], "-");
    }

    // Health (if available)
    ImGui.sameLine(400);
    if (entity.healthMax !== undefined) {
      const hpColor = !entity.isAlive ? [0.5, 0.5, 0.5, 1.0] :
                      entity.healthCurrent < entity.healthMax * 0.3 ? [1.0, 0.3, 0.3, 1.0] :
                      entity.healthCurrent < entity.healthMax * 0.7 ? [1.0, 1.0, 0.3, 1.0] :
                      [0.3, 1.0, 0.3, 1.0];
      ImGui.textColored(hpColor, `${entity.healthCurrent}/${entity.healthMax}`);
    } else {
      ImGui.textColored([0.4, 0.4, 0.4, 1.0], "-");
    }
    
    // Immunity indicator (if any immunity flag is set)
    const hasImmunity = entity.cannotBeDamaged || entity.isHiddenMonster || 
                        entity.cannotBeDamagedOutsideRadius || entity.cannotBeDamagedByNonPlayer;
    if (hasImmunity) {
      ImGui.sameLine();
      ImGui.textColored([1.0, 0.3, 0.3, 1.0], "[IMM]");
    }

    // Item rarity indicator (prefer worldItemRarity for ground items)
    const displayRarity = entity.worldItemRarity !== undefined ? entity.worldItemRarity : entity.rarity;
    if (displayRarity !== undefined && displayRarity > 0) {
      ImGui.sameLine();
      const rarityInfo = getRarityInfo(displayRarity);
      ImGui.textColored(rarityInfo.color, `[${rarityInfo.name[0]}]`);
    }
  }

  ImGui.endChild();

  // Details panel on right
  ImGui.sameLine();
  ImGui.beginChild("EntityDetails", {x: 0, y: 0}, ImGui.ChildFlags.Border);

  if (selectedEntity) {
    // Find fresh entity data by address (selectedEntity is cached, need live data)
    const freshEntity = entities.find(e => e.address === selectedEntity.address);
    if (freshEntity) {
      selectedEntity = freshEntity;  // Update cache with fresh data
      drawEntityDetails(freshEntity);
    } else {
      // Entity no longer exists, show stale data with warning
      ImGui.textColored([1.0, 0.5, 0.0, 1.0], "(Entity may have despawned)");
      drawEntityDetails(selectedEntity);
    }
  } else {
    ImGui.textColored([0.5, 0.5, 0.5, 1.0], "Select an entity to view details");
  }

  ImGui.endChild();

  ImGui.end();
}

// Export plugin
export const entityExplorerPlugin = {
  onDraw: onDraw
};

console.log("Entity Explorer plugin loaded");


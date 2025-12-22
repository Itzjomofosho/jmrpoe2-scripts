# Entity Radar Plugin

A JavaScript plugin that tracks entity positions in real-time and calculates distances to the player.

## Discovery

Through reverse engineering, we discovered that the fields at `Entity+0x3FC` and `Entity+0x400` (previously thought to be "ID_1" and "ID_2") are actually **grid coordinates**!

### Evidence:
- Values are small positive integers (hundreds range)
- They change smoothly as the player moves
- For the player character ("Characters/DexFour"), watching these values change confirms they track position

## Features

- **Real-time position tracking** of player and all entities
- **Distance calculation** between player and nearby entities
- **Category filtering** (Monsters, Characters, Chests, etc.)
- **Distance-based filtering** (show only entities within X units)
- **Color-coded display** 
  - Orange: Monsters
  - Green: Characters
  - Yellow: Chests
  - Distance gradient (red = close, blue = far)
- **Automatic sorting** by distance
- **Statistics panel** showing nearest entity, counts per category

## Usage

1. **Enable the Entity Inspector plugin** (C++ plugin) - this collects entity data
2. **Load this JS plugin** - it will display the data in a radar UI
3. **Adjust settings:**
   - Max Distance: How far to scan (10-500 units)
   - Update Interval: How often to refresh (50-1000ms)
   - Category filters: Show/hide specific entity types
4. **Move around** and watch the grid coordinates change!

## API Reference

### POE2.getEntities()

Returns an array of entity objects:

```javascript
[
  {
    address: 0x...,      // Entity memory address
    gridX: 266,          // Grid X coordinate (Entity+0x3FC)
    gridY: 918,          // Grid Y coordinate (Entity+0x400)
    name: "Metadata/...", // Full metadata path
    vtable: 0x...,       // Entity vtable
    typeId: 0x...,       // Entity type ID
    flags: 0x...         // Entity flags
  },
  // ... more entities
]
```

### Helper Functions

The plugin includes helper functions:

- `calculateDistance(x1, y1, x2, y2)` - 2D Euclidean distance
- `getCategory(path)` - Extracts category from metadata path
- `getShortName(path)` - Gets filename from full path

## Implementation Details

### Grid Coordinates

The coordinates are stored as unsigned 32-bit integers at:
- **Entity+0x3FC** (gridX) - X position in world grid
- **Entity+0x400** (gridY) - Y position in world grid

These were initialized to `0x80000000` in the Entity constructor (inactive state), but get real grid values once the entity is spawned in the game world.

### Distance Calculation

Simple 2D distance formula:
```javascript
distance = sqrt((x2 - x1)² + (y2 - y1)²)
```

### Player Detection

The plugin identifies the player by looking for entities in the "Characters" category with names containing "Dex", "Str", or "Int" (the character class prefixes).

## Future Enhancements

Potential improvements:
- Add Z-coordinate support (if Entity+0x404 is gridZ)
- Radar visualization (2D map view)
- Track entity movement speed/velocity
- Alert on nearby dangerous entities
- Path prediction for moving entities
- Export position data for mapping

## Troubleshooting

**"Player not found"**
- Make sure you're in-game with a character loaded
- The Entity Inspector plugin must be enabled
- Click "Refresh Entity List" in the Entity Inspector

**Empty entity list**
- Enable the Entity Inspector C++ plugin
- Make sure entities are loaded (you're in a game area, not menu)
- Increase the max distance filter

**No entities showing**
- Check category filters - you may have all categories disabled
- Increase max distance
- Refresh the entity list

## Technical Notes

This plugin demonstrates:
1. **C++/JavaScript interop** - exposing C++ plugin data to JS
2. **Real-time game state tracking** - monitoring entity positions
3. **Spatial algorithms** - distance calculations, filtering
4. **ImGui from JavaScript** - creating rich UI in JS
5. **Reverse engineering application** - turning RE findings into useful tools

The grid coordinate discovery shows how careful observation during gameplay can reveal the true meaning of unknown data fields!


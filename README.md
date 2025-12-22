# JMR POE2 Scripts

JavaScript plugins and settings for the JMR POE2 Modding Framework.

## Contents

- **settings.json** - Framework configuration
- **scripts/** - JavaScript plugins
  - **poe2-scripts/** - POE2-specific plugins
    - `chicken.js` - Auto-disconnect on low health
    - `entity_explorer.js` - Browse and inspect entities
    - `entity_actions.js` - Target entities with move/attack
    - `entity_radar.js` - Simple entity radar
    - `minimap_radar.js` - Full minimap/largemap radar overlay
    - And more...
  - **examples/** - Example scripts for learning

## Installation

1. Copy these files to your `build/Release` directory where `game_modding_framework.dll` is located
2. Structure should be:
   ```
   build/Release/
     ├── game_modding_framework.dll
     ├── settings.json
     └── scripts/
         └── poe2-scripts/
             └── [all .js files]
   ```

## Usage

Scripts are automatically loaded by the framework. Enable/disable plugins via the Plugin Browser (F12).

## Main Framework Repository

This is a companion repository to [jmrpoe2](https://github.com/Itzjomofosho/jmrpoe2) which contains the C++ framework source code.


/**
 * POE2 Cache Utility
 * 
 * Provides per-frame caching for expensive POE2 API calls.
 * All scripts should import and use this instead of calling poe2 methods directly.
 * 
 * Usage:
 *   import { POE2Cache } from './poe2_cache.js';
 *   
 *   // In your main.js onDraw (ONLY ONCE per frame):
 *   POE2Cache.beginFrame();
 *   
 *   // In any script:
 *   const player = POE2Cache.getLocalPlayer();  // Cached per frame
 *   const entities = POE2Cache.getEntities();   // Cached per frame
 * 
 * Benefits:
 * - Reduces redundant API calls within a single frame
 * - Shared cache across all scripts that use this module
 * - Automatic cache invalidation per frame
 * - Area change detection to clear stale data
 * 
 * IMPORTANT: Only call beginFrame() ONCE per frame (in main.js)!
 * Individual plugins should NOT call beginFrame().
 */

const poe2 = new POE2();

// Frame tracking
let frameCounter = 0;

// Area change tracking
let lastAreaHash = null;
let areaChangeCount = 0;

// Cached data
let cachedPlayer = null;
let cachedPlayerFrame = -1;

let cachedEntities = null;
let cachedEntitiesFrame = -1;
let cachedEntitiesKey = '';  // Cache key for distance-filtered queries

// Buff check caches (for common buff checks)
let cachedHealthFlaskActive = null;
let cachedHealthFlaskFrame = -1;

let cachedManaFlaskActive = null;
let cachedManaFlaskFrame = -1;

// Diagnostics
let lastDiagnosticFrame = 0;
const DIAGNOSTIC_INTERVAL = 300;  // Log every 300 frames (~5 seconds at 60fps)
let entityReadCount = 0;
let playerReadCount = 0;

/**
 * POE2 Cache - Shared caching utility for all scripts
 */
export const POE2Cache = {
  /**
   * Call this at the start of each frame (in onDraw)
   * IMPORTANT: Only call this ONCE per frame (in main.js)!
   * Individual plugins should NOT call beginFrame().
   *
   * Increments the frame counter to invalidate stale caches
   * Also checks for area changes to clear all cached data
   */
  beginFrame() {
    // Simply increment frame counter - this invalidates all per-frame caches
    frameCounter++;
    
    // Check for area change using terrain info (lightweight check)
    this._checkAreaChange();
    
    // Periodic diagnostics
    if (frameCounter - lastDiagnosticFrame >= DIAGNOSTIC_INTERVAL) {
      this._logDiagnostics();
      lastDiagnosticFrame = frameCounter;
    }
  },
  
  /**
   * Check if area has changed and clear caches if so
   * Uses multiple signals: terrain dimensions AND player entity address
   * @private
   */
  _checkAreaChange() {
    try {
      const terrain = poe2.getTerrainInfo();
      
      // Use multiple signals for area change detection:
      // 1. Terrain dimensions (can be same across some areas)
      // 2. Player entity address (changes on area load)
      // This makes detection more reliable
      let terrainHash = terrain && terrain.isValid 
        ? `${terrain.width}x${terrain.height}` 
        : null;
      
      // ALWAYS get fresh player address for area change detection
      // Don't use cached player - it's stale after death/loading screen
      let playerAddr = null;
      try {
        const freshPlayer = poe2.getLocalPlayer();
        if (freshPlayer && freshPlayer.address) {
          playerAddr = freshPlayer.address;
        }
      } catch (e) {
        // Player read failed, use null
      }
      
      const areaHash = terrainHash ? `${terrainHash}@${playerAddr || 0}` : null;
      
      if (areaHash !== lastAreaHash) {
        if (lastAreaHash !== null) {
          // Area actually changed (not just initial load)
          areaChangeCount++;
          console.log(`[POE2Cache] Area changed: ${lastAreaHash} -> ${areaHash} (change #${areaChangeCount})`);
          
          // Clear all caches on area change
          this.invalidateAll();
          
          // Force garbage collection hint by nulling references
          cachedPlayer = null;
          cachedEntities = null;
        }
        lastAreaHash = areaHash;
      }
    } catch (e) {
      // Terrain read failed, likely not in game
      if (lastAreaHash !== null) {
        console.log(`[POE2Cache] Left game area, clearing cache`);
        this.invalidateAll();
        lastAreaHash = null;
      }
    }
  },
  
  /**
   * Log diagnostic information
   * @private
   */
  _logDiagnostics() {
    const entityCount = cachedEntities ? cachedEntities.length : 0;
    console.log(`[POE2Cache] Frame ${frameCounter}: ${entityCount} entities, ` +
                `${entityReadCount} entity reads, ${playerReadCount} player reads ` +
                `(last ${DIAGNOSTIC_INTERVAL} frames)`);
    
    // Reset counters
    entityReadCount = 0;
    playerReadCount = 0;
  },
  
  /**
   * Get current frame number (for debugging)
   */
  getFrameNumber() {
    return frameCounter;
  },
  
  /**
   * Get area change count (for debugging)
   */
  getAreaChangeCount() {
    return areaChangeCount;
  },
  
  /**
   * Get local player with per-frame caching
   * Only calls poe2.getLocalPlayer() once per frame
   */
  getLocalPlayer() {
    if (cachedPlayerFrame !== frameCounter) {
      cachedPlayer = poe2.getLocalPlayer();
      cachedPlayerFrame = frameCounter;
      playerReadCount++;
    }
    return cachedPlayer;
  },
  
  /**
   * Get entities with per-frame caching
   * @param {number|object} options - Distance (number) or options object
   *   Options: { maxDistance, type, aliveOnly, monstersOnly }
   */
  getEntities(options = 0) {
    // Build cache key from options
    let cacheKey;
    if (typeof options === 'number') {
      cacheKey = options > 0 ? `entities_dist_${options}` : 'entities_all';
    } else if (typeof options === 'object') {
      cacheKey = `entities_${options.maxDistance || 0}_${options.type || ''}_${options.aliveOnly || false}_${options.monstersOnly || false}`;
    } else {
      cacheKey = 'entities_all';
    }
    
    if (cachedEntitiesFrame !== frameCounter || cachedEntitiesKey !== cacheKey) {
      cachedEntities = poe2.getEntities(options);
      cachedEntitiesFrame = frameCounter;
      cachedEntitiesKey = cacheKey;
      entityReadCount++;
    }
    return cachedEntities;
  },
  
  /**
   * Get nearby entities only (optimized for performance)
   * @param {number} maxDistance - Max distance from player (default 300)
   */
  getNearbyEntities(maxDistance = 300) {
    return this.getEntities(maxDistance);
  },
  
  /**
   * Get alive hostile monsters only - HIGHLY OPTIMIZED for auto-attack
   * All filtering happens in C++, returns only valid attack targets
   * @param {number} maxDistance - Max distance from player (default 300)
   */
  getHostileMonsters(maxDistance = 300) {
    return this.getEntities({ maxDistance, monstersOnly: true });
  },
  
  /**
   * Check if health flask is active (cached per frame)
   */
  isHealthFlaskActive() {
    if (cachedHealthFlaskFrame === frameCounter) {
      return cachedHealthFlaskActive;
    }
    
    const player = this.getLocalPlayer();
    if (!player) {
      cachedHealthFlaskActive = false;
      cachedHealthFlaskFrame = frameCounter;
      return false;
    }
    
    let result = false;
    if (player.buffs && player.buffs.length > 0) {
      for (const buff of player.buffs) {
        if (buff.name && buff.name.includes("flask_effect_life")) {
          result = true;
          break;
        }
      }
    }
    
    cachedHealthFlaskActive = result;
    cachedHealthFlaskFrame = frameCounter;
    return result;
  },
  
  /**
   * Check if mana flask is active (cached per frame)
   */
  isManaFlaskActive() {
    if (cachedManaFlaskFrame === frameCounter) {
      return cachedManaFlaskActive;
    }
    
    const player = this.getLocalPlayer();
    if (!player) {
      cachedManaFlaskActive = false;
      cachedManaFlaskFrame = frameCounter;
      return false;
    }
    
    let result = false;
    if (player.buffs && player.buffs.length > 0) {
      for (const buff of player.buffs) {
        if (buff.name && buff.name.includes("flask_effect_mana")) {
          result = true;
          break;
        }
      }
    }
    
    cachedManaFlaskActive = result;
    cachedManaFlaskFrame = frameCounter;
    return result;
  },
  
  /**
   * Check if player has a specific buff (cached per frame)
   * @param {string} buffNamePart - Part of buff name to search for
   */
  hasBuff(buffNamePart) {
    const player = this.getLocalPlayer();
    if (!player || !player.buffs) return false;
    
    for (const buff of player.buffs) {
      if (buff.name && buff.name.includes(buffNamePart)) {
        return true;
      }
    }
    return false;
  },
  
  /**
   * Get player health percentage (cached per frame)
   */
  getHealthPercent() {
    const player = this.getLocalPlayer();
    if (!player || !player.healthMax || player.healthMax <= 0) {
      return 100;
    }
    return (player.healthCurrent / player.healthMax) * 100;
  },
  
  /**
   * Get player mana percentage (cached per frame)
   */
  getManaPercent() {
    const player = this.getLocalPlayer();
    if (!player || !player.manaMax || player.manaMax <= 0) {
      return 100;
    }
    return (player.manaCurrent / player.manaMax) * 100;
  },
  
  /**
   * Get player ES percentage (cached per frame)
   */
  getESPercent() {
    const player = this.getLocalPlayer();
    if (!player || !player.esMax || player.esMax <= 0) {
      return 100;
    }
    return (player.esCurrent / player.esMax) * 100;
  },
  
  /**
   * Force cache invalidation
   * Called automatically on area change, but can be called manually if needed
   */
  invalidateAll() {
    cachedPlayerFrame = -1;
    cachedEntitiesFrame = -1;
    cachedEntitiesKey = '';  // Reset key to force fresh fetch
    cachedHealthFlaskFrame = -1;
    cachedManaFlaskFrame = -1;
    
    // Also null the cached data to help GC
    cachedPlayer = null;
    cachedEntities = null;
    cachedHealthFlaskActive = null;
    cachedManaFlaskActive = null;
    
    console.log(`[POE2Cache] All caches invalidated`);
  },
  
  /**
   * Get raw poe2 instance for uncached calls
   * Use this for methods that don't need caching (sendPacket, etc.)
   */
  getRawPOE2() {
    return poe2;
  },
  
  /**
   * Get cache statistics for debugging
   */
  getStats() {
    return {
      frameCounter,
      areaChangeCount,
      lastAreaHash,
      entityCount: cachedEntities ? cachedEntities.length : 0,
      hasPlayer: cachedPlayer !== null,
      entityReadCount,
      playerReadCount
    };
  }
};

// Also export the raw poe2 for convenience
export { poe2 };

console.log("[POE2Cache] Shared caching utility loaded (v3 - simplified frame counter)");

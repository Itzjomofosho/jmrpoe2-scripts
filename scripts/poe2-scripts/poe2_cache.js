/**
 * POE2 Cache Utility
 * 
 * Provides per-frame caching for expensive POE2 API calls.
 * All scripts should import and use this instead of calling poe2 methods directly.
 * 
 * Usage:
 *   import { POE2Cache } from './poe2_cache.js';
 *   
 *   function onDraw() {
 *     POE2Cache.beginFrame();  // Call once at start of each frame
 *     
 *     const player = POE2Cache.getLocalPlayer();  // Cached per frame
 *     const entities = POE2Cache.getEntities();   // Cached per frame
 *   }
 * 
 * Benefits:
 * - Reduces redundant API calls within a single frame
 * - Shared cache across all scripts that use this module
 * - Automatic cache invalidation per frame
 */

const poe2 = new POE2();

// Frame tracking
let frameCounter = 0;

// Cached data
let cachedPlayer = null;
let cachedPlayerFrame = -1;

let cachedEntities = null;
let cachedEntitiesFrame = -1;

// Buff check caches (for common buff checks)
let cachedHealthFlaskActive = null;
let cachedHealthFlaskFrame = -1;

let cachedManaFlaskActive = null;
let cachedManaFlaskFrame = -1;

/**
 * POE2 Cache - Shared caching utility for all scripts
 */
export const POE2Cache = {
  /**
   * Call this at the start of each frame (in onDraw)
   * Increments the frame counter to invalidate stale caches
   */
  beginFrame() {
    frameCounter++;
  },
  
  /**
   * Get current frame number (for debugging)
   */
  getFrameNumber() {
    return frameCounter;
  },
  
  /**
   * Get local player with per-frame caching
   * Only calls poe2.getLocalPlayer() once per frame
   */
  getLocalPlayer() {
    if (cachedPlayerFrame !== frameCounter) {
      cachedPlayer = poe2.getLocalPlayer();
      cachedPlayerFrame = frameCounter;
    }
    return cachedPlayer;
  },
  
  /**
   * Get all entities with per-frame caching
   * Only calls poe2.getEntities() once per frame
   */
  getEntities() {
    if (cachedEntitiesFrame !== frameCounter) {
      cachedEntities = poe2.getEntities();
      cachedEntitiesFrame = frameCounter;
    }
    return cachedEntities;
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
   * Force cache invalidation (use sparingly)
   */
  invalidateAll() {
    cachedPlayerFrame = -1;
    cachedEntitiesFrame = -1;
    cachedHealthFlaskFrame = -1;
    cachedManaFlaskFrame = -1;
  },
  
  /**
   * Get raw poe2 instance for uncached calls
   * Use this for methods that don't need caching (sendPacket, etc.)
   */
  getRawPOE2() {
    return poe2;
  }
};

// Also export the raw poe2 for convenience
export { poe2 };

console.log("[POE2Cache] Shared caching utility loaded");

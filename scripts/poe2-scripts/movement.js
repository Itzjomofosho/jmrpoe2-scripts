/**
 * Movement Utility Module
 * 
 * Provides functions for sending movement packets to the game.
 * Uses isometric coordinate system:
 *   +X = NE, +Y = NW, -X = SW, -Y = SE
 * 
 * Cardinal directions:
 *   North = +X, +Y
 *   South = -X, -Y
 *   East  = +X, -Y
 *   West  = -X, +Y
 * 
 * Distance notes:
 *   - Max effective distance per packet: ~500 units
 *   - Values above 500 appear to be capped/ignored by the game
 *   - 100 units = short step
 *   - 300 units = medium move
 *   - 500 units = max range move
 */

import { poe2 } from './poe2_cache.js';

// Maximum effective movement distance per packet
export const MAX_MOVE_DISTANCE = 500;

// Packet structure:
// [0-1]   Opcode: 01 84
// [2-4]   Header: 01 20 00
// [5-6]   Action Type: 29 09 (Move = 0x2909)
// [7-10]  Flags: 04 00 FF 00
// [11-14] Delta X (big-endian signed int32)
// [15-18] Delta Y (big-endian signed int32)

const MOVE_PACKET_TEMPLATE = [
  0x01, 0x84,             // Opcode
  0x01, 0x20, 0x00,       // Header
  0x29, 0x09,             // Action type (Move)
  0x04, 0x00, 0xFF, 0x00  // Flags
];

/**
 * Convert signed int32 to big-endian byte array
 */
function int32ToBytesBE(value) {
  // Handle signed values (JavaScript bitwise ops use 32-bit signed)
  const unsigned = value >>> 0;  // Convert to unsigned for bit shifting
  return [
    (unsigned >> 24) & 0xFF,
    (unsigned >> 16) & 0xFF,
    (unsigned >> 8) & 0xFF,
    unsigned & 0xFF
  ];
}

/**
 * Send raw movement packet with specified deltas
 * @param {number} deltaX - X delta (+ = NE, - = SW)
 * @param {number} deltaY - Y delta (+ = NW, - = SE)
 * @returns {boolean} Success
 */
export function sendMoveRaw(deltaX, deltaY) {
  const packet = new Uint8Array([
    ...MOVE_PACKET_TEMPLATE,
    ...int32ToBytesBE(deltaX),
    ...int32ToBytesBE(deltaY)
  ]);
  return poe2.sendPacket(packet);
}

/**
 * Direction mappings to isometric deltas
 * Distance is applied as the magnitude
 */
const DIRECTIONS = {
  // Cardinal (diagonal in isometric)
  n:     [1, 1],    // North = +X +Y
  s:     [-1, -1],  // South = -X -Y
  e:     [1, -1],   // East  = +X -Y
  w:     [-1, 1],   // West  = -X +Y
  
  // Ordinal (axis-aligned in isometric)
  ne:    [1, 0],    // Northeast = +X only
  nw:    [0, 1],    // Northwest = +Y only
  se:    [0, -1],   // Southeast = -Y only
  sw:    [-1, 0],   // Southwest = -X only
  
  // Aliases
  north: [1, 1],
  south: [-1, -1],
  east:  [1, -1],
  west:  [-1, 1],
  northeast: [1, 0],
  northwest: [0, 1],
  southeast: [0, -1],
  southwest: [-1, 0]
};

/**
 * Move in a named direction
 * @param {string} direction - Direction name: n, s, e, w, ne, nw, se, sw
 * @param {number} distance - Movement distance (default 100, max 500)
 * @returns {boolean} Success
 */
export function move(direction, distance = 100) {
  const dir = DIRECTIONS[direction.toLowerCase()];
  if (!dir) {
    console.error(`[Movement] Unknown direction: ${direction}`);
    return false;
  }
  
  // Don't clamp - let user test to find real cap
  const clampedDist = distance;
  
  const [xMult, yMult] = dir;
  
  // For diagonal directions (n/s/e/w), scale by sqrt(2)/2 to maintain distance
  // For axis-aligned (ne/nw/se/sw), use full distance
  let dx, dy;
  if (xMult !== 0 && yMult !== 0) {
    // Diagonal - split distance between X and Y
    const scaledDist = Math.round(clampedDist * 0.707);  // ~1/sqrt(2)
    dx = xMult * scaledDist;
    dy = yMult * scaledDist;
  } else {
    // Axis-aligned - full distance on one axis
    dx = xMult * clampedDist;
    dy = yMult * clampedDist;
  }
  
  return sendMoveRaw(dx, dy);
}

/**
 * Move toward a specific angle (0 = East, 90 = North, etc.)
 * @param {number} angleDegrees - Angle in degrees (0-360)
 * @param {number} distance - Movement distance
 * @returns {boolean} Success
 */
export function moveAngle(angleDegrees, distance = 100) {
  // Convert screen angle to isometric deltas
  // Screen coordinate system: 0 = right (E), 90 = up (N)
  const radians = angleDegrees * Math.PI / 180;
  
  // Screen X/Y deltas
  const screenX = Math.cos(radians);
  const screenY = Math.sin(radians);
  
  // Convert screen coords to isometric:
  // Screen East (+X) = Isometric (+X, -Y) = NE + SE
  // Screen North (+Y) = Isometric (+X, +Y) = NE + NW
  // 
  // Isometric X = screenX (for E component) + screenY (for N component)
  // Isometric Y = -screenX (E has -Y) + screenY (N has +Y)
  const isoX = screenX + screenY;
  const isoY = -screenX + screenY;
  
  // Normalize and scale
  const magnitude = Math.sqrt(isoX * isoX + isoY * isoY);
  const dx = Math.round((isoX / magnitude) * distance);
  const dy = Math.round((isoY / magnitude) * distance);
  
  return sendMoveRaw(dx, dy);
}

/**
 * Stop current movement
 * @returns {boolean} Success
 */
export function stopMovement() {
  const packet = new Uint8Array([0x01, 0x8B, 0x01]);
  return poe2.sendPacket(packet);
}

// Convenience functions for common directions
export const moveNorth = (d = 100) => move('n', d);
export const moveSouth = (d = 100) => move('s', d);
export const moveEast = (d = 100) => move('e', d);
export const moveWest = (d = 100) => move('w', d);
export const moveNE = (d = 100) => move('ne', d);
export const moveNW = (d = 100) => move('nw', d);
export const moveSE = (d = 100) => move('se', d);
export const moveSW = (d = 100) => move('sw', d);

// ============================================================================
// SKILL CASTING
// ============================================================================
// Skill packet format (for position-targeted skills):
// [0-1]   Opcode: 01 84
// [2]     Flag: 01
// [3]     Type: 85 (skill) vs 20 (move)
// [4]     Skill ID: 00, 01, 02... (capture via packet viewer)
// [5-6]   Flags: 00 40
// [7]     Flag: 04
// [8]     Extra flag: 00 or 01 (varies by skill)
// [9]     Flag: FF
// [10]    Flag: 00
// [11-14] Delta X (big-endian signed int32)
// [15-18] Delta Y (big-endian signed int32)
//
// Skill IDs are per-character and must be captured manually via packet viewer.
// ============================================================================

const SKILL_PACKET_PREFIX = [
  0x01, 0x84,  // Opcode
  0x01,        // Flag
  0x85,        // Skill type marker
];

/**
 * Cast a skill at a position (relative to player)
 * @param {number} skillId - Skill ID (0-255, capture via packet viewer)
 * @param {number} deltaX - X delta in isometric coords
 * @param {number} deltaY - Y delta in isometric coords
 * @param {number} extraFlag - Extra flag byte (0x00 or 0x01, default 0x00)
 * @returns {boolean} Success
 */
export function castSkillAtPosition(skillId, deltaX, deltaY, extraFlag = 0x00) {
  const packet = new Uint8Array([
    ...SKILL_PACKET_PREFIX,
    skillId & 0xFF,           // Skill ID
    0x00, 0x40,               // Flags
    0x04,                     // Flag
    extraFlag & 0xFF,         // Extra flag (0x00 or 0x01)
    0xFF,                     // Flag
    0x00,                     // Flag
    ...int32ToBytesBE(deltaX),
    ...int32ToBytesBE(deltaY)
  ]);
  return poe2.sendPacket(packet);
}

/**
 * Cast a skill in a named direction
 * @param {number} skillId - Skill ID (0-255)
 * @param {string} direction - Direction: n, s, e, w, ne, nw, se, sw
 * @param {number} distance - Distance (default 100, max ~500)
 * @returns {boolean} Success
 */
export function castSkill(skillId, direction, distance = 100) {
  const dir = DIRECTIONS[direction.toLowerCase()];
  if (!dir) {
    console.error(`[Movement] Unknown direction: ${direction}`);
    return false;
  }
  
  const [xMult, yMult] = dir;
  let dx, dy;
  
  if (xMult !== 0 && yMult !== 0) {
    const scaledDist = Math.round(distance * 0.707);
    dx = xMult * scaledDist;
    dy = yMult * scaledDist;
  } else {
    dx = xMult * distance;
    dy = yMult * distance;
  }
  
  return castSkillAtPosition(skillId, dx, dy);
}

// Known skill IDs (captured manually - update as needed)
// Format: SKILL_NAME: packetSkillId
export const KNOWN_SKILLS = {
  // Example - update with your character's skills:
  // LIGHTNING_ARROW: 0,
  // POISON_BURST: 1,
  // TOXIC_GROWTH: 2,
  // GAS_CLOUD_ARROW: 3,
  // POISON_VINE_ARROW: 6,
};

console.log("[Movement] Module loaded (with skill casting)");


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

// NEW move protocol (patch 2026-06): opcode 00 63 — a grid-space HEADING (unit direction), NOT a bounded
// delta. The player walks that way CONTINUOUSLY until the next packet or a stop. Confirmed live.
//   Move (10B): 00 63 01 | dirX (s16 LE) | dirY (s16 LE) | 00 00 00     dir = grid unit vector * 32767
//   Stop ( 8B): 00 63 01 00 00 00 00 00                                  (zero heading)
//   dirX -> +gridX, dirY -> +gridY (direct grid-space, NO isometric conversion).
// (Old 01 90 / 29 09 fixed BE-int32-delta format died in the patch -> instant DC.)

function s16le(v) { const u = ((Math.round(v) | 0) & 0xFFFF) >>> 0; return [u & 0xFF, (u >> 8) & 0xFF]; }
// The game's direction encoding is non-obvious and my computed values DC (0x7FFF is out of range; the
// magnitudes don't fit Euclidean OR max-norm). So quantize to the 4 EXACT captured byte-pairs per grid
// quadrant -> can't DC (they're the game's own bytes). Crude (4 screen-dirs, staircases) until the exact
// formula is RE'd. Captured: +axis = 80 7F (0x7F80), -axis = BF 81 (0x81BF).
//   grid(+X,-Y)=80 7F BF 81 [RIGHT], (-X,-Y)=BF 81 BF 81 [DOWN], (+X,+Y)=80 7F 80 7F [UP], (-X,+Y)=BF 81 80 7F [LEFT]
// The packet can only encode 4 grid-DIAGONAL directions (each axis +/-full = screen up/down/left/right).
// A pure grid-CARDINAL heading (= a screen DIAGONAL, e.g. grid -Y) is unreachable in one packet -- it
// requires ALTERNATING two diagonals (a staircase). The old sign-commit version drove straight into walls
// and oscillated. So we DITHER (Bresenham): commit the dominant axis, dither the weaker axis sign across
// successive packets so the time-average equals the true heading. Uses ONLY the 4 captured packets (no DC).
let _dthX = 0, _dthY = 0, _lastKey = '';
function buildMovePacket(dirGX, dirGY) {
  // Reset the dither accumulators whenever the heading's SHAPE changes (which axis dominates, or either
  // sign). A stale fraction from the previous heading would otherwise fire a wrong-way packet on the first
  // tick of a new heading -- and at ~140ms continuous, that half-step is a chunk of the wobble.
  const _domX = Math.abs(dirGX) >= Math.abs(dirGY);
  const _key = (_domX ? 'X' : 'Y') + (dirGX >= 0 ? '+' : '-') + (dirGY >= 0 ? '+' : '-');
  if (_key !== _lastKey) { _dthX = 0; _dthY = 0; _lastKey = _key; }
  let sx, sy;
  if (Math.abs(dirGX) >= Math.abs(dirGY)) {
    sx = dirGX >= 0 ? 1 : -1;                                   // dominant axis: committed
    const ratio = Math.abs(dirGX) < 1e-6 ? 0 : dirGY / Math.abs(dirGX); // -1..1
    _dthY += (ratio + 1) / 2;
    if (_dthY >= 1) { sy = 1; _dthY -= 1; } else { sy = -1; }   // weaker axis: dithered
  } else {
    sy = dirGY >= 0 ? 1 : -1;
    const ratio = dirGX / Math.abs(dirGY);
    _dthX += (ratio + 1) / 2;
    if (_dthX >= 1) { sx = 1; _dthX -= 1; } else { sx = -1; }
  }
  const X = sx >= 0 ? [0x80, 0x7F] : [0xBF, 0x81];
  const Y = sy >= 0 ? [0x80, 0x7F] : [0xBF, 0x81];
  return new Uint8Array([0x00, 0x63, 0x01, X[0], X[1], Y[0], Y[1], 0x00, 0x00, 0x00]);
}

/**
 * Convert signed int32 to big-endian byte array (kept for compat; no longer used by the move packet)
 */
export function int32ToBytesBE(value) {
  const unsigned = value >>> 0;
  return [(unsigned >> 24) & 0xFF, (unsigned >> 16) & 0xFF, (unsigned >> 8) & 0xFF, unsigned & 0xFF];
}

/**
 * Send a grid-space movement HEADING. (dirGX, dirGY) is a direction in GRID space (e.g. target - player);
 * magnitude is ignored (normalized). Player walks that way until the next heading or stopMovement().
 */
export function sendMoveGridDir(dirGX, dirGY) {
  return poe2.sendPacket(buildMovePacket(dirGX, dirGY));
}

/**
 * Back-compat shim: (deltaX, deltaY) treated as a heading direction (magnitude ignored).
 */
export function sendMoveRaw(deltaX, deltaY) {
  return sendMoveGridDir(deltaX, deltaY);
}

/**
 * Direction mappings to isometric deltas
 * Distance is applied as the magnitude
 */
export const DIRECTIONS = {
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
  // NEW stop: a zero-heading 00 63 packet (old 01 97 01 died in the patch).
  return poe2.sendPacket(new Uint8Array([0x00, 0x63, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]));
}

// CLICK-TO-MOVE: 0xA3 move action carrying a GRID-space DELTA (target - player). The game pathfinds to (player + delta)
// = collision-aware routing, no wall-jab / dither yoyo. Frame REBUILT 2026-06-28 from a live in-game click-to-move
// capture (two clicks, NW gave +27,+24 / SE gave -27,-27 -> signed BE i32 delta):
//   01 A3 01 20 00 29 09 04 00 FF 00 | dx (BE i32) | dy (BE i32)   (19 bytes)
// (The old SpikenQOL frame -- C2 66 04 02 FF 08 + entId + absolute coords, 23 bytes -- was wrong for this patch and
// DESYNCED the stream.) Magnitude clamped to the old max-effective range. INERT unless in-game Move = Mouse.
export function sendBotMoveTo(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  let mx = Math.round(dx), my = Math.round(dy);
  const mag = Math.hypot(mx, my);
  if (mag > 500) { mx = Math.round(mx / mag * 500); my = Math.round(my / mag * 500); }
  mx |= 0; my |= 0;
  const ok = poe2.sendPacket(new Uint8Array([
    0x01, 0xA3, 0x01, 0x20, 0x00, 0x29, 0x09, 0x04, 0x00, 0xFF, 0x00,
    (mx >> 24) & 0xFF, (mx >> 16) & 0xFF, (mx >> 8) & 0xFF, mx & 0xFF,
    (my >> 24) & 0xFF, (my >> 16) & 0xFF, (my >> 8) & 0xFF, my & 0xFF,
  ]));
  // RELEASE/COMMIT: the 01AB (8B, constant) that FOLLOWED each captured click. Without it the move never settles --
  // the player walks toward the point but won't commit/stop -> overshoots + yoyos over items + "no progress" on far
  // targets (the pickit break). This is the move's "mouse-up" = finish the path + stop on arrival.
  try { poe2.sendPacket(new Uint8Array([0x01, 0xAB, 0x01, 0x20, 0x00, 0x29, 0x09, 0x00])); } catch (e) {}
  return ok;
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
// [0-1]   Opcode: 01 90
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
  0x01, 0x90,  // Opcode
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


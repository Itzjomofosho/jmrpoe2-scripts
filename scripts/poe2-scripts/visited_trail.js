/**
 * visited_trail.js — VISITED TRAIL (coarse traversed-ground occupancy) (mapper split, Phase 1).
 *
 * Owns the walked-ground state; mapper's resume envelope rides trailSerialize/trailRestore/trailReset
 * (the navSerialize/navRestore wiring). Bus pattern: never imports mapper — log arrives via
 * trailConfigure({ log }).
 */

let _log = (msg) => { try { console.log(`[Mapper] ${msg}`); } catch (_) {} };
export function trailConfigure(bus) { if (bus && typeof bus.log === 'function') _log = bus.log; }

// Per-map record of ground the player ACTUALLY WALKED (distinct from fog-revealed). Coarse 16u cells keyed
// cx*4096+cy, value = last-walk timestamp. Feeds SOFT + RELATIVE anti-backtrack scoring in the explore pickers
// (TRAIL_BIAS_ON const -- user: always on, no setting; the pickers compute, LOG and BIAS toward less-walked ground).
// Recording is unconditional but behavior-inert. Kept SEPARATE from markFrontierVisited's reveal grid by design:
// never cross-feed -- over-stamping a reveal grid starved the frontier picker (roadmap conflict #1).
export const visitedTrail = new Map();       // cx*4096+cy -> Date.now() of last walk
const TRAIL_CELL = 16;                       // grid units per cell
const TRAIL_CAP = 4096;                      // hard entry cap; overflow drops the oldest HALF (median compaction)
let _trailPrevCX = NaN, _trailPrevCY = NaN;  // previous recorded cell (segment start); reset per map
function _trailKey(cx, cy) { return cx * 4096 + cy; }
function _trailStampCell(cx, cy, now) {      // 3x3 neighborhood (~one corridor width) around (cx,cy)
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) visitedTrail.set(_trailKey(cx + dx, cy + dy), now);
}
function _trailEvict() {
  if (visitedTrail.size <= TRAIL_CAP) return;
  // Overflow is rare (~1500 entries/map typical). One compaction: drop every cell at/below the median last-walk time.
  const ts = [];
  for (const t of visitedTrail.values()) ts.push(t);
  ts.sort((a, b) => a - b);
  const cutoff = ts[ts.length >> 1];
  for (const [k, t] of visitedTrail) if (t <= cutoff) visitedTrail.delete(k);
}
export function trailRecord(gx, gy) {
  if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
  const cx = Math.floor(gx / TRAIL_CELL), cy = Math.floor(gy / TRAIL_CELL);
  const now = Date.now();
  if (!Number.isFinite(_trailPrevCX)) { _trailStampCell(cx, cy, now); _trailPrevCX = cx; _trailPrevCY = cy; _trailEvict(); return; }
  // Bresenham-lite over cell space prev->current: a dodge roll between two 7Hz passes displaces a few cells, so
  // stamp the connecting segment (<=6 steps, cap bounds a teleport/area-seam), 3x3 per step. Worst case 6*9=54 sets.
  const ddx = cx - _trailPrevCX, ddy = cy - _trailPrevCY;
  const steps = Math.min(6, Math.max(Math.abs(ddx), Math.abs(ddy)));
  if (steps === 0) { _trailStampCell(cx, cy, now); }
  else for (let i = 1; i <= steps; i++) {
    _trailStampCell(Math.round(_trailPrevCX + (ddx * i) / steps), Math.round(_trailPrevCY + (ddy * i) / steps), now);
  }
  _trailPrevCX = cx; _trailPrevCY = cy;
  _trailEvict();
}
export function trailHas(gx, gy) {
  return visitedTrail.has(_trailKey(Math.floor(gx / TRAIL_CELL), Math.floor(gy / TRAIL_CELL)));
}
// Fraction of <=12 evenly-spaced samples on a straight segment that land on walked cells (0..1).
export function trailLineFrac(x0, y0, x1, y1) {
  if (!visitedTrail.size) return 0;
  const n = 12;
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    if (trailHas(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) hit++;
  }
  return hit / n;
}
// Fraction of a waypoint route (macroPathTo/findPathBFS return {x,y}) on walked cells, sampled at stride len/32 (<=32).
export function trailWalkedFrac(route) {
  if (!route || !route.length || !visitedTrail.size) return 0;
  const stride = Math.max(1, Math.floor(route.length / 32));
  let hit = 0, tot = 0;
  for (let i = 0; i < route.length; i += stride) {
    const p = route[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    tot++;
    if (trailHas(p.x, p.y)) hit++;
  }
  return tot ? hit / tot : 0;
}
export const TRAIL_BIAS_ON = true;   // USER: anti-backtrack is ALWAYS on, no setting. Flip here only for an emergency rollback.
let _trailPatrolLogAt = 0;

// TRAIL consumer 4: choose the next discover-patrol spoke ANGLE. BIAS OFF -> +1.7 rad exactly as before (byte-parity)
// plus a shadow wf log. BIAS ON -> rotate up to one full turn, skipping walked-heavy spokes (lineFrac>0.6); take the
// first fresh spoke, else the least-walked seen. Returns the chosen angle; the caller rebuilds the spoke endpoint.
export function trailNextPatrolAng(player, now, ang) {
  if (!TRAIL_BIAS_ON) {
    const na = ang + 1.7;
    if (visitedTrail.size && now - _trailPatrolLogAt > 4000) {
      _trailPatrolLogAt = now;
      const ex = player.gridX + Math.cos(na) * 350, ey = player.gridY + Math.sin(na) * 350;
      _log(`[Trail] discover patrol wf=${trailLineFrac(player.gridX, player.gridY, ex, ey).toFixed(2)} (shadow)`);
    }
    return na;
  }
  let bestAng = ang + 1.7, bestLf = Infinity, a = ang;
  const STEPS = Math.ceil((Math.PI * 2) / 1.7) + 1;   // one full rotation of 1.7-rad spokes
  for (let s = 0; s < STEPS; s++) {
    a += 1.7;
    const ex = player.gridX + Math.cos(a) * 350, ey = player.gridY + Math.sin(a) * 350;
    const lf = trailLineFrac(player.gridX, player.gridY, ex, ey);
    if (lf < bestLf) { bestLf = lf; bestAng = a; }
    if (lf <= 0.6) { bestAng = a; bestLf = lf; break; }   // fresh enough -> take it (least-walked never penalized)
  }
  if (now - _trailPatrolLogAt > 4000) { _trailPatrolLogAt = now; _log(`[Trail] discover patrol wf=${bestLf.toFixed(2)} bias`); }
  return bestAng;
}

// ===== resume-envelope hooks (mirror navSerialize/navRestore — mapper's serializeMapState/applyMapState ride these).
const MAP_STATE_TRAIL_CAP = 20000;   // serialization cap for visitedTrail (drop oldest by ts); in-memory TRAIL_CAP is far below this

// Envelope content unchanged: [ [cellKey, ts] ... ], insertion order when under the cap, else most-recent-first slice.
export function trailSerialize() {
  if (visitedTrail.size <= MAP_STATE_TRAIL_CAP) { const a = []; try { for (const [k, v] of visitedTrail) a.push([k, v]); } catch (_) {} return a; }
  return Array.from(visitedTrail.entries()).sort((a, b) => b[1] - a[1]).slice(0, MAP_STATE_TRAIL_CAP);  // keep the most-recent
}
export function trailRestore(arr) {
  let n = 0;
  if (Array.isArray(arr)) {
    for (const p of arr) if (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) { visitedTrail.set(p[0], p[1]); n++; }
    _trailPrevCX = NaN; _trailPrevCY = NaN;   // drop the segment anchor so the first post-resume record doesn't draw a line across the map
  }
  return n;
}
export function trailReset() {
  visitedTrail.clear(); _trailPrevCX = NaN; _trailPrevCY = NaN;   // per-map: forget walked-ground occupancy + segment anchor
}

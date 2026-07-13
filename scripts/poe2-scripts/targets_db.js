/**
 * targets_db.js — TGT-tile target database + boss-arena tile matching (mapper split, Phase 1).
 *
 * Pure poe2 reads only: the per-area TGT pattern DB, the densest-cluster math, and the getTgtLocations
 * pattern-match core of getBossArenaCentroid. The mapper keeps its thin per-area cache + retry-throttle
 * wrapper; this module holds no cache and never imports mapper (bus pattern — no mapper state needed here).
 */

import { poe2 } from './poe2_cache.js';

// ============================================================================
// TGT-TILE TARGET DATABASE (ExileCore2 "Radar" method, adopted 2026-07-02)
// ----------------------------------------------------------------------------
// poe2.getTgtLocations() returns { locations: { "<full tile path>": [{x,y},...] } } for the CURRENT area. exCore2's
// Radar matches those tile paths (regex) against a per-area targets.json to KNOW where the boss/content is from
// map-entry, then routes DIRECTLY there (no blind exploration -> no yoyo). Schema mirrors exCore2/Radar/targets.json:
// keyed by area RawName (we key by lowercased areaId), each { boss:[patterns], <content>:[patterns] } where a pattern
// is a regex tested against the tile path. '_default' = generic fallback used when a map has no curated entry.
// PROVEN LIVE 2026-07-02 (Cenotes): "Metadata/Terrain/Maps/Cenotes/Tiles/CenotesArena01.tdt" = 144-tile boss arena
// cluster @~(1150,2130). PoE2 endgame arenas are consistently named "<Map>Arena<NN>", so the generic 'Arena\d' +
// densest-cluster isolates the real arena from stray matches (the false-positive worry the old strict list avoided).
// TODO: add per-map curated entries as we dump getTgtLocations on each map (the exCore2 instance-dumper approach).
export const TARGETS_DB = {
  // 'Arena[_-]?\d' not 'Arena\d': SpringArena_01 (separator before the digit) matched NOTHING -> centroid cached
  // false -> boss-direct blind all map (live-proven 2026-07-11; the earlier "fix" patched the || fallback below,
  // which is dead code because THIS entry always supplies boss patterns).
  '_default': { boss: ['Arena[_-]?\\d', 'BossArena', 'pillararena', 'arenatransition', 'pinnacle', 'tower_beacon'] },
  'mapcenotes': { boss: ['CenotesArena'] },
  // Channel's arena (boss_01.arm, room_tag map_boss) is built from map-LOCAL re-skins of the Maraketh Arena
  // kit -- Maps/Channel/Tiles/{CentrePattern,SidePattern,diagpattern}_01.tdt (repoe-fork/poe2 graph dump;
  // absent from fill_tiles, so the cluster IS the arena). No 'Arena'/'boss' in those paths -> invisible to
  // the _default patterns (belief NONE + FIGHTING_BOSS never armed, live-proven on MapChannel).
  'mapchannel': { boss: ['Channel/Tiles/(Centre|Side|diag)Pattern'] },
};

// Densest-cluster center of tile positions (robust to stray matched tiles). Picks the point with the most neighbors
// within `radius`, then averages all points within `radius` of it. For a SINGLE boss arena this returns its true
// center (K-Means would split one blob into k sub-clusters -> off-center); for stray-polluted matches it isolates the
// real (densest) arena. O(n^2) but n is small (~150 arena tiles) and the result is cached per area. -> {x,y,size}|null.
export function densestClusterCenter(points, radius) {
  const n = points.length;
  if (n === 0) return null;
  // extent = max point-to-center distance within the cluster (arena-shell rung-2 radius input; additive, ignored elsewhere).
  if (n <= 2) { let sx = 0, sy = 0; for (const p of points) { sx += p.x; sy += p.y; } const mx = sx / n, my = sy / n; let ext = 0; for (const p of points) { const e = Math.hypot(p.x - mx, p.y - my); if (e > ext) ext = e; } return { x: mx, y: my, size: n, extent: ext }; }
  const r2 = radius * radius;
  let bestI = 0, bestCount = -1;
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let j = 0; j < n; j++) { const dx = points[i].x - points[j].x, dy = points[i].y - points[j].y; if (dx * dx + dy * dy <= r2) c++; }
    if (c > bestCount) { bestCount = c; bestI = i; }
  }
  const cx = points[bestI].x, cy = points[bestI].y;
  let sx = 0, sy = 0, cnt = 0;
  for (let j = 0; j < n; j++) { const dx = points[j].x - cx, dy = points[j].y - cy; if (dx * dx + dy * dy <= r2) { sx += points[j].x; sy += points[j].y; cnt++; } }
  const mx = sx / cnt, my = sy / cnt;
  let ext = 0;
  for (let j = 0; j < n; j++) { const dx = points[j].x - cx, dy = points[j].y - cy; if (dx * dx + dy * dy <= r2) { const e = Math.hypot(points[j].x - mx, points[j].y - my); if (e > ext) ext = e; } }
  return { x: mx, y: my, size: cnt, extent: ext };
}

// getBossArenaCentroid's tile-matching core (the mapper keeps the per-area cache + ~1s retry throttle around it).
// Returns undefined while terrain/TGTs are not ready (caller retries), else {gx,gy,extent,size} | null (computed).
export function matchBossArenaTiles() {
  const t = poe2.getTgtLocations();
  if (!t || !t.isValid || !t.locations) return undefined;   // terrain not ready yet
  const L = t.locations;
  // ExileCore2 Radar method: match this area's BOSS tile patterns (curated TARGETS_DB entry -> generic _default)
  // against the TGT tile paths, collect positions, take the DENSEST cluster = the real arena. The old /boss/-only
  // match missed every "<Map>Arena<NN>" tile (e.g. CenotesArena01) -> null -> blind-explore yoyo. We still UNION the
  // legacy /boss/ match so maps whose arena tiles literally contain "boss" keep working.
  let ai = ''; try { ai = ((poe2.getAreaInfo() || {}).areaId || '').toLowerCase(); } catch (e) {}
  const entry = TARGETS_DB[ai] || TARGETS_DB['_default'];
  // 'Arena[_-]?\d': SpringArena_01 (underscore variant) matched NOTHING under the old 'Arena\d' -> centroid
  // cached false -> boss-direct blind -> the whole session blind-explored PAST the arena (live-proven 2026-07-11:
  // 81 SpringArena_01 tiles at (3611,437), macroPathTo route 35 legs, and the bot walked west).
  const pats = (entry && entry.boss) || ['Arena[_-]?\\d'];
  let rx = null; try { rx = new RegExp(pats.join('|'), 'i'); } catch (e) {}
  const pts = [];
  for (const k in L) {
    if (rx ? (!rx.test(k) && !/boss/i.test(k)) : !/boss/i.test(k)) continue;
    const a = L[k];
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i].x) < 40 && Math.abs(a[i].y) < 40) continue;   // skip origin-junk tiles (unstreamed -> (0,0))
      pts.push(a[i]);
    }
  }
  const cl = densestClusterCenter(pts, 130);   // ~130u ~ one arena footprint; isolates the real arena from strays
  return cl ? { gx: cl.x, gy: cl.y, extent: cl.extent, size: cl.size } : null;   // extent -> arena-shell rung-2 radius; size -> the navigator's tiles=N belief log (both additive)
}

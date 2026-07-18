/**
 * navigator.js — THE NAVIGATOR (EXPLORE-REDESIGN 26A+26B, TASK-39)
 *
 * One loop: model -> objective -> plan -> execute legs -> event-driven re-plan.
 * Owns the "where do I walk when exploring" DECISION for FINDING_BOSS frames (mapper flips it in behind
 * NAV_ON). Never sends movement — the mapper's walker/senders execute the returned waypoint; dodge/MB/OB/
 * content yields sit on top unchanged.
 *
 * Module #1 of the mapper split. mapper.js imports this file; the navigator never imports mapper — every
 * piece of mapper state it needs arrives through the bus passed to navConfigure() (bus pattern).
 *
 * WORLD MODEL (per map, the sidecar payload via navSerialize/navRestore):
 *  - boss belief   : arena tgt-centroid > BossRoom marker > stored ckpt > radar. Side-effect-free tiers;
 *                    deliberately NOT resolveBossBearing — its landmark/hint fallbacks are nav targets, not
 *                    boss knowledge, and consuming them here would let a content marker impersonate the boss.
 *                    Persists once resolved (survives marker de-stream + reload).
 *  - frontier      : unexplored buckets clustered into connected REGIONS (chunk explore — commit one region,
 *                    drain it below a threshold, then pick the next, forward/nearest).
 *  - POIs          : filtered quest markers + pending contentQueue entries (stepping-stone destinations).
 *                    TASK-38 sleeping-entity feed inserts via navAddPoi().
 *  - BLOCKED EDGES : permanent-for-the-map connectivity facts written by stuck legs / partial routes.
 *                    Never a TTL ban that gets re-learned from another angle.
 *
 * OBJECTIVE: exactly ONE committed destination, chosen by ONE scoring function over
 * {boss belief, POIs, frontier regions}, with hysteresis (a challenger must beat the incumbent by a margin
 * on 2 consecutive evaluations). Completion/invalidation switches immediately.
 *
 * PLAN: waypoint route computed ONCE on commit — PRIMARY router = poe2.radarFindPath (RadarV2's full-res,
 * fog-independent, elevation-correct overlay grid: the drawn yellow line), macro tile graph as fallback and
 * sole author of unroutability facts (NAV_RADAR_ROUTE_ON). RE-PLAN ONLY ON EVENTS:
 * leg stuck (blocked edge recorded first), objective completed/invalidated, off-route after a preemption,
 * chunk step (region entry reached, more mass remains), restore. Never per-tick.
 *
 * TASK-44: (A2) belief-NONE + a MapBoss objective -> low-confidence bearing from the largest
 * revealed-but-unvisited region (a DIRECTION bias on explore scoring, never a boss commit); (B) LARGE
 * revealed-but-unvisited areas ('rvisit') are explore candidates — fog frontier alone is blind to a
 * radar-revealed wing the char never walked (fog + rvisit together = cover the whole map).
 */

import { POE2Cache, poe2 } from './poe2_cache.js';

// ---------------------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------------------
// TASK-40 flags — each independently rollback-able; both false (or an old DLL without the
// radarFindPath/getRadarPois bindings) = TASK-39 behavior byte-identical.
const NAV_RADAR_ROUTE_ON = true;     // PRIMARY router = poe2.radarFindPath (RadarV2's full-res overlay grid:
                                     // fog-independent + elevation-correct — the drawn yellow line). macroPathTo
                                     // stays the fallback AND the sole authority for unroutability facts.
const NAV_CKPT_ANCHOR_ON = true;     // radar checkpoints/waypoints = proven-walkable POIs + region entry anchors
const NAV_CKPT_ENTRY_EXTRA_U = 150;  // anchor within regionDisc+this of the chunk center counts as its entry door

// TASK-44 flags — each independently rollback-able; all off = TASK-40 behavior byte-identical.
const NAV_VISIT_REVEALED_ON = true;  // B: LARGE revealed-but-unvisited areas become 'rvisit' explore candidates
const NAV_BOSS_FALLBACK_ON = true;   // A2: belief NONE + MapBoss objective exists -> low-conf bearing from the
                                     //     largest revealed-unvisited region (direction bias only, conf 0.5 <
                                     //     NAV_BOSS_CONF_MIN so it can never be committed as the destination)
const NAV_RV_SCAN_MS = 4000;         // revealed-unvisited lattice rebuild cadence
const NAV_RV_PITCH_U = 96;           // lattice probe spacing (isWalkable ~0.1us/probe on the cached grid)
const NAV_RV_MAX_PROBES = 5000;      // probe budget per rebuild; pitch widens to fit oversized maps
const NAV_RV_PTS_CAP = 512;          // clustering input cap (stride-subsampled, cell weight scaled back up)
const NAV_RV_MIN_CELLS = 8;          // region needs >= this many (weighted) lattice cells...
const NAV_RV_MIN_SPAN_U = 200;       // ...AND a bbox minor span >= this (kills walked-corridor edge slivers)
const NAV_RV_REACH_U = 90;           // arrival radius: reaching the region rep point completes the visit
const K_RV_CELL_MASS = 25;           // lattice cell -> fog-mass equivalent (scored via K_REGION_MASS, same cap)
const K_BOSS_DIR = 150;              // low-conf boss bearing: region/rvisit candidates toward it gain dot*this
const NAV_REGION_COOLDOWN_MS = 25000;// C: a departed region's disc is score-penalized this long (0 = off)
const K_REGION_COOL_PEN = 350;       // ...by this much (soft: a lone candidate still commits, no stall)

// TASK-50 flag — false = TASK-44 fact/veto behavior byte-identical. Covers the full-veto amnesty AND the
// radar route-around (fact bypass). The fact-earning steal guard below rides NAV_ON itself (nav off =
// navigator unused), not this flag.
const NAV_FACT_AMNESTY_ON = true;
const NAV_STEAL_FACT_MS = 5000;      // leg-stuck fact withheld if movement was stolen within this window
                                     // (stuck convictions build over 8-9s; the Mire false fact fired 3.9s
                                     // after the last observable steal signal — 5s covers it with margin)
const NAV_AMNESTY_EXEMPT_MS = 300000;// a fact re-earned 2x after amnesty is amnesty-exempt this long
                                     // (bounds the suspend/re-earn oscillation: it is probably a real wall)

// TASK-78 flag — false = entry-pick behavior byte-identical (greedy nearest, re-picked from scratch on
// every chunk step — the Creek A<->B door oscillator).
const NAV_ENTRY_COMMIT_ON = true;    // region entry DOOR commits: reused verbatim until consumed (reached /
                                     // revealed / anchor spent) or excluded (tried-doors route failure);
                                     // consumed doors sit out the rest of the commitment
const NAV_ENTRY_MATCH_U = 64;        // committed bucket door still "present" if a live bucket sits within this
const NAV_ENTRY_BACK_MULT = 0.3;     // re-pick hysteresis: a door behind the heading weighs d*(1 - this*dot)
                                     // (directly behind = 1.3x) — the lastHead rear-bias idiom, as a premium

const NAV_EVAL_MS = 2500;            // objective evaluation cadence while committed (nav-owned frames only)
const NAV_EVAL_EMPTY_MS = 800;       // retry cadence while UNcommitted (bounds route-call bursts at 7Hz)
const NAV_MIN_DWELL_MS = 4000;       // no hysteresis switch this soon after a commit (completion still switches)
const NAV_MODEL_BUCKETS_MS = 3000;   // frontier-region rebuild cadence (one getUnexploredBuckets + clustering)
const NAV_MODEL_POIS_MS = 2000;      // POI refresh cadence (one getQuestMarkers pass)
const NAV_MODEL_BOSS_MS = 3000;      // boss-belief refresh cadence
const NAV_LEG_SPACING_U = 80;        // plan legs downsampled from the macro route to ~this spacing
const NAV_LEG_REACH_U = 40;          // player within this of the current leg -> advance
const NAV_OFFROUTE_U = 180;          // player farther than this from the upcoming legs -> replan (preemption drag)
const NAV_EDGE_CELL_U = 48;          // blocked-edge/-cell quantization
const NAV_REGION_DISC_U = 350;       // "the chunk": disc around the committed region center for remaining-mass
const NAV_REGION_DONE_MASS = 120;    // remaining mass below max(this, frac*initial) -> region complete
const NAV_REGION_DONE_FRAC = 0.2;
const NAV_REGION_LINK_MULT = 2.1;    // buckets within pitch*this are the same connected region: joins diagonal
                                     // AND one-drained-bucket (2*pitch) gaps -- sibling blobs a bucket apart
                                     // share a chunk disc and must not trade the commit (live Channel: two
                                     // regions ~198u apart at pitch 112u oscillated). 3*pitch stays separate.
const NAV_POI_REACH_U = 90;          // POI objective complete radius (content/utility systems own the rest)
const NAV_POI_NEAR_SKIP_U = 110;     // a POI already this close is not an explore destination
const NAV_BOSS_REACH_U = 60;         // boss-belief objective complete radius
const NAV_BOSS_CONF_MIN = 0.7;       // belief below this is logged, never committed as the destination
const NAV_BOSS_SUPPRESS_MS = 45000;  // after reached/exhausted/3x-stuck: don't re-commit boss unless belief moves
const NAV_BOSS_MOVED_U = 120;        // belief moved this far -> suppression lifts / plan refreshes
const NAV_PLAN_SHORT_U = 150;        // macro route ending farther than this from the target = partial (fact)
const NAV_SWITCH_MARGIN = 40;        // hysteresis: challenger must beat incumbent by max(this, frac*|inc|)
const NAV_SWITCH_FRAC = 0.3;
const NAV_MAX_COMMIT_TRIES = 4;      // route attempts per evaluation before waiting for the next one
const NAV_BUCKET_CAP = 512;          // clustering input cap (logged when it truncates — no silent caps)
// Scoring — one scale for all candidate kinds (calibration rationale in TASK-39-REPORT):
const K_BOSS_BASE = 900;             // boss belief structurally dominates (plus 100*conf)...
const K_CONTENT_REQ = 1400;          // ...EXCEPT required-objective content (user ruling: "Complete all
                                     // Abysses -> any abyss u see, GO DO, FORCE IT" -- required content
                                     // outranks even the boss walk; boss last, per the standing model)
const K_CONTENT_BASE = 500;          // non-required active content: the preferred explore direction
const NAV_CONTENT_ENTER_U = 260;     // a content anchor only becomes a candidate beyond this...
const NAV_CONTENT_HANDOFF_U = 200;   // ...and the objective hands off to the arbiter lanes inside this
const K_POI_BASE = 380;              // a quest-marker destination generally beats a plain frontier region...
const K_REGION_MASS = 0.55;          // ...unless the region is big and close (mass capped at 900)
const K_REGION_MASS_CAP = 900;
const K_DIST = 0.22;                 // travel discount (grid units) for POI + region candidates
const K_TRAIL = 60;                  // walked-ground penalty (bus.trailLineFrac in [0,1]) — soft anti-backtrack
const K_REGION_BACK = 0.25;          // region behind the last committed heading loses dot*this*massTerm (soft)

// ---------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------
let bus = null;      // mapper accessors: { log, getArenaCentroid, getBossRoomMarker, getRadarBossTarget,
                     //   getStoredCkpt, bucketTouchesRevealed, trailLineFrac, trailHas, getContentQueue,
                     //   isRequiredType, mapObjectiveExists }

const model = {
  area: -1,             // POE2Cache.getAreaChangeCount() the model belongs to
  boss: null,           // { x, y, conf, src, tiles } | null — persists once resolved
  bossLogKey: '',       // last logged belief signature (src + coarse pos) — log on change only
  bossNoneAt: 0,        // throttle for the one-time NONE diagnostic
  bossNoneLogged: false,
  bossSuppressUntil: 0, // boss-candidate suppression (reached / corridor exhausted / 3x stuck)
  bossSuppressX: NaN, bossSuppressY: NaN,
  bucketsRaw: [],       // last getUnexploredBuckets snapshot (count>0 only) — remaining-mass source
  regions: [],          // [{ cx, cy, mass, n }] connected components of bucketsRaw
  bucketsAt: 0,
  pois: [],             // [{ x, y, key, kind }]
  ckptAnchors: [],      // [{ x, y, key, kind, name }] radar checkpoints/waypoints — proven-walkable
                        // network nodes (region entry anchors); re-read from the radar cache, never persisted
  poisAt: 0,
  bossAt: 0,
  blockedEdges: new Map(),   // "a|b" (cells, order-normalized) -> stuck count; the human-readable edge fact
  blockedCells: new Set(),   // wall-guess cells (edge midpoints) — the plan-time enforcement form of the fact
  unroutable: new Set(),     // target cells proven graph-unreachable / route-partial; permanent for the map
  poiDone: new Set(),        // POI keys reached/consumed as explore destinations this map
  extraPois: [],             // TASK-38 insertion point: navAddPoi() feed (sleeping-entity classification etc.)
  bucketCapLogged: false,
  rvBounds: null,            // { minX, minY, maxX, maxY } map tile extent (getTgtLocations, once per map)
  rvBoundsAt: 0,             // bounds retry throttle until terrain is readable
  rvRegions: [],             // [{ x, y, cells, span }] revealed-but-unvisited clusters, cells desc;
                             // x,y = walkable member point nearest the centroid (rep point, probe-proven)
  rvAt: 0,
  rvCapLogged: false,
  regionCooldown: [],        // [{ x, y, until }] departed region discs — score-penalized, not re-picked as
                             // instant siblings (the A<->B trade); expires, never a permanent fact
};

let objective = null;   // { kind:'boss'|'poi'|'region', key, x, y, rx, ry, initialMass, score, committedAt }
let plan = null;        // { legs:[{x,y}], legIdx, tx, ty, stuckN, builtAt, loggedLeg }
let lastEvalAt = 0;
let _evalBackoffUntil = 0;   // full-fail backoff: every candidate unroutable -> don't re-run the route burst at 800ms
let _frontierAmnestyAt = 0;  // throttle: clear stale region unroutable-bans when fog remains but every frontier was banned
const _regAmnesty = new Map();  // region cell key -> { grants, exemptUntil } — a region re-banned after 2 amnestied retries is amnesty-EXEMPT (Headland 21:44 patrol loop: amnesty↔honest-re-ban cycled the same 37s lap forever)
let _lastChunkStepAt = 0;    // chunk-step rate-limit: >1/s = a degenerate plan loop -> consume the region
let pendingChallenger = null;   // { key } — must win 2 consecutive evaluations
let lastHeadX = NaN, lastHeadY = NaN;   // unit heading of the last commit (forward/nearest next-chunk bias)
// TASK-50 fact-earning justice: when was movement last STOLEN from nav (bus signal or a nav-pass call gap).
// A stuck verdict this soon after a steal convicts contested frames, not a wall — the fact is withheld.
let _navTickAt = 0, _moveStolenAt = 0, _moveStolenWhy = '';
const _vetoCells = new Map();   // blocked-cell key -> vetoes in the current commit burst (amnesty denominator)
const _amnesty = new Map();     // cell key -> { reEarns, exemptUntil } — amnestied facts awaiting re-earn

function _log(msg) { try { if (bus && bus.log) bus.log(msg); else console.log('[Nav] ' + msg); } catch (_) {} }
function _r(v) { return Math.round(v); }
// Route-source tag for the commit/replan lines — only once the radar router is actually in play, so an
// old DLL (or NAV_RADAR_ROUTE_ON=false) keeps the TASK-39 log text byte-identical.
function _viaTag(via) { return (NAV_RADAR_ROUTE_ON && typeof poe2.radarFindPath === 'function') ? ` via ${via}` : ''; }

function _cellKey(x, y) { return Math.round(x / NAV_EDGE_CELL_U) + ':' + Math.round(y / NAV_EDGE_CELL_U); }
function _edgeKey(ax, ay, bx, by) {
  const a = _cellKey(ax, ay), b = _cellKey(bx, by);
  return a < b ? a + '|' + b : b + '|' + a;
}
// Record an impassability fact between two points: the edge (for logs/serialization) + the midpoint cell
// (what plan-time route checks can actually match — route waypoints never reproduce our exact endpoint pair).
function _recordBlocked(ax, ay, bx, by, why) {
  const ek = _edgeKey(ax, ay, bx, by);
  model.blockedEdges.set(ek, (model.blockedEdges.get(ek) || 0) + 1);
  const ck = _cellKey((ax + bx) / 2, (ay + by) / 2);
  model.blockedCells.add(ck);
  _log(`[Nav] blocked edge (${_r(ax)},${_r(ay)})-(${_r(bx)},${_r(by)}) recorded (${why}; ${model.blockedEdges.size} facts)`);
  // An amnestied fact that re-earns is evidence the wall is real; 2x re-earned = amnesty-exempt for a while
  // so a genuinely-blocked corridor can't oscillate suspend/re-earn forever.
  if (NAV_FACT_AMNESTY_ON) {
    const a = _amnesty.get(ck);
    if (a && ++a.reEarns >= 2) {
      a.exemptUntil = Date.now() + NAV_AMNESTY_EXEMPT_MS;
      a.reEarns = 0;
      _log(`[Nav] fact ${ck} re-earned 2x after amnesty -> amnesty-exempt ${(NAV_AMNESTY_EXEMPT_MS / 60000) | 0}min`);
    }
  }
}
// Does a route pass through a known-blocked cell? Samples each segment at ~half-cell steps so a coarse
// macro route can't step OVER a 48u fact.
function _routeCrossesBlocked(route) {
  if (!model.blockedCells.size) return null;
  for (let i = 1; i < route.length; i++) {
    const ax = route[i - 1].x, ay = route[i - 1].y, bx = route[i].x, by = route[i].y;
    const segLen = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(segLen / (NAV_EDGE_CELL_U / 2)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const ck = _cellKey(ax + (bx - ax) * t, ay + (by - ay) * t);
      if (model.blockedCells.has(ck)) return ck;
    }
  }
  return null;
}

export function navConfigure(b) { bus = b; }

// TASK-38 insertion point: external feeds (map-wide sleeping-entity classification) add explore POIs here.
export function navAddPoi(gx, gy, kind, key) {
  if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
  const k = key || ('x:' + Math.round(gx / 32) + ':' + Math.round(gy / 32));
  if (model.extraPois.some(p => p.key === k)) return;
  model.extraPois.push({ x: gx, y: gy, key: k, kind: kind || 'extra' });
}
// TASK-38 removal: the feed drops an anchor when its object is consumed/banned/name-excluded. extraPois only --
// poiDone stays authoritative for anchors already reached as explore destinations. Returns true if one was removed.
export function navRemovePoi(key) {
  if (!key) return false;
  const i = model.extraPois.findIndex(p => p.key === key);
  if (i < 0) return false;
  model.extraPois.splice(i, 1);
  return true;
}

function _resetModel(area, reason) {
  model.area = area;
  model.boss = null; model.bossLogKey = ''; model.bossNoneAt = 0; model.bossNoneLogged = false;
  model.bossSuppressUntil = 0; model.bossSuppressX = NaN; model.bossSuppressY = NaN;
  model.bucketsRaw = []; model.regions = []; model.bucketsAt = 0;
  model.pois = []; model.ckptAnchors = []; model.poisAt = 0; model.bossAt = 0;
  model.blockedEdges.clear(); model.blockedCells.clear(); model.unroutable.clear(); model.poiDone.clear();
  _regAmnesty.clear(); _frontierAmnestyAt = 0;   // region-amnesty ledger is per map
  model.extraPois = []; model.bucketCapLogged = false;
  model.rvBounds = null; model.rvBoundsAt = 0; model.rvRegions = []; model.rvAt = 0; model.rvCapLogged = false;
  model.regionCooldown = [];
  objective = null; plan = null; lastEvalAt = 0; pendingChallenger = null;
  lastHeadX = NaN; lastHeadY = NaN;
  _navTickAt = 0; _moveStolenAt = 0; _moveStolenWhy = '';
  _vetoCells.clear(); _amnesty.clear();
  if (reason) _log(`[Nav] model reset (${reason})`);
}

export function navReset(reason) { _resetModel(-1, reason || 'mapper reset'); }

// ---------------------------------------------------------------------------------------------------------
// World model refresh (throttled; all reads are ones the legacy stack already pays for)
// ---------------------------------------------------------------------------------------------------------
function _refreshBossBelief(player, now) {
  if (now - model.bossAt < NAV_MODEL_BOSS_MS) return;
  model.bossAt = now;
  let b = null;
  try { const c = bus.getArenaCentroid(); if (c && Number.isFinite(c.gx)) b = { x: c.gx, y: c.gy, conf: 0.9, src: 'arena_tgt', tiles: c.size || 0 }; } catch (_) {}
  if (!b) { try { const m = bus.getBossRoomMarker(); if (m && Number.isFinite(m.gx)) b = { x: m.gx, y: m.gy, conf: 0.85, src: 'bossroom-marker', tiles: 0 }; } catch (_) {} }
  if (!b) { try { const k = bus.getStoredCkpt(); if (k && Number.isFinite(k.x)) b = { x: k.x, y: k.y, conf: 0.85, src: 'boss-ckpt', tiles: 0 }; } catch (_) {} }
  if (!b) { try { const r = bus.getRadarBossTarget(); if (r && Number.isFinite(r.x) && (Math.abs(r.x) > 1 || Math.abs(r.y) > 1)) b = { x: r.x, y: r.y, conf: 0.8, src: 'radar', tiles: 0 }; } catch (_) {} }
  if (b) {
    model.boss = b;   // a resolved belief REPLACES; an unresolved pass KEEPS the old one (persists de-stream)
    const sig = b.src + ':' + Math.round(b.x / 50) + ':' + Math.round(b.y / 50);
    if (model.bossLogKey !== sig) {
      model.bossLogKey = sig;
      _log(`[Nav] boss belief: ${b.src} centroid=(${_r(b.x)},${_r(b.y)}) conf=${b.conf}${b.tiles ? ` tiles=${b.tiles}` : ''}`);
    }
    return;
  }
  // NONE diagnostic (the SpringArena_ lesson): a blind map must be visible in ONE line. One-time per map,
  // only once terrain is actually readable (getTgtLocations pre-terrain is a legitimate null, not blindness).
  // The rarest tile FAMILIES ride along: special rooms (arena/unique) are low-count families, so the line
  // itself names the TARGETS_DB candidates for the next pattern-miss map (Channel needed a live re-dump).
  if ((!model.boss || model.boss.src === 'revealed-unvisited') && !model.bossNoneLogged && now - model.bossNoneAt > 3000) {
    model.bossNoneAt = now;
    try {
      const t = poe2.getTgtLocations();
      if (t && t.isValid && t.locations) {
        model.bossNoneLogged = true;
        let fams = '';
        try {
          const cnt = new Map();
          for (const k in t.locations) {
            const stem = k.slice(k.lastIndexOf('/') + 1).replace(/_?\d*\.t[dg]t$/i, '').toLowerCase();
            cnt.set(stem, (cnt.get(stem) || 0) + ((t.locations[k] || []).length || 0));
          }
          fams = Array.from(cnt).sort((a, b) => a[1] - b[1]).slice(0, 8).map(([s, c]) => `${s}(${c})`).join(' ');
        } catch (_) {}
        _log(`[Nav] boss belief: NONE (patterns matched 0/${Object.keys(t.locations).length} tile keys; rarest families: ${fams})`);
      }
    } catch (_) {}
  }
  // A2 FALLBACK: a pattern miss must never fully blind us. The base-game objective bitfield knows a MapBoss
  // exists; the largest revealed-but-unvisited region is where an unfound boss must be (the Channel NW square:
  // radar-revealed, zero fog, zero trail). conf 0.5 < NAV_BOSS_CONF_MIN = a scoring DIRECTION bias, never a
  // commit target. Only installs over nothing or over itself — a persisted real belief is never downgraded.
  if (NAV_BOSS_FALLBACK_ON && (!model.boss || model.boss.src === 'revealed-unvisited') &&
      model.rvRegions.length && bus.mapObjectiveExists) {
    let hasBoss = false;
    try { hasBoss = !!bus.mapObjectiveExists('MapBoss'); } catch (_) {}
    if (hasBoss) {
      const rv = model.rvRegions[0];   // largest by weighted cells
      model.boss = { x: rv.x, y: rv.y, conf: 0.5, src: 'revealed-unvisited', tiles: rv.cells };
      const sig = 'rv:' + Math.round(rv.x / 50) + ':' + Math.round(rv.y / 50);
      if (model.bossLogKey !== sig) {
        model.bossLogKey = sig;
        _log(`[Nav] boss belief: revealed-unvisited fallback centroid=(${_r(rv.x)},${_r(rv.y)}) conf=0.5 cells=${rv.cells} (direction bias only)`);
      }
    }
  }
}

function _refreshRegions(player, now) {
  if (now - model.bucketsAt < NAV_MODEL_BUCKETS_MS) return;
  model.bucketsAt = now;
  if (typeof poe2.getUnexploredBuckets !== 'function') { model.bucketsRaw = []; model.regions = []; return; }
  let buckets = null;
  try { buckets = poe2.getUnexploredBuckets(8); } catch (_) { buckets = null; }
  const raw = [];
  if (buckets) for (const b of buckets) if (b && (b.count || 0) > 0 && Number.isFinite(b.x)) raw.push({ x: b.x, y: b.y, count: b.count || 0 });
  model.bucketsRaw = raw;
  let pts = raw;
  if (pts.length > NAV_BUCKET_CAP) {
    pts = pts.slice().sort((a, b) => b.count - a.count).slice(0, NAV_BUCKET_CAP);
    if (!model.bucketCapLogged) { model.bucketCapLogged = true; _log(`[Nav] bucket clustering capped at ${NAV_BUCKET_CAP} of ${raw.length} (largest kept)`); }
  }
  // Connected components: link = grid pitch (min pairwise distance) * mult, so orthogonal+diagonal neighbors
  // join regardless of the C++ bucket size. O(n^2) over <=512 pts at a 3s cadence — sub-ms.
  const n = pts.length;
  model.regions = [];
  if (!n) return;
  let pitch = Infinity;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
    if (d > 0.5 && d < pitch) pitch = d;
  }
  if (!Number.isFinite(pitch)) pitch = 64;
  const link2 = (pitch * NAV_REGION_LINK_MULT) ** 2;
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
    if (dx * dx + dy * dy <= link2) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
  }
  const acc = new Map();   // root -> {sx, sy, mass, n}
  for (let i = 0; i < n; i++) {
    const root = find(i), p = pts[i];
    let a = acc.get(root); if (!a) { a = { sx: 0, sy: 0, mass: 0, n: 0 }; acc.set(root, a); }
    a.sx += p.x * p.count; a.sy += p.y * p.count; a.mass += p.count; a.n++;
  }
  for (const a of acc.values()) {
    if (a.mass <= 0) continue;
    model.regions.push({ cx: a.sx / a.mass, cy: a.sy / a.mass, mass: a.mass, n: a.n });
  }
}

function _refreshPois(player, now) {
  if (now - model.poisAt < NAV_MODEL_POIS_MS) return;
  model.poisAt = now;
  const out = [];
  const seen = new Set();
  const add = (x, y, kind, key) => {
    const k = key || (Math.round(x / 32) + ':' + Math.round(y / 32));
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ x, y, key: k, kind });
  };
  try {
    for (const m of (poe2.getQuestMarkers() || [])) {
      const gx = m.gridX || 0, gy = m.gridY || 0;
      if ((!gx && !gy) || Math.hypot(gx, gy) < 40) continue;   // origin-junk
      // Same exclusions as the legacy landmark layer: spawn infrastructure is never a destination, and
      // done-state markers (beacon 38->994, verisium ->1000) persist after completion.
      if (/Checkpoint|Portal|Waypoint|TownPortal|\/Town|MapIntro/i.test(m.path || '')) continue;
      if (m.iconType === 994 || m.iconType === 1000) continue;
      // CONTENT markers are not explore POIs: a marker sitting on a contentQueue entry (abyss/breach/...)
      // is the same object the ARBITER drives -- through this door it re-created the poi ping-pong the
      // contentQueue removal was meant to kill (live Cliffside 19:23: abyss markers at (587,1300)/(610,1300)
      // outscored the committed east region every ~8s).
      let onContent = false;
      try {
        const cq = bus.getContentQueue();
        if (cq) for (const e of cq.values()) {
          if (e && Number.isFinite(e.gridX) && Math.hypot(e.gridX - gx, e.gridY - gy) < 60) { onContent = true; break; }
        }
      } catch (_) {}
      if (onContent) continue;
      add(gx, gy, 'marker');
    }
  } catch (_) {}
  // Radar checkpoints/waypoints: RadarV2's per-area transition cache — the game guarantees a real
  // walkable path to a checkpoint, so they are PROVEN network nodes in (usually) unexplored land.
  // Infrastructure, hence deliberately NOT run through the contentQueue filter above. 'transition'
  // and 'door' kinds are NEVER walk targets: a proximity area-transition can zone the char out of
  // the map (walk targets only — no teleports, no exits).
  model.ckptAnchors = [];
  if (NAV_CKPT_ANCHOR_ON && typeof poe2.getRadarPois === 'function') {
    try {
      for (const p of (poe2.getRadarPois() || [])) {
        if (!p || !Number.isFinite(p.x) || (p.kind !== 'checkpoint' && p.kind !== 'waypoint')) continue;
        if (Math.hypot(p.x, p.y) < 40) continue;   // origin-junk
        const k = 'ckpt:' + Math.round(p.x / 32) + ':' + Math.round(p.y / 32);
        model.ckptAnchors.push({ x: p.x, y: p.y, key: k, kind: p.kind, name: p.name || '' });
        add(p.x, p.y, p.kind, k);
      }
    } catch (_) {}
  }
  // NEAR contentQueue entries are NOT POIs (the arbiter owns them: route-insertion, [Ckpt] yields; feeding
  // them here made the explorer consume 87 known abysses as 90u-reach destinations = the Cliffside zigzag).
  // FAR ACTIVE entries ARE anchors (planner fix, Channel 20:52: an ACTIVE required abyss sat in the queue
  // while the nav explored fog by mass -- "didn't complete the abyss and screwing around"): walking TOWARD
  // outstanding content is what exploration is FOR; inside NAV_CONTENT_HANDOFF_U they vanish as candidates
  // and the arbiter's lanes take over (ins is small by then). kind 'content' scores K_CONTENT_BASE.
  try {
    const cq = bus.getContentQueue();
    if (cq) for (const e of cq.values()) {
      if (!e || e.state !== 'active') continue;
      if (!Number.isFinite(e.gridX) || !Number.isFinite(e.gridY)) continue;
      const k = 'cq:' + (e.type || 'c') + ':' + Math.round(e.gridX / 24) + ':' + Math.round(e.gridY / 24);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ x: e.gridX, y: e.gridY, key: k, kind: 'content', ctype: e.type || '' });
    }
  } catch (_) {}
  for (const p of model.extraPois) add(p.x, p.y, p.kind, p.key);
  model.pois = out;
}

// REVEALED-BUT-UNVISITED regions (TASK-44 B): the fog frontier only drives UNREVEALED ground, so a
// radar-revealed wing the char never walked (the Channel NW boss square) is invisible to explore. Lattice-
// probe the map extent: revealed = poe2.isWalkable (fog-gated grid), unvisited = no visited-trail cell
// (bus.trailHas) -> cluster like frontier regions. Budgeted: <= NAV_RV_MAX_PROBES isWalkable probes
// (~0.1us each) + one O(n^2) union-find over <= NAV_RV_PTS_CAP pts, every NAV_RV_SCAN_MS. Bounds come from
// the tile extent (getTgtLocations, ONE ~5.6ms read per map). Also feeds the A2 low-conf boss fallback.
function _refreshRvRegions(player, now) {
  if (!NAV_VISIT_REVEALED_ON && !NAV_BOSS_FALLBACK_ON) return;
  if (typeof poe2.isWalkable !== 'function' || !bus.trailHas) return;
  if (!model.rvBounds) {
    if (now - model.rvBoundsAt < 5000) return;
    model.rvBoundsAt = now;
    try {
      const t = poe2.getTgtLocations();
      if (!t || !t.isValid || !t.locations) return;   // terrain not ready — retry after the throttle
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const k in t.locations) {
        const a = t.locations[k];
        for (let i = 0; i < a.length; i++) {
          const p = a[i];
          if (Math.abs(p.x) < 40 && Math.abs(p.y) < 40) continue;   // origin-junk (unstreamed -> (0,0))
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
      }
      if (!Number.isFinite(minX) || maxX - minX < 100 || maxY - minY < 100) return;
      model.rvBounds = { minX, minY, maxX, maxY };
      _log(`[Nav] rv bounds (${_r(minX)},${_r(minY)})-(${_r(maxX)},${_r(maxY)})`);
    } catch (_) { return; }
  }
  if (now - model.rvAt < NAV_RV_SCAN_MS) return;
  model.rvAt = now;
  const bnd = model.rvBounds;
  let pitch = NAV_RV_PITCH_U;
  const area = (bnd.maxX - bnd.minX) * (bnd.maxY - bnd.minY);
  if (area / (pitch * pitch) > NAV_RV_MAX_PROBES) pitch = Math.ceil(Math.sqrt(area / NAV_RV_MAX_PROBES));
  let pts = [];
  try {
    for (let x = bnd.minX; x <= bnd.maxX; x += pitch) {
      for (let y = bnd.minY; y <= bnd.maxY; y += pitch) {
        if (!poe2.isWalkable(Math.floor(x), Math.floor(y))) continue;   // unrevealed / wall / margin
        if (bus.trailHas(x, y)) continue;                               // walked ground
        pts.push({ x, y });
      }
    }
  } catch (_) { return; }
  let weight = 1;
  if (pts.length > NAV_RV_PTS_CAP) {
    const stride = Math.ceil(pts.length / NAV_RV_PTS_CAP);
    const sub = [];
    for (let i = 0; i < pts.length; i += stride) sub.push(pts[i]);
    if (!model.rvCapLogged) { model.rvCapLogged = true; _log(`[Nav] rv clustering capped: ${pts.length} pts -> stride ${stride}`); }
    pts = sub; weight = stride;
  }
  model.rvRegions = [];
  const n = pts.length;
  if (!n) return;
  const link2 = (pitch * 1.6) ** 2;   // orthogonal + diagonal lattice neighbors join
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
    if (dx * dx + dy * dy <= link2) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
  }
  const acc = new Map();   // root -> { sx, sy, n, minX, minY, maxX, maxY, members }
  for (let i = 0; i < n; i++) {
    const root = find(i), p = pts[i];
    let a = acc.get(root);
    if (!a) { a = { sx: 0, sy: 0, n: 0, minX: p.x, minY: p.y, maxX: p.x, maxY: p.y, members: [] }; acc.set(root, a); }
    a.sx += p.x; a.sy += p.y; a.n++;
    if (p.x < a.minX) a.minX = p.x; if (p.x > a.maxX) a.maxX = p.x;
    if (p.y < a.minY) a.minY = p.y; if (p.y > a.maxY) a.maxY = p.y;
    a.members.push(p);
  }
  for (const a of acc.values()) {
    const cells = a.n * weight;
    const span = Math.min(a.maxX - a.minX, a.maxY - a.minY) + pitch;   // bbox minor span (1-row strip -> pitch)
    if (cells < NAV_RV_MIN_CELLS || span < NAV_RV_MIN_SPAN_U) continue;
    const cx = a.sx / a.n, cy = a.sy / a.n;
    let rep = a.members[0], repD = Infinity;   // rep = walkable member nearest the centroid (a raw centroid
    for (const m of a.members) {               // can land inside a wall on C-shaped regions)
      const d = Math.hypot(m.x - cx, m.y - cy);
      if (d < repD) { repD = d; rep = m; }
    }
    model.rvRegions.push({ x: rep.x, y: rep.y, cells, span });
  }
  model.rvRegions.sort((a, b) => b.cells - a.cells);
}

function _refreshModel(player, now) {
  const ac = POE2Cache.getAreaChangeCount();
  if (ac !== model.area) _resetModel(ac, model.area === -1 ? null : 'area change');
  _refreshRvRegions(player, now);   // before belief: the A2 fallback reads rvRegions
  _refreshBossBelief(player, now);
  _refreshRegions(player, now);
  _refreshPois(player, now);
}

// ---------------------------------------------------------------------------------------------------------
// Objective scoring + candidates
// ---------------------------------------------------------------------------------------------------------
function _trailFrac(px, py, x, y) {
  try { if (bus.trailLineFrac) return bus.trailLineFrac(px, py, x, y) || 0; } catch (_) {}
  return 0;
}

// A2: a LOW-confidence boss belief (the revealed-unvisited fallback) is a direction bias, not a destination —
// region/rvisit candidates toward it gain up to K_BOSS_DIR. Applied to candidates AND incumbents (asymmetry
// would churn commits). High-conf beliefs are boss candidates themselves; no bias needed.
function _bossDirBonus(px, py, tx, ty) {
  if (!NAV_BOSS_FALLBACK_ON || !model.boss || model.boss.conf >= NAV_BOSS_CONF_MIN) return 0;
  const bdx = model.boss.x - px, bdy = model.boss.y - py, bm = Math.hypot(bdx, bdy);
  const tdx = tx - px, tdy = ty - py, tm = Math.hypot(tdx, tdy);
  if (bm < 60 || tm < 1) return 0;
  const dot = (bdx / bm) * (tdx / tm) + (bdy / bm) * (tdy / tm);
  return dot > 0 ? K_BOSS_DIR * dot : 0;
}

// C: a departed region's disc is score-penalized for the cooldown — a soft "not immediately again", so the
// just-drained chunk's re-clustered sibling can't trade the commit, while a map whose ONLY candidate sits in
// the disc still commits it (no stall).
function _regionCoolPenalty(x, y, now) {
  if (!NAV_REGION_COOLDOWN_MS || !model.regionCooldown.length) return 0;
  for (const c of model.regionCooldown) {
    if (now < c.until && Math.hypot(x - c.x, y - c.y) < NAV_REGION_DISC_U) return K_REGION_COOL_PEN;
  }
  return 0;
}
function _stampRegionCooldown(x, y, why) {
  if (!NAV_REGION_COOLDOWN_MS || !Number.isFinite(x)) return;
  const now = Date.now();
  model.regionCooldown = model.regionCooldown.filter(c => c.until > now);
  model.regionCooldown.push({ x, y, until: now + NAV_REGION_COOLDOWN_MS });
  _log(`[Nav] region@(${_r(x)},${_r(y)}) disc cooldown ${(NAV_REGION_COOLDOWN_MS / 1000) | 0}s (${why})`);
}

function _bossSuppressed(now) {
  if (!model.boss) return true;
  if (now >= model.bossSuppressUntil) return false;
  // suppression is anchored to WHERE the belief was — a moved belief is new information, lift it
  if (Number.isFinite(model.bossSuppressX) &&
      Math.hypot(model.boss.x - model.bossSuppressX, model.boss.y - model.bossSuppressY) > NAV_BOSS_MOVED_U) return false;
  return true;
}
function _suppressBoss(now, why) {
  model.bossSuppressUntil = now + NAV_BOSS_SUPPRESS_MS;
  model.bossSuppressX = model.boss ? model.boss.x : NaN;
  model.bossSuppressY = model.boss ? model.boss.y : NaN;
  _log(`[Nav] boss objective suppressed ${(NAV_BOSS_SUPPRESS_MS / 1000) | 0}s (${why})`);
}

function _candidates(player, now) {
  const px = player.gridX, py = player.gridY;
  const cands = [];
  if (model.boss && model.boss.conf >= NAV_BOSS_CONF_MIN && !_bossSuppressed(now)) {
    cands.push({ kind: 'boss', key: 'boss', x: model.boss.x, y: model.boss.y, score: K_BOSS_BASE + 100 * model.boss.conf });
  }
  for (const p of model.pois) {
    if (model.poiDone.has(p.key) || model.unroutable.has(_cellKey(p.x, p.y))) continue;
    const d = Math.hypot(p.x - px, p.y - py);
    if (p.kind === 'content') {
      // ACTIVE contentQueue anchor: exploration's primary purpose is reaching these. Candidates only
      // beyond ENTER (near ones belong to the arbiter -- the Cliffside zigzag guard); REQUIRED-objective
      // types outrank everything incl. the boss walk (user: "GO DO, FORCE IT"; boss last). No trail
      // penalty on required -- walked ground is irrelevant when the map cannot complete without it.
      if (d < NAV_CONTENT_ENTER_U && !(objective && objective.key === 'poi:' + p.key)) continue;
      const req = !!(bus.isRequiredType && bus.isRequiredType(p.ctype));
      cands.push({ kind: 'poi', key: 'poi:' + p.key, x: p.x, y: p.y, ctype: p.ctype, content: true,
        score: (req ? K_CONTENT_REQ : K_CONTENT_BASE) - K_DIST * d
               - (req ? 0 : K_TRAIL * _trailFrac(px, py, p.x, p.y)) });
      continue;
    }
    if (d < NAV_POI_NEAR_SKIP_U) continue;   // already there — content/utility systems own it, not the explore
    cands.push({ kind: 'poi', key: 'poi:' + p.key, x: p.x, y: p.y,
      score: K_POI_BASE - K_DIST * d - K_TRAIL * _trailFrac(px, py, p.x, p.y) });
  }
  for (const rg of model.regions) {
    if (model.unroutable.has(_cellKey(rg.cx, rg.cy))) continue;
    // the committed chunk's own region (re-detected under a drifted centroid) is the incumbent, not a challenger
    if (objective && objective.kind === 'region' &&
        Math.hypot(rg.cx - objective.rx, rg.cy - objective.ry) < NAV_REGION_DISC_U) continue;
    const d = Math.hypot(rg.cx - px, rg.cy - py);
    const massTerm = K_REGION_MASS * Math.min(rg.mass, K_REGION_MASS_CAP);
    let score = massTerm - K_DIST * d - K_TRAIL * _trailFrac(px, py, rg.cx, rg.cy);
    if (Number.isFinite(lastHeadX) && d > 1) {   // forward/nearest next-chunk bias (soft — a lone rear region still wins)
      const dot = ((rg.cx - px) / d) * lastHeadX + ((rg.cy - py) / d) * lastHeadY;
      if (dot < 0) score += dot * K_REGION_BACK * massTerm;
    }
    score += _bossDirBonus(px, py, rg.cx, rg.cy) - _regionCoolPenalty(rg.cx, rg.cy, now);
    cands.push({ kind: 'region', key: 'region:' + Math.round(rg.cx / 128) + ':' + Math.round(rg.cy / 128),
      x: rg.cx, y: rg.cy, rx: rg.cx, ry: rg.cy, mass: rg.mass, score });
  }
  // TASK-44 B: LARGE revealed-but-unvisited areas — one-shot visit destinations (arrival completes them; the
  // trail then shrinks/splits the cluster on the next scan). Scored on the fog-region scale so they compete
  // with (not dominate) the frontier; the A2 direction bias is what tips the boss wing over near fog.
  if (NAV_VISIT_REVEALED_ON) for (const rv of model.rvRegions) {
    const key = 'rv:' + Math.round(rv.x / 192) + ':' + Math.round(rv.y / 192);
    if (model.poiDone.has(key) || model.unroutable.has(_cellKey(rv.x, rv.y))) continue;
    const d = Math.hypot(rv.x - px, rv.y - py);
    if (d < NAV_RV_REACH_U + 30) continue;   // standing in it — walking IS visiting
    const massTerm = K_REGION_MASS * Math.min(rv.cells * K_RV_CELL_MASS, K_REGION_MASS_CAP);
    let score = massTerm - K_DIST * d - K_TRAIL * _trailFrac(px, py, rv.x, rv.y);
    if (Number.isFinite(lastHeadX) && d > 1) {   // same soft rear bias as fog regions (no mid-run yanking back)
      const dot = ((rv.x - px) / d) * lastHeadX + ((rv.y - py) / d) * lastHeadY;
      if (dot < 0) score += dot * K_REGION_BACK * massTerm;
    }
    // Same departed-disc cooldown as fog regions: without it the B lane re-attracts to a just-explored
    // chunk via its unwalked pockets — the exact backtrack C exists to kill (candidates only; incumbents
    // are never penalized, same asymmetry as regions).
    score += _bossDirBonus(px, py, rv.x, rv.y) - _regionCoolPenalty(rv.x, rv.y, now);
    cands.push({ kind: 'rvisit', key, x: rv.x, y: rv.y, cells: rv.cells, score });
  }
  // FRONTIER AMNESTY (planner 2026-07-14, "WHY CAN'T U GO TO MASSIVE UNEXPLORED AREAS"): model.unroutable is
  // PERMANENT for the map, but a wall-slide stuck (a transient pathing failure on bridge/gap terrain, NOT true
  // unreachability) poisons a whole region's centre into it -- then every frontier region is skipped (line ~618)
  // and we report "no frontier regions" while huge fog remains. When NOTHING frontier-y survived the ban yet
  // regions/rvRegions DO exist, the bans are almost certainly stale: lift the REGION bans (not POIs) and rebuild.
  // A genuinely-walled region gets re-banned the honest way (chunk-step walk-stall), so this can't loop forever;
  // throttled 8s to avoid thrash. This is what lets the bot keep striking out for the big unexplored area.
  const _hasFrontier = cands.some(c => c.kind === 'region' || c.kind === 'rvisit');
  if (!_hasFrontier && (model.regions.length || model.rvRegions.length) && now - _frontierAmnestyAt > 8000) {
    _frontierAmnestyAt = now;
    // TWO-STRIKES EXEMPTION (Headland 21:44, three identical 37s patrol laps): "re-banned the honest way"
    // did NOT terminate -- amnesty lifted the same bans every lap. Mirror the fact-cell amnesty rule: a
    // region ban amnestied TWICE goes amnesty-exempt 5min (a genuinely-walled region burns its retries and
    // STAYS banned -> the frontier list empties honestly and nav concedes instead of patrolling).
    let _relaxed = 0, _exempt = 0;
    const _tryLift = (k) => {
      const a = _regAmnesty.get(k) || { grants: 0, exemptUntil: 0 };
      if (now < a.exemptUntil) { if (model.unroutable.has(k)) _exempt++; return; }
      if (model.unroutable.delete(k)) {
        _relaxed++; a.grants++;
        if (a.grants >= 2) a.exemptUntil = now + 300000;
        _regAmnesty.set(k, a);
      }
    };
    for (const rg of model.regions) _tryLift(_cellKey(rg.cx, rg.cy));
    for (const rv of model.rvRegions) _tryLift(_cellKey(rv.x, rv.y));
    if (_relaxed) {
      _log(`[Nav] frontier amnesty: ${_relaxed} region ban(s) cleared${_exempt ? ` (${_exempt} exempt -- retries burned)` : ''} (fog remains but all frontiers were banned) -> retry`);
      return _candidates(player, now);   // rebuild with the bans lifted (bounded: the 8s throttle blocks re-entry)
    }
    if (_exempt) _log(`[Nav] frontier amnesty exhausted: ${_exempt} region(s) burned their retries -> conceding the banned frontier`);
  }
  return cands;
}

function _regionRemainingMass() {
  if (!objective || objective.kind !== 'region') return 0;
  let m = 0;
  for (const b of model.bucketsRaw) if (Math.hypot(b.x - objective.rx, b.y - objective.ry) < NAV_REGION_DISC_U) m += b.count;
  return m;
}

// Current score of the INCUMBENT under the same function (distance/mass move as we walk/reveal).
function _incumbentScore(player) {
  if (!objective) return -Infinity;
  const px = player.gridX, py = player.gridY;
  if (objective.kind === 'boss') return model.boss ? K_BOSS_BASE + 100 * model.boss.conf : -Infinity;
  if (objective.kind === 'poi') {
    // SAME base as the candidate scoring (the region-asymmetry lesson): a committed content anchor keeps
    // its content/required base as incumbent, or any nearby marker legitimately outscores it mid-walk.
    const base = objective.content
      ? ((bus.isRequiredType && bus.isRequiredType(objective.ctype)) ? K_CONTENT_REQ : K_CONTENT_BASE)
      : K_POI_BASE;
    return base - K_DIST * Math.hypot(objective.x - px, objective.y - py);
  }
  if (objective.kind === 'rvisit') {
    // SAME basis as the candidate scoring (incl. the direction bias — asymmetry would let a challenger with
    // the bias dethrone an incumbent without it, then lose it, the churn the region lesson already paid for).
    let cells = 0;
    for (const rv of model.rvRegions) {
      if (Math.hypot(rv.x - objective.x, rv.y - objective.y) < NAV_REGION_DISC_U && rv.cells > cells) cells = rv.cells;
    }
    if (!cells) cells = objective.initialMass || 0;   // scan mid-refresh — hold the commit-time size
    return K_REGION_MASS * Math.min(cells * K_RV_CELL_MASS, K_REGION_MASS_CAP)
           - K_DIST * Math.hypot(objective.x - px, objective.y - py)
           + _bossDirBonus(px, py, objective.x, objective.y);
  }
  // SAME MASS BASIS as the candidate scoring: the committed region's WHOLE mass (re-identified in the live
  // clustering), not the 350u disc. The disc basis silently docked the incumbent ~200 points the moment it
  // committed, so nearby markers legitimately outscored it mid-walk -> the region<->poi ping-pong (live
  // Cliffside 19:23: commit 325-367, incumbent read 197-207, poi 296 wins twice, repeat). Disc mass stays
  // the COMPLETION measure only.
  let mass = 0;
  for (const rg of model.regions) {
    if (Math.hypot(rg.cx - objective.rx, rg.cy - objective.ry) < NAV_REGION_DISC_U && rg.mass > mass) mass = rg.mass;
  }
  if (mass <= 0) mass = _regionRemainingMass();   // region dissolved/re-clustered away -> the disc is what's left
  return K_REGION_MASS * Math.min(mass, K_REGION_MASS_CAP) - K_DIST * Math.hypot(objective.rx - px, objective.ry - py)
         + _bossDirBonus(px, py, objective.rx, objective.ry);
}

// ---------------------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------------------
function _regionEntryPoint(player, exclude) {
  // nearest remaining bucket in the chunk that borders REVEALED ground (something to expand from);
  // fall back to nearest remaining bucket, then the chunk center. Buckets at our feet (<55u) are excluded —
  // standing here IS revealing them, and a plan to one of them spends instantly (chunk-step churn).
  // `exclude` (cell keys): entries whose route already failed this build — a walled region gets approached
  // through its NEXT door instead of being abandoned (live Cliffside 19:27: the nearest entry sat behind the
  // real south wall; the NE approach was never tried -> region dropped -> poi noise. "Try a different door.")
  // PROVEN anchor first: a radar checkpoint/waypoint inside (or just outside) the committed chunk is a
  // game-guaranteed-walkable entry — prefer the nearest one over raw fog buckets. Anchors at our feet,
  // already consumed as POIs, or already-tried doors fall through to the bucket entries below.
  if (NAV_CKPT_ANCHOR_ON && model.ckptAnchors.length) {
    let bestA = null, bestAD = Infinity;
    for (const a of model.ckptAnchors) {
      if (Math.hypot(a.x - objective.rx, a.y - objective.ry) >= NAV_REGION_DISC_U + NAV_CKPT_ENTRY_EXTRA_U) continue;
      if (exclude && exclude.has(_cellKey(a.x, a.y))) continue;
      if (model.poiDone.has(a.key)) continue;
      const d = Math.hypot(a.x - player.gridX, a.y - player.gridY);
      if (d < 55) continue;
      const ed = _entryPickDist(player, a.x, a.y, d);
      if (ed < bestAD) { bestAD = ed; bestA = a; }
    }
    if (bestA) return { x: bestA.x, y: bestA.y, anchor: bestA };
  }
  let best = null, bestD = Infinity, bestAny = null, bestAnyD = Infinity;
  for (const b of model.bucketsRaw) {
    if (Math.hypot(b.x - objective.rx, b.y - objective.ry) >= NAV_REGION_DISC_U) continue;
    if (exclude && exclude.has(_cellKey(b.x, b.y))) continue;
    const d = Math.hypot(b.x - player.gridX, b.y - player.gridY);
    if (d < 55) continue;
    const ed = _entryPickDist(player, b.x, b.y, d);
    if (ed < bestAnyD) { bestAnyD = ed; bestAny = b; }
    let rev = true;
    try { if (bus.bucketTouchesRevealed) rev = !!bus.bucketTouchesRevealed(b.x, b.y); } catch (_) {}
    if (rev && ed < bestD) { bestD = ed; best = b; }
  }
  const p = best || bestAny;
  return p ? { x: p.x, y: p.y } : null;
}

// TASK-78 Part B: re-pick hysteresis — a door BEHIND the last committed heading pays a dot-proportional
// distance premium (directly behind = 1.3x), the same lastHead rear-bias idiom the region scorer uses.
// Near-equidistant front/back doors stop trading the lead; a lone rear door still wins (premium, not veto).
function _entryPickDist(player, x, y, d) {
  if (!NAV_ENTRY_COMMIT_ON || !Number.isFinite(lastHeadX) || d <= 1) return d;
  const dot = ((x - player.gridX) / d) * lastHeadX + ((y - player.gridY) / d) * lastHeadY;
  return dot < 0 ? d * (1 - NAV_ENTRY_BACK_MULT * dot) : d;
}

// TASK-78 Part A: sticky entry commit. The committed door (objective.entryX/Y) is reused VERBATIM while it
// is still a live target; a fresh pick happens only when it is consumed — reached (<55u), revealed/gone from
// the bucket set, anchor spent — or excluded (tried-doors route failure / unroutable fact, which route facts
// own; a successful build overwrites the commit with whatever door it actually planned to). Consumed doors
// are remembered on the objective (entryDone) so the next pick cannot bounce back to a reached door's
// half-drained leftovers — standing at a door does not always drain its bucket to zero (Creek: the exact
// bucket re-picked minutes after being reached), and that leftover is the A<->B oscillator.
function _regionEntry(player, exclude) {
  if (NAV_ENTRY_COMMIT_ON && objective && Number.isFinite(objective.entryX)) {
    const ex = objective.entryX, ey = objective.entryY;
    const ck = _cellKey(ex, ey);
    if (!(exclude && exclude.has(ck)) && !model.unroutable.has(ck)) {
      let live = null;
      let consumed = Math.hypot(ex - objective.rx, ey - objective.ry) >=
        NAV_REGION_DISC_U + (objective.entryAnchorKey ? NAV_CKPT_ENTRY_EXTRA_U : 0);
      if (!consumed) {
        if (objective.entryAnchorKey) {
          live = model.ckptAnchors.find(a => a.key === objective.entryAnchorKey) || null;
          if (!live || model.poiDone.has(objective.entryAnchorKey)) consumed = true;   // anchor spent/gone
        } else if (!model.bucketsRaw.some(b => Math.hypot(b.x - ex, b.y - ey) < NAV_ENTRY_MATCH_U)) {
          consumed = true;   // revealed / gone from the bucket set
        }
      }
      if (!consumed && Math.hypot(ex - player.gridX, ey - player.gridY) < 55) consumed = true;   // reached
      if (!consumed) return live ? { x: ex, y: ey, anchor: live } : { x: ex, y: ey };
      // door done -> sits out the rest of this commitment; pick the next one
      if (!objective.entryDone) objective.entryDone = new Set();
      objective.entryDone.add(ck);
      if (exclude) exclude.add(ck);
      objective.entryX = NaN; objective.entryY = NaN; objective.entryAnchorKey = null;
    }
  }
  return _regionEntryPoint(player, exclude);
}

// Build the waypoint plan for the current objective. true on success; 'unroutable' records the connectivity
// FACT (never re-learned); 'blocked' = route crosses a known blocked cell (candidate passed over this
// evaluation only — the macro router can't weight our graph edits, so we route around by choosing elsewhere).
function _buildPlan(player, now, event) {
  // Region objectives iterate ENTRY DOORS: a route that crosses a known wall or runs short tries the next
  // entry bucket (different approach bearing) before the region is given up — a walled chunk is usually
  // reachable from another side (the Cliffside NE approach). Non-region kinds have exactly one target.
  const _tried = new Set(NAV_ENTRY_COMMIT_ON && objective.kind === 'region' ? objective.entryDone : undefined);
  let tgt = null, route = null, end = null, short = 0, via = 'macro';
  for (let attempt = 0; attempt < 4; attempt++) {
    tgt = (objective.kind === 'region') ? _regionEntry(player, _tried) : { x: objective.x, y: objective.y };
    if (!tgt) break;   // region: no untried entries left
    // PRIMARY router: RadarV2's full-resolution overlay grid (the drawn yellow line) — fog-independent AND
    // elevation-correct where the macro tile graph is blind (the Cliffside south "corridor" that does not
    // connect). A null/short radar answer is NOT an unroutability fact (grid mid-build, flood cap, snap
    // miss) — fall through to macroPathTo, which keeps SOLE authority over the unroutable/short facts.
    route = null; via = 'macro';
    if (NAV_RADAR_ROUTE_ON && typeof poe2.radarFindPath === 'function') {
      let rr = null;
      try { rr = poe2.radarFindPath(Math.floor(player.gridX), Math.floor(player.gridY), Math.floor(tgt.x), Math.floor(tgt.y)); } catch (_) { rr = null; }
      if (rr && rr.length >= 2) {
        const re = rr[rr.length - 1];
        if (Math.hypot((re.x || 0) - tgt.x, (re.y || 0) - tgt.y) <= NAV_PLAN_SHORT_U) { route = rr; via = 'radar'; }
      }
    }
    if (!route) {
      if (typeof poe2.macroPathTo === 'function') {
        try { route = poe2.macroPathTo(Math.floor(player.gridX), Math.floor(player.gridY), Math.floor(tgt.x), Math.floor(tgt.y)); } catch (_) { route = null; }
      } else {
        route = [{ x: player.gridX, y: player.gridY }, { x: tgt.x, y: tgt.y }];   // pre-rebuild: straight legs, fine walker copes
        via = 'line';
      }
    }
    if (!route || route.length < 2) {
      model.unroutable.add(_cellKey(tgt.x, tgt.y));
      _log(`[Nav] target (${_r(tgt.x)},${_r(tgt.y)}) graph-unreachable -> recorded (${model.unroutable.size} facts)`);
      if (objective.kind !== 'region') return 'unroutable';
      _tried.add(_cellKey(tgt.x, tgt.y)); route = null; continue;
    }
    end = route[route.length - 1];
    short = Math.hypot((end.x || 0) - tgt.x, (end.y || 0) - tgt.y);
    if (short > NAV_PLAN_SHORT_U && objective.kind !== 'boss') {
      // partial corridor = the graph does not reach this target: a permanent fact, learned at PLAN time (zero walk)
      model.unroutable.add(_cellKey(tgt.x, tgt.y));
      _recordBlocked(end.x, end.y, tgt.x, tgt.y, `route ${_r(short)}u short`);
      if (objective.kind !== 'region') return 'unroutable';
      _tried.add(_cellKey(tgt.x, tgt.y)); route = null; continue;
    }
    const crosses = _routeCrossesBlocked(route);
    if (crosses && objective.kind !== 'boss') {
      // TASK-50 ROUTE-AROUND: the radar grid is full-res where the macro tile graph is coarse — it may
      // legitimately route AROUND a 48u fact the macro router can't weight. A radar route that reaches the
      // target AND is clean of every blocked cell replaces the veto; radar also crossing/failing keeps it.
      if (NAV_FACT_AMNESTY_ON && via !== 'radar' && typeof poe2.radarFindPath === 'function') {
        let rr = null;
        try { rr = poe2.radarFindPath(Math.floor(player.gridX), Math.floor(player.gridY), Math.floor(tgt.x), Math.floor(tgt.y)); } catch (_) { rr = null; }
        if (rr && rr.length >= 2 &&
            Math.hypot((rr[rr.length - 1].x || 0) - tgt.x, (rr[rr.length - 1].y || 0) - tgt.y) <= NAV_PLAN_SHORT_U &&
            !_routeCrossesBlocked(rr)) {
          route = rr; via = 'radar';
          end = rr[rr.length - 1];
          short = Math.hypot((end.x || 0) - tgt.x, (end.y || 0) - tgt.y);
          _log(`[Nav] plan for ${objective.key} via radar (fact bypass; cell ${crosses})`);
          break;   // usable route
        }
      }
      if (NAV_FACT_AMNESTY_ON) _vetoCells.set(crosses, (_vetoCells.get(crosses) || 0) + 1);
      if (objective.kind === 'region') {
        _log(`[Nav] entry (${_r(tgt.x)},${_r(tgt.y)}) route crosses blocked cell ${crosses} -> trying another door`);
        _tried.add(_cellKey(tgt.x, tgt.y)); route = null; continue;
      }
      _log(`[Nav] plan for ${objective.key} crosses blocked cell ${crosses} -> next candidate`);
      return 'blocked';
    }
    break;   // usable route
  }
  if (!route) {
    if (objective.kind === 'region') { _log(`[Nav] region ${objective.key}: every tried door walled/short -> next candidate`); return 'blocked'; }
    return 'unroutable';
  }
  if (short > NAV_PLAN_SHORT_U && objective.kind === 'boss') {
    _log(`[Nav] boss route partial (ends ${_r(short)}u short) -- walking the reachable corridor`);
  }
  const legs = [];
  let lx = route[0].x, ly = route[0].y;
  for (let i = 1; i < route.length - 1; i++) {
    if (Math.hypot(route[i].x - lx, route[i].y - ly) >= NAV_LEG_SPACING_U) {
      legs.push({ x: Math.round(route[i].x), y: Math.round(route[i].y) });
      lx = route[i].x; ly = route[i].y;
    }
  }
  legs.push({ x: Math.round(end.x), y: Math.round(end.y) });
  const keepStuckN = (plan && event === 'leg stuck') ? plan.stuckN : 0;
  plan = { legs, legIdx: 0, tx: Math.round(tgt.x), ty: Math.round(tgt.y), stuckN: keepStuckN, builtAt: now, loggedLeg: -1,
    via, anchorKey: (objective.kind === 'region' && tgt.anchor) ? tgt.anchor.key : null };
  if (NAV_ENTRY_COMMIT_ON && objective.kind === 'region') {
    // the door actually planned to IS the commitment (a tried-doors iteration replaces a failed one)
    objective.entryX = tgt.x; objective.entryY = tgt.y;
    objective.entryAnchorKey = tgt.anchor ? tgt.anchor.key : null;
  }
  if (plan.anchorKey) _log(`[Nav] entry ${tgt.anchor.kind}@(${plan.tx},${plan.ty})${tgt.anchor.name ? ` '${tgt.anchor.name}'` : ''}`);
  if (event) _log(`[Nav] replan (${event}) -> ${legs.length} legs to ${objective.kind}@(${plan.tx},${plan.ty})${_viaTag(via)}`);
  return true;
}

function _commit(cand, player, now, nCands) {
  objective = { kind: cand.kind, key: cand.key, x: cand.x, y: cand.y,
    rx: cand.rx !== undefined ? cand.rx : cand.x, ry: cand.ry !== undefined ? cand.ry : cand.y,
    initialMass: cand.mass || 0, score: cand.score, committedAt: now,
    content: !!cand.content, ctype: cand.ctype || '' };
  // DISC-SCOPE the region's initial mass: cand.mass is the WHOLE region, but completion measures inside the
  // 350u chunk disc -- for a region bigger than the disc, remaining < frac*whole held AT COMMIT (live
  // Cliffside 19:16: 'mass 533 < 1815' 3s after every commit of the same region = drop/recommit loop).
  // Drain-to-20% must compare disc against disc.
  if (cand.kind === 'region') objective.initialMass = _regionRemainingMass();
  if (cand.kind === 'rvisit') objective.initialMass = cand.cells || 0;   // incumbent-score fallback size
  const res = _buildPlan(player, now, null);
  if (res !== true) { objective = null; plan = null; return res; }
  const hd = Math.hypot(cand.x - player.gridX, cand.y - player.gridY);
  if (hd > 1) { lastHeadX = (cand.x - player.gridX) / hd; lastHeadY = (cand.y - player.gridY) / hd; }
  _log(`[Nav] objective ${cand.kind}@(${_r(cand.x)},${_r(cand.y)}) committed (score ${_r(cand.score)}, over ${nCands} candidates)${_viaTag(plan.via)}`);
  return true;
}

function _dropObjective(reason, forceEval) {
  if (objective) {
    _log(`[Nav] objective switch ${objective.kind}@(${_r(objective.x)},${_r(objective.y)}) -> (re-eval) (${reason})`);
    if (objective.kind === 'region') _stampRegionCooldown(objective.rx, objective.ry, reason);
  }
  objective = null; plan = null; pendingChallenger = null;
  if (forceEval) lastEvalAt = 0;
}

// ---------------------------------------------------------------------------------------------------------
// Evaluation: completion/invalidation first (immediate), then hysteresis, then commit when empty.
// ---------------------------------------------------------------------------------------------------------
function _evaluate(player, now) {
  // Immediate completion / invalidation checks are cheap arithmetic — every pass, not on the eval throttle.
  if (objective) {
    const dObj = Math.hypot(objective.x - player.gridX, objective.y - player.gridY);
    if (objective.kind === 'boss') {
      if (model.boss && Math.hypot(model.boss.x - objective.x, model.boss.y - objective.y) > NAV_BOSS_MOVED_U) {
        objective.x = model.boss.x; objective.y = model.boss.y;
        if (_buildPlan(player, now, 'boss belief moved') !== true) _dropObjective('moved belief unroutable', true);
      } else if (dObj < NAV_BOSS_REACH_U) {
        _suppressBoss(now, 'belief point reached, boss not engaged');
        _dropObjective('reached', true);
      }
    } else if (objective.kind === 'poi') {
      if (objective.content) {
        // HOLD the content anchor until its queue entry is actually GONE -- do NOT hand off on proximity.
        // The proximity handoff (drop at 200u, assume the arbiter grabs it) left the verisium between two
        // owners: nav let go, the arbiter (pinned to a done breach) never caught, nav re-picked a far region
        // and walked AWAY (live Channel 21:25 "skipped verisium, ran south"). Instead: keep DRIVING to the
        // content; the runner activates on arrival (as the breach just did), completes it, the entry leaves
        // the queue, and ONLY THEN do we drop -- no seam. `model.pois` no longer carrying this content key =
        // it completed/de-streamed (refreshed every NAV_MODEL_POIS_MS).
        if (model.poisAt > objective.committedAt && !model.pois.some(p => ('poi:' + p.key) === objective.key)) {
          _dropObjective('content serviced/gone', true);
        }
      } else if (dObj < NAV_POI_REACH_U) {
        model.poiDone.add(objective.key.slice(4)); _dropObjective('reached', true);
      } else if (model.poisAt > objective.committedAt && !model.pois.some(p => ('poi:' + p.key) === objective.key)) {
        model.poiDone.add(objective.key.slice(4));
        _dropObjective('marker gone', true);
      }
    } else if (objective.kind === 'rvisit') {
      if (dObj < NAV_RV_REACH_U) {
        model.poiDone.add(objective.key);   // one-shot: the visit happened; the trail shrinks the cluster
        _dropObjective('reached', true);
      } else if (model.rvAt > objective.committedAt &&
                 !model.rvRegions.some(rv => Math.hypot(rv.x - objective.x, rv.y - objective.y) < NAV_REGION_DISC_U)) {
        model.poiDone.add(objective.key);   // cluster dissolved/split away — nothing left here to visit
        _dropObjective('rv region dissolved', true);
      }
    } else if (objective.kind === 'region') {
      const remaining = _regionRemainingMass();
      const doneAt = Math.max(NAV_REGION_DONE_MASS, NAV_REGION_DONE_FRAC * (objective.initialMass || 0));
      if (model.bucketsAt > objective.committedAt && remaining < doneAt) {
        _dropObjective(`region explored (mass ${_r(remaining)} < ${_r(doneAt)})`, true);
      }
    }
  }

  if (now - lastEvalAt < (objective ? NAV_EVAL_MS : NAV_EVAL_EMPTY_MS)) return;
  lastEvalAt = now;
  const cands = _candidates(player, now);

  if (objective) {
    // Hysteresis: a challenger must beat the incumbent by a margin AND persist across 2 evaluations.
    if (now - objective.committedAt < NAV_MIN_DWELL_MS) { pendingChallenger = null; return; }
    const incScore = _incumbentScore(player);
    let best = null;
    for (const c of cands) if (c.key !== objective.key && (!best || c.score > best.score)) best = c;
    if (best && best.score > incScore + Math.max(NAV_SWITCH_MARGIN, NAV_SWITCH_FRAC * Math.abs(incScore))) {
      if (pendingChallenger && pendingChallenger.key === best.key) {
        _log(`[Nav] objective switch ${objective.kind}@(${_r(objective.x)},${_r(objective.y)}) -> ${best.kind}@(${_r(best.x)},${_r(best.y)}) (outscored ${_r(best.score)} > ${_r(incScore)} on 2 evals)`);
        if (objective.kind === 'region') _stampRegionCooldown(objective.rx, objective.ry, 'outscored');
        objective = null; plan = null; pendingChallenger = null;
        _commit(best, player, now, cands.length);
      } else {
        pendingChallenger = { key: best.key };
      }
    } else {
      pendingChallenger = null;
    }
    return;
  }

  // No objective -> commit the best routable candidate (route facts learned at plan time, zero walk wasted).
  if (now < _evalBackoffUntil) return;
  cands.sort((a, b) => b.score - a.score);
  if (NAV_FACT_AMNESTY_ON) _vetoCells.clear();   // burst-scoped: only this evaluation's vetoes count
  const tryCommitAll = () => {
    let tries = 0;
    for (const c of cands) {
      if (tries >= NAV_MAX_COMMIT_TRIES) break;
      tries++;
      if (_commit(c, player, now, cands.length) === true) return true;
    }
    return tries > 0 ? false : null;   // null = no candidates at all
  };
  const res = tryCommitAll();
  if (res === true) return;
  // TASK-50 VETO-STORM AMNESTY: every candidate vetoed and >=1 veto named a blocked-cell fact -> the
  // common-denominator fact(s) (most vetoes this burst) are SUSPENDED (re-earnable, see _recordBlocked)
  // and the burst re-runs NOW. A FALSE fact un-bricks the navigator in one cycle; a real wall re-earns
  // the fact within one leg. Never two consecutive full vetoes without an amnesty attempt.
  if (NAV_FACT_AMNESTY_ON && res === false && _vetoCells.size) {
    let max = 0;
    for (const [ck, n] of _vetoCells) {
      const a = _amnesty.get(ck);
      if (a && now < a.exemptUntil) continue;   // re-earned 2x — probably a real wall, not suspendable
      if (n > max) max = n;
    }
    if (max > 0) {
      for (const [ck, n] of _vetoCells) {
        if (n !== max) continue;
        const a = _amnesty.get(ck);
        if (a && now < a.exemptUntil) continue;
        model.blockedCells.delete(ck);
        if (!a) _amnesty.set(ck, { reEarns: 0, exemptUntil: 0 });
        _log(`[Nav] fact ${ck} caused a full veto -> amnesty (re-earnable)`);
      }
      _vetoCells.clear();
      if (tryCommitAll() === true) return;
    }
  }
  // Everything routable failed: identical retries at 800ms are a route-call burst producing identical logs
  // (live 19:32 spam). Facts only change by walking/revealing -- back off.
  _evalBackoffUntil = now + 4000;
  if (res !== null) _log('[Nav] all candidates unroutable -> backing off 4s');
}

// ---------------------------------------------------------------------------------------------------------
// Execution interface — the mapper's walker calls these; the navigator never moves anything itself.
// ---------------------------------------------------------------------------------------------------------

// The committed plan's current waypoint for the walker, with leg bookkeeping + event-driven replans.
// Returns { x, y, ox, oy, status } or null (no objective available — caller holds/tells the user).
export function navCurrentWaypoint(player, now) {
  if (!bus || !player || !Number.isFinite(player.gridX)) return null;
  // TASK-50 fact-earning justice (rides NAV_ON): track when movement was last stolen from nav. A call gap
  // >1s = another system owned the frames entirely (runnerSpanStolen's gap signal); the bus read covers
  // in-frame theft (dodge suppress, posture step in flight, a stronger MB writer, OB-paused content).
  // Old mapper without the accessor -> gap signal only, everything else unchanged.
  if (_navTickAt && now - _navTickAt > 1000) { _moveStolenAt = now; _moveStolenWhy = 'frame gap'; }
  _navTickAt = now;
  if (bus.navMoveStolen) {
    try { const w = bus.navMoveStolen(now); if (w) { _moveStolenAt = now; _moveStolenWhy = w; } } catch (_) {}
  }
  _refreshModel(player, now);
  // a restored objective arrives plan-less (routes are never persisted) — rebuild before evaluating
  if (objective && !plan) {
    if (_buildPlan(player, now, 'restored') !== true) _dropObjective('restored objective unroutable', true);
  }
  _evaluate(player, now);
  if (!objective || !plan) return null;

  const legs = plan.legs;
  while (plan.legIdx < legs.length &&
         Math.hypot(legs[plan.legIdx].x - player.gridX, legs[plan.legIdx].y - player.gridY) < NAV_LEG_REACH_U) {
    plan.legIdx++;
  }
  if (plan.legIdx >= legs.length) {
    // plan spent — resolve by objective kind so nothing re-commits a finished destination
    if (objective.kind === 'region') {
      // an anchor entry we actually reached is CONSUMED (poiDone): a stepping stone spends once —
      // without this the >55u filter re-admits it from the next entry and the chunk walk ping-pongs
      if (plan.anchorKey && Math.hypot(plan.tx - player.gridX, plan.ty - player.gridY) < 55) {
        model.poiDone.add(plan.anchorKey);
      }
      const doneAt = Math.max(NAV_REGION_DONE_MASS, NAV_REGION_DONE_FRAC * (objective.initialMass || 0));
      const entry = _regionEntryPoint(player);
      if (_regionRemainingMass() < doneAt) {
        _dropObjective('region explored (plan spent)', true);
        return null;
      }
      if (!entry) {   // no reachable entry left at all (all <55u or excluded) -> same as residual-at-feet
        model.unroutable.add(_cellKey(objective.rx, objective.ry));
        _dropObjective('region residual at feet', true);
        return null;
      }
      if (Math.hypot(entry.x - player.gridX, entry.y - player.gridY) < 55) {
        // everything left in the chunk is at our feet, just not ticked over in the reveal grid yet — record
        // the chunk as consumed so the next evaluation can't re-pick it (commit/drop churn)
        model.unroutable.add(_cellKey(objective.rx, objective.ry));
        _dropObjective('region residual at feet', true);
        return null;
      }
      // HARD rate-limit first: chunk-step more than once a second = a degenerate plan loop of ANY cause
      // (live Channel 20:53 + 21:01: frame-rate replans, zero movement). The chunk is not offering
      // walkable progress -- consume it, whatever the mechanism.
      if (now - _lastChunkStepAt < 1000) {
        model.unroutable.add(_cellKey(objective.rx, objective.ry));
        _dropObjective('region residual (chunk-step loop)', true);
        return null;
      }
      _lastChunkStepAt = now;
      if (_buildPlan(player, now, 'chunk step') !== true) { _dropObjective('chunk entry unroutable', true); return null; }
      // A chunk-step plan whose END is already at our feet is instantly spent -> chunk-step again -> a
      // frame-rate replan LOOP with zero movement (live Channel 20:53: the radar route to a fog bucket
      // snaps its end to the nearest walkable cell = right where we stand). Same verdict as residual-at-
      // feet: this chunk has nothing walkable left to offer -- consume it and move on.
      const _csEnd = plan.legs[plan.legs.length - 1];
      if (_csEnd && Math.hypot(_csEnd.x - player.gridX, _csEnd.y - player.gridY) < NAV_LEG_REACH_U + 5) {
        model.unroutable.add(_cellKey(objective.rx, objective.ry));
        _dropObjective('region residual at feet (chunk-step end at feet)', true);
        return null;
      }
    } else if (objective.kind === 'poi') {
      if (objective.content) {
        // arrived at the content: HOLD (no poiDone). The arbiter's runner owns the frame now (breach/verisium
        // /abyss activate on proximity); nav returns null so it stops driving, and evaluate() drops the anchor
        // when the queue entry actually leaves ('content serviced/gone'). Dropping here re-opened the seam.
        return null;
      }
      model.poiDone.add(objective.key.slice(4));
      _dropObjective('reached (plan spent)', true);
      return null;
    } else if (objective.kind === 'rvisit') {
      model.poiDone.add(objective.key);
      _dropObjective('reached (plan spent)', true);
      return null;
    } else {
      // boss: corridor end reached; if the boss were engaged the mapper's fast-paths would own the frame by now
      _suppressBoss(now, 'corridor end reached, boss not engaged');
      _dropObjective('boss corridor spent', true);
      return null;
    }
  }
  // preemption drag: far from every upcoming leg -> replan from here (objective unchanged — that is the point)
  let nearLeg = Infinity;
  for (let i = plan.legIdx; i < Math.min(plan.legIdx + 4, legs.length); i++) {
    const d = Math.hypot(legs[i].x - player.gridX, legs[i].y - player.gridY);
    if (d < nearLeg) nearLeg = d;
  }
  if (nearLeg > NAV_OFFROUTE_U) {
    if (_buildPlan(player, now, 'off-route (preemption end)') !== true) { _dropObjective('off-route replan failed', true); return null; }
  }
  const leg = plan.legs[plan.legIdx];
  if (plan.loggedLeg !== plan.legIdx) {
    plan.loggedLeg = plan.legIdx;
    _log(`[Nav] leg ${plan.legIdx + 1}/${plan.legs.length} -> (${leg.x},${leg.y})`);
  }
  const od = _r(Math.hypot(plan.tx - player.gridX, plan.ty - player.gridY));
  return { x: leg.x, y: leg.y, ox: plan.tx, oy: plan.ty,
    status: `Nav ${objective.kind} -> (${plan.tx},${plan.ty}) leg ${plan.legIdx + 1}/${plan.legs.length} (${od}u)` };
}

// Walker reported a stuck leg (incl. the dislodge watchdogs): write the blocked-edge FACT first, then replan.
export function navOnLegStuck(player, now) {
  if (!objective || !plan || !player) return;
  // The mapper's no-progress detector keys on the target NAME ('Nav Explore' for every nav plan), so its
  // clock stays HOT across objective switches and convicts a fresh plan instantly (live 19:32: a 'blocked
  // edge' recorded 0ms after commit, char never moved -> false fact poisoned every POI route). A plan the
  // char hasn't walked for 2.5s cannot be stuck — ignore the report entirely.
  if (now - plan.builtAt < 2500) return;
  const leg = plan.legs[Math.min(plan.legIdx, plan.legs.length - 1)];
  // A fight is not a wall: 8s of no-progress while the rotation is actively killing a pack wrote PERMANENT
  // facts that poisoned every route to the big region (live Cliffside 19:16 -- both 'blocked edges' landed
  // on 128-entity fight frames, then 'crosses blocked cell' starved the region drive: "why can't u go up").
  // Combat-born stucks still replan/count toward the 3x drop; only the PERMANENT fact is withheld.
  const _fighting = (now - (POE2Cache.lastRotationCastAt || 0)) < 2000;
  // TASK-50: STOLEN movement is not a wall either. The cast guard above only covers ACTIVE casting; the
  // Mire false fact fired 5.9s after the last cast while dodge/posture/an Elite writer had contested the
  // whole conviction window (the walker's no-progress clocks freeze on DODGE frames only). Only the
  // PERMANENT fact is withheld — replan + the 3x drop below still run.
  const _stolen = _moveStolenAt > 0 && now - _moveStolenAt < NAV_STEAL_FACT_MS;
  if (!_fighting && !_stolen) _recordBlocked(player.gridX, player.gridY, leg.x, leg.y, 'leg stuck');
  else if (_fighting) _log(`[Nav] leg stuck during combat -> replan only (no fact recorded)`);
  else _log(`[Nav] leg stuck during stolen movement (${_moveStolenWhy} ${now - _moveStolenAt}ms ago) -> replan only (no fact recorded)`);
  plan.stuckN++;
  if (plan.stuckN >= 3) {
    if (objective.kind === 'boss') _suppressBoss(now, '3x stuck on the corridor');
    // review #2 (commitment discipline): the PERMANENT unroutable ban must not be written from a conviction earned
    // while fighting or during stolen movement -- the same guard the blocked-edge fact above uses. Otherwise 3
    // combat-born stucks permanently, silently abandon a REACHABLE (often required) content anchor. In that case just
    // drop+replan; a genuinely-unreachable target still earns the ban on a later non-combat/non-stolen conviction.
    else if (!_fighting && !_stolen) model.unroutable.add(_cellKey(plan.tx, plan.ty));
    else _log(`[Nav] 3x stuck during ${_fighting ? 'combat' : 'stolen movement'} -> drop+replan only (no permanent unroutable ban)`);
    _dropObjective('3x leg stuck', true);
    return;
  }
  if (_buildPlan(player, now, 'leg stuck') !== true) _dropObjective('replan after stuck failed', true);
}

// ---------------------------------------------------------------------------------------------------------
// Sidecar persistence (rides mapper's map_state envelope — mapper gates identity/age)
// ---------------------------------------------------------------------------------------------------------
export function navSerialize() {
  const edges = []; for (const [k, v] of model.blockedEdges) edges.push([k, v]);
  return {
    boss: model.boss ? { x: model.boss.x, y: model.boss.y, conf: model.boss.conf, src: model.boss.src, tiles: model.boss.tiles || 0 } : null,
    blockedEdges: edges,
    blockedCells: Array.from(model.blockedCells),
    unroutable: Array.from(model.unroutable),
    poiDone: Array.from(model.poiDone),
    objective: objective ? { kind: objective.kind, key: objective.key, x: objective.x, y: objective.y,
      rx: objective.rx, ry: objective.ry, initialMass: objective.initialMass } : null,
    head: Number.isFinite(lastHeadX) ? { x: lastHeadX, y: lastHeadY } : null,
  };
}

// Restore into the fresh VM's empty model. Stamps the CURRENT area so the per-tick area guard doesn't wipe
// what we just restored (mapper's identity gate already proved we're in the same map). Returns a summary.
export function navRestore(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const now = Date.now();
  model.area = POE2Cache.getAreaChangeCount();
  if (payload.boss && Number.isFinite(payload.boss.x)) {
    model.boss = { x: payload.boss.x, y: payload.boss.y, conf: payload.boss.conf || 0.7, src: payload.boss.src || 'restored', tiles: payload.boss.tiles || 0 };
    model.bossLogKey = model.boss.src + ':' + Math.round(model.boss.x / 50) + ':' + Math.round(model.boss.y / 50);
    _log(`[Nav] boss belief: ${model.boss.src} centroid=(${_r(model.boss.x)},${_r(model.boss.y)}) conf=${model.boss.conf} (restored)`);
  }
  if (Array.isArray(payload.blockedEdges)) for (const p of payload.blockedEdges) if (Array.isArray(p) && p.length >= 2) model.blockedEdges.set(p[0], p[1]);
  if (Array.isArray(payload.blockedCells)) for (const k of payload.blockedCells) model.blockedCells.add(k);
  if (Array.isArray(payload.unroutable)) for (const k of payload.unroutable) model.unroutable.add(k);
  if (Array.isArray(payload.poiDone)) for (const k of payload.poiDone) model.poiDone.add(k);
  if (payload.head && Number.isFinite(payload.head.x)) { lastHeadX = payload.head.x; lastHeadY = payload.head.y; }
  if (payload.objective && Number.isFinite(payload.objective.x)) {
    const o = payload.objective;
    objective = { kind: o.kind, key: o.key, x: o.x, y: o.y, rx: o.rx, ry: o.ry,
      initialMass: o.initialMass || 0, score: 0, committedAt: now };
    plan = null;        // rebuilt on the first nav-owned frame ('restored' replan)
    lastEvalAt = now;   // hold the restored commitment through the first evaluation window
  }
  return `nav(edges=${model.blockedEdges.size}, facts=${model.unroutable.size}, obj=${objective ? objective.kind : 'none'})`;
}

/**
 * Map Content Tracker  (plugin id: map_content)
 *
 * Accumulates a map's content + per-instance completion from BASE-GAME data (no UI for the data):
 *   getAllEntities()      classify content instances by precise marker (Breach/Delirium/Abyss/
 *                         Expedition/Brequel/Checkpoint) + count Rare uniques
 *   0x33eea50 component   the per-instance objective tracker -> complete 0/1 (Expedition/Brequel/Checkpoint)
 *   objState bitfield     BASE-GAME per-TYPE present/complete (ig->+0x4e0->+0xd8->+424); the source the
 *                         UI "Map Content" panel merely RENDERS -- read it directly, not the widget tree
 *
 * Architecture (proves the "accumulate over streaming" model before we bake to C++):
 *   - keyed by mechanic + coarse grid-bucket (geographically fixed -> survives despawn/re-stream)
 *   - UPSERT-never-delete: an instance that streams out (or is consumed) stays in the list
 *   - complete LATCHES sticky (1 wins forever); area change (areaInstance) is the only wipe
 *   - transient mechs (Breach/Delirium/Abyss, no per-entity tracker): done from the base-game objState bit
 *
 * Disabled by default; enable in the Plugin Browser. Logs filtered by [MAPC].
 * NOTE: drawing markers on the map is intentionally NOT here yet (parked).
 */

const poe2 = new POE2();

// -- colors -------------------------------------------------------------------
const GREEN = [0.35, 1.0, 0.4, 1.0];
const RED   = [1.0, 0.45, 0.45, 1.0];
const GRAY  = [0.55, 0.55, 0.55, 1.0];
const CYAN  = [0.4, 0.8, 1.0, 1.0];
const YEL   = [1.0, 0.85, 0.3, 1.0];

// -- boss PATH (phase 1: routed path from player to the end boss, drawn radar-style) ----------
// The boss-arena terrain tile (getTgtLocations key matching /boss/) is present AT MAP ENTRY, so the
// boss location is known before any content streams. grid->world scale = 250/23 (matches worldX/gridX).
const SHOW_BOSS_LINE = true;
const GRID2WORLD = 250 / 23;
function makeABGR(r, g, b, a) { return ((Math.floor(a*255)<<24)|(Math.floor(b*255)<<16)|(Math.floor(g*255)<<8)|Math.floor(r*255)) >>> 0; }

// content-line colors (ABGR u32 for the ImGui foreground draw list)
const LINE_ORANGE = makeABGR(1.00, 0.55, 0.10, 0.95);  // boss path/marker
const LINE_YELLOW = makeABGR(1.00, 0.90, 0.20, 0.95);  // incursion (incomplete): Vaal Chest / Vaal Beacon
const LINE_PURPLE = makeABGR(0.72, 0.32, 1.00, 0.95);  // breach (placeholder; refined later)
const LINE_GRAY   = makeABGR(0.66, 0.66, 0.66, 0.90);  // delirium start mirror
const LINE_WHITE  = makeABGR(1, 1, 1, 1);

// -- config -------------------------------------------------------------------
const TRACKER_RVA = 0x33eea50;      // objective-tracker component vtable (gameBase-relative); complete = u32 @ +0x10
const BUCKET      = 8;              // grid tiles per identity bucket
const SCAN_MS     = 600;            // ~1.6 Hz (tune; juiced maps may want adaptive)
const NEAR_TILES  = 80;            // proximity for transient despawn -> consumed inference

// instance markers: [label, regex, field]  field = 'name' (entity.name) or 'base' (baseEntityPath)
const MARKERS = [
  ['Breach',     /breach_attachment/i,         'base'],
  ['Delirium',   /DeliriumInitiator/i,         'name'],
  ['Abyss',      /AbyssCrack/i,                'name'],
  ['Expedition', /Expedition2Encounter/i,      'name'],   // Verisium / Expedition2
  ['Brequel',    /Brequel\/BrequelInitiator/i, 'name'],   // "Stabilised Breach"
  ['Checkpoint', /Checkpoint_Endgame/i,        'name'],
];
const NOISE = /Intro|Spawner|Scatter|Decal|Remnant/i;     // sub-objects / intro NPCs

// BASE-GAME objective completion (the bitfield the UI panel renders -- NOT the widget tree). Validated live 2026-06-16.
//   objState = *( *( *(ig+0x4e0) + 0xd8 ) + 424 );  present = bits @objState+8807,  complete = bits @objState+8810
//   bit i indexes EndgameMapObjectives.dat row i (canonical 19-row table below).
// IMPORTANT: validate objState by its BITFIELD SHAPE (present!=0 && complete subset-of present), NOT by a hardcoded
//   vtable RVA -- that RVA drifts every game patch and silently broke this read once (0x3429110 -> 0x342a378).
const OBJ_NAMES = ['MapBoss','CorruptedNexus','Checkpoints','RareMonsters','Breach','Expedition',
  'Delirium','Ritual','Abyss','AbyssDepths','Shrines','Strongboxes','Essences','RogueExiles',
  'AzmeriSpirits','StoneCircles','Incursion','Expedition2','Breach2'];
// our entity-classifier label -> objState objective name (null = NOT an EndgameMapObjective, e.g. Brequel = optional extra)
const MECH_TO_OBJ = { Breach:'Breach', Delirium:'Delirium', Abyss:'Abyss', Expedition:'Expedition2', Checkpoint:'Checkpoints', Brequel:null };

// -- state --------------------------------------------------------------------
let acc      = new Map();   // key -> record
let areaGen  = 0;           // last getAreaInfo().areaInstance
let lastScan = 0;
let objs     = [];          // objectives present this map: [{idx,name,complete}]
let objDone  = {};          // objective name -> 0/1
let objSrc   = 'base-game'; // which source filled objs this scan ('base-game' | 'UI fallback')
let rareSeen = 0;           // lower bound of rare uniques seen
let _base    = 0;
let _bossGrid = null;       // cached boss source (grid space); reset on area change
let _bossGridTryAt = 0;     // throttle for the boss-source search (entity fallback)
let _bossPath = null, _bossPathTime = 0;   // cached routed path (grid waypoints) to the boss
let contentLineTargets = [];               // cached color-coded content-line targets (refreshed each scan)

function gbase() {
  if (_base) return _base;
  try { _base = Number(poe2.getNativeMapInfo().moduleBase); } catch (e) { _base = 0; }
  return _base;
}

// read the objective-tracker complete bit for a live entity; null if no tracker / unreadable
function readTracker(addr) {
  try {
    const base = gbase(); if (!base) return null;
    const T = base + TRACKER_RVA;
    const b = Number(Memory.readU64(addr + 0x10));
    const e = Number(Memory.readU64(addr + 0x18));
    if (!(b > 0x10000000000 && e >= b)) return null;
    for (let c = b; c < e && (c - b) < 200; c += 8) {
      const cp = Number(Memory.readU64(c));
      if (cp > 0x10000000000 && cp < 0x7ff000000000 && Number(Memory.readU64(cp)) === T) {
        const v = Number(Memory.readU32(cp + 0x10));
        return (v === 0 || v === 1) ? v : null;
      }
    }
  } catch (e) {}
  return null;
}

function mechOf(e) {
  const nm = e.name || '', bp = e.baseEntityPath || '';
  if (NOISE.test(nm) || NOISE.test(bp)) return null;
  for (let i = 0; i < MARKERS.length; i++) {
    const t = MARKERS[i][2] === 'base' ? bp : nm;
    if (MARKERS[i][1].test(t)) return MARKERS[i][0];
  }
  return null;
}

function keyFor(mech, gx, gy) { return mech + '@' + Math.round(gx / BUCKET) + ',' + Math.round(gy / BUCKET); }

// locate objState via either known chain, validated by BITFIELD SHAPE (build-independent -- no hardcoded vtable RVA,
// which drifts on game patches; also survives any per-map-type objState vtable variance).
function findObjState() {
  const r   = a => Number(Memory.readU64(a));
  const u32 = a => Number(Memory.readU32(a)) >>> 0;
  const ok  = a => a > 0x10000000000 && a < 0x7ff000000000;
  const ig  = Number(poe2.getInGameState()); if (!ig) return 0;
  const CHAINS = [[0x4e0, 0xd8], [0x2f0, 0x328]];   // A=base-game mgr, B=UI-root holder; both -> +424 = objState
  for (let i = 0; i < CHAINS.length; i++) {
    const m = r(ig + CHAINS[i][0]); if (!ok(m)) continue;
    const s = r(m + CHAINS[i][1]);  if (!ok(s)) continue;
    const os = r(s + 424);          if (!ok(os)) continue;
    // accept if the present/complete bitfields are self-consistent: present nonzero & complete subset-of present.
    let present, complete;
    try { present = u32(os + 8807) & 0x7FFFF; complete = u32(os + 8810) & 0x7FFFF; } catch (e) { continue; }
    if (present !== 0 && (complete & ~present) === 0) return os;
  }
  return 0;
}

// PRIMARY: base-game per-TYPE objective present/complete (the bitfield the UI renders). null if no chain validates.
function readObjState() {
  try {
    const os = findObjState(); if (!os) return null;   // chain/validation failed -> caller falls back to panel
    const present  = Number(Memory.readU32(os + 8807)) >>> 0;
    const complete = Number(Memory.readU32(os + 8810)) >>> 0;
    const out = [];
    for (let i = 0; i < OBJ_NAMES.length; i++)
      if (present & (1 << i)) out.push({ idx: i, name: OBJ_NAMES[i], complete: (complete & (1 << i)) ? 1 : 0 });
    return out;
  } catch (e) { return null; }
}

// FALLBACK: same objective ids straight off the panel (always correct -- it renders the same objState bits).
// Used ONLY when the base-game chain fails, so the plugin never shows blank while content is clearly present.
function objsFromPanel() {
  try {
    const mo = poe2.getMapObjectives();
    if (!mo || !mo.content) return null;
    return mo.content.map(c => ({ idx: -1, name: c.id, complete: c.isCompleted ? 1 : 0 }));
  } catch (e) { return null; }
}

// average of all "boss" tile coords from getTgtLocations() (GRID space) -> arena center. Terrain is static -> cache.
function bossCentroidGrid() {
  // 1) terrain boss-arena tile centroid -- present at entry on maps that have one (e.g. Bastille)
  try {
    const t = poe2.getTgtLocations();
    if (t && t.isValid && t.locations) {
      const L = t.locations; let sx = 0, sy = 0, n = 0;
      for (const k in L) { if (!/boss/i.test(k)) continue; const a = L[k]; for (let i = 0; i < a.length; i++) { sx += a[i].x; sy += a[i].y; n++; } }
      if (n) return { gx: sx / n, gy: sy / n, src: 'tile' };
    }
  } catch (e) {}
  // 2) fallback for tile-less maps (e.g. Trenches): nearest boss-room entity that streams in
  //    (Checkpoint_Endgame_Boss / BossArena objects). Lets the line show on every map once it's nearby.
  try {
    let px = 0, py = 0; try { const p = poe2.getLocalPlayer(); px = p.gridX; py = p.gridY; } catch (e) {}
    const all = poe2.getAllEntities() || [];
    let best = null, bestD = Infinity;
    for (let i = 0; i < all.length; i++) {
      const e = all[i]; const s = (e.name || '') + ' ' + (e.renderName || '');
      if (/Checkpoint_Endgame_Boss|BossArena|BossForceField|BossArenaLocker|BossArenaBlocker/i.test(s)) {
        const d = Math.hypot((e.gridX || 0) - px, (e.gridY || 0) - py);
        if (d < bestD) { bestD = d; best = e; }
      }
    }
    if (best) return { gx: best.gridX, gy: best.gridY, src: 'entity' };
  } catch (e) {}
  return null;
}

// ROUTED path player -> END BOSS, drawn radar-style. The boss-arena tile is in getTgtLocations AT ENTRY, and
// findPathBFS (radar's walkable grid) routes to it -> works from the very start and anywhere on the map.
function drawBossPath() {
  let lp; try { lp = poe2.getLocalPlayer(); } catch (e) { return; }
  if (!lp || lp.gridX == null) return;
  // resolve the boss source once (tile centroid, or a boss-room entity once it streams). Throttle the search.
  if (!_bossGrid) { const t0 = Date.now(); if (t0 - _bossGridTryAt > 800) { _bossGridTryAt = t0; _bossGrid = bossCentroidGrid(); } }
  if (!_bossGrid) return;
  const z = lp.worldZ || 0;
  // grid -> world: self-calibrate the scale from the player (robust), fall back to the 250/23 constant
  let k = GRID2WORLD;
  if (Math.abs(lp.gridX) > 50 && Math.abs(lp.gridY) > 50) k = (lp.worldX / lp.gridX + lp.worldY / lp.gridY) / 2;
  const dl = ImGui.getForegroundDrawList(); if (!dl) return;
  const ORANGE = LINE_ORANGE, WHT = LINE_WHITE;
  // routed path via the radar's BFS pathfinder; recompute ~1/s (distance field is cached per target)
  const now = Date.now();
  if (!_bossPath || now - _bossPathTime > 1000) {
    try { const p = poe2.findPathBFS(Math.floor(lp.gridX), Math.floor(lp.gridY), Math.floor(_bossGrid.gx), Math.floor(_bossGrid.gy)); if (p && p.length) _bossPath = p; } catch (e) {}
    _bossPathTime = now;
  }
  // draw the path polyline (downsampled, projected in ONE batched FFI call)
  try {
    if (_bossPath && _bossPath.length >= 2) {
      const step = Math.max(1, Math.floor(_bossPath.length / 150));
      const flat = [];
      for (let i = 0; i < _bossPath.length; i += step) { const wp = _bossPath[i]; if (wp && wp.x !== undefined) flat.push(wp.x * k, wp.y * k, z); }
      const proj = poe2.worldToScreenBatch(flat);
      if (proj) { let prev = null; for (let i = 0; i < proj.length; i++) { const s = proj[i]; if (s && prev) dl.addLine({ x: prev.x, y: prev.y }, { x: s.x, y: s.y }, ORANGE, 3); prev = s || null; } }
    } else {
      const ps = poe2.worldToScreen(lp.worldX, lp.worldY, z), b0 = poe2.worldToScreen(_bossGrid.gx * k, _bossGrid.gy * k, z);
      if (ps && b0) dl.addLine({ x: ps.x, y: ps.y }, { x: b0.x, y: b0.y }, ORANGE, 2.5);  // fallback: straight line
    }
  } catch (e) {}
  // boss marker + label, clamped into the viewport so it stays visible when the boss is off-screen
  const bs = poe2.worldToScreen(_bossGrid.gx * k, _bossGrid.gy * k, z);
  if (!bs) return;
  const dist = Math.round(Math.hypot(_bossGrid.gx - lp.gridX, _bossGrid.gy - lp.gridY));
  const vp = ImGui.getMainViewport();
  const ox = (vp && vp.pos) ? vp.pos.x : 0, oy = (vp && vp.pos) ? vp.pos.y : 0;
  const W = (vp && vp.size) ? vp.size.x : 1920, H = (vp && vp.size) ? vp.size.y : 1080;
  const mx = Math.max(ox + 24, Math.min(bs.x, ox + W - 24));
  const my = Math.max(oy + 24, Math.min(bs.y, oy + H - 24));
  const off = (mx !== bs.x) || (my !== bs.y);
  try { dl.addCircleFilled({ x: mx, y: my }, 7, ORANGE, 16); }
  catch (e) { dl.addLine({ x: mx-6, y: my }, { x: mx+6, y: my }, ORANGE, 3); dl.addLine({ x: mx, y: my-6 }, { x: mx, y: my+6 }, ORANGE, 3); }
  dl.addText("END BOSS  ~" + dist + (off ? "  (off-screen)" : ""), { x: mx + 11, y: my - 8 }, WHT);
}

// -- color-coded content lines (boss is drawn separately, in orange) --------------------------
// classify an entity into a content-line {color,label}, or null. INCURSION=yellow, BREACH=purple,
// DELIRIUM start=gray. Objective-complete gating is applied where targets are collected (scanAndMerge).
function classifyContentLine(e) {
  // esp.js already draws vaal/breach/incursion (its "other" category) -- so Map Content only adds what
  // esp does NOT: delirium. (The boss has its own orange line in drawBossPath.) One place per thing.
  const s = (e.name || '') + ' ' + (e.baseEntityPath || '') + ' ' + (e.renderName || '');
  if (/DeliriumInitiator|DeliriumMirror/i.test(s)) return { color: LINE_GRAY, label: 'Delirium' };
  return null;
}

// draw the cached content-line targets every frame (cheap: only worldToScreen per target; the entity
// scan + objective gate run in scanAndMerge). Off-screen targets clamp to the viewport edge + label.
function drawContentLines() {
  if (!contentLineTargets.length) return;
  let lp; try { lp = poe2.getLocalPlayer(); } catch (e) { return; }
  if (!lp || lp.worldX == null) return;
  const dl = ImGui.getForegroundDrawList(); if (!dl) return;
  const z = lp.worldZ || 0;
  const ps = poe2.worldToScreen(lp.worldX, lp.worldY, z); if (!ps) return;
  const vp = ImGui.getMainViewport();
  const ox = (vp && vp.pos) ? vp.pos.x : 0, oy = (vp && vp.pos) ? vp.pos.y : 0;
  const W = (vp && vp.size) ? vp.size.x : 1920, H = (vp && vp.size) ? vp.size.y : 1080;
  for (let i = 0; i < contentLineTargets.length; i++) {
    const t = contentLineTargets[i];
    const es = poe2.worldToScreen(t.worldX, t.worldY, t.worldZ != null ? t.worldZ : z); if (!es) continue;
    // JUST a plain line to the real position -- no edge-clamp marker (that read as a 2nd "map" marker
    // and flashed as the target crossed the screen edge). Off-screen targets simply clip at the edge.
    dl.addLine({ x: ps.x, y: ps.y }, { x: es.x, y: es.y }, t.color, 2.5);
    const onScreen = es.x >= ox && es.x <= ox + W && es.y >= oy && es.y <= oy + H;
    if (onScreen) {
      try { dl.addCircleFilled({ x: es.x, y: es.y }, 5, t.color, 14); } catch (e2) {}
      const d = Math.round(Math.hypot((t.gridX || 0) - lp.gridX, (t.gridY || 0) - lp.gridY));
      dl.addText(t.label + "  ~" + d, { x: es.x + 9, y: es.y - 7 }, t.color);
    }
  }
}

// returns false when not in a real map (skip)
function resetIfNewArea() {
  let ai = 0;
  try { ai = Number(poe2.getAreaInfo().areaInstance); } catch (e) { return false; }
  if (!ai) return false;
  if (ai !== areaGen) { acc.clear(); rareSeen = 0; areaGen = ai; lastScan = 0; objs = []; objDone = {}; _bossGrid = null; _bossGridTryAt = 0; _bossPath = null; contentLineTargets = []; }
  return true;
}

function scanAndMerge() {
  let o = readObjState(); objSrc = 'base-game';
  if (!o || !o.length) { const p = objsFromPanel(); if (p && p.length) { o = p; objSrc = 'panel fallback'; } }
  if (o) { objs = o; objDone = {}; o.forEach(x => { objDone[x.name] = x.complete; }); }

  const all = poe2.getAllEntities() || [];
  if (!all.length) return;                 // mid-stream: keep accumulator, skip

  let player = null; try { player = poe2.getLocalPlayer(); } catch (e) {}
  const seen = new Set();
  let rc = 0;
  const now = Date.now();
  // collect color-coded content-line targets while we have the full entity list (drawn by drawContentLines)
  const clTargets = [], clSeen = new Set();

  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    { const cl = classifyContentLine(e);
      if (cl) { const bk = cl.label + '@' + Math.round((e.gridX || 0) / 6) + ',' + Math.round((e.gridY || 0) / 6);
        if (!clSeen.has(bk)) { clSeen.add(bk); clTargets.push({ color: cl.color, label: cl.label, worldX: e.worldX, worldY: e.worldY, worldZ: e.worldZ, gridX: e.gridX, gridY: e.gridY }); } } }
    if (e.entityType === 'Monster' && e.entitySubtype === 'MonsterUnique') rc++;
    const mech = mechOf(e); if (!mech) continue;
    // Per-instance completion. Brequel (breach hand) has NO readable tracker on this patch (the 0x33eea50
    // readTracker RVA drifted) -> use isObjectiveDone (MinimapIcon +0x38: 0=openable, 1=spent/done).
    // Expedition/Checkpoint keep the tracker; Breach/Delirium/Abyss have none -> objState-only (shown below).
    let t;
    if (mech === 'Brequel') {
      let done = false; try { done = poe2.isObjectiveDone(Number(e.address)); } catch (_) {}
      t = done ? 1 : 0;
    } else {
      t = readTracker(Number(e.address));
      if (t === null) continue;
    }
    const gx = e.gridX, gy = e.gridY, k = keyFor(mech, gx, gy);
    seen.add(k);
    let r = acc.get(k);
    if (!r) { r = { key: k, mech, gridX: gx, gridY: gy, worldX: e.worldX, worldY: e.worldY, id: e.id, complete: 0, lastSeen: now }; acc.set(k, r); }
    r.gridX = gx; r.gridY = gy; r.worldX = e.worldX; r.worldY = e.worldY; r.id = e.id; r.lastSeen = now;
    if (t === 1) r.complete = 1; else if (r.complete !== 1) r.complete = 0;
  }
  rareSeen = Math.max(rareSeen, rc);
  // An instance is done if its per-entity tracker says so OR its base-game objective is complete.
  // Tracker is per-instance/granular (Checkpoint/Expedition); Delirium's tracker never flips, but its
  // base-game objState bit does -- so objState is the authoritative per-type done (no UI involved).
  acc.forEach(r => { const on = MECH_TO_OBJ[r.mech]; if (on && objDone[on] === 1) r.complete = 1; });

  // publish content-line targets, dropping a whole mechanic once its base-game objective is complete
  contentLineTargets = clTargets.filter(t => {
    if ((t.label === 'Vaal Chest' || t.label === 'Vaal Beacon') && objDone['Incursion'] === 1) return false;
    if (t.label === 'Delirium' && objDone['Delirium'] === 1) return false;
    if (t.label === 'Breach' && objDone['Breach'] === 1) return false;
    return true;
  });
}

function onDraw() {
  if (!resetIfNewArea()) return;
  // Lines are now drawn from the MAPPER (drawMapperLines) -- map_content is just the tracking window now.
  // if (SHOW_BOSS_LINE) { try { drawBossPath(); } catch (e) {} }
  // try { drawContentLines(); } catch (e) {}
  const now = Date.now();
  if (now - lastScan > SCAN_MS) { lastScan = now; try { scanAndMerge(); } catch (e) { console.log('[MAPC] scan err: ' + e); } }

  if (!ImGui.begin("Map Content", null, ImGui.WindowFlags.None)) { ImGui.end(); return; }

  // group accumulated instances by mechanic
  const groups = {};
  acc.forEach(r => { (groups[r.mech] = groups[r.mech] || []).push(r); });

  // "what's left": base-game objectives not complete + non-objective placed content (Brequel) with incomplete instances
  const left = [], seenL = {};
  objs.forEach(o => { if (!o.complete && !seenL[o.name]) { seenL[o.name] = 1; left.push(o.name); } });
  for (const m in groups) { if (!MECH_TO_OBJ[m] && groups[m].some(r => r.complete !== 1) && !seenL[m]) { seenL[m] = 1; left.push(m); } }
  const haveData = objs.length || Object.keys(groups).length;
  if (!haveData) ImGui.textColored(GRAY, "reading… (no content yet -- just entered, or not in a map)");
  else ImGui.textColored(left.length ? YEL : GREEN, left.length ? ("LEFT: " + left.join(', ')) : "all known content done");
  ImGui.separator();

  ImGui.textColored(CYAN, "Placed content (accumulated, base-game):");
  const order = ['Breach', 'Delirium', 'Abyss', 'Expedition', 'Brequel', 'Checkpoint'];
  const shown = {};
  order.concat(Object.keys(groups)).forEach(mech => {
    if (shown[mech] || !groups[mech]) return; shown[mech] = 1;
    const list = groups[mech];
    const done = list.filter(r => r.complete === 1).length;
    const total = list.length;
    const on = MECH_TO_OBJ[mech];
    const mechDone = on ? (objDone[on] === 1) : (done === total);
    const note = (on && objDone[on] !== 1 && done === total) ? "  (obj: more)" : "";
    ImGui.textColored(mechDone ? GREEN : YEL, mech + "  " + done + "/" + total + note);
    let _pl = null; try { _pl = poe2.getLocalPlayer(); } catch (e) {}
    list.forEach(r => {
      const fresh = (Date.now() - r.lastSeen) < 1500;
      const col = r.complete === 1 ? GREEN : (r.complete === 0 ? RED : GRAY);
      const mk  = r.complete === 1 ? "[x]" : (r.complete === 0 ? "[ ]" : "[?]");
      const dtxt = _pl ? ("  " + Math.round(Math.hypot((r.gridX || 0) - _pl.gridX, (r.gridY || 0) - _pl.gridY)) + "u")
                       : ("  @" + Math.round(r.gridX) + "," + Math.round(r.gridY));
      ImGui.textColored(col, "   " + mk + dtxt + (fresh ? "" : "  (left view)"));
    });
  });

  ImGui.separator();
  ImGui.textColored(CYAN, "Objectives (" + objSrc + "):");
  if (!objs.length) ImGui.textColored(GRAY, "   (none read)");
  objs.forEach(o => ImGui.textColored(o.complete ? GREEN : RED, "   " + (o.complete ? "[x]" : "[ ]") + " " + o.name));
  ImGui.textColored(GRAY, "Rare uniques seen (lower bound): " + rareSeen);

  ImGui.end();
}

export const mapContentPlugin = {
  onDraw: onDraw,
  onEnable()  { acc = new Map(); areaGen = 0; lastScan = 0; objs = []; objDone = {}; rareSeen = 0; contentLineTargets = []; console.log("[MAPC] enabled"); },
  onDisable() { console.log("[MAPC] disabled"); }
};

console.log("[MapContent] Plugin loaded (disabled by default; enable in Plugin Browser)");

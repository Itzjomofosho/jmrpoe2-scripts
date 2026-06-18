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

// returns false when not in a real map (skip)
function resetIfNewArea() {
  let ai = 0;
  try { ai = Number(poe2.getAreaInfo().areaInstance); } catch (e) { return false; }
  if (!ai) return false;
  if (ai !== areaGen) { acc.clear(); rareSeen = 0; areaGen = ai; lastScan = 0; objs = []; objDone = {}; }
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

  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (e.entityType === 'Monster' && e.entitySubtype === 'MonsterUnique') rc++;
    const mech = mechOf(e); if (!mech) continue;
    // ONLY accumulate tracker-backed content (Expedition/Brequel/Checkpoint): clean 1-per-instance + real done bit.
    // Breach/Delirium/Abyss have no tracker (and breach_attachment is many sub-effects) -> objState-only, shown below.
    const t = readTracker(Number(e.address));
    if (t === null) continue;
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
}

function onDraw() {
  if (!resetIfNewArea()) return;
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
    list.forEach(r => {
      const fresh = (Date.now() - r.lastSeen) < 1500;
      const col = r.complete === 1 ? GREEN : (r.complete === 0 ? RED : GRAY);
      const mk  = r.complete === 1 ? "[x]" : (r.complete === 0 ? "[ ]" : "[?]");
      ImGui.textColored(col, "   " + mk + " @" + Math.round(r.gridX) + "," + Math.round(r.gridY) + (fresh ? "" : "  (left view)"));
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
  onEnable()  { acc = new Map(); areaGen = 0; lastScan = 0; objs = []; objDone = {}; rareSeen = 0; console.log("[MAPC] enabled"); },
  onDisable() { console.log("[MAPC] disabled"); }
};

console.log("[MapContent] Plugin loaded (disabled by default; enable in Plugin Browser)");

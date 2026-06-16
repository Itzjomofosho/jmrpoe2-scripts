/**
 * Map Markers Diagnostic  (plugin id: bindings_test)
 *
 * Read-out for the 0.5.x map / objective bindings:
 *   getQuestMarkers()   on-map MinimapIcon entities, grouped by kind (positions for ESP/pathing)
 *   getTgtLocations()   TGT terrain features (temple waygate / boss arenas)
 *   getMapObjectives()  main objective + the live "Map Content" checklist (id/name + completion)
 *   readMapInfo()       the ui_root>6>2 panel: area header, content tags, waystone mod list
 *   UI Objective Finder search the live UI tree for a string + its index-path (UI re-mapping tool)
 *
 * Disabled by default; enable in the Plugin Browser. Filter logs by [MARKERS].
 */

import { uiRoot, uiChildren, uiNav, uiText, uiVisible } from './ui_tree.js';

const poe2 = new POE2();

// -- colors -------------------------------------------------------------------
const GREEN = [0.3, 1.0, 0.3, 1.0];
const RED   = [1.0, 0.4, 0.4, 1.0];
const GRAY  = [0.6, 0.6, 0.6, 1.0];
const CYAN  = [0.4, 0.8, 1.0, 1.0];
const YEL   = [1.0, 0.9, 0.3, 1.0];

// -- state --------------------------------------------------------------------
let _filter = null;                 // MutableVariable<string>, lazily created
let _markers = null;                // cached getQuestMarkers() result
let _markersAt = 0;
let _tgt = null;                    // cached getTgtLocations() -- static per zone, refreshed rarely
let _tgtAt = 0;
let _obj = null;                    // cached getMapObjectives() (main objective + content)
let _objAt = 0;
let _markersOpen = false;           // is the getQuestMarkers section open? (gates the expensive entity walk)
let _showAllTgt = null;             // MutableVariable<boolean>
let _needle = null;                 // MutableVariable<string> for the UI finder
let _uiHits = null;                 // last UI-finder result
let _uiScanned = 0;                 // nodes visited by last scan
let _mapInfo = null;                // cached readMapInfo() ([6,2] area / mods / content tags)
let _maskTrack = null;              // content-set probe: Map(loc -> {value, hits}) across dumps in one map
let _maskRuns = 0;                  // dumps so far in this map
let _lastRevMask = 0;               // last revealed bitmask (to detect map change)
let _maskPrevMap = null;            // Map(loc -> value) from the PREVIOUS map, for cross-map compare
let _objAll = null, _objAllAt = 0;  // cached readObjectives() (all 19 slots), refreshed slowly
let _mcFull = null;                 // cached getMapContent() result (heavy full-map walk; button-refreshed)
const REFRESH_MS = 400;             // cheap UI reads (objectives / map info)
const MARKERS_REFRESH_MS = 2500;    // getQuestMarkers walks the WHOLE entity map -> very expensive on big maps
const TGT_REFRESH_MS = 3000;        // TGT is static per zone; poll rarely (also avoids native log spam)

// -- helpers ------------------------------------------------------------------
function safe(fn) {
  try { return { ok: true, v: fn() }; }
  catch (e) { return { ok: false, e: String(e) }; }
}

function hex(v) {
  try {
    if (typeof v === 'bigint') return '0x' + v.toString(16);
    if (typeof v === 'number') return '0x' + Math.round(v).toString(16);
    return String(v);
  } catch (e) { return String(v); }
}

// ImGui.text/textColored/setItemTooltip treat the string as a printf FORMAT, so a literal '%' in
// game text (e.g. "14% increased") corrupts output. Escape % before passing ANY game text. No-op
// when the string has no '%', so it's safe to wrap liberally.
function esc(s) { return String(s == null ? '' : s).replace(/%/g, '%%'); }

function verdict(ok, text) {
  ImGui.textColored(ok ? GREEN : RED, esc((ok ? '[OK]  ' : '[!!]  ') + text));
}

function jstr(o) {
  return JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? '0x' + v.toString(16) : v), 2);
}

// last path segment, for a compact label (".../Objects/Foo" -> "Foo")
function pathTail(p) {
  if (!p) return '';
  const parts = String(p).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

// path/name -> semantic marker kind. First match wins; order = specificity.
const KIND_RULES = [
  ['temple',     /waygate|incursion/i],
  ['delirium',   /delirium/i],
  ['expedition', /expedition/i],
  ['brequel',    /brequel/i],
  ['breach',     /breach/i],
  ['ritual',     /ritual/i],
  ['essence',    /essence/i],
  ['strongbox',  /strongbox/i],
  ['shrine',     /shrine/i],
  ['boss',       /mapboss|\/boss|arena|hyenacanyon|caedron/i],
  ['checkpoint', /checkpoint/i],
  ['portal',     /portal/i],
  ['league_npc', /affliction|madox|league\/npc|npc\/league/i],
];
function kindOf(path) {
  const p = String(path || '');
  for (const [kind, re] of KIND_RULES) if (re.test(p)) return kind;
  return 'other';
}

// TGT names are ~481 mostly-noise terrain tiles; surface only objective-bearing features.
const TGT_INTEREST = /waygate|incursion|\/boss|arena|temple|shrine|strongbox|breach|ritual|delirium|expedition|vaal|device|encounter/i;
const TGT_NOISE = /unwalkable|\/fill|blank|dune_top|ruinwall|planter|forced_blank|_border_/i;
function tgtInteresting(name) {
  return TGT_INTEREST.test(name) && !TGT_NOISE.test(name);
}

// Resolve GGG inline markup to readable text: "[ContainsBreach|Breaches]" -> "Breaches",
// "[Flask]" -> "Flask", and strip "<<loc_token>>". Used for the map-mod list.
function resolveMarkup(s) {
  if (!s) return '';
  return s.replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2')   // [id|display] -> display
          .replace(/\[([^\]]*)\]/g, '$1')              // [single]     -> single
          .replace(/<<[^>]*>>/g, '')                   // <<loc_token>> -> ''
          .trim();
}

// First "[id|Display]" markup token's Display half (the clean objective name), '' if none.
function firstMarkupDisplay(s) {
  if (!s) return '';
  const m = String(s).match(/\[[^\]|]*\|([^\]]*)\]/);
  return m ? m[1].trim() : '';
}

// Read the top-left map-info panel (ui_root > 6 > 2): area header [6,2,0,*] + waystone mod list
// [6,2,3,0,1,*]. `content` pulls mechanic tags from [Contains<X>|Display] tokens. (The actual
// per-icon Map Content checklist comes from native getMapObjectives().content.) null if not in a map.
function readMapInfo() {
  const root = uiRoot(poe2);
  if (!root) return null;
  const out = { info: [], mods: [], content: [] };
  const infoC = uiNav(poe2, root, [6, 2, 0]);
  if (infoC) for (const c of uiChildren(poe2, infoC)) {
    const t = resolveMarkup(uiText(poe2, c, 0x390));
    if (t) out.info.push(t);
  }
  const modsC = uiNav(poe2, root, [6, 2, 3, 0, 1]);
  if (modsC) for (const c of uiChildren(poe2, modsC)) {
    const raw = uiText(poe2, c, 0x390);
    const t = resolveMarkup(raw);
    if (t) out.mods.push(t);
    for (const m of (raw ? raw.matchAll(/\[Contains([^\]|]*)\|?([^\]]*)\]/g) : [])) {
      out.content.push(m[2] || m[1]);
    }
  }
  return out;
}

function refresh(force) {
  const now = Date.now();
  // getQuestMarkers walks the full entity map -- VERY expensive on big maps; only when its section
  // is open, and even then poll slowly.
  if ((force || _markersOpen) && (force || !_markers || now - _markersAt >= MARKERS_REFRESH_MS)) {
    _markersAt = now;
    _markers = safe(() => poe2.getQuestMarkers());
  }
  // cheap UI-tree reads.
  if (force || !_obj || now - _objAt >= REFRESH_MS) {
    _objAt = now;
    _obj = safe(() => poe2.getMapObjectives());
    _mapInfo = safe(() => readMapInfo()).v || null;
  }
  // TGT is static per zone -> refresh on a slow cadence so we don't spam the native reader.
  if (force || !_tgt || now - _tgtAt >= TGT_REFRESH_MS) {
    _tgtAt = now;
    _tgt = safe(() => poe2.getTgtLocations());
  }
}

// -- sections -----------------------------------------------------------------

// Every MinimapIcon entity, grouped by semantic kind.
function sectionMarkers() {
  _markersOpen = ImGui.collapsingHeader("getQuestMarkers()  -  on-map MinimapIcon entities");   // collapsed by default; gates the entity walk
  if (!_markersOpen) return;

  if (typeof poe2.getQuestMarkers !== 'function') {
    verdict(false, "getQuestMarkers is not a function -> OLD dll. Rebuild.");
    return;
  }
  const r = _markers;
  if (!r || !r.ok) { verdict(false, "threw: " + (r ? r.e : 'no data')); return; }
  const m = r.v || [];
  verdict(Array.isArray(m), `${m.length} marker(s)`);

  // filter box (substring match on path / pathTail)
  if (!_filter) _filter = new ImGui.MutableVariable("");
  ImGui.inputText("filter (path)##markers", _filter);
  const f = (_filter.value || '').toLowerCase();
  const shown = f ? m.filter(x => (x.path || '').toLowerCase().includes(f)) : m;

  ImGui.sameLine();
  if (ImGui.smallButton("dump##markers")) dumpMarkers(shown);
  ImGui.sameLine();
  if (ImGui.smallButton("copy addrs##markers")) {
    ImGui.setClipboardText(shown.map(x => hex(x.address)).join('\n'));
  }

  // ---- grouped by kind (temple/delirium/expedition/...) ----
  if (ImGui.treeNode(`By kind (${shown.length})`, ImGui.TreeNodeFlags.DefaultOpen)) {
    const groups = new Map();   // kind -> { count, items:[] }
    for (const x of shown) {
      const k = kindOf(x.path);
      let g = groups.get(k);
      if (!g) { g = { count: 0, items: [] }; groups.set(k, g); }
      g.count++; g.items.push(x);
    }
    const kinds = [...groups.keys()].sort();
    for (const k of kinds) {
      const g = groups.get(k);
      const tails = g.items.slice(0, 6).map(x => `${pathTail(x.path)}[t${x.iconType}]`).join(', ');
      ImGui.textColored(k === 'other' ? GRAY : CYAN, `  ${k}  x${g.count}`);
      ImGui.sameLine();
      ImGui.textColored(GRAY, esc(`  ${tails}${g.items.length > 6 ? ' ...' : ''}`));
    }
    ImGui.treePop();
  }

  // ---- flat per-marker list (expand for address / full path / copy) ----
  if (ImGui.treeNode(`All markers (${shown.length})`)) {
    const sorted = [...shown].sort((a, b) => {
      const ka = kindOf(a.path), kb = kindOf(b.path);
      return ka < kb ? -1 : ka > kb ? 1 : ((a.path || '') < (b.path || '') ? -1 : 1);
    });
    for (let i = 0; i < Math.min(sorted.length, 200); i++) {
      const x = sorted[i];
      const label = `${kindOf(x.path)}  ${pathTail(x.path) || '?'}  t=${x.iconType}##mk${i}`;
      if (ImGui.treeNode(label)) {
        ImGui.textColored(GRAY, `  addr:   ${hex(x.address)}`);
        ImGui.sameLine();
        if (ImGui.smallButton(`copy##a${i}`)) ImGui.setClipboardText(hex(x.address));
        ImGui.text(`  world:  (${(x.worldX || 0).toFixed(1)}, ${(x.worldY || 0).toFixed(1)})   grid: (${(x.gridX || 0).toFixed(1)}, ${(x.gridY || 0).toFixed(1)})`);
        ImGui.text(esc(`  kind:   ${kindOf(x.path)}    iconType: ${x.iconType}    q: ${x.hasQuestComponent ? 1 : 0}    questId: "${x.questId || ''}"`));
        ImGui.textColored(GRAY, esc(`  path:   ${x.path || '(none)'}`));
        ImGui.treePop();
      }
    }
    if (sorted.length > 200) ImGui.textColored(YEL, `  (+${sorted.length - 200} more; narrow with the filter)`);
    ImGui.treePop();
  }
}

// TGT terrain features -- temple/boss arenas live here, not in the icon set.
function sectionTgt() {
  if (!ImGui.collapsingHeader("getTgtLocations()  -  TGT terrain (temple / arenas)")) return;
  if (typeof poe2.getTgtLocations !== 'function') { verdict(false, "not a function -> OLD dll"); return; }
  const r = _tgt;
  if (!r || !r.ok) { verdict(false, "threw: " + (r ? r.e : 'no data')); return; }
  const t = r.v || {};
  verdict(!!t.isValid, `isValid: ${!!t.isValid}`);
  const locs = t.locations || {};
  const allNames = Object.keys(locs);

  if (!_showAllTgt) _showAllTgt = new ImGui.MutableVariable(false);
  ImGui.checkbox("show all (incl. terrain noise)##tgt", _showAllTgt);
  const names = _showAllTgt.value ? allNames : allNames.filter(tgtInteresting);
  ImGui.sameLine();
  ImGui.textColored(GRAY, `  ${names.length} / ${allNames.length} shown`);

  for (let i = 0; i < Math.min(names.length, 60); i++) {
    const name = names[i];
    const arr = locs[name] || [];
    const first = arr[0];
    const k = kindOf(name);
    ImGui.textColored(k === 'other' ? GRAY : CYAN, `  ${k}`);
    ImGui.sameLine();
    ImGui.text(esc(`${pathTail(name)}  x${arr.length}` + (first ? `  @(${(first.x || 0).toFixed(0)}, ${(first.y || 0).toFixed(0)})` : '')));
    if (ImGui.isItemHovered()) ImGui.setItemTooltip(esc(name));
  }
}

// getMapObjectives(): main objective + the live Map Content checklist (id/name + completion).
function sectionObjectives() {
  if (!ImGui.collapsingHeader("getMapObjectives()  -  main objective + content", ImGui.TreeNodeFlags.DefaultOpen)) return;
  if (typeof poe2.getMapObjectives !== 'function') { verdict(false, "not a function -> OLD dll"); return; }
  const r = _obj;
  if (!r || !r.ok) { verdict(false, "threw: " + (r ? r.e : 'no data')); return; }
  const o = r.v;
  if (!o) {
    ImGui.textColored(YEL, "  native: null (not in a map, or DLL pre-dates the path fix)");
    // JS fallback so the panel is useful pre-rebuild: read the main objective at the fixed path.
    const root = uiRoot(poe2);
    const mainEl = root ? uiNav(poe2, root, [7, 0, 0, 1]) : 0;
    const txt = resolveMarkup(mainEl ? uiText(poe2, mainEl, 0x390) : '');
    ImGui.textColored(txt ? GREEN : GRAY, esc(txt ? `  [JS] main: "${txt}"` : "  [JS] no objective at [7,0,0,1]"));
    return;
  }
  const main = o.mainObjective || {};
  verdict(true, `main: "${main.text || ''}"  ${main.isCompleted ? '(done)' : ''}`);

  const content = o.content;
  if (!Array.isArray(content)) {
    ImGui.textColored(YEL, "  no `content` field -> rebuild the DLL for the Map Content checklist");
    return;
  }
  const done = content.filter(c => c.isCompleted).length;
  ImGui.textColored(CYAN, `  Content: ${content.length} active, ${done}/${content.length} complete`);
  ImGui.sameLine();
  if (ImGui.smallButton("dump ALL slots")) dumpAllContentSlots();   // probe: do hidden slots carry the full set?
  ImGui.sameLine();
  if (ImGui.smallButton("find content-set")) findContentSet();     // deep-dive: hunt the per-map rolled set
  ImGui.sameLine();
  if (ImGui.smallButton("probe presence")) probeSlotPresence();    // deep-dive #2: per-slot present field
  ImGui.sameLine();
  if (ImGui.smallButton("find pinInfo")) findPinInfo();            // deep-dive #3: the +0x368 content-set vector (IDA-pinned)
  ImGui.sameLine();
  if (ImGui.smallButton("registry set")) readContentSetRegistry(); // deep-dive #4: via the pinInfo registry singleton
  for (const c of content) {
    const label = c.name && c.name !== c.id ? `${c.name} (${c.id})` : (c.id || ('slot ' + c.index));
    ImGui.textColored(c.isCompleted ? GREEN : YEL, esc(`    [#${c.index}] ${label} : ${c.isCompleted ? 1 : 0}`));
    const tip = c.isCompleted ? c.completeText : c.objective;
    if (ImGui.isItemHovered()) ImGui.setItemTooltip(esc(`id=${c.id}${tip ? '\n' + tip : ''}`));
  }
}

// Deep-dive: the FULL generated content set (incl. undiscovered) via the in-map MapContentManager.
function sectionDeepDive() {
  if (!ImGui.collapsingHeader("Deep dive: full generated content set", ImGui.TreeNodeFlags.DefaultOpen)) return;
  if (ImGui.button("dump objectives data")) dumpObjectives();
  ImGui.sameLine();
  if (ImGui.button("scan entities (full set)")) dumpMapEntityScan();
  ImGui.sameLine();
  if (ImGui.smallButton("nodes")) dumpMapContentNodes();
  ImGui.sameLine();
  if (ImGui.smallButton("HUD")) dumpMapHud();
  ImGui.sameLine();
  if (ImGui.smallButton("atlas")) readMapContentFinal();
  ImGui.textColored(GRAY, "  dump objectives data: present-objective list (panel+0x320) by vtable + all 19 vocab slots -> console");
}

// Walk the reachable in-game Map-Content HUD ([7,0] container, present in-map) and dump each element's
// vtable RVA (= IDA addr 0x7ff7db370000 + rva) plus any embedded std::vector-looking field, so the
// backing class + the content list can be located in IDA. Pure read-out; always informative.
function dumpMapHud() {
  const rd = (a, t) => { try { return Number(poe2.readMemory(a, t)) || 0; } catch (e) { return 0; } };
  const rd64 = a => rd(a, 'int64'), rd8 = a => rd(a, 'uint8');
  const vp = p => p > 0x10000 && p < 0x7fffffffffff;
  let baseN = 0; try { const n = poe2.getNativeMapInfo(); baseN = n ? Number(n.moduleBase) : 0; } catch (e) { /* */ }
  const root = uiRoot(poe2);
  if (!root || !baseN) { console.log('[MARKERS] mapHud: no uiRoot / moduleBase'); return; }
  const inMod = v => v >= baseN && v < baseN + 0x6000000;
  const rva = v => (v - baseN);
  // vtable RVA + a compact field scan (only structural fields: module ptrs, heap ptrs, vector pairs).
  const dumpEl = (label, el, deep) => {
    if (!vp(el)) { console.log(`  ${label} = ${hex(el)} (not a valid element)`); return; }
    const vt = rd64(el);
    console.log(`  ${label} addr=${hex(el)} vtable=${hex(vt)} ${inMod(vt) ? 'IDA=0x' + (0x7ff7db370000 + rva(vt)).toString(16) + ' (RVA 0x' + rva(vt).toString(16) + ')' : '(vtable not in module!)'}`);
    if (!deep) return;
    for (let off = 8; off <= 0x600; off += 8) {
      const v = rd64(el + off);
      if (!v) continue;
      if (inMod(v)) { console.log(`     +0x${off.toString(16)}: MOD 0x7ff7db370000+0x${rva(v).toString(16)} (subobj vtable / fn ptr)`); continue; }
      if (!vp(v)) continue;
      const v1 = rd64(el + off + 8);
      if (vp(v1) && v1 >= v && (v1 - v) <= 0x4000) {
        const diff = v1 - v;
        let extra = '';
        if (diff > 0 && diff <= 64) { const bytes = []; for (let j = 0; j < diff; j++) bytes.push(rd8(v + j)); extra = ` bytes=[${bytes.join(',')}]`; }
        else if (diff > 0 && diff % 8 === 0 && diff <= 0x400) extra = ` ptrs=${diff / 8}`;
        console.log(`     +0x${off.toString(16)}: VEC begin=${hex(v)} end=${hex(v1)} span=${diff}${extra}`);
        off += 8; // skip the end-ptr we just consumed
      } else {
        console.log(`     +0x${off.toString(16)}: ptr ${hex(v)}`);
      }
    }
  };
  console.log(`[MARKERS] mapHud: base=${hex(baseN)} root=${hex(root)}`);
  const c70 = uiNav(poe2, root, [7, 0]);
  dumpEl('[7,0]', c70, true);
  dumpEl('[7,0,1]', uiNav(poe2, root, [7, 0, 1]), true);
  const list = uiNav(poe2, root, [7, 0, 1, 1]);
  dumpEl('[7,0,1,1]', list, true);
  if (list) {
    const slots = uiChildren(poe2, list);
    console.log(`  [7,0,1,1] has ${slots.length} slot(s); first few:`);
    for (let i = 0; i < Math.min(slots.length, 6); i++) {
      const s = slots[i];
      const vt = rd64(s), row = rd64(s + 0x2f8);
      console.log(`    slot#${i} addr=${hex(s)} vtable=${inMod(vt) ? '0x7ff7db370000+0x' + rva(vt).toString(16) : hex(vt)} +0x2f8(row)=${hex(row)}`);
    }
  }
}

// Resolve ALL objectives in the Map-Objectives panel ([7,0,1,1]): each of the 19 slots is one
// EndgameMapObjectives.dat row at slot+0x2F8 (+0x00 Id, +0x08 objective text, +0x10 complete text,
// each a wchar_t*); a slot is ACTIVE (present in this map) when visible; completion = child[1] visible.
// Resolves the clean name the same way native getMapObjectives does: [id|Display] -> sentence -> Id.
function readObjectives() {
  const rd = (a, t) => { try { return Number(poe2.readMemory(a, t)) || 0; } catch (e) { return 0; } };
  const rd64 = a => rd(a, 'int64');
  const vp = p => p > 0x10000 && p < 0x7fffffffffff;
  const wstr = a => { try { return poe2.readWideStringPtr(a) || ''; } catch (e) { return ''; } };
  const root = uiRoot(poe2);
  if (!root) return null;
  const panel = uiNav(poe2, root, [7, 0, 1, 1]);
  if (!vp(panel)) return null;
  const slots = uiChildren(poe2, panel);
  const out = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const row = rd64(s + 0x2f8);
    let idRaw = '', objRaw = '', doneRaw = '';
    if (vp(row)) { idRaw = wstr(row); objRaw = wstr(row + 8); doneRaw = wstr(row + 0x10); }
    const id = resolveMarkup(idRaw);
    const name = firstMarkupDisplay(objRaw) || firstMarkupDisplay(doneRaw) || resolveMarkup(objRaw) || id || ('slot' + i);
    const active = uiVisible(poe2, s) ? 1 : 0;
    const kids = uiChildren(poe2, s);
    const complete = kids.length > 1 && uiVisible(poe2, kids[1]) ? 1 : 0;
    out.push({ i, name, id, objective: resolveMarkup(objRaw), active, complete });
  }
  return out;
}

function dumpObjectives() {
  const list = readObjectives();
  if (!list) { console.log('[MARKERS] objectives: panel [7,0,1,1] not found (in a map?)'); return; }
  const active = list.filter(r => r.active);
  console.log(`[MARKERS] objectives: ${active.length} ACTIVE (present in map) of ${list.length} possible`);
  console.log('  ACTIVE (everything we found, complete or not): ' + (active.map(r => `${r.name}${r.complete ? ' (done)' : ''}`).join(', ') || '(none)'));
  // Per-slot raw signals so we can hunt for a "present-in-map" flag distinct from UI visibility:
  // #kids, the slot flags dword (+0x180, vis = bit 0xB), and two candidate state words.
  const rd = (a, t) => { try { return Number(poe2.readMemory(a, t)) || 0; } catch (e) { return 0; } };
  const root = uiRoot(poe2); const panel = root ? uiNav(poe2, root, [7, 0, 1, 1]) : 0;
  const slots = panel ? uiChildren(poe2, panel) : [];
  console.log('  --- all slots ( * = active/present ) name | vis comp | kids flags @+0x180 | states ---');
  for (let i = 0; i < list.length; i++) {
    const r = list[i]; const s = slots[i] || 0;
    const kids = s ? uiChildren(poe2, s).length : -1;
    const flags = s ? rd(s + 0x180, 'uint32') : 0;
    const w2e4 = s ? rd(s + 0x2e4, 'uint16') : 0;   // ctor a4 state word
    const b388 = s ? rd(s + 0x388, 'uint8') : 0;
    console.log(`    ${r.active ? '*' : ' '} #${r.i} ${r.name.padEnd ? r.name.padEnd(26) : r.name}  vis=${r.active} comp=${r.complete} | kids=${kids} flags=0x${flags.toString(16)} | w2e4=${w2e4} b388=${b388}  [id=${r.id}]`);
  }
}

// THE deliverable: poe2.getMapContentFull() -- every mechanic present in the map INCLUDING the ones the
// in-game Map Content panel hides. Heavy heap scan -> cache + button-refresh. active = shown in panel;
// hidden = placed but the panel never shows it (the value-add). Gated on the binding (needs DLL rebuild).
let _cFull = null, _cFullAt = 0;
function sectionContentFullNative() {
  if (!ImGui.collapsingHeader("Map Content FULL  (native -- incl. panel-HIDDEN)", ImGui.TreeNodeFlags.DefaultOpen)) return;
  if (typeof poe2.getMapContentFull !== 'function') {
    ImGui.textColored(YEL, "  needs DLL rebuild -- poe2.getMapContentFull() not present yet");
    return;
  }
  if (ImGui.button("scan content (full)")) {
    const t0 = Date.now();
    try { _cFull = poe2.getMapContentFull() || []; } catch (e) { _cFull = []; console.log('[MARKERS] getMapContentFull failed: ' + String(e)); }
    _cFullAt = Date.now();
    const shown = _cFull.filter(c => c.active), hid = _cFull.filter(c => c.hidden);
    console.log(`[MARKERS] getMapContentFull: ${_cFull.length} present (${shown.length} shown, ${hid.length} HIDDEN) in ${_cFullAt - t0}ms`);
    console.log('  shown : ' + shown.map(c => c.name).join(', '));
    console.log('  HIDDEN: ' + hid.map(c => c.name).join(', '));
  }
  ImGui.sameLine();
  ImGui.textColored(GRAY, "(heavy heap scan -- click to refresh)");
  if (!_cFull) { ImGui.textColored(GRAY, "  click 'scan content (full)' (also dumps to console)"); return; }
  const shown = _cFull.filter(c => c.active), hid = _cFull.filter(c => c.hidden);
  ImGui.textColored(CYAN, `  ${_cFull.length} present:  ${shown.length} shown,  ${hid.length} HIDDEN`);
  for (const c of shown) ImGui.textColored(GREEN, esc(`    [panel] ${c.name}`));
  for (const c of hid)   ImGui.textColored(YEL,   esc(`    [HIDDEN] ${c.name}  (${c.id})`));
}

// FULL content set incl. undiscovered, via the native getMapContent() (walks the whole awake+sleeping
// entity map). Button-refreshed (heavy). Dedupes by type for the "mechanics present" set; each type
// expands to its entities with grid positions. Gated on the binding existing (needs the DLL rebuild).
function sectionMapContentFull() {
  if (!ImGui.collapsingHeader("Map Content  (FULL set incl. undiscovered)", ImGui.TreeNodeFlags.DefaultOpen)) return;
  if (typeof poe2.getMapContent !== 'function') {
    ImGui.textColored(YEL, "  needs DLL rebuild -- poe2.getMapContent() not present yet");
    return;
  }
  // arena-boundary / boss-visual entities aren't content; drop them (native classify also drops BossArena
  // after the next rebuild -- this keeps the live view clean now). The map boss itself comes from readObjectives().
  const MC_NOISE = /BossArena|ForceFieldDoor|BossTargetMarker|ArenaBlocker/i;
  if (ImGui.button("scan full map content")) {
    const t0 = Date.now();
    try { _mcFull = (poe2.getMapContent() || []).filter(c => !MC_NOISE.test(c.path || '')); } catch (e) { _mcFull = []; console.log('[MARKERS] getMapContent failed: ' + String(e)); }
    const byT = new Map(); for (const c of _mcFull) byT.set(c.type, (byT.get(c.type) || 0) + 1);
    console.log(`[MARKERS] getMapContent: ${_mcFull.length} content entities, ${byT.size} types in ${Date.now() - t0}ms`);
    console.log('  ' + [...byT.entries()].map(([t, n]) => `${t}:${n}`).join('  '));
    for (const c of _mcFull.slice(0, 80)) console.log(`    ${c.type}  ${pathTail(c.path)} @grid(${Math.round(c.gridX)},${Math.round(c.gridY)})`);
  }
  ImGui.sameLine();
  ImGui.textColored(GRAY, "(heavy full-map walk -- click to refresh)");
  if (!_mcFull) { ImGui.textColored(GRAY, "  click 'scan full map content' (also dumps to console)"); return; }
  const byType = new Map();
  for (const c of _mcFull) { if (!byType.has(c.type)) byType.set(c.type, []); byType.get(c.type).push(c); }
  ImGui.textColored(CYAN, `  ${byType.size} mechanic type(s) present, ${_mcFull.length} entities:`);
  for (const [t, list] of byType) {
    if (ImGui.treeNode(`${t}  (${list.length})##mc_${t}`)) {
      for (let i = 0; i < Math.min(list.length, 40); i++) {
        const c = list[i];
        ImGui.textColored(GRAY, esc(`    ${pathTail(c.path)}  @grid(${Math.round(c.gridX)},${Math.round(c.gridY)})`));
      }
      ImGui.treePop();
    }
  }
}

// Live render of readObjectives(): the objectives PRESENT in this map (active) + completion, with the
// full possible vocab under a tree. Cached ~0.5s. User-confirmed: active set == the map's real content.
function sectionAllObjectives() {
  if (!ImGui.collapsingHeader("Map Objectives  (present + all possible)", ImGui.TreeNodeFlags.DefaultOpen)) return;
  const now = Date.now();
  if (!_objAll || now - _objAllAt > 500) { _objAll = readObjectives(); _objAllAt = now; }
  const list = _objAll;
  if (!list) { ImGui.textColored(YEL, "  not in a map (objectives panel not found)"); return; }
  const active = list.filter(r => r.active);
  const done = active.filter(r => r.complete).length;
  ImGui.textColored(CYAN, `  Present in this map: ${active.length}   (${done}/${active.length} complete)`);
  for (const r of active) ImGui.textColored(r.complete ? GREEN : YEL, esc(`    ${r.complete ? '[x]' : '[ ]'} ${r.name}`));
  if (ImGui.treeNode(`All possible objectives (${list.length})##allobj`)) {
    for (const r of list) ImGui.textColored(r.active ? (r.complete ? GREEN : YEL) : GRAY, esc(`    ${r.active ? '*' : '  '} ${r.name}  (${r.id})`));
    ImGui.treePop();
  }
}

// IN-MAP generated content nodes (the authoritative full set incl. undiscovered, IDA-traced):
// AreaInstance (vtable off_7FF7DE37F470) holds a content sub-object at +0x2208 (ticked by sub_7FF7DC8AA160);
// content+0x8 = component bag (sorted 88-byte entries {hash@+0, vector@+16}); component hash 0x4DD153A7 =
// std::vector<node*> of PLACED content (each node = EndgameMapContent row + world pos). This is what the
// game generated, independent of UI discovery. We verify parent by vtable, find the component, dump nodes.
function dumpMapContentNodes() {
  const rd = (a, t) => { try { return Number(poe2.readMemory(a, t)) || 0; } catch (e) { return 0; } };
  const rd64 = a => rd(a, 'int64'), rd32 = a => rd(a, 'uint32');
  const vp = p => p > 0x10000 && p < 0x7fffffffffff;
  let ai = 0, ig = 0, baseN = 0;
  try { ai = Number(poe2.getAreaInstance()) || 0; } catch (e) { /* */ }
  try { ig = Number(poe2.getInGameState()) || 0; } catch (e) { /* */ }
  try { const n = poe2.getNativeMapInfo(); baseN = n ? Number(n.moduleBase) : 0; } catch (e) { /* */ }
  if (!ai || !baseN) { console.log('[MARKERS] content-nodes: no AreaInstance / moduleBase'); return; }
  const inMod = v => v >= baseN && v < baseN + 0x6000000;
  const ida = v => inMod(v) ? ('0x' + (0x7ff7db370000 + (v - baseN)).toString(16)) : hex(v);
  const HASH = 0x4dd153a7;
  // A component bag = sorted array of 88-byte entries {hash@+0 dword, vector@+16}. begin=*(bag+8), end=*(bag+16).
  const bagInfo = bag => {
    if (!vp(bag)) return null;
    const b = rd64(bag + 8), e = rd64(bag + 16);
    if (!vp(b) || e < b || (e - b) % 88 !== 0) return null;
    const n = (e - b) / 88;
    if (n === 0 || n > 300) return null;   // real bags are small
    return { b, n };
  };
  const bagFind = (bi, hash) => { for (let i = 0; i < bi.n; i++) { const ent = bi.b + i * 88; if ((rd32(ent) >>> 0) === hash) return ent; } return 0; };
  const sd = rd64(ai + 0x580);
  let pl = 0; try { pl = Number(poe2.getLocalPlayer()) || 0; } catch (e) { /* */ }
  const MGR_VT = baseN + 0x300f470;   // off_7FF7DE37F470 (content-tick obj 2ndary vtable)
  console.log(`[MARKERS] content-nodes: ai=${hex(ai)} aiVT=${ida(rd64(ai))} serverData(@ai+0x580)=${hex(sd)} hash=0x${HASH.toString(16)}`);
  // SIGNATURE SCAN (anchor-free, MI-proof). content obj = X where *(X+8) is a component bag CONTAINING
  // hash 0x4DD153A7. Test X as: inline at root+o; the field value p; p+0x2208 (p=parent); or p whose
  // vtable == MGR_VT (then content = p+0x2208). Covers inline / pointer / parent-relative / MI layouts.
  const objHasComp = x => { if (!vp(x)) return 0; const bi = bagInfo(rd64(x + 8)); return bi ? bagFind(bi, HASH) : 0; };
  let content = 0, entry = 0, how = '';
  outer:
  for (const [nm, root] of [['ai', ai], ['serverData', sd], ['ig', ig], ['player', pl]]) {
    if (!vp(root)) continue;
    for (let o = 0; o <= 0x2800; o += 8) {
      let e = objHasComp(root + o);                       // inline content obj at root+o
      if (e) { content = root + o; entry = e; how = `${nm}+0x${o.toString(16)} inline`; break outer; }
      const p = rd64(root + o);
      if (!vp(p)) continue;
      e = objHasComp(p);                                  // field points straight at content obj
      if (e) { content = p; entry = e; how = `*(${nm}+0x${o.toString(16)})`; break outer; }
      if (rd64(p) === MGR_VT || (e = objHasComp(p + 0x2208))) {  // field = parent, content at +0x2208
        const ee = e || objHasComp(p + 0x2208);
        if (ee) { content = p + 0x2208; entry = ee; how = `*(${nm}+0x${o.toString(16)})+0x2208`; break outer; }
      }
    }
  }
  if (!content) {
    console.log('  0x4dd153a7 component not found in ai/serverData/ig (scanned +0..0x3000).');
    console.log('  -> either not in a generated content map here, or the content obj is deeper. Run in a real map; tell me aiVT.');
    return;
  }
  console.log(`  content obj @ ${how} = ${hex(content)} vt=${ida(rd64(content))}  comp entry @${hex(entry)}`);
  const vb = rd64(entry + 16), ve = rd64(entry + 24);
  if (!(vp(vb) && ve >= vb && (ve - vb) % 8 === 0)) { console.log(`  comp vector invalid -- entry+16 raw: ${[0, 8, 16, 24, 32].map(o => hex(rd64(entry + 16 + o))).join(' ')}`); return; }
  const nodes = (ve - vb) / 8;
  console.log(`  ${nodes} content node(s):`);
  for (let i = 0; i < Math.min(nodes, 60); i++) {
    const nd = rd64(vb + i * 8);
    if (!vp(nd)) { console.log(`    #${i} ${hex(nd)} (bad)`); continue; }
    const f = [0x8, 0x10, 0x18, 0x20, 0x28, 0x30, 0x38, 0x40].map(fo => `+0x${fo.toString(16)}=${hex(rd64(nd + fo))}`);
    console.log(`    #${i} ${hex(nd)} vt=${ida(rd64(nd))} ${f.join(' ')}`);
  }
}

// Scan the FULL entity map (getAllEntities = awake + sleeping, incl. undiscovered) for content-marker
// entities -- the generator places content as objects, so this is the full set WITH positions even before
// you walk to them. Dumps a content-filter pass + the whole entity inventory so we can ID the markers.
function dumpMapEntityScan() {
  let ents = []; const t0 = Date.now();
  // getAllEntities() is broken on 0.5.x (returns 0 + AVs). getEntities({maxDistance:0}) walks the same
  // slab list (awake+sleeping), skips only MiscellaneousObjects/Doodad, and WORKS -> full non-doodad set.
  try { ents = poe2.getEntities({ maxDistance: 0, lightweight: true }) || []; } catch (e) { console.log('[MARKERS] entity-scan: getEntities failed: ' + String(e)); return; }
  console.log(`[MARKERS] entity-scan: ${ents.length} entities (getEntities maxDistance:0, ${Date.now() - t0}ms)`);
  const CONTENT = [
    ['Breach', /breach/i], ['Expedition', /expedition/i], ['Ritual', /ritual/i], ['Delirium', /delirium/i],
    ['Shrine', /shrine/i], ['Strongbox', /strongbox/i], ['Essence', /essence/i], ['Abyss', /abyss/i],
    ['Vaal/Incursion', /incursion|vaal/i], ['Checkpoint', /checkpoint/i], ['Boss', /mapboss|bossarena|\/boss/i],
    ['RogueExile', /rogueexile/i], ['Azmeri', /azmeri/i], ['Circle', /stonecircle|summoningcircle/i],
    ['LeagueContent', /leaguecontent|hellscape|contentmarker|encounter/i],
  ];
  const byCat = new Map();
  for (const e of ents) {
    const p = String(e.name || '');
    for (const [c, re] of CONTENT) { if (re.test(p)) { if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(e); break; } }
  }
  console.log(`  content-matched: ${byCat.size} categor(ies)`);
  for (const [c, list] of byCat) {
    const ex = list[0];
    console.log(`    ${c}: ${list.length}  e.g. "${pathTail(ex.name)}" @grid(${Math.round(ex.gridX || 0)},${Math.round(ex.gridY || 0)})`);
  }
  // full inventory grouped by first 3 path segments, to spot content markers I haven't keyworded yet
  const byTop = new Map();
  for (const e of ents) { const seg = String(e.name || '').split('/').slice(0, 3).join('/'); byTop.set(seg, (byTop.get(seg) || 0) + 1); }
  console.log(`  --- all entity groups (${byTop.size} distinct, top 60 by count) ---`);
  for (const [seg, n] of [...byTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(`    ${n}x ${seg}`);
}

// The ui_root>6>2 panel: area header, content tags, and the waystone mod list. (Map Content
// checklist itself is shown in sectionObjectives from the native binding.)
function sectionMapContent() {
  if (!ImGui.collapsingHeader("Map Info / Mods  (ui_root>6>2)")) return;
  const mi = _mapInfo;
  if (!mi) { ImGui.textColored(YEL, "  no UI root / not in a map"); return; }
  if (mi.info.length) {
    ImGui.textColored(CYAN, "  Area:");
    for (const s of mi.info) ImGui.textColored(GRAY, esc("    " + s));
  }
  ImGui.textColored(CYAN, `  Content tags (${mi.content.length}): `);
  ImGui.sameLine();
  ImGui.text(esc(mi.content.join(', ') || '(none)'));
  if (ImGui.treeNode(`Mods (${mi.mods.length})##mapmods`)) {
    for (let i = 0; i < mi.mods.length; i++) ImGui.textColored(GRAY, esc("  - " + mi.mods[i]));
    ImGui.treePop();
  }
}

// One-shot DFS over the live UI tree, reporting elements' text + index-path from root.
// needle === '' => DUMP mode: every element with non-empty text. else: substring filter. Bounded.
function findInUiTree(needle, maxNodes) {
  const root = uiRoot(poe2);
  const hits = [];
  _uiScanned = 0;
  if (!root) return { hits, scanned: 0, root: 0 };
  const dump = !needle;
  needle = (needle || '').toLowerCase();
  const cap = dump ? 250 : 40;
  const stack = [{ el: root, path: [] }];
  while (stack.length && _uiScanned < maxNodes && hits.length < cap) {
    const { el, path } = stack.pop();
    _uiScanned++;
    // objectives use a Text16Ptr @ +0x588; labels use +0x390 -- check both.
    for (const off of [0x588, 0x390]) {
      const t = uiText(poe2, el, off);
      if (t && (dump || t.toLowerCase().includes(needle))) {
        hits.push({ path: path.slice(), off, text: t, visible: uiVisible(poe2, el), addr: el });
        break;
      }
    }
    if (path.length < 30) {
      const ch = uiChildren(poe2, el);
      for (let i = ch.length - 1; i >= 0; i--) stack.push({ el: ch[i], path: path.concat(i) });
    }
  }
  return { hits, scanned: _uiScanned, root };
}

function runUiFind(needle) {
  const r = findInUiTree(needle, 12000);
  _uiHits = r.hits;
  const label = needle ? `find "${needle}"` : 'dump ALL text';
  console.log(`[MARKERS] UI ${label}: ${r.hits.length} hit(s), scanned ${r.scanned} nodes, root=${hex(r.root)}\n` +
    r.hits.map(h => `  [${h.path.join(',')}]  off=0x${h.off.toString(16)}  vis=${h.visible ? 1 : 0}  "${h.text}"`).join('\n'));
}

// Reusable UI-tree search: find a string + its index-path (how we re-mapped the moved panels).
function sectionUiFinder() {
  if (!ImGui.collapsingHeader("UI Objective Finder  -  search the live UI tree")) return;
  if (!_needle) _needle = new ImGui.MutableVariable("Defeat");
  ImGui.inputText("text to find##uifind", _needle);
  ImGui.sameLine();
  if (ImGui.button("Find in UI tree")) runUiFind(_needle.value);
  ImGui.sameLine();
  if (ImGui.button("Dump ALL text")) runUiFind("");   // empty needle = dump every text element
  ImGui.textColored(GRAY, "  find a UI string + its index-path (empty -> dump every on-screen string)");
  if (_uiHits === null) { ImGui.textColored(GRAY, "  type text and press Find"); return; }
  verdict(_uiHits.length > 0, `${_uiHits.length} hit(s)  (scanned ${_uiScanned} nodes)`);
  for (let i = 0; i < _uiHits.length; i++) {
    const h = _uiHits[i];
    ImGui.textColored(h.visible ? CYAN : GRAY, `  [${h.path.join(',')}]`);
    ImGui.sameLine();
    ImGui.text(esc(`off=0x${h.off.toString(16)} vis=${h.visible ? 1 : 0}  "${h.text.length > 50 ? h.text.slice(0, 50) + '...' : h.text}"`));
    if (ImGui.isItemHovered()) ImGui.setItemTooltip(esc(`addr ${hex(h.addr)}\n${h.text}`));
  }
}

// -- main draw ----------------------------------------------------------------
function onDraw() {
  ImGui.setNextWindowSize({ x: 680, y: 720 }, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({ x: 40, y: 40 }, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowCollapsed(true, ImGui.Cond.Once);

  if (!ImGui.begin("Map Markers", null, ImGui.WindowFlags.None)) { ImGui.end(); return; }

  refresh(false);

  const rebuilt = typeof poe2.nowMicros === 'function';
  ImGui.textColored(rebuilt ? GREEN : RED, rebuilt ? "DLL: rebuilt" : "DLL: OLD - rebuild before testing");
  ImGui.sameLine();
  if (ImGui.button("Refresh")) refresh(true);
  ImGui.sameLine();
  if (ImGui.button("Dump all to console")) dumpSnapshot();

  const player = safe(() => poe2.getLocalPlayer()).v;
  if (!player) ImGui.textColored(YEL, "Not in game (enter a map to populate markers)");
  ImGui.separator();

  sectionMarkers();
  sectionTgt();
  sectionContentFullNative();
  sectionMapContentFull();
  sectionAllObjectives();
  sectionObjectives();
  sectionDeepDive();
  sectionMapContent();
  sectionUiFinder();

  ImGui.end();
}

// -- console dumps (copy-friendly) --------------------------------------------
function dumpMarkers(list) {
  const rows = (list || []).map(x =>
    `${hex(x.address)}  t=${x.iconType}  q=${x.hasQuestComponent ? 1 : 0}  (${(x.worldX || 0).toFixed(0)},${(x.worldY || 0).toFixed(0)})  ${x.path || ''}`);
  console.log(`[MARKERS] ${rows.length} marker(s):\n` + rows.join('\n'));
}

// Probe: read EVERY slot of the [7,0,1,1] content row (not just visible) -> does a hidden slot
// already carry this map's undiscovered content (full set readable from the UI), or only the
// visible ones? Reports per slot: visibility, child[1] completion, and the +0x2F8 row Id.
function dumpAllContentSlots() {
  const root = uiRoot(poe2);
  if (!root) { console.log('[MARKERS] no UI root'); return; }
  const rowEl = uiNav(poe2, root, [7, 0, 1, 1]);
  if (!rowEl) { console.log('[MARKERS] no content row [7,0,1,1]'); return; }
  const wsp = a => { try { return poe2.readWideStringPtr(a) || ''; } catch (e) { return ''; } };
  const slots = uiChildren(poe2, rowEl);
  const lines = slots.map((s, i) => {
    const vis = uiVisible(poe2, s) ? 1 : 0;
    const kids = uiChildren(poe2, s);
    const c1 = kids[1] ? (uiVisible(poe2, kids[1]) ? 1 : 0) : '-';
    let rp = 0; try { rp = Number(poe2.readMemory(s + 0x2F8, 'int64')) || 0; } catch (e) { /* skip */ }
    const id = rp > 0x10000 ? resolveMarkup(wsp(rp)) : '(no row)';
    return `  #${i}  vis=${vis}  c1=${c1}  row=${hex(rp)}  id="${id}"`;
  });
  console.log(`[MARKERS] ALL ${slots.length} content slots [7,0,1,1]:\n` + lines.join('\n'));
}

// DEEP-DIVE probe: hunt for the per-map ROLLED content set (the full set incl. undiscovered).
// For this map, present content == the EndgameMapObjectives rows at the visible slots' +0x2F8, and
// a present-bitmask = OR(1<<slotIndex). Search structures reachable from the panel / area / game state
// for (a) any field holding one of those row pointers (an array of them = the set), or (b) a uint32
// equal to the bitmask. Whatever holds them is the content-set struct -> gives us the read path.
const CONTENT_VOCAB = ['MapBoss', 'CorruptedNexus', 'Checkpoints', 'RareMonsters', 'Breach',
  'Expedition', 'Delirium', 'Ritual', 'Abyss', 'AbyssDepths', 'Shrines', 'Strongboxes', 'Essences',
  'RogueExiles', 'AzmeriSpirits', 'StoneCircles', 'Incursion', 'Expedition2', 'Breach2'];

function findContentSet() {
  const root = uiRoot(poe2);
  if (!root) { console.log('[MARKERS] no UI root'); return; }
  const rd = a => { try { return Number(poe2.readMemory(a, 'int64')) || 0; } catch (e) { return 0; } };
  const rd32 = a => { try { return Number(poe2.readMemory(a, 'uint32')) || 0; } catch (e) { return 0; } };
  const rowEl = uiNav(poe2, root, [7, 0, 1, 1]);
  if (!rowEl) { console.log('[MARKERS] no content row [7,0,1,1]'); return; }
  const slots = uiChildren(poe2, rowEl);
  const present = [];
  const presentRows = new Set();
  slots.forEach((s, i) => { if (uiVisible(poe2, s)) { present.push(i); const r = rd(s + 0x2F8); if (r > 0x10000) presentRows.add(r); } });
  let revMask = 0; for (const i of present) revMask |= (1 << i);
  const CONTENT_BITS = 0x7FFFF;   // bits 0..18
  const slotSet = new Set(slots.map(Number));
  const named = v => { const b = []; for (let i = 0; i < 19; i++) if (v & (1 << i)) b.push(i + ':' + CONTENT_VOCAB[i]); return b.join(', '); };
  console.log(`[MARKERS] content-set search. revealed=[${present}] revMask=0x${revMask.toString(16)} rows={${[...presentRows].map(hex).join(',')}}`);

  const validPtr = p => p > 0x10000 && p < 0x7fffffffffff && (p % 8 === 0);
  const roots = [
    ['row',    rowEl],
    ['panel1', uiNav(poe2, root, [7, 0, 1])],
    ['panel0', uiNav(poe2, root, [7, 0])],
    ['area',   poe2.getAreaInstance ? poe2.getAreaInstance() : 0],
    ['igs',    poe2.getInGameState ? poe2.getInGameState() : 0],
  ].filter(r => r[1]);

  const rowHits = [], maskHits = [];
  const seenMask = new Set();
  for (const [rname, rstart] of roots) {
    const visited = new Set();
    const queue = [{ addr: rstart, depth: 0, chain: '' }];
    let nodes = 0;
    while (queue.length && nodes < 300) {
      const { addr, depth, chain } = queue.shift();
      if (visited.has(addr)) continue; visited.add(addr); nodes++;
      if (!slotSet.has(addr)) {
        for (let off = 0; off <= 0x240; off += 4) {
          const v = rd32(addr + off);
          // SUPERSET of revealed, only content bits (0..18), at least 1 extra bit OR exactly revealed
          if (revMask && (v & revMask) === revMask && (v & ~CONTENT_BITS) === 0 && v !== 0) {
            const loc = `${rname}${chain}+0x${off.toString(16)}`;
            if (!seenMask.has(loc)) {
              seenMask.add(loc);
              let extra = 0; for (let i = 0; i < 19; i++) if ((v & (1 << i)) && !(revMask & (1 << i))) extra++;
              maskHits.push({ loc, value: v, extra });
            }
          }
        }
      }
      for (let off = 0; off <= 0x240; off += 8) {
        const p = rd(addr + off);
        if (presentRows.has(p) && !slotSet.has(addr)) rowHits.push(`${rname}${chain}+0x${off.toString(16)}=${hex(p)}`);
        if (depth < 4 && validPtr(p) && !visited.has(p)) queue.push({ addr: p, depth: depth + 1, chain: `${chain}+0x${off.toString(16)}` });
      }
    }
  }
  // cross-dump narrowing: track each location's survival across incremental dumps in the SAME map.
  // The real set sits at a STABLE instance offset, value constant, a superset of revealed EVERY dump.
  if (_maskTrack === null || (revMask & _lastRevMask) !== _lastRevMask) {   // map changed -> reset (save prev map first)
    if (_maskTrack && _maskTrack.size) { _maskPrevMap = new Map(); for (const [loc, o] of _maskTrack) _maskPrevMap.set(loc, o.value); }
    _maskTrack = new Map(); _maskRuns = 0;
  }
  _lastRevMask = revMask; _maskRuns++;
  const nextTrack = new Map();
  for (const c of maskHits) {
    const prev = _maskTrack.get(c.loc);
    const hits = (prev && prev.value === c.value) ? prev.hits + 1 : 1;
    nextTrack.set(c.loc, { value: c.value, hits });
    c.hits = hits;
    const pv = _maskPrevMap ? _maskPrevMap.get(c.loc) : undefined;     // cross-map: CHANGED=per-map set, SAME=constant
    c.xmap = pv === undefined ? '-' : (pv === c.value ? 'SAME-const' : 'CHANGED-instance!');
  }
  _maskTrack = nextTrack;
  const rank = c => (c.xmap === 'CHANGED-instance!' ? 0 : c.xmap === '-' ? 1 : 2);
  maskHits.sort((a, b) => rank(a) - rank(b) || (b.hits - a.hits) || (a.extra - b.extra));
  console.log(`  bitmask candidates (dump #${_maskRuns} this map; CHANGED-instance vs prev map = THE SET; SAME-const = constant):\n` +
    (maskHits.slice(0, 40).map(c =>
      `    ${c.hits}/${_maskRuns} ${c.xmap} [${c.extra === 0 ? 'EXACT' : '+' + c.extra}] ${c.loc}  v=0x${c.value.toString(16)}  set=[${named(c.value)}]`
    ).join('\n') || '   (none)'));
  console.log(`  present-row-pointer hits (${rowHits.length}):\n` + (rowHits.slice(0, 40).join('\n') || '   (none)'));
}

// DEEP-DIVE probe #2: in a FRESH map (content still undiscovered), look for a per-slot field that's
// non-zero for MORE slots than the revealed ones -- those extra slots == undiscovered-but-present
// content (the rest of the rolled set). Also dumps the +0x180 flags so we can spot a "present" bit.
function probeSlotPresence() {
  const root = uiRoot(poe2);
  if (!root) { console.log('[MARKERS] no UI root'); return; }
  const rowEl = uiNav(poe2, root, [7, 0, 1, 1]);
  if (!rowEl) { console.log('[MARKERS] no content row [7,0,1,1]'); return; }
  const slots = uiChildren(poe2, rowEl);
  const rd = a => { try { return Number(poe2.readMemory(a, 'int64')) || 0; } catch (e) { return 0; } };
  const rd32 = a => { try { return Number(poe2.readMemory(a, 'uint32')) || 0; } catch (e) { return 0; } };
  const wsp = a => { try { return poe2.readWideStringPtr(a) || ''; } catch (e) { return ''; } };
  const idOf = i => { const r = rd(slots[i] + 0x2F8); return r > 0x10000 ? resolveMarkup(wsp(r)) : '?'; };
  const vis = slots.map(s => uiVisible(poe2, s) ? 1 : 0);
  const revealed = vis.map((v, i) => v ? i : -1).filter(i => i >= 0);
  console.log(`[MARKERS] slot-presence probe. revealed=[${revealed.map(i => i + ':' + idOf(i)).join(', ')}]`);
  console.log('  per-slot +0x180 flags:\n' + slots.map((s, i) => `    #${i} ${idOf(i)}  vis=${vis[i]}  flags=0x${rd32(s + 0x180).toString(16)}`).join('\n'));
  const cands = [];
  for (let off = 0; off <= 0x500; off += 8) {
    if (off === 0x2F8) continue;   // the shared row pointer is non-zero for all slots
    const nz = [];
    for (let i = 0; i < slots.length; i++) if (rd(slots[i] + off)) nz.push(i);
    if (revealed.every(r => nz.includes(r)) && nz.length > revealed.length && nz.length < slots.length) {
      cands.push(`    +0x${off.toString(16)}  set=[${nz.map(i => i + ':' + idOf(i)).join(', ')}]`);
    }
  }
  console.log(cands.length
    ? '  CANDIDATE present-set fields (revealed + EXTRA undiscovered):\n' + cands.join('\n')
    : '  no per-slot field is a strict superset of revealed within 0x500 (rolled set is stored externally)');
}

// DEEP-DIVE probe #3 (IDA-informed): the per-map ROLLED content set is a sorted+unique
// std::vector<uint8_t> at MapContentObject+0x368 (begin) / +0x370 (end); each byte = an
// EndgameMapContent.dat row index. Scan structures reachable from area/igs/panel/player for that
// exact shape (a short strictly-increasing byte vector at those offsets). The bytes = the FULL set
// (incl. undiscovered). Source: IDA workflow wfkzey8uu (BuildMapContentList sub_7FF7DBE836F0).
function findPinInfo() {
  const root = uiRoot(poe2);
  const rd = a => { try { return Number(poe2.readMemory(a, 'int64')) || 0; } catch (e) { return 0; } };
  const rd8 = a => { try { return Number(poe2.readMemory(a, 'uint8')) || 0; } catch (e) { return 0; } };
  const validPtr = p => p > 0x10000 && p < 0x7fffffffffff && (p % 2 === 0);
  const rowEl = root ? uiNav(poe2, root, [7, 0, 1, 1]) : 0;
  const slots = rowEl ? uiChildren(poe2, rowEl) : [];
  const revealed = slots.map((s, i) => uiVisible(poe2, s) ? i : -1).filter(i => i >= 0);
  let player = 0; try { const p = poe2.getLocalPlayer(); player = p ? p.address : 0; } catch (e) { /* */ }
  const roots = [
    ['area', poe2.getAreaInstance ? poe2.getAreaInstance() : 0],
    ['igs', poe2.getInGameState ? poe2.getInGameState() : 0],
    ['panel', root ? uiNav(poe2, root, [7, 0]) : 0],
    ['player', player],
  ].filter(r => r[1]);
  const hits = [];
  const seen = new Set();
  for (const [rname, rstart] of roots) {
    const visited = new Set();
    const queue = [{ addr: rstart, depth: 0, chain: '' }];
    let nodes = 0;
    while (queue.length && nodes < 500) {
      const { addr, depth, chain } = queue.shift();
      if (visited.has(addr)) continue; visited.add(addr); nodes++;
      const begin = rd(addr + 0x368), end = rd(addr + 0x370);
      if (validPtr(begin) && validPtr(end) && end > begin && (end - begin) <= 40) {
        const n = end - begin;
        const bytes = []; let ok = true, prev = -1;
        for (let i = 0; i < n; i++) { const b = rd8(begin + i); bytes.push(b); if (b > 90 || b <= prev) ok = false; prev = b; }
        if (ok && n >= 2) {   // strictly-increasing byte vector -> the sorted content-index set
          const key = `${begin}:${n}`;
          if (!seen.has(key)) { seen.add(key); hits.push(`  ${rname}${chain} @${hex(addr)}  count=${n}  EndgameMapContentIdx=[${bytes.join(',')}]`); }
        }
      }
      for (let off = 0; off <= 0x400; off += 8) {
        const p = rd(addr + off);
        if (depth < 5 && validPtr(p) && !visited.has(p)) queue.push({ addr: p, depth: depth + 1, chain: `${chain}+0x${off.toString(16)}` });
      }
    }
  }
  console.log(`[MARKERS] pinInfo search. revealed HUD slots=[${revealed}] (EndgameMapObjectives idx; note: set uses EndgameMapContent idx).\n` +
    `  candidates (sorted byte-vec @ +0x368/+0x370 = the rolled set, incl. undiscovered):\n` + (hits.slice(0, 40).join('\n') || '   (none reachable in 5 hops)'));
}

// DEEP-DIVE probe #4 (IDA-pinned, deterministic): read the rolled set via the EndgameMapPinInfo
// REGISTRY singleton (the manager isn't reachable by pointer-scan). base = getNativeMapInfo().moduleBase;
// reg = *(base + 0x462c188); entries at reg+0x28(begin)/+0x30(end), stride 48, key={areaId@+16,seed@+20}.
// Each entry holds a pinInfo*; pinInfo+0x368/+0x370 = sorted vector<uint8> of EndgameMapContent indices
// = the FULL rolled set. We brute the pinInfo-ptr offset within the entry, then dump every map's set.
function readContentSetRegistry() {
  let base = 0; try { const n = poe2.getNativeMapInfo(); base = n ? Number(n.moduleBase) : 0; } catch (e) { /* */ }
  if (!base) { console.log('[MARKERS] no moduleBase (getNativeMapInfo missing/0)'); return; }
  const rd = (a, t) => { try { return Number(poe2.readMemory(a, t)) || 0; } catch (e) { return 0; } };
  const rd64 = a => rd(a, 'int64'), rd32 = a => rd(a, 'uint32'), rd8 = a => rd(a, 'uint8');
  const validPtr = p => p > 0x10000 && p < 0x7fffffffffff;
  const mz = rd(base, 'uint16');
  const baseOk = mz === 0x5a4d;   // 'MZ'
  console.log(`[MARKERS] base=${hex(base)}  MZ=0x${mz.toString(16)} ${baseOk ? '(EXE ok)' : '(NOT a PE base -> getNativeMapInfo.moduleBase is the wrong module; tell me)'}`);
  const regGlobal = base + 0x462c188;
  const reg = rd64(regGlobal);
  const heapish = reg > 0x10000000000 && reg < 0x7ff000000000;   // game heap ~0x1xx-0x2xx; module is 0x7ff6..
  console.log(`  regGlobal=${hex(regGlobal)} reg=${hex(reg)} ${heapish ? '(heap-like, good)' : '(module-internal/0 -> registry not initialised: OPEN THE ATLAS once, then retry)'}`);
  if (!validPtr(reg)) { console.log('  registry not initialised (open the Atlas once this session, then retry)'); return; }
  const begin = rd64(reg + 0x28), end = rd64(reg + 0x30);
  const count = (validPtr(begin) && end > begin) ? Math.floor((end - begin) / 48) : 0;
  console.log(`  entries: begin=${hex(begin)} end=${hex(end)} count=${count} (stride 48)`);
  if (!count) return;
  const candOffs = [0, 8, 24, 32, 40];   // unknown pinInfo-ptr offset within the 48-byte entry -> brute it
  const out = [];
  for (let i = 0; i < Math.min(count, 80); i++) {
    const entry = begin + i * 48;
    const areaId = rd32(entry + 16), seed = rd32(entry + 20);
    let line = `  entry#${i} key={area=${areaId},seed=${hex(seed)}}`;
    let found = false;
    for (const off of candOffs) {
      const pin = rd64(entry + off);
      if (!validPtr(pin)) continue;
      const vb = rd64(pin + 0x368), ve = rd64(pin + 0x370);
      if (validPtr(vb) && validPtr(ve) && ve >= vb && (ve - vb) <= 40) {
        const n = ve - vb; const bytes = [];
        for (let k = 0; k < n; k++) bytes.push(rd8(vb + k));
        out.push(`${line} pinOff=+0x${off.toString(16)} pin=${hex(pin)} count=${n} EndgameMapContentIdx=[${bytes.join(',')}]`);
        found = true; break;
      }
    }
    if (!found) out.push(`${line} (no +0x368 vector at candidate offsets)`);
  }
  console.log(out.join('\n'));
}

// DEEP-DIVE FINAL (IDA-verified): read the CURRENT in-map area's FULL GENERATED content set (incl.
// undiscovered). The producer is the EndgameMapContentManager (HUDMGR) -- buildPerMapContent
// sub_7FF7DBEC1E80(a1=HUDMGR) rolls a pinInfo per map and stores it in HUDMGR+0x10/+0x18 (vector<pinInfo*>)
// and HUDMGR+0x578 (area-key->pinInfo map). HUDMGR is NOT a UI element and NOT reachable by a +0x320==ai
// scan (PARENT also has a +0x320 self-ptr; HUDMGR's +0x320 only holds ai transiently). The reliable
// disambiguator is HUDMGR's vtable == moduleBase+0x3015910 (off_7FF7DE385910, from its ctor sub_7FF7DBEBEBA0).
// Two verified anchors reach it:
//   AREA_HUB: ai -> hub=*(ai+0x1B0) -> listHolder=*(hub+0x3A20) -> vec[begin=+0x20,end=+0x28] of node*;
//             node[0]=HUDMGR+0x358, so HUDMGR=*(node)-0x358 (verify vtable).      [sub_7FF7DBF03520]
//   UI_TREE:  widget(vtable moduleBase+0x300beb0) -> HUDMGR=*(*(*(w+0x368)+0x488)+0x3E0) (verify vtable).
//             [stores in sub_7FF7DBF02CB0 / sub_7FF7DBEDEBB0 / sub_7FF7DBEB62E0]
// Each pinInfo: +0x300 WorldArea row, +0x320 area key, +0x368/+0x370 = sorted vector<uint8> of
// EndgameMapContent row indices = the full rolled set; +0x350/+0x358 = m_MapMods (uint16).
function readMapContentFinal() {
  const rd = (a, t) => { try { return Number(poe2.readMemory(a, t)) || 0; } catch (e) { return 0; } };
  const rd64 = a => rd(a, 'int64'), rd32 = a => rd(a, 'uint32'), rd8 = a => rd(a, 'uint8');
  const vp = p => p > 0x10000 && p < 0x7fffffffffff;
  let ai = 0, baseN = 0;
  try { ai = Number(poe2.getAreaInstance()) || 0; } catch (e) { /* */ }
  try { const n = poe2.getNativeMapInfo(); baseN = n ? Number(n.moduleBase) : 0; } catch (e) { /* */ }
  if (!ai) { console.log('[MARKERS] content-final: not in a generated map (no AreaInstance)'); return; }
  if (!baseN) { console.log('[MARKERS] content-final: no moduleBase (getNativeMapInfo missing/0)'); return; }
  const HUDMGR_VT = baseN + 0x3015910;   // off_7FF7DE385910 rebased
  const WIDGET_VT = baseN + 0x300beb0;   // off_7FF7DE37BEB0 rebased (MapUIWidget)
  const hub = rd64(ai + 0x1B0);
  console.log(`[MARKERS] content-final: ai=${hex(ai)} base=${hex(baseN)} hub=${hex(hub)} HUDMGR_VT=${hex(HUDMGR_VT)}`);

  let MGR = 0, how = '';
  // -- anchor 1: AREA_HUB (only if getAreaInstance()'s hub is live; it may be a different area object) --
  if (vp(hub)) {
    const listHolder = rd64(hub + 0x3A20);
    if (vp(listHolder)) {
      const begin = rd64(listHolder + 0x20), end = rd64(listHolder + 0x28);
      if (vp(begin) && end > begin && (end - begin) <= 0x8000) {
        for (let p = begin; p < end && !MGR; p += 8) {
          const node = rd64(p);
          if (!vp(node)) continue;
          const cand = rd64(node) - 0x358;             // node[0] = HUDMGR+0x358
          if (vp(cand) && rd64(cand) === HUDMGR_VT) { MGR = cand; how = 'AREA_HUB'; }
        }
      }
    }
  }
  // -- anchor 2: UI_TREE -- walk getUiRoot(); census the atlas MapUIWidget + HUDMGR vtables. Report
  // whether the tree was EXHAUSTED (stack emptied) vs CAPPED, so "not found" is unambiguous.
  let uiN = 0, uiCap = 40000, capHit = false, widgetSeen = 0, mgrSeen = 0, widgetPath = '';
  if (!MGR) {
    const root = uiRoot(poe2);
    if (root) {
      const stack = [{ el: root, path: [] }];
      while (stack.length) {
        if (uiN >= uiCap) { capHit = true; break; }
        const { el, path } = stack.pop(); uiN++;
        if (!vp(el)) continue;
        const vt = rd64(el);
        if (vt === HUDMGR_VT && !MGR) { MGR = el; how = 'UI_TREE(self)'; }
        if (vt === WIDGET_VT) {
          widgetSeen++; if (!widgetPath) widgetPath = path.join(',');
          const gp = rd64(el + 0x368), parent = rd64(gp + 0x488), h = rd64(parent + 0x3E0);
          if (vp(h) && rd64(h) === HUDMGR_VT && !MGR) { MGR = h; how = `UI_TREE[${path.join(',')}]`; }
        }
        const ch = uiChildren(poe2, el);
        for (let i = ch.length - 1; i >= 0; i--) stack.push({ el: ch[i], path: path.concat(i) });
      }
    }
    console.log(`  UI walk: scanned ${uiN} nodes (${capHit ? 'CAPPED at ' + uiCap + ' -- tree bigger' : 'EXHAUSTED whole tree'}); MapUIWidget(${hex(WIDGET_VT)}) seen=${widgetSeen}${widgetPath ? ' @[' + widgetPath + ']' : ''}; HUDMGR self-seen=${mgrSeen}`);
  }

  if (!MGR) {
    // ai-shape diagnostic: find which offset on getAreaInstance() holds a hub (a ptr whose +0x3A20 is a ptr).
    const probes = [];
    for (let off = 0x100; off <= 0x400; off += 8) {
      const v = rd64(ai + off);
      if (vp(v) && vp(rd64(v + 0x3A20))) probes.push(`+0x${off.toString(16)}->${hex(v)}`);
    }
    console.log(`  ai+0x1B0(hub)=${hex(hub)} (0 => getAreaInstance() is NOT HUDMGR's area object). ` +
      `hub-like ptrs on ai: ${probes.length ? probes.slice(0, 8).join(' ') : '(none in 0x100..0x400)'}`);
    console.log(`  HUDMGR not found (vtable ${hex(HUDMGR_VT)}). If MapUIWidget seen=0 and tree EXHAUSTED, the atlas map widget is torn down while in-map -> the full set lives elsewhere; tell me and I pivot to the in-map source.`);
    return;
  }

  const mgrAi = rd64(MGR + 0x320);
  // hub belongs to HUDMGR's OWN area object (MGR+0x320), not necessarily getAreaInstance()
  const mgrHub = vp(mgrAi) ? rd64(mgrAi + 0x1B0) : 0;
  console.log(`  HUDMGR=${hex(MGR)} (${how})  +0x320=${hex(mgrAi)} ${mgrAi === ai ? '(==getAreaInstance OK)' : '(!= getAreaInstance)'}  hub=${hex(mgrHub)}`);

  // current area key = *(MGR+0x320)+0x1B0)+0x3E68 (two u32)
  let kLo = 0, kHi = 0;
  if (vp(mgrHub)) { kLo = rd32(mgrHub + 0x3E68); kHi = rd32(mgrHub + 0x3E68 + 4); }
  console.log(`  currentAreaKey={${kLo},${hex(kHi)}}`);

  const b = rd64(MGR + 0x10), e = rd64(MGR + 0x18), cnt = vp(b) && e > b ? (e - b) / 8 : 0;
  console.log(`  ${cnt} pinInfo(s) in HUDMGR vector:`);
  for (let i = 0; i < Math.min(cnt, 80); i++) {
    const pin = rd64(b + i * 8);
    if (!vp(pin)) { console.log(`    #${i} pin=${hex(pin)} (bad)`); continue; }
    const vb = rd64(pin + 0x368), ve = rd64(pin + 0x370);
    let setStr = `no/odd +0x368 vec (vb=${hex(vb)})`;
    if (vp(vb) && ve >= vb && (ve - vb) <= 120) {
      const c = ve - vb, bytes = [];
      for (let j = 0; j < c; j++) bytes.push(rd8(vb + j));
      setStr = `count=${c} EndgameMapContentIdx=[${bytes.join(',')}]`;
    }
    const wa = rd32(pin + 0x300);
    const pkLo = rd32(pin + 0x320), pkHi = rd32(pin + 0x324);
    const cur = (pkLo === kLo && pkHi === kHi) ? '  <== CURRENT AREA' : '';
    console.log(`    #${i} pin=${hex(pin)} key={${pkLo},${hex(pkHi)}} worldArea=${wa} ${setStr}${cur}`);
  }
}

function dumpSnapshot() {
  refresh(true);
  const m = _markers && _markers.ok ? (_markers.v || []) : [];
  const snap = {
    rebuilt: typeof poe2.nowMicros === 'function',
    markerCount: m.length,
    markers: m.slice(0, 80),
    tgt: _tgt && _tgt.ok ? { isValid: !!(_tgt.v && _tgt.v.isValid), names: Object.keys((_tgt.v && _tgt.v.locations) || {}) } : _tgt,
    objectives: _obj,
    mapInfo: _mapInfo,
  };
  console.log("[MARKERS] snapshot:\n" + jstr(snap));
}

export const bindingsTestPlugin = {
  onDraw: onDraw,
  onEnable() {
    _markers = null; _markersAt = 0; _tgt = null; _tgtAt = 0; _obj = null; _objAt = 0;
    _uiHits = null; _uiScanned = 0; _mapInfo = null;
    _maskTrack = null; _maskRuns = 0; _lastRevMask = 0;
    console.log("[MARKERS] enabled");
  },
  onDisable() { console.log("[MARKERS] disabled"); }
};

console.log("[MapMarkers] Plugin loaded (disabled by default; enable in Plugin Browser)");

/**
 * ui_tree.js — JS toolkit for navigating PoE2's UI tree + game structs.
 *
 * Built on the native exploration primitives added 2026-06-02 (REQUIRES a DLL rebuild from that
 * date or later): poe2.getInGameState(), getUiRoot(), getAreaInstance(), readWideString(addr),
 * readWideStringPtr(addr), readCString(addr), plus the existing readMemory().
 *
 * With these you can read ANY UI panel / game struct from JS without new native code.
 * See docs/js_api_quest_area_transitions_RE.md for the verified offsets used below.
 *
 * Pass your POE2 instance (`const poe2 = new POE2()`) to each function.
 */

// ── UI element layout (verified) ──
//   children StdVector {first,last} @ element +0x10 / +0x18 (8-byte child pointers)
//   visibility flag @ element +0x180, bit 0x0B
//   text: objectives panel uses Text16Ptr @ +0x588; label elements use +0x390

export function uiRoot(poe2) { return poe2.getUiRoot ? (poe2.getUiRoot() || 0) : 0; }

export function uiChildren(poe2, el) {
  const out = [];
  if (!el) return out;
  const first = poe2.readMemory(el + 0x10, 'int64');
  const last = poe2.readMemory(el + 0x18, 'int64');
  if (first && last > first) {
    let n = (last - first) / 8;
    if (n > 500) n = 500;
    for (let i = 0; i < n; i++) {
      const c = poe2.readMemory(first + i * 8, 'int64');
      if (c) out.push(c);
    }
  }
  return out;
}

/** Navigate by child indices, e.g. uiNav(poe2, root, [22,7,1,3]). Returns 0 on bad index. */
export function uiNav(poe2, root, idxs) {
  let cur = root;
  for (const i of idxs) {
    const ch = uiChildren(poe2, cur);
    if (i < 0 || i >= ch.length) return 0;
    cur = ch[i];
  }
  return cur;
}

export function uiVisible(poe2, el) {
  if (!el) return false;
  const f = poe2.readMemory(el + 0x180, 'uint32');
  return (f & (1 << 0x0B)) !== 0;
}

/** Text at a Text16Ptr field on an element (deref). off = 0x588 (objectives) or 0x390 (labels). */
export function uiText(poe2, el, off) {
  if (!el) return '';
  return poe2.readWideStringPtr(el + off) || '';
}

// ── Quests (verified paths — see docs §4) ──
// Tracker (always-on HUD): root[7][1][0][0][0]; full list (quest map open): root[22][7][1][3].

/** Read the full quest list from the quest-map panel (only populated while the quest map is OPEN). */
export function getQuestList(poe2) {
  const root = uiRoot(poe2);
  if (!root) return [];
  const list = uiNav(poe2, root, [22, 7, 1, 3]);
  const quests = [];
  for (const e of uiChildren(poe2, list)) {
    // id @ +0x2e0 is ptr -> ptr -> wchar* : read the inner pointer, then readWideStringPtr
    const idPtr = poe2.readMemory(e + 0x2e0, 'int64');
    const id = idPtr ? (poe2.readWideStringPtr(idPtr) || '') : '';
    const titleEl = uiNav(poe2, e, [0, 0, 0]);
    const objEl = uiNav(poe2, e, [0, 0, 1]);
    const name = titleEl ? uiText(poe2, titleEl, 0x390) : '';
    const objective = objEl ? uiText(poe2, objEl, 0x390) : '';
    if (id || name) quests.push({ id, name, currentObjective: objective });
  }
  return quests;
}

/** Read the always-on quest tracker (tracked quests on the HUD). */
export function getTrackedQuests(poe2) {
  const root = uiRoot(poe2);
  if (!root) return [];
  const tracker = uiNav(poe2, root, [7, 1, 0, 0, 0]);
  const out = [];
  for (const q of uiChildren(poe2, tracker)) {
    const idPtr = poe2.readMemory(q + 0x338, 'int64');
    const id = idPtr ? (poe2.readWideStringPtr(idPtr) || '') : '';
    // title label is a descendant; commonly q.0.0.0 +0x390
    const titleEl = uiNav(poe2, q, [0, 0, 0]);
    const name = titleEl ? uiText(poe2, titleEl, 0x390) : '';
    if (id || name) out.push({ id, name });
  }
  return out;
}

// ── Entity components (the lookup walk, verified) ──
//   EntityData   = *(entity + 0x08)
//   compHead     = *(entity + 0x10)                       (component-pointer StdVector head)
//   Lookup       = *(EntityData + 0x28)
//   bucket       = {first,last} @ Lookup+0x28 / +0x30     (16-byte entries {name_ptr, idx, pad})
//   componentPtr = *(compHead + idx * 8)
// With a component pointer + ReClass offsets you can read any component field for a condition, e.g.
//   const life = getComponent(poe2, target.address, 'Life');
//   const cur  = life ? poe2.readMemory(life + 0xNN, 'int32') : 0;   // 0xNN from ReClass

function _walkComponents(poe2, entity, onEntry) {
  if (!entity) return;
  const ed = poe2.readMemory(entity + 0x08, 'int64'); if (!ed) return;
  const head = poe2.readMemory(entity + 0x10, 'int64'); if (!head) return;
  const look = poe2.readMemory(ed + 0x28, 'int64'); if (!look) return;
  const bb = poe2.readMemory(look + 0x28, 'int64');
  const be = poe2.readMemory(look + 0x30, 'int64');
  if (!bb || be <= bb) return;
  let n = (be - bb) / 16; if (n > 128) n = 128;   // bounded (watchdog safety)
  for (let i = 0; i < n; i++) {
    const np = poe2.readMemory(bb + i * 16, 'int64');
    const idx = poe2.readMemory(bb + i * 16 + 8, 'int32');
    if (!np || idx < 0) continue;
    const name = poe2.readCString(np) || '';
    if (!name) continue;
    const cp = poe2.readMemory(head + idx * 8, 'int64') || 0;
    if (onEntry(name, cp)) return;   // return true to stop early
  }
}

/** Pointer to a named component on an entity (0 if absent). e.g. getComponent(poe2, e.address, 'Life'). */
export function getComponent(poe2, entity, name) {
  let found = 0;
  _walkComponents(poe2, entity, (n, cp) => { if (n === name) { found = cp; return true; } return false; });
  return found;
}

/** Map of { componentName: pointer } for an entity — handy for RE/discovery. */
export function listComponents(poe2, entity) {
  const out = {};
  _walkComponents(poe2, entity, (n, cp) => { out[n] = cp; return false; });
  return out;
}

// ── Area entity maps (awake/sleeping) — full enumeration, bypasses the getEntities 128-cap ──
// AreaInstance = poe2.getAreaInstance()  [= *(InGameState + 0x290)]
//   awake std::map   @ AreaInstance + 0x6c0
//   sleeping std::map@ AreaInstance + 0x6d0
// std::map node layout (MSVC): left@+0x00, parent@+0x08, right@+0x10, _isnil@+0x19,
//   key(id)@+0x20, value(entity*)@+0x28.  root = *(mapHead + 0x08).
// NOTE: there is NO flat "transitions" array on AreaInstance — transitions are ENTITIES in these
// maps (each has an AreaTransition component). For exits with positions, prefer poe2.getAreaTransitions().

/** Walk a std::map of entities. mapHead = AreaInstance + 0x6c0 (awake) or +0x6d0 (sleeping). */
export function walkEntityMap(poe2, mapHead, max = 5000) {
  const out = [];
  if (!mapHead) return out;
  const head = poe2.readMemory(mapHead, 'int64');         // _Myhead sentinel
  if (!head) return out;
  const root = poe2.readMemory(head + 0x08, 'int64');     // sentinel._Parent = root
  if (!root || root === head) return out;
  const stack = [root];
  const seen = new Set();
  while (stack.length && out.length < max) {
    const n = stack.pop();
    if (!n || n === head || seen.has(n)) continue;
    seen.add(n);
    if (poe2.readMemory(n + 0x19, 'uint8')) continue;     // _isnil
    const ent = poe2.readMemory(n + 0x28, 'int64');
    if (ent) out.push(ent);
    const l = poe2.readMemory(n + 0x00, 'int64');
    const r = poe2.readMemory(n + 0x10, 'int64');
    if (l && l !== head) stack.push(l);
    if (r && r !== head) stack.push(r);
  }
  return out;
}

/** Every entity in the current area (awake + sleeping) — no 128-cap. Bound your per-frame work! */
export function allAreaEntities(poe2, max = 8000) {
  const ai = poe2.getAreaInstance ? poe2.getAreaInstance() : 0;
  if (!ai) return [];
  return walkEntityMap(poe2, ai + 0x6c0, max).concat(walkEntityMap(poe2, ai + 0x6d0, max));
}

/** Pure-JS transition destinations (mirror of native getAreaTransitions, minus position). For
 *  positions use poe2.getAreaTransitions() (it reads the Render component for you). */
export function getTransitionDestinations(poe2) {
  const out = [];
  for (const ent of allAreaEntities(poe2)) {
    const at = getComponent(poe2, ent, 'AreaTransition');
    if (!at) continue;
    const row = poe2.readMemory(at + 0x48, 'int64');      // -> destination WorldArea row
    if (!row) { out.push({ address: ent }); continue; }
    out.push({
      address: ent,
      destinationAreaId: poe2.readMemory(row + 0x00, 'wstringptr') || '',   // row id   @ +0x00
      destinationAreaName: poe2.readMemory(row + 0x08, 'wstringptr') || '', // row name @ +0x08
      destinationAct: poe2.readMemory(row + 0x10, 'int32'),                 // row act  @ +0x10
    });
    if (out.length >= 256) break;
  }
  return out;
}

// ── Pattern scanning / global resolution (requires native poe2.patternScan; rebuild 2026-06-02+) ──
// SCAN ONCE AND CACHE the result — never call patternScan every frame (deadlock watchdog).

/**
 * Resolve a RIP-relative global found by a code pattern.
 *   pattern   IDA-style bytes, e.g. "48 8B 05 ? ? ? ?"  (mov reg,[rip+disp])
 *   dispOff   byte offset of the disp32 within the match (3 for the example above)
 *   instrLen  total instruction length / disp end       (7 for the example above)
 * Returns the absolute global address, or 0 if not found.
 * Example (the GameState global): scanRipGlobal(poe2, "83 ? ? ? 8B ? 33 ? ? 39 2D ? ? ? ? 0F 85", 11, 15)
 */
export function scanRipGlobal(poe2, pattern, dispOff, instrLen) {
  if (typeof poe2.patternScan !== 'function') return 0;
  const m = poe2.patternScan(pattern);
  if (!m) return 0;
  const disp = poe2.readMemory(m + dispOff, 'int32');
  return m + instrLen + disp;
}

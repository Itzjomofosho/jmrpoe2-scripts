/**
 * Inventory module — read inventories, enumerate stash tabs, move items, check space.
 * For pickit / stash / restock / viewer plugins.
 *
 *   import { readInventory, getStashTabs, moveToStash, canFit, findByName, getMods } from './inventory.js';
 *
 * HOW MOVES WORK: crafted packets via poe2.sendPacket (game encrypts+sends), view-independent.
 *   into-stash   (op 0x0100): 01 00 01 <tabId:htons> <handle:htonl> 00 <rx> <ry> 00*8
 *   out-of-stash (op 0x0105): 01 05 01 <tabId:htons> <handle:htonl> 00 <rx> <ry>
 *   - tabId  = the stash tab's move id = its dense index in the tab table (see getStashTabs).
 *   - handle = the item's per-inventory handle (getInventory item.itemSlotHandle).
 *   - rx/ry  = within-slot click point; MUST be randomized per move (anti-detection, randClickAxis).
 *
 * Stash tab table: PSD = getInventory(id).playerServerDataAddr; holder = *(PSD+0x1B0); per-tab
 * record array {begin,end} = *(holder+0x3A90), 104-byte entries (name@+0x8, invId@+0x28, type@+0x34);
 * the move tabId = the entry's dense index.
 *
 * NOTE: in-grid reposition + swap are NOT possible (cursor/hover-coupled; the pickup packet is
 * stream-quantized + un-replayable — replaying it disconnects the client). Don't attempt it.
 */

import { poe2 } from './poe2_cache.js';

// Common inventory ids (client InventoryType). Stash tabs show up as high "Unknown" ids.
export const INV = {
  MAIN: 1, BODY: 2, WEAPON1: 3, OFFHAND1: 4, HELM: 5, AMULET: 6,
  RING1: 7, RING2: 8, GLOVES: 9, BOOTS: 10, BELT: 11, FLASK: 12, CURSOR: 13,
};

// Equipment/main slot display names (stash tabs get their names from getStashTabs).
const INV_NAMES = {
  1: 'Backpack', 2: 'Body', 3: 'Weapon 1', 4: 'Offhand 1', 5: 'Helmet', 6: 'Amulet',
  7: 'Ring 1', 8: 'Ring 2', 9: 'Gloves', 10: 'Boots', 11: 'Belt', 12: 'Flasks', 13: 'Cursor',
};
export function invName(id) { return INV_NAMES[id] || `Inventory ${id}`; }

const DEFAULT_W = 12, DEFAULT_H = 5;   // main backpack fallback dims

function rd(addr, type) { try { return poe2.readMemory(addr, type); } catch (e) { return null; } }

/**
 * Read an inventory, normalized. Returns null, or
 * { invId, width, height, items: [{ base, path, unique, rarity, stack, identified, x, y, w, h, ex, ey, addr, handle }] }.
 * `handle` is the move handle (getInventory item.itemSlotHandle == InventoryItemStruct+0x18; live-verified).
 * MUST use getInventory — getMainInventory does NOT expose itemSlotHandle.
 */
export function readInventory(invId) {
  const inv = poe2.getInventory(invId);
  if (!inv || !inv.isValid) return null;
  const items = (inv.items || []).map(function (it) {
    return {
      base: it.baseName, path: it.itemPath, unique: it.uniqueName,
      rarity: it.rarity, stack: it.stackSize, identified: it.isIdentified,
      x: it.slotX, y: it.slotY, w: it.width, h: it.height, ex: it.slotEndX, ey: it.slotEndY,
      addr: it.itemAddress, handle: it.itemSlotHandle,
    };
  });
  return { invId: invId, width: inv.totalBoxesX || DEFAULT_W, height: inv.totalBoxesY || DEFAULT_H, items: items };
}

/** Find the item whose top-left cell is (x,y). null if none. */
export function itemAtGrid(invId, gridX, gridY) {
  const inv = readInventory(invId);
  if (!inv) return null;
  for (let i = 0; i < inv.items.length; i++) { const it = inv.items[i]; if (it.x === gridX && it.y === gridY) return it; }
  return null;
}

// ===================== occupancy / fit =====================

/** Occupancy grid for an inventory: { width, height, occupied:bool[] } (row-major) or null. */
export function buildOccupancyGrid(invId) {
  const inv = readInventory(invId);
  if (!inv) return null;
  const W = inv.width, H = inv.height;
  const occ = new Array(W * H).fill(false);
  for (let i = 0; i < inv.items.length; i++) {
    const it = inv.items[i];
    const x1 = (it.ex != null && it.ex > it.x) ? it.ex : it.x + (it.w || 1);
    const y1 = (it.ey != null && it.ey > it.y) ? it.ey : it.y + (it.h || 1);
    for (let y = it.y; y < y1 && y < H; y++) for (let x = it.x; x < x1 && x < W; x++) if (x >= 0 && y >= 0) occ[y * W + x] = true;
  }
  return { width: W, height: H, occupied: occ };
}

/** Free-space summary: { width, height, freeSlots, totalSlots, occupied:bool[] }. */
export function freeSlots(invId) {
  if (invId == null) invId = INV.MAIN;
  const g = buildOccupancyGrid(invId);
  if (!g) return { width: 0, height: 0, freeSlots: 0, totalSlots: 0, occupied: [] };
  let free = 0; for (let i = 0; i < g.occupied.length; i++) if (!g.occupied[i]) free++;
  return { width: g.width, height: g.height, freeSlots: free, totalSlots: g.occupied.length, occupied: g.occupied };
}

/** First top-left cell where a gridW x gridH item fits. {x,y} or null. */
export function firstFreeSlot(gridW, gridH, invId) {
  if (invId == null) invId = INV.MAIN;
  const g = buildOccupancyGrid(invId);
  if (!g) return null;
  const W = g.width, H = g.height, w = gridW || 1, h = gridH || 1;
  for (let y = 0; y + h <= H; y++) {
    for (let x = 0; x + w <= W; x++) {
      let ok = true;
      for (let yy = y; yy < y + h && ok; yy++) for (let xx = x; xx < x + w; xx++) if (g.occupied[yy * W + xx]) { ok = false; break; }
      if (ok) return { x: x, y: y };
    }
  }
  return null;
}

/** Does a gridW x gridH item fit? Fail-OPEN (true) if the inventory can't be read (pickit relies on this). */
export function canFit(gridW, gridH, invId) {
  if (invId == null) invId = INV.MAIN;
  if (buildOccupancyGrid(invId) == null) return true;
  return firstFreeSlot(gridW, gridH, invId) !== null;
}

// ===================== find / filter / mods =====================

export function findItems(invId, predicate) { const inv = readInventory(invId); return inv ? inv.items.filter(predicate) : []; }
export function findByName(invId, substr) {
  const s = String(substr).toLowerCase();
  return findItems(invId, function (it) {
    return (it.unique && it.unique.toLowerCase().indexOf(s) >= 0) ||
           (it.base && it.base.toLowerCase().indexOf(s) >= 0) ||
           (it.path && it.path.toLowerCase().indexOf(s) >= 0);
  });
}
export function findByPath(invId, substr) { const s = String(substr).toLowerCase(); return findItems(invId, function (it) { return it.path && it.path.toLowerCase().indexOf(s) >= 0; }); }
export function findByRarity(invId, minRarity) { return findItems(invId, function (it) { return (it.rarity || 0) >= minRarity; }); }

/**
 * Item mods/flags. Accepts an item object (uses .addr/.itemAddress) or a raw address. Returns the
 * poe2.getItemMods shape: { isValid, rarity, rarityName, identified, corrupted, twiceCorrupted,
 * duplicated, split, relic, synthetic, fractured, shaperItem, elderItem, requiredLevel,
 * generationLevel, implicitMods[], explicitMods[], enchantMods[], hellscapeMods[] } (mods: {name,value0,value1}).
 */
export function getMods(addrOrItem) {
  const addr = (addrOrItem && typeof addrOrItem === 'object') ? (addrOrItem.addr != null ? addrOrItem.addr : addrOrItem.itemAddress) : addrOrItem;
  if (addr == null) return { isValid: false };
  try { return poe2.getItemMods(addr) || { isValid: false }; } catch (e) { return { isValid: false }; }
}

/** Flat dump for stash/restock consumers: [{ name, path, rarity, stack, x, y, w, h, handle }]. */
export function dumpInventory(invId) {
  const inv = readInventory(invId);
  if (!inv) return [];
  return inv.items.map(function (it) {
    return { name: it.unique || it.base, path: it.path, rarity: it.rarity, stack: it.stack, x: it.x, y: it.y, w: it.w, h: it.h, handle: it.handle };
  });
}

// ===================== moves =====================

// ANTI-DETECTION (per JMR, account-critical): the within-slot click point MUST be randomized per
// move — GGG flags sending the SAME point on every move as a bot signature. Never hardcode it.
// Triangular ~[20,235] spread (avg of 2 uniforms): center-biased, never exact edges.
function randClickAxis() { const r = (Math.random() + Math.random()) / 2; let v = 20 + Math.floor(r * 215); if (v < 20) v = 20; else if (v > 235) v = 235; return v & 0xFF; }

function buildMovePacket(dir, tabId, handle) {
  const tb = (tabId >> 8) & 0xFF, tl = tabId & 0xFF;
  const h0 = (handle >>> 24) & 0xFF, h1 = (handle >>> 16) & 0xFF, h2 = (handle >>> 8) & 0xFF, h3 = handle & 0xFF;
  const px = randClickAxis(), py = randClickAxis();
  if (dir === 'in') return new Uint8Array([0x01, 0x00, 0x01, tb, tl, h0, h1, h2, h3, 0x00, px, py, 0, 0, 0, 0, 0, 0, 0, 0]);
  return new Uint8Array([0x01, 0x05, 0x01, tb, tl, h0, h1, h2, h3, 0x00, px, py]);
}

/** Move an item by handle. dir 'in' (->stash) / 'out' (->inventory); tabId may be a tab NAME. */
export function moveByHandle(dir, tabId, handle) {
  if (typeof tabId === 'string') tabId = tabIdByName(tabId);
  if (handle == null || tabId == null) return false;
  return !!poe2.sendPacket(buildMovePacket(dir, tabId, handle));
}

/** Move the main-inventory item at grid (x,y) INTO stash tab `tabId` (number or name). */
export function moveToStash(gridX, gridY, tabId) {
  const it = itemAtGrid(INV.MAIN, gridX, gridY);
  if (!it || it.handle == null) return false;
  return moveByHandle('in', tabId, it.handle);
}

/** Move the item at grid (x,y) of LOADED stash-tab inventory `tabInvId` OUT to the main inventory.
 *  tabId auto-resolves from tabInvId if omitted. Returns false if the tab isn't loaded / cell empty. */
export function moveFromStash(tabInvId, gridX, gridY, tabId) {
  if (tabId == null) tabId = tabIdForInv(tabInvId);
  const it = itemAtGrid(tabInvId, gridX, gridY);
  if (!it || it.handle == null) return false;
  return moveByHandle('out', tabId, it.handle);
}

/** Move every item in srcInvId matching predicate. dir 'in'/'out', tabId number or name. Returns moved count. */
export function moveMatching(srcInvId, dir, tabId, predicate) {
  const inv = readInventory(srcInvId);
  if (!inv) return 0;
  let moved = 0;
  for (let i = 0; i < inv.items.length; i++) {
    const it = inv.items[i];
    if (it.handle != null && (!predicate || predicate(it)) && moveByHandle(dir, tabId, it.handle)) moved++;
  }
  return moved;
}

// ===================== stash tab table =====================

const PSD_HOLDER = 0x1B0, TAB_ARR = 0x3A90, TAB_STRIDE = 104, TAB_NAME = 0x08, TAB_INVID = 0x28, TAB_TYPE = 0x34;
let _tabsCache = null, _tabsCacheTime = 0;

function rd16(a) { const v = rd(a, 'int32'); return v == null ? null : (v & 0xFFFF); }
function looksPtr(v) { return v != null && v > 0x10000000000 && v < 0x800000000000; }
function readWStr(a) {
  if (a == null) return '';
  let s = '';
  for (let i = 0; i < 32; i++) { const c = rd16(a + i * 2); if (c == null || c === 0) break; s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '?'; }
  return s;
}
function tabName(rec) {
  const q = rd(rec + TAB_NAME, 'int64');   // names >= 8 chars spill to a heap ptr; shorter are inline
  if (looksPtr(q)) { const n = readWStr(q); if (n) return n; }
  return readWStr(rec + TAB_NAME);
}

/**
 * Full stash tab list incl unloaded tabs: [{ tabId, name, invId, type, loaded }].
 * tabId = move-packet [3,4] value (dense index); invId = client inventory id (0 until viewed).
 * Cached ~800ms; pass force=true to bypass.
 */
export function getStashTabs(force) {
  const now = Date.now();
  if (!force && _tabsCache && (now - _tabsCacheTime) < 800) return _tabsCache;
  const out = [];
  const main = poe2.getInventory(INV.MAIN);
  const psd = main && main.playerServerDataAddr;
  if (psd) {
    const holder = rd(psd + PSD_HOLDER, 'int64');
    if (holder) {
      let begin = null, end = null;
      for (let cat = 0; cat < 8; cat++) {                 // pick the category whose array is a valid 104-stride list
        const b = rd(holder + 24 * cat + TAB_ARR, 'int64'), e = rd(holder + 24 * cat + TAB_ARR + 8, 'int64');
        if (b && e && e > b) { const n = (e - b) / TAB_STRIDE; if (n === Math.floor(n) && n > 0 && n < 500) { begin = b; end = e; break; } }
      }
      if (begin != null) {
        const count = (end - begin) / TAB_STRIDE;
        for (let i = 0; i < count; i++) {
          const rec = begin + i * TAB_STRIDE;
          const invId = rd(rec + TAB_INVID, 'int32') || 0;
          out.push({ tabId: i, name: tabName(rec), invId: invId, type: rd(rec + TAB_TYPE, 'int32'), loaded: invId !== 0 });
        }
      }
    }
  }
  _tabsCache = out; _tabsCacheTime = now;
  return out;
}

/** Resolve a tab's move tabId by name (case-insensitive). null if not found. */
export function tabIdByName(name) {
  const want = String(name).toLowerCase();
  const t = getStashTabs().filter(function (x) { return x.name.toLowerCase() === want; })[0];
  return t ? t.tabId : null;
}

/** Resolve a tab's move tabId by its (loaded) client inventory id. null if not found/loaded. */
export function tabIdForInv(invId) {
  const t = getStashTabs().filter(function (x) { return x.invId === invId; })[0];
  return t ? t.tabId : null;
}

/**
 * LOADED stash-tab inventories (readable item data), enriched with tabId + name where known.
 * Returns [{ invId, count, tabId, name }]. Includes the personal stash tabs (named, with tabId)
 * plus other high-id stash-side inventories like the relic locker (tabId/name null).
 * Use getStashTabs() for the full (incl. unloaded) list.
 */
export function findStashTabs() {
  const byInv = {};
  const named = getStashTabs();
  for (let i = 0; i < named.length; i++) if (named[i].invId) byInv[named[i].invId] = named[i];
  const all = poe2.getAllInventories();
  const tabs = [];
  for (let i = 0; i < all.length; i++) {
    const inv = all[i];
    const meta = byInv[inv.inventoryId];
    const isStashLike = meta != null || inv.inventoryId > 120;   // personal tabs OR other high "unknown" stash inventories
    if (isStashLike && inv.items && inv.items.length > 0) {
      tabs.push({ invId: inv.inventoryId, count: inv.items.length, tabId: meta ? meta.tabId : null, name: meta ? meta.name : null });
    }
  }
  return tabs;
}

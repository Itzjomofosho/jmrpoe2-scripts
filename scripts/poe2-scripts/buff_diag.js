/**
 * Buff Diagnostic
 *
 * Logs player + rare/unique mob buffs at a configurable interval. Use to
 * identify buff names for rotation conditions (e.g. channel-window buffs like
 * `channelling_seconds`, CC buffs on mobs like `frozen` / `chilled`).
 *
 * Disabled by default. To enable: import + register in main.js, e.g.
 *   import { buffDiagPlugin } from './buff_diag.js';
 *   Plugins.register("buff_diag", buffDiagPlugin, false);
 *
 * Filter logs by [BUFFDIAG].
 */

import { POE2Cache, poe2 } from './poe2_cache.js';

const INTERVAL_MS = 250;
const MAX_RARE_MOBS = 5;
const ONLY_ON_CHANGE = true;  // false = log every tick (catches transient buffs)

let lastDumpAt = 0;
let lastPlayerKey = '';
const lastMobKeyByAddr = new Map();

function fmtBuffs(buffs) {
  if (!buffs || buffs.length === 0) return '(none)';
  return buffs.map(b => {
    const tl = (b.timeLeft || 0).toFixed(2);
    return (b.charges > 0) ? `${b.name}|${tl}s|c=${b.charges}` : `${b.name}|${tl}s`;
  }).join(', ');
}

function buffSetKey(buffs) {
  return (!buffs || buffs.length === 0) ? '' : buffs.map(b => b.name).sort().join('|');
}

function dump() {
  const now = Date.now();
  if (now - lastDumpAt < INTERVAL_MS) return;
  lastDumpAt = now;

  const player = POE2Cache.getLocalPlayer();
  if (player) {
    const k = buffSetKey(player.buffs);
    if (!ONLY_ON_CHANGE || k !== lastPlayerKey) {
      console.log(`[BUFFDIAG] PLAYER hp=${player.healthCurrent||0}/${player.healthMax||0} buffs(${(player.buffs||[]).length}): ${fmtBuffs(player.buffs)}`);
      lastPlayerKey = k;
    }
  }

  let entities;
  try {
    entities = poe2.getEntities({ lightweight: true, includeBuffs: true });
  } catch (e) { return; }
  if (!entities) return;

  const rares = [];
  for (const e of entities) {
    if (e.entityType !== 'Monster' || !e.isAlive) continue;
    if (typeof e.rarity !== 'number' || e.rarity < 2) continue;
    rares.push(e);
    if (rares.length >= MAX_RARE_MOBS) break;
  }

  // Drop stale dedupe entries
  const seen = new Set();
  for (const m of rares) seen.add(m.address);
  for (const addr of lastMobKeyByAddr.keys()) {
    if (!seen.has(addr)) lastMobKeyByAddr.delete(addr);
  }

  for (const m of rares) {
    const k = buffSetKey(m.buffs);
    const prev = lastMobKeyByAddr.get(m.address);
    if (!ONLY_ON_CHANGE || k !== prev) {
      const rstr = m.rarity === 3 ? 'UNIQUE' : 'RARE';
      console.log(`[BUFFDIAG] ${rstr} ${m.name||'?'} hp=${m.healthCurrent||0}/${m.healthMax||0} buffs(${(m.buffs||[]).length}): ${fmtBuffs(m.buffs)}`);
      lastMobKeyByAddr.set(m.address, k);
    }
  }
}

export const buffDiagPlugin = {
  onDraw() { dump(); }
};

console.log("[BuffDiag] Plugin loaded (disabled by default; enable in Plugin Browser to log buffs)");

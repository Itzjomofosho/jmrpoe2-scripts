/**
 * movement_broker.js — MOVEMENT BROKER (MB) (mapper split, Phase 1).
 *
 * Bus pattern: never imports mapper — the [MB] BLOCK log line goes through mbConfigure({ log }).
 */

let _log = (msg) => { try { console.log(`[Mapper] ${msg}`); } catch (_) {} };
export function mbConfigure(bus) { if (bus && typeof bus.log === 'function') _log = bus.log; }

// ===== MOVEMENT BROKER (user: 'one movement writer at a time, THREAD SAFE') =====
// Every movement send funnels through the five primitives in mapper; the broker gates them all. Each subsystem
// declares itself the current WRITER at its entry point (MB.set); a send is allowed unless a STRICTLY
// higher-priority owner has sent within the ownership window. Ladder: dodge(1) > fight(2) > content(3) >
// utility(4) > nav/explore(5). Blocking startWalkingTo too makes target-name theft (the foreign-path
// false-ban class) mechanically impossible.
// ALWAYS ENFORCED (user: no setting, no shadow mode): lower-priority sends are dropped for the window (700ms).
// STEP-2 (claim-first): subsystems ASK for the writer slot up front via request() instead of declaring
// ambiently and having every send silently dropped -- a denial means PAUSE (freeze your clocks, keep your
// target, retry next frame), so preemption can never burn a ban/stall timer (commitment discipline).
// set() stays as the migration shim for writers not yet converted.
export const MB = {
  cur: { owner: 'nav', prio: 5 },
  hold: { owner: '', prio: 9, at: 0 },
  WINDOW: 700,
  logAt: 0,
  set(owner, prio) { this.cur.owner = owner; this.cur.prio = prio; },
  // Would a send by (owner, prio) pass right now? Read-only.
  avail(owner, prio) {
    const h = this.hold;
    return !(h.at && (Date.now() - h.at) < this.WINDOW && h.owner !== owner && h.prio < prio);
  },
  // Claim the writer slot. null = a strictly-higher-prio holder owns the window -> caller pauses.
  // The token's ok() flips false when another writer claims (preemption-as-revocation -- long loops
  // re-check between sends); end() releases back to the nav default.
  request(owner, prio) {
    if (!this.avail(owner, prio)) return null;
    this.set(owner, prio);
    const self = this;
    return {
      owner, prio,
      ok() { return self.cur.owner === owner && self.avail(owner, prio); },
      end() { if (self.cur.owner === owner) self.set('nav', 5); },
    };
  },
  gate() {
    const now = Date.now();
    const c = this.cur, h = this.hold;
    const blocked = h.at && (now - h.at) < this.WINDOW && h.owner !== c.owner && h.prio < c.prio;
    if (!blocked) { h.owner = c.owner; h.prio = c.prio; h.at = now; return true; }
    if (now - this.logAt > 1500) {
      this.logAt = now;
      _log(`[MB] BLOCK: ${c.owner}(p${c.prio}) vs holder ${h.owner}(p${h.prio})`);
    }
    return false;
  },
};

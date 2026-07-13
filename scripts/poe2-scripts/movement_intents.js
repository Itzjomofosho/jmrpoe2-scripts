/**
 * movement_intents.js — MOVEMENT INTENT RESOLVER (MI) (TASK-59R).
 *
 * ONE movement owner. Subsystems no longer call the walker primitives directly; they submit an
 * INTENT (walk / step / hold / nudge / direct / gridStep) tagged with an owner token, and the
 * resolver decides whether that owner drives this frame. The EXISTING rule set, consolidated
 * into one ladder (lower class number = higher priority):
 *
 *   1 dodge    — NOT submitted here. auto_dodge keeps its hard priority exactly as today:
 *                MB p1 + dodgeMoveSuppressUntil at the packet layer (the gated senders
 *                self-suppress). The resolver never delays or owns a dodge.
 *   2 fight    — boss-fight movement, posture steps, boss-death escapes.
 *   3 engaged  — engaged content: activated breach roam, opened verisium, hive defense,
 *                abyss node work, stone circle, essence fight, sbox/beacon event holds,
 *                rare/elite engage holds, delirium walk-ins, engaged-hold walk-backs (47-B class).
 *   4 committed— committed content walks (43-A/56-A hold semantics): arb drives/far-walks,
 *                revisit/cleanup/discover/required passes, abyss chest sweep, loot sweep, coverage.
 *   5 utility  — the utility state walks + detours + hv-insert (48-B pair).
 *   6 nav      — nav/boss explore, temple search, checkpoint/arena/melee approach legs,
 *                map-complete sweeps/portal walks.
 *   7 idle     — parity stop when nobody owns.
 *
 * Arbitration (hysteresis / min-dwell / defer-never-ban — HERE, once):
 *   - A strictly higher class preempts instantly (fight never waits on content).
 *   - While the standing winner is FRESH (submitted within GRACE) — or, for sticky intents,
 *     younger than MIN_DWELL — a DIFFERENT owner at the same-or-lower class is DEFERRED:
 *     no walker call happens, the call returns 'deferred', and the denial is recorded so
 *     runner clocks freeze (runnerSpanStolen / navMoveStolen consult miDeniedRecently).
 *     Deferred owners keep their target and re-submit next frame by construction.
 *   - A winner that stops submitting goes stale after GRACE and the next submitter takes over.
 *
 * The resolver is the ONLY caller of startWalkingTo / stepPathWalker / sendStopMovementLimited /
 * sendMoveAngleLimited / sendMoveGridLimited / moveTowardGridPos (injected via miConfigure —
 * the walker fns stay in mapper for now; Phase 4 moves them). MB stays underneath, untouched,
 * as the packet-level backstop; the callers' MB.set() declarations are unchanged.
 *
 * Bus pattern: never imports mapper — miConfigure({ log, exec }).
 */

let _log = (msg) => { try { console.log(`[Mapper] ${msg}`); } catch (_) {} };
let _exec = null;   // { startWalkingTo, stepPathWalker, stop, moveAngle, moveGrid, moveToward }
export function miConfigure(bus) {
  if (bus && typeof bus.log === 'function') _log = bus.log;
  if (bus && bus.exec) _exec = bus.exec;
}

// Owner token factory. Tokens are frozen little records so call sites stay greppable:
// MI.walk(MOV.breach, ...) — the token names the subsystem, the class ranks it.
export function miOwner(name, cls) { return Object.freeze({ o: name, c: cls }); }

export const MI = {
  GRACE: 450,        // ms: winner freshness window (~3 logic frames) — a live owner holds its claim
  MIN_DWELL: 700,    // ms: minimum tenure of a sticky winner before a same-class owner may take over
  win: null,         // { owner, cls, since, lastAt, tgt, sticky } — the standing winner
  denied: new Map(), // owner name -> last denied ts (defer-never-ban: clock-freeze source)
  spans: [],         // resolver's OWN ledger: [{ o, cls, t0, t1, tgt }] capped — who owned movement when
  _pairLogAt: new Map(),

  _endSpan(now) {
    const w = this.win;
    if (!w) return;
    this.spans.push({ o: w.owner, cls: w.cls, t0: w.since, t1: now, tgt: w.tgt || '' });
    if (this.spans.length > 60) this.spans.splice(0, this.spans.length - 60);
  },

  // Claim the movement frame for `own`. True = this owner drives; false = deferred.
  // One readable line per contested frame (throttled per owner-pair) replaces the [MB] BLOCK spam.
  claim(own, now, tgt, sticky) {
    const w = this.win;
    if (w && w.owner !== own.o) {
      const fresh = (now - w.lastAt) <= this.GRACE || (w.sticky && (now - w.since) <= this.MIN_DWELL);
      if (fresh && own.c >= w.cls) {
        this.denied.set(own.o, now);
        const pk = own.o + '<' + w.owner;
        if (now - (this._pairLogAt.get(pk) || 0) > 1500) {
          this._pairLogAt.set(pk, now);
          _log(`[MI] ${own.o}(c${own.c}) deferred: ${w.owner}(c${w.cls}) holds${w.tgt ? ` "${w.tgt}"` : ''}`);
        }
        return false;
      }
      if (fresh) _log(`[MI] ${own.o}(c${own.c}) preempts ${w.owner}(c${w.cls})${tgt ? ` -> "${tgt}"` : ''}`);
      this._endSpan(now);
      this.win = { owner: own.o, cls: own.c, since: now, lastAt: now, tgt: tgt || '', sticky: !!sticky };
    } else if (w) {
      w.lastAt = now; w.cls = own.c;
      if (tgt) w.tgt = tgt;
      if (sticky) w.sticky = true;
    } else {
      this.win = { owner: own.o, cls: own.c, since: now, lastAt: now, tgt: tgt || '', sticky: !!sticky };
    }
    return true;
  },

  // Set/refresh the shared walker target (startWalkingTo). Returns 'deferred' or the walker's return.
  walk(own, x, y, name, pathType) {
    if (!this.claim(own, Date.now(), name, true)) return 'deferred';
    return _exec ? _exec.startWalkingTo(x, y, name, pathType, own.o) : false;
  },

  // Step the shared path walker toward the current target. 'deferred' | 'no_path' | 'walking' | 'arrived' | 'stuck'.
  step(own) {
    if (!this.claim(own, Date.now(), null, true)) return 'deferred';
    return _exec ? _exec.stepPathWalker() : 'no_path';
  },

  // walk + step in one call (the dominant call-site pattern).
  walkStep(own, x, y, name, pathType) {
    const now = Date.now();
    if (!this.claim(own, now, name, true)) return 'deferred';
    if (_exec) _exec.startWalkingTo(x, y, name, pathType, own.o);
    return _exec ? _exec.stepPathWalker() : 'no_path';
  },

  // Plant (stop movement). Sticky: a hold IS a commitment (loot dwells must not be stolen by nav).
  hold(own, force) {
    if (!this.claim(own, Date.now(), null, true)) return 'deferred';
    return _exec ? _exec.stop(!!force) : false;
  },

  // Dislodge/burst heading (non-sticky: a nudge must not buy the owner a dwell).
  nudge(own, angleDeg, dist, force) {
    if (!this.claim(own, Date.now(), null, false)) return 'deferred';
    return _exec ? _exec.moveAngle(angleDeg, dist, !!force) : false;
  },

  // Raw grid heading (pack step-out etc.). Non-sticky.
  gridStep(own, dx, dy, force) {
    if (!this.claim(own, Date.now(), null, false)) return 'deferred';
    return _exec ? _exec.moveGrid(dx, dy, !!force) : false;
  },

  // Direct steer toward a point (moveTowardGridPos — wall-probe steering, no shared-target change).
  direct(own, px, py, tx, ty) {
    if (!this.claim(own, Date.now(), null, true)) return 'deferred';
    return _exec ? _exec.moveToward(px, py, tx, ty) : false;
  },

  // Was `owner` (or anyone, when owner omitted) denied the frame recently? Clock-freeze read.
  deniedRecently(now, ms, owner) {
    if (owner !== undefined) return (now - (this.denied.get(owner) || 0)) < ms;
    for (const t of this.denied.values()) if (now - t < ms) return true;
    return false;
  },

  // Explicit hand-back (optional — going silent for GRACE is equivalent).
  release(ownerName) {
    if (this.win && this.win.owner === ownerName) { this._endSpan(Date.now()); this.win = null; }
  },

  reset() {
    this.win = null;
    this.denied.clear();
    this.spans.length = 0;
    this._pairLogAt.clear();
  },

  status() {
    const w = this.win;
    return w ? `${w.owner}(c${w.cls})${w.tgt ? ` "${w.tgt}"` : ''}` : '-';
  },
};

# TASK-04 REPORT — Objective Broker: SHADOW registry (roadmap step 6)

**Status: implemented, `node --check` clean, not committed (runtime dir only). Zero behavioral writes.**

Pre-snapshot taken as FIRST ACT: `handoff/pre/TASK-04/mapper.js` (871,425 bytes, pre-edit). Diff vs it:
**+290 / −4 lines, one file.** The 4 deletions are the two pre-switch `if (… && runner(…)) return;` lines,
re-expanded into blocks around a boolean temp (control-flow identical, see *Parity* below).

Bridge not consulted: nothing in this task reads runtime state (the registry mirrors keys the mapper already holds).

---

## Files touched

`mapper.js` only. Nothing else — no C++, no `auto_dodge_core.js`, no tracked repo.

---

## What ships

### Constants (beside `MB`, search `OBJECTIVE BROKER (OB) -- SHADOW REGISTRY`)

| symbol | value | role |
|---|---|---|
| `OB_SHADOW` | `true` | Rollback kill-switch. `false` → every OB method returns immediately, `OB.cur` stays null, all `ob*()` adapters no-op. Object is delete-safe. |
| `OB_PRI` | `{mirror:1, required:2, rare:3, optional:4, utility:5, loot:6, explore:7}` | Cross-layer ladder, lower = stronger. `loot`/`explore` are declared but unclaimed this task (no instrumentation point). |
| `OB_STACK_MAX` | `2` | Pause-stack depth cap (per brief; see deviation 1). |
| `OB_MIRROR_CAP_MS` | `10000` | Mirrors `handleDeliriumMirror`'s owned no-consume cap. |
| `OB_ANCHOR_R` | `{abyss:130, 'incursion-beacon':25, breach2:25, mirror:12, rare:62, utility:20}` | Site radius, recorded for the step-8 walk-back. Unread this task. |
| `OB_MISS_MAX` | `3` | Stale-holder guard, counted in **missed logic passes**, never wall time (see *Stale guard*). |

### `const OB` — the registry

State: `cur` (the one commitment record | null), `stack` (preempted records, LIFO), `timerReg` (Map), `_log`
(line-class throttle), `_frzAt/_frzMs/_frzWhy`.

Methods (all searchable): `say`, `_flag`, `regTimer`, `reset`, `_mk`, `_banCheck`, `_pause`,
**`claim`**, **`pause`**, **`resume`**, **`complete`**, **`freezeTick`**, **`ownedTick`**.

### Commitment record as implemented (`OB._mk`)

```
{ id, layer, key, pri, anchorX, anchorY, anchorR, capMs,
  committedAt, ownedMs, frozenMs, pausedAt, pausedBy, pausedMs, _tr, _ownAt, _miss }
```

- `key` MIRRORS the layer-native key verbatim: `arbCommittedKey` / `String(rotRareId)` / `deliriumTargetKey` /
  `getUtilityTargetKey(selected)`. OB never writes any of them.
- `id` = `content:<arbKey>` | `rare:<id>` | `mirror:<gx,gy>` | `utility:<sig>`.
- `capMs` = the layer's own cap (`arbCommittedTtl`, `ROT_RARE_TIMEOUT`, `OB_MIRROR_CAP_MS`), used **only** to
  emit `would-ban-suppressed`.
- `ownedMs`: anchored records (content/mirror/utility) score owned **no-progress** ms via the existing
  `trackOwnedProgress`; the anchorless rare record (its target is a kill, not a position) scores plain owned ms.
  Gaps > 1s add 0 in both branches — a preemption can never charge a budget.
- **`done()` / `resume()` from the roadmap's record are NOT carried.** In shadow nothing may call them: `done()`
  runs layer predicates that mutate caches, `resume()` is by definition a behavioral write. They belong to step 7.

### Ladder semantics (the two rules that matter)

1. **Intra-layer swap is not a preemption.** `content→content` (arbiter re-commit) and `rare→rare` replace the
   record in place and log `complete … (layer-swap) -> claim=…`. Intra-content selection stays the arbiter's
   `ARB_MARGIN`/hysteresis business, untouched.
2. **A denied preemptor still takes the frame (shadow), so the holder is recorded as PAUSED, not abandoned.**
   `claim()` denies unless there is no holder or the holder is strictly weaker; on denial the adapter calls
   `OB.pause(layer)`. So a rare stealing a *required* content walk emits **both** `shadow-deny` (what flag-on would
   have done: defer) and `pause` (what reality did). This is the roadmap's intended inversion made visible —
   required(2) > rare(3) — and the same shape formalizes `_reqCommitted` for the utility detour (5).

`OB.complete()` clears the record and pops the stack. **No pick-next inside OB** — `arbTick`/`tryCleanupContent`
already pick every frame.

### Stale guard (an addition, justified)

`rotRareId` and `deliriumTargetKey` are only cleared by their own runners, and both hooks sit behind state guards
(boss engage, `MAP_COMPLETE`, `WALKING_TO_UTILITY`, a `runRunicSeals`/`exp2FarWalkYield` preempt). Without a guard,
a rare engaged just before `WALKING_TO_BOSS_MELEE` would hold `OB.cur` **forever** and shadow-deny every later
claim — including, in `MAP_COMPLETE`, a `shadow-deny content:X vs mirror:Y`, i.e. the exact trap the brief names.
`obReconcile` therefore retires a rare/mirror holder after `OB_MISS_MAX` consecutive logic passes in which its hook
did not stamp. **Counted in passes, not milliseconds, on purpose:** the opener/pickit yield `return`s before
`obTick`, so a 5s loot lock cannot age a record (a wall-clock version would have re-created the very bug class OB
exists to kill).

---

## Instrumentation points (symbol names, in execution order)

| # | Site (search string) | Call | Emits |
|---|---|---|---|
| 1 | `arbCommitTo` — last line | `obArbClaim(key, e, now, reason)` | `claim=content:<k> pri=2\|4 (fresh\|preempt)` |
| 2 | `arbRelease` — first line (before the key is cleared) | `obArbRelease(now)` | `complete content:<k> (arb-release)` |
| 3 | `resetMapper` — beside `arbReset()` | `obReset()` | — (per-map wipe) |
| 4 | move-lock yield, right after the delta-advance list, inside the `opener\|pickit` branch | `OB.freezeTick(now, moveLock.source)` | `would-freeze … by=opener\|pickit` |
| 5 | 7Hz logic pass, right after `trailRecord(...)` | `obTick(player, now)` | reconcile + `ownedTick` + `would-freeze … by=dodge` |
| 6 | pre-switch chain, `handleDeliriumMirror` call site | `obMirrorTick(_mirOwns, now)` | `claim=mirror:<gx,gy> pri=1` / `complete … (mirror-gone)` |
| 7 | pre-switch chain, `runClearNearbyRares` call site | `obRareTick(_rareOwns, now)` | `claim=rare:<id> pri=3` / `shadow-deny` / `complete … (rare-gone)` |
| 8 | right after the `arbFrozeAt` block (block itself untouched) | `OB.freezeTick(now, 'utility')` | `would-freeze … by=utility` |
| 9 | `startUtilityState` — last line | `obUtilityClaim(selected, Date.now())` | `claim=utility:<sig> pri=5` or `shadow-deny` + `pause` |
| 10 | `finishUtilityState` — first line | `obPreemptEnd('utility', Date.now())` | `complete utility:<sig>` or `resume <holder>` |

Adapters: `obArbClaim`, `obArbRelease`, `obRareTick`, `obMirrorTick`, `obUtilityClaim`, `obPreemptEnd`,
`obReconcile`, `obTick`, `obReset`.

## Timers registered (`OB.regTimer(name, get, set)`, 6 entries)

`deliriumTargetStart` · `rotRareStart` · `incursionCurStartAt` · `abyssDwell` · `abyssLootDwellAt` ·
`arbCommittedSince`

Accessor closures over the existing module `let`s, so no runner is touched. **In shadow the registry is a
manifest**: no getter is read, no setter is ever called (`freezeTick` only prints `timerReg.size`). Step 7 makes
`freezeTick` advance them and must disable the legacy delta-advance list + `arbFrozeAt` in the same flag branch —
both live = every window advances twice and never expires (roadmap conflict).

---

## Settings added

| name | default | what flips it |
|---|---|---|
| `objBroker` | `false` | Saved-settings edit only. **No UI control was added on purpose:** this build ignores the flag behaviorally, and a checkbox that does nothing invites a bogus live-test conclusion. It is read in exactly one place (`OB._flag()`), which appends ` flag=on(no-op)` to `claim`/`complete` lines so the combined test can confirm the flag plumbs through. TASK-05 gives it the UI + the behaviors. |

---

## Parity

- The only control-flow edit is the two pre-switch `if`s, re-expanded to `const _x = runner(...); obTick(_x, now); if (_x) return;`.
  Guard chain, short-circuit (runner not called when the guards fail), and both return paths are unchanged.
- Do-not-touch regions verified by targeted diff (zero matching diff lines): the opener/pickit delta-advance list
  (`abyssLootDwellAt +=`, `exp2LootedAt +=`, `hiveDefEndAt +=`, …), the `arbFrozeAt` freeze block
  (`arbCommittedSince +=`, `arbFrozeAt = now`), `_unexpCache`, `markFrontierVisited`.
- Every OB call is in statement position; none appears inside a condition. All adapters are `try`-guarded where they
  touch a layer helper (`arbPriClass`, `getUtilityTargetKey`).
- Perf: no entity scans, no bridge reads. Per 7Hz pass = one reconcile + one `Math.hypot` + one
  `trackOwnedProgress`. Per locked frame = ~5 arithmetic ops. Claims/completes are edge-triggered.
- Log throttle: `>=1s` per line class (`_log` Map). Repeating classes key by layer (`deny:rare`, `freeze:opener`,
  2s); edge events key by record id so two different claims within a second can never swallow each other.

---

## LIVE-TEST CHECKLIST

One mixed-content map. Watch `[Mapper] [M:<map>]` for `[OB]` lines. **Behavior must be identical to today** — this
is a logger.

**Working looks like a coherent narrative:**
- `[OB] claim=content:<key> pri=4 (fresh) key=<key>` when the arbiter commits; `pri=2` for a required objective.
- Walk into a rare: `[OB] pause content:<key> by=rare` then `[OB] claim=rare:<id> pri=3 (engage)`.
  Rare dies: `[OB] complete rare:<id> (rare-gone) owned=…ms paused=0ms frozen=…ms` immediately followed by
  `[OB] resume content:<key> (paused NNNNms, from stack)`.
- Rare near a **required** objective instead: `[OB] shadow-deny rare:<id> pri=3 vs content:<key> pri=2` (≤1/s)
  **plus** `[OB] pause content:<key> by=rare`. That pair is the intended ladder inversion — flag-on will defer the
  rare. Flag it to the planner if the required objective then behaves worse than today (it must not: nothing changed).
- Shrine/chest detour: `[OB] shadow-deny utility:<sig> pri=5 vs content:<key>` + `pause … by=utility`, then
  `[OB] resume content:<key> (paused NNNNms)` when the detour ends.
- Delirium mirror at spawn: `[OB] claim=mirror:<gx,gy> pri=1 (mirror-walk)` → `[OB] complete mirror:… (mirror-gone)`.
- Opener/pickit vacuum: `[OB] would-freeze <id> by=opener +NNNms (6 timers registered; legacy clocks authoritative)`
  (≤1 per 2s). Loot windows must still behave exactly as today — the legacy advance list is what actually runs.
- A rare/mirror that outlived its 12s/10s cap only because someone else held the frames:
  `[OB] would-ban-suppressed rare:<id> wall=13400ms owned=5100ms cap=12000ms stolen=7900ms`. **This is the money
  line for step 7** — it says the ban the bot just charged would not have fired under an enforcing OB.

**Broken looks like:**
- `[OB] shadow-deny mirror:…` — must be **impossible** (rank 1). Report immediately.
- `shadow-deny … vs mirror:<key>` while no mirror walk is visibly happening → a stale mirror holder survived
  `OB_MISS_MAX`; report the preceding state transition.
- `[OB] shadow-deny (depth) …` → a depth-3 nesting the ownership map says cannot occur; capture the preceding lines.
- The same `claim=X` / `complete X` pair repeating several times a second → a hook is oscillating; capture it.
- Any behavior delta vs baseline (different routes, dwell, bans) → a parity leak. Set `OB_SHADOW = false` to
  confirm it disappears, then report.
- No `[OB]` lines at all on a map with content → `obTick`/hooks not reached.

**Rollback:** `OB_SHADOW = false` (one const) — every call becomes a no-op, zero lines. Nothing else to unwind.

---

## Risks / deviations

1. **Pause-stack depth = 2 (brief) vs 1 (roadmap "Rejected: OB depth-2 pause stack … Cap the stack at 1").**
   The brief mandates 2 explicitly ("depth cap 2; deeper would-claims log `[OB] shadow-deny (depth)`"), so 2 ships.
   The disagreement is behaviorally inert here (in shadow the stack only shapes log lines) but the planner should
   settle it before step 7. Depth 2 is reachable in principle: `content` → paused by `rare` → paused by `mirror`.
   `OB_STACK_MAX = 1` is a one-token change.
2. **`OB.regTimer` shipped (brief) though the roadmap "Rejected" section calls the named timer registry
   over-indirection with one consumer.** The brief mandates it and the Conflicts section presupposes it
   ("OB timer-accessor closures vs module-split stage c"). Shipped as bookkeeping only; nothing reads a getter and
   nothing calls a setter. The stage-c hazard is real: these closures capture module `let`s and must be rebuilt
   against the exported `S` object during the split.
3. **`done()` / `resume()` record fields omitted** — see *Commitment record*. Calling either in shadow would be a
   behavioral write or a cache mutation. Step 7 adds them with their consumers.
4. **Stale-holder guard (`_miss` / `OB_MISS_MAX`) is not in the brief.** Without it the registry lies within one
   boss transition and would fire the deny the brief's own trap forbids. Pure bookkeeping, no behavior. Documented
   above; reject it and the shadow narrative breaks, don't reject it silently.
5. **`shadow-deny` and `pause` fire together on a denied preemption.** The brief's acceptance narrative wants a
   pause on rare engage *and* on the utility detour, while the ladder denies both against content. Both lines are
   truthful and separable: `shadow-deny` = what flag-on would do; `pause` = what reality did. If the planner wants
   only one, drop the `OB.pause(...)` line in `obRareTick`/`obUtilityClaim`.
6. **`arbTerminated` is not instrumented; `arbRelease` is.** `arbTerminated` is a predicate called every frame on
   the committed entry; `arbRelease` is the single point where the commitment actually ends (both terminator and
   walled/banned paths). Completing from the predicate would fire on every polling frame.
7. **Freeze attribution is one-source-per-pass.** `freezeTick` uses a single `_frzAt`, so if a dodge suppression and
   a utility detour overlap in one pass, the span is charged once (to whichever ran first), never twice. `frozenMs`
   totals stay correct; per-`why` attribution is approximate.

## Out-of-brief change (user-directed, mid-session)

- **`'rugosa'` added to `EXCLUDED_MAP_NAMES`** (exact lowercase short-name set, beside `'sealed vault'`), on the
  user's explicit instruction "add rugosa to excluded map list, as part of this change". Single word → exact-name
  set, not `EXCLUDED_MAP_SUBSTRINGS`. Unrelated to the OB; called out so the diff holds no surprises.

## Open questions for the planner

1. **Depth cap 1 or 2, and does `regTimer` survive?** The brief and the roadmap's Rejected section disagree on both
   (deviations 1–2). Both are free to change now and expensive after step 7 wires the setters.
2. **Is `pause`-on-denial the contract you want** (deviation 5), or should a denied preemptor leave the holder
   completely untouched in the log?
3. **`loot` (6) and `explore` (7) have no claim site.** The loot sweep (`sweepLootStep`) and the explore leg both
   write the walker target; if you want them registered, name the edges — I did not invent instrumentation the brief
   did not list.

Nothing committed; runtime dir only. Not started: TASK-05 or any other queue item.

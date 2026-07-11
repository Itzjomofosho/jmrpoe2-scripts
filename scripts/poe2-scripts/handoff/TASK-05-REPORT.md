# TASK-05 REPORT — Objective Broker ON: owned-ms bans + freeze swap + anchor walk-back (roadmap steps 7+8)

**Status: implemented, `node --check` clean, not committed (runtime dir only).**

Pre-snapshot taken as FIRST ACT, before any edit: `handoff/pre/TASK-05/mapper.js`
(906,087 bytes, MD5 `991D68D66BF7986BCB31A86E8E812F51`, hash-verified against the source at copy time).
That file is the diff base for this report. Diff vs it: **+304 / −71 lines, one file.**

Bridge not consulted: every fact this task needed was already established live in TASK-08's investigation
(abyss bit timing, chest position) and by reading the code paths. Nothing here depends on runtime state I guessed at.

Files touched: **`mapper.js` only.** No C++, no `auto_dodge_core.js`, no tracked repo (`c:\Games\jmrpoe2-scripts`
verified `git status` clean), nothing under `handoff\baseline\`. No memory writes, no new packets, no new bindings,
no new entity scans on any hot path.

---

## The three planner adjudications, as applied

| # | Adjudication | Applied |
|---|---|---|
| 1 | `OB_STACK_MAX` 2 → **1**; a claim against an occupied stack logs `deny (depth)` and under the flag defers | Yes — **with one refinement, see Deviation 1**: the mirror (rank 1) is exempt from the depth cap. Cap-1 alone makes a mirror deny *reachable*, and the brief forbids denying a mirror. |
| 2 | **Delete `OB.regTimer`/`timerReg`**; `freezeTick` advances the anchors directly, same `if (x) x += dt;` shape | Yes. Registry gone (`obAdvanceAnchors`). **Widened per Deviation 2**: the advance is the *union* of the OB anchors and the legacy loot list, or flag-on silently stops freezing nine loot anchors. |
| 3 | Dual `shadow-deny` + `pause` stays for flag-OFF; under the flag only the deny line fires | Yes. `OB.pause()` returns immediately when `obOn()`; the deny line's verb is `shadow-deny` (off) / `deny` (on). |

---

## Flag contract

`obOn()` = `OB_SHADOW && currentSettings.objBroker === true` — the single gate for every behavior in (a)–(d).
Both code paths are retained: `if (obOn()) { new } else { legacy }`. The legacy delta-advance list and the
`arbFrozeAt` advance live in the `else`.

**Flag-off byte-parity audit** (each new call site, what it does with the flag off):

| Site | Flag-off behavior |
|---|---|
| opener/pickit yield | `if (!obOn() && _dt > 0)` → the ten-anchor list runs exactly as before |
| `arbFrozeAt` block | `if (arbFrozeAt > 0 && !obOn())` → `arbCommittedSince += dt` exactly as before |
| rare pre-switch | `obRareDeferred()` short-circuits on `!obOn()` → `else` branch is the original two lines |
| utility selector | `obUtilityDeferred()` returns `false` → `lootOnly = _reqCommitted \|\| _bossDriveLootOnly`, unchanged |
| rare 12s cap | `obRareOwnedMs(id, wall)` returns `wall` → `now - rotRareStart` |
| delirium 15s cap | `_delMs = now - rotDeliriumStart` |
| arb TTL | `obContentOwnedMs(key, wall)` returns `wall` → `now - arbCommittedSince` |
| abyss walk-back | `obOn()` is the first term of the `&&` chain → the original quiet reset runs |
| `OB.freezeTick` | `obAdvanceAnchors` not called; counts the span and logs `would-freeze` |

Verified by targeted diff that the do-not-touch regions have **zero** matching diff lines:
`_unexpCache`, `markFrontierVisited`, `trailRecord(`, `arbCommitTo(`, `arbRelease(`, the movement senders,
`writeMemory`/`patchBytes`/`sendPacket`.

---

## What ships

### (a) Denial DEFERS — flag-gated

New: `OB._denyReason(layer, pri, id)` is **the** denial rule, read by both `OB.claim()` and the new
`OB.wouldDeny(layer, pri, id, gap)`. An asking preemptor and a claiming one can no longer disagree.

- **Rare** (`obRareDeferred(now)`, pre-switch chain): asks before `runClearNearbyRares` runs. Denied against a
  committed required objective → the frame is skipped entirely; rare-clear never steals a required content walk.
  The ask is gated on `rareUniqueNear(now)` (cached 250 ms, 75u — a strict superset of the 62u `ROT_RARE_RANGE`
  engage radius, so a real preemption is never missed) so the deny line names a preemption that would have
  happened, not a poll.
  On a deferred frame `rotRareStart` is re-armed to `now`: **a frame we never owned may not burn the 12s cap.**
- **Utility** (`obUtilityDeferred()`, the `tryStartUtilityNavigation` call site): a denied claim degrades the pass
  to `lootOnly` — exactly the mechanism `_reqCommitted` already uses (a pickit grab never steals a commitment; a
  shrine/chest detour does). Folded as `_reqCommitted || _bossDriveLootOnly || obUtilityDeferred()`, so the legacy
  gate stays authoritative when off and the OB denial is a strict superset when on.
- **Mirror is never denied.** Structural: pri 1 is stronger than every other rank, `cur.layer === 'mirror'`
  short-circuits, and the depth cap exempts it. The `[OB] BUG mirror-denied` assertion is retained as a tripwire
  and is now unreachable by construction.
- Denial = defer-this-frame only. No bans, no state, no `pause`. The caller retries next frame.

### (b) Owned-ms bans — flag-gated

| Clock | Was | Now (flag-on) |
|---|---|---|
| rare-clear 12s (`ROT_RARE_TIMEOUT`) | `now - rotRareStart` | `obRareOwnedMs(e.id, …)` → the rare record's `ownedMs` (plain owned engage ms; the target is a kill, not a position) |
| delirium reach 15s (`rotDeliriumStart`) | `now - rotDeliriumStart` | `trackOwnedProgress(_rotDelTr, key, p.d, …)` → owned **no-progress** ms |
| arbiter commit TTL (`arbCommittedTtl`) | `now - arbCommittedSince` | `obContentOwnedMs(arbCommittedKey, …)` → the content record's owned no-progress ms |

Each helper falls back to the caller's wall-clock value when no record exists (denied, not yet claimed, flag off),
so every call site keeps its legacy behavior in every uncovered case.

**Game-real windows untouched, as instructed:** `ABYSS_MIN_LOOT_MS` (5s chest-spawn hold), the chest-settle dwell,
the strongbox event window, `BEACON_CHEST_DWELL_MS`, the hive defense caps. The mirror handler's own progress-aware
`deliriumBestD` re-arm (`deliriumTargetStart`, 10s owned no-consume) was left exactly as it was.

**Conflict rule honored:** `obRarePaused()` gates the `rotRareStart` freeze — `rotRareStart` advances only while the
rare engage is the **paused** party, never while rare-clear is itself the active preemptor. (Belt and braces: under
(b) the 12s cap reads `ownedMs`, so `rotRareStart` is only the fallback.)

### (c) Freeze swap — strictly either/or

`OB.freezeTick(now, why)` → `obAdvanceAnchors(dt, why)`, called **only** when `obOn()`. It is the single owner of
the advance under the flag. The legacy opener/pickit list is wrapped in `if (!obOn() && _dt > 0)`; the legacy
`arbCommittedSince += (now - arbFrozeAt)` is wrapped in `if (arbFrozeAt > 0 && !obOn())`. Both live would advance
every window twice per yielded frame and none would expire — this is the thing to grep for first.

`obAdvanceAnchors` advances:

- **Every stolen span** (opener / pickit / utility / dodge): `deliriumTargetStart`, `rotRareStart` (gated by
  `obRarePaused()`), `incursionCurStartAt`, `abyssDwell`, `abyssLootDwellAt`, `arbCommittedSince` — the six the
  shadow registered.
- **opener/pickit spans only** (exactly the legacy scope): `rotBreachClearedAt`, `exp2LootedAt`, `hiveDefEndAt`,
  `revisitBeaconEnergisedAt`, `exp2LootWaitAt`, `exp2LootReadyAt`, `utilityArrivalWaitStart`,
  `utilitySessionStartTime`, `_portalLootHoldAt`.

`abyssLootDwellAt` appears in the first group only — it is advanced exactly once per span, never twice.

**Continuity anchors are now per-source** (`OB._frzAnchor = {opener, pickit, utility, dodge}`) plus
`OB.freezeIdle(why)`, called from `obTick` for every source that is not active this pass. See Deviation 3 — the
shadow's single shared `_frzAt` would have charged the gap *between* two freeze sources to real timers.

### (d) Anchor walk-back — flag-gated, abyss

In the abyss quiet-reset branch (`_ndD > 130` clear of `abyssId`/`abyssDwell`): when the flag is on, OB holds
**this** node (`obHoldsAbyssNode()` matches the record's `contentQueue` entry by `type==='abyss' && id===abyssId`),
the displacement is dodge-attributed (`obDodgeDisplaced(now)`, a dodge owned a frame within `OB_DODGE_ATTR_MS`),
and the shove is within `OB_WALKBACK_MAX_D` — `obAnchorWalkBack()` issues a return leg to `abyssNodeX/Y` via
`MB.set('content', 3)` + `startWalkingTo` + `stepPathWalker` (rule 3: gated senders only) instead of clearing.

Bounded three ways: owned no-progress (`OB_WALKBACK_NOPROG_MS` 8s → release, the normal ban path), an absolute leg
cap (`OB_WALKBACK_MAX_MS` 20s), and the runner's own dwell caps. On release the original quiet reset runs and the
site falls to the post-boss chest sweep. **The boss-state escape hatch bypasses the walk-back entirely** (verbatim
`_bossEngaged` short-circuit). Mirror and rare get no walk-back. Beacon/hive: see Deviation 5.

### (e) Abyss grace-finish — NOT flag-gated (correctness fix)

`abyssMidNode()` = `abyssId !== 0 && abyssDwell !== 0` (the same predicate the legacy rotation's keep-alive already
uses). `abyssMidNodeEntry(e)` = that, and `e` is *this* node — so no other abyss entry is ever kept alive.

Applied at **four** gates (the brief named two — see Deviation 4):

1. `arbTerminated` — `objectiveTypeComplete(e.type, now) && !abyssMidNodeEntry(e)`
2. `pickObjective`'s candidate loop
3. `tryRevisitNearbyContent.eligible` and `tryCleanupContent.eligible`
4. **`populateContentQueue`'s prune** — without this the entry is deleted, `arbTerminated`'s `!e` fires anyway, and
   (e) is a no-op.

Composes with TASK-08: the mid-node entry is not queued as a sweep site while the runner holds it; once the runner
retires it normally it calls `abyssMarkLooted`, and `abyssSweepAdd` refuses a looted site. If the runner abandons
(walk-back budget spent, boss engaged), `abyssId = 0` and the next prune queues the site for the sweep as before.

### (f) Map-start hold gates the utility selector — NOT flag-gated (correctness fix)

`mapStartHoldActive(now)` mirrors the FINDING_BOSS gate's condition exactly
(`!_msDoneLogged && deliriumLastSeenAt === 0 && mapStartWallAt > 0` + `_mcLen === 0 && elapsed < MAP_START_CONTENT_WAIT_MS`),
scoped to `currentState === STATE.FINDING_BOSS` (the state that gate lives in), and `tryStartUtilityNavigation`
returns `false` while it is active. An unreadable content list (`-1`) never holds — the gate does not trust that
read either.

Perf: the extra `poe2.getMapContent()` is cached 120 ms (one logic pass), only reachable in FINDING_BOSS, only in
the first 4 s of a map, and stops entirely once `_msDoneLogged` flips. Bounded at ≈28 reads/map, and it is the same
read the gate itself does.

---

## Settings

| name | default | what flips it |
|---|---|---|
| `objBroker` | `false` | **New UI checkbox**, beside the arena-shell combo: *"Objective broker (one goal at a time)"* with a tooltip naming the three ON behaviors. TASK-04 deliberately deferred it to this task. |

`OB_SHADOW = true` remains the module-const master kill-switch (`false` → every OB call a no-op, `obOn()` false).

---

## LIVE-TEST CHECKLIST

Run **flag OFF first** on one mixed-content map to confirm parity, then flip the checkbox and run a second map.

### Pass 1 — flag OFF (parity)
Behavior must be identical to the accepted shadow, and the `[OB]` narrative must read the same:
`claim=` / `pause` / `resume` / `complete` / `shadow-deny` / `would-freeze` / `would-ban-suppressed`.
Two intended log-text deltas: the `would-freeze` line no longer carries `(6 timers registered; legacy clocks
authoritative)` (the registry is deleted), and its `+Nms` numbers shift slightly (per-source anchors).
**Broken:** any route/dwell/ban difference vs baseline. Rollback: `OB_SHADOW = false`.

### Pass 2 — flag ON
**Working looks like:**
- Rare next to a **required** objective: `[OB] deny rare:<id> pri=3 vs content:<key> pri=2`, the walk **continues**
  (no stop-and-engage), and the rare still dies — entity_actions kills it en route. This is the intended ladder
  inversion; it is the one thing to watch for regressions.
- A **mirror** walk is never denied. `[OB] BUG mirror-denied …` must **never** appear. Report it if it does.
- Shrine/chest detour while content is committed: `[OB] deny utility:* pri=5 vs content:<key>` (≤1 per 5s) and the
  bot does **not** detour; a pickit loot grab still happens (loot-only is exempt).
- Opener/pickit vacuum mid-abyss-dwell: `[OB] freeze content:<key> by=opener +Nms`, the dwell **resumes intact**,
  the chest is looted. **Double-advance symptom to watch for: a window that never expires** — the bot standing at a
  finished abyss node or a spent beacon indefinitely. That means both freeze paths ran.
- Dodge shove off an abyss node: `[OB] walk-back content:abyss:<id> -> (x,y) <d>u (dodge-displaced)` →
  `Abyss: hold for chest …` resumes → `[Abyss] node <id> cleared + held Ns + looted -> next`.
  Give-up paths are named: `walk-back … no progress` / `walk-back … capped Ns -> release`.
- The `[OB] would-ban-suppressed rare:<id> wall=… owned=… cap=12000ms` class from the shadow now manifests as **the
  ban not firing** — no `[Rotation] rare <id> not dying in 12s -> skip` on a rare whose frames were stolen.
- Abyss grace-finish: the map's **last** abyss node finishes, the objective bit flips, and the bot **stays** for the
  5s chest hold + loot instead of leaving. `[AbyssSweep] … chest site queued` should now list **fewer** sites, and
  the ones it does list should probe `chest=no` only for genuinely stale nodes.
- Map start: `[MapStart] map content empty -> holding walk up to 4.0s` then `[MapStart] content ready (N entries)
  after <4000ms`. **Broken:** `after 44595ms` again, or any utility detour inside the first 4 s.

**Broken looks like:**
- `[OB] deny mirror:…` or `[OB] BUG mirror-denied …` — the ladder is wrong.
- `[OB] deny (depth) …` — should be unreachable (a non-mirror claimant with a full stack is always denied on `pri`
  first). Capture the preceding lines.
- Any window that never expires (see above) → freeze double-advance.
- A rare engage that never times out on a genuinely unkillable rare → `ownedMs` isn't accruing.
- The bot walking a long way "back" to an abyss node right after a boss kill → the `OB_WALKBACK_MAX_D` bound failed.

**Rollback:** uncheck the box (flag off → shadow). Full rollback: `OB_SHADOW = false`.

---

## Deviations from the brief, with why

1. **Mirror is exempt from the depth cap (adjudication 1 refinement).** With `OB_STACK_MAX = 1` and nothing else,
   `content(optional) → paused by rare → mirror claims` yields `deny (depth)` on the mirror — and TASK-04's own
   deviation 1 already proved that state reachable. The brief simultaneously says a mirror deny is a loud BUG. I
   resolved it the way the roadmap's *"rare re-acquires by id within its 62u range or should simply be dropped"*
   points: a mirror preempting a full stack **drops** the record it preempts (`complete … (dropped: depth,
   preempted by mirror:…)`) instead of stacking a second one. The cap holds at 1, no mirror is ever denied, the BUG
   assertion stays as a real tripwire. Every non-mirror claimant with a full stack is still denied — on `pri`.

2. **`obAdvanceAnchors` advances the union, not just the six registered anchors.** A literal reading of
   adjudication 2 ("over the set the shadow registered") plus (c) ("REPLACES the legacy opener/pickit
   delta-advance list") would, flag-on, stop advancing `rotBreachClearedAt`, `exp2LootedAt`, `hiveDefEndAt`,
   `revisitBeaconEnergisedAt`, `exp2LootWaitAt`, `exp2LootReadyAt`, `utilityArrivalWaitStart`,
   `utilitySessionStartTime` and `_portalLootHoldAt` during an opener/pickit vacuum — reintroducing the exact
   "loot windows expiring mid-vacuum, items skipped" bug that list was written to fix. "Replaces" has to mean "does
   at least what it did". The loot anchors keep their legacy scope (opener/pickit spans only); the six commitment
   anchors freeze on every stolen span, which is the point of the broker.

3. **Per-source freeze anchors instead of the shadow's single `_frzAt`.** The shadow computed
   `dt = now - _frzAt` from one shared anchor, so `opener lock ends → 800 ms of ordinary walking → utility detour
   starts` charged those 800 ms to the detour. In shadow that only inflated `frozenMs`. Flag-on it would advance
   nine real timers by 800 ms of time nobody stole. Fixed with `_frzAnchor` per source + `freezeIdle()` from
   `obTick`. This is a prerequisite for (c), not a gratuitous change.

4. **(e) needed a fourth gate the brief did not name: `populateContentQueue`'s `objectiveTypeComplete` prune.**
   It deletes the mid-node entry, after which `arbTerminated`'s first line (`!e || e.state !== 'active'`) returns
   true regardless of the `objectiveTypeComplete` exemption. Without exempting the prune, (e) is a no-op. I also
   applied the exemption to `tryCleanupContent.eligible` / `tryRevisitNearbyContent.eligible` (both dispatch the
   runner). I did **not** touch `hasPreBossContentToDo`, `nearestOutstandingRequiredContent`,
   `nearbyObjectiveBeforeBoss`, the HUD counters or the marker draw — those are predicates/readouts, not
   dispatchers, and the runner holds the frame anyway.

5. **(d): no code added for beacon and hive.** I looked for the branch to replace and there isn't one — neither has
   a displacement path that *clears* committed state the way the abyss quiet-reset does, so the anchor-return
   contract is already satisfied:
   - `beaconArrivalDwell` returns `null` once displaced past `BEACON_FIGHT_REACH`, and its caller `arbCoordDrive`
     — already under `MB.set('content', 3)` — re-issues `startWalkingTo(e.gridX, e.gridY, 'Objective Walk', 'boss')`.
     That *is* a walk-back to the anchor at content prio 3. `revisitBeaconKey` is untouched.
   - `hiveArrivalDwell` is sticky on `hiveKey` and its own body drives `moveTowardGridPos` toward the
     Ailith/Stabiliser anchor every frame.

   Adding `obAnchorWalkBack` there would install a **second movement writer for the same anchor**, fighting the
   existing one. If the planner wants an explicit OB-owned leg there anyway, say so and name what it should replace.

6. **`OB_WALKBACK_MAX_D = 260` added (not in the brief).** A dodge chain shoves tens of units. Without a distance
   bound, the first post-boss frame (dodge within `OB_DODGE_ATTR_MS`, state no longer `FIGHTING_BOSS`) could start
   a 600u "walk-back" to a stale abyss node that the post-boss chest sweep already owns. 260u ≈ 2× the abyss
   `anchorR`. `NaN` fails the comparison, so a positionless node never walks back.

7. **`OB_SHADOW` keeps its name** even though it is now the master kill-switch rather than a mode. A rename to
   `OB_ON` touches ~18 lines the reviewer would otherwise not have to read; the rollback contract is unchanged.
   Flag it if you want the rename as its own no-op diff.

8. **The rare ask is gated on `rareUniqueNear()`**, so a deferred frame does not run `runClearNearbyRares` and
   therefore does not execute its `if (!e) { rotRareId = 0; }` line. `rotRareId` is read only by the OB adapters,
   `obReconcile`'s stale guard and the runner itself, so a stale value is inert and self-heals the moment the deny
   lifts. Verified by grep: 6 references, no other consumer.

---

## Risks the planner should weigh

1. **The arb TTL is now a no-progress budget, not a wall deadline.** `arbCommittedTtl` compared against owned
   *no-progress* ms means an objective we are steadily walking toward is no longer TTL-banned at 45 s. Deadlock-
   proofness is preserved (`trackOwnedProgress`'s `bestD` is monotone decreasing, so the resets are finite), but
   the semantics of `[Arb]` TTL bans change. This is what the brief asks for and what the shadow's
   `would-ban-suppressed` line predicted; it is still the largest behavior change in the task.

2. **A mid-node abyss dwell can still be evicted by the arb TTL** (60 s for abyss). (e) exempts
   `objectiveTypeComplete` *alone*, as worded — `lockIsDone`, `typeShouldRun` and the TTL still terminate. Flag-on
   makes this much less likely (the walk to the node no longer consumes the budget; the clock effectively starts on
   arrival). **Open question:** should `abyssMidNodeEntry(e)` exempt the TTL clause too? I did not, because "on
   `objectiveTypeComplete` alone" reads as deliberate and removing the abyss deadlock guard is not a change I want
   to make un-asked.

3. **A rare that keeps us dodging takes longer in wall time to hit its 12 s cap**, because dodge-suppressed frames
   are not owned. That is the definition of owned-ms and it is correct, but it is user-visible: rare engages will
   *look* longer on high-pressure packs.

4. **The walk-back only fires on the ARBITER path.** `obHoldsAbyssNode()` needs an OB `content` record, which only
   `arbCommitTo` creates. `ARBITER = true` is the live config, so this is fine today, but the legacy
   `runContentRotation` path gets no walk-back.

5. **The utility denial widens `_reqCommitted`.** Today it defers only against *required* content; the OB ladder
   (optional content = 4, utility = 5) defers against *any* held commitment. That is the ladder as specified in the
   roadmap, but it is a widening, and it is the flag-on change most likely to read as "the bot stopped picking up
   shrines". Loot-only remains exempt.

6. **`abyssLootDwellAt` is frozen by dodge/utility spans**, being one of the six commitment anchors (adjudication 2)
   while (b) classifies its 5 s window as game-real and leaves the *cap* on wall clock. Both rules are honored —
   the anchor freezes, the cap does not convert. The effect is that a dodge roll during the chest hold extends the
   hold, which is correct: the roll physically moved us off the node, which is what suppresses the spawn.

## Open questions

1. Risk 2 — should the mid-node exemption cover `arbTerminated`'s TTL clause, or is the 60 s abyss deadlock guard
   sacred?
2. Deviation 5 — accept "beacon/hive already satisfy the anchor-return contract", or do you want an explicit
   OB-owned leg there (and if so, what does it replace)?
3. Deviation 1 — confirm the mirror-drops-instead-of-denying resolution. The alternative that also satisfies both
   constraints is `OB_STACK_MAX = 2` with mirror at the top, which is what TASK-04 shipped.

---

## Verification performed (HOUSE_RULES definition of done)

- `node --check mapper.js` → **PASS** (re-run after the final edit).
- Symbol grep over all 25 new symbols: every one resolves to a definition **plus** at least one use — no orphan, no
  half-rename. Stale-symbol grep for `regTimer` / `timerReg` / `_frzAt` / `_dodgeFrzAt` / the old
  `OB.freezeTick(now, why, dt)` 3-arg form → **zero matches**.
- Targeted diff proving the do-not-touch regions are untouched (zero matching diff lines, listed above).
- Blast radius: `mapper.js` is the only file modified in the runtime dir; the tracked repo is `git status` clean.
- Worked solo. No agents, no workflows (HOUSE_RULES rule 0).

**Not committed.** Runtime dir only, awaiting the user's live test. Not started: any other queue item — the queue
ends with this task.

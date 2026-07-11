# TASK-21 REPORT — beacon chest dwell, opener unfair-send hold, abyss node routing

Implementer session. Pre-snapshot: `handoff/pre/TASK-21/{mapper.js,opener.js}` (md5-verified copies of the
runtime files taken before any edit). `node --check` passes on both edited files. No commit (user live-tests first).

## Scope delivered
- **A (beacon chest dwell)** — DONE (mapper.js).
- **B unfair-send HOLD** — DONE (opener.js).
- **B COMMIT-TO-CLICK** — **NOT shipped: STOP-and-report per the brief's own architecture constraint.** It needs
  three mapper-internal signals opener.js cannot reach; details + options below. This is the brief's escape hatch
  ("If any piece needs a mechanism the yield system doesn't already provide, STOP and report"), not a punt.
- **C (abyss node route)** — DONE (mapper.js).

Files touched: `mapper.js`, `opener.js` only.

---

## A. Post-energise vaal-chest dwell (mapper.js)

**Hooked the sticky-mark CHOKE, not the commitment.** `markBeaconEnergised()` is the single point every energise
path passes through and it fires exactly once per beacon (the `< 60u` dedup guard). On that first mark it now calls
`armBeaconChestDwell(x,y)`, which arms a bounded dwell iff the player is within 80u and we're not in a boss state.
The dwell executes in `processMapper()` right after the movement-lock yield block (unlocked frames, after the
survival dodge, before the state machine), so it owns the frame while the reward chest rises — regardless of whether
the arbiter already released the beacon commitment (the exact 17:37:18-vs-17:37:25 race in the brief).

Symbols added (all in mapper.js):
- `const BEACON_CHEST_DWELL_ON = true` — gate. Flag-off ⇒ `armBeaconChestDwell` never called ⇒ `beaconChestDwell`
  stays `null` ⇒ tick call short-circuits on the const ⇒ **byte-identical**.
- `BEACON_CHEST_DWELL_ARM_R = 80` (arm radius + walk-back leash), `BEACON_CHEST_DWELL_PLANT_R = 12` (plant vs
  walk-back), `BEACON_CHEST_DWELL_HOLD_MS = 8000` (hold clock, dodge-frozen), `BEACON_CHEST_DWELL_CAP_MS = 15000`
  (wall-clock ultimate cap).
- `let beaconChestDwell` / `const beaconChestDwellDone` (per-map, one dwell per beacon, keyed on rounded coords).
- `armBeaconChestDwell(x,y)`, `beaconChestDwellStep(player, now)`.
- Reset added to `resetMapper` next to the `energisedBeacons` reset.

Bounds / house idioms honored: one dwell per beacon (`beaconChestDwellDone`), 8s hold that **freezes on dodge-held
frames** (`dodgeMoveSuppressUntil` / MB dodge hold), 15s wall-clock hard cap, **never fires in boss states** (checked
at arm-time and re-checked every step — aborts to done if a boss state begins). Walk-back uses the fog-independent
`'boss'` route (`startWalkingTo(...,'boss')` + `stepPathWalker`); plant uses `sendStopMovementLimited` (both MB-gated,
so a dodge steals freely — and the survival dodge already ran earlier in the same frame). During opener/pickit
servicing the mapper yields *above* this step, so `heldMs` naturally pauses (waits for the chest to be grabbed),
bounded by the 15s cap.

**Chest passes the opener whitelist — verification.** The vaal reward chest is a normal `Chest` entity
(`chestIsStrongbox === false`) → `collectOpenTargets` chests bucket → `openNormalChests` (default true) opens it as
type `"Chest"`. Its name also matches `LEAGUE_CHEST_RE` (`.../vaal|incursion|beacon/i`, mapper.js), so the mapper's
`sweepLootStep`/chest classifier recognize it too. **Open item for live test:** confirm the exact entity is a Chest
(not a proximity-only interactable) by watching for an `[Opener] Opened Chest: …` line during the dwell — see checklist.

---

## B. Opener unfair-send HOLD (opener.js) — SHIPPED

Symbol: `const OPEN_UNFAIR_HOLD_ON = true`. Flag-off ⇒ the added `if` short-circuits ⇒ **byte-identical send path**.

Placed in `processAutoOpen`'s candidate loop, after the strongbox-guard skip, before the walkable-LoS gate (so it
only sees non-essence targets — the essence lane `break`/`continue`s earlier). Reuses the **exact** `_fairWindow`
building blocks from the `markOpenAttempt` call site (`POE2Cache.isMovementLocked()` + `OPEN_FAIR_RANGE`):

```
HOLD (skip send, charge nothing, stay a candidate) when:
    type !== Essence  AND  distance > OPEN_FAIR_RANGE(30)  AND  (lock.locked && lock.source !== 'opener')
```

De-Morgan of the brief's two clauses: "hold when `dist>30 AND non-opener-lock`" ⇔ "send when `in-range OR
movement-free`" — the implementation is exactly this, so both clauses are satisfied simultaneously.

Note on the signal: the **mapper does not itself register a movement lock** (only opener/pickit/spiken_bot do —
verified: `requestMovementLock` call sites). So "a non-opener lock owns the character" is in practice **pickit's**
lock during dense content (breach/abyss loot) — which is exactly when the drive-by whiffs happen. This matches the
planner's model and the existing `_fairWindow` read; flagged here so live-test interpretation is unambiguous.

### Final send-decision table (non-essence, with OPEN_UNFAIR_HOLD_ON)

| Target | dist ≤ 30 | 30 < dist, movement FREE | 30 < dist, non-opener lock held |
|---|---|---|---|
| Chest / Shrine / Door / Special / Strongbox\* | **SEND** (fair) | **SEND** (as today; post-send accounting = unfair → free-retry) | **HOLD** (no send, nothing charged, stays candidate) |
| Abyss chest (`/abysschest/i`) | SEND if ≤ 25 (existing 25u gate); **>25 = HELD by the existing gate** — never reaches the new hold | same | same |
| Essence / RuneRock | unaffected — essence lane (gate 40u / RuneRock 20u), exempt from the hold | | |

\*Strongbox additionally requires guards-dead (existing). The post-send free-retry/attempt accounting
(`markOpenAttempt` fair-window) is **unchanged** — it still governs sends that fired fair but the server ate.

**Why the hold alone fixes "shrine NEXT TO ME didn't go":** the 45.3u/38.1u whiffs burned free-retries then real
attempts → the shrine got **banned** before the bot ever stood next to it. The hold stops those far whiffs, so no
ban accrues, so when the bot is actually within 30u (or standing still nearby) the send fires and it opens.

### B commit-to-click — BLOCKED, not shipped (details + options)

The commit-to-click as written requires, from **opener.js**:
1. `sendStopMovementLimited()` — mapper-internal, **MB-gated**, not exported. Only the raw `stopMovement()`
   (movement.js) is importable, and it **bypasses the Movement Broker** (violates house rule 3 + "dodge always
   allowed to steal").
2. "MB dodge owner check" — `MB` is mapper-internal; not exposed to opener.js.
3. "not FIGHTING_BOSS / boss-melee" — `currentState` is mapper-internal; not exposed to opener.js (the mapper
   publishes nothing about state/dodge to `POE2Cache`).

opener.js imports only `POE2Cache` + `poe2`; **mapper.js already imports opener.js** (line 24), so an opener→mapper
import would be **circular** (fragile in this SpiderMonkey build). Exposing these would mean the mapper *publishing*
new fields to `POE2Cache` each frame — a mechanism the yield system does not provide today. Per the brief's explicit
constraint ("If any piece needs a mechanism the yield system doesn't already provide, STOP and report instead of
building a parallel one") and HOUSE_RULES rule 12, I stopped here rather than guess.

**Decisive safety reason it must NOT ship half-gated:** the shipped HOLD already suppresses far sends *during boss
fights* whenever a lock is present. A commit-to-click **without** the boss-state gate would *re-fire* those held
targets within 50u mid-boss — walking the character 30–50u off the boss to interact a shrine. That is **strictly
worse** than shipping just the hold. So the boss gate is not cosmetic; it is required, and it is unreadable from
opener.js. (The dodge gate, by contrast, is already structural: `opener` is registered before `mapper` (main.js
51 vs 60), so the mapper's survival dodge runs *after* the opener every frame and always wins — "dodge steals" is
guaranteed regardless.)

**Verified for the planner (so the commit can land fast once a signal exists):** the mapper *does* stamp
`utilityLastServicedAt = now` on every `'opener'`-lock frame (mapper.js ~12797) and advances all dwell anchors — so
`requestMovementLock('opener', OPEN_COMMIT_MS)` **would** get the clock-freeze the brief wants, for free. Everything
else the commit needs is already reachable (`requestMovementLock`, `sendOpenPacket`, a per-target 2.5s timestamp).

**Concrete options (planner picks one; I did not build any):**
- **(a) Publish + yield-as-stop (smallest, two-files-only):** mapper writes two booleans to `POE2Cache` each frame
  (`mapperInBossState`, `mbDodgeActive`); opener reads them, and for a held target ≤50u & safe, fires
  `sendOpenPacket` + `requestMovementLock('opener', OPEN_COMMIT_MS=800)` — the **mapper's existing yield IS the stop**
  (it stops re-issuing its walk and the interact redirects the char). No MB bypass, no explicit stop packet. This is
  the most faithful to "ride the existing yield architecture." Needs planner OK because it adds POE2Cache fields.
- **(b) Mapper-hosted commit:** the mapper (which already walks opener candidates as utility targets and has
  boss/dodge/MB/stop) grants the 800ms yield when it is ≤50u from an opener target and safe. Bigger; risks
  overlapping the existing utility-target dwell.
- **(c) Export an MB-gated `openerStopAndYield()` from mapper** for the opener to call. Cleanest API but couples the
  modules (circular-import care needed).

---

## C. Abyss node walk = fog-independent route (mapper.js) — SHIPPED

`runAbyssRun` Phase-A approach rewritten to mirror the sweep/stone walks:
- Walk is now `startWalkingTo(_wx, _wy, 'Abyss Node', 'boss')` + `stepPathWalker()` (fog-independent macro route),
  replacing the old `navTo`/`macroWaypointToward`-fallback. **`'boss'` routing is unconditional** per the brief.
- Within 45u, `WALK_APPROACH_ON`-gated: if the node's own cell reads `!isWalkable` (pit-edge), probe once via the
  shared `walkableApproachPoint` and re-target the ring cell (`abyssApX/abyssApY`, node-scoped).
- New node-scoped state `let abyssApX = NaN, abyssApY = NaN, abyssApChk = false`, reset in the `abyssId !== t.id`
  commit block (so it never leaks between nodes).
- Phase-B recenter (`dist > 55`, no mob) now walks to the **same** approach cell when one was computed (same target
  name `'Abyss Node'`) — this is the "walk-target re-issue site respects the same target so the two don't fight"
  the brief asked me to verify: the reach and recenter legs now share the sidestep cell and never wall-slide the
  raw unwalkable node coords.

**Bounds unchanged:** the no-progress skip (`bestAt>11s AND reachMove>6s`, or `startAt>50s`) and all caps are
untouched — the route fix should make the 41u/50s stall vanish without loosening the verdicts.

**Flag-off note (as requested):** `WALK_APPROACH_ON=false` disables only the approach-cell sidestep (abyssApX stays
NaN ⇒ raw coords; Phase-B recenter reverts to raw `navTo`, byte-identical). The `'boss'` routing is **not** gated —
so flag-off does **not** restore the pre-task Phase-A path. **I agree** the `'boss'` route should be unconditional:
the fog-gated `navTo` was the documented stall cause (the node "sat behind terrain the fog-gated JS path can't
route"), and `'boss'` is the same proven fog-independent router every other far walk already uses (sweep, stone,
boss approach, required content, etc.). It is a routing choice, not a behavior gamble.

---

## LIVE-TEST CHECKLIST

### A — beacon chest dwell
- On a Vaal-Beacon energise while standing on it, WATCH FOR (order):
  - `[Incursion] Vaal Beacon (x,y) marked ENERGISED (sticky) -> N done`
  - `[Incursion] chest dwell armed at Vaal Beacon (x,y) -> hold 8s for the vaal chest`
  - status line `Vaal Beacon: chest dwell 0.0/8s` climbing
  - `[Opener] Opened Chest: … (Dist …)` and pickit lines DURING the dwell ⇒ **working** (chest looted before leaving).
  - `[Incursion] chest dwell done at Vaal Beacon (x,y) (held ~8s) -> release`
- BROKEN looks like: bot walks off the instant the ENERGISED line prints (no `chest dwell armed`), OR the dwell
  arms but no `Opened Chest` appears (⇒ the reward is NOT a whitelisted Chest entity — capture its name for the
  planner; the opener whitelist/`LEAGUE_CHEST_RE` may need that keyword).
- Must NOT arm during a boss fight; must NOT hold past ~15s; a dodge during the hold must still roll (dodge line
  fires, `heldMs` pauses).

### B — unfair-send hold
- Walk the bot PAST a shrine toward other content (the map-1 repro). WATCH: **no** `[Opener] Opened Shrine: …
  (Dist: 3x–8x)` lines while `Walking to …` owns movement (a non-opener/pickit lock is live). Then when the bot is
  actually within ~30u or parked, the shrine opens once. **Working** = far whiffs gone, close open still happens.
- BROKEN = still seeing `Opened Shrine … Dist: 45.x/38.x` mid-walk, or a nearby shrine now NEVER opens even when the
  bot ends up beside it (would indicate the hold isn't releasing in-range — check the lock source in the heartbeat
  `lock=` field).
- Regression guard: essences/RuneRocks must open exactly as before; abyss chests still gated at 25u.

### C — abyss node route
- On the map-1 skip class (node behind terrain): WATCH `Walking to Abyss Node at (x,y) [pathType=boss]` (was
  `pathType=none`), and — if the node cell is a pit edge — `[Abyss] node <id> cell unwalkable -> approach cell (x,y)`.
- **Working** = the node is reached; no 40u+ closest-approach stall for multiple 10s stretches; the
  `[Abyss] node <id> no progress -> skip` from map 1 does NOT recur on that node.
- BROKEN = still `pathType=none`, or new stalls, or the no-progress verdict now firing on nodes it used to reach
  (⇒ the route change loosened something — should not happen, bounds untouched).

## Risks / deviations
- **B commit-to-click deferred** (see blocker above) — the only deviation from the brief; done under the brief's
  explicit STOP-and-report clause. The shipped HOLD delivers the core symptom fix on its own.
- **A chest-entity assumption:** the dwell holds and lets opener/pickit service; it does not itself invoke the
  opener. If a specific vaal reward container is a proximity-only interactable rather than a `Chest`, add active
  `sweepLootStep` loot-walking or an opener-whitelist keyword — flagged as a live-test verification item, not a
  known break.
- **C flag-off** is not full pre-task parity by design (unconditional `'boss'` routing) — stated above with reasons.

## Open questions for the planner
1. Approve one of the commit-to-click options (a/b/c) so the ≤50u "step-up, stop, click" lands, or accept
   hold-only? (Recommendation: **(a)** — smallest, rides the existing yield, two-files-only if POE2Cache field-adds
   are allowed.)
2. Item A: is the vaal reward chest always a `Chest` entity (opener whitelist), or do we need active loot-walking /
   a keyword? Live test answers this.

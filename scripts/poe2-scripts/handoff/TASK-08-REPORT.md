# TASK-08 REPORT — Abyss required + chest sweep (P2/P8)

Pre-snapshot: `handoff\pre\TASK-08\mapper.js` (copied BEFORE any edit, per HOUSE_RULES first act).
`node --check mapper.js` → **PASS**. Files edited: **`mapper.js` only**. No C++, no packets, no memory writes.

---

## INVESTIGATION — answered from the LIVE game, not from the code

The user brought the debug bridge up mid-task. Every claim below is a live read from a real map
(`MapRustbowl`-family, main objective "Defeat Gozen, Rebellious Rustlord", player at grid (651,999)),
**not** an inference. This supersedes the guesses I would otherwise have had to report.

### Q1 — When does the Abyss objective bit flip?

**Answer: it flips when the LAST abyss node finishes — i.e. exactly when that node goes gray and spawns its
chests. It does NOT flip early.**

Evidence, all from the same live frame:

| Read | Value |
|---|---|
| `getMapObjectives()` → content row `Abyss` | `isCompleted: **true**` |
| `AbyssFinalNodeBase` id 1059 @ (518,1185) | quest-marker `iconType: **891**` (gray/done), `MinimapIcon+0x10 = 1` |
| `AbyssFinalNodeBase` id 1101 @ (587,1081) | quest-marker `iconType: **891**` (gray/done), `MinimapIcon+0x10 = 1` |

Both nodes on the map read **done**, and the objective reads complete. **No active (890) node exists while the bit
reads complete**, which is what an early flip would require. So the "7 queue entries still active" in the incident
log were **stale queue entries, not live nodes** — an abyss node that goes gray while the runner isn't personally
retiring it (de-streamed, or finished by mob-clear while the bot was elsewhere) never gets into `abyssBlacklist`,
so the prune's per-entry `done` check never fires and `state` stays `'active'` until the 10-min staleness delete.
The queue's `abyss:N` count is not a count of live nodes.

**Bonus finding (kills a hypothesis I was carrying):** `getMapObjectives().content[].index` matches `MAP_OBJ_NAMES`
positionally — `Checkpoints:2, RareMonsters:3, Breach:4, Abyss:8, Shrines:10, Strongboxes:11, StoneCircles:15,
Incursion:16`. The objState bitfield index mapping has **not** drifted this patch. (Worth re-running this one-liner
after every game patch — it is the cheapest possible drift canary, cf. `poe2-atlas-statid-drift`.)

### Q2 — Where do the end-of-abyss chests spawn?

**Answer: exactly ON the tracked node coordinate (delta ≤ 1u). The pruned node position IS the chest position.**

| Chest (`type: 'Chest'`) | renderName | Pos | Node it sits on | `chestIsOpened` | `isTargetable` |
|---|---|---|---|---|---|
| `AbyssChestGeneric` | Abyssal Trove | (587,1082) | 1101 @ (587,1081) → **1u** | `true` | `false` |
| `AbyssChestRareFinalWeapons` | Abyssal Arsenal | (518,1185) | 1059 @ (518,1185) → **0u** | **`false`** | **`true`** |

So at the moment of reading: the Abyss objective is **complete**, and an **unopened, targetable rare chest is still
standing on a gray node 229u from the player**. The bug reproduced itself live while I was investigating it.
The chests unambiguously **outlive the objective bit**. They are in the opener's candidate reach (it scans
`type:'Chest'`, and `chestIsOpened` / `isTargetable` populate under `lightweight:true`) — the bot simply is not
standing near them, because the prune deleted the coordinates that would take it back.

### The mechanism, corrected

The brief named the prune. The prune is only **half** of it, and the other half is why "don't delete the entry"
would not have been enough:

1. `runAbyssRun`'s 5s chest-spawn hold + `sweepLootStep` loot dwell live **inside the runner**
   (`mapper.js`, the `abyssId && abyssDwell && !nodes.some(...)` branch).
2. **Every caller** of `runAbyssRun` gates on `objectiveTypeComplete('abyss')` — `tryCleanupContent.eligible`,
   `hasPreBossContentToDo`, `nearestOutstandingRequiredContent`, the arbiter, the rotation.
3. On the **last** node, the bit flips in the *same pass* the node drops out of `getAbyssNodes()`. The gate closes
   before the dwell branch ever runs. The hold that exists specifically to let the chest spawn and be looted is
   skipped, for the one node that always has the best chest.
4. `populateContentQueue`'s prune then deletes the coords, so nothing remembers where to walk back to.

That is why the fix is a **sweep with its own dwell**, not a prune exemption.

### P8 / REQUIRED SEMANTICS — verified, already correct, no change made

`isRequiredType('abyss')` is **true** on "Complete all Abysses" maps. Chain: `getRequiredObjectiveNames` matches the
content row's `objective` text ("Complete all Abysses") inside `mainObjective.text` → adds `'Abyss'` →
`OBJ_DRIVABLE.Abyss === 'abyss'` → `isRequiredType` true → the arbiter scores those entries **pri-2**
(`arbPriority`: `if (isRequiredType(...)) return 2`), and `tryCleanupContent` pursues them at **any** distance.
Confirmed independently in `data\poe2-scripts\map_audit.log`: `required=[MapBoss,Abyss]` on all three such maps
(`MapSulphuricCaverns` 07-09, `MapRustbowl` 07-10, `MapSinterRift` 07-10). **No code change was needed for P8.**
Per the brief: required-complete never implies loot-complete — the sweep runs on required and optional abyss alike.

---

## THE FIX

New subsystem in `mapper.js`, tag `[AbyssSweep]`. Positions are visited **from a list with per-position retire**;
nothing is ever re-scanned into a fresh commitment, and a retired site can never be re-queued.

**Symbols added** (all in `mapper.js`, defined just after `runAbyssRun`):

| Symbol | Role |
|---|---|
| `ABYSS_SWEEP_ON` | kill-switch const, `true` (see "Settings" below) |
| `ABYSS_SWEEP_MAX_SITES` = 8 | bound on the site list; overflow is **logged, not silent** |
| `ABYSS_SWEEP_ARRIVE` = 18 | "at the site" radius (chest is ≤1u from the node, opener reach is 80u) |
| `ABYSS_SWEEP_CHEST_R` = 90 | chest-presence probe radius |
| `ABYSS_SWEEP_HOLD_MS` | = `ABYSS_MIN_LOOT_MS` (5s) — the wall-clock chest-spawn hold, deliberately reused |
| `ABYSS_SWEEP_SITE_CAP_MS` = 25000 | per-site cap from arrival; held past **only** while collection is in flight |
| `ABYSS_SWEEP_SITE_MAX_MS` = 45000 | absolute per-site ceiling |
| `ABYSS_SWEEP_WALK_MS` = 45000 | per-site walk cap |
| `ABYSS_SWEEP_NOPROG_MS` = 10000 | **owned** no-progress → site unreachable → retire |
| `ABYSS_SWEEP_BUDGET_MS` = 90000 | hard total budget across all sites |
| `abyssSweepSites` / `abyssSweepLooted` / `abyssSweepStartAt` / `abyssSweepDone` | state |
| `_abSwTrack` / `_abSwChestAt`,`_abSwChestKey`,`_abSwChestVal` | owned-progress tracker / 500ms chest-probe cache |
| `abyssSiteKey(x,y)` | 12u position bucket (mirrors `upsert`'s position key) |
| `abyssMarkLooted(x,y)` | records a site as done-with |
| `abyssSweepAdd(x,y,now)` | queue a pruned node position |
| `abyssChestNear(s,now)` | unopened `AbyssChest*` still standing here? |
| `abyssSweepProbeSite(s,now)` | one-shot arrival diagnostic (see below) |
| `abyssSweepRetire(s,why,now)` | shift + mark looted + log |
| `tryAbyssChestSweep(player,now)` | the driver; true while it owns the frame |

**Call sites modified:**

| Location | Change |
|---|---|
| `runAbyssRun`, full-dwell retire (`node ... cleared + held ...s + looted`) | `abyssMarkLooted(abyssNodeX, abyssNodeY)` — a node the runner already loot-dwelled is **never** swept again |
| `populateContentQueue`, the `objectiveTypeComplete(e.type, now)` prune | `if (e.type === 'abyss') abyssSweepAdd(e.gridX, e.gridY, now);` before `contentQueue.delete(key)` |
| `MAP_COMPLETE`, new **Phase 3.8** (after 3.75 cleanup, before 3.9 Precursor Beacon) | `if (tryAbyssChestSweep(player, now)) { mapCompleteContentDriveAt = now; break; }` |
| `resetMapper` | clears `abyssSweepSites`/`abyssSweepLooted`/`abyssSweepStartAt`/`abyssSweepDone`/`_abSwTrack`/`_abSwChestKey` |

**Behavior:** walk to the nearest un-swept site (`startWalkingTo(..., 'Abyss Chest Sweep', 'boss')` — fog-independent
macro route, since the site is usually de-streamed) → on arrival stand still for 5s (moving off the node can suppress
the chest spawn, and the opener needs us inside its reach) → `sweepLootStep` walks the drops into pickit's short grab
range → hold while an unopened `AbyssChest*` remains → retire. Nearest-first ordering is chosen **only at a retire
boundary**, never while a site is committed.

**Anti-guillotine:** the 25s per-site cap gates *starting* the next site; it is held past while `lootStillLeft(90)` or
`abyssChestNear()` says collection is in flight, bounded by the 45s ceiling. (This was a bug in my first draft — the
cap could have cut pickit off mid-grab.)

**Never traps.** Four independent exits: owned-no-progress (10s) → site retired unreachable; walk cap (45s); per-site
ceiling (45s); total budget (90s) → list cleared + latch. A retired site is marked looted, so a still-green node that
re-streams and is re-pruned **cannot** re-enter the list — that is the anti-yoyo guarantee.

### Deliberate instrumentation — `abyssSweepProbeSite`

One read per site on arrival, logging `node=<active|done|gone> chest=<YES|no>`. This is the live-game answer to Q1
recorded *per site, per map*, so the planner never has to take my single-frame snapshot on faith. If a future map
ever logs `node=active` at a pruned site, the bit **did** flip early on that map and the required-semantics half of
this task must be reopened.

---

## Settings added: **none**

The brief names no setting, and HOUSE_RULES rule 2 says the flag is "named in the brief". Per the TASK-09 precedent
("all four are always-on directives, as the brief requires") and the `TRAIL_BIAS_ON` precedent, this ships as an
always-on directive behind a module const `ABYSS_SWEEP_ON = true` (flip to `false` for byte-parity control flow).

**This is a deviation worth the planner's attention:** the sweep runs **regardless of `objGoalOn()`**. That is
intentional — the prune that strands the chests is *not* flag-gated either, so the bug exists with the master flag
off, and gating the fix behind `objGoalOn()` would leave it unfixed in the default configuration. Phase 3.8 sits
after Phase 3.75, which `break`s whenever it drives, so the two can never fight for the frame.

---

## PERF budget (rule 4)

Only runs in `MAP_COMPLETE`, only when the site list is non-empty (i.e. only on maps that had an abyss).

- `abyssChestNear`: one `POE2Cache.getEntities({type:'Chest', maxDistance:90, lightweight:true})`, **500ms-cached**,
  only while standing on a site. Worst case ~90 typed+distance-capped scans per site.
- `abyssSweepProbeSite`: one `lightweight:false` scan **per site, once** (≤8 per map).
- `sweepLootStep` / `lootStillLeft`: existing, already-throttled helpers.
- Walking legs: `startWalkingTo` + `stepPathWalker` only (Movement Broker `content`/prio-3, rule 3). No raw senders.

---

## LIVE-TEST CHECKLIST

Run an abyss map (any map whose content list shows Abysses; a **required** "Complete all Abysses" map is the best
test, but optional abyss maps exercise the same path).

**Watch for, in order:**

1. During the map, per node the runner finishes normally:
   `[Abyss] node <id> cleared + held <n>s + looted -> next` — unchanged behavior. That node is now marked looted and
   **must not** appear as a sweep site later.
2. The instant the objective completes:
   `[AbyssSweep] abyss node (x,y) pruned on objective-complete -> chest site queued (N)`
   — one line per abyss entry that was still `active`. Expect **several**, most of them stale (see Q1).
3. Post-boss, after the cleanup phase yields:
   `[AbyssSweep] -> chest site (x,y) <d>u (N left)`
   then `[AbyssSweep] site (x,y) node=done chest=YES` on arrival.
4. `[Opener] Opened Chest: AbyssChest…` (`Abyssal Trove` / `Abyssal Arsenal` / …), pickit grabs the drops.
5. `[AbyssSweep] site (x,y) retired: chests cleared (N-1 left)` → next site → finally
   `[AbyssSweep] all chest sites visited -> done` → bot proceeds to Precursor Beacon / portal.

**Working looks like:** the bot visits each abyss site **once**, stands ~5s, chests pop, loot is collected, it leaves
within the dwell caps. Status line reads `Abyss sweep: …`.

**Broken looks like (and what each means):**

- `[AbyssSweep] site (x,y) node=active …` → **the bit flipped early on this map**; Q1's answer is map-dependent and
  the required-semantics half must be reopened. Report the map name.
- `[AbyssSweep] site (x,y) retired: unreachable (no progress, closest <d>u)` repeatedly → the macro route can't reach
  gray nodes (fog/terrain); the `'boss'` pathType may need the `Cleanup Reveal` fog-explore treatment.
- `[AbyssSweep] budget 90s spent -> N site(s) NOT visited` → the map had more real chest sites than the budget covers;
  tune `ABYSS_SWEEP_BUDGET_MS`. **This line is deliberate — the sweep never silently drops sites.**
- `[AbyssSweep] site cap 8 reached -> DROPPED site (x,y)` → raise `ABYSS_SWEEP_MAX_SITES`.
- Bot revisits a node it already looted → `abyssMarkLooted` isn't firing on the runner's retire path; regression.
- Bot lingers at a site >45s → the ceiling failed; regression.

**Flag-off parity check:** set `ABYSS_SWEEP_ON = false` → `tryAbyssChestSweep` returns `false` on its first
condition and `abyssSweepAdd` returns immediately; Phase 3.8 falls straight through. Control flow is identical to the
pre-snapshot.

---

## Risks / deviations

1. **Sweep is MAP_COMPLETE-only** (post-boss). If the abyss objective completes pre-boss, the chests wait. This is
   safe and verified: the live probe found an unopened chest that had persisted long after its node went gray —
   abyss chests do **not** despawn. It also matches the boss-on-the-way model (the boss is never held for content the
   cleanup owns). The brief allowed either owner.
2. **Sweep runs with `objGoalOn()` off** — see Settings. Called out explicitly because it is the one place I widened
   scope beyond a flag-gated behavior, and I believe the brief's intent (P2/P8 are user-visible loot bugs) requires it.
3. `abyssSweepRetire` marks a site looted **even when retired unreachable/capped**. Intentional: without it, a node
   re-streaming green would be re-pruned and re-queued forever. Cost: one unreachable site is not retried this map.
4. The 5s hold is **wall-clock**, not owned-frame ms. Per `MAPPER_ROADMAP` ("the abyss 5s chest-spawn hold must stay
   wall-clock — it measures the game, not our progress"). Not converted.

## Open questions for the planner

1. **`objectiveTypeComplete('abyss')` uses `.some()` over `['Abyss','AbyssDepths']`.** If a map ever has
   `AbyssDepths` present *and* complete while `Abyss` is still incomplete, **every** abyss node is pruned and the
   whole mechanic is abandoned mid-map. I did not change this (outside the brief, and I could not construct the case
   live — `AbyssDepths` was absent from this map's bitfield). The `abyssSweepProbeSite` `node=active` line is the
   tripwire that would catch it. Worth a dedicated look.
2. **Should the sweep also run pre-boss** when the abyss objective completes early in a long map? Currently no. Costs
   nothing today (chests persist) but a pre-boss sweep would collect the loot sooner and closer to the walk.

## Out of scope, but found live — SHRINE BUG (the user's "no shrine pickup", reported mid-task)

**The user asked me about this mid-task and instructed me to note it and move on.** Not touched, no edit to
`opener.js` (one task per session). Handing over with live numbers so nobody re-investigates:

`opener.js:475` — shrine bucket:
```js
if (!allowBlockedVisibility && !passesVisibilityCheck(player, entity, maxDist) && dist > 34) continue;
```
Live, on the user's map, player at (651,999):

| Shrine | Pos | Dist | `isTargetable` | `hasLineOfFire` | `isWithinLineOfSight` | `isWalkable(shrine tile)` |
|---|---|---|---|---|---|---|
| Seeking Shrine (274) | (632,976) | 30u | `false` (taken — correctly ignored) | false | false | false |
| **Resistance Shrine (275)** | (680,1025) | **39u** | **`true`** | **false** | **false** | **false** |

The shrine occupies a **non-walkable tile**, so the ray's terminal tile is blocked and `passesVisibilityCheck` is
**structurally false for shrines at any distance**. The code already knows this (its own comment: "Shrines frequently
report blocked LoS/LoF in tight layouts even when they are valid/targetable") and relaxes the gate — but only within
**34u**. At 39u the live, targetable Resistance Shrine is skipped by `processAutoOpen` every tick.

The bot standing still is **explained and is not a bug**: the user had paused the mapper to talk to me. That makes
the shrine finding *cleaner*, not weaker — the opener is its own plugin and auto-opens independently of the mapper,
so with the mapper paused it had a targetable shrine at 39u, inside its 80u reach, and still did not take it. The
`dist > 34` gate is the whole explanation. Prediction to falsify it: the same shrine opens the moment the player
stands within 34u of it. The abyss chest was a separate matter — at 229u it was simply outside the opener's reach,
which is exactly the sweep this task adds.

Suggested owner: whoever holds TASK-06. Note I could not read mapper JS state (`currentState`, `statusMessage`,
`contentQueue`) over the bridge — `eval_js` evaluates in a fresh `new POE2()` context, not the plugin module.

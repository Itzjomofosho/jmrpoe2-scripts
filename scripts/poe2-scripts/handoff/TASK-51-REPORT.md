# TASK-51 REPORT — paused-completion loot loss + pickit false-unreachable + explore pocket

Implemented per brief. Solo (HOUSE_RULES §0 — no fleets/workflows). Pre-snapshot in `handoff\pre\TASK-51\`
(mapper.js, pickit.js, navigator.js). All three `node --check` pass. TASK-53 already implemented (sequencing OK).

## Files touched
- **mapper.js** (A + B-consumer + C) — 43 added lines.
- **pickit.js** (B-producer) — 66 added lines.
- **navigator.js** — INVESTIGATED, **not edited** (confirmed byte-identical to pre-snapshot). See Part C.

---

## A. Paused-completion strands the abyss chest (`PAUSED_COMPLETION_ON`, mapper.js)

**Root cause (confirmed from code):** `abyssFlipWatch()` unconditionally skipped the runner-committed node
(`if (e.id === abyssId) …continue`), trusting the runner to do the completion work. When the runner is PAUSED
(rare stole the frame per `[OB] pause content:abyss:724 by=rare`), `runAbyssRun` isn't ticking, the node flips
spent, and **nobody** queues the chest site: the prune (`objectiveTypeComplete && !abyssMidNodeEntry`) also skips
it because `abyssMidNodeEntry` is true (abyssId set + reached), and `arbRelease` (via arbTerminated/valve) just
clears the commitment — no site queue. Hence `complete … (arb-release, consumed while paused)` with the chest
stranded.

**Fix (`abyssFlipWatch`, symbol `PAUSED_COMPLETION_ON`):**
- The committed-node exclusion is now gated on the runner actually being IN its loot-dwell:
  `if (e.id === abyssId && (!PAUSED_COMPLETION_ON || abyssLootDwellAt > 0)) …skip`. Paused / never-reached
  (`abyssLootDwellAt === 0`) → fall through to the flip detection, which `abyssSweepAdd`s the chest site (the sweep
  machinery does the dwell+opener at the site — the brief's "queueing the site is the minimum").
- On the paused branch it then releases the stranded runner state (`abyssId/abyssDwell/abyssLootDwellAt = 0`,
  `obWalkBackReset()`) because the paused runner never resumes to zero it.

**Why the normal (unpaused) flow can't false-fire:** the flip-watch is throttled 1500ms; the runner ticks ~7Hz and
enters loot-dwell (`abyssLootDwellAt` set) within one tick of the node flipping. So by the time the flip-watch's
NEXT pass observes `active→done`, an unpaused runner has already set `abyssLootDwellAt > 0` → line still skips.
`abyssLootDwellAt === 0` at an observed flip therefore reliably means "runner not servicing" (i.e. paused). Flag
off = the original unconditional skip (byte-parity, verified in the diff).

**Second deliverable — the abyss:753 silent exit (named + fixed):** the exit is the whole-objective prune
`if (objectiveTypeComplete('abyss') && !abyssMidNodeEntry(e)) { …abyssSweepAdd(); contentQueue.delete(key); }`.
`noteContentCompleted` logs nothing and `abyssSweepAdd` is silent when it dedups (site already tracked/looted /
sweep done), so a non-committed abyss node whose objective completed left with no trace. The `abyssSweepAdd` call
already preserved the chest position (so 753's chest was NOT actually lost — its site was already tracked); the gap
was purely visibility. Now: `const _q = abyssSweepAdd(...); if (PAUSED_COMPLETION_ON && !_q) log("[Abyss] node <id>
pruned (objective-complete) -> chest site already tracked/looted (no new queue)")`. Pure log add — the
`abyssSweepAdd` behaviour is unchanged, so flag off = byte-parity.

**Breach / verisium paused-completion holes (brief asked to VERIFY):**
- **Verisium — SAFE.** `objectiveTypeComplete('verisium')` reads `st['Expedition2']`, which never sets (Expedition2
  is deliberately NOT a map objective — comment in `_CQTYPE_OBJNAMES` / OBJ_DRIVABLE). So the objective-bit prune
  never fires for verisium; it's pruned only via `exp2Done`, which the runner sets **after it loots**
  (`if (exp2LootedAt) exp2Done.set(...)`). A paused verisium keeps its entry active → the runner resumes and loots.
  `exp2StaleFarTick` (TASK-53 C) likewise only marks done when already looted; unlooted keeps the anchor. No hole.
- **Breach — different, not abyss's hole.** `objectiveTypeComplete('breach')` reads the real `st['Breach']` bit, so
  the prune CAN delete a breach entry while its runner is paused (line 7485 queues NO sweep site for breach). BUT
  breach has no on-dwell reward chest — breach loot drops on the ground during the roam as mobs die, collected by
  pickit / the utility loot lane / the post-boss sweep. The abyss-specific stranding (chest spawns on the flip and
  is only looted if you dwell on the node) does not apply. So no equivalent chest-strand fix is needed. (If the
  planner wants belt-and-suspenders, a breach roam-end loot-dwell could be added — out of scope for the min fix.)

**Residual (honest):** if the runner reached loot-dwell (`abyssLootDwellAt > 0`) and was paused MID-dwell and never
resumes, the flip-watch still skips it (thinks it's servicing). Narrower than the reported incident (the chest has
already spawned by then → ground loot, recoverable by pickit/sweep). The reported case is `abyssLootDwellAt === 0`
("AT the node clearing", not yet dwelling), which this fix covers.

---

## B. Pickit false-unreachable on web terrain (`PICKIT_ROUTE_REACH_ON`, pickit.js + mapper.js)

**Root cause:** `isItemReachable()` is a straight-line LoS/LoF walkable test. On Mire's bridge-weave, a rule-matched
item across a chasm gap reads unreachable, so the pickit grab is soft-skipped and re-logged forever; the char never
routes around, and the map ends with the item on the ground. (Note: the soft-skip does NOT burn `maxAttempts`, so
the "3 retries" in the brief were 3 throttled log lines over 3 min, not an attempt-abandon — the loss is that the
char never walked there.)

**Fix (producer, pickit.js):** at the reachability-fail branch, before the soft-skip, probe a real route
`poe2.radarFindPath(player, item)`; routable when the path's last point lands within `ROUTE_REACH_END_U` (20u) of
the item — that point is a reachable approach cell. Verdict cached per item id 30s (`_routeReachCache`), and a
per-cycle budget (`_radarBudget = {calls:1}`) caps radar BFS to **one call per pickit cycle** (cache hits are free)
so a burst of stranded items can't stack radar calls into one frame. On routable, publish
`POE2Cache.pickitRouteReach = {id, x, y, apX, apY, until: now+3000}` (nearest item only, one bus slot) and
soft-skip the straight grab. Cache + bus cleared on area change.

**Fix (consumer, mapper.js `getLootUtilityCandidates`):** the item is already in the mapper's existing loot-walk
lane (`walkToLootEnabled` default true → utility state machine, the "sweepLootStep pattern"). When the bus flags it
(fresh + apX finite), retarget the candidate's walk cell to the route's reachable end (`c.x/c.y = apX/apY`) so the
utility walk routes AROUND the gap and pulls us into grab range; then pickit's normal short grab fires there. The
loot utility key is id-based (`loot:id:<id>`), so moving the cell doesn't change the ban key; a prior failed-walk
ban is cleared once per new bus item (`_rrLastHandled`) so a now-confirmed-routable item isn't kept out. Items
radar also can't reach keep today's soft-skip.

**Notes / limits:**
- `PICKIT_ROUTE_REACH_ON` exists in BOTH files (pickit publishes, mapper consumes), both default true. Setting the
  **pickit** one false fully disables the feature (no bus → mapper consumer no-ops) = byte-parity. The mapper one is
  a second independent kill switch on the consume side.
- The handoff walks only when `walkToLootEnabled` is on (default true) — respected intentionally (loot-walk
  disabled = user doesn't want loot detours; the bus log still prints but no walk happens).

---

## C. Explore pocket — strongbox anchor (`STRONGBOX_ANCHOR_ON`, rides `NAV_HV_ANCHORS_ON`, mapper.js)

**Which suspect was real:** Suspect **#1** (the region done-check). A drained disc whose remaining fog-mass drops
below `NAV_REGION_DONE_MASS` is declared done BY DESIGN, leaving a small pocket; the strongbox in it was not an
anchor (deliberately excluded per TASK-38), so nothing pulled the char back. Suspect #2 (rvisit 96u lattice) is a
revealed-but-unvisited mechanism — a dark/unrevealed pocket isn't its domain, and the brief forbids changing the
pitch unilaterally, so I did not.

**Fix:** `_hvAnchorType()` now returns `'strongbox'` for `t.type === 'Strongbox'` → fed as `hv-strongbox` via
`navAddPoi`, so a spotted-then-passed strongbox becomes a K_POI_BASE explore anchor (pulls exploration, loses to
content/boss on score) exactly like an essence. Already `openStrongboxes`-gated **upstream**: `collectOpenTargets`
only emits `type: "Strongbox"` when `openStrongboxes.value` is true, so a Strongbox in the mapper feed implies the
toggle is on. The existing feed's guards apply unchanged (>150u only, one-shot, dropped on big-content-active /
open-ban / consumed-via-isTargetable).

**navigator.js unchanged (why):** all non-`content` POI kinds are scored generically (`K_POI_BASE`) in
`_candidates`; the `add` closure preserves the kind string verbatim. `hv-strongbox` flows through identically to
`hv-essence` — the kind is only a mapper-side log label. No navigator registration/allowlist to update.

**Flag:** `STRONGBOX_ANCHOR_ON` (default true) is a narrow bisect kill switch that also rides `NAV_HV_ANCHORS_ON`
(both must be on to anchor a strongbox). Either off → `_hvAnchorType` returns null for Strongbox = byte-parity.

---

## Settings added (all default TRUE = new behavior on)
| Symbol | File(s) | Default | Flip off → |
|---|---|---|---|
| `PAUSED_COMPLETION_ON` | mapper.js | true | flip-watch unconditionally skips committed node + prune log gone = byte-parity |
| `PICKIT_ROUTE_REACH_ON` | pickit.js + mapper.js | true | pickit stops publishing the bus (pickit-side off fully disables); mapper stops retargeting = byte-parity |
| `STRONGBOX_ANCHOR_ON` | mapper.js | true | strongboxes are not anchors (also gated by `NAV_HV_ANCHORS_ON`) = byte-parity |

New bus field: `POE2Cache.pickitRouteReach` (pickit writes, mapper reads; cleared on area change / expires in 3s).

---

## LIVE-TEST CHECKLIST

### A — paused abyss node (run an abyss map with rares near a pit under pressure)
- **WORKING:** after `[OB] pause content:abyss:<id> by=rare` and the node going spent, watch for
  `[Abyss] node <id> completed while runner paused -> chest site queued` + `[AbyssSweep] abyss node (x,y)
  flip-watch (paused-completion, runner never dwelled) -> chest site queued (N)`, then the sweep servicing it
  (`[AbyssSweep] -> chest site (x,y) …` and a chest opened). Objective still finishes.
- **BROKEN:** `[OB] complete content:abyss:<id> (arb-release, consumed while paused)` with NO
  `while runner paused` line and NO sweep site → chest stranded again (regression).
- **Second exit named:** `[Abyss] node <id> pruned (objective-complete) -> chest site already tracked/looted
  (no new queue)` — the abyss:753-class exit is now visible (only prints when the site was already tracked).

### B — item across a web gap (Mire-type map, pickit enabled + walkToLootEnabled on)
- **WORKING:** `[Pickit] <item> straight-line unreachable but route found -> mapper loot-walk (approach x,y)` →
  the mapper walks (WALKING_TO_UTILITY toward the approach cell) → the item is grabbed (`stats.itemsPickedUp`
  increments / `[Pickit] Picking up: <item>` with debug on). NOT 3 min of "may not be reachable".
- **BROKEN:** repeated "route found -> mapper loot-walk" with no grab and no walk → check `walkToLootEnabled`;
  or the item is genuinely unreachable (radar unroutable) → today's `may not be reachable` soft-skip (correct).
- **Perf watch:** no radar-call bursts — at most one radar BFS per pickit cycle (the `_radarBudget`); no new
  `[Discover] radar route slow` spam attributable to pickit.

### C — strongbox in an unexplored pocket (map with `openStrongboxes` ON)
- **WORKING:** `[Nav] hv anchor +strongbox@(x,y)` when a far (>150u) strongbox is spotted, the nav objective
  becomes `poi:hv:o:…strongbox…`, the char walks to the pocket and opens it, then
  `[Nav] hv anchor -strongbox@(x,y) (consumed)`.
- **BROKEN:** a strongbox visible in a pocket the trail surrounds but never enters, with no `+strongbox` anchor
  line → the pocket is still being abandoned.

## Risks / deviations
- **A:** the flip-watch now probes the committed node's status during clearing (previously skipped). Cost is one
  extra `abyssNodeStatus` read per 1.5s (cached) — negligible. The false-fire race is prevented by the 1.5s throttle
  vs 7Hz runner (argued above). Residual mid-dwell-pause case documented.
- **B:** the handoff relies on the existing loot-utility lane + `walkToLootEnabled`. If the item's radar route ends
  ≤20u away but LoS still fails AT the approach cell (item behind a thin wall), the char loiters there briefly until
  the utility lane's own no-progress cap blacklists it (bounded, no wedge). `PICKIT_ROUTE_REACH_ON` lives in two
  files — noted above; the pickit-side switch is the master.
- **C:** guarded strongboxes are anchored the same as an imprisoned-rare essence (the feed doesn't guard-gate for
  the mapper); the char walks in and the existing strongbox event-hold / attack machinery handles guards on arrival.
  Consistent with essence behavior. No new entity scan (rides the TASK-38 opener feed).

## Open questions
None blocking. One judgment call for the planner: I added `STRONGBOX_ANCHOR_ON` as a dedicated bisect flag even
though the brief said "rides `NAV_HV_ANCHORS_ON`" — it rides that flag AND has its own kill switch (both-on to
anchor). If you'd rather it purely ride `NAV_HV_ANCHORS_ON` with no sub-flag, delete the `STRONGBOX_ANCHOR_ON &&`
guard in `_hvAnchorType` (one-word edit).

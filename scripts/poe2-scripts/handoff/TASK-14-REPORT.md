# TASK-14 REPORT — Post-objective coverage sweep + objBroker default ON

Pre-snapshot: `handoff\pre\TASK-14\mapper.js` (taken before any edit). `node --check mapper.js` PASSES.
Only file touched: `..\mapper.js` (runtime dir). No git operations. No C++/packets/memory writes.

## Files touched + symbols

`mapper.js` — 6 edit sites:

1. **`DEFAULT_SETTINGS.objBroker: false -> true`** (~line 178) + comment swap ("ON (default) = enforcing").
   Nothing else about OB touched: `OB_SHADOW` const, `obOn()`, and the UI checkbox ("Objective broker (one
   goal at a time)") are unchanged and remain the rollback path.
2. **`pickRouteNearestBucket`** (~6576): added module-level `_routePickMass` + three assignments inside the
   function (reset-to-0, `Infinity` on the pre-rebuild fallback, `_chosen.c.mass` after the select loop).
   ASSIGNMENTS ONLY — zero control-flow change, runs identically flag-off; nothing reads the var except the
   coverage sweep. This exposes the picked expanse's mass for the brief's "no mass above a small threshold"
   concede without a second `getUnexploredBuckets` scan (perf rule 4).
3. **NEW: `tryCoverageSweep(player, now)`** (~5367-5460) + consts/state directly above it:
   `COVERAGE_SWEEP_ON` (true), `COVERAGE_SWEEP_BUDGET_MS` (180000), `COVERAGE_MIN_MASS` (30),
   `covSweepStartAt`, `covConceded`, `covRevealed`, `covTgtX/covTgtY`, `_covPickAt`, `_covTrack`.
4. **MAP_COMPLETE Phase 3.75** (~15460): new `COVERAGE_SWEEP_ON && now - _cleanupDriveAt > 5000 &&
   tryCoverageSweep(...)` driver inserted AFTER the `tryDiscoverListedContent` call, same break-hold +
   clock-reset shape. `tryCleanupContent` stays first and untouched.
5. **Cleanup ban-wait** (~15490): the `revisitSkip` ban-extension line now skips OPTIONAL entries when
   `COVERAGE_SWEEP_ON && covRevealed` (map has no routable unexplored mass left). The 20s active-content
   floor still applies; REQUIRED entries keep the full ban-wait (`soonestRequiredBanExpiry` path untouched).
6. **`tryDiscoverListedContent` no-heading branch** (~5305): under `COVERAGE_SWEEP_ON`, the patrol-spoke
   fallback NEVER fires — no marker + no routable mass concedes via the existing sustained no-heading window
   (8s) and returns the frame to coverage/portal. Flag-off: the original patrol code is bit-identical below it.
7. **`resetMapper`** (~10562): one added line resetting all coverage state per map.

## Settings added

None user-visible. `COVERAGE_SWEEP_ON` is a const kill-switch in mapper.js (brief-specified, no UI setting).
`objBroker` default flipped to `true`. **NOTE (per brief): a saved settings file with an EXPLICIT
`objBroker:false` still overrides the default.** The user's current profile already has it true — no action
needed; a fresh profile now gets OB enforcing from the first run.

## How it behaves (flag ON)

Inside the existing MAP_COMPLETE cleanup gate (objective-complete, content still outstanding/unfound), per frame:
`tryCleanupContent` (unchanged, owns reachable queued content) → `tryDiscoverListedContent` (unchanged
marker-first hunt, minus patrol spokes) → **`tryCoverageSweep`**: routes to the largest routable unexplored
mass via `pickRouteNearestBucket`, sticky commit per bucket (re-pick only on reached <60u / 12s OWNED
no-progress via `trackOwnedProgress` — dodge/stolen-broker frames never tick), walks with
`startWalkingTo`/`stepPathWalker` + the same fog-frontier crawl discover uses. Packs die en route via
entity_actions; revealed content streams into the queue and cleanup drives it next frame.

Termination guarantees (all latched, all bounded): coverage budget 180s (`covConceded`) → no routable mass
above `COVERAGE_MIN_MASS` (`covRevealed`, concedes the frame) → the existing cleanup fast-out/budget then
portals, and with `covRevealed` set the fast-out no longer waits out 60s bans on OPTIONAL content (≤20s tail).
The whole thing also stays under the existing `OBJ_CLEANUP_BUDGET_MS` (150s, refreshed only by completions),
so the effective coverage bound is min(180s, cleanup budget). Strict-finish gates, pre-boss flow, and the
boss-approach chain are untouched; coverage stands down whenever `nearestOutstandingRequiredContent` has a
drivable required target (same rule as discover).

## LIVE-TEST CHECKLIST

On an objective-complete map with unexplored mass + leftover content:
- `[Coverage] sweep armed (budget 180s)` once, then `[Coverage] -> mass (x,y)` with INTERIOR coordinates.
  **Broken =** repeated `-> mass` picks sharing a constant edge row (the y=159 pattern) or ping-ponging A→B→A.
- Bot walks the committed mass, kills packs on the way; status line `Map complete: coverage sweep -> (x,y) (Ns budget)`.
- A beacon/breach revealed mid-sweep → `[Cleanup]` lines take over and drive it (coverage yields automatically).
- Occasional `[Coverage] mass (x,y) has no revealed neighbor (margin phantom) -> banned` at sweep start is
  EXPECTED (border phantoms being burned off). **Broken =** an endless stream of these with no `-> mass` commit.
- End of map: `[Coverage] no routable unexplored mass >=30 left -> map substantially revealed, conceding`,
  then within ~20s `[Cleanup] outstanding objectives but nothing reachable for Xs -> leaving anyway` → portal.
  **Broken =** sitting in `content remains, nothing reachable...` for 60s+ with only a banned optional beacon left.
- Unfound-listed case: `[Discover] nothing to reveal here (coverage owns the sweep) -> conceded` replaces
  patrol lines. **Broken =** ANY `[Discover] no fog frontier -> patrol spoke toward` line (must be impossible now).
- Hard cap: `[Coverage] budget spent -> conceding to portal` at 180s worst case; the map must ALWAYS portal.
- Strict-finish regression check: a map with a readable-INCOMPLETE main objective must still refuse the portal
  exactly as before (`[Cleanup] portal gate: main objective INCOMPLETE`).
- OB default: on a FRESH profile the mapper logs `[OB] ... flag=on` without touching the checkbox; the user's
  existing profile is unaffected. Rollback = untick the checkbox (or `OB_SHADOW=false`).

## Risks / deviations from the brief (with why)

1. **Phantom-margin guard added to coverage picks** (`bucketTouchesRevealed`, existing helper, coverage-local
   ban + picker-cache drop). The brief prescribes raw `pickRouteNearestBucket`, but that picker has NO phantom
   filter (only `pickUnexploredHeading` got the 2026-07-06 fix) and its mass scoring sorts saturated border
   buckets FIRST — the audit's `(1186,159)/(323,159)/(755,159)` constant-y picks match margin-phantom bucket
   rows, not patrol spokes. Without the guard the sweep would reproduce the exact corner-ping it exists to fix
   and fail the acceptance's "NOT y=edge" criterion. Discover's own bucket path was deliberately NOT changed.
2. **`_routePickMass` assignments inside the shared picker** — control flow untouched (see above); flagged here
   because it is technically a shared-path edit.
3. **Coverage runs INSIDE the Phase 3.75 cleanup gate**, i.e. only while the map still has outstanding /
   queued / unfound content. A map with truly nothing left portals immediately as today (no unconditional
   180s full-clear per map — that would be a large throughput change the brief's concede rules don't describe).
   The audit case (banned beacon left) opens the gate, so it is covered. Flag if unintended.
4. **The "~15s" discover fast-concede is emergent, not a literal 15s clock**: patrol suppression + the existing
   8s sustained-no-heading concede + the 9s stall-ban that usually precedes it ≈ 15-17s. A literal
   elapsed-time+no-mass check would have conceded mid-MARKER-walk (markers sit on revealed ground where the
   mass picker legitimately returns null), killing the proven marker-first mechanism.
5. **Ban-wait skip is OPTIONAL-only.** The brief's "Do NOT wait out 60s bans" sentence names optional content;
   required entries keep full patience so the strict-finish/required flow is provably untouched.
6. **Boss-arena exclusion mirrored into coverage** (10min ban within 200u of the death/arena anchor) — discover
   precedent; without it the densest "unexplored" mass near the arena walls paces the boss room.
7. `COVERAGE_MIN_MASS = 30` is a judgment call (border saturation is ~162/bucket; 30 ≈ a real but small pocket).
   TUNABLE-commented for the planner.

## Open questions

- Should coverage also sweep maps whose cleanup gate never opens (zero outstanding content) — i.e. a true
  full-clear mode? Not shipped (deviation 3); trivial to extend if the ruling meant that.
- If the planner wants the phantom-margin guard inside `pickRouteNearestBucket` itself (fixing discover and the
  strict-finish sweep too), that's a follow-up task — it changes flag-independent behavior, so I kept it out.

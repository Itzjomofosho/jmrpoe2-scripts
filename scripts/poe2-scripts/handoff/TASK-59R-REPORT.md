# TASK-59R REPORT — movement ownership refactor (intents in, ONE resolver out)

Pre-snapshots: `handoff\pre\TASK-59R\mapper.js` + `handoff\pre\TASK-59R\navigator.js` (taken FIRST, before any edit).
Rollback = restore those two files + delete `movement_intents.js`.

## Files touched
- **`movement_intents.js` (NEW, ~170 lines)** — the resolver. Exports `MI`, `miConfigure`, `miOwner`.
- **`mapper.js`** — every mapper-side movement call site (199 of them) now submits through `MI`; legacy
  FINDING_BOSS explore stack DELETED (−137 lines); S5 white-chase folded into candidate priority.
- **`navigator.js`** — UNTOUCHED (verified: it contains zero movement calls; it only plans).

## Architecture (what reviewers should check first)
`movement_intents.js` — claim-based resolver. Key deviation from the brief's literal "collect per frame,
ONE resolve(now) at frame end": ~40 call sites synchronously branch on the walker verdict
(`step === 'stuck'` → soft-block/ban/re-pick, `'arrived'` → phase advance). A deferred batch-resolve
would have forced rewriting every runner into two-phase (submit now, read verdict next frame) — the
highest-risk change possible here. Instead **submission IS arbitration**: `MI.walk/step/hold/direct/
nudge/gridStep(owner, ...)` claims the frame; the winner's call executes the walker synchronously
(verdict semantics preserved exactly); a loser gets `'deferred'` and NO walker call happens. The
resolve rule set still lives in exactly one place (`MI.claim`), and the resolver is the only caller of
`startWalkingTo / stepPathWalker / sendStopMovementLimited / sendMoveAngleLimited / sendMoveGridLimited /
moveTowardGridPos` (injected via `miConfigure({exec})`; the fns stay defined in mapper — Phase 4 moves them).

Arbitration rules (hysteresis / min-dwell / defer-never-ban, HERE once):
- Strictly higher class preempts **instantly** (fight never waits on content).
- While the standing winner is FRESH (`GRACE=450ms` since its last claim, ~3 logic frames) — or a sticky
  winner younger than `MIN_DWELL=700ms` — a **different owner at same-or-lower class** is deferred.
- A winner that stops claiming goes stale after GRACE → next claimant takes over (≤450ms handoff).
- Every denial is recorded (`MI.denied`); `runnerSpanStolen()` and `navMoveStolen` (TASK-50 bus) now
  consult `MI.deniedRecently(...)` → a resolver-denied frame freezes that runner's reach/ban clocks
  (defer, never ban — commitment discipline).
- `'deferred'` is truthy — every site that truth-tested a sender's return uses `miOk()` (mapper helper).

MB (movement_broker.js) is **unchanged** underneath as the packet-level backstop; all existing `MB.set`
declarations were kept (deleting them would change packet-gate outcomes). Dodge is untouched: auto_dodge
keeps MB p1 + `dodgeMoveSuppressUntil` exactly as today; MI never delays or owns a dodge (brief §5).

## Intent table (owner → class; class ladder: 1 dodge [packet-level] > 2 fight > 3 engaged > 4 committed > 5 utility > 6 nav > 7 idle)
| owner | class | submitted from |
|---|---|---|
| `fight` | 2 | FIGHTING_BOSS movement (stance holds, nudges, press-in via `stepFightDirectMove`, orbit arcs, dead-boss stops), boss-death escapes/retreat |
| `posture` | 2 | `fightHoldPostureStep` back-out / cast-gap / hazard steps (4 `moveTowardGridPos` → `MI.direct`) |
| `rare` | 3 | `runClearNearbyRares` engage walk/hold |
| `breach` | 3 | `runWalkToBreach` + `runBreachRoam` (chase/standoff/sweep/loot plants) |
| `abyss` | 3 | `runAbyssRun` (reach walk, chase, recenter, dwell plants, tidy hold) + OB anchor walk-back |
| `verisium` | 3 | `_runExpedition2` all phases (walk/open/awaitpick/fighting/loot) + `exp2SideStep` |
| `hive` | 3 | `runHiveDefense` + `hiveArrivalDwell` (kite/intercept/summon) |
| `stone` | 3 | `runStoneCircle` (rock walk, centre hold, recover) |
| `essence` | 3 | `essenceFightStep` (ring kite/drift/plant) |
| `sbox` | 3 | strongbox event hold (`sboxEventHoldStep`) |
| `beacon` | 3 | beacon chest dwell + `beaconArrivalDwell` centre drive/plant |
| `incursion` | 3 | chest run + beacon run (`navTo` owner) |
| `delirium` | 3 | mirror walk-in (`handleDeliriumMirror`) + piece runs (`runDelirium`) |
| `seal` | 3 | Runic Seal walk (`runRunicSeals`) |
| `engaged` | 3 | 47-B engaged-hold walk-back (`arbEngagedHold`) |
| `arb` | 4 | committed drives: `arbExploreToward` / `arbCoordDrive` / `arbFarWalk` (43-A/56-A hold class) |
| `revisit` / `cleanup` / `discover` / `required` | 4 | pre-boss revisit, post-boss cleanup (+Cleanup Reveal), content discover, pre-boss required pass |
| `abyss-sweep` / `loot-sweep` / `coverage` | 4 | abyss chest sweep, `sweepLootStep`, coverage sweep (flag-off today) |
| `utility` | 5 | utility state walks, approach-cell re-issues, detours, dwell plants, strongbox kite |
| `boss-walk` | 6 | checkpoint/arena/melee approach legs, radar/hint explores, ckpt-yield hold, melee waits |
| `chase` | 6 | S5 elite/mob chase + adjacent-mob stand + pack step-out |
| `nav` | 6 | navigator-owned explore ('Nav Explore'), map-start hold, frontier fallback |
| `temple` | 6 | temple find/walk/clear/center + temple search exploration |
| `mapdone` | 6 | MAP_COMPLETE retreat-ring plant, boss-room exit, precursor beacon, objective sweep, portal-gate holds |

## Deleted paths (each with the superseding rule)
1. **Legacy FINDING_BOSS explore block** (the `else` after the nav-explore branch: marker scan,
   `getExploreLandmark` pick, `pickUnexploredHeading` commit machinery, corridor-latch hop, 40u crawl
   clamp, boss-direct + `_bd*` wedge bans, 'Boss Explore' walk + boxed-in plant — 137 lines).
   *Superseded by*: TASK-39/44 — navigator owns explore (`NAV_ON` has been const `true`). Replaced with a
   **thin nav-null >3s fallback**: nav returns no objective for >3s → one `pickUnexploredHeading` frontier
   intent (`'Frontier Fallback'`, owner `nav`); else the planted "PAUSED: navigator has no objective" as
   today. New state: `_navNullSince` (reset per map + on any nav waypoint).
2. **S5 white-chase** (the `S5_CHASE_MAGIC_PLUS` post-filter block + the const). *Superseded by*: 58-core
   hotfix, now folded INTO candidate priority — the mob-scan loop skips non-`Magic|Rare|Unique` subtypes
   up front (fails open on missing subtype), so a white can never latch, chase-walk, or hold. Same
   behavior, one rule instead of scan-then-unpick.
3. **Delirium raw nudge** — the arrival nudge used raw `sendMoveGridDir` (bypassing every gate); now
   `MI.gridStep(MOV.delirium, ..., force)` through the gated sender. (Behavior note under Risks.)

Deliberately NOT deleted: per-runner stop/plant calls that the brief called "duplicated" are each the
single plant for their branch (converted to `MI.hold`, not removed) — removing any would introduce drift
on hold frames. No literal duplicate stop-after-stop existed after conversion.

## Bilateral gates → resolver rules (43-A / 47-B / 53-A / 56-A / 58-core, [OB])
- The gates' movement-layer enforcement is now **structural**: engaged(3) mechanically defers rare(3)
  same-class steals and utility(5)/boss-walk(6) claims while fresh; committed(4) defers utility/nav.
- The explicit gate call sites were **kept** where they gate non-movement side effects (state changes,
  session-clock starts) and to preserve the exact forensic log vocabulary:
  `[Engaged] rare-chase deferred (...)`, `[Engaged] utility start deferred (...)`, `[Ckpt] yielding ...`,
  `[Posture] reach-yield ...` all still fire with the same text.
- 58-core is fully folded (see deletion 2). The OB shadow ledger keeps recording unchanged; the resolver
  additionally keeps its OWN ledger (`MI.spans`, capped 60 owner-spans — readable live via
  `bridge eval_js: new POE2() ... MI status`; `MI.status()` also rides both heartbeat lines as `miOwn=`).

## Log-line mapping (the user's forensics vocabulary)
| old | new |
|---|---|
| `Walking to <name> at (x, y) [pathType=..]` | same + ` [own=<owner>]` (acceptance: every walk line names its owner) |
| `[MB] BLOCK: a(pX) vs holder b(pY)` (spam) | `[MI] <loser>(cN) deferred: <winner>(cM) holds "<tgt>"` — one line per contested owner-pair per 1.5s. `[MB] BLOCK` still exists as packet-level backstop but should now be rare |
| (none) | `[MI] <owner>(cN) preempts <owner>(cM) -> "<tgt>"` on higher-class takeovers |
| `[Nav] no objective available (...)` | unchanged; after >3s also `Nav idle -> frontier <d>u` + `Walking to Frontier Fallback ... [own=nav]` |
| `[S5] mob hold expired / no line-of-fire` | unchanged (rare/magic chases only now) |
| `[Engaged]/[Ckpt]/[Posture]/[Breach]/[Abyss]/[Exp2]/[Hive]/[Incursion]/[Cleanup]/[Discover]/[Coverage]` | all unchanged |
| heartbeat `... mbHold=X` | + ` miOwn=<owner>(cN) "<tgt>"` |

## Unconverted writers (deliberate, each with why)
| site | call | why kept direct |
|---|---|---|
| master-toggle-off (processMapper top) | `sendStopMovementLimited(true)` ×1 | disable/abort safety stop right after `resetMapper` (MI just reset; arbitration meaningless) |
| hideout-entry-stale / non-map-area | `sendStopMovementLimited(true)` ×2 | same reset-path abort stops |
| hotkey-toggle-off / UI-checkbox toggle | `sendStopMovementLimited(true)` ×2 | same (user-initiated disable) |
| dodge walk-egress (post-`runAutoDodge`) | `sendMoveGridLimited(_we.dx,_we.dy,true)` | dodge keeps hard priority exactly as today (brief §5) |
| drawUI manual N/S/E/W buttons | `moveAngle(...)` ×8 | user-driven debug controls, not a bot writer |
| walker internals (`stepPathWalker`, `moveTowardGridPos`) | dislodge/arrival-stop/steer sends | part of the walker primitive itself — executed only when MI drives it |

## Settings added
NONE. Per the brief: this is a structural refactor; no flag can gate it. Rollback = the pre-snapshot
copies. (`MI.GRACE`=450ms / `MI.MIN_DWELL`=700ms are code constants in movement_intents.js, tunable.)

## Risks / deviations from the brief
1. **Claim-based instead of collect-then-resolve** (see Architecture) — same single-owner rule set, same
   single module; preserves ~40 synchronous stuck/arrived reads that a deferred resolver would break.
2. **Handoff debounce**: an owner taking over from a same/lower-class fresh winner now waits ≤450ms
   (GRACE) / ≤700ms (MIN_DWELL after a fresh claim). This is the anti-yoyo core, but it means e.g.
   loot-sweep after a breach dwell, or a rare engage after an arb walk, starts up to ~0.5s later than
   today. Watch for feel changes, not correctness changes.
3. **`'deferred'` treated as owning the frame** in `arbCoordDrive`/`arbFarWalk`/revisit/cleanup
   (`step === 'walking' || step === 'deferred'` → hold + return true) — deliberately so a denied frame
   can't fall through to `revisitSkip` bans (defer-never-ban).
4. **Delirium arrival nudge** now goes through the gated sender (was raw `sendMoveGridDir`); the gated
   path adds heading low-pass + move-interval throttling — the nudge may land one ~200ms tick later.
   Forced (`force=true`) so dodge-suppress can't eat it... note: force also bypasses the min-gap, so in
   practice behavior should be identical.
5. **Melee walk legs are class 6 (`boss-walk`), not fight(2)** — matches today's chain order (engaged
   content finishes during the walk-in, 47-B); the packet-level MB 'fight' p2 for that state is unchanged.
   Only FIGHTING_BOSS movement is class 2.
6. **Orphaned-but-left dead code** (now unreferenced after deletion 1, kept to keep the diff reviewable;
   planner may delete next pass): `corridorLatchTick`/`corridorLatchHop`/`CORRIDOR_LATCH_ON` + `_cor*`
   state, `_bdFailX/Y/N`/`_bdBanUntil` (still reset in resetMapper), `_exploreBossDirect` (still read in
   stepPathWalker, now permanently false → explore stuck-abandon uses 1-strike for clamped hops as
   before; melee 3-strike unaffected), `exploreTgtIsMarker` (still written, never read for validity now).
7. **OB ledger not rewired** — brief §4 wanted the OB shadow ledger to "become the resolver's own
   ledger". OB's bookkeeping is interleaved with commitment-freeze semantics far beyond movement;
   rewiring it was judged out of safe scope for one session. Instead MI keeps its own compact span
   ledger and OB continues recording as before. Honest partial.
8. `runnerSpanStolen` freeze keys map content types to owner names via `type.split('-')[0]`
   ('incursion-chest' → 'incursion'). 'breach2' (hive) spans are keyed by owner 'hive' at its own sites;
   the hive runner does not use runnerSpanStolen, so no mismatch.

## LIVE-TEST CHECKLIST (one map end-to-end)
Working looks like:
- Every `Walking to ...` line ends with `[own=...]` and the owner matches the subsystem doing the work.
- Contested frames produce single `[MI] x(cN) deferred: y(cM) holds "..."` lines (throttled), NOT `[MB] BLOCK` spam.
- **No opposite-direction walk pairs within 5s** anywhere in the log (the acceptance criterion) — in
  particular no `Nav Explore`↔`Boss Explore` alternation (white-chase gone) and no checkpoint↔utility flap.
- Explore during boss-find shows `[own=nav]` ('Nav Explore'); if nav goes quiet: after ~3s a
  `Nav idle -> frontier ...` + `Frontier Fallback [own=nav]` walk instead of a permanent PAUSED plant.
- Dodge latency unchanged: rolls still instant during any walk (dodge is packet-level, untouched).
- Content completes as today: breach touch→roam→loot, verisium open→fight→loot, hive summon→defend,
  beacon energise dwell — all with their usual log lines.
- Heartbeats show `miOwn=<owner>`.
Broken looks like:
- The bot freezes >2s outside dodge windows with `[MI] ... deferred` repeating for the SAME pair
  continuously (a livelock between two claimants — report the pair; rollback = pre-snapshots).
- Any `Walking to ... [own=?]` (an unconverted writer slipped through MI with no owner).
- A runner banning/skipping content immediately after `[MI] <that owner> deferred` lines (a clock that
  didn't freeze on denial — report which owner).
- Whites dragging the walk again (chase lines for non-magic mobs) — the fold regressed.

## Open questions for the planner
- Should the orphaned corridor-latch / boss-direct machinery (Risk 6) be deleted in a follow-up pass?
- `chase`(6) vs `nav`(6) same-class: chase wins only via the elite/mob branch running first + nav going
  stale (450ms). If live testing shows chase feeling sluggish to engage, drop GRACE to ~300ms or give
  chase class 5.5 semantics (new class between utility and nav).

Verification done: `node --check` green on mapper.js + movement_intents.js after every increment; MOV
token grep (all 27 owners resolve), `'deferred'`-truthiness audit (miOk at all truth-test sites), raw
primitive grep (only senders/walker internals/manual buttons remain), navigator.js movement grep (zero).

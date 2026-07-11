# TASK-16 REPORT — Silent-frame visibility + stuck-dead cleanup

Status: IMPLEMENTED. `node --check mapper.js` passes. Pre-snapshot in `handoff\pre\TASK-16\mapper.js`.
mapper.js ONLY — no chicken.js, no disconnect/exit logic anywhere, no defaults flipped, death fail-safe
(`tryHandleDeathReturn`) and the validity bail untouched.

## Files touched

- `mapper.js` (runtime dir) — 3 edits, all in/around `processMapper`.

## Symbols added / modified (searchable)

Added (module scope, directly above the MASTER-TOGGLE DEBOUNCE block / `processMapper`):
- `SILENT_FRAME_GUARD_ON` — const flag, `true` (brief-specified const, same pattern as `TRAIL_BIAS_ON`; no UI setting).
- `SF_CLEANUP_MS` — 120000; blind-streak age that fires the release, and the re-arm spacing.
- `_sfInvalidSince`, `_sfNullN`, `_sfUndefN`, `_sfNextLogAt`, `_sfProbeAt`, `_sfProbeTxt`, `_sfCleanupAt` — guard state.
- `_sfProbeArea(now)` — `poe2.getAreaInfo()` probe, 1s throttle, only called while a streak is live.
- `silentFrameGuardTick()` — the guard body (streak instrumentation → 120s cleanup → moved heartbeat).

Modified:
- `processMapper` — one added call right after the master-toggle check (`_mtOffPasses = 0;`):
  `if (SILENT_FRAME_GUARD_ON) silentFrameGuardTick();` — above the player-validity bail, the death
  fail-safe, the area guard, and the whole-map clock.
- The in-clock 60s heartbeat (search `SILENT-STALL HEARTBEAT`) — condition prefixed with
  `!SILENT_FRAME_GUARD_ON &&` so the guard owns the line when on; flag off = the original condition
  evaluates identically (parity).

## What the guard does (flag ON)

1. **Unreachable-proof heartbeat** — same 60s nothing-has-logged cadence and format as before, one added
   field `playerRead=OK` / `playerRead=INVALID <N>s`. Runs for any non-IDLE state (incl. HIDEOUT_ states
   and before the map clock starts) because it now sits above every bail — strictly broader coverage than
   the old in-clock copy.
2. **Invalid-read streak** — counts consecutive ms where `POE2Cache.getLocalPlayer()` is null/threw or
   `gridX === undefined`, only while `currentState !== STATE.IDLE`; reset on any valid read. First
   `[SilentFrame]` line at 10s, then every 30s: null-vs-gridXundef frame split + areaInfo probe result
   (`areaName` / `null` / `threw` — names whether OTHER reads still work). A recovery line logs when a
   ≥10s streak ends (sub-10s flickers stay silent).
3. **Stuck-dead cleanup** — at 120s of streak in a map state (non-IDLE, non-HIDEOUT_): loud log +
   `sendBackToHideoutAndReset('SilentFrame')` — the EXISTING resurrect/release pair (006C+0177), exactly
   the manual death-screen release; server no-ops on a living char. Re-arm: won't fire again within 120s
   (`_sfCleanupAt`), and the reset drops state to IDLE which stops the streak anyway.

Per-frame cost: one `POE2Cache.getLocalPlayer()` call (per-frame cached — the bail immediately below does
the same read, so net zero extra native reads) + arithmetic. The areaInfo probe only runs while a streak
is live and in practice only when a `[SilentFrame]` line is about to print (see deviations). No entity
scans, no movement, no memory writes, no new packets.

## Flag-off parity

`SILENT_FRAME_GUARD_ON = false` →
- guard call skipped (single `if` at the top of `processMapper`),
- in-clock heartbeat condition `!false && <original>` ≡ original,
- new consts/lets/functions are inert declarations.
Control flow byte-identical to the pre-task file.

## LIVE-TEST CHECKLIST

1. **Induced silence, healthy reads** (acceptance test): mid-map, put the mapper in any state that logs
   nothing for 60s+. WORKING: within ~60s —
   `heartbeat: state=<STATE> status="..." pos=(x,y) target=...(...) lock=... mbHold=... playerRead=OK`
   and it repeats each ~60s of continued silence. BROKEN: no heartbeat within 60s, or `playerRead=INVALID`
   while the char is visibly fine.
2. **Next stale-read occurrence** (passive — this is the instrumentation payoff): expect at ~10s
   `[SilentFrame] player read INVALID 10s (null=N gridXundef=M) state=<STATE> areaProbe=<area|null|threw>`
   then every 30s with growing counters. **Please save these lines** — the null-vs-undef split + areaProbe
   result is the data for the C++ root-cause fix (stale/recycled player slab theory).
3. **120s cleanup**: if the streak reaches 120s in a map state —
   `[SilentFrame] 120s of blind frames in <STATE> (...) -> releasing via resurrect sequence` followed by
   `[SilentFrame] Resurrect sequence sent (checkpoint / hideout if out of revives, A then B), okA=..., okB=...`.
   WORKING: dead char releases to checkpoint/hideout and the loop continues; living char = nothing happens
   in game (server no-op), mapper resets to IDLE. BROKEN: resurrect lines repeating faster than 120s apart.
4. **Regression — real death with healthy reads**: must look exactly like today:
   `Health 0 detected, re-validating in 2.0s...` → `[Death] Resurrect sequence sent ...`. No `[SilentFrame]`
   lines should appear (reads are valid on a normal death screen).
5. **Optional parity spot-check**: flip `SILENT_FRAME_GUARD_ON` to `false`, reload — zero `[SilentFrame]`
   lines ever; heartbeat only inside maps as before.

## Deviations from the brief (with why)

- **areaInfo probe cadence**: brief allows probing up to once/1s while the streak is live; I probe only
  when a `[SilentFrame]` line (10s/30s/cleanup) is about to print — always fresh at log time, and 29
  unread probes per 30s window are skipped. Strictly within the 1s-throttle hard limit. `_sfProbeArea`
  keeps the 1s throttle internally in case call sites grow.
- **Heartbeat during a live streak**: the heartbeat keeps its exact "60s since ANY mapper log" semantics
  (brief: "keeps its 60s cadence"). Since streak lines log every 30s, they keep `lastLogTime` fresh — so
  during a long streak, visibility is carried by the richer `[SilentFrame]` lines rather than heartbeats.
  `playerRead=INVALID <N>s` shows on heartbeats when an invalid read begins inside an existing silence
  window (before the 10s streak line) — the brief's example rendered verbatim would only occur if the
  streak logger were silenced, which can't happen (same function, no bail between them).
- **Recovery line** (`player read recovered after Ns`) is not in the brief — added for forensics (bounds
  the streak end for log correlation), gated to ≥10s streaks so read flickers can't spam.
- **Streak counts in HIDEOUT_ states** (brief says streak = `state !== IDLE`); the 120s cleanup is
  map-state-only per the brief, so HIDEOUT_ streaks log but never fire the release.

## Risks

- The cleanup fires on ANY 120s invalid-read streak in a map state — including a hypothetical
  read-broken-but-alive-and-fighting case, where the release packet is a server no-op but
  `resetMapper('resurrect')` still drops the mapper to IDLE mid-map (it was blind and doing nothing
  anyway; on read recovery the area guard / normal flow picks back up). This matches the brief's intent
  ("char long dead or the read unrecoverable").
- `[SilentFrame]` streak lines during a genuinely-dead-on-screen wait will also count down to the same
  release the death fail-safe would have sent had reads been healthy — the two paths converge on
  `sendBackToHideoutAndReset`, so double-fire is impossible in one frame and harmless across frames
  (both are the manual-release equivalent).

## Open questions

None blocking. One for the planner: should the 120s cleanup ALSO cover HIDEOUT_ states (currently excluded
per the brief's "map state" wording)? An invalid read wedged in a HIDEOUT_ state would log streak lines
forever but never self-heal; today that case has never been observed (the incident recovered on hideout entry).

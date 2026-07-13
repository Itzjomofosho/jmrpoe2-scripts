# TASK-53 — Posture fights the approach + TTL release/instant-reclaim cycle + engaged-at-62u phase wedge

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-53\`. File: mapper.js ONLY. USE OPUS 4.8.
SEQUENCING: fires FIRST (before TASK-51 — this one wedges whole maps; planner reordered 2026-07-13).
Evidence: C:\tmp\log.txt (Flotsam 15:12-15:14, 2026-07-13) + user screenshot (verisium select panel OPEN,
no pick ever made, encounter never run).

## The three-feature standoff (each part works; the combination deadlocks)
- Committed verisium:1287; the walk NEVER closes: `No net progress toward Verisium for 8s at 62u
  (wall-slide?)` x2, while [Posture] back-outs fire at hostiles 17-23u -> step to 55u ring -> approach ->
  back-out -> repeat. POSTURE IS FIGHTING THE REACH LEG.
- 15:12:49.699 all in one ms: `[OB] would-ban-suppressed ... wall=75126ms owned=31078ms cap=75000ms` (the
  TASK-47 owned-frames justice correctly refuses the unreachability ban) -> `[OB] complete (arb-release)` ->
  `[OB] claim=content:verisium:1287 (fresh)` — TTL release + suppressed ban + R4 = INSTANT same-key re-claim.
  Nothing changed; the cycle can spin every 75s forever.
- `[Engaged] utility start deferred / rare-chase deferred (verisium engaged)` — exp2 reads ENGAGED while the
  char is 62u away and has never reached the stone; 47-B then holds every other system hostage to it. The
  select panel is OPEN in the UI with no pick (screenshot) — something opened it (or a prior attempt's
  anchor state lingers) without the select/hammer chain running.

## A. POSTURE MUST NOT FIGHT A COMMITTED REACH LEG
While the frame's goal is an APPROACH (exp2 walk/loot-nav, opener commit-walk, abyss Phase A reach, breach
Phase 1): the 55u-ring BACK-OUT does not fire against hostiles that lie WITHIN ~30u of the approach path's
direction (the attack chain kills them as we push; stepping back just re-opens the gap — the 8s wall-slide
x2 is this loop). Perpendicular SIDE-steps stay allowed (they don't lose progress); PANIC/blind egress and
dodge are untouched (survival outranks reach). Flag `POSTURE_REACH_YIELD_ON = true`. State the exact signal
used for "a reach leg is active" (the runners' walk phases already exist — reuse, no new state).

## B. TTL RELEASE WITH SUPPRESSED BAN MUST NOT INSTANT-RECLAIM FRESH
When arbTerminated TTLs a commit and the unreachability ban is SUPPRESSED (owned < cap — justice correct),
the same key re-claiming on the SAME pick pass restarts wall/owned clocks from zero = an unbounded cycle.
FIX: carry the owned-clock forward on an immediate same-key re-claim (treat as RESUME: keep arbCommittedSince
lineage or seed the new commit's owned accounting from the released record), AND after N (=2) consecutive
TTL-release->same-key-reclaim cycles with no reach progress, apply a SHORT defer (60s revisitSkip — a defer,
not the unreachability ban; the item stays completable post-boss). Log: `[Arb] verisium:1287 ttl-cycled 2x
without progress -> deferred 60s`.

## C. ENGAGED-AT-62u: name what set the phase, then gate the anchor on REACH
Deliverable 1: trace WHY engagedContentAnchor read verisium engaged while the stone was never reached (no
`remnant reached` log this window; panel open in UI). Suspects: a prior attempt this map leaving exp2Phase/
exp2ClearAt set (the TASK-50 anchor/resume state), or proximity panel-open feeding a phase transition.
Deliverable 2 (fix): the engaged anchor requires the encounter to have been physically REACHED (the runner's
own reached signal: exp2ClearAt/exp2 open-chain begun within ~35u) — a walk-phase 62u out must read as a
REACH, not an engagement, so 47-B's gates don't hold the map hostage to it. The panel-open-no-pick state:
if the select panel is open and the pick chain is NOT running (awaitpick not active), close it (the existing
ESC-equivalent path) and retire the attempt cleanly.

## Hard limits
- mapper.js only. A/B/C independently flagged; flags off = today byte-parity. Do NOT weaken: the ban
  suppression itself (justice is correct — B changes the RECLAIM, not the suppression), panic/dodge, the
  engaged gates' design (C narrows their INPUT signal, not their behavior). node --check; TEST BEFORE COMMIT.

## Acceptance
- A verisium behind a contested approach: the char pushes through (posture side-steps only), reaches, runs
  the chain; no 8s wall-slide loops caused by back-outs.
- No same-ms release->reclaim pairs in the log; a genuinely unreachable stone defers after 2 cycles and the
  map proceeds (post-boss cleanup may retry it).
- [Engaged] lines appear ONLY after a real reach; a panel left open with no pick gets closed + retired.

# TASK-20 — Shared picker: phantom-margin filter at the source + pre-boss explore routability

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-20\`. File: `..\mapper.js` ONLY.
DO NOT START while TASK-21 is open (both edit mapper.js; one implementer at a time).

## Evidence
- TASK-14 deviation #1 (planner-confirmed): `pickRouteNearestBucket` never received the `bucketTouchesRevealed`
  phantom filter (only `pickUnexploredHeading` got it) and its mass scoring SORTS saturated border buckets first —
  the mechanism behind every constant-y map-edge pick in the audits (Excavation corner-ping, Willow y=159 rows).
  Coverage carries a LOCAL guard (ban + re-pick per serve); discover still gets served phantoms.
- Combined-test map 1 (Spring_, C:\tmp\log.txt 17:37-17:39): pre-boss explore banned `(776,465)` as unreachable
  only after walking at it, landmark `(2277,552)` burned a 25s no-progress window, then re-picked across the map —
  the user watched it "exploring BACKWARDS." Reachability is knowable at pick time via `macroPathTo`.

## What ships (const `PICKER_PHANTOM_ON = true` — one-token rollback; note this changes flag-independent
## discover behavior BY DESIGN, that is the point)
1. **Phantom filter in the shared picker**: inside `pickRouteNearestBucket`'s scoring loop, skip any bucket with
   `!bucketTouchesRevealed(x, y)` BEFORE scoring (cheap; the helper exists). Coverage's local guard becomes
   redundant-but-harmless — LEAVE IT (defense in depth; do not refactor it out in this task).
2. **Routability at pick time (pre-boss explore)**: where the explore/landmark flow commits a heading/landmark
   (`pickUnexploredHeading` consumers + the landmark commit site), pre-check the candidate with the router:
   `macroPathTo` unreachable -> ban the bucket immediately (`_unexpFailed`, the existing 3min TTL) and re-pick,
   instead of walking 25s to learn it. THROTTLE: at most 2 router probes per pick pass (the probe is the expensive
   bit); an unprobed candidate proceeds as today (the walk-based bans remain the backstop — do NOT remove any
   existing bound/ban, this is an accelerator not a replacement).
3. **Verify + report (no blind edit)**: TASK-14's report claims `pickUnexploredHeading` already has the phantom
   filter — CONFIRM in-tree; if it is missing or partial (e.g. filters the pick but not the fallback), extend the
   same filter there and say so.

## Hard limits
- mapper.js only. No changes to coverage's guard, trail bias math, `getUnexploredBuckets`, or any walker/ban bound.
- No new native scans; `bucketTouchesRevealed` + throttled `macroPathTo` probes only.
- Flag-off (`PICKER_PHANTOM_ON = false`): both changes vanish, byte-parity.

## Acceptance
- `node --check mapper.js`; parity walk.
- Report per HOUSE_RULES + live-test checklist: no constant-y edge picks in [Explore]/[Discover]/[Coverage] lines
  across a session; unreachable buckets ban at PICK time (log line) instead of after a 25s walk; discover on a
  fogged map routes to real mass first pass.

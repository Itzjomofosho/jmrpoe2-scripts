# TASK-16 — Silent-frame visibility + stuck-dead cleanup (mapper.js ONLY — NO chicken, NO disconnect)

USER RULING (final): no disconnect/exit logic of any kind — not hardcore. Chicken is untouched, out of scope.
The fight-quality half of the Willow death is TASK-18 (fire that FIRST). This task is only: never let the mapper
go silently blind again (visibility), and never sit on a death screen for 84min (the same release the user does
by hand — their releaseOnDeath=true behavior, NOT a DC).

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-16\`. File: `..\mapper.js` ONLY.

## The incident (planner forensics, C:\tmp\log.txt)
Connal fight entered 12:55:35. At **12:56:05** `poe2.getLocalPlayer()` went persistently invalid (null or
`gridX === undefined`, every frame, 88min; recovered only in hideout; other reads kept working). processMapper's
validity bail (~12152 `if (!player || player.gridX === undefined) return;`) sits ABOVE the death fail-safe
(12164), the OVERTIME clock (12242) and the 60s heartbeat (12264) → mapper + folded-in AutoDodge went totally
silent MID-BOSS-FIGHT (no dodges from 12:56:05!), char died 12:59:51, death screen sat undetected 84min until
the user manually released (hideout-entry-stale reset). OVERTIME never logged in a 100min map.

## What ships (const `SILENT_FRAME_GUARD_ON = true`; flag-off = byte-parity)
1. **Unreachable-proof heartbeat**: move the 60s silent-stall heartbeat to run BEFORE every bail in
   processMapper (right after the master-toggle check). When the bail reason is the invalid player read, say so:
   `heartbeat: state=X ... playerRead=INVALID 340s`. A watchdog no early-return can silence — that is its job.
2. **Invalid-read streak instrumentation**: count consecutive invalid-read ms while state !== IDLE (reset on any
   valid read). At 10s log once, then once/30s: null-vs-gridX-undefined split + a throttled `poe2.getAreaInfo()`
   probe result. This names the C++ root cause (stale/recycled player slab is the working theory) on the next
   occurrence — the data feeds the real fix (C++, backlog).
3. **Stuck-dead cleanup at 120s**: if the streak reaches 120s while in a map state (char long dead or the read
   unrecoverable): log loudly + `sendBackToHideoutAndReset('SilentFrame')` — the EXISTING resurrect/release
   sequence (006C+0177), i.e. exactly what the user does by hand on the death screen; server no-ops it on a
   living char. 120s re-arm. This is post-death cleanup so the loop continues; it is NOT a survival mechanism
   and NOT a disconnect.
4. Death fail-safe (tryHandleDeathReturn) and the validity bail itself: UNTOUCHED.

## Hard limits
- mapper.js only. NO chicken.js changes, NO disconnect/exit-to-char-select anywhere, no defaults flipped.
- No new per-frame scans (streak counter is arithmetic; the areaInfo probe only runs while the streak is live,
  throttled 1s). Heartbeat keeps its 60s cadence + format (one added field).

## Acceptance
- `node --check mapper.js`; flag-off parity.
- Report per HOUSE_RULES + live-test checklist: heartbeat appears within 60s of any induced mapper silence
  (toggle a state that logs nothing) with correct playerRead field; on the next stale-read occurrence the streak
  lines name null-vs-undefined + area state; a real death with healthy reads still resurrects via the existing
  fail-safe exactly as today.

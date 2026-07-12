# TASK-30 — Stale-channel movement wedge + stationary watchdog + fog-anchor yoyo latch (Greenhouse triage 2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\rotation_builder.js` AND `..\entity_actions.js` AND `..\mapper.js` into
`handoff\pre\TASK-30\`.
Evidence: C:\tmp\log.txt (Greenhouse 10:58-11:07) — planner-verified timestamps below.

## A. THE BUG OF THE RUN: Snipe channel armed as its target dies -> char wedged channelling 28s and 48s
Live: `Channel armed: ChannelledSnipe` 11:04:19.968 (boss died 11:04:20.346) -> `Channel STALE (28366ms),
nuking without stop` 11:04:48. Again 11:04:54 -> `Channel STALE (48201ms)` 11:05:42. Mechanism (verified in
rotation_builder.js:906-940): ALL release paths (perfect-window / timeout / stale) live inside
`executeRotation`, which entity_actions only calls WITH a combat target. Target dies the tick the channel
arms -> rotation never ticks -> no release, and critically NO STOP ACTION is ever sent -> the char stands
channelling Snipe IN-GAME and ignores our move packets (user had to hand-click to break it). Collateral
during the outage: GoldCoin 59u "unreachable", Chest "contested", Coverage mass (711,737) "stalled" — all
blacklisted while the char literally could not move.
FIX (rotation_builder.js + entity_actions.js):
1. Export a `channelArbiterTick()` (cheap: returns immediately when `_activeChannel === null`) containing the
   existing release arbiter, and call it UNCONDITIONALLY once per frame from entity_actions' per-frame path
   (even with zero targets / rotation disabled mid-map). `executeRotation` keeps calling the same arbiter.
2. Release must actually STOP the in-game channel: on timeout/stale release, read the REAL channel state (the
   perfect-window stage read `actor+0x228 -> ctrl+0x1A8`, rotation_builder.js:889-898 — stage > 0 means still
   channelling; reuse, no new RE) and if actually channelling -> `sendStopAction()`. Replace the blind
   "nuking without stop" with this check. The old fear (stale stop packet) only applies when we are NOT
   actually channelling — skip stop in that case exactly as now.
3. Target-death fast release: while `_activeChannel` is armed, if the cast target is dead/gone (id no longer
   in the shared entity list or hp<=0) and elapsed > 300ms -> release immediately (stop per #2). Snipe's
   damage lands at release; holding a channel on a corpse is pure wedge time.

## B. Mapper stationary watchdog (user ruling: "keep sending the move packets when u arent moving")
Defense-in-depth for ANY future wedge of this class. In the mapper's walk tick: while a walk is OWNED (we
believe we are moving), no MB hold by dodge/opener is live, and the char's grid position has not changed for
3s -> log `[Mapper] stationary 3s while walking -> unstick (stop + resend)`, send `sendStopAction()`, then
re-issue the current move packet. Throttle: max once per 5s; counts as no walk progress (existing stall
clocks unchanged). Const `STATIONARY_UNSTICK_ON = true`.

## C. Fog-unreachable boss-anchor ping-pong (the start-of-map forwards/backwards yoyo)
Live 10:58:13-10:59:41: FIVE cycles of `WALKING_TO_BOSS_CHECKPOINT -> [5s] -> "Boss anchor (437,782)
fog-unreachable 5s at ~1400u -> HOLD as bearing + explore" -> FINDING_BOSS -> Boss Explore (1774,745) ->
[~10s] -> WALKING_TO_BOSS_CHECKPOINT` — checkpoint is WEST, the explore target EAST of the player, so every
flip is a ~180deg direction reversal (the user watched it yoyo over the shocked ground). The HOLD verdict
does not latch: FINDING_BOSS happily re-enters the checkpoint walk ~10s later, re-pays the 5s discovery, flips
back.
FIX (mapper.js): when the fog-unreachable verdict fires, LATCH explore-to-reveal: do NOT re-enter
WALKING_TO_BOSS_CHECKPOINT until a terrain path to the anchor actually COMPUTES (probe pathability every ~3s
in the background from the explore leg — the same path call the walk would make, result-only). While latched,
keep ONE explore target until reached/timeout (no re-pick each re-entry). Log the latch set + release:
`[Mapper] boss anchor fog-latched -> explore until pathable` / `boss anchor pathable -> resuming checkpoint`.
Const `FOG_ANCHOR_LATCH_ON = true`. All existing explore machinery unchanged — this only stops the flip-flop.

## Hard limits
- Files: rotation_builder.js, entity_actions.js, mapper.js. A-2 reuses the existing stage read — no new RE,
  no new offsets. No OB/MB ladder changes. B and C behind their consts (flag-off parity); A is a bug fix on
  the release path (say so in the report).
- `channelArbiterTick()` must be O(1) when no channel is armed (it runs every frame).

## Acceptance
- `node --check` all three; parity walks for B/C consts.
- Report per HOUSE_RULES + live checklist: kill a target mid-Snipe-channel -> release within ~2.5s (timeout)
  with a stop action, char immediately walkable, NO `Channel STALE` lines the whole map; map start with a
  far fog-blocked anchor shows ONE latch line then steady explore (no WALKING<->FINDING flip-flop); a forced
  wedge (if reproducible) shows the stationary-unstick line and self-recovery.

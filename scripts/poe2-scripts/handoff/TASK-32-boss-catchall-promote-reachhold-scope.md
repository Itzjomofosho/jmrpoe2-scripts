# TASK-32 — Catchall promote-on-hit (boss cone) + reach-hold scope tighten (Greenhouse triage 2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\auto_dodge_core.js` AND `..\mapper.js` into `handoff\pre\TASK-32\`.
Evidence: C:\tmp\log.txt (Greenhouse 10:58-11:07).

## A. The catchall mute ate the boss's frontal cone (user got hit for 21%)
Live (Rootgrasp fight 11:04:03-11:04:20): cone = unknown anim `anim_1086` -> catchall ROLL x2 -> the 2/10s
budget MUTED it 8s (11:04:05) -> the third cone LANDED (hp 100% -> 79%, 11:04:08.669) -> damage-unmute fired
(too late by design). The tamer (TASK-18) exists to kill false-positive spam; this anim had a 100% hit rate.
FIX (auto_dodge_core.js): PROMOTE-ON-HIT — when the damage-unmute fires for a catchall anim (the existing
`unmuted (hp X% -> Y%)` path), permanently promote that animId (per-map registry) out of the catchall budget:
it never mutes again this map, dodged every time like a known telegraph. Log once:
`[AutoDodge] catchall anim_<id> promoted (it hit us)`. Additionally, anims sourced from a BOSS-rarity entity
get a gentler budget BEFORE any hit: mute 3s (not 8s) — bosses have few anims and the cost of a miss is a
cone to the face. Const `CATCHALL_PROMOTE_ON = true` (covers both).

## B. Reach-hold tanked five lightning booms during the essence approach (user: "stood in essence lightning
## BOOMBOOM ground x5 ... did u see it?")
Live 11:06:41-11:06:52: essence committed at d=301 -> "fighting through (clocks frozen)" approach ->
`reachHoldActive` published for the WHOLE approach -> dodge core's opener-reach hold (auto_dodge_core.js
~1361: "HOLD against ALL risks") tanked repeated lightning ground -> hp to 90%, chicken potion 11:06:55.
The TASK-22 ruling (tank casts/fire so the opener plants its clicks) is for the PLANT — not for a 10s+
walk-in fight.
FIX (mapper.js publisher — scope the flag, do NOT touch the core's hold semantics): publish
`reachHoldActive = true` only while the char is within PLANT range of the openable (<= ~15u) OR an opener
commit-click is in flight (`commitClickSafe`/openCommitAt window); drop it the moment the openable reads
opened/consumed. Outside that window the approach gets NORMAL dodge (ground rolls included) — the walk
machinery already re-approaches after a dodge. Keep the core's 5s cap/1.5s cooldown untouched (it still
backstops the plant window). Also keep the HP<50% floor drop as-is.

## Hard limits
- Files: auto_dodge_core.js + mapper.js (B's publisher only). A's promotion registry resets per map. No
  changes to known-telegraph handling, projectile logic, or the channel-hold. Flag-off parity per const
  (B rides the existing reachHoldActive publisher — flag `REACH_HOLD_PLANT_SCOPE = true` around the
  narrowed condition, old behavior when false).

## Acceptance
- `node --check` both; parity walks.
- Report per HOUSE_RULES + live checklist: a boss whose unknown anim hits us once gets dodged EVERY
  subsequent use (promotion line in log, no repeat hit); an essence approach through ground hazards shows
  ground ROLLs during the walk-in, reach-hold only near the crystal, opener still completes its clicks.

# TASK-27 — Abyss: stale-id clear + node flip-watch chest sites; Stone: combat/dodge freeze (final-log triage 2026-07-11)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-27\`. File: `..\mapper.js` ONLY.
Evidence: C:\tmp\log.txt (Spring_ 21:37-21:45) — planner-verified line numbers below.

## A. Stale abyssId blocks the pre-boss sweep (7 chests stranded)
Live: objective flipped 21:41:22 -> 7 sites queued, bot STANDING among them, state WALKING_TO_BOSS_CHECKPOINT —
and zero `[AbyssSweep] -> chest site` lines before the boss. Cause: the objective-complete prune deletes the abyss
entries and gates every runAbyssRun caller shut, so the runner never runs again to clear `abyssId` (last runner
line: node 1086 clearing at 21:40:45) -> `abyssSweepIdle()` reads `abyssId !== 0` FOREVER -> pre-boss sweep dead
(the 7/7 on the PREVIOUS map worked because its runner exited a clean path that zeroed abyssId).
FIX: at the prune site (where `e.type === 'abyss'` entries are deleted -> `abyssSweepAdd`), after the loop: if
`abyssId !== 0` and the contentQueue no longer holds an active abyss entry with that id, clear the runner state
(`abyssId = 0; abyssDwell = 0; abyssLootDwellAt = 0; obWalkBackReset()`) — UNLESS `abyssMidNode()` grace is live
(the TTL hold finishing a wave); in that case skip and let the grace path end it (verify the grace path's own exit
clears abyssId; if it doesn't, clear it there too — say which in the report).

## B. Node GREEN->GRAY flip-watch (user ruling: "mark the trigger, go back for the chest")
Nodes completed INCIDENTALLY — wave killed while the node was never runner-committed — never queue chest sites
(sites only come from runner completion + the prune). The chest spawns ON the node the moment it flips spent.
FIX: a throttled (~1.5s) watcher over the contentQueue's ACTIVE abyss entries: read `abyssNodeStatus(entry)` (the
existing MinimapIcon+0x10 probe on the entry's entity/coords — reuse, no new scan class); on an active->spent
transition for an entry that is NOT the committed `abyssId` and NOT already runner-completed:
`abyssSweepAdd(entry.gridX, entry.gridY, now)` + mark the entry completed (completionSource 'flip-watch') + log
`[Abyss] node <id> completed incidentally -> chest site queued`. Dedupe via abyssSweepLooted/site keys (existing).
Bound: the watcher only reads entries already in the queue (<= ~8/map), only while in-map pre-MAP_COMPLETE.

## C. Stone reach clock: combat/dodge freeze (the Taua incident)
Live 21:43:20-40: stone committed MID-FIGHT (Taua the Ruthless 2.1M rogue exile + Nameless Burrower; chicken
potioning; MB dodge holds) -> the rock walk never owned frames -> `rock 391 unreachable (no approach 7s at 23u)`,
`rock 390 ... at 22u` -> both skipped standing next to them -> `no unique -> handled` with a live rock left (user
hand-clicked it). The 7s reach clock burned on frames the walk didn't own — the EXACT hole TASK-15 closed for the
utility walk; stone's freeze only covers `gap>1000 || dodgeMoveSuppressUntil` (my TASK-13 review watch-item).
FIX: port the two proven idioms into runStoneCircle's reach accrual (`stoneRockProgAt` / the give-up test):
1. COMBAT FREEZE: hostile within 60u (throttled probe — reuse/share the `_utFrz` pattern or stoneHostileNear with
   the player as centre) -> freeze the reach clock, capped +20s per rock (the anti-pin bound).
2. DODGE EXCLUSION: frames within 1200ms of an MB dodge hold (`MB.hold.owner === 'dodge' && now - MB.hold.at <
   MB.WINDOW`, the established read) do not accrue.
Also extend the same two freezes to the per-rock consume timeout (STONE_ROCK_TIMEOUT_MS) — a fight at the rock
must not burn the dwell either. All other stone bounds unchanged.

## Hard limits
- mapper.js only. No new entity-scan classes (B reuses the node-status probe on known entries; C reuses
  established freeze idioms). Consts: `ABYSS_FLIP_WATCH_ON = true` gates B; A and C ride existing flags/paths
  (A is a bug fix on the prune path — say so in the report; C extends STONECIRCLE_ON's own machinery).
- Flag-off parity for B; A/C behavior-reviewed via the report's before/after walk-through.

## Acceptance
- `node --check mapper.js`.
- Report per HOUSE_RULES + live-test checklist: objective flip with the bot at the nodes -> `[AbyssSweep] -> chest
  site` lines PRE-BOSS within seconds (no stale-id block); an incidentally-killed node logs the flip-watch line +
  gets its chest; a stone circle committed during a fight consumes all rocks (no 22u "unreachable" skips while
  hostiles are on screen).

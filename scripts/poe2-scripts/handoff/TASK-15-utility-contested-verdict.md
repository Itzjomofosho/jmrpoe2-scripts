# TASK-15 — Utility walk: contested ≠ unreachable (essence banned mid-dodge, 2026-07-11 Savanna)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-15\`. File: `..\mapper.js` ONLY.

## Live incident (console 10:44, MapSavanna)
Committed essence walk at d=103. A rare telegraphed from ~46u; AutoDodge rolled 5+ times in 10s (every roll's
offset magnitude 46-47u), each roll displacing the player (d 103->140, never improved). At 10:44:43 the verdict
fired: `Utility openable unreachable (owned no-progress 5s at 140u) -> blacklist + skip` -> 10-MIN ban. The fight
then carried the player to 24u of the essence (opener fired 3 clicks; didn't land mid-roll — TASK-13 item A's
lane), the rare died, and the mapper stood ~107u away logging `IGNORED (utility blacklist)` and left for boss.
The target was CONTESTED, not walled — the verdict can't tell the difference.

## Root causes (verified in tree)
1. `_utCombatFrz` (mapper.js ~8469-8492) probes hostiles at **45u** (`getEntities maxDistance:45`) — SMALLER than
   the dodge-trigger envelope (~50u+ for telegraphs; this rare sat at 46-47u). Freeze never armed (no
   "fighting through" log line in the incident), so the clock ran while dodge owned the movement.
2. `_utOwned` (~8493-8494) excludes only `now < dodgeMoveSuppressUntil` (520ms, armed by the BOSS dodge paths).
   AutoDodge rolls surface as MB dodge holds (`[MB] BLOCK ... holder dodge(p1)`, `[OB] freeze ... by=dodge`) and a
   ~1s re-path/re-accelerate recovery after each roll — all of which counted as owned walking with zero progress.
3. The verdict's ban is one-size: `addIgnoredUtilityTarget(..., 'failed:no-net-progress')` = default **600s**
   (~7352; only 'loot' passes 90s). A contested failure gets the same map-length ban as a genuine wall-hump.

## What ships (kill-switch const `UT_CONTEST_ON = true`; flag-off = byte-parity with today)
**A. Close the dodge hole in the owned test** (all inside the existing openable block, ~8460-8503):
   - Track `_utLastDodgeAt`: stamp it on frames where the MB dodge hold is live (the established idiom:
     `MB.hold.owner === 'dodge' && now - MB.hold.at < MB.WINDOW`) — verify that idiom is visible at this point in
     the file; the stepPathWalker watchdog already uses it. A frame is NOT owned while
     `now - _utLastDodgeAt < 1200` (roll + recovery), in addition to the existing dodgeMoveSuppressUntil test.
   - Widen the `_utCombatFrz` probe 45u -> **60u** (cover the telegraph envelope). The 20s per-target cap stays —
     that is the anti-pin bound; do not touch it. Fix the log text: it's player-centred, so "hostiles nearby ->
     fighting through", not "hostiles at target".
**B. Contested verdict = short defer with escalation, not 600s:**
   - Record the commit distance when a target is claimed (`_utCommitD` at selection).
   - At the verdict (~8496): `contested = (_utFrzUsed > 0) || (dodge-not-owned ms accrued for this key > 1500) ||
     (dist > _utCommitD + 15 /* we were SHOVED AWAY, not walled */)`.
   - contested -> `addIgnoredUtilityTarget(target, 'defer:contested', 25000)`; per-key contested counter (Map,
     reset in resetMapper): 2nd contested verdict on the same key -> 90s, 3rd -> fall through to the default 600s
     (a genuinely unreachable target guarded by a respawn loop stays bounded). NOT contested -> existing default
     ban, byte-identical behavior (the anti-yoyo walled-Trunk discipline is untouched).
   - Distinct log so the audit shows which lane fired: `... -> defer 25s (contested)` vs the existing blacklist line.
**C. No new scans**: reuse the existing `_utFrz` probe (one radius change), MB.hold reads, and the tracker. Do not
   change the 5s threshold, trackOwnedProgress, or any non-openable utility path.

## Check + report only (no edit unless it's a one-liner in mapper's rare-engage candidate filter)
The rotation burned 3.5s on "Rattling Gibbet (unhittable from here)" during the same fight, and OB claimed
rare:1083. If that was the essence's IMPRISONED rare (invulnerable until its Monolith opens —
essence-differentiation rule: skip imprisoned rare until opened), the mapper's rare-engage layer should exclude a
rare standing within ~12u of an un-opened essence Monolith. Report where rare:1083's candidacy came from and
whether the exclusion exists; entity_actions' hp-frozen 5s ban is the current backstop — do NOT edit
entity_actions.js in this task.

## Acceptance
- `node --check mapper.js`; flag-off parity.
- Report per HOUSE_RULES + live-test checklist: commit an essence with a pack en route -> dodge rolls do NOT
  accrue the ban clock ("fighting through" arms at <=60u, or the dodge-recency exclusion covers it); if a verdict
  still fires it logs `defer 25s (contested)` and the bot RE-COMMITS after the fight instead of `IGNORED
  (utility blacklist)` for 10 minutes; a genuine walled target still gets the long ban.

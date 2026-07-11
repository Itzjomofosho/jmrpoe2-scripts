# TASK-22 — Commit-to-click via the movement-state bus + imprisoned-rare exclusion

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\opener.js` into `handoff\pre\TASK-22\`.
Context: TASK-21 shipped the unfair-send HOLD but it only triggers on a FOREIGN MOVEMENT LOCK — the live shrine
whiffs (45.3/38.1u) happened during a plain MAPPER WALK, which opener.js cannot see (locks are opener/pickit
claims only). Same blocker stopped commit-to-click. Planner ruling = the implementer's option (a): a one-way
movement-state bus on POE2Cache (the established pattern: channelHold, lastEssenceOpen, reachHold's cfg twin).

## A. Movement-state bus (mapper.js publishes; ~3 lines)
Each processMapper frame (cheap, after the state machine has run):
- `POE2Cache.mapperDrivingAt = <ts>` — stamped whenever the mapper actively drives movement this frame (a live
  walk: stepPathWalker advanced / a move send went out / targetName holds a walk). Simplest correct: stamp at the
  move-send choke(s) the walker uses — say which site(s) in the report.
- `POE2Cache.commitClickSafe = <bool>` — true iff NOT (dodge live/recent: `now < dodgeMoveSuppressUntil ||
  MB.hold.owner === 'dodge' && now - MB.hold.at < MB.WINDOW`) AND currentState is not WALKING_TO_BOSS_MELEE /
  FIGHTING_BOSS.
Publishing is unconditional + inert (the only reader gates behaviour) — the TASK-18 rotation precedent.

## B. Opener: complete the hold + COMMIT-TO-CLICK (opener.js)
1. Widen the TASK-21 hold: unfair = `dist > OPEN_FAIR_RANGE && (foreignLock || (now - (POE2Cache.mapperDrivingAt
   || 0) < 600))` — a send during a live mapper walk is held exactly like a locked frame. (This is the real fix
   for "shrine NEXT TO ME didn't go".)
2. COMMIT-TO-CLICK (user: "get closer and commit ~800ms"): when a HELD non-essence target is within 50u AND
   `POE2Cache.commitClickSafe === true`: claim the opener's OWN movement lock for `OPEN_COMMIT_MS = 800`
   (the existing claim/lock machinery — the mapper yields to it exactly as it does for every open today), fire
   the interact, and let its auto-walk carry the character for the window; the landing check / free-retry
   accounting then applies as normal. One commit per target per the existing 2.5s anti-repeat gap. No new stop
   packets opener-side: the lock stops the mapper, the interact walks the char. Dodge steals freely (commitClickSafe
   goes false -> no new commit; a mid-commit dodge simply wins movement, the send just doesn't land = free retry).
3. Essences/RuneRocks/abyss-25u-gate untouched. Update the send-decision table in the report.
Gate: reuse `OPEN_UNFAIR_HOLD_ON` for both (they are one mechanism now).

## C. Imprisoned-rare exclusion (mapper.js) — CONTENT-MATRIX gap #5, the one real co-location hole
A rare standing within ~12u of an UN-OPENED essence Monolith (candidate: `openableType 'Essence'`, entity
`isTargetable === true`, name NOT runerock/stonecircle) is IMPRISONED — invulnerable until the essence opens.
Exclude it from the rare-engage candidate pick (`nearestRareToClear` / the OB rare-claim path — find the single
candidate filter and add the check there; reuse the opener's cached essence candidates or the shared entity list,
NO new scan). The essence side-step (_hvOpen) then opens the crystal, the rare becomes real, and the normal
engage takes it. entity_actions' hp-frozen 5s ban stays as the backstop — do NOT edit entity_actions.js.
Const `IMPRISONED_RARE_SKIP_ON = true`.

## Hard limits
- Files: mapper.js + opener.js only. Bus fields are write-only from mapper, read-only in opener. All existing
  bounds/accounting untouched; flag-off parity per const.

## Acceptance
- `node --check` both; parity walks.
- Report per HOUSE_RULES + live-test checklist: a >30u shrine/chest during a mapper walk gets ZERO sends until
  either in-range or a commit window (log the commit: `[Opener] commit-click <name> at <d>u`); the commit lands
  opens that previously whiffed; a frozen/imprisoned essence rare is never walk-engaged before its crystal opens
  (no hp-frozen 3.5s waste), engaged normally after.

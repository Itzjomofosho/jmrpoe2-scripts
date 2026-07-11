# TASK-12 — Essences skipped ALTOGETHER: investigate like the shrine, then fix (user directive)

FIRST ACT (HOUSE_RULES): copy `..\opener.js` AND `..\mapper.js` AND `..\entity_actions.js` into
`handoff\pre\TASK-12\`. INVESTIGATE-THEN-FIX, TASK-06 style: ground truth from live reads before any edit, and
the report must state which hypothesis was TRUE. If the bridge is available, one live probe of a real unopened
essence monolith beats everything (rule 0 still applies: solo, no fleets).

## Problem (user)
"You're also skipping essences, altogether." Not slow-clicking (TASK-09 already fixed cadence: 400ms retry,
350ms claim, cap 6, dwell ceiling 6000) — the bot doesn't attempt them at all: no walk, no clicks.

## Hypotheses to test IN ORDER (each has a known precedent in this codebase)
1. **Line-of-fire/visibility gate — the SHRINE class.** TASK-10 removed the LoF gate for the Shrine bucket ONLY,
   after proving a shrine's own cell is non-walkable so `hasLineOfFire` reads structurally false at any range.
   Essence monoliths are also physical objects. Check `collectOpenTargets`' Essence bucket (opener.js, search
   `isEssenceEntity` / the Essence push) for `passesVisibilityCheck`/LoF/LoS gating, and live-read an unopened
   monolith: `isTargetable`, `hasLineOfFire`, `poe2.isWalkable` on its cell.
2. **No walk path.** Who WALKS the bot to an essence? Check whether essences appear in any utility candidate
   source (`getOpenableUtilityCandidates`, the opener feed `getOpenableCandidatesForMapper`) or whether the design
   relies on the imprisoned-RARE engagement to bring the bot close (memory says: essence = rare + co-located
   monolith; the rare is skipped until the monolith opens). If the rare-skip gate (search `isEssenceImprisoned`
   in entity_actions.js) suppresses engagement AND nothing walks to the monolith, the essence is unreachable by
   construction — the bot orbits at range forever or never approaches.
3. **The 40u fire gate + reach mismatch.** The opener's essence click gate is <=40u; if the walk stops at
   utility arrival distance (~20u ok) or the rare-fight standoff keeps the player >40u, clicks never start.
4. **Name/exclusion drift.** Confirm the monolith metadata path still matches `isEssenceEntity` this patch
   (the RuneRock/StoneCircle exclusion regex lives nearby — make sure real essences aren't caught by it), and
   that the TASK-09 league-whitelist changes didn't touch the essence flow.

## Fix shape (adapt to findings; likely = the shrine treatment)
- If (1): drop/relax the visibility gate for the Essence bucket exactly as TASK-10 did for shrines, with the
  same justification comment. The <=40u click gate and the 6-attempt ban remain the bounds.
- If (2): give essences a walk: either include unopened monoliths as utility openable candidates (league
  whitelist already contains 'essence' — verify type routing), or lift the imprisoned-rare engagement skip so
  the fight brings the player into click range, whichever matches the existing design intent
  (memory: "essence differentiation — skip imprisoned rare until opened" was about kill-order, not approach).
- If (3): align the essence arrival distance with the 40u click gate.
- Log one throttled line when an essence is seen but filtered (`[Opener] essence skip (<name>): <reason>`),
  mirroring the shrine skip-log — the next live map must name any residual skip itself.

## Hard limits
- Do not touch the cadence work from TASK-09 (retry/claim/cap/dwell numbers).
- No new settings. Keep diffs minimal per hypothesis actually confirmed.

## Acceptance
- `node --check` on all edited files.
- Report per HOUSE_RULES: which hypothesis was TRUE (with the live-read table like TASK-06's), what changed,
  and a live-test checklist (walk near an essence -> approach -> `[Opener] Opened Essence` xN at 400ms cadence,
  imprisoned rare killed after opening).

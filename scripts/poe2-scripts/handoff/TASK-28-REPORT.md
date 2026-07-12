# TASK-28 REPORT — Debug-code cleanup + bank the invuln-flag finding

Implementer session, solo (HOUSE_RULES rule 0). Pre-snapshot: `handoff/pre/TASK-28/` (entity_actions.js,
auto_dodge_core.js, mapper.js — md5-verified identical to runtime at copy time). `node --check` passes on all
three edited/inspected files.

---

## Files touched

| File | What changed |
|------|--------------|
| `entity_actions.js` | A: removed `[BossDiag]` dump. B: added invuln-gate (`INVULN_GATE_ON`). C: removed all `[AA-Diag]` lines. |
| `mapper.js` | C: `[ArbShadow]` 2s→10s-or-on-change; `startWalkingTo` dupe gap 1400→2500ms; removed redundant per-frame boss "Walking to" log. |
| `auto_dodge_core.js` | **No edits.** No always-on leftover diag lines exist (see item C findings). File byte-identical to pre-snapshot. |

## Symbols added / modified (searchable)

**entity_actions.js**
- Added const `INVULN_GATE_ON = true` and `INVULN_IMMUNITY_BUFF = 'no_players_in_range_immunity'` (after `RARITY`).
- Added function `hasInvulnImmunity(entity)` (exact-name buff match; after `hasBuffContaining`).
- Added state `_invulnHoldLast` (replaced the deleted `_aaDiagLast`/`_aaLastFireAt`/`_bossDiagLast`).
- New log tag: `[Rotation] hold: <name> invulnerable (out-of-range immunity)` (throttled 5s).
- Invuln gate block sits in `processAutoAttack()` between final target selection and target-commit.

**mapper.js**
- Added state `arbShadowSig` (declared line ~4587, reset in `arbReset()` ~4604, used in `arbTick()` ~4905).
- `arbTick()` `[ArbShadow]` log rewritten: fires when `sig = pick|committed|phase` changes OR ≥10s elapsed.
- `startWalkingTo()` `minLogGap` normal case 1400→2500ms.
- Deleted `sourceLabel` const + its `log()` in the boss-checkpoint approach branch (~14412).

## Settings added

| Name | Default | Flips it | Effect |
|------|---------|----------|--------|
| `INVULN_GATE_ON` | `true` (const, entity_actions.js) | edit the const to `false` | OFF = byte-identical to today's control flow (blind-fire + hp-frozen backstop). The whole gate is behind `if (INVULN_GATE_ON && ...)`. |

Items A and C are **deletions/throttle-tightening**, not flagged behaviors (per brief). No new game writes, packets,
or C++ bindings. No movement sent by this task.

---

## A. `[BossDiag]` retired (entity_actions.js) — DONE

Removed the entire per-2s rare+ damageability dump: the comment block, the `_bossDiagLast` state var, and the
`console.log('[BossDiag] ...')` block (~13 lines). Nothing kept. The finding it existed to produce
(`no_players_in_range_immunity`) is now banked in B.

## B. Invuln-gate the rotation (entity_actions.js) — DONE

When the CURRENT target carries `no_players_in_range_immunity` (exact-name match against the same shared per-frame
`entity.buffs` list the diag read):
1. **Prefer re-targeting**: scan the sorted candidate list for the first *other* candidate that is non-immune AND
   passes line-of-fire; if found, switch the rotation to it (`target = _alt`).
2. **Hold if immune-only**: if no eligible alternative exists, log the throttled hold line (once per 5s), send the
   stop-cast (mirrors the LoF-fail stop path exactly: `sendStopAction` + one-shot `stopResendAt`), and `return`
   before the target-commit — so no cast fires and the hp-frozen timer never even starts accruing on the immune boss.

The existing **hp-frozen 3.5s ban is untouched** — it stays as the generic backstop for other invuln flavors (bosses
that freeze HP without carrying this specific buff). Flag off (`INVULN_GATE_ON=false`) = today's blind-fire into the
immunity window, ended only by that hp-frozen ban.

## C. Diagnostic-chatter sweep — removed/downgraded line classes

**entity_actions.js — DELETED (no debug toggle exists in this file, so per brief → delete):**
- `[AA-Diag] prev rare+ target ... gone from scan` / `... FILTERED: ...` (prev-target-gone block).
- `[AA-Diag] N candidate(s), NONE passes line-of-fire ...` (all-LoF-failed block — kept the surrounding stop logic).
- `[AA-Diag] holding on ... Xs no-cast: reason=...` (skill-layer-declining block + its `_aaLastFireAt` write).
- Diag state vars `_aaDiagLast`, `_aaLastFireAt` removed (fed only the deleted prints; no operational state lost).

**mapper.js — THROTTLED / DE-DUPED (no removal of state, only prints):**
- `[ArbShadow] pick=...`: was every 2s → now on-change (pick|committed|phase) OR ≥10s heartbeat. `arbYoyoCount` is
  still printed (current value) but excluded from the change-signature, so genuine yoyo still surfaces without the
  per-2s dupe spam. Perf gate (`arbTickAt<1000` in shadow) untouched.
- `Walking to <name> at (x,y)` (generic `startWalkingTo`): identical-target re-log gap 1400→2500ms (was allowing a
  repeat within 2s; the noisy-fight-move 4500ms case unchanged).
- `Walking to <boss anchor> at (x,y)` (boss-checkpoint approach): was an **unthrottled per-frame** print firing right
  before `startWalkingTo(...)` — which already logs the same target+coords (throttled, with pathType). Deleted as an
  exact redundant dupe; no information lost.

**auto_dodge_core.js — NOTHING QUALIFIED (honest finding):**
All 7 log sites are either (a) the opt-in `CFG.debug` diag — `[Dodge] mode=...` (line ~1281) plus its `_dbgActions`
feed, both fully gated by `CFG.debug` (keep, it's opt-in); (b) operational state-transition logs, throttled 2s or
edge-triggered — `[AutoDodge] catchall held/unmuted/skipped/muted` (the TASK-18 catchall-tame system) and
`[AutoDodge] <ROLL/BLINK decision>` (once per real dodge action); or (c) the staged-feature `[ArenaShell] ... (shadow)`
log (shadow-mode-gated + throttled 2s; a rule-2 shadow log, not leftover scaffolding — and only mapper's `[ArbShadow]`
was named for throttling). None is an "always-on leftover diag line," so the file is unchanged.

**NOT touched (per brief):** `[SilentFrame]`, `MAP SUMMARY`/audit, `[Trail]`, `[FwdExplore]`, `[OB]`, `[Ckpt]`,
`[AbyssSweep]`, `[Coverage]`, `[StoneCircle]`, `[Resume]`, heartbeat, and all operational content-handler tags.
Presence re-confirmed by grep after edits (counts: SilentFrame 4, MAP SUMMARY 5, Trail 6, FwdExplore 2, OB 1, Ckpt 2,
AbyssSweep 8, Coverage 7, StoneCircle 7, Resume 4, ArbShadow 1).

---

## LIVE-TEST CHECKLIST

**Quieter console (all maps):**
- No `[BossDiag]` lines anywhere. No `[AA-Diag]` lines anywhere. (Both are gone; seeing either = stale file / wrong
  runtime dir.)
- On a busy/juiced map: `[ArbShadow]` should appear only when the pick/commit/phase *changes* or ~every 10s — NOT a
  steady 1-every-2s stream. `Walking to X` for the same target should not repeat more than ~once per 2.5s.
- Boss approach: you should still see one throttled `Walking to Boss Checkpoint ... [pathType=boss]` (from
  `startWalkingTo`), NOT a per-frame `Walking to Checkpoint_Endgame_Boss ...` flood.

**Invuln gate (needs a boss with an out-of-range immunity phase — Manassa is the confirmed case):**
- WORKING: when the boss phases into `no_players_in_range_immunity`, if any other mob is nearby the rotation switches
  to it (no wasted casts at the immune boss); if the boss is the only target, you see
  `[Rotation] hold: <boss> invulnerable (out-of-range immunity)` at most once per 5s and the character stops casting
  until the window ends, then resumes automatically. No 3.5s dead-air `hp frozen` ban needed for THIS flavor.
- STILL-OK fallback: for a boss that freezes HP *without* this buff, the existing
  `[Rotation] hp frozen 3.5s on <name> ... -> ban Ns` line should still fire (the backstop is untouched).
- BROKEN looks like: character keeps firing at an immune boss for the full 3.5s with no `[Rotation] hold:` line (gate
  not matching the buff), or it never resumes after the window ends (would indicate the ban path, not the hold path,
  is engaging — but the hold `return`s before the ban, so this shouldn't happen).

## Risks / deviations

- **`[ArbShadow]` `gk`/`sig` now computed each `arbTick` call** (was only inside the 2s branch). This is a trivial
  string concat on `goal` already in hand; shadow mode is still throttled to 1/s by the `arbTickAt` gate, and driving
  mode already computes `goal` per frame. Negligible.
- **Invuln gate may swap a boss target for trash during its immunity window.** This is the brief's explicit intent
  ("prefers re-targeting something else if another eligible target exists"). Next frame, if the boss is still the
  boss-priority pick and still immune, it re-swaps — consistent, no thrash beyond intended. When the window ends the
  boss stops carrying the buff and boss-priority reclaims it.
- **Deviation from brief item C (auto_dodge):** brief said "delete any always-on leftover diag lines"; I found none
  that qualify and left the file untouched rather than deleting operational/shadow logs. Rationale documented above.
  If the planner intended a specific line (e.g. the `[ArenaShell]` shadow log or the per-dodge `[AutoDodge]` decision
  line) to also go, name it and I'll remove it — I judged both to be load-bearing, not leftover.

## Open questions

- None blocking. One judgment call flagged above: whether `[ArenaShell] ... (shadow)` and the per-dodge
  `[AutoDodge] <decision>` line should also be throttled/removed. I kept both (operational / staged-shadow). Confirm
  if you want them quieted too.

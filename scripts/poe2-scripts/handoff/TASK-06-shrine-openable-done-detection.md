# TASK-06 — Openable done-detection audit: used shrines/chests must never re-offer

Read `HOUSE_RULES.md` first. Files: `..\mapper.js` (utility candidate selection) and `..\opener.js` (open targeting).
This is an INVESTIGATE-THEN-FIX task — the diagnosis is a suspicion, not a confirmed mechanism. Report what you
actually find before/alongside the fix.

## Problem (user's words)
"Getting stuck after using a shrine, i wonder if its because OF 'is opened' is wrong or something." Observed on
Cliffside: opener used a Gloom Shrine; afterwards the bot churned in place nearby. Earlier the same map:
`Utility select: openable (Gloom Shrine) d=214` -> `failed:no-net-progress` ban (that one was elevation-unreachable
— fine). The suspicion: a USED shrine (or opened chest) still reads as an open candidate, so the utility selector
and/or opener keep re-offering it, or its ban key doesn't match on re-encounter.

## Investigate (report findings even where no fix is needed)
1. How does the utility openable candidate scan (search `getOpenableUtilityCandidates`) decide a shrine/chest is
   already USED? Which entity flags does it read (`isOpened`, `isTargetable`, others)? Do SHRINES flip any of them
   after granting their buff, or do they stay "open-looking" forever? If the game flags are unreliable for shrines,
   that is the root finding.
2. The opener side (opener.js): after a successful shrine interact, what stops it re-targeting the same shrine?
   (Search the open-attempt bookkeeping / `markOpenAttempt` / blacklist.) Does it publish "serviced" back so the
   mapper's utility layer marks the target `handled:*` rather than letting the session time out?
3. The ban KEY stability: utility blacklist entries key how (name? pos+name?)? A shrine banned once must stay
   banned when re-encountered from a different angle (compare with the opener's pos+name key convention).
4. If you have the jmrd2r-bridge MCP available, a read-only `eval_js` probing a used shrine's entity flags
   (`isTargetable`, `isOpened`, buff state) is the fastest ground truth — read-only probes are allowed; no writes.

## Fix shape (adapt to findings)
- Whatever reliable "used" signal exists (flag flip, isTargetable false, an interaction-count, or our own
  used-registry), exclude used shrines/chests from BOTH the utility candidate scan and the opener's target list.
- If no game-side signal exists for shrines: maintain a per-map used-openables registry (pos-keyed, cleared in
  `resetMapper`) stamped at the opener's successful interact, and filter candidates against it.
- Log once per exclusion class (throttled): `[Utility] shrine already used -> excluded` so live logs can confirm.

## Acceptance
- `node --check` on both files.
- A used shrine is never re-selected by utility nor re-clicked by opener within the same map (state the mechanism
  you used and why it's reliable in the report).
- No change to unused shrines/chests behavior; flag-off parity is N/A here (this is a correctness fix, no new flag)
  but keep the diff minimal.
- Report per HOUSE_RULES: findings from steps 1-4 (explicitly say which hypothesis was TRUE), symbols touched,
  live-test checklist.

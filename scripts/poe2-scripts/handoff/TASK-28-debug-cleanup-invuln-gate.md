# TASK-28 — Debug-code cleanup + bank the invuln-flag finding (user: "we committed a bunch of debug code")

FIRST ACT (HOUSE_RULES): copy `..\entity_actions.js` AND `..\auto_dodge_core.js` AND `..\mapper.js` into
`handoff\pre\TASK-28\`.

## A. Retire [BossDiag] (entity_actions.js) — mission accomplished
The TEMP per-2s rare+ dump was planted to find the boss-invulnerability signal. FOUND (live, Manassa + others):
the buff `no_players_in_range_immunity`. Remove the [BossDiag] dump block entirely (the toggle, the log, the
noDmg probes). Keep nothing.

## B. BANK the finding (entity_actions.js): invuln-gate the rotation
While the CURRENT target carries `no_players_in_range_immunity` (exact buff-name match, the shared per-frame
buffs list — same read the diag used), the rotation HOLDS casts on it (throttled `[Rotation] hold: <name>
invulnerable (out-of-range immunity)` once per 5s) and prefers re-targeting something else if another eligible
target exists. This replaces blind-firing + the hp-frozen 3.5s waste. Do NOT touch the existing hp-frozen ban
(it stays as the generic backstop for other invuln flavors).

## C. Diagnostic-chatter sweep (all three files) — reduce, don't blind
- [AA-Diag] lines (prev-target-gone, holding-on) -> behind the existing debug toggle if one exists, else delete.
- auto_dodge_core: the opt-in dodgeDebug diag stays (it IS opt-in); delete any always-on leftover diag lines
  that don't gate on a toggle.
- mapper.js: downgrade per-frame-ish narration that has served its purpose to throttled/edge-only where a task
  checklist no longer needs it — SPECIFICALLY: keep [OB]/[Ckpt]/[AbyssSweep]/[Coverage]/[StoneCircle]/[Resume]/
  heartbeat/audit lines (operational narrative, load-bearing for planner triage); kill or throttle exact-dupe
  spam (e.g. repeated identical 'Walking to X' within 2s, the [ArbShadow] per-2s line -> every 10s or on-change).
- DO NOT remove: [SilentFrame], MAP SUMMARY/audit, [Trail] (K-tuning pending), [FwdExplore] (K-tuning pending).
List every removed/downgraded line class in the report.

## Hard limits
- Three files only. No behavior changes outside B's cast-hold. `node --check` all three. Log-line removals must
  not remove STATE, only prints. Flag: B behind `INVULN_GATE_ON = true`; A/C are deletions (say so in report).

## Acceptance
- Report per HOUSE_RULES + live checklist: no [BossDiag]/[AA-Diag] spam; a boss phasing into
  no_players_in_range_immunity shows the hold line + no wasted casts; console visibly quieter on a busy map;
  all load-bearing tags still present.

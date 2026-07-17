# TASK-73 — Boss-engage calm gate + kite-floor integrity (radial rolls, retreat resumption)

Read `handoff/HOUSE_RULES.md` FIRST. Pre-snapshot (FIRST ACT): copy `mapper.js` and `auto_dodge_core.js`
into `handoff/pre/TASK-73/` before ANY edit. TASK-72 is already in these files — do not disturb it.

## Incident (Backwash boss death 2026-07-17 10:25:40, log quoted — tmp log rotates)

The bot released a blacklisted unique at 10:25:19, and 5s later engaged the full-HP map boss:

```
[10:25:24.363] Engage detector: targetable on "Yaota, the Loathsome" id=507 hp=5263394/5263394 dist=46
[10:25:24.363] Boss already engaged during checkpoint walk (targetable) -> closing in via melee
[10:25:35.469] Boss engaged during melee walk (targetable) dist=37 -> entering fight    <- kite mode ON (else gate=32)
```
25s after a blind egress (10:25:10, -15%/2.5s). Then, during the boss OPENER, the character was pinned
INSIDE the kite floor and never retreated:

```
[10:25:36.106] [AutoDodge] ROLL angle=90  why=boss_telegraph:BossOpener d=-15,44
[10:25:36.494] [MB] BLOCK: fight(p2) vs holder dodge(p1)          <- kite retreat starved by the dodge hold
[10:25:36.873] [BossFight] diag ... 36u
[10:25:37.248] [AutoDodge] ROLL angle=-90 why=boss_telegraph:BossOpener d=15,-44
[10:25:38.843] [AutoDodge] ROLL angle=-45 why=proximity-net d=33,-33
[10:25:38.896] [BossFight] diag ... 30u  /  [MB] BLOCK: fight(p2) vs holder dodge(p1)
[10:25:39.296] [BossFight] diag ... 23u                            <- rolls netted INWARD; wind_Knockback at 5u
[10:25:40.087] [Survival] HP-yield 12% ... [AutoDodge] PANIC egress: hp -70% in 2s
```
NO `Kiting Boss... BACK OFF` line ever fired. Three defects, one fix each:

1. **No recovery gate on boss ENGAGE** — a full-HP boss fight was volunteered 25s after an egress
   (TASK-72's calm gate deliberately excluded boss; this task adds it).
2. **Roll bearings ignore the kite floor** — telegraph/proximity rolls chose vectors whose sum moved a bow
   build 37u -> 23u INTO the boss during its opener.
3. **The kite-floor retreat starves behind the dodge hold** — `[MB] BLOCK: fight(p2) vs holder dodge(p1)`
   between every roll; the radial retreat (`KITE_FLOOR` block, `pickRadialRetreatWaypoint`) never got a frame.

## Scope

Runtime JS only: `mapper.js`, `auto_dodge_core.js`. All parts flag-gated, defaults ON, flag off =
byte-identical control flow. Do NOT touch pickObjective/`engagedContentAnchor`, the MB priority ladder
itself, or TASK-72 code paths (reuse them where told).

---

## Part A — Boss-engage calm gate (flag `BOSS_ENGAGE_CALM_ON`, mapper.js)

Reuse TASK-72's `calmGateHold(type, player, now)` with type `'boss-engage'` (starvation cap, logging,
stolen-span freeze all come free; add `'boss-engage'` wherever runnerSpanStolen's type matching needs it —
grep how `_cgHoldType` is consumed).

Gate ONLY the volitional entry into a fresh fight — both transitions:
1. **Checkpoint-walk engage detector** (search `Boss already engaged during checkpoint walk`): before
   switching to melee approach.
2. **WALKING_TO_BOSS_MELEE -> FIGHTING_BOSS** (search `Boss engaged during melee walk`): before
   `setState(STATE.FIGHTING_BOSS)`.

Gate condition (ALL must hold, else never gate):
- flag on AND NOT `activationCalm(player, now)` (TASK-72 predicate), AND
- the boss is effectively UNTOUCHED: `(e.healthCurrent || 0) >= (e.healthMax || 1) * 0.995`, AND
- `distToEngaged > 34` (already close = the fight found US; gating there just stands in it).

While gated: hold OUTSIDE the standoff — if `distToEngaged < kiteStandoff() + 15`, walk AWAY from the boss
to that ring (reuse `pickRadialRetreatWaypoint` + `MI.walk(MOV.bossWalk, ...)`; label `Boss Calm Hold`),
else `MI.hold(MOV.bossWalk)`. Status `Boss: calm gate (recovering)`. Stay in the CURRENT state (do not
transition); the engage re-evaluates naturally each pass and proceeds once calm. A boss that damages us
or drops below 99.5% hp while we wait stops matching the untouched condition -> gate opens -> fight starts.

## Part B — Radial-out roll bearings inside the kite floor (flag `BOSS_ROLL_RADIAL_ON`, both files)

When a tracked boss is closer than the kite floor, a roll must not end NET-CLOSER to the boss.

- **auto_dodge_core.js**: in the bearing chooser used by boss-mode rolls (telegraph + proximity-net):
  when `CFG.mode === 'boss'` AND a boss entity is known AND its distance < the kite floor the mapper uses
  (export/read it — see below), score candidate bearings with a radial-out preference and REJECT any
  bearing whose destination is closer to the boss than the current position, unless every unbanned,
  unblocked bearing is inward (walls/sector bans may force it — never roll into a wall to satisfy this).
- **mapper.js**: the mapper needs to publish the floor + boss position for the chooser: extend the existing
  one-way publication idiom (grep `channelThreatD` / `POE2Cache.channelThreat` — auto_dodge must NOT import
  mapper) with `POE2Cache.bossKite = { x, y, floor, at }`, written in the FIGHTING_BOSS/kite block where
  `KITE_FLOOR` is computed (search `KITE-FLOOR (anti-death)` and the `const KITE_FLOOR =` site). Stale
  entries (>1500ms) are ignored by the chooser.
- Same rule for the mapper's own boss rolls (`tryBossEmergencyRollOut`, `tryBossFirstContactDiagonalRoll`,
  `tryBossDodgeRollBehind` — the last one legitimately crosses BEHIND the boss: exempt it, it's an i-frame
  play, but it must only be picked when `engagedClear >= 3` as today).

## Part C — Kite-floor retreat must get frames between rolls (flag `BOSS_KITE_RESUME_ON`, both files)

Constraint to satisfy (mechanism is yours, stay inside the MB/MI discipline): while `FIGHTING_BOSS` with
boss distance < KITE_FLOOR and no roll IN FLIGHT, the radial retreat (`Kiting Boss... BACK OFF` path) must
be able to move the character — the post-roll dodge HOLD must not consume the whole inter-roll window.
Preferred seam: auto_dodge's boss mode, on frames where it has no roll to make and no hazard walk-out,
should RELEASE its movement hold early (or convert its walk-out direction to the radial-out bearing from
Part B's `POE2Cache.bossKite`) instead of holding the broker doing nothing. A dodge system that owns
movement and stands still inside the floor is the defect. Do not lower dodge's MB priority; do not let the
fight steal an in-flight roll.

## Verification (solo, per HOUSE_RULES)

1. `node --check` both files; grep new symbols.
2. Flag-off parity vs `handoff/pre/TASK-73/`.
3. REPORT `handoff/TASK-73-REPORT.md` with LIVE-TEST CHECKLIST, at minimum:
   - `Boss: calm gate (recovering)` when a boss engage follows an egress within 25s; fight starts after.
   - During a boss opener, BossFight diag distances stop trending downward below the floor; `Kiting
     Boss... BACK OFF` lines appear between rolls.
   - Rolls during boss fights log bearings that move away from the boss when inside the floor.
   - No regression: dormant-boss chasm routing (`Boss dormant across a gap`) and stance-wait
     (`Waiting (safe)`) branches unchanged.

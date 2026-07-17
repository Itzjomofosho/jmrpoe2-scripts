# TASK-73 REPORT — Boss-engage calm gate + kite-floor integrity

Pre-snapshot: `handoff/pre/TASK-73/` (mapper.js, auto_dodge_core.js) taken BEFORE any edit.
`node --check` passes on both edited files. All new symbols grepped (no typos/half-renames).
TASK-72 code untouched (calmGateHold / activationCalm / runnerSpanStolen only CALLED, never edited).

## Files touched

- `mapper.js`
- `auto_dodge_core.js`

## Settings added (all module consts, defaults ON, off = byte-identical control flow)

| Flag | File(s) | Gates |
|---|---|---|
| `BOSS_ENGAGE_CALM_ON` | mapper.js | Part A: volitional boss-engage calm gate |
| `BOSS_ROLL_RADIAL_ON` | both | Part B: net-closer roll reject + `POE2Cache.bossKite` chooser logic |
| `BOSS_KITE_RESUME_ON` | both | Part C: entry-mobile defer, broker-hold release, egress radial conversion |

Note: the mapper publishes `POE2Cache.bossKite` when `BOSS_ROLL_RADIAL_ON || BOSS_KITE_RESUME_ON`
(C's dodge-side egress conversion needs the publication even if B is turned off).

## Symbols added / modified

mapper.js
- `BOSS_ENGAGE_CALM_ON`, `BOSS_ROLL_RADIAL_ON`, `BOSS_KITE_RESUME_ON`, `_becWalkAt`, `_kiteResumeLogAt` (new consts/state, after the TASK-72 block)
- `bossKiteFloorU()` (new) — the kite floor as ONE number, identical to the old inline FIGHTING_BOSS computation
- `bossEngageCalmHold(player, e, dist, now)` (new) — Part A gate; reuses `calmGateHold('boss-engage', ...)`, `kiteStandoff()`, `pickRadialRetreatWaypoint`, `MI.walk/step/hold(MOV.bossWalk)`
- `WALKING_TO_BOSS_CHECKPOINT` engage detector (search `Boss already engaged during checkpoint walk`) — gate call + `break` before the melee switch
- `WALKING_TO_BOSS_MELEE` (search `Boss engaged during melee walk`) — gate as `else if` before `setState(STATE.FIGHTING_BOSS)`, and a second gate on the "Boss engaged early, closing in" approach arm (see Deviations)
- `FIGHTING_BOSS` kite block — `KITE_FLOOR` hoisted to the top of the `trackedBossEntity && !postDodgeLock` block (same value, computed via `bossKiteFloorU()`); `POE2Cache.bossKite = {x, y, floor, at}` published there; entry-mobile branch (`BOSS_ENTRY_MOBILE_ON`) now defers to the kite retreat when `_bd < KITE_FLOOR`
- `tryBossEmergencyRollOut`, `tryBossFirstContactDiagonalRoll` — `_radialGate`/`bestOut` net-closer reject with wall fallback; `tryBossDodgeRollBehind` untouched (exempt i-frame play; its callers keep the `engagedClear >= 3` gate and its own `quickClearanceScore <= 3` reject, unchanged)
- Dodge integration block (search `[KiteResume]`) — idle post-roll broker-window release (`MB.hold.at = 0`) when in FIGHTING_BOSS boss-mode, no roll fired, no walk-out armed, and `now >= dodgeMoveSuppressUntil`
- `resetMapperState` area (next to the TASK-72 calm-gate reset) — `_becWalkAt = 0` + `POE2Cache.bossKite = null` per map

auto_dodge_core.js
- `BOSS_ROLL_RADIAL_ON`, `BOSS_KITE_RESUME_ON`, `BOSS_KITE_STALE_MS` (1500), `BOSS_RADIAL_BIAS_W` (26), `_bkrLast` (new consts/state)
- `_rollSectorBanned(ang, now)` (new) — TASK-54 D ban predicate extracted VERBATIM from `rollWallPenalty` (which now calls it; behavior identical) so the winner sweep can share it
- `_bossKiteRadial(pgx, pgy, now)` (new) — the kite gate: boss mode + fresh `POE2Cache.bossKite` + player inside floor, else null
- `chooseDodgeDirection` — radial-out score preference + `inward` landing mark on every candidate (8-dir and perpendicular); winner sweep takes the best walkable NOT-inward, NOT-sector-banned candidate first, falling back to today's sweep when every such bearing is inward/banned/blocked (never rolls into a wall to satisfy the rule)
- `runAutoDodge` — walk-out arm/re-arm (search `walkEgress = { dx: _egDx`) converts the escape heading to the radial-out bearing when inside the floor AND that bearing is path-walkable; roll log line gains a ` kite-radial` marker while the gate is active

## How each incident defect is closed

1. **Volunteered fight 25s after egress** — both engage transitions now call `bossEngageCalmHold`: flag on, NOT `activationCalm`, boss ≥99.5% hp, dist > 34u → hold outside `kiteStandoff()+15` (walk away via `pickRadialRetreatWaypoint` if closer, else `MI.hold`), status `Boss: calm gate (recovering)`, no state transition. Starvation cap / `[CalmGate]` logging / stolen-span freeze come from TASK-72's `calmGateHold`. A boss that damages us or drops below 99.5% stops matching → gate opens → fight starts.
2. **Rolls netted inward during the opener** — with the boss inside the kite floor, auto_dodge's chooser and the mapper's own out-rolls refuse landings net-closer to the boss (1u tolerance) unless walls/sector-bans force it; radial-out bearings get a score preference on top.
3. **Retreat starved behind the dodge hold** — three seams: (a) entry-mobile no longer outranks the kite retreat inside the floor (the incident fight died entirely within the 5s entry window, so `BACK OFF` never ran); (b) the dodge's post-roll 700ms broker window is released once the 520ms roll flight is over and the scan produced nothing new; (c) when the dodge DOES own frames via the field walk-out, its heading is converted to radial-out — the dodge's own movement becomes the retreat.

## LIVE-TEST CHECKLIST

Setup: any map boss; ideally trigger an egress (take a beating on trash) within ~25s of reaching the boss.

1. **Part A working**: after an egress/HP-yield, on approach to an untouched boss:
   - `[CalmGate] boss-engage held Ns (hp X%, last egress Ys ago)` lines (5s cadence), heartbeat status `Boss: calm gate (recovering)`, and (if inside 75u) a walk AWAY from the boss (`Boss Calm Hold` target).
   - Once 25s calm + hp ≥ 70%: the normal `Boss engaged during melee walk ... -> entering fight` (or checkpoint variant) fires and the fight proceeds. **Broken**: fight entered while `[CalmGate] boss-engage` lines are still printing, or the bot stands INSIDE melee range while gated.
   - Never more than ~60s of gate (starvation cap logs `[CalmGate] boss-engage starvation cap ... -> proceeding`).
2. **Part C working**: during a boss opener with the boss on top of us:
   - `[BossFight] diag` distances stop trending DOWN below the floor (37→30→23 was the bug); heartbeat status shows `Kiting Boss... BACK OFF N->60u` between rolls.
   - `[KiteResume] dodge idle post-roll -> broker window released` appears (5s throttle); `[MB] BLOCK: fight(p2) vs holder dodge(p1)` should become rare/absent between rolls (only legitimate during the ~520ms roll flight).
3. **Part B working**: `[AutoDodge] ROLL angle=... why=... kite-radial` lines during boss fights inside the floor, with the `d=dx,dy` deltas pointing AWAY from the boss (compare against `[BossFight] diag` bearing). **Broken**: consecutive `kite-radial` rolls whose deltas point at the boss while open ground exists behind us.
4. **No regression**:
   - Dormant boss across a chasm still logs `Boss dormant across a gap -- routing up to it` and routes (path untouched, evaluated BEFORE the calm gate).
   - Stance-wait `Waiting (safe): ...` branch unchanged.
   - Normal calm engages (no recent egress) enter the fight with zero new log lines.
   - Press-in (`Press-in: ...`) still drives toward dormant/immune bosses (calm gate and radial logic don't touch it).

## Deviations from the brief (with why)

1. **Melee-walk: the "closing in" approach arm is also gated**, not just the `setState` line. Gating only the transition left the approach driving back to the 60u engage line every pass, producing a 60↔75u walk yo-yo for the whole gate window (the gate's ring-hold could never sustain). The approach is the same volitional entry; the gate condition (flag+calm+untouched+>34u) is identical, and flag-off is byte-identical.
2. **Entry-mobile defer (Part C mechanism)**: the brief left the mechanism open. In the incident the whole fight (35.5s→40.1s) sat inside `BOSS_ENTRY_MOBILE_MS` (5000), whose branch `break`s BEFORE the kite-floor retreat — so no amount of broker-frame freeing alone could produce a `BACK OFF`. Inside the floor the entry arc (which targets CURRENT range) now yields to the retreat; outside the floor entry-mobile is unchanged.
3. **`MB.hold.at = 0` release is done from mapper.js**, not via a new MB method — movement_broker.js is out of scope for this task. The ladder itself is untouched; this only ends a dodge-owned window early on frames where the dodge produced nothing and no roll is in flight.
4. **`runnerSpanStolen` type matching: nothing added.** Grepped every `_cgHoldType` consumer — the only one is `runnerSpanStolen` (~line 2400), which compares `_cgHoldType` against the CALLING runner's type ('breach', 'abyss', 'verisium', 'incursion-*'). No runner calls it with 'boss-engage', so there is no matching to extend; the boss walks' own clocks self-heal via their existing gap-advance logic (checkpoint improvement clock advances by preempted gaps).
5. **`rollWallPenalty` internals refactored** (sector-ban loop extracted verbatim into `_rollSectorBanned`) so Part B's winner sweep can reuse the exact TASK-54 D ban test instead of duplicating it. Behavior is identical (verified line-by-line).

## Risks

- The Part A gate can retreat-walk during `WALKING_TO_BOSS_CHECKPOINT`; the retreat overwrites the shared path walker's target ('Boss Calm Hold'). If the boss drops out of the 52u detector while gated, the checkpoint walk resumes with a stale short path — the existing re-issue logic (`!targetName.includes('Detour')` re-walk, `arrived && dist>130` guard) self-heals this, and the ≤50u false-arrival path only hands to the melee state, whose own gate re-holds. Watch for rapid `Boss Calm Hold` ↔ `Boss Checkpoint` target flips in the heartbeat if anything looks off.
- `POE2Cache.bossKite` is only fresh while the FIGHTING_BOSS kite block runs; during press-in/unhittable-evade frames it ages out (>1.5s) and the dodge-side radial logic goes inert. This is intended (press-in is a deliberate approach), but means Part B does not shape rolls during those sub-modes, nor during `WALKING_TO_BOSS_MELEE` (per brief: publication lives in the kite block).
- `BOSS_RADIAL_BIAS_W = 26` is a soft preference under the hard inward-reject; if live logs show radial rolls chosen into worse hazards, the reject (not the weight) is the operative mechanism and the weight can be dropped without losing the guarantee.

## Open questions

None blocking. One judgment call worth planner review: the gated "closing in" arm (Deviation 1) — if the planner prefers the literal setState-only gate, deleting the second `else if (bossEngageCalmHold(...))` arm restores it verbatim.

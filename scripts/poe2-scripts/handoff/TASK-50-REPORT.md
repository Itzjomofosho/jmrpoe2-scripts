# TASK-50 REPORT — Nav fact-wedge (amnesty + owned-frames facts + radar bypass) + Exp2 anchor tracking

Pre-snapshots: `handoff\pre\TASK-50\navigator.js` + `handoff\pre\TASK-50\mapper.js` (taken before any edit).
SEQUENCING: TASK-49 (ARB_PATH_ORDER_ON / DISC_POSTCOMPLETE_FIX_ON) was already in the runtime mapper.js —
TASK-50 lands ON TOP of it. `node --check` passes on both files.

## FIRST DELIVERABLE — the exact path that recorded the false fact, and why the guard missed

The 14:06:47.961 fact came from **`navOnLegStuck` → `_recordBlocked(..., 'leg stuck')`** (the only other
`_recordBlocked` caller stamps `route Nu short`, not `leg stuck`). The stuck verdict itself came from
`stepPathWalker`'s detectors, whose no-progress clocks **freeze only on DODGE-held frames**
(`now < dodgeMoveSuppressUntil || MB.hold.owner === 'dodge'`) — every other kind of theft counts as
"no progress". Live chain (C:\tmp\log.txt):

- 14:06:39.382 `[AutoDodge] ROLL ... why=lethal:lightning_beacons` → 14:06:40.017 `[MB] BLOCK: nav(p5) vs holder dodge(p1)`
- 14:06:40.199 / 14:06:43.454 `Walking to Elite at (496,946)` alternating with `Walking to Nav Explore` —
  a second writer trading the walker target with nav (the "mobs stealing movement")
- last rotation cast 14:06:42.029 → at the 14:06:47.961 verdict `lastRotationCastAt` was **5.9s stale**,
  so the ONLY guard in `navOnLegStuck` (`_fighting = lastRotationCastAt < 2000`) read false → fact recorded.

So the guard failed because it only covers **active casting**; dodge suppression (520ms windows), posture
back-steps, and higher-priority MB writers are all invisible to `lastRotationCastAt`, and the walker's own
clocks don't freeze for them either. The last observable steal signal landed ~3.9s before the verdict —
hence the 5s withhold window below (stuck convictions build over 8–9s).

## A. navigator.js

### A1 — fact-earning justice (rides NAV_ON, no new flag)
- `navCurrentWaypoint` now tracks `_moveStolenAt/_moveStolenWhy`: a **call gap >1s** (another system owned
  the frames — runnerSpanStolen's gap signal) or the new bus read `bus.navMoveStolen(now)` (in-frame theft).
- `navOnLegStuck`: a stuck report within `NAV_STEAL_FACT_MS` (5000ms) of the last steal **withholds the
  permanent fact only** — replan + stuckN + the 3x drop run exactly as before (mirrors the combat case).
  New log: `[Nav] leg stuck during stolen movement (<why> <N>ms ago) -> replan only (no fact recorded)`.
- mapper.js side: ONE new bus accessor `navMoveStolen` in `navConfigure` returning the signal name:
  `'dodge'` (`now < dodgeMoveSuppressUntil`), `'mb:<owner>'` (`!MB.avail('nav', 5)`), `'posture'`
  (`now <= _poStepUntil`, the back-out bus), `'ob-paused'` (a content-layer OB record with `pausedBy` set,
  the shadow-truthful read `obContentPausedFor` uses). Old mapper without the accessor → gap signal only.

### A2 — veto-storm amnesty (`NAV_FACT_AMNESTY_ON`)
- `_buildPlan` records every blocked-cell veto's cell key into `_vetoCells` (burst-scoped, cleared at the
  start of each no-objective commit burst).
- In `_evaluate`'s no-objective path: when EVERY candidate fails AND ≥1 veto named a blocked cell, the
  **common-denominator cell(s)** (max veto count this burst) are removed from `model.blockedCells`
  (re-earnable) and the commit burst **re-runs immediately** — log
  `[Nav] fact <cell> caused a full veto -> amnesty (re-earnable)`. Only if the retry also fails does the
  4s backoff happen. So no full veto ever passes without an amnesty attempt (when a cell was named).
- Re-earn bookkeeping in `_recordBlocked`: an amnestied cell that re-earns **2x** becomes amnesty-exempt
  for `NAV_AMNESTY_EXEMPT_MS` (5min) — log `[Nav] fact <cell> re-earned 2x after amnesty -> amnesty-exempt 5min`.
  Exempt cells are skipped when choosing the suspend set (all-exempt → today's backoff).
- `_amnesty`/`_vetoCells`/steal state reset in `_resetModel` (per map). Amnesty state is runtime-only,
  NOT serialized — a suspended cell simply drops out of the sidecar payload (re-earnable after reload).

### A3 — radar route-around (`NAV_FACT_AMNESTY_ON`)
- In `_buildPlan`, before vetoing a route whose `via !== 'radar'` crosses a blocked cell: try
  `poe2.radarFindPath`; a radar route that reaches the target (≤ `NAV_PLAN_SHORT_U`) AND crosses **no**
  blocked cell replaces the veto — log `[Nav] plan for <key> via radar (fact bypass; cell <cell>)`.
  Radar crossing/short/failing keeps today's veto (per brief). Applies to poi/region/rvisit; boss routes
  never vetoed anyway.

## B. mapper.js — Exp2 anchor tracking (`EXP2_ANCHOR_TRACK_ON`)

New state: `exp2HamAt/Id/X/Y/Runes/Area/Took` — the HAMMERED anchor. Stamped at all three fighting-entry
sites (`exp2BlindHammer`, awaitpick manual-takeover, STEP-3 hammer) via `exp2StampHammer`. `exp2HamTook`
flips when the untargetable flip is OBSERVED (the existing `exp2SawUntgt` line) = the activation verifiably
took. Helpers: `exp2ClearAnchor`, `exp2AnchorAlive`, `exp2AnchResumable`.

1. **Id-churn re-bind (engaged)**: `t.id !== exp2CurId` in phase fighting/loot with `t` within
   `EXP2_ANCHOR_R` (45u) of the anchor → adopt the new id in place (phase + all clocks kept), log
   `[Exp2] anchor re-bind id OLD->NEW (post-activation)`. No more nulling into the concede path.
2. **Concede gate**: at miss-cap expiry (engaged, post-hammer, inside `EXP2_TOTAL_TIMEOUT`),
   `exp2AnchorAlive()` scans lightweight entities (Expedition2 + Encounter|Remnant within 45u, controller
   NOT required — it despawns at completion while the loot-ready stone remains) and quest markers
   (Expedition2 path, iconType 1000 done-state excluded). Re-bindable entity → re-bind; family/marker
   evidence only → keep holding at the anchor, re-check every 5s (`exp2MissAt` pushed forward — one scan
   per 5s, not per frame); anchor dead → today's concede + anchor cleared. Bounded by the 3-min total.
3. **Idle re-acquire resume**: top of the walk phase — `exp2AnchResumable` (flag + hammered + TOOK verified +
   TTL 5min + same area-change count + within 45u) → walk to ≤55u, then re-enter **'fighting'** with
   `exp2SawUntgt = true` (skips the hammer-take re-hammer; tgt=true reads as loot-ready → the existing open
   ladder; tgt=false → wave clear), `exp2SelRunes` restored from the anchor (default 5 = WIDE), fight caps
   restart. Never touches 'reached -> clear mobs then open'.
4. **Anchor lifecycle**: cleared at every terminal give-up (hammer never took, total timeout, loot
   unreachable, loot-open never took, looted retire, loot never ready, dead-anchor concede, looted
   left-behind). KEPT on: entity-gone concede while walking back (pre-open 'walk' 6s concede) and the
   **unlooted** left-behind retire — those are exactly the states a later re-acquire should resume from.

Untouched per hard limits: verisium settle gates (`VERISIUM_PANEL_SETTLE_MS`, `exp2Stationary`), reward
ranking, the open ladder itself, everything outside the exp2 runner (except the one bus accessor, below).

## Settings added

| Setting | File | Default | What flips it |
|---|---|---|---|
| `NAV_FACT_AMNESTY_ON` | navigator.js | `true` | `false` = no amnesty, no veto-cell capture, no radar fact-bypass, no re-earn bookkeeping → TASK-44 fact/veto behavior byte-identical |
| `EXP2_ANCHOR_TRACK_ON` | mapper.js | `true` | `false` = stamp/clear/re-bind/resume/concede-gate all inert → today's 30s-concede + restart behavior |
| (guard) steal-withhold | navigator.js | rides `NAV_ON` | nav off = navigator unused (the brief assigns this guard no flag) |

Tunables (consts, not settings): `NAV_STEAL_FACT_MS=5000`, `NAV_AMNESTY_EXEMPT_MS=300000`,
`EXP2_ANCHOR_R=45`, `EXP2_ANCHOR_TTL_MS=300000`.

## LIVE-TEST CHECKLIST

Navigator (Mire-class bridge-weave map, or any map that grows a blocked-cell fact):
- WORKING: on a contested stuck, `[Nav] leg stuck during stolen movement (mb:… / dodge / posture / frame gap …ms ago) -> replan only (no fact recorded)` instead of `[Nav] blocked edge … recorded`.
- WORKING: if a fact still bricks the map: `[Nav] fact <cell> caused a full veto -> amnesty (re-earnable)` followed within ~1 eval by a normal `[Nav] objective … committed` — the char MOVES again. NEVER more than two consecutive `all candidates unroutable -> backing off 4s` lines when a `crosses blocked cell` veto preceded them.
- WORKING (real wall): `[Nav] fact <cell> re-earned 2x after amnesty -> amnesty-exempt 5min` and routing settles around it.
- Occasionally: `[Nav] plan for <key> via radar (fact bypass; cell <cell>)` — a candidate saved from a veto.
- BROKEN: `blocked edge … (leg stuck…)` still appearing while `[MB] BLOCK`/dodge/posture lines are active within ~5s; or an amnesty→re-earn→amnesty loop repeating past ~2 cycles on the same cell without the exempt line; or the char standing still with repeated backoff lines.

Verisium (any map with a remnant; ideally let it de-stream mid-encounter, e.g. a busy wave fight):
- WORKING: activation → waves → `[Verisium] loot-open fired #1/…` → loot picked, UNATTENDED. On a de-stream: `[Exp2] anchor re-bind id OLD->NEW (post-activation)` (or `Verisium: encounter live at anchor (awaiting re-stream)` then the re-bind) — NO `gone 30s -> concede` while the encounter/chest is still standing there, NO second `reached (…u) -> clear mobs then open` on the same stone.
- WORKING (genuinely gone, e.g. user opened it manually and left): concede fires as today after the anchor reads dead.
- BROKEN: a re-bind line followed by `re-HAMMER` spam (means the take-verification interaction regressed — kill EXP2_ANCHOR_TRACK_ON); or `encounter live at anchor` repeating past ~3 min (the total-timeout bound failed); or a `loot-open` fired on a stone that was never activated (UI cog-wheel wedge — kill the flag immediately).

Bisect order if something is off: `NAV_FACT_AMNESTY_ON=false` first (amnesty+bypass off, steal guard stays), then `EXP2_ANCHOR_TRACK_ON=false`.

## Risks / deviations from the brief

1. **mapper.js touched beyond exp2 (1 spot)**: the `navMoveStolen` bus accessor in `navConfigure`. Prong 1
   demands mirroring `runnerSpanStolen`'s signal set, and MB/dodge/posture/OB are mapper-module state — the
   bus is the architecture's only sanctioned channel (navigator never imports mapper). Purely additive; an
   old mapper without it degrades to the gap-signal only.
2. **OB signal is coarser than runnerSpanStolen's**: nav has no OB record of its own, so the accessor reads
   "ANY content-layer record currently paused" instead of a per-type/id read. A stale pause (preemptor died,
   owner hook not yet re-run) can withhold a legitimate fact for a few seconds — the safe direction (replan/
    3x-drop still recover; only permanent learning is deferred).
3. **Steal window 5000ms** (brief said "recently stolen" without a number): chosen from the live chain — the
   last observable steal was 3.9s before the verdict, conviction windows are 8–9s. Wide enough to have caught
   the Mire fact, narrow enough that a clean 8s walk into a real wall still records.
4. **"Common denominator" = cells with the max veto count in the burst** (each veto names exactly one cell —
   the first crossing found). One cell blocking everything (the live case) suspends exactly that cell.
5. **Radar bypass under NAV_RADAR_ROUTE_ON=true is usually a repeat call** (radar already declined this
   target moments earlier, so the bypass mostly re-confirms). It matters when radar's answer was short-of-
   target-but-clean — still rejected (brief: take only a CLEAN route that reaches). Cost: one extra native
   route call per veto, bounded by 4 tries × 4 doors per eval at ≥800ms cadence.
6. **`exp2HamTook` gate added beyond the brief's letter**: a resume forces `exp2SawUntgt=true`, and doing
   that for a hammer that never verifiably TOOK could fire the loot-open (0x01) on a never-activated stone —
   the exact UI-wedge the hammer-take verification exists to prevent. So the idle-resume requires the
   observed untargetable flip; a never-took stone re-enters today's open flow instead. Engaged re-binds
   don't need it (they preserve `exp2SawUntgt` as-is).
7. **Resume restarts the fight caps** (`exp2FightStartAt = now`): the wave state at re-acquire is unknown;
   caps stay bounded per-resume and the anchor is cleared on every terminal path, so no unbounded loop.
8. **Marker liveness uses `getQuestMarkers`** (Expedition2 path, done-icon 1000 excluded) as the
   fog/128-cap-independent signal; the map-wide `mapObjectiveExists('Expedition2')` was deliberately NOT
   used (flips complete after the FIRST remnant on multi-remnant maps — not anchored evidence).
9. Amnesty state (`_amnesty` exemptions) is not persisted in the nav sidecar — after a mapper reload an
   exempt cell becomes amnestiable again; worst case one extra amnesty/re-earn cycle post-reload.

## Open questions

- None blocking. If the planner wants the steal-withhold behind its own flag instead of riding NAV_ON,
  it's a one-line gate around the `_stolen` check in `navOnLegStuck`.

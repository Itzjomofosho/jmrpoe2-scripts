# TASK-29 — Required-map completeness bundle (SevenWaters "Complete all Abysses" triage, 2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-29\`. File: `..\mapper.js` ONLY.
Evidence: C:\tmp\log.txt (SevenWaters 10:01-10:07) + user's minimap screenshot (4+ chests, a breach, a strongbox
stranded). TASK-27's flip-watch worked (7 incidental completions caught) — these are the NEXT layer of gaps.

## A. Sweep budget: scale + never done-latch on pre-boss exhaust
Live: `[AbyssSweep] budget 90s spent -> 3 site(s) NOT visited` at 10:04:05 — and the budget-exhaust path sets
`abyssSweepDone = true`, so the post-boss Phase 3.8 NEVER revisits (3 chests in the screenshot).
FIX: (1) budget scales with load: `ABYSS_SWEEP_BUDGET_MS = max(90s, 25s * sitesEverQueued)` capped 240s (compute
from abyssSweepCnt.t at spend-check time — no new state); (2) PRE-boss budget exhaust PAUSES the sweep
(`[AbyssSweep] pre-boss budget spent -> N site(s) deferred to post-boss`), does NOT set abyssSweepDone and does
not drop the sites; the MAP_COMPLETE Phase 3.8 call resumes the list with a fresh post-boss allowance (one extra
anchor var). Done-latch only when the LIST drains.

## B. Strongbox guard-event hold for opener-initiated opens
Live: ArmourerStrongboxHigh opened by drive-by commit-click (43.9 -> 19.9u, 10:02:56) with NO utility commitment
-> nothing owned the guard event -> bot walked on with the spawn waves chasing (user almost died; loot stranded).
The Researcher's box 2min later had a utility commitment and held correctly.
FIX: the opener already publishes `POE2Cache.lastStrongboxOpen` (portal-gate backstop). Event-driven hold in the
mapper (the beacon-chest-dwell pattern, TASK-21A): when lastStrongboxOpen fires within 60u and no utility session
already owns that box, arm a bounded stand-and-fight hold at the box (dodge+rotation own the kill; hold ends when
the box's guards are dead/`chestIsOpened` contents drop + a short loot settle, caps: 30s owned / 45s wall, dodge
freeze idiom, aborts in boss states). One hold per box (position key). Const `SBOX_EVENT_HOLD_ON = true`.

## C. Incidental breach adoption MISSED a run-through touch
Live: queue held breach:1 all map; the user ran through and STARTED the breach; ZERO `[Breach]` lines in the
whole log — the incidental-activation detector (`_brIncChkAt`) never adopted it; the timer expired unattended
(CONTENT-MATRIX row #2's watch-item, now confirmed). INVESTIGATE the detector's gates (throttle, radius, the
committed-elsewhere precondition) against this log's movement, then harden: ANY breach entity observed
transitioning to its ACTIVE/opening state within ~100u of the player while no breach is committed -> ADOPT
immediately (rotBreachId + activated timestamp; the roam owns it) — a live breach timer outranks whatever walk
is in progress (it is the one content type that EXPIRES). Log the adoption reason. Keep the existing detector as
one trigger; the hardened check is the backstop.

## D. Abyss wave deadlocked by an IMPRISONED last mob (user: "missed one — essence creature further away
## was the last abyss mob")
The wave's last mob can be imprisoned in an essence (proven co-location: rare:1310 == abyss:1468's mob). The
runner chases visible abyss mobs; an imprisoned one is invulnerable (and excluded from rare-engage by TASK-22C)
-> the wave stalls -> the no-mob/no-progress timeout skips an ACTIVE node on a REQUIRED-abyss map.
FIX in the runner's stalled/no-mob path (before the skip verdict): if the committed node is still ACTIVE and an
UN-OPENED essence crystal sits within ~120u of the node or player (reuse unopenedEssenceMonoliths(), TASK-22 —
no new scan), drive the essence open FIRST (the utility/_hvOpen machinery already opens it once offered — the
runner should HOLD the node commitment, log `[Abyss] wave stalled, unopened essence at <d>u -> opening it first`,
and let the side-step service it; resume the wave after). Bound: one essence attempt per node, the node's
existing caps unchanged. Const `ABYSS_ESSENCE_UNLOCK_ON = true`.

## E. USER RULING — known-boss pre-boss content budget (<=1000u deviation)
"What happened to completing visible objectives BEFORE boss — a deviation of <1000u, knowing where boss is —
shouldve done vaal and others." With the arena anchor KNOWN from map entry (bossTargetSource 'arena_tgt' or an
equivalent confident source), the old route-insertion budgets (~150-540u, sized for boss-location uncertainty)
are obsolete. FIX: when the boss anchor is known-confident, the arbiter's insertion budget for KNOWN queued
content becomes `max(existing, 1000)` (`PREBOSS_KNOWN_BUDGET = 1000`, const `PREBOSS_KNOWN_BUDGET_ON = true`).
This automatically widens the TASK-26 checkpoint-yield (it consumes the arbiter's verdict). Content with
ins > 1000 stays post-boss. Watch: log budget source in the [ArbShadow]/dbg line so the audit shows which budget
applied.

## F. FIGHTING_BOSS stuck with a DEAD boss (user: "fighting boss even though boss is dead")
Live: Manassa died UNOBSERVED (phase + the device-recovery window where scans read 1 entity) -> zero `Boss DEAD`
lines -> every fight exit requires seeing the corpse on scan -> FIGHTING_BOSS persisted (~20s of
`DODGE-SEES-NONE ... boss-doing: ?`) until the user paused. The map's objective bitfield HAS a MapBoss row
(audit: required=[MapBoss,Abyss]) and it is de-stream-proof.
FIX in FIGHTING_BOSS: when the tracked boss has been GONE FROM SCAN for >= 8s (entity absent — distinct from
present-but-hidden phasing), consult `mapObjectiveComplete('MapBoss', now)`; if flipped -> log
`Boss DEAD (objective bit; corpse never scanned)` + run the EXISTING death routing (mapBossKilledAt stamp, the
objective-incomplete branch -> MAP_COMPLETE cleanup for the remaining required content). If the bit is absent on
a map (no MapBoss row), fall back to the existing behavior unchanged. Const `BOSS_DEAD_BIT_ON = true`.

## G. Invuln-phase ban hangover (entity_actions.js — file set expanded for this item)
Live: `hp frozen 3.5s -> ban 4s` fired on Manassa twice during invuln phases BEFORE the gate's holds; when she
became hittable the 4s ban still had to expire -> the observed 1-2s dead air before shooting resumed.
FIX: (1) while the CURRENT target carries `no_players_in_range_immunity`, the hp-frozen clock must not accrue
(the gate is already holding casts — freeze the heuristic too); (2) when the immunity buff CLEARS on a target the
gate was holding, clear that id from `aaStaleBL` -> instant re-engage. Both inside INVULN_GATE_ON.

## Hard limits
- Files: mapper.js + entity_actions.js (G only). No OB ladder changes; reuse the named existing machinery
  (beacon-dwell pattern, sweep list, unopenedEssenceMonoliths, arbiter dbg, MapBoss bitfield read). Flag-off
  parity per const; A's scaling rides ABYSS_SWEEP_ON.
- All new holds bounded + dodge-freeze idiom + boss-state aborts.

## Acceptance
- `node --check mapper.js`; parity walks.
- Report per HOUSE_RULES + live checklist: a 6+-site abyss map sweeps ALL sites (pre+post boss split visible);
  a drive-by strongbox open holds until guards die; a run-through breach gets adopted + cleared; a stalled wave
  with an imprisoned mob opens the essence then finishes the node; a known-boss map does <=1000u-deviation
  content pre-boss ([Ckpt] yields for beacon/strongbox-class content appear).

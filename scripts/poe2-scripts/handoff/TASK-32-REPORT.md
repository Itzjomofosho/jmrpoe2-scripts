# TASK-32 REPORT — Boss survival bundle (catchall promote-on-hit + reach-hold scope + unhittable evade + slam diag)

Status: IMPLEMENTED, runtime-only, UNCOMMITTED. `node --check` passes on all three files. Awaiting user live-test.

Pre-snapshot: `handoff/pre/TASK-32/{auto_dodge_core.js, mapper.js, entity_actions.js}` (copied before any edit).

## Files touched + symbols

### `auto_dodge_core.js` (part A + D-support)
- Consts: `CATCHALL_PROMOTE_ON = true`, `CATCHALL_MUTE_BOSS_MS = 3000`; registry `_catchallPromoted` (Set, `entityId|hazardName`).
- `_catchallSuppressed(entityId, hazardName)`: computes `key` once; **first check** now `if (CATCHALL_PROMOTE_ON && _catchallPromoted.has(key)) return false;` — a promoted anim bypasses EVERY catchall suppressor (channel-hold, mute, CC-skip) and is dodged like a known telegraph. In the existing damage-unmute branch, the anim is **promoted** (added to the set + one-time log) so it never mutes again this map.
- `_noteCatchallDodge(h, now)`: skips budget bookkeeping entirely for a promoted key; mute duration is now `CATCHALL_MUTE_BOSS_MS` (3s) for boss-rarity (`sourceRarity >= RARITY_UNIQUE`) catchalls, else `CATCHALL_MUTE_MS` (8s). Mute log now prints the actual duration.
- New exports: `getCatchallCcVerdict(entityId)` (read-only peek at the `_ccVerdicts` cache; null if never probed) and `resetCatchallPromotions()` (clears the per-map registry).

### `entity_actions.js` (ban-state publish for C + D)
- Module state `_hpFrozenBanId`, `_hpFrozenBanConsec`.
- At the `[Rotation] hp frozen 3.5s ... -> ban` site: increments the consecutive-ban counter (resets on target-id change or on any real hp drop), then publishes `POE2Cache.rotationBan = { id, until, at, consec, rare }`. Pure JS-side publish (no game-memory write); nothing reads it unless the mapper flags are on.

### `mapper.js` (parts B, C, D)
- Import adds `getCatchallCcVerdict, resetCatchallPromotions`.
- Consts/state block near `REACH_THRU_GROUND_*`:
  - **B**: `REACH_HOLD_PLANT_SCOPE = true`, `REACH_HOLD_PLANT_R = 15`, `REACH_HOLD_COMMIT_MS = 2500`, `REACH_HOLD_COMMIT_R = 25`.
  - **C**: `UNHITTABLE_EVADE_ON = true`, `UNHITTABLE_HP_FLAT_MS = 8000`, `UNHITTABLE_ENGAGE_MAXU = 90`; state `unhittableEvadeActive`, `_uhBossId/_uhLastHp/_uhLastDropAt`, `_uhWpX/_uhWpY/_uhWpAt`, `_uhLogAt`, `_uhStallPX/_uhStallPY/_uhStallAt`.
  - **D**: `BOSSFIGHT_DIAG_ON = true`; state `_bfDiagActId/_bfDiagHb/_bfDiagLast/_bfDiagHp`.
- **B** — reach-hold publisher (in the dodge-config block): when `REACH_HOLD_PLANT_SCOPE` on, publish `reachHoldActive = true` only if the char is within `REACH_HOLD_PLANT_R` (15u) of the committed openable, OR an opener commit-click is in flight (`lastEssenceOpen < 2500ms` and within `REACH_HOLD_COMMIT_R` 25u). HP<50% floor unchanged. Flag off → the exact original 90u-essence / 50u-other + 60u-opportunistic condition (moved verbatim into the `else`).
- **C** — in `case STATE.FIGHTING_BOSS`:
  - Detector: right after `trackedBossEntity` resolves (runs every tick, before any early-break). Own HP-flat tracker keyed to the boss id. Enter evasive when engaged >3s AND within `UNHITTABLE_ENGAGE_MAXU` AND (hp flat ≥ 8s OR `rotationBan.consec ≥ 2` on the boss). Drop the instant the boss hp moves / hp resumes / boss leaves the band. Edge logs `[BossFight] unhittable -> evasive posture` / `-> re-engaging`.
  - Posture: inside the close-range movement block, **after** the press-in gate and **before** the kite-floor: reuses `pickLargeOrbitWaypoint` (perpendicular arc, ~58u band) via `stepFightDirectMove`; re-picks on arrival / >1s hold / own stall-watch (flips `bossOrbitDir`); falls back to a perpendicular `sendMoveAngleLimited` nudge if fully boxed. `break`s the tick. Never issues a stop — never stationary.
  - `resetMapper` clears the C tracker/posture state per map.
- **D** — TEMP diag right after the C detector: gated to `FIGHTING_BOSS` + `BOSSFIGHT_DIAG_ON`, on-change of `currentActionTypeId` + 2s heartbeat + 250ms floor. Logs `[BossFight] diag anim=<id>(<name>) act=<typeId> acting=<0/1> cc=<verdict> aaban=<state> dodge=<ran/off> hpd=<delta> <dist>u evade=<0/1>`. Numeric anim id comes from the lightweight fields; if absent AND the boss is acting, one targeted 150u read at emit time. `resetMapper` clears the diag state per map.
- `resetMapper` also calls `resetCatchallPromotions()` (A's per-map reset).

## Settings / consts added (all default-ON; each flips its own feature; OFF = byte-parity)
| Const | File | Default | Off behavior |
|---|---|---|---|
| `CATCHALL_PROMOTE_ON` | auto_dodge_core.js | true | pre-task budget (8s mute, no promotion) |
| `REACH_HOLD_PLANT_SCOPE` | mapper.js | true | original 90/50u + 60u-opportunistic reach-hold |
| `UNHITTABLE_EVADE_ON` | mapper.js | true | FIGHTING_BOSS movement byte-identical (no detector, no posture) |
| `BOSSFIGHT_DIAG_ON` | mapper.js | true | no diag lines |

`POE2Cache.rotationBan` publish in entity_actions is unconditional (telemetry only, mirrors `lastEssenceOpen`/`commitClickSafe`); it changes no rotation behavior and is read only behind the mapper flags.

## LIVE-TEST CHECKLIST

### A — promote-on-hit (boss whose unknown anim hits us once → dodged every subsequent use)
- WORKING: on a boss cone/slam that lands damage, expect once: `[AutoDodge] catchall <label> unmuted (hp X% -> Y%)` immediately followed by `[AutoDodge] catchall <label> promoted (it hit us)`. After that line, that anim is rolled EVERY time (no second hit from the same anim). Boss catchall mutes now read `-> muted 3s` (was 8s).
- BROKEN: the same anim hits us a second/third time with no `promoted` line, or the promoted anim keeps getting muted.

### B — reach-hold scoped to the plant (essence approach dodges ground, holds only at the crystal)
- WORKING: during a long essence walk-in through ground hazards (lightning/fire), the dodge ROLLS the ground during the approach (normal `[Dodge]` roll lines); the reach-hold (no-roll `opener-reach hold`) appears only within ~15u of the crystal or while the opener is actively clicking; the opener still lands all clicks and opens the essence. No sustained HP bleed / chicken-potion during the walk-in.
- BROKEN: still face-tanks ground for the whole approach (HP grinds down far from the crystal), OR the essence never opens because the dodge peels us off before the opener can reach it (see risk note).

### C — unhittable-boss evasive (no standing in front of an invuln boss)
- WORKING: on a boss whose HP freezes (repeated `[Rotation] hp frozen 3.5s ... -> ban`), within ~8s expect `[BossFight] unhittable -> evasive posture (...)` and VISIBLE continuous movement on an arc at ~58u — never standing. The instant the boss becomes damageable expect `[BossFight] unhittable -> re-engaging (boss hp moved)` and the normal fight resumes. Char survives the invuln window instead of eating a one-shot.
- BROKEN: char stands still at engage range while HP is frozen (no `evasive posture` line), OR keeps kiting after the boss HP starts dropping (no `re-engaging` line).

### D — slam-blindness diag (capture one Frostborn-class fight)
- WORKING: during any boss fight, `[BossFight] diag ...` lines on each action change + every 2s. For the invisible-slam case, capture whether `anim=` shows a real id (the 1086 class), `cc=` (CCd vs clear vs unprobed), `dodge=` (ran vs off), `aaban=` (BANNED/expired), `hpd=`. This triages the three suspects: `cc=CCd` while it slams ⇒ TASK-18 CC suppression; `dodge=off` or `cc=unprobed` during the slam ⇒ the ban cleared the boss from the dodge scan; `anim=` a generic/idle id with `dodge=ran,haz0` ⇒ the melee-cone RE gap (no GeometryAttack + reused id).
- This is TEMP — flagged for removal in a later cleanup task once one Frostborn-class fight is captured.

## Risks / deviations
- **B — imprisoned-caster band (WATCH):** the old 90u essence hold existed to push through an imprisoned rare's cast zone to reach the crystal. Narrowing to 15u means the 15–50u band now gets normal dodge, which can roll us off the essence and require the opener to re-approach (the brief explicitly accepts this: "the walk machinery already re-approaches after a dodge"). If a live essence stops getting opened (dodge/re-approach loop that never plants), that's the trade-off to revisit — likely by widening `REACH_HOLD_PLANT_R` or gating the hold on "opener commit in flight" more permissively.
- **C — press-in ordering (deliberate):** evasive runs only when press-in did NOT claim the tick (press-in is checked first). Rationale: press-in is the established activation path for proximity-gated / dormant-idle bosses (drives IN to trigger the phase); the IceCave death had the boss *acting* (slamming) which keeps press-in's gate closed, so evasive fills exactly that gap. For a boss that is idle-but-unhittable AND not proximity-gated, press-in may still drive us to 12u — that is pre-existing behavior, not introduced here. Watch item: if a timed-invuln boss's press-in walks us into a slam, evasive priority may need to outrank press-in when `unhittableEvadeActive`.
- **C — melee builds:** evasive kites at ~58u, so a melee build won't damage the boss while evading. This is acceptable because (a) the boss is unhittable during the window anyway, and (b) proximity phases are owned by press-in. The bot is a ranged (bow) build, which is the design target. Not a regression for the death case.
- **C — trigger timing:** hp-flat (8s) is the primary trigger; `rotationBan.consec >= 2` is a secondary confirmation (~11s given the 4s bans) and only counts when the BOSS itself is the banned target (`rotationBan.id === bossEntityId`), so clustered trash bans can't false-trigger it.
- **D — cost:** the diag is throttled (on-change + 2s + 250ms floor); the enrich read is a single 150u `getEntities` only when the lightweight snapshot omitted the anim id AND the boss is acting. Bounded, and TEMP. If lightweight already carries `currentAnimationId`/`animatedAnimId`, no extra read fires at all.

## Open questions
- (D) Confirm whether the fight snapshot's lightweight entities carry `currentAnimationId`/`animatedAnimId`. If they read 0 in the live log's `anim=` field, the 150u fallback is doing the work (expected); if `anim=` still shows 0 while the boss visibly acts, the numeric top-level anim id may need a heavier read path — flag it and I'll adjust the diag's read.

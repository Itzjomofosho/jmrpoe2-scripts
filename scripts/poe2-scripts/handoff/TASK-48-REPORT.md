# TASK-48 REPORT — flameblast death / ckpt-utility flap / breach white-tail / radar-validate cost

Pre-snapshots: `handoff\pre\TASK-48\mapper.js` + `handoff\pre\TASK-48\auto_dodge_core.js` (taken before any edit).
`node --check` passes on both edited files. All new symbols grepped clean. Runtime dir only; nothing committed.

## A. Ground classify (auto_dodge_core.js)

### A.1 — flameblast family added to the whitelist (code change)
One row in `GROUND_CLASS_TABLE`:
`{ re: /Spells\/monsters_effects\/.*flameblast/i, sev: 1, radiusMul: 1.0 }` — AVOID, generic across acts/re-skins.
Verified against the dump path (`Act3_FOUR/AnchoriteMother/m_flameblast_01_01.ao` matches; the beacon path does
NOT match this row and still hits the sev-2 explode_on_death row first). `m_flameblast_*.ao` does not match the
soft-ground strip regex (`/chill|coldsnap|shock|ignit|burn|abysscrack/`), so the zone stays armed with no hostile
near. b=32 bounds under-read → `GROUND_CLASS_FLOOR_W` (12u grid) carries, same as the beacon rows.
No new flag: rides the existing `GROUND_CLASSIFY_ON` (TASK-41 whitelist), off = byte-parity, per the brief's
"table + matcher fix only" hard limit.

### A.2 — beacon "silence" root cause (REPRODUCED — the premise is partly wrong, no matcher fix needed)
**The beacon was NOT silent and the matcher did NOT miss.** Evidence from C:\tmp\log.txt:
- `11:52:33.513 [AutoDodge] ROLL angle=0 why=lethal:lightning_beacons.ao` — the LETHAL path fired ~700ms BEFORE
  the panic (log line 18966). It also fired earlier the same session (11:25:15 lightning, 11:22:35 + 11:44:49-55
  fire_beacons), so the row works across maps.
- Reproduction of the classify call on the dump line: full path
  `Metadata/Effects/Spells/monsters_effects/monster_mods/lightning/explode_on_death/ao/lightning_beacons.ao`
  matches `/monster_mods\/(fire|lightning|cold|chaos)\/explode_on_death\//i` (verified in node); dump fields
  `type=Renderable/None host=1` pass both the `entityType === 'Monster'` skip and the `!isHostile` skip; d=5u is
  inside the 45u classify range. Every gate passes.
- Why it looked silent: explode_on_death beacons SPAWN when their mod-carrier dies. The rotation was chewing the
  pack from 11:52:22 (rare:605 claimed 11:52:32.920); the beacon appeared ~11:52:33 and the LETHAL roll fired
  within one scan. Detection cannot precede spawn.
**What actually killed:** FOUR overlapping `m_flameblast_*` fields (unclassified → invisible to the dodge's
destination scorer). The 11:52:33.513 escape roll was scored blind to them — "away from the beacon" pointed into
the flameblast carpet; hp -35%/2s → panic → one pot → death. A.1 fixes both halves at once: classified
flameblasts arm the at-risk gate early (charge-up phase) AND penalize roll destinations inside the overlap.

### A.3 — scan-gate verification (report only, per hard limits)
The ground classify runs inside the hazard scan, which only runs when the mapper publishes `dodgeMode !== 'off'`
(`runAutoDodge` is not called otherwise). `dodgeMode` = 'boss' in boss states, else 'rare' iff `rareUniqueNear`
(rare/unique ≤75u) OR a content fight (breach/abyss/verisium/hive/beacon) OR `hazardTerrainNear` (FungalBurst
≤90u), else 'off'. **During the death window the scan WAS running** — mode 'rare' via Sondar/rare 605, proven by
the rare-surround rolls at 11:52:27/:30 and the beacon roll at :33. The planner's "no hazard line between
11:52:12 and the panic" is contradicted by 4 ROLL lines in that window.
**Residual gap (open question below):** on a plain checkpoint/utility walk with only white mobs near (no rare,
no content, no fungal), mode is 'off' and NO ground scan runs at all — a beacon field left behind by a fight can
be walked back through blind. Fixing that means widening the mapper's mode gate, which is outside A's
"auto_dodge_core.js: table + matcher fix only" limit.

## B. Checkpoint<->utility pair commitment (mapper.js, `UTIL_CKPT_COMMIT_ON = true`)

Log-evidence correction first: in the Backwash window each detour DID finish legitimately before resuming
(11:51:44 `handled:pickit`, 11:52:12 `failed:no-net-progress` ban) — the flips were three DIFFERENT far loots
(d=180/196/207) selected in sequence. The un-committed holes that DO exist (and are now closed) are:
1. **Post-grace cap strip**: the active-target resume block in `tryStartUtilityNavigation` nulls a committed
   detour after the 2s `utilCommitted` grace via the boss-approach distance caps — no ban, no log, target can
   re-claim later. Now: `_ckptHeld` (detour claimed FROM `WALKING_TO_BOSS_CHECKPOINT`, key match) keeps
   `utilCommitted` true → the caps may not strip it; its own bounded machinery finishes it (12-45s session cap,
   5s owned-no-progress ban, consumed-retire).
2. **setState ckpt-entry clear**: every transition INTO `WALKING_TO_BOSS_CHECKPOINT` nulled `utilityActiveTarget`
   un-banned. Now `_keepUt` preserves a ckpt-pair-committed, non-ignored target through that entry (the resume
   block re-enters it next pass). Boss-melee/fight entries still clear (different pair, out of scope).
3. **Same-target re-claim**: on every finish that resumes the checkpoint, `finishUtilityState` stamps the
   committed key into `_utCkptDoneKeys`; the candidate filter in `tryStartUtilityNavigation` excludes those keys
   while selecting from a checkpoint walk — so a short defer ttl (25/45/90s contested/arrived bans) lapsing can
   no longer re-open the same detour mid-walk. The set scopes to ONE continuous ckpt<->utility pair: `setState`
   clears it on any other state; also cleared in `resetMapper` and the MAP_COMPLETE fresh-utility pass.

Symbols: `UTIL_CKPT_COMMIT_ON`, `_utCkptCommitKey`, `_utCkptDoneKeys`, `_ckptHeld`, `_keepUt`; hooks in
`startUtilityState` (commit stamp + log), `finishUtilityState` (done stamp + resume log + release), `setState`
(preserve + pair-scope clear), `tryStartUtilityNavigation` (held commit + candidate filter).
Logs (once each): `[Utility] detour committed (<type>: <name>) -- finish/timeout/ban before checkpoint resume`
and `[Utility] resume checkpoint (detour consumed-or-banned, no re-claim this walk)`.
Flag off: `_ckptHeld`/`_keepUt` false, filter and hooks skipped → today's control flow byte-for-byte.
Not touched: TASK-47 engaged-content gates (`OWNED_RUNNER_CLOCKS_ON`/`ENGAGED_NO_PAUSE_ON`), priority ladder.

## C. Breach white-tail (mapper.js, `BREACH_WHITE_TAIL_ON = true`, `BREACH_WHITE_TAIL_MS = 6000`)

Encoded exactly as the user gave it: `rotBreachLastEliteAt` is stamped in `bestBreachMob` when an in-ring,
non-blacklisted rare/unique breach mob is seen (same filter position that refreshes `rotBreachLastMobAt`), and
seeded at the STABILISED one-shot so a rare that never enters the ring still anchors the clock. In
`runBreachRoam`'s DONE condition, `_whiteTailDone` (stabilised && >6000ms since the last elite ping) is a third
OR-term — leftover whites refreshing `rotBreachLastMobAt` no longer hold the roam to the 75s `ROT_BREACH_DWELL`.
Pre-stabilise behavior unchanged (whites are the wave; CLEAR_MS/SPAWN_GRACE untouched). The whole DONE branch
(10s loot stand + sweep + queue completion + pre-breach heading resume) is untouched — white-tail just enters it
sooner. One-shot breadcrumb when white-tail is the deciding reason:
`[Breach] white-tail: no rare/unique Ns post-stabilise -> done (whites don't hold the ring)`.
Reset at all four lifecycle sites (roam start, both adoption paths, `resetMapper`).
Flag off: the timestamp is written but never read → byte-parity.

## D. Lazy radar validation (mapper.js, `RADAR_LAZY_VALIDATE_ON = true`)

In `pickRouteNearestBucket`: the upfront per-candidate `radarFindPath` sweep (up to 8 calls in one 2.5s pass —
the 1551ms mapper frame) is skipped in lazy mode; the macro pick runs exactly as pre-46F, then ONE
`radarFindPath` validates the winner. Failed winner → same `_unexpFailed` 300s ban + the same
`[Discover] bucket (x,y) radar-unroutable -> banned upfront` log → this pass returns null and the next 2.5s pass
re-picks around it. Net ban set identical over time; worst-case one radar call per pass. The lazy call is timed:
`[Discover] radar route slow NNNms` for any call >100ms (JS-side visibility of the C++ BFS/RebuildOverlayPaths
cost). `PICKER_RADAR_ROUTE_ON` stays the master kill switch (off = no radar validation at all, either mode).
Flag off: the upfront sweep runs verbatim (no timing/log added there) → byte-parity.

## Settings added (all consts at top of their sections, greppable)
| Flag | Default | Off = |
|---|---|---|
| `UTIL_CKPT_COMMIT_ON` (mapper.js) | true | today's ckpt/utility flow byte-for-byte |
| `BREACH_WHITE_TAIL_ON` (+ `BREACH_WHITE_TAIL_MS` 6000) (mapper.js) | true | 75s-cap behavior |
| `RADAR_LAZY_VALIDATE_ON` (mapper.js) | true | upfront 8-candidate radar sweep |
| (A rides existing `GROUND_CLASSIFY_ON`, table row only) | — | row never consulted |

## LIVE-TEST CHECKLIST
Suggested map: anything with AnchoriteMother packs + a breach (Backwash-like), then watch discover on a maze map.
- **A**: near a casting AnchoriteMother expect `[AutoDodge] ROLL ... why=ground:m_flameblast_...` (or a walk-out)
  BEFORE standing in the blast; the overlay draws the danger circles. BROKEN = char plants in visible stacked
  flameblasts with a rare/unique nearby and no ground line. (Remember: with no rare/content near, mode='off' —
  no ground dodge at all; that's the pre-existing gap, not a regression.)
- **B**: on a checkpoint walk that detours, exactly one `[Utility] detour committed (...)` then later one
  `[Utility] resume checkpoint (...)`; the SAME item/chest must not be re-selected during that walk; a committed
  detour must never silently vanish (state flips ckpt->utility->ckpt with no blacklist/consumed/timeout line
  between = BROKEN). Different targets may still each get one detour — expected, see open questions.
- **C**: after `[Breach] STABILISED` and the last rare/unique dies, expect the white-tail line + `[Breach]
  cleared` within ~6-7s even with whites visibly standing; then the normal 10s loot stand. BROKEN = breach still
  running 60s+ with only whites in the ring, or a breach ending mid-rare-wave (would mean the elite ping is
  wrong).
- **D**: during discover, `[DrawProf]` must show no ~1s+ mapper frames coincident with `radar-unroutable` lines;
  any single slow C++ call now shows as `[Discover] radar route slow NNNms`. BROKEN = discovery stalls >10s with
  repeated `radar-unroutable` on consecutive passes (3+ banned winners back-to-back) — kill
  `RADAR_LAZY_VALIDATE_ON` first, `PICKER_RADAR_ROUTE_ON` second.

## Risks / deviations from the brief
- **A.2 deviation**: no matcher change made — the brief assumed a classify miss, but the log proves the beacon
  fired the LETHAL path (11:52:33.513) and the reproduction shows every gate passing. Root cause reported
  instead (beacon spawns on host death; the killer was the unclassified flameblast stack the roll was scored
  blind to). If the planner still wants a matcher hardening pass (e.g. the per-id verdict cache vs recycled
  entity-id slabs — a THEORETICAL stale-verdict source, no observed instance), that's a follow-up decision.
- **B interpretation**: the brief's "checkpoint walk re-claims mid-utility-walk" reading of 11:51:44/11:52:12 is
  contradicted by the finish reasons (pickit-handled / no-progress ban); I closed the REAL un-committed holes
  (cap strip, setState clear, short-ttl re-claim) that produce exactly that symptom. The observed flip-chain of
  DIFFERENT far loots (d=180-207 selections while `bossObjectiveCommitted` computed false) is NOT blocked by the
  brief's prescription — flagged as an open question rather than invented scope.
- **D**: in lazy mode an unroutable winner costs one 2.5s pass (pick returns null) before the re-pick; N stacked
  unroutable buckets take N passes to drain where the old sweep banned up to 8 in one (1551ms) frame. Accepted
  by the brief ("the NEXT pass re-picks").
- **C**: a walled-off (mob-blacklisted) rare inside the ring does not ping the elite clock — consistent with the
  existing CLEAR_MS convention (blacklisted mobs don't hold the breach either), so a walled rare closes the
  breach after 6s instead of pinning it.

## Open questions (for the planner)
1. A.3 residual: should a follow-up widen the dodge mode gate so LETHAL-class ground (beacons) is scanned during
   plain walk states (whites-only)? Cost: the classify scan runs off the shared per-frame list, but `runAutoDodge`
   itself would need arming outside rare/content windows — mapper-side change, perf-sensitive.
2. B residual: the observed death-march pattern (three DIFFERENT 180-207u loot detours chained through one pack)
   is still possible one-per-target. If unwanted, candidates: a per-checkpoint-walk detour budget, or fixing the
   `bossObjectiveCommitted=false` hole that let 200u+ loot bypass the checkpoint caps entirely (the `d=207`
   select shows the caps never applied). Neither was in the brief, so neither was coded.

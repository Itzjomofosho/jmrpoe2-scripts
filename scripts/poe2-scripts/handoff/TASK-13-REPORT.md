# TASK-13 REPORT — StoneCircle (Runed Monolith) handler + generic interrupt-aware opener retry

**Status: IMPLEMENTED + LIVE-TESTED across multiple maps, confirmed working. NOT committed** (runtime-only edits in
`c:\Games\jmr-poe2\scripts\poe2-scripts\`; awaiting the planner/Fable review vs `handoff/pre/TASK-13/`, then the
user commits). `node --check` passes on both files; all new symbols grepped.

## Pre-snapshot (FIRST ACT)
`handoff/pre/TASK-13/opener.js` + `handoff/pre/TASK-13/mapper.js` — byte-identical copies taken BEFORE any edit
(md5 verified: `91741d46…` / `81f1f28a…`). This is the diff base. Working files now differ (as expected).

## Verify-first result
Used the planner's PROVEN premise directly (no re-verify): one `0x01A3` interact consumes a rune
(`isTargetable` true→false), a `RuneRock_Controller` (no Targetable) sits at the rock centre and is the unique's
spawn point. Confirmed live during testing (rocks consumed in 1 click, Stormgore/unique spawned + died on completion).

## Files touched (2 files, both in the runtime dir)

### `opener.js`
- **Item A constants**: `OPEN_LAND_CHECK_MS = 600`, `OPEN_FREE_RETRIES = 2`, `OPEN_FAIR_RANGE = 30`.
- **`RUNEROCK_MAX_ATTEMPTS = 3`** const + **`isRuneRockEntity(entity)`** helper (matches the RuneRock path /
  "Runed Monolith", NOT a plain essence "Monolith").
- **`markOpenAttempt(entity, now, type, fairWindow)`** — new `fairWindow` arg; `rec` gains `freeRetries`; the
  interrupt-aware free-retry branch (non-essence, unfair, under cap); **RuneRock capped at 3** (real essences 9).
- **`shouldSkipOpenTarget`** — fast-lane re-fire gap (`OPEN_LAND_CHECK_MS`) while a target still has free retries.
- **`processAutoOpen`** — computes `_fairWindow`, passes it to `markOpenAttempt`; the ban-log line now prints the
  ACTUAL cap (so a RuneRock ban reads "after 3 attempts", not the hardcoded 9).

### `mapper.js`
- **STONECIRCLE block** (inserted before `navTo`): `STONECIRCLE_ON` kill-switch + `STONE_*` tunables; module state;
  helpers `stoneCircleKey` / `stoneHostileNear` / **`stoneApproachPoint`** / `stoneScan` / `stoneReset` /
  `stoneFinish`; the **`runStoneCircle(player, now)`** state machine; OB adapters
  `obStoneClaim`/`obStoneRelease`/`obStoneTouch`.
- **`obReconcile`** — added a `layer === 'stone'` branch (retires a stale record keyed on `stoneKey`).
- **`getOpenableUtilityCandidates`** — excludes RuneRock/StoneCircle from utility openable candidates (retire the
  old owner).
- **`_isMonolith` stand-dwell branch** — comment updated (now unreachable by RuneRocks; serves only essences).
- **Hook sites**: pre-boss (after `runHiveDefense`, gated `FINDING_BOSS || WALKING_TO_BOSS_CHECKPOINT`);
  MAP_COMPLETE cleanup (new "Phase 3.7", before the abyss-chest sweep).
- **`resetMapper`** — clears stone state per map (`stoneReset()` + `stoneBlacklist.clear()` + scan/tick reset).

## Settings added
None as a user setting. **`STONECIRCLE_ON`** const (default `true`) is the kill-switch (house convention). Set it
`false` for byte-parity rollback (one token). No `Settings.*` key, no UI checkbox.

## Item A — the EXACT rule implemented
A generic (NON-essence) opener send counts as a **real attempt** (toward `OPEN_MAX_ATTEMPTS = 3` → 10-min ban) only
when it had a **fair window**: target within `OPEN_FAIR_RANGE` (30u) **AND** no non-opener movement lock driving the
character (a `pickit`/other lock cancels the interact's auto-walk; the opener's own lock does not count).
- A send with **no** fair window is a **free retry**: doesn't count, and re-fires on the fast `OPEN_LAND_CHECK_MS`
  (600ms) gate — capped at `OPEN_FREE_RETRIES` (2) per target; after that, normal accounting resumes so a genuinely
  stuck target still bans (~2 free + 3 counted). The fast gate applies only while `rec.attempts === 0`.
- **Real essences UNTOUCHED**: `rec.t === 'Essence'` skips the free-retry branch and keeps `ESSENCE_RETRY_DELAY_MS`
  (250ms) / `ESSENCE_MAX_ATTEMPTS` (9) — byte-identical.
- **RuneRocks** (the exception the user asked for) keep the fast essence cadence but cap at **3** attempts (see
  deviation #5).

## How runStoneCircle owns it
- **Detection** (`stoneScan`, throttled 800ms): `getEntities({nameContains:'StoneCircle', maxDistance: 150 pre-boss /
  320 MAP_COMPLETE})`; classify `RuneRock_Controller` (anchor + spawn point) vs `RuneRock` rocks; cluster rocks to the
  nearest controller (≤60u); fallback = rock centroid if no controller streamed.
- **Commit**: nearest non-banned group WITH a live (targetable) rock; never re-commits while one is live (no steal).
  **GATED on `mapObjectiveComplete('StoneCircles')`** (user request) — once `[x] StoneCircles` is done it will NOT
  commit a new circle, so a leftover orphan RuneRock (stays `isTargetable:true` after "All Summoning Circles
  Completed") never drags the bot across the map. A circle already in progress when the objective flips still finishes.
- **VISIT** — the load-bearing part: **commit to ONE rock at a time** (anti-thrash), and **walk to a WALKABLE APPROACH
  CELL beside the rock, not the rock's own cell**. A RuneRock's cell is UNWALKABLE (solid stone; live-verified via
  `isWalkable` — every rock read `cellWalkable:false`, walkable ground ~6–8u away), so pathing straight at it dead-ended
  + wall-slid on a 44-waypoint route. `stoneApproachPoint(rx,ry,px,py)` probes rings outward and returns the innermost
  walkable cell nearest the player (≤16u); the walk targets THAT (`'boss'` fog-independent route); we park at the cell /
  inside the opener's 20u reach, then dwell until `isTargetable === false` (the opener clicks). Three skip signals (all
  → try the next rock, never yoyo): opener **hard-ban** (`isOpenTargetHardBanned`, now 3 attempts); **reachability
  give-up** (no progress toward the approach cell for 7s owned — tracks the CELL, since it can be on the far side);
  15s consume-timeout backstop. **Skipped rocks don't block completion (live-proven) — no skip-count circle-ban.**
- **FIGHT**: all rocks consumed/skipped → hold the **committed anchor** (≤14u; dodge + rotation own the kill; the
  rocks/controller de-stream on completion, which is fine — the fight doesn't need them). End on unique-dead (seen
  then gone ≥1.5s, min 3s hold) / 20s cap / no-unique-within-6s.
- **DONE/BAN**: position-keyed (`/12`) 10-min ban so a re-streamed/re-targetable circle is never re-done; release OB.
- **Clock freeze** (commitment discipline): every committed-circle clock advances by any span the handler did NOT own
  the frame — a dodge-held frame OR a >1s gap (hook not running during a boss fight / other state). No cap burns
  off-frame. Live-confirmed under heavy dodge/rare/pickit churn.
- **OB**: registers a commitment on commit, releases on done/ban, refreshes while owning — the broker's
  claim/pause/resume/complete narrative covers it (live: survived ~5 rare preemptions with correct pause→resume).

## Deviations from the brief (with why) — READ THESE
1. **OB layer `'stone'`, not `'content'`** (brief said `layer 'content', pri 4 optional`). `obReconcile` retires any
   `layer:'content'` record whose key ≠ `arbCommittedKey` EVERY pass — a self-driven runner (like the breach roam)
   would churn claim/complete each frame. Used a dedicated layer `'stone'` at the **same rank** (`OB_PRI.optional` = 4)
   with its own reconcile branch keyed on `stoneKey`, mirroring the `rare`/`mirror` adapters. Ladder behavior identical.
2. **OB register-for-narrative, not hard-defer.** Records the commitment (claim/pause/complete) so the broker log
   covers it, but does NOT hard-defer `runStoneCircle` when `objBroker` is ON (no `obStoneDeferred`). Enforcing-mode
   deferral would need clock-freeze-on-deny plumbing (not in the brief, wrong to add blind). Mirrors how breach-roam
   (no OB) and `obUtilityClaim` (claim + pause-on-deny, no control-flow change) integrate.
3. **Pre-boss gate = `FINDING_BOSS || WALKING_TO_BOSS_CHECKPOINT`** (the mirror hook's scope), not breach-roam's wider
   "all non-boss-engage" scope. Conservative; anything missed there is swept post-boss by the MAP_COMPLETE hook.
4. **Removed the brief's "2 skips → ban circle."** Live-proven a skipped rock does NOT block completion (a circle
   completed with a rock skipped). So un-consumable/unreachable rocks are just skipped, we consume whatever IS
   consumable, then fight — the 6s no-unique grace + 90s per-circle cap are the real bounds. Prevents giving up with a
   good rock still present.
5. **RuneRock opener cap = 3** (brief's item A said "essences untouched"; the user then explicitly asked for "3
   attempts, EXCEPT essence"). RuneRocks classify as `type:'Essence'` but a live rune consumes in 1 click and a
   spent/re-clickable one never consumes — 9 attempts wasted ~7s/rune. Real essences still get 9.
6. **Approach-cell walk + objective gate + reachability give-up + `'boss'` routing** — not in the brief; added from
   live testing (rock cells are unwalkable; orphan rocks after completion; juiced-map pathing). Detailed above.

## Risks / things to watch
- **Depends on `openEssences` ON** (default true) for the dwell clicks. Off → the 15s per-rock timeout skips every
  rock → circle bans (acceptable; the opener is opt-in).
- **`isTargetable` resets to true on re-stream** (user saw a clicked rune "respawn clickable"). Handled: within one
  committed session the rocks stay streamed (consume signal reliable), and the position-keyed ban stops re-commit.
- **Deeply-walled / genuinely-unreachable rock**: `stoneApproachPoint` finds no walkable cell within 16u → the
  reachability give-up skips it (bounded, no trap). If a whole circle is behind hard terrain the unique may be
  forgone — it's optional content; the circle bans and the map continues.
- **Juiced-map churn**: on a dense map the circle competes with rares/breach/dodge/pickit (all higher or equal
  priority). Expect "yoyo" — the OB pause/resume handles it and the circle completes; a far first-commit can be lost
  + banned + re-committed nearer (bounded). See "reduce far-commit" in open questions.

## LIVE-TEST CHECKLIST (`[StoneCircle]` tag; `[Opener]` for the opener)
**Good path:** `commit sc:<k> (N rocks)` → `-> rock <d>u via (x,y)` (heads for the walkable approach cell) →
`[Opener] Opened Essence: RuneRock` per rock → `rocks done (0 skipped) -> hold centre` → unique →
`fight done (unique dead) -> handled`. Must NOT re-commit the same circle after (position-ban).

**Skips (bounded, healthy):**
- `rock <id> opener-banned (un-consumable) -> skip (skipped=N)` — a spent rune (now after **3** opener attempts).
- `rock <id> unreachable (no approach 7s at <d>u) -> skip` — a walled rock (moves to the next, no yoyo).
- `rock <id> no consume in 15s -> skip` — the consume-timeout backstop.
- `total cap 90s -> ban + done` / `lost (de-streamed 15s) -> ban` — per-circle caps.

**RuneRock 3-cap:** a spent rune now logs `[Opener] Blacklisted Essence: RuneRock after 3 attempts` (was 9).

**Objective gate:** on a map whose `[x] StoneCircles` is already complete, NO `[StoneCircle] commit` line (no chasing
orphan rocks); the opener may still click one that falls in its 20u range (≤3 clicks then banned).

**Retirement:** no `Runed Monolith: standing (x/5.0s)` utility status / no utility `Walking to <RuneRock>` — the
circle handler owns them now.

**OB (only if `objBroker` ON):** `claim=stone:<k> pri=4 (stone-circle)` on commit; `pause stone by=rare` →
`resume stone (from stack)` on preemption; `complete stone:<k> (stone-done)` on finish. `objBroker` OFF = shadow.

## Live-test log (what actually happened, chronological)
1. **Excavation `sc:70x70`** — end-to-end worked: 2 rocks consumed, un-consumable 3rd skipped, unique **Stormgore**
   killed, completed. Exposed → fixed: (a) thrash back to the broken rock (→ commit-one-rock + opener-ban fast-skip);
   (b) premature 2-skip ban (→ removed, deviation #4). Initial "nothing happened" was **Auto-Open being OFF** (not code).
2. **Savanna `sc:55x43`** — got stuck walking to a rock (`No net progress … at 43u`, `44 wp`). **Live `isWalkable`
   probe found the root cause: rock cells are UNWALKABLE.** → `stoneApproachPoint` (walk to the walkable cell beside
   the rock). Validated live: stuck rock `127` → approach cell (676,534), walkable, 7u away. **Re-run succeeded.**
3. **Savanna `sc:89x89` (juiced, breach + rare swarm)** — completed `0 skipped` amid constant dodge/rare/pickit;
   OB pause/resume textbook across ~5 preemptions; clocks froze correctly. User: "GOOD ENUFF."
4. **Savanna orphan rocks** — after `[x] StoneCircles` complete, a spent rune re-streamed clickable and the opener
   clicked it 9× (~7s). → objective gate (no mapper commit) + RuneRock opener cap **3**. Confirmed: bans after 3.

## Open questions (optional follow-ups, none blocking)
- **Reduce far-commit churn**: only commit pre-boss within ~100u (vs 150u) so the bot clears local threats first and
  commits the circle when close (far ones still swept post-boss). Would cut the juiced-map "yoyo". One-line change;
  left as-is per "good enuff".
- **Pre-boss gate width** (deviation #3): keep conservative or widen to breach parity? Trivial to widen.
- **Unrelated to TASK-13**: a far `Researcher's Strongbox` at ~244u burned ~16s in the utility-detour flow before
  `unreachable -> blacklist`. Pre-existing utility behavior, separate subsystem — flag only.

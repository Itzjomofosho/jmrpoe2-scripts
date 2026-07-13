# TASK-54 REPORT — Catchall cadence cap + inventory-full handling + route-verified checkpoint arrival

Implementer: Opus 4.8. Solo (HOUSE_RULES §0 — no fleets/workflows). All four sub-tasks implemented behind flags,
flag-off = byte-parity. `node --check` passes on every edited file. NOT committed — awaiting the user's live test.

Pre-snapshot: `handoff\pre\TASK-54\{auto_dodge_core.js, mapper.js, pickit.js}` (copied before any edit).

## Files touched
- `auto_dodge_core.js` — A (catchall roll-cadence cap) + D (roll-into-wall feedback).
- `mapper.js` — C (route-verified checkpoint arrival) + B.3 (between-maps hideout stash dump).
- `pickit.js` — B.1/B.2 (inventory-full detection + full-bag pickup hold).
- (read-only reuse) `inventory.js` — existing proven `freeSlots / readInventory / getStashTabs / requestStashTab
  (0x00E6) / moveByHandle (0x0100 via moveStashItem)`. NOT edited.

---

## A — CATCHALL ROLL-STORM (auto_dodge_core.js)
Root cause confirmed from the brief: a PROMOTED catchall re-promotes on every boss hit, so a proven-dead anim read
(`anim_1086`) drove one roll per hit → the boat-deck yoyo. Promote-on-hit is untouched (survival). Added a
per-SIGNATURE roll-cadence cap.

Symbols added: `CATCHALL_ROLL_CD_ON`, `CATCHALL_ROLL_CD_MS`, `_catchallRollAt`, `_cdSuppressN/_cdSuppressLogAt/_cdSuppressName`.
- `_catchallSuppressed()` promoted branch: if the signature rolled within `CATCHALL_ROLL_CD_MS`, SUPPRESS synthesis
  (return true) instead of the old unconditional `return false`. Standoff/evade own survival between rolls.
- `_noteCatchallDodge()`: stamps `_catchallRollAt[entityId|hazardName]=now` on every roll where the player stands in
  the catchall hazard (the boss-anim catchall circle is player-centered → fires reliably for the dead-anim case).
- Cleared per map in `resetCatchallPromotions()`.
- NOT 1086-specific (dead-anim bosses are the majority) — caps ALL promoted catchalls. No change to promote-on-hit
  arming, standoff, or the telegraph DB (hard-limit A honored).

Settings: `CATCHALL_ROLL_CD_ON = true` (default), `CATCHALL_ROLL_CD_MS = 4000`. Off → promoted dodges every scan (parity).

## B — INVENTORY-FULL (pickit.js + mapper.js)
### B.1/B.2 pickit — full-bag pickup hold
Symbols added: `INV_FULL_HOLD_ON`, `INV_FREE_TTL_MS`, `invSnapshot()`, `invFreeSlots()`, `stacksIntoExistingBag()`,
`_invSnapCache/_invSnapAt/_invFullHoldLogAt`. New import: `readInventory` from `inventory.js`.
- `invSnapshot()` = one `getInventory(main)` read (via `freeSlots` + `readInventory`), cached 5s → `{free, items}`.
  Fail-OPEN (`free: 99`) on any read error so a bad read never suppresses a pickup.
- In the pickup loop, BEFORE the reachability probe: at `free === 0` and the item is NOT stackable-into-an-existing
  same-base stack → log ONE `[Pickit] inventory FULL -> holding pickup of <item>` (10s throttle) and `continue`
  WITHOUT touching `pickupAttempts` (no retry burn, no blacklist — the item stays wanted). This is what stops the
  `may not be reachable - will retry` churn on unpickable items.
- Stackables (currency with a same-base stack present) are NOT held — they proceed through the unchanged
  reachability + `canFit` path (parity for them).

Settings: `INV_FULL_HOLD_ON = true` (default), `INV_FREE_TTL_MS = 5000`.

### B.3 mapper.js — between-maps hideout stash dump
Symbols added: `INV_STASH_DUMP_ON`, `INV_MIN_FREE`, `STASH_DUMP_SEND_MS/LOAD_WAIT_MS/BUDGET_MS/ITEM_RETRIES/TAB_NAME`,
`_stashDump`, `runStashDumpStep()`, `_stashDumpKeep()`, `_resolveStashDumpTab()`, `_buildStashDumpQueue()`,
`_finalizeStashDump()`. New import: `readInventory, freeSlots as invFreeSlotsOf, getStashTabs, requestStashTab,
moveByHandle, INV as INV_IDS` from `inventory.js`.
- Runs at the FRONT of the hideout cycle (`HIDEOUT_CHECK_PORTALS`), BEFORE the `stopWhenInventoryFull` AFK-stop, so
  a full bag is cleared instead of parking the loop. Holds the flow (`return`) while dumping; state stays at
  `HIDEOUT_CHECK_PORTALS` (no new state threaded through the machine).
- Only when free < `INV_MIN_FREE (=10)`. Force-loads the dump tab (`requestStashTab` = 0x00E6), waits ~1.2s, then
  moves loot item-by-item (`moveByHandle('in',...)` = 0x0100) paced 150ms, per-item retry cap 2, 60s hard budget.
- KEEP in the bag (dumping them would wedge the next map-open): waystones (holder id14), tablets/precursors
  (holder id77), and **all currency** (see Open Question 1), plus any unclassified/empty-path item. DUMP the rest
  (gear/gems/jewels/relics/…).
- Verifies via a fresh `freeSlots` read and logs `[Stash] dumped N items (M free now)`; invalidates the AFK-stop's
  cache so it re-reads. Any stash read/move failure → `[Stash] ... -> skip dump` + fall through. NEVER wedges.
- Re-armed per hideout visit via `resetMapper()` (`_stashDump = null`).

Settings: `INV_STASH_DUMP_ON = true` (default), `INV_MIN_FREE = 10`, `STASH_DUMP_TAB_NAME = ''` (→ first stash tab).

## C — CHECKPOINT "REACHED" IS EUCLIDEAN (mapper.js)
Symbols added: `CKPT_ROUTE_ARRIVAL_ON`, `CKPT_ROUTE_DEFER_CAP_MS`, `ckptRouteDeferSince`, `checkpointRouteVerified()`,
`_checkpointRouteProbe()`, `_ckptDeferLogAt/_ckptVerdictAt/_ckptVerdictVal/_ckptVerdictKey`.
- `checkpointRouteVerified()` requires distance ≤ threshold (unchanged) AND route-verified adjacency:
  `poe2.isWithinLineOfSight(player, ckpt)` at close range (LoS is a walkable-grid line → a chasm breaks it), OR
  `poe2.radarFindPath(player → ckpt)` whose end lands ≤15u from the checkpoint with route LENGTH ≤ ~2× euclidean
  (a 3× route = wrong side, not there). Verdict cached ~400ms / re-probed on >6u player move (throttles the radar
  BFS — the arrival block re-enters every logic pass). No LoS + no radar binding → returns true (can't verify →
  distance-only, never wedge).
- Integrated at the checkpoint ARRIVAL trigger (not the `checkpoint-confirmed` gate return): the gate-fail path
  force-switches to melee-forward, which was still crossing-less. Instead, while route-far we RE-ISSUE the
  checkpoint walk (the radar route knows the bridge) and hold in `WALKING_TO_BOSS_CHECKPOINT`. Bounded by
  `CKPT_ROUTE_DEFER_CAP_MS (=12s)` → after the cap, proceed as before (never livelock). Checkpoint-source only
  (arena barriers are physical objects, not prone to the chasm lie). No change to checkpoint selection or the melee
  approach itself (hard-limit C honored).
- Deferral log: `[Ckpt] euclid-close but route-far (route Nu vs Nu) -> keep walking` (4s throttle).

Settings: `CKPT_ROUTE_ARRIVAL_ON = true` (default), `CKPT_ROUTE_DEFER_CAP_MS = 12000`.

## D — ROLL-INTO-WALL (auto_dodge_core.js)
Symbols added: `ROLL_WALL_FEEDBACK_ON`, `ROLL_WALL_MEASURE_MS/MAX_MEASURE_MS/MOVE_FRAC/BAN_MS/BAN_HALF_DEG`,
`ROLL_WALL_UNWALK_PEN/SECTOR_PEN`, `_rollWallBans`, `_pendRoll`, `rollWallPenalty()`, `_checkRollWall()`.
- PRE (`rollWallPenalty`, added to both the 8-dir and perpendicular candidate scoring in `chooseDodgeDirection`):
  heavy down-score for an unwalkable landing cell and for a bearing inside a banned sector. Not forbidden — a fully
  boxed-in fight still takes the least-bad option.
- POST (`_checkRollWall`, run early each scan): ~400ms after a roll, if world displacement < `ROLL_WALL_MOVE_FRAC
  (=0.4)` × expected roll distance → the bearing hit a wall → ban its ±45° sector for `ROLL_WALL_BAN_MS (=20s)`;
  log `[AutoDodge] roll bearing N blocked (moved Nu) -> sector banned 20s`. The next roll scores that sector out and
  goes elsewhere. `_pendRoll` armed on each roll (bearing = direction actually rolled). Bans cleared per map in
  `resetCatchallPromotions()`. Roll TRIGGERS (telegraph/panic/catchall) untouched (hard-limit D honored).
- Only false-negatives possible (walker movement between roll+measure can mask a block → no ban, safe); never a
  false wall-ban from other movement.

Settings: `ROLL_WALL_FEEDBACK_ON = true` (default) + the tunables above. Off → today's scoring + no sector bans.

---

## LIVE-TEST CHECKLIST
**A (dead-anim boss, e.g. the Flotsam/boat-deck boss):**
- WORKING: at most ~one catchall roll every ~4s; between them `[AutoDodge] catchall anim_1086 on cooldown (Nx
  suppressed)` (every 10s). No roll-per-hit storm. Panic/telegraph-DB rolls still fire freely (unaffected).
- BROKEN: still 30+ rolls/min against `anim_1086`; or the boss's REAL telegraphs stop being dodged (over-suppress).

**B (full inventory):**
- WORKING (in map): `[Pickit] inventory FULL -> holding pickup of <item>` ONCE per 10s; the
  `may not be reachable - will retry` churn stops. In hideout: `[Stash] inventory low (N free) -> dumping M loot
  item(s)` then `[Stash] dumped N items (M free now)`; the next map opens with more free cells and the AFK "STOP:
  inventory full" does NOT fire when dumpable loot existed.
- BROKEN: pickit keeps churning reachability; OR `[Stash] ... skip dump` every visit (stash unreachable from the
  map-device spot — see Risk 1); OR a waystone/tablet got stashed and the map-open then fails (KEEP set too narrow).

**C (chasm-side checkpoint, e.g. HiddenGrotto with a bridge):**
- WORKING: `[Ckpt] euclid-close but route-far (route Nu vs Nu) -> keep walking` appears, the char keeps walking
  across the bridge, THEN `Boss entry reached (checkpoint) ... -> switching to melee engagement` fires (on the
  correct side). No melee switch from the wrong side of the chasm.
- BROKEN: it defers forever (watch for `[Ckpt] route-far deferral capped` — means the 12s bound engaged; the radar
  route may not be landing on the checkpoint) OR it still false-arrives across the chasm (flag/route not firing).

**D (boss-fight start against an invisible arena edge):**
- WORKING: a blocked roll logs `[AutoDodge] roll bearing N blocked (moved Nu) -> sector banned 20s` and the NEXT
  roll visibly goes a different direction. Never 3 consecutive rolls into the same invisible wall.
- BROKEN: still 3+ rolls into the same wall (measurement not firing / ban not steering the pick).

## Risks / deviations
1. **Stash access from the bot's hideout position (biggest live-test unknown).** The dump assumes the proven
   `requestStashTab (0x00E6)` + `moveStashItem (0x0100)` land from wherever the bot sits in the hideout (typically at
   the map device, possibly not adjacent to the stash). If they require stash proximity, the moves no-op → the verify
   logs a still-full bag → the AFK-stop parks the loop. It fails GRACEFULLY (never wedges), but the feature would do
   nothing until the bot is positioned near the stash or the packets are confirmed proximity-independent.
2. **Dump target tab = the FIRST stash tab** (`STASH_DUMP_TAB_NAME = ''`). If tab 0 is a special/currency tab that
   rejects gear, the moves no-op (still graceful). Set `STASH_DUMP_TAB_NAME` to a real grid tab's name to pin it.
3. **C integration point.** The brief said "the reached-gate (grep 'checkpoint-confirmed')", but returning `ok:false`
   from that gate force-switches to melee-forward (crossing-less). I instead gated the ARRIVAL trigger so a route-far
   checkpoint KEEPS the checkpoint walk (the brief's intended "keep walking"). Same effect, correct control point.

## Open questions
1. **Currency dump policy (B.3).** The brief keeps "waystones, tablets, and the currency the device flow needs." I
   could not reliably distinguish device-currency from loot-currency, and stashing a currency the open flow consumes
   would wedge the map-open (explicitly forbidden). So I KEEP ALL currency (conservative) and dump only gear/gems/etc.
   This clears the evidence case (gear-full bag) and lets currency merge into existing stacks, but it does NOT stash
   exalts/vaal to free their cells. If you want currency stashed too, name the exact keep-set (or the specific
   device-currency to exclude) and I'll tighten `_stashDumpKeep()`.

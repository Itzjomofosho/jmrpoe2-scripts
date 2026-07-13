# TASK-54 — Catchall cadence cap + inventory-full handling + route-verified checkpoint arrival

FIRST ACT (HOUSE_RULES): copy `..\auto_dodge_core.js`, `..\mapper.js`, `..\pickit.js` into
`handoff\pre\TASK-54\`. USE OPUS 4.8. SEQUENCING: after TASK-53 and TASK-51 land (mapper.js order).
Evidence: C:\tmp\log.txt (Flotsam 15:18-15:20, 2026-07-13) + user screenshot (Exalted Orb + 2x T15
Waystones + Vaal Orb on the ground, inventory FULL).

## A. CATCHALL ROLL-STORM (auto_dodge_core.js): anim_1086 promoted every ~1.2s for a full minute
`boss_telegraph:boss-anim~catchall:anim_1086` rolled 30+ times in 60s (15:18:47-15:19:45). anim 1086 is the
PROVEN-DEAD anim read (aa-OFF capture: anim=1086 act=0 mid-slam AND at idle — it never changes), so the
catchall/promote-on-hit re-promotes it on every boss hit -> a roll per hit -> the boat-deck yoyo. Do NOT
blanket-exempt 1086 (promote-on-hit is a survival feature and dead-anim bosses are the majority) — CAP THE
CADENCE: a promoted catchall signature may trigger at most one roll per CATCHALL_ROLL_CD_MS = 4000 (tunable);
between rolls the standoff/evade layers own survival (they exist for exactly this). Log the suppressed
re-fires once per 10s: `[AutoDodge] catchall anim_1086 on cooldown (Nx suppressed)`. Flag
`CATCHALL_ROLL_CD_ON = true`.

## B. INVENTORY-FULL (mapper.js + pickit.js): the bot has NO concept of a full bag
User: "right because u are full." — exalts + T15 waystones left on the ground; pickit churned
'may not be reachable - will retry' at items it could never take.
1. DETECT (cheap): free-slot count from the existing inventory read (getInventory — the map-device fill flow
   already reads it). Cache 5s. `invFreeSlots()`.
2. PICKIT: when free slots == 0 and the item is not stackable-into-an-existing-stack (currency with a
   non-full stack still fits): log ONE line `[Pickit] inventory FULL -> holding pickup of <item>` (10s
   throttle), do NOT burn reachability retries/blacklists on it (the item stays wanted; nothing bans).
3. STASH DUMP between maps (mapper.js hideout flow): in HIDEOUT, before the next map-device cycle, if free
   slots < INV_MIN_FREE (=10): force-load the dump stash tab (op 0x00E6 — proven), then move loot to stash
   with the proven into-stash packet (0x0100) item by item: everything EXCEPT waystones (id14 holder feeds
   the device), tablets (id77), and the currency the device flow needs. Throttle sends (~150ms), verify by
   re-reading the inventory, bounded 60s + a per-item retry cap. Log a summary: `[Stash] dumped N items
   (M free now)`. Flag `INV_STASH_DUMP_ON = true`. If the stash read/move fails (packet drift), log + skip
   — NEVER wedge the map loop on a stash failure.
4. MID-MAP: no mid-map stash trips (portal churn risks the map); full-inventory mid-map = hold pickups (2)
   and finish the map — the hideout dump catches it before the next one.

## C. CHECKPOINT "REACHED" IS EUCLIDEAN — fired on the wrong side of a chasm (mapper.js)
Live (HiddenGrotto 15:28): checkpoint entity at (1223,754) -> 8s of walking -> `Boss entry reached
(checkpoint) gate=checkpoint-confirmed -> switching to melee engagement` — but the char was euclidean-close
on the WRONG SIDE of the chasm (the route crosses a bridge; user: "didn't walk through bridge"); the melee
approach then had no crossing. The reached-gate (grep 'checkpoint-confirmed') is distance-only, route-blind
— today's recurring straight-line lie.
FIX (flag `CKPT_ROUTE_ARRIVAL_ON = true`): the checkpoint-reached verdict requires distance <= threshold
AND route-verified adjacency: poe2.isWithinLineOfSight(player, ckpt) at close range, OR
poe2.radarFindPath(player -> ckpt) whose end lands <=15u from it with route LENGTH <= ~2x euclidean (a 3x
route = you are NOT there). Fail -> keep the checkpoint walk (the radar route already knows the bridge).
Log the deferral once: `[Ckpt] euclid-close but route-far (route Nu vs Nu) -> keep walking`.

## D. ROLL-INTO-WALL: 3 rolls into an invisible arena edge at the boss fight start (auto_dodge_core.js)
User: "rolled back into invisible wall at start of boss fight 3 times, if he smashed us there we'd be dead."
Invisible arena boundaries are NOT in the walkable grid, so a destination pre-check can't fully catch this.
FIX (flag `ROLL_WALL_FEEDBACK_ON = true`), two layers:
1. PRE: score roll bearings by destination validity — isWalkable at the landing cell AND (when the arena
   shell is computed) landing INSIDE the shell disc; a bearing failing either is heavily down-scored (not
   forbidden — sometimes every option is bad).
2. POST (the honest signal): measure actual displacement ~400ms after each roll. Displacement < ~40% of the
   roll's expected distance = the bearing hit a wall -> BAN that bearing sector (+-45deg) for this fight for
   20s and log `[AutoDodge] roll bearing N blocked (moved Nu) -> sector banned 20s`. The next roll picks
   from the remaining sectors. Three identical blocked rolls (the live case) becomes: blocked once, banned,
   next roll goes elsewhere.

## Hard limits
- A: cadence cap ONLY — no changes to promote-on-hit arming, standoff, or the telegraph DB. B: reuse the
  PROVEN packets/reads (0x00E6 force-load, 0x0100 into-stash, getInventory) — NO new RE, NO reposition/swap
  (that's a proven dead end), NO selling. C: the arrival TEST only — no changes to checkpoint selection or
  the melee approach itself. D: bearing scoring/ban only — the roll TRIGGERS (telegraph/panic/catchall)
  are untouched. All flags off = today byte-parity. node --check all three. TEST BEFORE COMMIT.

## Acceptance
- A boss fight with dead anim reads: rolls at most every ~4s from the catchall (panic/telegraph-DB rolls
  unaffected); no roll-per-hit storms.
- Full inventory: pickit says so once and stops churning; in hideout the bag is dumped to stash (waystones/
  tablets kept) and the next map starts with >= INV_MIN_FREE slots; a stash failure skips gracefully.
- A chasm-side checkpoint: no melee switch until the bridge is actually crossed (the deferral log appears,
  the walk continues over the bridge, THEN the switch fires).
- Boss-fight rolls: a blocked roll bans its sector (log line) and the NEXT roll visibly goes a different
  way — never 3 consecutive rolls into the same invisible wall.

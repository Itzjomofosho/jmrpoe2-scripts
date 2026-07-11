# TASK-06 REPORT — Openable done-detection (investigate-then-fix)

**Verdict on the brief's hypothesis: FALSE as stated.** A used shrine does NOT keep reading as an open
candidate. The game retires it cleanly and both candidate scanners already drop it. The real defect is that the
**utility SESSION never re-reads its committed target**, so after the shrine is consumed the mapper keeps
walking at / dwelling on a dead object until a timeout or a no-progress ban fires. That is the user's
"tries it, then TIMES OUT and moves, instead of 'oh I got the shrine, I'll keep going'".

Ground truth was obtained **live** via the bridge on `MapEpitaph`, with the user standing at an Enduring Shrine
and using it on request (opener disabled, so the flip is attributable to the use, not to our opener).

---

## Live measurement (the decisive evidence)

Same entity (`id=481`, `address=0x2d2dd035b80`) before and after the user clicked it:

| field | UNUSED | USED |
|---|---|---|
| `isTargetable` | `true` | **`false`** |
| `isObjectiveDone(address)` | `false` | **`true`** |
| `chestIsOpened` | absent | absent |
| entities matching `/shrine/i` in area | 1 | 1 (no phantom/effect entity spawned) |

Entity path `Metadata/Shrines/Shrine`, render `Enduring Shrine`, `baseEntityPath
Metadata/Shrines/CultureShrines/Badlands_shrine.ao`. `dumpEntityComponents` shows a dedicated **`Shrine`**
component plus `Targetable`, whose `+0x68` qword reads `…0101 00` (i.e. `+0x69 = 1` while unused).

**So the game-side "used" signal exists, is reliable, and is already exposed to JS today with no new C++:
`isTargetable === false` (Targetable `+0x69 → 0`).** `poe2.isObjectiveDone(entity.address)` reads the same byte
and also flipped. No used-registry is needed — the brief's fallback plan is moot.

Two further live facts that shaped the fix:
- **880 of 1145** entities in a live area have **no Targetable component at all**, so `isTargetable` serializes
  as `undefined` (poe2_wrap.cc only sets it under `if (entity.components.hasTargetable)`).
- Entities **de-stream when far** (the shrine vanished from `getAllEntities` once the user walked off), so
  "absent from the scan" must never be read as "consumed", and **entity ids can recycle on re-stream**.

---

## Answers to the brief's questions 1–4

**1. How does the utility openable scan decide a shrine is already USED?**
Two independent sources feed `getOpenableUtilityCandidates`:
- the opener feed, `getOpenableCandidatesForMapper` → `collectOpenTargets(...)`, whose Shrine bucket gates on
  `if (entity.isTargetable !== true) continue;` — **correct**, drops a used shrine.
- a second, in-mapper **fallback shrine scanner** (`source:'shrine_fallback'`), which gated on
  `if (e.isTargetable === false) continue;` — this drops a *used* shrine (it reads `false`) but **passes every
  entity that has no Targetable component at all** (`undefined`). Those can never be interacted with by the
  opener, so any `/shrine/i`-named effect/projectile/doodad that slipped the ad-hoc
  `effect|vfx|decal|projectil|daemon` substring list became a permanently unservicable walk target. Latent, and
  the same class as the `ShrineEyeOfWinterProj` bug the code already comments on. **Fixed.**

**2. Opener side: what stops it re-targeting the same shrine, and does it publish "serviced" back?**
Nothing needs to stop it: the used shrine leaves `collectOpenTargets` on the very next scan because
`isTargetable !== true`. `markOpenAttempt`/`openBlacklist` is the backstop for targets that *don't* go away.
It publishes **nothing** target-specific back to the mapper (only `POE2Cache.lastEssenceOpen`, for the dodge).

The mapper's only "serviced" signal is `utilityLastServicedAt`, stamped on movement-locked frames. **But the
arrival dwell tried to read the lock directly** — `const lock = POE2Cache.isMovementLocked()` — and
`processMapper()` does `return;` on *any* locked frame (mapper.js, the `if (moveLock.locked)` block) before
`runUtilityNavigationStep` is ever called (single call site). So `gotYield` was **provably dead**:
`utilityYieldCount` could never leave 0, every target ended `handled:arrived` (45 s) instead of
`handled:opener` (10 min), and the essence `minTouches = 3` path was unreachable. The session-timeout branch
50 lines below had already been migrated to the `utilityLastServicedAt` recency signal for exactly this reason,
with a comment saying so; the dwell had not. **Fixed.**

**3. Ban KEY stability.**
Confirmed mismatch. `opener.getOpenKey` is deliberately `o:<name>:<floorX>:<floorY>` ("survives entity-id slab
recycle"). `mapper.getUtilityTargetKey` was **id-first**: `` `${type}:id:${id}` ``. Since entities de-stream and
re-stream with fresh ids (measured above), a shrine banned once could return under a new id and be re-offered.
**Fixed for openables** (static objects → position+name); loot keeps the id key (transient, stacks share cells).

Separately, the fallback scanner **never consulted the opener's hard ban** at all, so a shrine the opener had
given up on after 3 attempts was still offered as a walk target forever. **Fixed.**

**4. Live probe.** Done — see the table above. This is what refuted the hypothesis.

---

## Files touched

### `opener.js`
- **added** `isOpenTargetHardBanned(entity)` — position-keyed hard-ban predicate (reuses `getOpenKey`).
- **added** to the export list: `isOpenTargetHardBanned`.

### `mapper.js`
- **import** — added `isOpenTargetHardBanned` from `./opener.js`.
- **`getUtilityTargetKey`** — openables now key by `openable:o:<name>:<floorX>:<floorY>` (position+name, the
  opener's convention) instead of entity id. Loot unchanged.
- **`getOpenableUtilityCandidates`** (fallback shrine scanner) — gate changed `isTargetable === false` →
  `isTargetable !== true` (matches the opener exactly), plus `isOpenTargetHardBanned(e)` skip.
- **`utilityOpenableConsumed(target, dist, now)`** — NEW. Shrine-only, 400 ms throttled, reads the shared
  `POE2Cache.getEntities` cache (adds no scan of its own). Returns true only when the target entity is **found**
  and reads `isTargetable === false || chestIsOpened === true`. Not-found ⇒ **unknown/false**.
- **`runUtilityNavigationStep`** — early exit right after `dist` is computed: a consumed openable is retired
  with `addIgnoredUtilityTarget(..., 'handled:consumed', 600000)` + `finishUtilityState()`.
- **`runUtilityNavigationStep`** arrival dwell — `gotYield` now watches the `utilityLastServicedAt` watermark
  via the new `utilityYieldSeenAt` (seeded at dwell start) instead of the dead live-lock read. The now-unused
  `const lock` was removed; the `handled:` label falls back to `isOpenable ? 'opener' : 'pickit'` as before.

**Settings added: none.** This is a correctness fix; there is no new flag, so flag-off parity is N/A (as the
brief states). No C++, no packets, no memory writes, no new scans.

---

## Verification performed
- `node --check mapper.js` → OK. `node --check opener.js` → OK.
- Symbol greps: `isOpenTargetHardBanned` (2 in mapper, 2 in opener), `utilityYieldSeenAt` (4),
  `utilityOpenableConsumed` (2). No stray `lock.` references remain in the dwell block.
- `isMovementLocked()` now has exactly **one** live call site (the `processMapper` gate); both dead reads gone.
- The new predicate was replayed against live entities: a non-targetable entity → `consumed:true`;
  a targetable one → `consumed:false`; a de-streamed one → `found:false, consumed:false` (correctly unknown).

---

## LIVE-TEST CHECKLIST

Walk the bot into a shrine and let the opener take it.

**Working looks like:**
- `[Mapper] [M:<map>] Utility openable consumed (<Shrine name> at Nu) -> done, resuming <state>` fires within
  ~400 ms of the buff landing, and the bot **immediately resumes** exploring.
- Utility blacklist line: `Utility blacklist add (handled:consumed): <Shrine name>`.
- You should **no longer** see, for a shrine that was actually used:
  `Utility timeout after 12.0s`, `failed:timeout`, or
  `Utility openable unreachable (owned no-progress 5s at Nu) -> blacklist + skip`.

**Broken looks like:**
- The consumed line never appears but the buff landed → the entity fell outside the scan radius
  (`max(60, dist+25)`) or past the `getEntities` entity cap. It will still time out as before (no regression),
  but tell me the distance in the log line.
- The consumed line fires on a shrine the bot never used → the scan matched the wrong entity. Would need the
  shrine's id/pos.
- `handled:opener` (10 min) now appearing where `handled:arrived` (45 s) used to → **expected**, see risk 1.

Also watch, for the ban-key change: a shrine banned `failed:no-net-progress` far away should stay banned when
re-approached from another angle later in the map (previously it could return under a new entity id).

---

## Risks / deviations

1. **The `gotYield` revival is a real behavior change, and the one to watch.** Serviced targets now correctly
   ban for 10 min (`handled:opener`) instead of 45 s (`handled:arrived`), and the essence dwell's
   `minTouches = 3` becomes live for the first time (it was previously exiting on the 4 s `ceilingMs`). Both are
   the *intended* semantics, but neither has ever actually run. Essence exits stay bounded by `ceilingMs`, so
   the worst case is unchanged. Easy to revert in isolation (it is one `const gotYield = …` line plus the
   watermark) if the combined test shows essence/strongbox dwell regressions.
2. **Scope.** The brief scoped items 1–4; item 2 explicitly asks whether the opener "publishes serviced back so
   the mapper marks `handled:*` rather than letting the session time out". That question is what surfaced the
   dead `gotYield`, so I fixed it. I did **not** build the per-map used-openables registry the brief offered as
   a fallback — the game signal exists and is reliable, so the registry would have been dead weight.
3. The consumed check is **shrine-only** on purpose. Chests/strongboxes/essences drop loot and their dwell owns
   the pickit settle window (`lootStillLeft`, the strongbox 28 s event hold, the 3 s drop-settle); an immediate
   consumed-exit there would walk away from drops. Widening it later must route through the dwell, not past it.

---

## Open questions for the planner

1. **The "3 attempts" the user describes is NOT explained by anything I fixed, and I could not reproduce it.**
   A shrine consumed on click #1 leaves `collectOpenTargets` immediately, so 3 attempts means the clicks were
   not landing. My leading theory (UNVERIFIED, do not build on it): the arrival dwell calls
   `sendStopMovementLimited()` at `dist <= 20`, which cancels the game-side auto-walk that `sendOpenPacket`
   initiates, so the interact never reaches range; the opener re-fires at its 2.5 s retry delay, hits
   `OPEN_MAX_ATTEMPTS = 3`, and hard-bans the shrine — with the player frozen ~7 s by the 3× 2 s movement locks
   ("SAT THERE"). Confirming this needs one live trace with opener ON: watch for three
   `[Opener] Opened Shrine: …` lines followed by `[Opener] Blacklisted Shrine: … after 3 attempts`. If that is
   real, the fix is opener-side (don't fire beyond the shrine's true interact range) and is a separate task.
2. **`Metadata/Shrines/Shrine` is a permanent phantom hostile monster, and I did not touch it.** Live read of
   the *used* shrine: `entityType: 'Monster'`, `entitySubtype: 'MonsterNormal'`, `isAlive: true`,
   `healthCurrent/Max: 100/100`, `isHostile: true`, `reaction: 2`, `hiddenFromPlayer: false`,
   `isTargetable: false` — forever, because it can never be killed. `isHostileAlive()` does **not** check
   `isTargetable`, so it returns **true** for it. In a live map I counted **2** such phantoms passing
   `isHostileAlive`: the used shrine and a `MonsterMods/ProximalTangibility@80` mod-aura daemon (6 real
   monsters passed alongside).
   The mob-chase latch and `pickExploreMobTarget` already guard with `!e.isTargetable`, so they are safe. The
   consumers that do **not** are: the utility combat-freeze `_utFrzNearVal` (freezes the session clocks for up
   to 20 s whenever a utility target is within 45 u of a used shrine), `countHostilesNear`, `findNearestHostile`,
   `getFightMonsterSnapshot`'s `alive` filter, and the `_packN` step-out-of-pack centroid.
   This is a plausible contributor to "churned in place near the shrine" and is **out of TASK-06's scope**.
   Two candidate fixes, planner's call: (a) narrow — exclude `Metadata/Shrines/` in `isHostileAlive`; (b) broad —
   require `isTargetable !== false` in `isHostileAlive`, which also kills the `ProximalTangibility` phantom but
   risks dropping real monsters that are briefly non-targetable (burrowed / emerging / spawn-invulnerable).
   I recommend (a) now and (b) only behind a flag with a live count of what it removes.

Not started: TASK-03. Nothing committed; runtime dir only.

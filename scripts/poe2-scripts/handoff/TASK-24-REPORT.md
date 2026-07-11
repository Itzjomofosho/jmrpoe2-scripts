# TASK-24 REPORT — Phantom projectile rolls + hv-sidestep vs REQUIRED-abyss contention

Status: **implemented, syntax-clean, UNTESTED in game** (awaiting user live-test per TEST-BEFORE-COMMIT).
Pre-snapshot: `handoff/pre/TASK-24/{auto_dodge_core.js,mapper.js}` (byte-identical copies taken before any edit).
Files edited: `auto_dodge_core.js`, `mapper.js` (runtime dir only). No C++, no packets, no memory writes, no OB-ladder edits.

---

## A. Phantom projectile lanes — `auto_dodge_core.js`

**Root cause (confirmed against the code):** in `collectHazardsAndEnemies`, the projectile branch's FIRST-SIGHT
rotation fallback (`if (speed < 50 && typeof e.rotationZ === 'number')`) fabricates an 800-speed lane along a
stationary `shot/arrow`-named entity's `rotationZ` before two velocity samples exist. Any stationary shot-named
entity that streams in facing the player (spent/stuck projectiles, own non-tornado deployables, arrow-named ground
scenery) = one phantom collision course → one roll, with no shooter present.

**Fix — a projectile needs a SHOOTER.** The rotation fallback now only fires when there was ≥1 live hostile near the
**player** on the PREVIOUS scan pass (`_prevPassHostileNear >= 1`). Measured-velocity projectiles are untouched — a
real off-screen spear has velocity by sample 2, and sample 1 of a real volley has a live hostile near the player
(they're shooting *at us*); the fabrication window is one scan wide anyway.

- **Cheaper-of check chosen: near the PLAYER**, not the entity. The `enemies[]` array is already player-proximity
  filtered, so the count is free; and "no hostile near me" is exactly the phantom signature the user watched
  (25/36 rolls, no hostiles near). PREVIOUS pass because same-pass ordering leaves the current `enemies[]`
  incomplete when the projectile branch runs.
- Cache is computed once at the end of the pass (loop over the already-built `enemies[]`, no new scan) and gated on
  the flag so **flag-off adds no work**.
- `PROJ_SHOOTER_RANGE_GRID = 120` (→ world² `PROJ_SHOOTER_RANGE_SQ`). Note the existing enemy-collection radius is
  `(estimatedRollDist*2+20)=112` grid, so today every collected enemy is inside 120 grid — the count is effectively
  "any hostile near the player last pass"; the explicit 120-grid filter keeps that true if `estimatedRollDist` grows.

**Symbols added:** `PROJ_FALLBACK_NEEDS_SHOOTER` (const, `true`), `PROJ_SHOOTER_RANGE_GRID`, `PROJ_SHOOTER_RANGE_SQ`,
`_prevPassHostileNear` (module let). Gate edited: the rotation-fallback `if` (adds `&& (!PROJ_FALLBACK_NEEDS_SHOOTER
|| _prevPassHostileNear >= 1)`). Cache loop added just before `return { hazards: out, enemies }`.

**Flag-off parity:** `PROJ_FALLBACK_NEEDS_SHOOTER=false` → `!false` short-circuits the gate to today's condition, and
the cache block is skipped entirely. Byte-for-byte.

---

## B. Node-local service window — `mapper.js`

**Root cause:** the `_hvOpen` side-step (added 2026-07-11, correct vs OPTIONAL content) bypasses the loot-only
degradation for a close essence/strongbox. Against a **REQUIRED** abyss runner mid-drive, that bypass let the
utility SELECT + start a walk to the box while the runner also held the frame → two writers → `Utility select (Large
Strongbox) d=66` ↔ `[OB] deny … vs content:abyss:1048 pri=2` box↔abyss yoyo (~32s).

**Fix — a per-node rhythm with a formal tidy-up gap. Consumer-side defer only (no OB-ladder change).**

1. **MID-DRIVE DEFER (part 1, in `tryStartUtilityNavigation`).** While a required abyss node is committed and the
   runner is walking to / clearing it, `abyssRequiredMidDrive(now)` is true. The `_hvOpen` predicate is split:
   `_hvRaw` (today's raw test) and `_hvOpen = !_hvDeferred && _hvRaw`. Deferred ⇒ `_hvOpen` is false everywhere ⇒
   the box is subject to the normal degradation: in the loot-only pass it is not added to candidates (logged once);
   in a full pass it falls to the existing "objective wins" / far-drive caps → skipped. The box **stays offered**
   (nothing bans it) and is picked up in the tidy-up gap. **The active-target RESUME keeps `_hvRaw`** so an
   already-committed hv walk is never stolen mid-flight (commitment discipline) — a *new* hv walk simply can't start
   during mid-drive.
   - Log (throttled 3s): `[Utility] hv side-step deferred: required content:abyss:<id> mid-drive`.

2. **TIDY-UP WINDOW (part 2, in `runAbyssRun`).** At the clean loot-dwell advance point (`node … cleared + held +
   looted -> next`), before committing the next node, `abyssTidyHold` HOLDS (stops at the node, does not advance)
   while an hv openable (essence/strongbox) or an unopened chest sits within `NODE_TIDY_RADIUS = 90` of the finished
   node. During the hold the runner is NOT mid-drive, so the utility/opener machinery (which runs first each frame)
   services the box/essence cleanly. Bounded by `NODE_TIDY_BUDGET_MS = 20000` of **owned** time — the clock freezes
   on dodge-held frames (`now >= dodgeMoveSuppressUntil`), the house idiom, so a dodge chain can't burn the budget.
   The "is anything local left?" probe rides the opener's cached feed (`getOpenableUtilityCandidates`) + the shared
   cache (`abyssChestNear`) — **no new entity scan**.

3. **CHEST PROBE (part 3).** Already present and unchanged: the loot-dwell branch holds `ABYSS_MIN_LOOT_MS = 5000`
   at the node the instant it flips gray (`Abyss: hold for chest N/5s`) so the reward chest can spawn; the opener
   takes it in range. The tidy-up window (2) sits *after* this 5s spawn-hold, so the chest gets its spawn window
   before any hv detour walks us off the node.

**Symbols added:** consts `HV_DEFER_REQUIRED_ON` (`true`), `NODE_TIDY_BUDGET_MS` (20000), `NODE_TIDY_RADIUS` (90);
module lets `abyssTidyOwnedMs`, `abyssTidyAt`, `abyssTidyNodeId`; functions `abyssTidyReset`,
`abyssRequiredMidDrive`, `abyssHvOrChestNear`, `abyssTidyHold`. Utility-nav: `_hvRaw` (was `_hvOpen`), `_hvDeferred`,
`_hvOpen` redefined as the defer-gated form; resume-line switched to `_hvRaw`; loot-only hv-add now logs on defer.
Tidy-up hold inserted at the loot-dwell advance; `abyssTidyReset()` on clean advance + new-node commit.

**Flag-off parity:** `HV_DEFER_REQUIRED_ON=false` → `abyssRequiredMidDrive` returns false → `_hvDeferred=false` →
`_hvOpen === _hvRaw` (identical to today's predicate) at every use site incl. the resume line; the loot-only add
takes its original `else` branch; the tidy-up hold is short-circuited (`HV_DEFER_REQUIRED_ON && …`). The two added
`abyssTidyReset()` calls are provably no-ops when the flag is off (nothing ever writes the tidy vars). Byte-parity.

---

## Settings / kill-switches added

| Const | File | Default | Off = |
|---|---|---|---|
| `PROJ_FALLBACK_NEEDS_SHOOTER` | auto_dodge_core.js | `true` | rotation-fallback fabricates always (today) |
| `HV_DEFER_REQUIRED_ON` | mapper.js | `true` | no mid-drive defer + no tidy-up hold (today's side-step) |

No user-facing `currentSettings` toggles — both are code-level kill-switches per the brief.

---

## LIVE-TEST CHECKLIST

**A — quiet map segment, no hostiles, loot/deployables streaming:**
- WORKING: **zero** `[Dodge]` rolls with `why=projectile-path` while no hostile is near the player (own arrows,
  tornado deployables, spent/arrow-named ground objects streaming in produce no roll).
- WORKING: a real ranged pack still gets dodged — measured-velocity projectiles roll exactly as before
  (`why=projectile-path` fires when there IS a live hostile near you / the projectile has real velocity).
- BROKEN: rolls on `projectile-path` in an empty area (phantom still firing) → check `_prevPassHostileNear` /
  the 120-grid range vs `estimatedRollDist`. Or: a real off-screen volley's *first* arrow no longer rolls with no
  visible shooter (over-suppression) — acceptable per brief (bounded one-scan window; sample 2 has velocity).

**B — strongbox/essence ≤120u DURING a REQUIRED abyss node:**
- WORKING: exactly ONE `[Utility] hv side-step deferred: required content:abyss:<id> mid-drive` line while the
  runner drives/clears — NO `Utility select (Large Strongbox)` and NO `[OB] deny … vs content:abyss` churn during
  mid-drive (the box↔abyss yoyo is gone).
- WORKING: after the node clears you should see `Abyss: hold for chest N/5s` (chest probe), then
  `Abyss: tidy-up node <id> (n/20s)` while the box/essence is serviced, then the normal `[Abyss] node <id>
  cleared + held … + looted -> next`, then advance to the next node.
- WORKING (optional abyss / no commitment): NO defer log, NO tidy-up line — the essence/strongbox is serviced
  mid-drive exactly as today (proven path unchanged).
- BROKEN: box↔abyss still yoyos (defer not taking) → confirm `isRequiredType('abyss')` is true this map and
  `abyssId` is set during the drive. Or: the runner never advances after a node (tidy-up stuck) → check the 20s
  owned budget is accruing (it freezes only during dodges) and that `abyssHvOrChestNear` eventually reads false.

**Grep markers:** `hv side-step deferred`, `Abyss: tidy-up`, `Abyss: hold for chest`, `why=projectile-path`.

---

## Risks / deviations

- **Order of tidy-up (2) vs chest-probe (3).** The user's verbatim order was "service essences → then wait 5s for
  chest". The chest-spawn mechanic (moving off the node can suppress the spawn) forces the 5s spawn-hold to run
  FIRST; the hv service runs in the tidy-up gap after it. Same end state (both chest and box done at the node before
  advancing), reordered only to protect the spawn.
- **Hard-cap / already-done advance paths get no tidy-up.** The 45s `ABYSS_DWELL_MS` "closed off" cap and the
  top-of-loop already-gray re-pick advance directly (no loot-dwell) — deliberately not held, so a genuinely stuck
  node is never pinned longer. Tidy-up applies only to the clean "cleared + looted" completion.
- **Drift during hv service.** If servicing an hv target walks the player >130u from the node, the existing
  loot-dwell range guard quiet-resets the abyss commitment (node already blacklisted) — tidy-up simply ends early
  and normal utility/explore continues (no yoyo, no stuck). A rare drift may leave the node un-`abyssMarkLooted`,
  so the MAP_COMPLETE chest-sweep double-checks it (idempotent probe-and-retire).
- **`_hvOpen` cap-site behavior when deferred.** The four cap-exemption sites now see `_hvOpen=false` during
  mid-drive, so a close box is deferred via the existing "objective wins" (live abyss within 600u) gate — i.e. the
  exact pre-`_hvOpen`-fix behavior, restored only while a required abyss is mid-drive.
- Perf: `abyssRequiredMidDrive` only calls `isRequiredType` (1.5s-cached) when a node is committed; the tidy probe
  reuses cached feeds. No unthrottled scans added.

## Open questions
None blocking. If the reviewer prefers the shooter-proximity keyed to the projectile entity rather than the player,
it's a one-line swap (cache per-projectile would need positions, not a count) — flagged the player choice above.

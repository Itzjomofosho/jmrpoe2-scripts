# TASK-32B REPORT — Vastweld addendum (H fresh-boss entry-mobile + I ranged standoff & cast-gap diag + J unique path-gate)

Status: IMPLEMENTED, runtime-only, UNCOMMITTED. `node --check` passes on both edited files. Awaiting user live-test.

This is a **follow-up mini-task on top of the already-shipped TASK-32** (A/B/C/D are live in the runtime files).
TASK-32B adds items **H, I, J** from `TASK-32-ADDENDUM-vastweld.md` and **verifies K** (no reimplementation).

Pre-snapshot (FIRST ACT, before any edit): `handoff/pre/TASK-32B/{mapper.js, entity_actions.js}` — md5-verified identical
to the runtime files at snapshot time. This is the diff base for these two files (they already carried TASK-32 A/B/C/D).
`auto_dodge_core.js` is NOT touched by H/I/J, so it was not snapshotted (per the user's explicit two-file instruction and
the addendum hard-limit "same three files … H/I must not fight the dodge").

---

## Settings / consts added (all default-ON; each flips its own feature; OFF = byte-parity to the TASK-32 baseline)

| Const | File | Default | Item | OFF behavior |
|---|---|---|---|---|
| `BOSS_ENTRY_MOBILE_ON` | mapper.js | `true` | H | no entry window; FIGHTING_BOSS movement byte-identical to TASK-32 |
| `BOSS_ENTRY_MOBILE_MS` | mapper.js | `5000` | H | (window length) |
| `BOSS_STANDOFF_ON` | mapper.js | `true` | I | `kiteBossOn()`/`kiteStandoff()` read the user setting only (kiteBoss stays opt-in/OFF) |
| `BOSS_STANDOFF_U` | mapper.js | `60` | I | (forced standoff band) |
| `BOSS_CASTGAP_DIAG_ON` | entity_actions.js | `true` | I (diag) | silent (was pure logging anyway) |
| `UNIQUE_ENGAGE_PATH_GATE_ON` | mapper.js | `true` | J | uniques stay eligible on euclidean distance alone (TASK-31 C behavior) |
| `UNIQUE_ENGAGE_PATH_MAX` | mapper.js | `250` | J | (max BFS path length, grid units) |
| `UNIQUE_PATH_RECHECK_MS` | mapper.js | `2000` | J | (per-unique BFS re-probe throttle) |
| `UNIQUE_NOPROG_MS` | mapper.js | `4000` | J | (no-progress bail window) |
| `UNIQUE_BAIL_BLACKLIST_MS` | mapper.js | `60000` | J | (bail blacklist span) |
| `UNIQUE_PROG_EPS` | mapper.js | `6` | J | (grid units of net closing = "progress") |

---

## Files touched — functions / symbols added or modified

### `mapper.js`

**H — fresh-boss entry-mobile posture** (`case STATE.FIGHTING_BOSS`)
- Consts/state near `BOSSFIGHT_DIAG_ON`: `BOSS_ENTRY_MOBILE_ON`, `BOSS_ENTRY_MOBILE_MS`; arc state `_beWpX/_beWpY/_beWpAt`, stall-watch `_beStallPX/_beStallPY/_beStallAt`.
- New branch inserted **immediately after the shipped C evasive-arc block** (so press-in and the C unhittable-evade
  both still `break` first) and **before** the KITE_FLOOR/orbit-settle: while `(now - bossFightEngagedAt) < BOSS_ENTRY_MOBILE_MS`,
  strafe a perpendicular arc via `pickLargeOrbitWaypoint` + `stepFightDirectMove` (fallback `sendMoveAngleLimited`
  perpendicular nudge), re-picking on arrival / >1s staleness, reversing `bossOrbitDir` on a wedge stall, and `break`s
  the tick — **never plants**. Status: `[BossFight] entry-mobile arc <d>u (<t>s)`. It is a near-verbatim mirror of the
  C arc but time-gated (not unhittable-gated), with its own state so it can't disturb C.
- `resetMapper`: clears the six `_be*` fields per map (next to the TASK-32 C reset).

**I — ranged standoff (reuse the kiteBoss loop, don't duplicate)** (`kiteBossOn`, `kiteStandoff`)
- Consts `BOSS_STANDOFF_ON`, `BOSS_STANDOFF_U` next to `KITE_STANDOFF_DEFAULT`.
- `kiteBossOn()` now returns `BOSS_STANDOFF_ON || currentSettings.kiteBoss === true` — this **forces** the existing
  ranged-kite standoff loop on for the bow build profile.
- `kiteStandoff()` returns `BOSS_STANDOFF_U` (60) when forced by the profile, **unless** the user explicitly opted into
  `kiteBoss` (their `bossKiteRange` always wins). This flows through the two approach engage-ranges (`engageFightDist`,
  `engageRange`) and the fight `KITE_FLOOR` — the same single source the melee-entry and the fight already share. Net
  effect: the boss fight holds ~60u (bow range) instead of walking to 29–32u and parking in slam range; if the entry
  left us inside the floor, the existing radial-retreat backs us out to it. The `!selected` arena-walk-in branch (the
  "boss not yet resolved/targetable" case) is untouched, so activation still walks in as today.

**I (diag) — cast-gap gate reason:** see entity_actions.js.

**J — unique engage must be PATH-gated** (`nearestRareToClear`, `runClearNearbyRares`, new `uniqueEngagePathOk`)
- Consts/state near `UNIQUE_ENGAGE_R`: `UNIQUE_ENGAGE_PATH_GATE_ON`, `UNIQUE_ENGAGE_PATH_MAX`, `UNIQUE_PATH_RECHECK_MS`,
  `UNIQUE_NOPROG_MS`, `UNIQUE_BAIL_BLACKLIST_MS`, `UNIQUE_PROG_EPS`; maps `_uniquePathGate`, `_uniqueBailInfo`; tracker
  `_uEngId/_uEngBestD/_uEngBestAt`.
- `uniqueEngagePathOk(player, e, now)` — throttled (`UNIQUE_PATH_RECHECK_MS`) BFS reachability probe: `jsBfsPath` to the
  unique's `walkableApproachPoint`; eligible only if a path exists and its summed segment length ≤ `UNIQUE_ENGAGE_PATH_MAX`.
  Result cached per entity id (BFS is expensive: the throttle bounds it to ≤1 BFS / 2s / wide-unique).
- `nearestRareToClear`:
  - The accept test `if (d < cap && d < bestD)` now short-circuits a wide-band unique (`d > ROT_RARE_RANGE`) through
    `uniqueEngagePathOk` — placed **inside** the nearest-candidate test so BFS only ever runs for the entity that would
    actually win. Rares (`d ≤ ROT_RARE_RANGE`) never touch the gate.
  - The engage-blacklist check now early-**un**-blacklists a bailed unique (`_uniqueBailInfo`) the instant it is closer
    (`_dNow < bail.d - UNIQUE_PROG_EPS`, i.e. a corridor opened) or its hp dropped (`healthCurrent < bail.hp - 1`).
- `runClearNearbyRares`:
  - Early-bail: an engaged wide-band unique that makes no net closing for `UNIQUE_NOPROG_MS` (4s) is released +
    blacklisted `UNIQUE_BAIL_BLACKLIST_MS` (60s) — **before** the existing 12s cap burns — and its bail snapshot
    `{d, hp}` recorded. Log: `[Engage] unique <name> no progress <n>s at <d>u -> release + blacklist 60s`.
  - `_uEngId` is cleared when the target reaches rare range / switches to a rare / disappears (`!e`).
- `resetMapper`: clears `_uniquePathGate`, `_uniqueBailInfo`, `_uEngId/_uEngBestD/_uEngBestAt` per map (next to
  `rotRareBlacklist.clear()`).

### `entity_actions.js`

**I (diag) — cast-gap gate reason** (`processAutoAttack`)
- Consts near the ban state: `BOSS_CASTGAP_DIAG_ON`, throttle `_bossGapDiagAt`. TEMP (flagged for removal with the
  mapper D diag).
- New throttled (~2s) block **after the candidate-building loop, before target selection**: reuses `allEntities`
  (no new scan) to find the nearest in-range objective boss; if it exists and we are NOT already shooting it, it names
  the holding gate — `not-targetable(awake-gate)` / `cannotBeDamaged(immune-phase)` / `phasing-intro` /
  `aa-banned(hp-frozen)` / `invuln-gate(out-of-range-immunity)` / `LoF-blocked(wall/elevation)` / `skipped(other-gate)`.
  Exactly one LoF raycast fires, and only after the cheaper flag checks pass. Log:
  `[BossFight] cast-gap: boss <name> <d>u held (<reason>)`. Pure logging — changes no rotation behavior.
  (Only runs while auto-attack is ON — which is correct: it diagnoses why *casts* hold. The aa-OFF capture run is
  covered by the mapper D diag; see K.)

---

## K — verification only (already satisfied by the shipped TASK-32 D diag)

The addendum K constraint: the `[BossFight]` diag "MUST run whenever FIGHTING_BOSS is active regardless of auto-attack
state — do not gate it on the rotation/aa loop or on having a current attack target."

Verified in `mapper.js`:
- The D diag lives in `case STATE.FIGHTING_BOSS`, gated **only** on `BOSSFIGHT_DIAG_ON && trackedBossEntity && (now - _bfDiagLast > 250)`.
- `trackedBossEntity` is resolved from `allMonstersNearby = fightSnapshot.all`, where `fightSnapshot = getFightMonsterSnapshot(...)`
  is the **mapper's own** unconditional per-frame combat scan — it has no dependency on `entity_actions`' `autoAttackEnabled`
  or on a locked attack target.
- The diag's `dodge=` field reads the **dodge** toggle (`currentSettings.autoDodgeEnabled` / `dodgeMode`), not the
  auto-attack toggle.

⇒ The D diag already runs with mapper ON + auto-attack OFF (the planned capture run). No change required. **Not reimplemented.**

---

## LIVE-TEST CHECKLIST

### H — fresh-boss entry-mobile (no planting through the first slam)
- WORKING: the instant a boss fight starts, the status shows `[BossFight] entry-mobile arc <d>u (<t>s)` counting up to
  5.0s and the char is **visibly strafing** (not standing) while the rotation still fires bow casts. A Vastweld/Frostborn-class
  first slam lands on a moving char (survivable) instead of a planted one.
- BROKEN: char stands planted casting for the first ~2s of the fight (no `entry-mobile arc` status), OR the arc prevents
  a dormant/staged boss from activating (should not — press-in is checked first and still `break`s).

### I — ranged standoff (stop parking in slam range)
- WORKING: on boss approach, the char stops at ~60u once it has line-of-fire and enters the fight from there (status like
  `Kiting Boss… BACK OFF <d>->60u` and `wp=`), instead of closing to 29–32u and parking. If the boss chases inside 60u,
  the radial retreat backs it out. On an elevation/LoF map the char still routes up until LoF opens, then engages at ~60u
  (no more 9s park at 29u).
- BROKEN: the char still walks to <35u and stands, OR it refuses to ever close on a flat-ground boss that genuinely needs
  proximity activation (press-in should still drive in during dormancy — watch for `Press-in:` status).

### I (diag) — cast-gap reason
- WORKING: whenever a targetable objective boss is in range and the rotation is NOT shooting it, one throttled
  `[BossFight] cast-gap: boss <name> <d>u held (<reason>)` line names why. For the Vastweld 9s gap, expect a repeating
  `held (LoF-blocked(wall/elevation))` (or `not-targetable(awake-gate)`) — this is the reason the melee-entry parked with
  zero casts. No line appears while the boss is actually being shot.

### J — unique engage path-gate (windy-map yoyo)
- WORKING: a unique 63–200u away that is **maze-far / unpathable** (BFS > 250u or no path) is NOT committed — no
  `[Engage] unique … committing` for it, no walker grinding into a wall. If we do commit and then stall, expect
  `[Engage] unique <name> no progress 4s at <d>u -> release + blacklist 60s`, and it re-commits promptly once we've
  moved closer or exploration opened the corridor (or something chips its hp). A **reachable** unique ≤200u still commits
  as in TASK-31 C. Rares (≤62u) are unchanged.
- BROKEN: the walker still grinds against a wall toward a euclidean-close unique for 12s (path-gate not applied), OR a
  clearly-reachable unique is wrongly skipped (BFS budget too tight / approach-point unwalkable), OR the same unique
  re-commits every 2s with no progress (bail not firing).

---

## Risks / deviations / watch items

1. **I forces `kiteBoss` ON globally (sanctioned by the brief: "kiteBoss forced ON … reuse, don't duplicate").** This
   flips the whole boss profile from melee-entry (32u) to ranged-kite (60u). It is scoped to boss approach + boss fight
   only (`kiteBossOn()`/`kiteStandoff()` are referenced nowhere else). Flag off (`BOSS_STANDOFF_ON=false`) = exact
   pre-task behavior (kiteBoss reads the user setting, default false).
2. **`perpendicularDodge` intentionally left reading `currentSettings.kiteBoss` directly (line ~13756), NOT `kiteBossOn()`.**
   So the forced profile does NOT auto-enable the dodge's perpendicular sidesteps. Rationale: the hard limit says "H/I
   must not fight the dodge" — flipping a dodge-config field is exactly the kind of change to avoid here. The fight still
   kites at 60u; the dodge behaves as today. If the planner wants perpendicular dodge as part of the ranged profile, that's
   a one-line follow-up (`kiteBossOn()` there) — flagged, not done.
3. **H arcs at the fixed ~58u orbit band** (`pickLargeOrbitWaypoint`'s `clampFightRadius(58)`), which the C posture already
   uses and the brief accepted as "arc at engage range". With I's 60u standoff this is effectively "current range". If the
   fight is entered far (60–120u), the entry arc closes toward 58u while moving (never planting) — not into slam range.
4. **H re-arms if `bossFightEngagedAt` is reset mid-fight** (the live-boss re-acquisition paths set it to `now`). That gives
   a fresh 5s mobile window on re-engage, which is the desired behavior (re-engaging = a fresh entry). Not a regression.
5. **J BFS cost** is bounded by `UNIQUE_PATH_RECHECK_MS` (≤1 `jsBfsPath` per 2s per wide-band unique; wide-band uniques are
   typically 0–1 at a time). `jsBfsPath` searches a MARGIN=140 box capped at 14k cells. A unique whose route lies entirely
   outside that box (very rare) reads as unpathable → skipped until we're closer — acceptable (matches the intent).
6. **J hp-drop un-blacklist** uses `entity.healthCurrent` from the lightweight scan — confirmed present on lightweight
   monster entities via a live bridge read. Distance-shrink is the primary re-entry signal; hp-drop is the secondary.

## Open questions
- None blocking. The two review-worthy seams: (I) forcing `kiteBoss` on globally vs. the deliberately-unchanged
  `perpendicularDodge` line, and (J) the accept-gate placement of the BFS check inside the nearest-candidate test.

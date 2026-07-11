# TASK-22 REPORT — Commit-to-click via the movement-state bus + imprisoned-rare exclusion

Implementer session. Pre-snapshot: `handoff/pre/TASK-22/{mapper.js,opener.js}` (md5-verified copies taken before any
edit — both hashes matched the runtime files). `node --check` passes on both edited files. No commit (user live-tests
first). Files touched: **mapper.js, opener.js only** — nothing else (entity_actions.js untouched per the brief).

All three items shipped. The TASK-21 commit-to-click blocker (opener.js couldn't see the mapper's boss/dodge/walk
state) is resolved via the planner's chosen option (a): a one-way movement-state bus on `POE2Cache`, published
unconditionally + inert from the mapper (the `channelHold`/`lastEssenceOpen`/TASK-18 rotation precedent).

---

## A. Movement-state bus (mapper.js publishes; opener.js reads)

### `POE2Cache.mapperDrivingAt = <ts>` — stamped at the two active-move chokes
Stamped inside `sendMoveAngleLimited` and `sendMoveGridLimited`, on the exact `if (sent) …` line that already sets
`lastMovePacketTime`, i.e. **only when a real move packet went out**. These are the two low-level gated senders every
mapper walk funnels through: `moveTowardGridPos` (the documented "SINGLE choke point" for `stepPathWalker` + every
direct chase) sends via `sendMoveGridLimited`; `sendMoveAngleLimited` is the other active-move path. Publishing at
the choke means "the mapper drove movement this frame" is true for a live walk, an explore step, a rare chase, a
content-runner push, and a dodge egress alike.

- **The stop sender (`sendStopMovementLimited`) deliberately does NOT stamp** — a stop is the opposite of driving.
- **Not stamped:** `sendClickMoveLimited` (0xA3 click-to-move). It is dead code today (`CLICK_TO_MOVE_READY = false`)
  so it can never run; if that const is ever flipped true, add the same one-liner there. Flagged, not covered, by design.
- Write-only from the mapper; read-only in opener.js. Inert here.

### `POE2Cache.commitClickSafe = <bool>` — published once per in-map frame
Published in `processMapper`, **right after this frame's survival-dodge block closes** (just before the movement-lock
yield / 7Hz throttle). That point is reached every in-map frame regardless of the dodge branch, and it captures **this
frame's** dodge state. Exactly the brief's formula:

```
commitClickSafe = !(now < dodgeMoveSuppressUntil || (MB.hold.owner === 'dodge' && now - MB.hold.at < MB.WINDOW))
                  && currentState !== STATE.WALKING_TO_BOSS_MELEE
                  && currentState !== STATE.FIGHTING_BOSS
```

Unconditional + inert (opener.js is the only reader and it gates its own behaviour). **currentState reflects the end
of the previous frame's state machine** (my publish is before this frame's dispatch); the lag is one frame (~16ms) and
is benign because the excluded boss states persist for seconds and the walk-in transition (`FINDING_BOSS →
WALKING_TO_BOSS_MELEE`) happens while the boss is still far, so a one-frame-late `false` can never strand a commit
next to the boss. See Risks for the early-return staleness note.

---

## B. Opener: widened hold + commit-to-click (opener.js) — SHIPPED

### B.1 — hold widened to a live mapper walk
The TASK-21 hold triggered only on a foreign movement **lock**. The mapper registers no lock, so a plain mapper walk
was invisible to it — that is why the 45.3u/38.1u shrine whiffs happened. The hold condition is now:

```
held  ⇔  dist > OPEN_FAIR_RANGE(30)  AND  (foreignLock  OR  (now - (POE2Cache.mapperDrivingAt || 0) < 600))
foreignLock = movementLock.locked && movementLock.source !== 'opener'
```

Same placement (candidate loop, after the strongbox-guard skip, before the walkable-LoS gate). Essences/RuneRocks
never reach it (the essence lane `break`/`continue`s earlier); the abyss-chest 25u gate above is stricter and stays.

### B.2 — commit-to-click
Inside that widened hold branch, before the `continue` (hold), a held **non-essence** target commits when all hold:
- `dist <= OPEN_COMMIT_RANGE (50)`
- `POE2Cache.commitClickSafe === true` (mapper not dodging, not a boss walk-in/fight)
- `now - (openCommitAt.get(getOpenKey) || 0) >= OPEN_RETRY_DELAY_MS (2500)` — one commit per target per 2.5s

On commit: `target = t; _committing = true; break;` → the normal send path fires the interact, then:
- `requestMovementLock('opener', OPEN_COMMIT_MS=800)` instead of the usual 2000ms open-dwell — **the mapper's
  existing yield IS the stop** (it stops re-driving its walk; the interact's auto-walk carries the char in). The
  short lock releases fast so the mapper resumes if the walk-in didn't land; convergence relies on the next commit
  2.5s later, not on pinning the mapper. A commit that lands opens the target → it leaves the candidate list → no
  further commits.
- `openCommitAt.set(getOpenKey, now)` stamps the 2.5s gap (pruned >60s in `pruneOpenBlacklist`).
- `[Opener] commit-click <name> at <d>u` logs it.
- **Landing / free-retry accounting is unchanged**: a commit send has no fair window (dist > 30), so `markOpenAttempt`
  grants it a free (non-counting) retry for the first `OPEN_FREE_RETRIES(2)`, then charges toward the ban — 2 free + 3
  charged ≈ 5 commits over ~12.5s before a genuinely-unreachable target bans. No new stop packets, no MB bypass.

Commit is **gate-exempt on the walkable-LoS check** (it `break`s directly), like the essence lane — the interact's
auto-walk uses the game pathfinder, which routes around walls the JS straight-line gate would (wrongly) reject.

**Dodge steals freely:** the opener is registered before the mapper (main.js), so the mapper's survival dodge runs
*after* the opener every frame and always wins movement; and a live/recent dodge flips `commitClickSafe` false → no
new commit. A mid-commit dodge simply wins movement → the send doesn't land → free retry. Nothing opener-side needs to
stop the character.

**Gate:** both B.1 and B.2 live under `OPEN_UNFAIR_HOLD_ON` — one mechanism. Flag-off = the whole block is skipped =
byte-identical to pre-TASK-21 (far sends fire; no hold, no commit), the documented parity for that const.

### Updated send-decision table (non-essence, `OPEN_UNFAIR_HOLD_ON = true`)

| Target · distance | movement FREE (no lock, no mapper walk) | held: foreign lock OR mapper walking (<600ms) |
|---|---|---|
| `dist ≤ 30` (OPEN_FAIR_RANGE) | **SEND** (fair) | **SEND** (in-range always sends; not held) |
| `30 < dist ≤ 50` (OPEN_COMMIT_RANGE) | **SEND** (as today; post-send accounting unfair → free-retry) | **COMMIT** if `commitClickSafe` && 2.5s gap → send + 800ms opener lock + `commit-click` log; **else HOLD** |
| `dist > 50` | **SEND** (as today; free-retry accounting) | **HOLD** (no send; commit can't fire beyond 50u) |
| Abyss chest (`/abysschest/i`) | `dist ≤ 25` → SEND; `dist > 25` → **HELD by the existing 25u gate** (never reaches the new hold/commit) | same — the abyss gate is above and stricter |
| Essence / RuneRock | essence lane only (≤40u / RuneRock ≤20u), exempt from hold + commit | same |
| Strongbox w/ live guards | skipped by `strongboxGuardsNear` above the hold | same |

The only new column vs TASK-21 is the middle cell of the `30 < dist ≤ 50` row (COMMIT), and that the held column now
also fires on a live mapper walk (not just a foreign lock).

---

## C. Imprisoned-rare exclusion (mapper.js) — SHIPPED

`nearestRareToClear` (the single rare-engage candidate filter; the OB rare-claim path runs through it via
`runClearNearbyRares`) now skips a rare co-located with an un-opened essence crystal.

- New `unopenedEssenceMonoliths()` reads `POE2Cache.getSharedEntities()` — the **shared per-frame list** (lightweight
  + buffs, within `SHARED_RADIUS = 500`, built every frame by auto-attack/ESP and per-frame cached). **No new scan.**
  It collects entities that are `isTargetable === true`, name/renderName includes `monolith`, and are **not** a portal
  (MultiplexPortal lives under Monolith metadata) or a RuneRock/StoneCircle (terrain puzzle, no imprisoned rare).
- In `nearestRareToClear` the list is built **once** (before the candidate loop), then each rare/unique candidate that
  is within `IMPRISONED_RARE_R (12u)` of any such crystal is `continue`d — **no blacklist accrues** (it's deferred, not
  a fail). `SHARED_RADIUS(500)` comfortably covers `ROT_RARE_RANGE(62) + 12`.
- The essence side-step (`_hvOpen` / the utility walk to the crystal) opens the monolith → `isTargetable` flips false
  → the crystal drops out of the list → the (now-real) rare is engaged by the normal path next scan. entity_actions'
  hp-frozen 5s ban stays as the backstop (untouched).

Const `IMPRISONED_RARE_SKIP_ON = true`. Flag-off ⇒ `_essMonoliths` is `null` ⇒ the per-rare check short-circuits ⇒
byte-identical. When on but no crystals present (`_essMonoliths.length === 0`), the per-rare check also short-circuits
⇒ zero cost on normal maps.

---

## Settings / consts added

| Const | File | Default | Effect / flip |
|---|---|---|---|
| `OPEN_COMMIT_MS` | opener.js | `800` | movement-lock window a commit grants its auto-walk |
| `OPEN_COMMIT_RANGE` | opener.js | `50` | max distance to commit-walk a held target |
| `OPEN_UNFAIR_HOLD_ON` | opener.js | `true` (unchanged) | gates **both** the widened hold and commit-to-click; `false` ⇒ byte-parity |
| `IMPRISONED_RARE_SKIP_ON` | mapper.js | `true` | `false` ⇒ imprisoned-rare check is a no-op (byte-parity) |
| `IMPRISONED_RARE_R` | mapper.js | `12` | rare↔crystal co-location radius |

New `POE2Cache` fields (write-only mapper, read-only opener): `mapperDrivingAt` (ts), `commitClickSafe` (bool).
New state: `openCommitAt` Map (opener.js, per-target commit ts, pruned >60s).

---

## LIVE-TEST CHECKLIST

### B — widened hold + commit-to-click (the shrine-next-to-me repro)
- Walk the bot PAST a shrine/chest that ends up **30–50u** off the path while the mapper is walking somewhere else.
  - **Working:** `[Opener] commit-click <name> at 3x–4xu` fires, the mapper yields (~0.8s), the char steps in, and the
    open lands (`[Opener] Opened Shrine/Chest: … Dist: <smaller>`) on a target that previously whiffed at 45.3/38.1u.
  - Between commits (≤2.5s) there are **no** far `Opened … Dist 45.x` whiff lines — those are held now.
  - A target that's genuinely reachable converges (each commit + the mapper walk close the gap) and opens once ≤30u.
- **Broken:** far `Opened … Dist 40+` whiffs still print during a `Walking to …` frame (hold not engaging); OR a
  nearby shrine never opens even when the bot ends beside it (hold not releasing in-range — check the heartbeat
  `lock=` and that `commitClickSafe` is going true off-boss); OR `commit-click` lines firing faster than one / 2.5s
  per target (the openCommitAt gap broke).
- **Boss safety:** while `FIGHTING_BOSS` / `WALKING_TO_BOSS_MELEE`, **no** `commit-click` lines at all (commitClickSafe
  is false); a held shrine 30–50u off the boss must stay held. This is the exact case TASK-21 said must never re-fire.
- **Dodge safety:** a dodge during a commit → the roll wins movement, `commit-click` stops until the dodge clears; the
  un-landed send is a free retry (no ban burn).
- **Regression guard:** essences/RuneRocks open exactly as before; abyss chests still gated at 25u (no commit); a
  target ≤30u still opens immediately even while the mapper walks.

### C — imprisoned-rare exclusion
- On an essence map with a rare imprisoned in an un-opened monolith:
  - **Working:** the rare is **not** walk-engaged before its crystal opens — no `Engage Rare/Unique` status locked onto
    it and no entity_actions hp-frozen 3.5s waste on it while the monolith is still targetable. The bot instead
    services the essence (utility walk → `[Opener] Opened Essence: …`), then engages the freed rare normally.
  - **Broken:** the bot stops on the imprisoned rare (status `Engage …`) and burns the 12s cap / hp-frozen ban while
    the monolith is still un-opened.
- **Regression guard:** a normal (non-essence) rare within 62u is engaged exactly as before; RuneRock/StoneCircle maps
  are unaffected (excluded from the crystal list, and they have no imprisoned rare anyway).

### A — bus sanity (optional, if debugging B/C)
- `commitClickSafe` should read true during ordinary map-clear walks and flip false the instant a dodge fires or a
  boss state begins; `mapperDrivingAt` should be within ~600ms of `now` whenever the bot is actively walking and go
  stale when it parks/dwells (that is what lets a far send resume once the mapper stops).

---

## Risks / deviations

- **`commitClickSafe` staleness on mapper early-return frames** (master toggle off, hideout, death, non-map area):
  those frames return before the publish, so the last in-map value persists. This is inert in practice: on those
  frames `mapperDrivingAt` is also stale, so the only way to reach the hold/commit is a **foreign (pickit) lock**, and
  an in-flight pickit interaction holds `interactionClaim()` which makes the opener return at the top of
  `processAutoOpen` before any commit. Worst case is one bounded 800ms interact toward a nearby openable while the
  mapper is off — never a boss-safety issue (a boss fight keeps the mapper running ⇒ fresh `false`). Left as-is to
  match the brief's per-frame formula rather than editing every early-return site.
- **Commit bypasses the walkable-LoS gate** (deliberate, like the essence lane): a fully-walled openable within 50u
  will commit up to ~5 times (2 free + 3 charged over ~12.5s) before banning. Bounded by the existing accounting +
  the mapper's own no-progress watchdog; the shrine repro (unwalkable-cell shrines) isn't gated by that check anyway,
  so this only affects walled ground chests, where routing-around via the game pathfinder is the desired outcome.
- **Commit vs a co-located essence at 41–50u:** if an essence sits just past the opener's 40u essence-reach and a
  non-essence openable is also 41–50u, the non-essence may commit-walk briefly while the mapper walks the essence as a
  utility target. Both still get serviced (the mapper's essence commitment resumes after the 800ms lock); it's a minor
  oscillation in a rare co-location, not a stall. No commitment-discipline violation — the commit uses the same
  movement-lock-yield the opener already uses for every in-range open; it never rewrites the mapper's target.
- **`mapperDrivingAt` stamps on dodge-egress moves too** (forced sends). Intended: a far open can't land during a
  dodge either, so holding it is correct, and `commitClickSafe` is false during a dodge so no commit results.

## Open questions
None blocking. Item B's convergence cadence (800ms lock / 2.5s gap / 50u range) and item C's 12u radius are the
tunables to watch on the live retest; all are single consts.

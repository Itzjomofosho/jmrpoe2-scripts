# TASK-03 REPORT — Arena Shell: full mechanism, default 'shadow'

**Status: implemented, syntax-clean, not committed (runtime dir only).** The complete arena-shell mechanism ships
behind the 3-state setting `fightArenaShell: 'off' | 'shadow' | 'on'`, default `'shadow'`. `'off'` is byte-parity
(all helpers no-op, no compute, no logs); `'shadow'` computes + logs the would-clamp/would-penalize/would-shrink but
enforces nothing; `'on'` enforces via rungs 2-4 (rung-1 barrier ring stays log-only forever this task).

Bridge was UP during implementation (`pong Jun 15 2026`), but the player was mid-map in `MapTrenches`, **not at a
boss**, so no arena TGT tiles / barrier entities were streamed — the barrier regex is validated against the proven
`findBossArenaInterior` name set, not a live ring. Rung-1 ring/door geometry and rung-2 extent need a real boss fight
to validate; the shadow logs are built to surface exactly that (see LIVE-TEST CHECKLIST).

---

## Files touched

### `mapper.js`

**Setting**
- `DEFAULT_SETTINGS.fightArenaShell` — NEW, default `'shadow'`.

**New state globals** (beside `bossFightEngagedAt`)
- `arenaShell` — `{cx,cy,r,src}` or `null`. `conf` dropped per roadmap (no consumer branches on it).
- `arenaShellRefreshIdx`, `arenaShellNoGo` (rung-1 door discs, LOG-ONLY), `_arenaEngageX`/`_arenaEngageY`
  (engage-inside anchor), `_arenaShadowLogAt` (throttle).

**New functions** (all searchable)
- `arenaShellMode()` / `arenaShellEnforced()` — mode read + `=== 'on' && arenaShell !== null` gate.
- `arenaShellClear()` — nulls shell + refresh idx + no-go list + engage anchor.
- `arenaShadowLog(msg)` — `[ArenaShell] … (shadow)` throttled ≥2s.
- `fightPointInArena(gx, gy, margin=6)` — TRUE when shell null OR flag ≠ 'on' (the parity mechanism), else
  `hypot(pt,center) ≤ r-margin`. Door discs are LOG-ONLY, **not** enforced here.
- `clampToArenaShell(gx, gy, margin=10)` — radial projection onto `r-margin`; identity when not enforced.
- `clampFightRadius(r)` — caps a fight radius to `max(24, r-12)` when enforced; identity otherwise.
- `fightNudgeDeg(player, baseDist)` — shell-aware random stuck-nudge heading (deg).
- `arenaBarrierScan(cx, cy)` — rung-1: ONE `getAllEntities` read, returns `{pts,count,spanDeg,meanR,isRing,isDoor}`.
- `arenaShellCompute(player, now)` — center ladder + radius ladder + engage-inside invariant + the rung-1 log.
- `arenaShellTick(player, now)` — schedule driver (engage +0/+1s/+5s/+10s, then frozen); no-op when flag 'off'.
- `arenaShellLearnOnStall(player)` — micro-stall shrink ('on') / would-shrink log ('shadow').
- Consts: `ARENA_BARRIER_RX`, `ARENA_REFRESH_MS = [0,1000,5000,10000]`.

**Modified functions**
- `densestClusterCenter(points, radius)` — now also returns `extent` (max point-to-center distance of the cluster).
  x/y/size unchanged; additive field.
- `getBossArenaCentroid()` — threads `extent` through the cached centroid object (`{gx,gy,extent}`).
- `pickRadialRetreatWaypoint(...)` — pass-1 rejects out-of-shell candidates (`if (minClear && !fightPointInArena…)`);
  pass-2 (the desperate pass) still ignores the shell, per brief.
- `pickBehindBossWaypoint(...)` — radius `clampFightRadius`-capped; candidate gated with `&& fightPointInArena`.
- `pickLargeOrbitWaypoint(...)` — `BASE_RADIUS = clampFightRadius(58)`; main-loop candidate `if (!fightPointInArena) continue`.
  The tangential *fallback* (guaranteed keep-moving) is left unclamped (desperate, same class as pass-2).
- `pickWideOrbitWaypoint(...)` — `RADII.map(clampFightRadius)`; candidate `if (!fightPointInArena) continue`.
- `stepFightDirectMove(...)` — clamps its target via `clampToArenaShell` when `currentState === FIGHTING_BOSS`.
- `setState(...)` — clears the shell on **leaving** FIGHTING_BOSS (post-kill exit walk never clamped) and on
  **entering** FIGHTING_BOSS (fresh disc, before first compute).
- `resetMapper(...)` — `arenaShellClear()` beside the boss-arena-cache resets (per-map).
- FIGHTING_BOSS case — calls `arenaShellTick(player, now)` once at the top.
- KITE_FLOOR (fight-move) — `clampFightRadius(…)`-capped.
- Fight micro-stall (`moved < 2.0`) — calls `arenaShellLearnOnStall(player)`.
- Fight stuck-nudge (`moved < 2.5`, `distToTarget > 120` branch) — heading now `fightNudgeDeg(player, _nd)`.
- UI — a 3-state `ImGui.combo("Boss arena shell (off / shadow / on …)")` beside the kite-boss controls.

### `auto_dodge_core.js`

- `AUTO_DODGE_DEFAULTS` — added `arenaCX/arenaCY/arenaR: null`, `arenaEnforce: false`.
- `_arenaShadowLogAt` — module throttle var.
- `arenaShellPenalty(pgx, pgy, dx, dy, rollGrid)` — NEW. GRID-space penalty: outside `r-4` → +140; within 10u of
  the edge → graded +0..80; **0** when no shell published (parity).
- `chooseDodgeDirection(...)` — the term is added to **both** candidate blocks (8-dir + perpendicular): each stores
  `arenaPen` on the candidate and adds it to `score` **only when `CFG.arenaEnforce`**. The return path now captures
  the winner and, when a shell is published but **not** enforced ('shadow'), logs the winner's would-be penalty
  (throttled ≥2s). Selection order is otherwise byte-identical to before.

---

## Settings added

| name | default | what flips it |
|---|---|---|
| `fightArenaShell` | `'shadow'` | UI combo "Boss arena shell (off / shadow / on …)" beside the kite-boss controls; or edit the saved setting directly. |

`'off'` → helpers no-op, shell never computed, zero logs (byte parity). `'shadow'` → computed + logged, never
enforced. `'on'` → rungs 2-4 enforce; rung-1 barrier ring stays log-only.

---

## EXACT dodge-cfg publication field names + where nulled

Published (in the dodge section of `processMapper`, right after `const dodgeMode = …`, runs EVERY frame):

- `autoDodgeCfg.arenaCX`, `autoDodgeCfg.arenaCY`, `autoDodgeCfg.arenaR` — the shell disc.
- `autoDodgeCfg.arenaEnforce` — boolean; `true` only when `fightArenaShell === 'on'` and a shell exists. (Added
  beyond the three named fields because the dodge core needs to distinguish shadow-log from apply — the three
  position fields alone can't carry that.)

**Nulled** in the `else` branch of the same publish block whenever `dodgeMode !== 'boss'` **or** `arenaShell` is
absent: `arenaCX = arenaCY = arenaR = null; arenaEnforce = false`. This runs every frame (before the
`autoDodgeEnabled`/moveLock gates), so a rare-mode or non-boss dodge can never inherit the previous fight's disc.
With `fightArenaShell:'off'` the shell is always null → always the null branch → dodge scorer is byte-identical.

---

## Detection ladder (as implemented)

- **Center priority:** `getBossArenaCentroid` (TGT densest-cluster) → locked `bossArenaCacheX/Y` →
  `findBossArenaInterior` → tracked boss grid pos. First finite wins; if none, compute returns and retries next refresh.
- **Radius ladder:** rung-1 barrier-ring/door (**LOG-ONLY**, `arenaBarrierScan`) → rung-2 tgt-extent
  (`extent+8`, clamped `[60,170]`) → rung-3 ckpt-dist (`dist(center, bossCkptExitX/Y)`, ≥45) → rung-4 default `85`.
- **Invariant:** `r ≥ dist(center, engagePos) + 10`, engagePos captured at first compute; `src` suffixed `+eng`.
- **Learn-on-stall:** on the `moved < 2.0` micro-stall, if the active waypoint is radially outward of the player,
  `r = max(dist(player,center)+4, 45)`, `src='learned'` ('on') or a would-shrink log ('shadow').

**Perf:** the only `getAllEntities`-class read is `arenaBarrierScan`, called solely from `arenaShellCompute`, called
solely from `arenaShellTick` on the 4 scheduled refresh indices → **≤4 reads per fight**, never per frame. Everything
else is arithmetic on cached values.

---

## LIVE-TEST CHECKLIST (default 'shadow')

Run one boss map with the setting left at `shadow`. Watch the `[Mapper] [M:<map>]` console.

**Working looks like:**
- At boss engage (and again at ~+1s/+5s/+10s): one compute line each —
  `[ArenaShell] src=tgt-extent r=NN center=(X,Y) via=centroid` (src may be `ckpt-dist`/`default`, possibly `+eng`;
  via may be `arena-locked`/`interior`/`boss-pos`).
- If barrier entities stream: `[ArenaShell] rung1 barrier-ring r=NN pts=N span=NNdeg (log-only)` **or**
  `[ArenaShell] rung1 door-cluster discs=N span=NNdeg (log-only)`. (May never appear — barriers are optional.)
- During the fight, throttled would-have lines when picks approach the wall:
  - `[ArenaShell] dodge would-penalize dir=N p=NN (shadow)` (from `chooseDodgeDirection` on a roll that would land
    near/outside the edge),
  - `[ArenaShell] would-learn r=A->B (stall shrink) (shadow)` on a wall-hump micro-stall,
  - `[ArenaShell] nudge would-exit deg=D d=DD r=NN (shadow)` if a stuck-nudge heading would exit.
- **Behavior is identical to today** — the bot fights exactly as before; only the log lines are new. Compare the
  logged `r` against the visually observed invisible wall: `r` should be roughly the wall radius (a bit inside it).

**Broken looks like:**
- No `[ArenaShell] src=…` line ever at a boss → `arenaShellTick` isn't reaching compute, or every center source is
  unresolved (report the map). Not fatal (shell stays null → no enforcement).
- The fight visibly changes in `shadow` (different kiting/dodging) → a parity leak; capture the diff. Should be
  impossible (every enforce path gates on `arenaShellEnforced()`).
- `r` logged much larger than the visible wall → rung-2 extent over-reads; the invariant may be inflating it — note
  the `src` (a bare `+eng`/`default` r that's too big is the tell).

**Then flip to `on`** (UI combo) on a small-arena boss that previously wall-humped:
- `Fight kite stuck: flipped orbit direction` fires rarely/never; kite/orbit/dodge picks stay inside the wall;
  `[ArenaShell] learned r=NN (stall shrink)` may fire once and tighten the disc. Kill time no worse than baseline.

**Flip to `off`** to confirm rollback: zero `[ArenaShell]` lines, byte-parity fighting.

---

## Risks / deviations from the brief

1. **RoomArenaBlocker NOT added to the shared center-detection sets** (`BOSS_ROOM_OBJECT_PATTERNS`,
   `BOSS_ARENA_HINT_PATTERNS`, `findBossArenaInterior`'s `rxInt`). The roadmap step-2 SHIPS asked for this so
   rung-1 and center share an entity set — **but those functions run every frame regardless of the flag**, so
   adding a pattern there changes centroid/bearing/interior results even with `fightArenaShell:'off'`, breaking the
   #1 acceptance bar (flag-off parity). Instead `RoomArenaBlocker` lives only in the shell's self-contained
   `ARENA_BARRIER_RX` (the rung-1 log-only scan), which runs only when the flag is not 'off'. Rung-1 computes its
   ring around the shell's chosen center, so it is internally consistent without touching the shared sets. **The
   brief's pins ("'off' = zero behavior change", "rung-1 LOG-ONLY forever") win over the roadmap here, as the brief
   says they do.** When a later task promotes rung-1 out of shadow, that is the time to fold `RoomArenaBlocker` into
   the shared sets (it will be a real behavior change to test on its own).

2. **`densestClusterCenter`/`getBossArenaCentroid` compute `extent` unconditionally** (per the brief's explicit
   "extend … to also cache the extent"). The extra O(n) loop and the added `extent` field run even with the flag
   off. x/y/size are byte-identical and nothing off-flag reads `extent`, so there is no behavioral parity impact —
   only a cheap loop + dead field. n is ~150 arena tiles, cached per area.

3. **`arenaEnforce` cfg field added** beyond the three named position fields — required for the dodge core to tell
   shadow (compute+log) from on (apply). Documented above.

4. **UI combo added.** The brief's DoD doesn't mandate UI, but the roadmap ROLLBACK flips the setting in the UI and
   the user needs a way to reach 'off'/'on' during live-test, so a 3-state `ImGui.combo` was added beside the
   kite-boss controls.

5. **Desperate fallbacks intentionally left unclamped:** pass-2 of `pickRadialRetreatWaypoint`, the tangential
   keep-moving fallback of `pickLargeOrbitWaypoint`, and `pickFenceEscapeWaypoint` (untouched). These are the
   "boxed vs boss > boxed vs wall" escapes; a null/blocked pick still means "keep orbiting", per the brief. Only the
   primary candidate loops enforce the shell.

6. **Engage-inside invariant uses the engage position captured at first compute** (`_arenaEngageX/Y`), not the
   wandering player position at refresh — matches the brief. If a boss kites the player far outside a small learned
   `r`, `fightPointInArena` on the player's own region could reject picks, but only under `'on'`; in the default
   `'shadow'` there is zero enforcement, so this is a shadow observation to surface before flipping on.

---

## Open questions for the planner

1. **No live arena to validate against.** Bridge was up but the session was mid-`MapTrenches`, not at a boss, so
   rung-1 ring/door discrimination (the ≥120° vs <90° thresholds) and rung-2 `extent+8` sizing are un-validated on a
   real arena. The shadow logs are designed to answer this on the first boss map — compare logged `r` to the visible
   wall before anyone flips to `'on'` (roadmap step 3).

2. **Rung-1 promotion path.** When a later task promotes the barrier ring from log-only to enforced, folding
   `RoomArenaBlocker` into the shared center-detection sets (deviation 1) should be part of that task and tested as
   its own behavior change — not silently merged here.

Not started: TASK-04 or any other queue item. Nothing committed; runtime dir only.

# TASK-07 REPORT — Dodge efficiency: frozen-anim chain-rolls + catch-alls scoped to the real boss fight

Status: **implemented, syntax-checked, NOT tested in game, NOT committed.**
Pre-snapshot: `handoff\pre\TASK-07\{auto_dodge_core.js,mapper.js}` (taken as FIRST ACT, md5-verified identical to
live before any edit). Diff base for the planner review.

## Files touched (2, both in the RUNTIME dir)

### `auto_dodge_core.js`
| Symbol | Kind | What |
|---|---|---|
| `_animAdv` | new module `Map` | entityId -> `{dur, prog, at, seen}` animation-advancement anchor |
| `ANIM_ADV_EPS` | new const `0.04` | seconds of clip advance that still counts as "playing" |
| `ANIM_ADV_WINDOW_MS` | new const `250` | same clip, no advance for this long => frozen |
| `ANIM_ADV_PRUNE_MS` | new const `5000` | drop anchors of entities we stopped sampling |
| `animIsAdvancing(id, dur, prog)` | new function | the P1 gate; returns false while a clip is frozen/stunned/paused |
| `AUTO_DODGE_DEFAULTS.bossFightActive` | new field, default `false` | the P9 gate |
| anim-only catch-all (`boss-anim~catchall`) | modified | `+ CFG.bossFightActive === true` (outer), `+ animIsAdvancing(...)` (inner) |
| named floor-up catch-all (`~catchall`, the `effectiveRadius < minRadius && isBoss` branch) | modified | `+ CFG.bossFightActive === true` |

### `mapper.js`
| Symbol | Kind | What |
|---|---|---|
| `autoDodgeCfg.bossFightActive` | new publication, 1 line | `= (currentState === STATE.FIGHTING_BOSS)`, published every frame in the dodge-cfg block, immediately after the arena `if/else` |

`node --check` passes on both. `runAutoDodge` has exactly ONE caller repo-wide (`mapper.js`, via
`autoDodgeCfg = {...AUTO_DODGE_DEFAULTS, ...}`), so the new field is always present — no `undefined` path that
could silently disable the catch-alls. (Checked: `CFG = cfg` is a reference assign, not a merge, so a caller that
built its own literal would have lost the field. There is no such caller.)

## Settings added
**None.** No new user-facing setting, no UI. `bossFightActive` is an internal per-frame publication (mapper -> dodge
core), exactly like the existing `bossEngaged` / `arenaCX` fields. Flag-off parity is N/A per the brief.

## How the two fixes work

**P1 — frozen animation.** `_abFp` fingerprints an anim instance by its *estimated start* (`now - prog*1000`, bucketed
to 700ms). Freeze the boss: `prog` stands still, `now` advances, the bucket rolls over every 700ms => a "new instance"
=> a roll every `minIntervalMs`. `animIsAdvancing` anchors `{prog, at}` and moves them **only on real advance**, so a
stationary clip accumulates elapsed time against a *fixed* anchor. `>=250ms` with `|prog - anchor.prog| < 0.04` and the
same `dur` => not advancing => the branch is skipped, no hazard pushed, no fingerprint churn.

At the boss scan cadence (`SCAN_INTERVAL_MS = 100`), the freeze is proven on the 3rd sample (~200-300ms), and
`minIntervalMs = 1100` means at most one roll can fire inside that window anyway.

Tuning margin: a normally-playing clip advances 0.1s per 100ms sample, far above the 0.04 eps. Because the anchor only
re-anchors on `>= eps` (never on the last sample), a *slowed* clip still re-anchors before the window expires. A clip
must play slower than **~0.16x** to be misread as frozen — well below any chill/slow in this game.

**P9 — catch-all scope.** `mode === 'boss'` is `FIGHTING_BOSS || WALKING_TO_BOSS_MELEE` (mapper `inBossDodge`), and
`isBoss` is just `rarity === RARITY_UNIQUE`. So both synthetic catch-alls fired on **any unique** during the whole
boss walk-in — a rogue exile met on the way became a phantom hazard and got rolled away from instead of killed.
Gating on `bossFightActive` narrows both to `FIGHTING_BOSS` only. Verified this is **not** a no-op: it removes the
catch-alls during `WALKING_TO_BOSS_MELEE`. Mid-map exiles (`dodgeMode === 'rare'`) were already excluded by the
pre-existing `mode === 'boss'` clause, so acceptance (b) holds through both gates.

Untouched, as required: `animCastDodged`, the deny-name list, the distance/hp gates, `minIntervalMs`, channel
protection, the Movement Broker, and every other hazard class (geometry telegraphs, projectiles, ground, melee nets,
rare-surround, hostile deployable fields).

## LIVE-TEST CHECKLIST

Turn on the **`dodgeDebug`** setting to get `[DodgeDiag] state=… mode=… dodgeOn=…` every 1.5s — it tells you which
state you are in, which is what both fixes key off. Roll lines look like:
`ROLL angle=… why=boss_telegraph:boss-anim~catchall:anim_1086 d=…`

**(a) Frozen boss (the P1 fix) — the headline test.**
Freeze/stun the map boss and channel Snipe.
- WORKING: **zero** new `why=…boss-anim~catchall…` ROLL lines for as long as the boss is frozen (one roll at the very
  instant of the freeze is acceptable and expected — see Risks). ChannelledSnipe completes without interruption.
- BROKEN: `boss-anim~catchall` ROLL lines keep repeating every ~1.1-2s while the boss is visibly frozen.
- Note the roll must stop **for the whole freeze**, including freezes longer than 5s (the prune window) — that case is
  specifically covered, see Risks #1.

**(b) Rogue exile mid-map (the P9 fix).**
Walk into a rogue exile / unique while clearing, and again while the bot is walking to the map boss
(`[DodgeDiag] state=WALKING_TO_BOSS_MELEE`).
- WORKING: **no** ROLL line whose `why=` contains `~catchall` (neither `boss-anim~catchall` nor `<SkillName>~catchall`).
  The bot stands and kills it. Real geometry dodges still fire — you should still see ROLL lines with a real skill name
  and no `~catchall` suffix (e.g. `why=boss_telegraph:SomeSlam`, `why=projectile:…`, `why=ground:…`, `why=melee:…`).
- BROKEN: any `~catchall` ROLL while `state=WALKING_TO_BOSS_MELEE` or `state` is a clearing state; or the opposite —
  the bot stops dodging the exile's *real* telegraphs/projectiles entirely (that would mean I over-gated).

**(c) Real, un-frozen boss wave (Caedron class) — the regression test.**
- WORKING: still exactly **one** `boss-anim~catchall` roll per cast/wave (unchanged from today), while
  `[DodgeDiag] state=FIGHTING_BOSS`. `<SkillName>~catchall` rolls also still fire in the fight.
- BROKEN: zero rolls during an advancing wave (the advancement gate is too strict / the publication never goes true),
  or chain-rolls returned.

**(d) Cheap sanity:** `[DodgeDiag] state=FIGHTING_BOSS` must appear during the boss fight even with the
**`fightArenaShell` = `off`** setting. If catch-alls die when that setting is `off`, the publication got coupled to the
arena shell (it must not be — see Deviation).

## Risks / deviations

1. **DEVIATION (behavioral, deliberate) — where `bossFightActive` is published.** The brief said to publish it inside
   the arena block and "set it explicitly false in the same else-branch that nulls arena fields". That else-branch is
   `if (dodgeMode === 'boss' && arenaShell) {…} else {…}` — it also fires when **`arenaShell` is null**, which happens
   whenever `fightArenaShell` is `'off'` (`arenaShellMode() === 'off'` never computes a shell) or when the shell simply
   fails to resolve on a map. Implemented literally, that would set `bossFightActive = false` **during a real boss
   fight** and silently kill both catch-alls — reintroducing the exact death class they exist for ("you didn't dodge a
   SINGLE thing he cast"). I published the brief's stated expression `(currentState === STATE.FIGHTING_BOSS)`
   unconditionally, one line, in the same block, right after the arena `if/else`. This satisfies both the stated value
   and "false otherwise", and decouples the dodge from the arena-shell setting. **Planner: please confirm.**

2. **First-sample optimism (bounded, matches the brief).** Advancement cannot be observed from a single sample. An
   entity whose clip is *first seen already frozen* gets one anchor-creating sample that returns `true`, so **one**
   catch-all roll is possible before the freeze is proven (~200-300ms later). In the real sequence — boss animates,
   then we freeze it — the anchor already exists and the roll count is **zero**. The brief specifies this ("Otherwise
   update the entry and proceed"); I did not tighten it, because returning `false` on the first sample would delay a
   genuine boss cast's roll by one scan pass and risk acceptance (c).

3. **Pruning keyed on `seen`, not on `at` (deliberate, small deviation from a literal reading).** The brief says
   "prune entries older than ~5s". Pruning on the *advancement anchor* `at` would delete a frozen boss's anchor after
   5s of freeze, re-creating the entry, re-arming the chain-roll — i.e. it would cap the fix at "one roll per 5s"
   instead of zero, failing acceptance (a) on any long freeze. I keep a separate `seen` timestamp, refreshed on every
   sample, and prune on that: it drops anchors for entities we **stopped sampling** (dead/out of range), which is the
   evident intent, while a continuously-observed frozen boss keeps its anchor indefinitely.

4. **`e.id || 0` collision (pre-existing, not introduced).** Entities with an unreadable id all share anchor key `0`.
   The existing `_abFp` fingerprint already collapses the same way, so this adds no new bug class, but two id-less
   uniques animating at once could suppress each other's catch-all. Not worth fixing here.

5. **Perf.** `animIsAdvancing` is called only for entities that already passed the anim shape gate (unique, engaged,
   <=1400w, non-idle clip) — i.e. ~0-2 entities per boss scan. The prune loop walks `_animAdv` only when inserting a
   new entry, and the map is bounded by uniques in scan range. No new entity scan, no new throttle needed.

6. **Gate placement inside the inner `if`.** `animIsAdvancing(...)` is the **last** clause, so the cheap shape/name
   gates short-circuit first and we only sample clips that could actually push a hazard. All clauses are `&&`-ed, so
   the result is identical to placing it first; only sampling cost and which clips get anchored differ. The brief's
   "composes IN FRONT of them" is satisfied semantically (it gates the push); if the planner meant *textually first*,
   it's a one-line move with no behavior change.

## Open questions
1. Deviation #1 (publication site) — confirm the unconditional publication is what you want, or tell me you really do
   want `bossFightActive` to follow `arenaShell`'s nullity.
2. During `FIGHTING_BOSS`, a rogue exile that wanders into the arena **still** gets both catch-alls (they key off
   `isBoss`/`RARITY_UNIQUE`, not off the committed boss entity id). The brief scoped by *state*, not by entity, so I
   did not touch it. If the user's "running from rogue exiles" also happens inside boss arenas, the next task is to
   gate the catch-alls on `entityId === <committed boss id>`.

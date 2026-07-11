# TASK-03 — Arena Shell: full mechanism, default 'shadow' (roadmap steps 2+3)

Read `HOUSE_RULES.md` first. Full design: `..\MAPPER_ROADMAP.md` section "### Arena Shell" — that section is the
spec; this brief pins the contract, scope cuts, and traps. Files to edit: `..\mapper.js` AND `..\auto_dodge_core.js`.

## Problem (user's words)
"Still fighting bosses like an absolute moron... running into an invisible wall in boss arena" — boss arenas have
an invisible circular boundary (+ sealed-door barrier entities) that `isWalkable` reads as walkable. Kite/retreat/
dodge picks land outside it, the player rubs the wall, and the fight stalls.

## What ships in this task
The complete shell mechanism behind a 3-state setting `fightArenaShell: 'off' | 'shadow' | 'on'`, **default
'shadow'**: the shell is computed, logged, and every consumer logs what it WOULD have changed — but nothing is
enforced. `'off'` = byte-parity (helpers no-op). `'on'` (enforced later, after shadow validates) = the radius comes
from **rungs 2-4 only**; the rung-1 barrier-ring scan stays log-only even when 'on' (unproven entity signal — a
later task promotes it).

## Spec (implement per the roadmap section; the deltas/pins below win on conflict)
1. Shell struct + lifecycle: `{cx, cy, r, src, conf}` + barrier no-go disc list. Computed at FIGHTING_BOSS entry,
   refreshed at most 3x (engage +1s / +5s / +10s), then FROZEN. Cleared: on entering FIGHTING_BOSS (before first
   compute), on LEAVING FIGHTING_BOSS (the post-kill exit walk through the reopened door must never be clamped),
   and in `resetMapper`.
2. Detection ladder (roadmap): rung 1 barrier-ring (LOG-ONLY forever in this task — both its ring radius and its
   door no-go discs are logged, never enforced), rung 2 tgt-extent (extend `getBossArenaCentroid`/
   `densestClusterCenter` to also cache the cluster's max point-to-center distance; r = extent+8 clamped [60,170]),
   rung 3 ckpt-dist (r = dist(center, `bossCkptExitX/Y`)), rung 4 default r=85.
   Center priority: `getBossArenaCentroid` -> locked `bossArenaCacheX/Y` -> `findBossArenaInterior` -> tracked boss
   entity pos at engage.
3. INVARIANTS: expand r so the engage position is inside (`r >= dist(center, engagePos) + 10`). LEARN-ON-STALL:
   the existing fight micro-stall detector (search `moved < 2.0` in the fight-move code) fires when we push the
   wall — if the active waypoint is radially OUTWARD of the player, cap `r = max(dist(player,center)+4, 45)`,
   src='learned'. In 'shadow' this LOGS the would-be shrink instead of applying it.
4. Helpers (O(1), used by every consumer): `fightPointInArena(gx, gy, margin=6)` and
   `clampToArenaShell(gx, gy, margin=10)`. Both return "allow"/identity when the shell is null OR the flag is not
   'on' — that is the parity mechanism; consumers call them unconditionally.
5. Consumers:
   a. DODGE (auto_dodge_core.js): mapper publishes `autoDodgeCfg.arenaCX/arenaCY/arenaR` (null them whenever
      mode!=='boss' or shell absent — follow the existing `holdSoftRisks` publication pattern in the dodge cfg
      section of mapper.js). In `chooseDodgeDirection`, add an `arenaShellPenalty` term in GRID space to both the
      8-direction and the perpendicular candidate scoring blocks: landing outside r-4 -> +140, within 10u of the
      edge -> graded +0..80. In 'shadow', compute and (throttled ~2s) log the would-be penalty of the WINNING
      candidate only if nonzero: `[ArenaShell] dodge would-penalize dir=N p=NN (shadow)`.
      TRAP: auto_dodge_core.js recently gained a `boss-anim~catchall` branch and an `animCastDodged` map near the
      top — do not disturb them; your edit sites are `chooseDodgeDirection` and the cfg intake only.
   b. KITE/RETREAT/ORBIT pickers (mapper.js): beside every existing `isWalkable` candidate test in the fight
      movement pickers (search `pickRadialRetreatWaypoint`, the orbit picker, and the kite standoff logic), add the
      `fightPointInArena` predicate. Pass-2 of `pickRadialRetreatWaypoint` (the desperate pass) keeps IGNORING the
      shell; a null pick still means "keep orbiting". Clamp effective kite floor and orbit radii to r-12 when 'on'.
   c. PRESS-IN / direct move: `stepFightDirectMove` clamps its target via `clampToArenaShell` when
      state===FIGHTING_BOSS; the random stuck-nudge rejects headings that exit the shell ('on' only; 'shadow' logs).
6. Logging: `[ArenaShell] src=<rung> r=<n> center=(x,y) conf=<c>` once per compute/refresh/learn; consumer
   would-have lines throttled >=2s each. No per-frame spam.
7. Perf: the barrier scan is ONE `getAllEntities`-class read per refresh (max 3 per fight + entry) — never per
   frame. Everything else is arithmetic on cached values.

## Hard limits
- Advisory geometry ONLY: no Movement Broker changes, no memory writes, no packets, no new C++ bindings.
- Do not touch the boss-approach walker (`Boss Melee Approach` / advance-cycles logic) — the shell governs the
  FIGHT, not the approach.
- Line numbers in the roadmap are stale (the file grew ~350 lines since) — locate by symbol only.

## Acceptance
- `node --check mapper.js` and `node --check auto_dodge_core.js` pass.
- 'off': zero behavior change, zero logs. 'shadow' (default): `[ArenaShell]` compute line at each boss engage +
  throttled would-have lines during the fight; behavior identical.
- Report per HOUSE_RULES (symbols, the exact publication field names, live-test checklist for a boss fight,
  deviations).

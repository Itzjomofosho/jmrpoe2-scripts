# TASK-44 REPORT — Navigator: boss-belief fallback + visit revealed-unvisited + region oscillation

Pre-snapshot: `handoff\pre\TASK-44\` (navigator.js + mapper.js, taken before any edit).
`node --check` PASSES on both edited files. New-symbol grep clean. No git commit/push (house rule).

## Files touched

### navigator.js
- Header doc: TASK-44 bullet (A2 fallback + rvisit candidate class).
- **New consts** (all in the tunables block):
  - `NAV_VISIT_REVEALED_ON = true` — B master flag. `false` = no rvisit candidates.
  - `NAV_BOSS_FALLBACK_ON = true` — A2 master flag. `false` = no fallback belief, no direction bias.
  - `NAV_RV_SCAN_MS = 4000`, `NAV_RV_PITCH_U = 96`, `NAV_RV_MAX_PROBES = 5000`, `NAV_RV_PTS_CAP = 512`,
    `NAV_RV_MIN_CELLS = 8`, `NAV_RV_MIN_SPAN_U = 200`, `NAV_RV_REACH_U = 90`, `K_RV_CELL_MASS = 25`,
    `K_BOSS_DIR = 150` — B/A2 tuning.
  - `NAV_REGION_COOLDOWN_MS = 25000`, `K_REGION_COOL_PEN = 350` — C2. `NAV_REGION_COOLDOWN_MS = 0` = off.
- **Retuned**: `NAV_REGION_LINK_MULT` 1.7 → 2.1 (C1, see Deviations #3). Rollback = 1.7.
- **New functions**: `_refreshRvRegions` (lattice scan + union-find clustering), `_bossDirBonus`,
  `_regionCoolPenalty`, `_stampRegionCooldown`.
- **Modified**: `model` (+`rvBounds/rvBoundsAt/rvRegions/rvAt/rvCapLogged/regionCooldown`), `_resetModel`,
  `_refreshBossBelief` (NONE digest + A2 fallback), `_refreshModel` (calls `_refreshRvRegions` before belief),
  `_candidates` (region cooldown penalty + boss-dir bonus; new `rvisit` candidate class), `_incumbentScore`
  (rvisit branch; boss-dir symmetry on region/rvisit incumbents), `_commit` (rvisit initialMass = cells),
  `_dropObjective` + hysteresis-switch (region cooldown stamp), `_evaluate` (rvisit completion),
  `navCurrentWaypoint` (rvisit plan-spent branch).

### mapper.js
- `TARGETS_DB` + `'mapchannel': { boss: ['Channel/Tiles/(Centre|Side|diag)Pattern'] }` (A1).
- `navConfigure` bus: + `trailHas`, + `mapObjectiveExists` (lazy accessors, no behavior change flag-off).

## What each fix does

**A1 (Channel arena pattern — solved WITHOUT a live Channel instance).** Datamined the map's generation
graphs (repoe-fork/poe2, `data/Metadata/Terrain/Maps/Channel/Graphs/Channel_0{1-4}.dgr.json`): the boss room
is `Rooms/Unique/boss_01.arm` with `room_tag: "map_boss"`, and the graph `tile_set` carries map-local
re-skins of the Maraketh **Arena** kit — `Metadata/Terrain/Maps/Channel/Tiles/{CentrePattern,SidePattern,
diagpattern}_01.tdt` (parents literally `Desert/Maraketh/Arena/*`). They are NOT fill tiles (checked all 4
graph variants), so their cluster IS the arena. Regex sanity-tested: matches exactly those three families,
rejects Abyss/door/fill tiles. This also re-arms FIGHTING_BOSS on Channel (getBossArenaCentroid feeds it),
which is the A0 survival half.

**A2 (belief can never be bare-NONE with a MapBoss).** When all four belief tiers fail AND
`mapObjectiveExists('MapBoss')` AND a revealed-but-unvisited region exists: install
`{conf 0.5, src 'revealed-unvisited'}` from the largest rv region. conf 0.5 < `NAV_BOSS_CONF_MIN` (0.7) so
it is NEVER committed as a boss destination — it acts through `_bossDirBonus` (+up to 150, dot-scaled) on
region/rvisit candidates AND their incumbents (symmetric, no churn). It never overwrites a real persisted
belief (only installs over nothing or over itself). The NONE diagnostic still fires once and now appends a
**rarest-tile-family digest** so the NEXT pattern-miss map self-reports its TARGETS_DB candidates in one line.

**B (rvisit).** Once per map: tile-extent bounds from `getTgtLocations` (measured 3ms live). Every 4s on
nav-owned frames: lattice probe (96u pitch, ≤5000 probes; pitch auto-widens on oversized maps) —
`poe2.isWalkable` (revealed) AND NOT `trailHas` (never walked) → union-find clusters → keep regions with
≥8 weighted cells AND bbox minor span ≥200u (kills walked-corridor edge slivers) → candidate kind `rvisit`
targeting the walkable member point nearest the centroid. Scored on the fog-region scale
(`K_REGION_MASS * min(cells*25, 900) - K_DIST*d - trail - rear-bias + bossDirBonus`) so it competes with,
not dominates, the frontier. Arrival (<90u) or plan-spent = one-shot done (`poiDone` key `rv:x:y`); a
dissolved cluster also completes. Live-measured cost on the game thread: probes+clustering <1ms.

**C (oscillation).**
1. `NAV_REGION_LINK_MULT` 2.1: **verified against live data** — bucket pitch measured 112u via bridge
   (`getUnexploredBuckets(8)` min pairwise distance); the Channel siblings sat ~198u apart, just over the
   old link (1.7×112 = 190.4). New link 235.2u joins diagonal + one-drained-bucket gaps; 2-bucket gaps
   (336u) stay separate. The two south chunks become ONE region → one commit, disc-scoped chunk-steps.
2. Departed-region cooldown: every region-objective departure (drop OR hysteresis loss) stamps its disc for
   25s; candidates inside a stamped disc lose 350 points. Soft on purpose — see Deviations #2.

## LIVE-TEST CHECKLIST (Channel is the acceptance map)

Working looks like:
1. `[Nav] boss belief: arena_tgt centroid=(x,y) conf=0.9 tiles=N` — N in the ~4–50 range, centroid inside
   the NW square (compare the radar). The mapper should then drive boss-direct and enter FIGHTING_BOSS at
   the arena (survival stack armed — the A0 fix).
2. `[Nav] rv bounds (...)` once per map; on maps with a large revealed-unwalked wing:
   `[Nav] objective rvisit@(x,y) committed (score S, over N candidates)` + status `Nav rvisit -> ...`, and
   the char actually walks into that wing.
3. If a FUTURE map still misses patterns: `[Nav] boss belief: NONE (patterns matched 0/N tile keys; rarest
   families: a(2) b(4) ...)` followed within seconds by
   `[Nav] boss belief: revealed-unvisited fallback centroid=(x,y) conf=0.5 cells=N (direction bias only)` —
   paste the NONE line; the families named in it are the next TARGETS_DB entry.
4. No south oscillation: no alternating `objective region@A committed` / `region@B committed` pairs ~200u
   apart. After a region completes you may see one `[Nav] region@(x,y) disc cooldown 25s (region explored...)`.
5. Regression check (normal open map, e.g. Cenotes): flow unchanged; rvisit commits rare while fog mass
   remains; NO new `PAUSED: navigator has no objective` stalls.

Broken looks like: belief resolves to a centroid OUTSIDE the arena (wrong cluster — send the belief line);
rvisit ping-pong (repeated rvisit commits to nearby keys — send the objective lines); cooldown lines
spamming more than ~once per region completion.

Rollback: `NAV_VISIT_REVEALED_ON=false`, `NAV_BOSS_FALLBACK_ON=false`, `NAV_REGION_COOLDOWN_MS=0`,
`NAV_REGION_LINK_MULT=1.7` → TASK-40 control flow; `NAV_ON=false` → full legacy explorer.

## Risks / deviations from the brief
1. **A1 via datamine, not live bridge**: no Channel instance was live (game sat in MapCenotes). Sourced the
   arena tile family from the repoe-fork/poe2 graph dump instead; DLL log confirmed areaId `MapChannel` and
   the 223-tile-type count matches the evidence. High confidence but live-unproven until the acceptance run;
   the belief log line (tiles=N + centroid) is the verification hook.
2. **C2 is a score penalty, not a hard skip**: a hard cooldown skip stalls the nav (PAUSED) when the only
   remaining candidate sits inside a just-completed disc — which is the NORMAL case after finishing a region
   whose neighbor holds the residue. -350 for 25s kills the immediate A<->B trade while a lone candidate
   still commits. Brief offered "cooldown OR fold-into-disc"; the link-mult merge (C1) is the fold, the
   penalty is the belt-and-braces.
3. **C1 is a retune of the existing const, not a new flag** — the brief's instruction was "verify
   NAV_REGION_LINK_MULT merges these"; verified arithmetically against a live pitch measurement (112u).
   Deliberately always-on; rollback is the old value.
4. The NONE diagnostic line TEXT changed (appended digest) even flag-off — log-only, control flow identical;
   it is A1's "future miss visible in ONE line" requirement.
5. B's "revealed" test is `poe2.isWalkable` (the fog-gated grid). Matches the evidence: Channel's NW had
   ZERO unexplored buckets, i.e. the fog-gated grid already carries it. If some radar-revealed ground is NOT
   in that grid, rvisit won't see it (fog frontier will, eventually).
6. `visitedTrail` caps at 4096 cells (median compaction): on very long maps, evicted old trail can resurface
   as "unvisited" rv candidates late. Bounded by the min-cells/min-span filters and one-shot `rv:` done-keys.
7. rvisit rep points that are genuinely unreachable (revealed island) burn one plan attempt, record an
   unroutable cell fact and are skipped — same containment as any other candidate.

## Perf accounting (house rule 4)
- One extra `getTgtLocations` per map for rv bounds (measured 3ms; 5s retry until terrain valid).
- rv scan: ≤5000 `isWalkable` probes + ≤512² union-find every 4s, nav-owned frames only — measured <1ms
  total on the live instance (110 probes / 2 clusters on Cenotes).
- `mapObjectiveExists` bus call rides the existing 1.5s `readMapObjectiveState` cache, at the 3s belief cadence.
- `trailHas` = one Map lookup per lattice probe. No entity scans added anywhere.

## Open questions
- None blocking. If the live Channel run shows the centroid outside the arena, send the
  `boss belief:` line + a radar screenshot — the pattern list is one string in `TARGETS_DB['mapchannel']`.

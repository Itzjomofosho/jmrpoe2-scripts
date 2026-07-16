# TASK-65 REPORT — Z-aware reachability (cross-layer mobs must not derail movement)

Implementer: Opus 4.8. Bridge used for Phase A calibration only (read-only reads; **note below** re: cogwheels).
Files edited: `mapper.js` ONLY. Pre-snapshot: `handoff/pre/TASK-65/mapper.js` (md5 454518ce…, taken before any edit).
`node --check mapper.js` passes.

---

## Phase A — calibration (live bridge, 2026-07-14)

### A1. Does the LIGHTWEIGHT entity read carry Z?
**YES — both `worldZ` and `terrainHeight` are in the lightweight payload.** No extra read cost; the gates use
fields already in hand. (Verified via `getEntities({lightweight:true})` key dump — `terrainHeight`, `worldZ`,
`boundsZ`, `rotationZ` all present; same for `getLocalPlayer()`.) `getSharedEntities()` (the posture scan's
source) is `{lightweight:true, includeBuffs:true}` → also carries `terrainHeight` + `id`.

### A2. Which field is the layer signal? — dz distributions
`worldZ` is the entity's actual model-height (noisy); `terrainHeight` is the terrain elevation at the entity's
cell, **quantized to ~7.8125 units/step** (= one "sub-step"; 15.6 = a full story). Two live scans:

| mob (sample) | euclid | dWorldZ (mob−player) | dTerrainH | reachable? |
|---|---|---|---|---|
| same-floor Scavenged Skeleton | 29–182u | −4 … −14 | **0** | yes |
| same-floor Blood-fevered Tusk | 85–236u | +16 … +43 | **0 / −7.8** | yes |
| Daemon (flying, same floor) | 113–215u | **+77.9** | −7.8 / 0 | yes |
| elevated Spite / Fury | 55–82u | +45 … +53 | **+31 … +39** | (elevated) |
| elevated Amphibious Prowler | 177–193u | +44 … +57 | **+31 … +39** | (elevated) |

**Conclusion:** `worldZ` alone is useless as a layer discriminator — same-floor mobs show dWorldZ from −55 to
+78 (a flying Daemon reads +78 on the player's own floor). `terrainHeight` cleanly separates floor (0) from
ledges (15.6/31.3/39.1/…). **dz uses `terrainHeight`.** Gate `Z_REACH_DZ_GATE = 12`: ≥ one story (15.6)
trips a radar probe; single ramp steps (7.8) do not.

### A3. The reachability oracle — radarFindPath detour ratios
`radarFindPath(pgx,pgy,gx,gy)` behavior (live):
- **Reachable target → array of `{x,y}` waypoints, last point lands ON the cell (`land`≈0), detour ratio
  (pathLen/euclid) 1.00–1.17** across 19 live monster targets + a +500u east probe (1.17).
- **No route → returns `null`.** Confirmed on: origin(0,0), player±2000, south+500 (blocked direction),
  off-map(99999) — all `null`. (`self`→`null` too: start==end degenerates → hence `Z_REACH_MIN_EUCLID`.)

So the primary unreachable signal is simply **`radarFindPath` returned null / <2 pts / doesn't land on the
cell**; the detour>3 clause is secondary insurance for "reachable only via an absurd go-around". Proposed
verdict validated: **UNREACHABLE-NOW = dz > 12 (terrainHeight) AND (no radar route OR ratio > 3)**.

### A4. Cost — the hard perf constraint
A batch of **40 `radarFindPath` calls in one frame returned `ERR js drain timeout`** (exceeded the single-frame
JS drain budget). The game also showed cogwheels / DC'd around then — **the user notes this may have been
unrelated**, so I do not claim causation; but the drain-timeout on the batch is a solid, reproducible
observation on its own. Either way the ruling stands: **never batch radar; one fresh probe at a time.** The
oracle enforces `≤1 fresh probe per Z_REACH_PROBE_GAP_MS (60ms)` across ALL gate sites + a 20s per-id cache,
so steady-state is ~0 probes and warm-up is a handful spread over a second. (Single 1/frame radar calls are
already proven safe — the existing ckpt/picker code does them.)

**I stopped all bridge use after the timeout** and did not reproduce the rampart case live (the user was not
parked below rampart mobs; the DC interrupted). The threshold rests on the terrainHeight quantization + the
null-vs-lands-on-cell dichotomy above, which are unambiguous. Live rampart validation is the user's retest.

---

## Phase B — the gates (all behind `Z_REACH_GATE_ON`)

**New oracle** (mapper.js, right before `nearestRareToClear`):
- `zReachUnreachable(player, e, now)` → bool. Cheap dz pre-filter runs AHEAD of the cache (fresh vs the
  CURRENT player layer, so a parapet mob turns reachable the instant WE climb — no stale skip); only the
  expensive radar verdict is cached 20s per id. Serialized to ≤1 fresh probe/60ms. Unmeasurable-Z /
  budget-spent-no-cache / flag-off → `false` (never invents a skip).
- `_zReachTag(id)` → `"dz=N, Nu"` string for the skip logs.

**Gate sites (3):**
1. **`nearestRareToClear`** (rare/unique chase pick) — inside the nearest-candidate test (like the existing
   unique BFS gate), so only the would-be winner is probed. Cross-layer → `continue` + `[Chase] skip <name>:
   cross-layer (dz=N, Nu)` (throttled 3s).
2. **`_postureThreatScan`** — filters cross-layer hostiles out of BOTH `_poPress` (back-out pressure) and
   `_poNear` (idle-watch nudge) so an unreachable parapet mob neither backs us off nor nudges us into the wall.
   Placed after the 70u range cut (bounded set). dodge/packet-level untouched.
3. **STRATEGY-5 elite/boss-proxy pick** (`findNearestEliteAlive`) — refuses to START a chase toward a
   cross-layer elite; only when it is NOT the already-latched `_s5EliteId` (an engaged elite stays with the
   existing stuck/dislodge machinery, per task scope). Falls through to the explore branch → keeps
   macro-routing the objective. `[Chase] skip elite <name>: cross-layer (dz=N)`.

**Explicitly NOT touched** (per user ruling): entity_actions/rotation targeting (attacks may keep plinking
cross-layer mobs), dodge, walker/nav/dislodge, breach-internal mob chase (has its own `rotBreachMobBL`).

---

## Settings added
| name | default | flips |
|---|---|---|
| `Z_REACH_GATE_ON` | `true` | master gate; `false` → `zReachUnreachable` returns false on line 1 → all 3 gates inert = **byte-parity** |
| `Z_REACH_DZ_GATE` | `12` | terrainHeight delta (units) that admits a radar probe |
| `Z_REACH_DETOUR` | `3.0` | pathLen/euclid above this = unreachable-now |
| `Z_REACH_LAND_U` | `20` | radar route must end within this of the mob cell |
| `Z_REACH_MIN_EUCLID` | `20` | below this, never gate (mob on top of us; radar degenerates) |
| `Z_REACH_TTL_MS` | `20000` | per-id verdict cache |
| `Z_REACH_PROBE_GAP_MS` | `60` | ≤1 fresh radar probe per this window, across all sites |

Perf budget: worst case ~1 probe/60ms during warm-up; steady-state ~0 (20s cache + dz pre-filter skips
same-floor mobs with zero radar). Well under the "no unthrottled scans" rule; ≤ what existing code already does.

---

## LIVE-TEST CHECKLIST
Run a **multi-level / rampart map** (Stronghold repro ideal). Watch `C:\tmp\log.txt`:

**WORKING looks like:**
- `[Chase] skip <name>: cross-layer (dz=NN, NNNu)` when a rare/elite sits on a parapet — and the bot does
  NOT emit `Walking to Elite … No net progress 8s -> stuck + dislodge` against that same pocket.
- Movement toward **Breach / Abyss Node / Content Explore** proceeds while parapet mobs plink from above
  (arrows into the wall are fine — attacks are out of scope).
- `dz=` in the skip line should read ≥ ~15 (a real story). If you see `dz=` around 7–8 being skipped, the
  gate is a touch aggressive — lower-priority, tell the planner.
- Stuck-dislodge count on such pockets drops **visibly** vs today.

**BROKEN / watch-for:**
- **No `[Chase] skip` lines ever on a known rampart map** → the posture/pick source may lack `terrainHeight`
  (oracle returns false, gate inert). Confirm with one bridge read of a parapet mob's `terrainHeight`.
- **Skipping mobs it CAN reach** (skip line then the mob was actually pathable) → radar false-null; raise
  `Z_REACH_DZ_GATE` or check `radarFindPath` health on that map.
- **Any stutter/cogwheel** correlated with the skip lines → probe serialization failing (should be impossible
  at ≤1/60ms, but flag it — set `Z_REACH_GATE_ON=false` to confirm it's this change).
- Flag-off sanity: set `Z_REACH_GATE_ON=false`, behavior must be identical to pre-task.

---

## Risks / deviations
- **Chose `terrainHeight` over `worldZ` for dz** (brief listed both) — worldZ is too noisy (data above). This
  is the "threshold with data" the brief asked for, not a guess.
- **20s cache is player-position-agnostic for the radar verdict.** Mitigated: the dz pre-filter runs ahead of
  the cache, so climbing to the mob's layer un-skips it immediately. Residual: if we stay below but a stairway
  opens within 20s, we keep skipping until re-probe. Per brief (20s cache) and scope (movement-first). Fine.
- **Warm-up transient:** if two cross-layer candidates want a fresh probe in the same frame, only the first
  probes; the other defaults to reachable that frame and is classified next tick (~140ms picker / 300ms
  posture). At most ~1 tick of movement toward a cross-layer mob before it's cached-and-skipped — far short of
  the 8s needed to trigger a wall-slide/dislodge. Self-correcting, never batches → never freezes.
- **Did NOT live-repro the exact rampart case** (DC + user not parked). Oracle logic rests on the
  unambiguous Phase-A dichotomies. First live rampart map is the real proof.

## Open questions
- None blocking. If the planner wants tighter freshness on the radar verdict when the player is moving fast,
  a "player-terrainHeight-changed → drop cache" hook is a small follow-up (deliberately omitted to honor the
  brief's flat 20s cache).

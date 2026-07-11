# TASK-19 REPORT — Abyss chests as first-class objectives (pre-boss sweep + whiff-burn fix)

Pre-snapshot: `handoff\pre\TASK-19\` (mapper.js + opener.js copied BEFORE any edit).
`node --check` PASSES on both edited files (node v20.12.1). New symbols grepped — no typos/half-renames.

## Files touched

### mapper.js
| Symbol | What |
|---|---|
| `walkableApproachPoint(tx,ty,px,py)` | NEW shared helper — stoneApproachPoint's ring probe verbatim (rings 2..16, innermost walkable cell nearest the player), renamed + generalized comment. |
| `stoneApproachPoint` | now `const stoneApproachPoint = walkableApproachPoint;` — thin alias, stone behavior byte-identical. |
| `WALK_APPROACH_ON` | NEW const `true`, declared beside the helper — kill-switch for the two NEW call sites only (stone always used the probe). |
| `abyssSweepCnt` | NEW `{d,t}` tally beside the sweep state. `t++` in `abyssSweepAdd` on push (cap-DROPPED sites never count); `d++` in `abyssSweepRetire` when retired clean. Reset in the per-map reset line (same statement as `abyssSweepSites = []`). |
| `abyssSweepRetire(s, why, now, done)` | 4th param added. `done=true` at the `'chests cleared'` retire and the 25s-cap retire (cap fires only when loot is drained AND no unopened chest remains = clean); ceiling/unreachable/walk-cap/budget-drop stay un-counted. |
| `tryAbyssChestSweep` | Walk branch: fog-gated (`d <= 45`) ONE-SHOT probe of the site's own cell (`s.apChk` latch); unwalkable → `walkableApproachPoint`, cached on the site (`s.apX/s.apY`), path forced to re-issue onto it. Arrival gate additionally accepts "within 3u of the approach cell" (an outer-ring cell can sit at the 18u edge — without this the walker idles there into the no-progress retire). Arrival line: `clearOpenBansNear(s.x, s.y, ABYSS_SWEEP_CHEST_R, /abysschest/i)` — once per site arrival (the `s.arriveAt = now` frame), never per frame; covers BOTH the pre-boss and MAP_COMPLETE hooks (shared arrival code). |
| `abyssSweepIdle()` | NEW idle guard: `abyssId === 0 && rotBreachActivatedAt === 0 && hiveDefStart === 0 && hiveDefEndAt === 0 && !stoneKey`. |
| `obSweepTick(owns, now)` | NEW OB adapter, layer `'sweep'`, pri `OB_PRI.optional`, anchor = current head site (anchorR `STONE_ANCHOR_R`, capMs `ABYSS_SWEEP_BUDGET_MS`). Same-id re-claim is idempotent; site advance = intra-layer handoff (OB.claim completes the old record itself); drained/budget on an owned frame → immediate `complete('sweep-drained')`. |
| `obReconcile` | `'sweep'` added to the rare/mirror branch: gone = head-site key mismatch, PLUS `_miss` aging (OB_MISS_MAX passes) — see Risks #2. |
| pre-switch content chain | NEW hook directly below the `runStoneCircle` hook: `ABYSS_SWEEP_ON && abyssSweepSites.length && (FINDING_BOSS \|\| WALKING_TO_BOSS_CHECKPOINT) && abyssSweepIdle()` → `tryAbyssChestSweep` + `obSweepTick`, `return` while it owns. MAP_COMPLETE Phase 3.8 call untouched. Not ARBITER-gated (self-driven runner with no legacy owner, like stone). |
| `[Queue]` heartbeat | appends `abyss-chest:N` (pending sites) into the same k:v tally and the active count. |
| `logMapSummary` | merges `abyssSweepCnt` into the content d/t list as `abyss-chest d/t` (summary flushes before the per-map reset — order verified). |
| `runUtilityNavigationStep` | NEW sidestep after the `_utNoProg` tracker: openable targets ONLY (loot untouched), `dist <= 45` (fog rule) AND `_utNoProg > 1500` AND target cell unwalkable → compute approach cell ONCE per key (`_utApKey/_utApX/_utApY/_utApDone` cache), `startWalkingTo` it; recompute only if the cached cell itself later reads unwalkable (fog lie). The existing walk re-issue line now prefers the cached cell when set (a dodge/detour resume would otherwise silently revert to the raw coords). |
| import line | `clearOpenBansNear` added to the `./opener.js` import. |

### opener.js
| Symbol | What |
|---|---|
| `OPENER_ABYSS_RANGE_ON` | NEW const `true` — gates items 4 AND 5 (false = send at any range + `clearOpenBansNear` no-ops → parity). |
| `ABYSS_CHEST_SEND_RANGE` | NEW const `25`. |
| `processAutoOpen` send loop | after the essence branch, before the strongbox guard check: `/abysschest/i` target beyond 25u → `continue` (skip the SEND only — `collectOpenTargets` / `getOpenableCandidatesForMapper` untouched, candidates keep flowing). |
| `clearOpenBansNear(x, y, r, nameRe)` | NEW, exported. Walks `openBlacklist` keys (`o:<name>:<gx>:<gy>`; coords parsed from the tail two segments so ':' in names can't break it), deletes every entry within r whose name matches nameRe — banned AND attempt-burned records both (delete resets attempts + freeRetries = full fresh budget). Logs `[Opener] cleared N open-ban(s) near (x,y) r=R` when it removed anything. |

## Settings added
No UI settings. Three const kill-switches (per the brief's const-gate directive):
- `ABYSS_SWEEP_ON` (mapper.js, existing, `true`) — reused for items 1-3.
- `WALK_APPROACH_ON` (mapper.js, NEW, `true`) — item 6's two new call sites.
- `OPENER_ABYSS_RANGE_ON` (opener.js, NEW, `true`) — items 4-5.

Flag-off parity walked through per flag: `ABYSS_SWEEP_ON=false` → `abyssSweepAdd` early-returns (counters never move), no sites → hook/heartbeat/summary additions all short-circuit, `obSweepTick` unreachable, the `'sweep'` obReconcile branch can never match (no sweep record can exist). `WALK_APPROACH_ON=false` → `s.apChk/s.apX` never set, `_apD = Infinity`, `_utApDone` never true, every changed expression evaluates to its pre-task value; stone unaffected either way (alias). `OPENER_ABYSS_RANGE_ON=false` → the send-gate `continue` short-circuits false; `clearOpenBansNear` returns 0 without touching the map.

## LIVE-TEST CHECKLIST (abyss map, ideally one with pit-edge chests)
1. **Pre-boss sweep fires immediately.** After the Abyss objective bit flips mid-map:
   `[AbyssSweep] abyss node (x,y) pruned on objective-complete -> chest site queued (N)` followed within seconds — still pre-boss — by `[AbyssSweep] -> chest site (x,y) Du (N left)` and status `Abyss sweep: ...`.
   BROKEN: sites queue but the bot walks to the boss and `-> chest site` lines only appear post-boss in MAP_COMPLETE (old behavior).
2. **Chests actually open.** At each site: `[AbyssSweep] site (x,y) node=... chest=YES/no`, opener lines `[Opener] Opened Chest: AbyssChest... (Dist: <25)`, chest de-streams/`chestIsOpened`, loot picked, then `[AbyssSweep] site ... retired: chests cleared`.
3. **No drive-by whiffs.** Zero `[Opener] Opened Chest: AbyssChest*` lines with `Dist:` above 25 (the old log had 32.9/39.7/48.1).
   BROKEN: any AbyssChest open logged at 30u+.
4. **Ban lifted on arrival.** On a site whose chest got attempt-burned earlier: `[Opener] cleared N open-ban(s) near (x,y) r=90` at the `[AbyssSweep] site ...` arrival line, then that chest opens anyway.
   BROKEN: sweep holds 25-45s at the site, chest stays shut, retire says `45s ceiling`.
5. **Never preempts a live runner.** While `[Abyss] node ...` wave / `[Breach] ... adopting clear` roam / hive defense / `[StoneCircle] ...` lines are active, NO `Abyss sweep:` status or `[AbyssSweep] -> chest site` lines interleave.
6. **OB narrative.** First pre-boss sweep frame: `[OB] claim=sweep:<key> pri=4 (abyss-chest-sweep)`; on site advance an intra-layer `complete ... (layer-swap) -> claim=...`; after drain `complete sweep:<key> (sweep-drained)` (or `sweep-gone`/`stale (hook unreachable)` if a boss engage cut it off — that's the reconcile doing its job). NO sweep record lingering as holder through a boss fight (watch for repeated `deny ... vs sweep:...`).
7. **Visibility.** `[Queue] N active: ... abyss-chest:K` while sites pend; MAP SUMMARY `content:` shows `abyss-chest d/t`, d==t on a clean run. d<t → the retire reasons in the [AbyssSweep] lines above it say why (ceiling/unreachable/budget).
8. **Approach sidestep.** Pit-edge site: `[AbyssSweep] site cell unwalkable -> approach cell (x,y)` then a clean arrival (no wall-slide loop). Utility: `Utility openable: target cell unwalkable at Du -> approach cell (x,y)` and the strongbox/shrine/essence opens instead of `failed:no-net-progress`/`failed:no-path`. Loot pickups unaffected.

## Risks / deviations from the brief (with why)
1. **Idle guard named `abyssSweepIdle`, not `runAbyssRunIdle`, and widened.** The brief's symbol was a placeholder ("verify exact symbols"). Verified names: `abyssId`, `rotBreachActivatedAt`. I ALSO added `hiveDefStart/hiveDefEndAt/stoneKey`: the hard-limits section forbids preempting hive defense and stone circle, but the chain position only guarantees that while `ARBITER` (const true) gates those hooks — the explicit reads keep the guarantee if ARBITER is ever flipped. Extra terms can only make the sweep MORE conservative (skip a frame), never preempt.
2. **obReconcile `'sweep'` branch uses `_miss` aging (like rare/mirror), not the stone-style key-only check.** `stoneKey` clears when its runner finishes; the sweep's site list SURVIVES a boss engage, so a key-only reconcile would leave a stale pri-4 `sweep:` record as the OB holder for the whole fight — denying utility(5)/loot(6) claims if/when objBroker enforces. `_miss` retires it ~3 logic passes after the hook stops owning; the owning pass stamps `_miss = 0` in `obSweepTick`.
3. **Adapter shape: one `obSweepTick(owns, now)` instead of separate claim/release/touch.** Same-id `OB.claim` is idempotent (touch), a site advance is an intra-layer handoff (release+claim in one), and reconcile covers the hook-stopped case — three functions would duplicate that. anchorR borrowed from `STONE_ANCHOR_R` (60): the brief named no radius; the sweep is the same stand-and-work shape as stone.
4. **Item 6 had no flag named in the brief** → added const `WALK_APPROACH_ON = true` (house const-kill-switch style: `ABYSS_SWEEP_ON`, `STONECIRCLE_ON`, `TRAIL_BIAS_ON`). Rule-2 requires every new behavior gated; both new call sites are byte-parity with it false.
5. **`d` counter semantics:** "looted or probed-empty" mapped to the `'chests cleared'` retire AND the 25s-cap retire (that cap only fires when loot is drained and no unopened abyss chest remains — i.e. the site IS clean). 45s-ceiling/unreachable/walk-cap/budget-dropped sites count only in `t`, so d<t flags exactly the sites the user should ask about.
6. **Sweep arrival gate extended** (`within 3u of the approach cell` counts as arrived): an outer-ring approach cell can sit at the 18u ARRIVE edge; without this the walker parks on the cell and burns the 10s no-progress retire. Flag-off → the added term is `Infinity > 3` → unchanged.
7. **Utility sidestep re-issue:** the compute is once-per-key as specified, but the existing "walk got stomped" re-issue line now prefers the cached approach cell — otherwise the first dodge/detour resume silently reverts the walk to the raw unwalkable coords and the one-shot sidestep is lost.
8. **`clearOpenBansNear` deletes attempt-burned records too, not just hard-banned ones** ("delete/unban" per the brief) — freeRetries reset with them, so a whiff-burned chest gets the full free-retry + 3-attempt budget once we stand there.

## Open questions
- None blocking. If the planner prefers the 45s-ceiling retire to also count toward `d` (site visited but chest given up), it's a one-arg change at the ceiling call site.

# TASK-66 REPORT — Split-map fog-concede: explore the unexplored map, stop false "map revealed" concede

**Status: SHIPPED to runtime, UNCOMMITTED, LIVE-PROVEN (the bot found the abyss on the real Sandspit failure map).**
Reviewed 3× (2 adversarial + 1 final: No Critical / No High, all flag-off parity confirmed). Awaiting the user's
AFK regression pass + planner review. Nothing committed (TEST-BEFORE-COMMIT).

Implementer: Opus 4.8. Runtime-only edits to `c:\Games\jmr-poe2\scripts\poe2-scripts\mapper.js`. navigator.js was
snapshotted (`handoff\pre\TASK-66\`) but needed NO edits — the fix reuses the existing walker/picker primitives.

> Scope note for the orchestrator: this report covers (A) the TASK-66 exploration/concede fix, plus two out-of-brief
> items the user requested live: (B) two settings locked ON + de-UI'd, and (C) a **diagnosis only** of an abyss-coffer
> bug that is a **separate task** (not started). (B) and (C) are called out explicitly so they can be reviewed apart
> from the TASK-66 diff.

---

## Phase A — WHY radar nulled (live bridge, start pinned to the boss room)

| Probe | radarFindPath | macroPathTo | Meaning |
|---|---|---|---|
| near/mid EAST buckets | PATH | ROUTE | radar routes streamed terrain (fog-independent within coverage) |
| WEST buckets (517,517)/(517,862) | **NULL** | ROUTE (13 collinear wp = straight cross-cliff) | never-streamed; macro gives a FALSE straight route |
| map START (1818,2523), walked FROM | **NULL** | ROUTE 86wp | de-streamed → radar can't see it either |

**Verdict:** `radarFindPath`'s overlay covers only CURRENTLY-STREAMED terrain (routes ≲300u, NULLs beyond) regardless
of foot-reachability. `macroPathTo` has the full map topology but is elevation-blind (false cross-gap routes). So
**a radar-null toward a fog bucket = coverage-UNKNOWN, not unreachable.** The picker was banning its own good winner on
that null → frontier erased → false "map revealed" concede with half the map dark.

---

## The fix (final shape, after 3 review passes)

The first cut (B1 defer / B2 nearest-frontier fog-explore / B3 honest log) worked on paper but live-tested badly —
it **grazed** near the player, **yo-yo'd**, and **conceded mid-combat**. Two adversarial reviews + a live trace found
the real disease and reshaped it into 5 flagged changes:

- **H3 (PRIMARY) `DISC_COMMIT_MACRO_ROUTABLE_ON`** — `pickRouteNearestBucket` already picks the big unexplored
  expanse (mass + FwdExplore-centroid), then abdicated: it banned its winner + returned `null` whenever radar was
  coverage-blind, handing the frame to nearest-frontier grazing. Now it **COMMITS** a macro-routable radar-null-ENTIRELY
  winner; the **walk + the 9s owned-frame stall** prove reachability. Only a radar **PARTIAL** dead-end (radar HAS
  coverage, confirms a wall) hard-bans. This is the fix that makes the bot drive into the dark instead of nibbling.
- **C1 (House-Rule #1) — combat-frame freeze** in `fogTrack`: the no-reveal watchdog + episode cap now freeze on
  stolen frames (`now < dodgeMoveSuppressUntil || !MB.avail('nav',5)`), the same guard `discoverProgAt` uses. This was
  the 50s-mid-fight false concede (a wall-clock timer burning while dodge held the frame).
- **H2 `DISC_ENABLED_FULL_WINDOW_ON`** — a user-ENABLED + base-game-PRESENT unfound objective (`objDriveEnabled` +
  `mapObjectiveExists`, i.e. the user's "do abysses") earns the FULL 90s discover window, not the 40s optional hedge.
  Deliberately NOT promoted to `isRequiredType` (both reviewers: that would strand the bot on unreachable-abyss split
  maps and wouldn't force it anyway).
- **M4 / M5 / Change-3** in `reachableFogFrontier`: removed the unsafe `<80u` reach shortcut; `mass` is now the
  committed target's **reachable** local expanse (killed the west-inflated constant-3085 that made the log lie); the
  fallback picks **biggest local mass** (not nearest), with the `_fogStickyX` sticky commit (anti-yoyo).
- **L1 (review cleanliness)** — the strict-finish portal caller (`getMapCompletionState()==='incomplete'`, ~19507)
  now stall-bans an H3-committed false-route bucket on `stuck` so it can't wall-slide within the 2.5s picker cache.

Retained but now secondary: **B1** (`DISC_VERIFY_BAN_ON`, radar-null defer vs 300s ban) and the **B2/B3** fog-explore
fallback + honest concede log (`CLEANUP_FOG_FALLBACK_ON`). B2 rarely drives now that H3 keeps the picker committing.

### Why it terminates (verified by the final review)
One 9s owned-stall ban writes `_unexpFailed[round(x/64):round(y/64)]`, which is read by **all three** consumers — the
picker candidate filter, `reachableFogFrontier._reachable`, and the discover stall — so a false-route bucket is dropped
everywhere at once. Hard bounds: the **150s `OBJ_CLEANUP_BUDGET_MS`** portal gate (un-frozen) + the 180s discover cap.

---

## Settings (all in mapper.js; off = byte-identical control flow + original logs — confirmed by the final review)

| Flag | Default | Off = |
|---|---|---|
| `DISC_COMMIT_MACRO_ROUTABLE_ON` | true | picker bans+null (B1 path; +`DISC_VERIFY_BAN_ON` off = pre-task 300s ban) |
| `CLEANUP_FOG_FALLBACK_ON` | true | no fog-explore, original concede + log |
| `DISC_ENABLED_FULL_WINDOW_ON` | true | req-only full window (40s optional) |
| `DISC_VERIFY_BAN_ON` | true | (with H3 off) 20s defer vs 300s ban |
| tunables | `FOG_CONCEDE_MASS=300`, `FOG_NO_PROGRESS_MS=30000`, `FOG_EXPLORE_MAX_MS=120000`, `DISC_UNKNOWN_COOLDOWN_MS=20000` | — |

New functions: `reachableFogFrontier`, `fogTrack`, `fogExploreAlive`, `fogExploreHop`, `discMissingTypesStr`.

---

## AFK LIVE-TEST CHECKLIST

**WORKING (post-boss cleanup with an unfound enabled objective + big fog):**
- `[Discover] bucket (x,y) radar-null (unstreamed) -> committing via macro corridor (walk arbitrates)` — the picker
  COMMITS and the bot drives the long corridor **into the big unexplored region** (not wiggling near the pack).
- **No** `window spent … conceded` at ~40–50s while fighting. The bot keeps exploring while reachable fog still reveals.
- Content (abyss/breach/etc.) streams in as the bot reveals → the cleanup queues + drives it.
- Genuinely done / wedged → an **honest measured** concede: `[Discover] conceded: fog-mass=N routable=M (gate: abyss)`
  — never "map revealed" unmeasured.
- Normal maps: no `fog-explore` lines (picker succeeds); concede timing unchanged, only the log is the measured form.

**BROKEN (watch for):**
- Bot wall-slides at one spot >30s without conceding → tune `FOG_NO_PROGRESS_MS` / the frontier-hash churn.
- `fog-explore` fires on an essentially-revealed normal map (wastes the tail) → raise `FOG_CONCEDE_MASS`.
- Frame stutter / `radar route slow` spam during explore → the 1s `reachableFogFrontier` cache should prevent it.

**Config changes to verify (B, below):** the "Boss arena shell" dropdown and "Objective broker (one goal at a time)"
checkbox are **gone** from the Mapper UI; both behaviors stay ON.

---

## (B) OUT-OF-BRIEF config changes (user request 2026-07-14) — flagged for separate review

Both were already ON by default, so **zero behavior change for a default user** — this only locks them and removes the
toggles (a user who had manually turned them off/shadow is now forced on, which is the explicit ask):
- **Objective Broker locked ON:** `obOn()` → `return OB_SHADOW;` (dropped the `objBroker` user setting; `OB_SHADOW=true`
  remains the dev kill-switch). UI checkbox removed.
- **Boss Arena Shell locked ON:** `arenaShellMode()` → `return 'on';` (was `fightArenaShell||'shadow'`, default 'on').
  UI combo removed. (Arena shell = advisory geometry that keeps boss-fight movement off the arena's invisible circular
  wall; edit that one line for off/shadow if it ever misbehaves.)

---

## (C) SEPARATE TASK — abyss "Abyssal Coffer" not opening (DIAGNOSIS ONLY, not started)

On the same run the exploration fix found the abyss, the reward coffer wasn't opening. Bridge diagnosis:
- The openable coffer `AbyssChestCurrency` ("Abyssal Coffer") is **fully reachable** (radarFindPath 2wp, macro endGap 9,
  all 8 cells around it walkable) and `isTargetable:true` — **NOT** fissure-line-cut (my first guess was wrong).
- The bot walked **away** from it (53u → 102u) toward the **locked** final-node chests (`AbyssLargeChestCurrency` /
  `AbyssChestRareFinalCurrency`, `isTargetable:false`, still gated by ~23 alive final-node mobs).
- Root cause: `tryAbyssChestSweep` commits the nearest site at a retire boundary and **holds it** (commitment
  discipline) — so it services the locked final-node site first and the openable coffer waits. Risk: a locked
  final-node site can retire as "chests cleared" (its chest reads not-targetable at visit time) and the chest then
  unlocks *after* the mobs die → stranded.
- **Recommended task:** teach the sweep to prefer a site with a **targetable chest present NOW** over a locked/waiting
  one (and don't retire a final-node site as clean while its chest is merely locked). Files: `tryAbyssChestSweep`
  (~4236), `abyssChestScan` (~4175), `abyssChestNear` (~4193), the retire-boundary sort (~4270). Delicate subsystem
  (10+ prior hotfixes) — do it as its own task with the planner, not a hot-patch.

---

## Files / symbols touched (TASK-66 + B)
`mapper.js` only: flags (~6987), `reachableFogFrontier`/`fogTrack`/`fogExploreAlive`/`fogExploreHop`/`discMissingTypesStr`
(~7372–7477), `tryDiscoverListedContent` concede sites (window-spent ~7494, main ~7603), `pickRouteNearestBucket` H3
block (~9210), strict-finish caller L1 (~19507), resets (~13876, ~19417), and (B) `obOn` (1413) / `arenaShellMode`
(13169) / the removed UI block (~19692).

## Risks / open
- **Split-map true cliff:** if the abyss sits in the west half reachable only via a routers-can't-compute detour, the
  bot explores everything reachable then honestly concedes. Reliably crossing that needs checkpoint-anchored routing or
  the parked checkpoint-teleport — a separate task (Phase A "OUT" clause).
- **Perf (Low):** `reachableFogFrontier` is O(n²) local-mass + ≤13 macroPathTo/call, 1s-cached — worth an
  AtlasOptimizer glance on juiced maps, not a blocker.
- **C1 clock semantics (Low):** the episode-cap anchor resets rather than pauses under frame-theft; bounded by the 150s
  cleanup budget, can only *extend* exploration, never strand.

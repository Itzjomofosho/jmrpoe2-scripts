# TASK-49 REPORT — Path-order content on linear maps + post-complete discover fixes

Pre-snapshot: `handoff\pre\TASK-49\mapper.js` (taken before any edit). File touched: `mapper.js` ONLY.
`node --check` PASSES. All new symbols grepped, no typos/half-renames.

## Flags added (both default ON per brief; flip to `false` in mapper.js to bisect)

| Flag | Default | What it gates |
|---|---|---|
| `ARB_PATH_ORDER_ON` | `true` | Part A: passed-content memory + path-order preference at the arbiter's R4 fresh pick |
| `DISC_POSTCOMPLETE_FIX_ON` | `true` | Part B: gate forensics log, abandoned-type concede, revealed-map concede (no patrol spokes), one-writer discover walk |

Tunables (Part A): `ARB_PATH_ORDER_MAX_INS = 800` (retreat cap), `ARB_PATH_ORDER_VIA = 150` (fresh-winner
"on the way" tolerance), pending-list cap 48 keys.

## A. How arbRouteOrder computes TODAY vs AFTER (brief asked explicitly)

**Today:** `arbRouteOrder` is a greedy nearest-neighbour chain (`arbNNsweep`) over the **current eligible
candidate set only** (`cands`), anchored at the frozen route anchor (`arbRouteAnchorX/Y` = the just-finished
objective's position at `arbRelease`, else the player). It is rebuilt whenever empty or >15s old, and consulted
only at the R4 fresh pick when the score-best pick is optional: the first key in NN order still present in
`cands` wins. **It has no memory.** An entry that is not eligible at rebuild time is simply absent, and on a
completion the rebuild sees only what is pickable NOW — so a newly-spotted near item always beats an item
passed minutes ago whose insertion cost has grown with every bend of the wind.

**Why it didn't order breach:43 next (log forensics, corrected timeline):** the brief's premise "both spotted
while committed to abyss:825" is wrong by the log — abyss:825 released at 13:46:54; the two breaches were
queued at 13:48:10 and 13:48:41 while `committed=-` and `pick=boss` (checkpoint walk). Since no commitment
held, R4 would have claimed a NEAR breach immediately — meaning the breaches **never entered `cands` at all**
while near. They were filtered before candidacy; the prime suspect is the **optional+walled skip** (`arbReachOf
=== 'walled'` from the 14u straight-ray heuristic — a canyon-wind map is exactly where a breach across the
switchback wall reads walled while 100–300u away). They stayed invisible until 13:51:48, when breach:43 finally
classified reachable — at OFFROUTE ins=1706 (eligible via the boss-known dist<=1000 rule). The new `noted ...
reach=` log field settles this hypothesis live.

**After (flag ON):** `arbRouteOrder`/`arbNNsweep` are untouched. A new `arbPassedOrder` Map remembers every
active driven-type entry the moment it is first seen **NEAR** (dist <= `ARB_GRAB_DIST` 260u — recorded BEFORE
the ban/pri/walled filters, so an unpickable-this-frame entry still enters the order) or **ONROUTE**
(`cl.detourCost <= cl.budget` when classified). At R4, after the NN sweep picks the fresh winner, the pending
passed item with the **smallest CURRENT ins** (re-measured from the frozen anchor, i.e. the just-finished
objective) replaces it — unless (a) its current ins exceeds 800 (retreat cap: falls back to today's scoring,
post-boss cleanup owns leftovers) or (b) the fresh winner is strictly on the way to it (visiting the fresh one
first adds <=150u to the anchor→passed leg; the passed item stays pending for the next completion). Entries
leave the list on commit (`arbCommitTo` deletes), when their queue entry goes inactive/done (lazy delete during
the R4 scan), and on map reset (`arbReset` clears).

Required content is untouched: the preference runs only inside the existing `pri < 2` branch (required +1000
score domination is unchanged), and R1 commitment holds/hysteresis are unchanged — passed items never preempt a
live commitment, they only win the next fresh pick.

## B. Post-complete discover

### B1 — gate instrumentation + accounting fix
`hasUnfoundListedContent` = per drivable objective row: `exists && !complete && (toggle-on || required) && no
ACTIVE queue entry of the type`. Two deliverables:

1. **One real accounting hole found and fixed:** TASK-43 C's skip-ban abandon flips an entry to
   `state='completed', completionSource='abandoned-unreachable'` **without the objective being done** — the
   gate then reads `queued=0` with the bit still incomplete and sends discover corner-pinging the map for
   content whose position we KNOW and deliberately gave up on. New `discTypeConcededAbandoned(type)`:
   under the flag, such a type is NOT "unfound" — applied in `hasUnfoundListedContent`,
   `hasConfirmedUnfoundContent` (an abandoned instance also voids the ">=1 done proves one more" proof), and
   the marker-scan `_unfoundTypes` builder (never walk a conceded type's abandoned marker). NOTE: this did
   **not** fire on the Ravine log (no abandon lines) — it is a latent hole, fixed because the brief said fix
   what's ours.

2. **Forensics for the case the log can't decide** (Ravine: bits read breach+verisium incomplete while the user
   saw every icon checked — either a genuine 3rd instance, a stale last-good snapshot, or offset drift). When
   the hunt OPENS, `discGateLog` prints once:
   - `[Discover] gate: Breach exists=1 complete=0 queued=0 on=1 req=0 abandoned=0 | Expedition2 ...` — the
     exact gate inputs per row;
   - `[Discover] gate raw: present=0x... complete=0x... src=bitfield|panel age=<ms> panel[Breach=1 Expedition2=1]`
     — the raw objState words (+8807/+8810 chain), which read path produced them, the age of the last good
     read, and an **independent `getMapObjectives` panel cross-read**. Bitfield=0 with panel=1 on the same line
     = the offset/read bug, captured for the RE follow-up; large `age` = stale-snapshot serving.
   `readMapObjectiveState` now stashes `_mapObjRawPresent/_mapObjRawComplete/_mapObjReadSrc/_mapObjLastGoodAt`
   on each successful read (data-only writes — see Deviations).

### B2 — revealed-map concede (no patrol spokes)
`tryDiscoverListedContent` runs only in `STATE.MAP_COMPLETE`, so "post-complete" = every call. Under the flag,
the no-marker + no-routable-mass branch (`pickRouteNearestBucket` returned nothing) **concedes instead of
patrol-spoking**: sustained-miss window of 8s (transient radar/picker hiccups must not latch — same idiom as
the coverage-era concede), then one line `[Discover] no fog frontier + no routable mass -> conceded (map
revealed, no patrol)` and the latch closes discover for the map. After the concede, the cleanup's own fast-out
(line ~18273 stops freezing once `discoverConceded`) takes the map to the portal. Flag off = today's patrol
spokes byte-for-byte.

### B3 — dual writer: root cause + fix
Confirmed from the log + code: the two alternating writers are BOTH inside `tryDiscoverListedContent` —
the **sticky-target gate** (re-issues `discoverTgt`, e.g. (3471,885)) and the **frontier-crawl hop**
(`frontierTowardTarget`, a player-relative point that drifts: (3249,711)→(3247,717)→(3240,709)). The cycle:
crawl writes its hop → `startWalkingTo` resets `lastRepathTime=0` + clears `currentPath` → next pass the sticky
gate sees `target != discoverTgt (>60u)` AND `currentPath.length===0` AND the repath gate instantly open →
re-grabs the far bucket → its fog-gated path dead-ends → crawl fires again. ~150ms alternation, zero net walk.

Fix (flag ON): the crawl records its hop in `discoverCrawlX/Y`; while the walk targets that waypoint
(`_crawlOwns`), the sticky gate does not re-write. `stepPathWalker` self-computes the path to the hop (800ms
retry when empty), the hop chain advances the walk bucket-ward, and ownership returns to the sticky target on a
new pick / gate reset / foreign writer. The existing 9s no-closer stall clock still bounds the whole walk.
Flag off: `discoverCrawlX` stays NaN forever → `_crawlOwns` always false → original gate byte-for-byte.

## Files touched / symbols (searchable)

- **mapper.js** only.
- Part A: `ARB_PATH_ORDER_ON`, `ARB_PATH_ORDER_MAX_INS`, `ARB_PATH_ORDER_VIA`, `arbPassedOrder` (new);
  modified: `arbReset`, `arbCommitTo` (delete-on-commit), `pickObjective` (two record points + R4 preference).
- Part B: `DISC_POSTCOMPLETE_FIX_ON`, `discTypeConcededAbandoned`, `discGateLog`, `discoverCrawlX/Y`,
  `_mapObjRawPresent`, `_mapObjRawComplete`, `_mapObjReadSrc`, `_mapObjLastGoodAt` (new); modified:
  `readMapObjectiveState` (raw stash), `hasUnfoundListedContent`, `hasConfirmedUnfoundContent`,
  `tryDiscoverListedContent` (gate log, marker mirror, B2 concede, B3 one-writer), `resetMapper` (new-var
  resets).

## LIVE-TEST CHECKLIST

Best map: a linear/winding map with breach+abyss+verisium (Ravine-like), then any map whose content finishes
before the boss (to exercise the post-complete tail).

**Part A working:**
- `[Arb] path-order: noted breach:<id> (passed <d>u, reach=walled|reachable|fogged)` as content is walked past
  — the `reach=` value on a skipped-while-near breach answers the root-cause question above.
- `[Arb] path-order: passed <key> (ins=<n>) preferred over fresh <key>` at completions, with the following
  `[ArbShadow] pick=<key> ... ins=<n>` showing SMALL ins (<~700) for keys that had a `noted` line.
- **Broken:** a `pick=... ins=1200+` claim for a key that was `noted ... passed <d>u` earlier while its current
  ins was still under 800 at some completion; or commit churn/yoyo lines right after a `preferred over fresh`.

**Part B working:**
- On any discover open: ONE `[Discover] gate: ...` + ONE `[Discover] gate raw: ...` pair. On a UI-done map,
  check the raw line: `complete=0x...` missing bits vs `panel[...=1]` = the read bug (capture for RE);
  `abandoned=1` with `queued=0` = the accounting case (now conceded, hunt should NOT open for that type).
- Revealed-map tail: a single `[Discover] no fog frontier + no routable mass -> conceded (map revealed, no
  patrol)` and NO `patrol spoke toward` / `stalled -> blacklist` cycling after it; MAP_COMPLETE → portal phases
  within ~10–20s when nothing remains.
- No alternating `Walking to Content Discover at (A)` / `at (B)` pairs ~150ms apart; while hunting, walk lines
  should be a stable far bucket plus occasional forward crawl hops that PROGRESS (coords advance toward the
  bucket, not oscillate).
- **Broken:** patrol-spoke lines post-complete, two-coordinate alternation, a hunt opening for a type whose
  gate line shows `complete=1`, or the tail exceeding ~30s after the concede line.

**Flag bisect:** flip `ARB_PATH_ORDER_ON=false` → all `[Arb] path-order:` lines vanish, pick behavior = today.
Flip `DISC_POSTCOMPLETE_FIX_ON=false` → no gate/concede lines, patrol spokes + dual-writer behavior return.

## Risks / deviations from the brief

1. **Brief's timeline premise corrected** (A): breaches were spotted with NO commitment held (committed=-,
   pick=boss), not "while committed to abyss:825". Recording therefore does NOT require a live commitment —
   it records whenever an entry is seen NEAR/ONROUTE. Requiring a commit would have missed the exact Ravine case.
2. **Residual walk-back window** (A): on the Ravine replay itself, breach:43 was unpickable (never in `cands`)
   until its current ins was already >800 — the retreat cap then correctly refuses to force it and today's
   scoring claims it (same 1706 walk-back). The fix guarantees path-order claims only for content that becomes
   pickable while its ins is still <=800. If the live `reach=` field confirms the walled-skip cause, the real
   fix for the residual is letting passed-NEAR optional content ride the walled→fogged path (like required
   does) — flagged as an open question, NOT implemented (brief: no new pathfinding, ride existing model).
3. **Raw-stash writes are not flag-gated** (`readMapObjectiveState`): four data-only writes to new module vars
   on successful reads. No control-flow change, nothing reads them unless the flag is on. Gating them inside
   the read chain would have added a flag check to a hot cached function for zero behavioral difference.
4. **Recording runs in shadow mode too** (ARBITER=false): `pickObjective` records passed content at the 1Hz
   shadow cadence (log lines appear). ARBITER=true in this runtime; noted for completeness.
5. **B2 removes patrol spokes entirely under the flag** — including the legitimate "re-entered revealed map,
   content unstreamed in walked ground" hunt. Accepted per the user's corner-ping ruling and the acceptance
   text ("hunts routable ground only, or concedes"). Markers + routable buckets still drive the hunt.
6. Perf: the NEAR-record adds one `Math.hypot` + Map lookup per active queue entry per driving frame (queue
   <~30; sub-microsecond scale), `discTypeConcededAbandoned` is a small queue scan called only on gate
   evaluation paths, `discGateLog` runs once per hunt-open (one `getMapObjectives` call). All within the 7Hz
   logic budget; no new entity scans.

## Open questions (for the planner)

1. If the live `gate raw` line shows bitfield incomplete vs panel complete on a UI-done map → RE follow-up on
   the objState chain (`+8807/+8810` via `[[0x4e0,0xd8],[0x2f0,0x328]]`) — offsets may have drifted for the
   COMPLETE word specifically.
2. If `noted ... reach=walled` confirms the walled-skip kept near breaches out of candidacy: extend the
   walled→fogged rescue (today required-only) to passed-NEAR optional content? That closes the residual in
   deviation 2.

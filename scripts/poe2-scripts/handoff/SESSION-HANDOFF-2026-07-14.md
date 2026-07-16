# SESSION HANDOFF 2026-07-14 (for Fable) — verisium C++ WIN + a wave of live-fix hotfixes + Mire nav still open

Fire prompt: "Read handoff/HOUSE_RULES.md and handoff/SESSION-HANDOFF-2026-07-14.md. The verisium C++ fix is
live-proven; the batch is uncommitted. Continue: (1) act on the nav-defer-fix review verdict, (2) the south-
exploration / Mire bridge-pathing fix, (3) offer the commit." USE OPUS 4.8 for implementation (Fable = planner).

## THE USER'S COMPLAINTS THIS SESSION (in order, so you know the pain)
1. Abyss chests missed / stranded (trail chests the sweep never reached).
2. 2nd breach not run though "we can SEE it" — bot couldn't enumerate it.
3. Verisium "clearing without starting" x3 (Oasis/Spring_/Sanctuary) — opened but never SELECTed the recipe.
4. Delirium mirror missed ("first thing in the map") — walked to it then abandoned to boss.
5. Ritual/Delirium maps should be atlas-EXCLUDED.
6. "Always running from mobs when u fire" (posture back-out too aggressive).
7. Got KILLED by a Beyond pack on a verisium fight.
8. Breach: "yoyoing into a breach wall", "breach didn't stabilise", "MOVE TO PROPER PATHS".
9. Mire: "SO LOST", "can't go to MASSIVE UNEXPLORED AREAS", "yoyoing", "STUCK", "used to work 10000 edits ago",
   "you're just going back to the checkpoint", "NO content/checkpoint/mob positions to latch onto?!".
10. A DC ("u dc'd me").

## WHAT I FOUND (root causes, evidence-backed)
- **Verisium never SELECTed** = getExpedition2Offered() returned NULL. ROOT (IDA, fresh IDB): the C++ binding
  brute-force SCANNED heap for a stride-16 {rowPtr,0} signature that no longer matches — the panel is a
  full-catalog TOME of tiles, OFFERED = the tiles with the VISIBLE bit (+0x180 & 0x800), recipe = tile+0x540,
  pool = ui_root[39][3][2][2][0]. FIXED in C++ (see below). Offer roll = a deterministic catalog FILTER by the
  encounter's rune/tier (sub_141E62380), source persistent pre-open -> TASK-70 "compute without opening" is
  feasible (static RE done, needs one live probe; handoff/TASK-70-REPORT.md + phaseA-probe.js).
- **Mire fixation** = the bot restored a boss belief @(978,1480) from an earlier BossArenaBlocker sighting, but
  NO boss entity is there now (live-proven: only a plain Checkpoint_Endgame @(1210,1483)). It rammed the ghost,
  wall-slid on bridge terrain. (I tried removing BossArenaBlocker from the anchor list -> user said KEEP it -> REVERTED.)
- **Mire "can't explore the unexplored south"** = navigator model.unroutable is PERMANENT; a wall-slide stuck
  poisons a whole region's centre into it -> "no frontier regions" while fog remains. + the boss belief outranked
  regions so it never explored.
- **Mire "ignores content, blind-explores"** (live-proven, the key one): 94 content entries incl. a Strongbox
  cluster + live Abyss (AbyssFinalNodeBase @1185,1392) sat ~150-200u away, but the ARBITER's boss-defer-spent
  keeps only <=ARB_GRAB_DIST content eligible and defers the rest to POST-BOSS cleanup -- and the boss is an
  unreachable ghost so post-boss NEVER comes -> deadlock -> blind fog.
- **Radar semantics** (bridge-proven): radarFindPath NULL for far targets = STREAMED-ONLY coverage, NOT
  unreachable. macro handles far; the wall-slide is macro being elevation/bridge-blind (deeper follow-up).
- **DC** = the known AV-storm/cogwheel class (jmrpoe2.dll+0x25CCFF ~49/sec all session; [[poe2-driver-reset-freeze]]).
  My Show-Debug-Tools overlay adds an uncapped scan -- turn Debug Tools OFF removes that variable.

## FIXES SHIPPED THIS SESSION (ALL runtime + C++, UNCOMMITTED unless noted)
C++ (c:/Games/jmrpoe2, staged):
- getExpedition2Offered() rewrite (deterministic UI-tile read) — **LIVE-PROVEN** (Sanctuary: SELECT idx243 ->
  HAMMERED -> encounter). getMinimapIcons() binding. Both need the user's rebuild (they DID rebuild+inject once).
mapper.js:
- Abyss sweep-reopen (new site un-latches abyssSweepDone) + minimapIconFeed (icon 891 chests) [TASK-60/63].
- Breach registry (_breachRegSeen accumulate, getMapContent stream-bound) [TASK-61].
- TASK-64 EXCLUDED_MAP_CONTENT=['Ritual','Delirium'] atlas ban (chB stat 26739=Ritual etc.).
- Verisium: open-approach relax (exp2OpenApAt), offer-read FAIL diagnostic, loot-claim fix (enter loot UNLOOTED).
- Delirium walk-THROUGH + retention (DELIRIUM_THROUGH_ON, ~L12300).
- Breach wall-path latch (breachSweepStep + _breachLineClear ~L3046: navTo BFS around walls, latched).
- Posture HP-aware back-out (~L2678: _hpFrac<0.75 -> _boU=42 kite, else 20 stand+fire).
- False-stuck clock fix (stepPathWalker ~L9457: _wkLastStepAt, ADVANCE by paused gap not reset — 10-lens finding 1).
- ~~Boss-unreachable content-defer override~~ **REVERTED — the 2-expert review NO-GO'd it (correctly). It targeted
  the WRONG distance band: the stranded Mire content was 150-200u = INSIDE ARB_GRAB_DIST(260), which the near-only
  clamp NEVER excluded, so the fix did nothing for the actual strand. Also not inert (fogBlockedAnchorUntil is an
  overloaded bearing marker set on healthy maps) + TTL-flicker yoyo. Code is back to original. THE REAL FIX is on a
  DIFFERENT gate — see "OPEN / NEXT #2" below.**
- Boss-arena DEBUG line overlay (Show Debug Tools + Draw lines): cyan lines to all boss-arena entities + BOSS-TGT.
navigator.js:
- FRONTIER AMNESTY (_candidates ~L653): clear stale region unroutable-bans when fog remains but all frontiers banned.
  LIVE-PROVEN it now un-fixates: "[Nav] boss objective suppressed 45s (3x stuck) -> objective region committed".

## REVIEWS
- 10-LENS review (done): 4 findings all LOW, verdict GO-TO-COMMIT (no critical regression). Finding 1 FIXED.
- nav-defer-fix-review (2 experts, DONE): **NO-GO -> content-defer override REVERTED.** Both experts independently:
  the Mire strand was 150-200u = INSIDE ARB_GRAB_DIST(260) -> already eligible -> the near-only clamp never touched
  it -> my fix was orthogonal. The content was dropped EARLIER in pickObjective's candidate loop by one of:
  (a) revisitSkip ban @mapper.js:6255 (a path-stall ban set by arbGoal at 6048/6901/7041 when the walk toward it
      stalled on the SAME bridge terrain that blocks the boss), (b) walled-optional skip @6277-6280, or (c) the
      runner goal.run() returning false -> arbTick falls through to the boss/blind-explore. Also flagged: if any
      >260u lift is ever wanted, key it ONLY on fogAnchorLatchActive (the true proven-unreachable latch @18020,
      cleared by a real jsBfsPath probe) NOT fogBlockedAnchorUntil (overloaded, TTL, set on healthy maps), AND gate
      _farUnderDefer's concede @6362 with the same condition or it yoyos on TTL flicker.

## OPEN / NEXT (priority order)
1. **THE MIRE CONTENT STRAND — ROOT-CAUSED + FIXED (2026-07-14 evening, live-probed, awaiting live map test).**
   Live bridge probe WITH the bot mid-Mire: getAllEntities = ZERO content entities streamed, while getMinimapIcons
   (TASK-63 oracle, map-wide + persistent) showed EVERYTHING: 20-icon AbyssCrack trail, AbyssFinalNodeBase nodes
   @(1184,1391) 191u + @(1230,1506), AbyssChestRareWeapons, MartialStrongboxHigh @(1170,1241), Shrine @(1188,1506),
   RitualRune, AND a verisium Expedition2Encounter @(402,1368) 596u never touched. ROOT: contentQueue.clear() on the
   DC re-entry wiped all content beliefs; every re-discovery path (getAbyssNodes/getMapContent) is STREAM-BOUND, so
   the arbiter read pick=boss forever (the revisitSkip theory was secondary -- the queue was simply EMPTY/blind).
   FIX (mapper.js minimapIconFeed): icon-891-with-AbyssNode-path -> seed position-keyed 'abyss:mm-' contentQueue
   entries (terrain-beacon idiom: valve far-walks until the entity streams, numeric-over-icon dedup hands over);
   + [Arb] no-cand drop-reason diagnostic in pickObjective (q/act + per-gate drop counts + 4 nearest with reasons);
   + [MinimapIcon] verisium icon-known-but-unqueued visibility log (seeding verisium needs its own task -- the exp2
   phantom guard vetoes coincident entries and must be exempted for 'mm-' ids first).
2. SOUTH-EXPLORATION: the big unexplored south isn't a region candidate (frontier amnesty helped fixation but the
   south still isn't surfaced). Separate from #1.
3. COMMIT the batch (10-lens said GO; verisium C++ is the crown jewel — do NOT lose it). Both repos. The nav
   frontier-amnesty + boss-suppress DID fix the boss-fixation (live-proven), keep it.
4. Mire bridge WALL-SLIDE: macro/radar can't cross bridges (radar streamed-only). Deeper radar-3D task -- likely
   the shared root under #1 (the path-stall) AND the boss-unreachability.
5. TASK-70 (verisium offers without opening) — static RE done, one live probe to green-light.
6. Dead code from 10-lens findings 2/3 (VERISIUM_STOP_OPEN_ON L5496-98, DELIRIUM_THROUGH_ON L12424-29).
BASELINE: scripts @c2f830b, C++ @18ed777. Runtime has everything above ON TOP, uncommitted. Bridge single-client.

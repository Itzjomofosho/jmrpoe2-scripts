# TASK-44 — Navigator: boss-belief fallback + visit REVEALED-unvisited + kill adjacent-region oscillation

FIRST ACT (HOUSE_RULES): copy `..\navigator.js` AND `..\mapper.js` into `handoff\pre\TASK-44\`.
Files: navigator.js (A/B/C) + mapper.js (A's bus wiring, if needed). If a LIVE BRIDGE read is needed to
find Channel's arena tile name (item A option 1), that half is Opus-with-bridge; the fallback (option 2)
and B/C are pure JS. Repos are COMMITTED: scripts @4cc73e3 (github Itzjomofosho/jmrpoe2-scripts), C++
@11c54ef (Itzjomofosho/jmrpoe2, radar bindings + rebuilt DLL already injected). GIT IS THE BASELINE.

## Evidence (Channel, 21:40-21:42, C:\tmp\log.txt + user screenshot)
The map: boss arena is the big NW square, ALREADY REVEALED on the radar (blue outline). Small fog pockets
remain in the SOUTH. The navigator ran SOUTH — away from the boss — and oscillated between two adjacent
south chunks. Root, one line: `[Nav] boss belief: NONE (patterns matched 0/223 tile keys)`. Three faults:

## A0. THE COMPOUND CONSEQUENCE (why A is P0, not cosmetic)
Boss belief NONE does not just misroute exploration — it means the mapper NEVER ENTERS FIGHTING_BOSS.
Live (Channel 21:39-21:42): the char wandered the boss area as plain "Nav Explore" and got HIT BY THE BOSS
with the ENTIRE survival stack dormant (no standoff, no entry-mobility, no promote-on-hit, no evade — those
only arm inside FIGHTING_BOSS). "You got hit by the boss, FAIL." So a boss-belief miss = the char walks
into the arena defenceless. Fixing A restores both navigation AND boss survival on pattern-miss maps.

## A. THE BLINDNESS — boss belief NONE means no drive to the boss at all
All four belief tiers (arena tgt-centroid / BossRoom marker / stored ckpt / radar) returned nothing on
Channel; the arena tile-pattern matched 0 of 223 tile keys (same CLASS as the old SpringArena_ underscore
bug — a tile-name the `getBossArenaCentroid` pattern doesn't recognize). With no belief, the boss is never
a candidate and the map can only ever be finished by luck of exploration.
FIX (two prongs, do BOTH):
1. FIND CHANNEL'S ARENA PATTERN (bridge, Opus): live-read `getTgtLocations().locations` tile keys on a
   Channel instance, find the arena/boss tile-name family, extend TARGETS_DB `_default.boss` patterns (the
   same table the SpringArena_ fix touched — memory poe2-mapper-bossfind-canyon / the arena-blindness
   lesson). Log the belief source + tiles=N as today so a future miss is visible in ONE line.
2. FALLBACK so a pattern miss can NEVER fully blind us: the map's base-game OBJECTIVE bitfield already
   knows there is a MapBoss and (often) its area. When arena-centroid is NONE but a MapBoss objective
   EXISTS (mapObjectiveExists('MapBoss') — the read TASK-29F used), derive a boss BEARING/belief from the
   best available signal (BossRoom marker if any; else the map's largest revealed-but-unvisited region as
   a low-confidence boss-direction anchor) so exploration is at least aimed toward where the boss must be,
   not away from it. Low confidence (< NAV_BOSS_CONF_MIN) = a DIRECTION bias, not a commit target — see B.

## B. VISIT REVEALED-BUT-UNVISITED (the NW square problem)
The navigator explores UNREVEALED fog (getUnexploredBuckets). Channel's NW is REVEALED (radar-mapped) but
UNVISITED — the char never walked there — so there is zero fog there and zero drive to go. The boss sits in
that revealed-unvisited area. FIX: add a candidate class for LARGE revealed-but-unvisited regions: read the
radar/reveal grid (or the trail-visited overlay's inverse against revealed terrain) to find connected
areas that are revealed but carry no visited-trail, cluster like frontier regions, score them as explore
candidates (below required content, comparable to fog frontier). This is what makes "the boss is in the
revealed NW, GO THERE" happen even with belief NONE. Const `NAV_VISIT_REVEALED_ON = true`.
(Design note: fog-frontier + revealed-unvisited together = "cover the whole map"; today only fog is driven,
which is why a fully-revealed-but-unwalked wing is invisible to explore.)

## C. ADJACENT-REGION OSCILLATION (a real bug regardless of A/B)
Live: `region@(1091,935)` <-> `region@(893,935)` chunk-stepped back and forth (21:41:10 / 21:42:06 /
21:42:11 ...). Two centroids ~200u apart that are ONE connected area got split into separate regions, and
the chunk-step + hysteresis let them trade the commit. FIX: (1) the region clustering link distance is too
tight for this map's bucket pitch — verify NAV_REGION_LINK_MULT merges these; (2) a just-completed/departed
region must not be immediately re-picked as a sibling (a short per-region cooldown after a chunk-step away,
OR fold the sibling into the committed region's disc so it is the incumbent, not a challenger — the same
disc-scoping used for mass). Log the merge/dedupe.

## Honest framing for the implementer
The navigator (TASK-39/40) is committed and is a real improvement on OPEN terrain (radar routing works,
commitment holds). Its gap is CLOSED/REVEALED maps where the boss is known-to-a-human-from-the-minimap but
invisible to the belief tiers. A/B close that. Do NOT rewrite the navigator; these are additive candidate
sources + one clustering fix. NAV_ON=false remains the full rollback.

## Hard limits
- navigator.js primary; mapper.js only for A's bus (getTgtLocations/objective read already exist there —
  wire them to the nav bus like getContentQueue/getArenaCentroid). No new movement mechanism. Every new
  behavior flag-gated (NAV_VISIT_REVEALED_ON; A2 fallback behind its own const); flag-off = today's nav.
- Reuse: TARGETS_DB (A1), mapObjectiveExists (A2), the region clustering + disc-scope (B/C), radar/trail
  overlays (B). No raw memory writes; A1 bridge read is READ-ONLY.

## Acceptance
- `node --check` both; parity walk with the new consts off.
- Live checklist (Channel is the acceptance map): `[Nav] boss belief:` resolves to a real source OR a
  logged low-conf fallback bearing (never a bare NONE that strands exploration); the char drives toward the
  NW revealed area and reaches the boss; no south-chunk oscillation (one region commit, no A<->B trade);
  a normal open map is unchanged (regression check).

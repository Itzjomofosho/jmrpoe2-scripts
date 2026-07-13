# TASK-55 — Boss-defer-spent silently starves near content + sweep-layer A<->B swaps + mirror never detected

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-55\`. File: mapper.js ONLY. USE OPUS 4.8.
SEQUENCING: after TASK-51 and TASK-54 land. Evidence: C:\tmp\log.txt (Port 16:07-16:10, Grimhaven 15:5x,
2026-07-13); settings confirm deliriumMirrorEnabled=true.

## A. BOSS-DEFER-SPENT IS A SILENT PERMANENT LATCH THAT STARVES NEAR CONTENT
Live: verisium:1 ACTIVE in the queue 16:07-16:10+ (3+ min), never claimed, never path-order-noted; every
pick logs `[ArbShadow] pick=boss committed=-`. Root: `if (_bossDeferSpent) return { kind: 'boss' }` in
pickObjective — NO log line, and once arbBossDeferSpent latches, ALL pre-boss content is refused until
post-boss cleanup, invisibly.
FIX (flag `ARB_DEFER_SPENT_GRAB_ON = true`):
1. LOG the latch ONCE when it first flips: `[Arb] boss-defer budget spent -> content deferred to post-boss`
   (and once per 60s while content sits active-but-refused, name the nearest refused key).
2. USER RULING (standing, ARB_GRAB_DIST): content within ARB_GRAB_DIST (260u) of the player is ALWAYS
   eligible — "it's right there" beats the spent budget (the budget exists to stop FAR chases). The
   defer-spent early-return must still run the candidate scan for <=260u entries and claim the best one;
   only farther content defers to post-boss.
3. Report WHY the Port verisium never got path-order-noted (was it ever within 260u / onroute? if genuinely
   far off-route the post-boss cleanup owning it is correct — say so).

## B. SWEEP-LAYER INTRA-LAYER SWAPS HAVE NO COMMITMENT HOLD (the A<->B yoyo)
Live: `[OB] complete sweep:144x108 (layer-swap) -> claim=sweep:149x99` then BACK to 144x108 14s later;
sweep<->sweep swaps every ~10-15s through 16:08-16:09 while rares/stone/boss-walk interleave = the visible
yoyo. TASK-43 A's OB_CONTENT_HOLD_ON protects the CONTENT layer only.
FIX: extend the same hold to the sweep layer (flag `OB_SWEEP_HOLD_ON = true`): a committed sweep site holds
until done/failed/stuck — a sibling sweep site may not take it by ins jitter; same defer-never-ban shape,
same engaged signal (the sweep's own site head). Reuse the 43-A code path — do not fork a second hold
implementation if a layer parameter suffices.

## C. DELIRIUM MIRROR: the handler's 200u reach bubble makes off-path mirrors invisible (NOT drift)
PLANNER LIVE-VERIFIED (bridge, Port 16:1x): poe2.getMapContent() is healthy (86 entries, types intact);
Port has no Delirium content — the binding is NOT drifted. The real hole, from findDeliriumMirror
(~11653): acquisition reach = DELIRIUM_REACH 200u (500u only in the first 30s via mapStartWallAt), and
delirium NEVER gets a contentQueue entry — so a start-spawned mirror that the opening moves leave >200u
behind is silently invisible forever (no log possible: to the handler, nothing existed). That is exactly
the Grimhaven skip. The user believed this "fixed" because it WORKS whenever the mirror sits on the
opening path.
FIX (flag `MIRROR_START_COMMIT_ON = true`):
1. MAP-START MIRROR COMMITMENT: during the first 60s of a map (mirrors are start-spawned by design), if
   deliriumMirrorEnabled and getMapContent lists ANY Delirium piece at ANY distance, log
   `[Mirror] start mirror at (x,y) Nu` and COMMIT to it like content (walk + step in via the existing
   handler machinery, its owned-progress cap and blacklist unchanged) BEFORE the opening fight/explore can
   carry the char out of range. After the 60s window / consumption / blacklist, today's 200u behavior.
2. Keep the instrumentation half: `[Mirror] detected...` on first sighting and (toggle on + Delirium listed
   by the objective row + nothing found for 30s) -> `[Mirror] listed but NOT detected` once — so any FUTURE
   real drift names itself.

## Hard limits
- mapper.js only; A/B/C independently flagged; flags off = today byte-parity. A must NOT touch the budget
  mechanics themselves (only the spent-state's treatment of <=260u content). B reuses 43-A's hold logic.
  node --check; TEST BEFORE COMMIT.

## Acceptance
- A map with near content + spent defer budget: the latch logs once, <=260u content still gets claimed and
  run pre-boss; far content defers with a visible line.
- No sweep<->sweep A->B->A swaps (hold-deny log appears instead).
- The next mirror map either drives the mirror or names exactly why in one log line.

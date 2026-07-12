# TASK-39 — THE NAVIGATOR (EXPLORE-REDESIGN 26A+26B in one task) — "you're bandaiding, not fixing"

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-39\`. Files: NEW `navigator.js` +
`mapper.js` (integration + persistence only).
READ FIRST: `handoff/EXPLORE-REDESIGN.md` — it IS the design; this brief only scopes and sequences it.
Evidence for why shadow-mode is skipped: Cliffside 18:43-18:45 — the explore HEADING changed 8 times in
90s ((668,1358)->(552,1093)->(668,1056)->(401,1358)->(529,1139)->(541,1127)->(401,1358)->(668,1358)), a
new heading rolled at nearly every 'landmark reached'. Three shim layers (forward bias, corridor latch,
S5 bans) sit under that churn and cannot fix it. The disease is goal churn; the fix is ONE plan.

## Scope: 26A skeleton + 26B flip, one flag
Build `navigator.js` per the redesign doc's section 4, and flip the FINDING_BOSS explore decision onto it
behind `NAV_ON = true`. The ENTIRE legacy explore stack stays intact and byte-parity when `NAV_ON = false`
(the rollback). 26C (discover/coverage) and 26D (legacy deletion) stay future tasks.

## navigator.js (module #1 of the split)
1. WORLD MODEL (one object, THE sidecar payload):
   - macro tile-graph handle (poe2.macroPathTo / the C++ graph — do not rebuild it),
   - revealed/visited overlay (subsume the trail reads — consume, don't duplicate),
   - POI set: quest markers + contentQueue entries (positions/types/states). (The map-wide sleeping-entity
     feed joins later via TASK-38 — leave one clean insertion point.)
   - boss belief: arena centroid / BossRoom marker / bearing hints, with the MANDATED log —
     `[Nav] boss belief: <src> centroid=(x,y) tiles=N` or `[Nav] boss belief: NONE (patterns matched 0/N)`
     — a blind map must be visible in ONE line (the SpringArena_ lesson).
   - BLOCKED-EDGE facts: a stuck leg / failed route writes `edge A-B impassable` into the model,
     PERMANENT for the map. Never a TTL ban that gets re-learned from another angle.
2. OBJECTIVE — exactly ONE committed destination, chosen by ONE scoring function over {boss belief, POIs,
   frontier REGIONS}, with hysteresis (a challenger must beat the incumbent by a margin AND persist across
   2 evaluations before a switch; objective completion/invalidations switch immediately).
   CHUNK EXPLORE (the user's ruling): frontier objectives are connected REGIONS of unexplored mass, not
   buckets — commit to one region, explore until its remaining mass < threshold, then pick the next
   (forward/nearest). Bucket-flitting dies by construction.
3. PLAN — waypoint route computed ONCE on commit (macro graph + frontier extension across fog).
   RE-PLAN ONLY ON EVENTS: leg stuck (write the blocked edge FIRST, then re-plan), objective
   completed/invalidated, a major reveal contradicting the plan, preemption end. Never per-tick.
4. EXECUTION INTERFACE — the navigator OWNS decisions, never movement: it exposes
   `navCurrentWaypoint(player)` (+ leg bookkeeping) and the mapper's existing walker/senders execute.
   Dodge/MB/OB/[Ckpt]/content yields all work unchanged on top — to them the navigator is just a very
   consistent explore-target chooser.
5. LOGGING (load-bearing): `[Nav] objective <kind>@(x,y) committed (score S, over N candidates)`,
   `[Nav] leg i/N -> (x,y)`, `[Nav] replan (<event>)`, `[Nav] blocked edge (a)-(b) recorded`, the boss-belief
   line, and `[Nav] objective switch <old> -> <new> (reason)` — every switch must name its cause.

## mapper.js integration (26B)
- In FINDING_BOSS explore frames (and ONLY there — this task's flip): `NAV_ON` routes the walk target
  through the navigator; `pickUnexploredHeading`/`getExploreLandmark`/bucket-authority/corridor-latch are
  not consulted on those frames. `NAV_ON=false` = today's stack byte-for-byte.
- Preemptions (content [Ckpt] yields, engage, utility, dodge) behave exactly as today — on return the
  navigator's plan is still there (that is the point).
- Persistence: the world model rides the existing map_state sidecar (save/restore with the established
  envelope rules; blocked edges + boss belief + objective survive reload).
- The stuck/dislodge watchdogs stay live as the safety net; a dislodge event feeds `leg stuck` -> blocked
  edge -> replan instead of a target re-roll.

## Hard limits
- Content runners, OB/MB, opener/pickit, dodge, boss-fight machinery: UNTOUCHED. The navigator decides
  where to explore; it never sends packets.
- No new native bindings; consume existing reads (macroPathTo, markers, trail, contentQueue).
- navigator.js is a proper module (imports like the other files); no circular imports (mapper imports
  navigator, never the reverse — bus pattern if the navigator needs mapper state).
- Perf lens: model updates throttled; the whole point is that per-tick picker bursts DISAPPEAR — the
  25-40ms mapper frames at pick moments in tonight's log are part of the indictment.

## Acceptance
- `node --check` both; parity walk with NAV_ON=false.
- Report per HOUSE_RULES with the objective-scoring description + every deviation from EXPLORE-REDESIGN.md
  flagged. Live checklist (Cliffside is the acceptance map): heading/objective changes ONLY on named events
  (log-auditable — zero unexplained switches); no direction reversals while an objective is committed;
  boss found + engaged; blocked edges accumulate instead of repeat-learning (the same wall never banned
  twice); [Ckpt]/content yields still fire; mapper frame times at former pick moments visibly down;
  reload mid-map -> model restores (belief + blocked edges + objective) and the walk resumes coherently.

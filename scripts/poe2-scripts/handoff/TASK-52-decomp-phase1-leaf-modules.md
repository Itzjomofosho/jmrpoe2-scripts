# TASK-52 — Mapper decomposition PHASE 1: extract the four leaf modules (pure moves, zero behavior change)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-52\`. READ handoff/MAPPER-DECOMP-PLAN.md
FIRST — it is the constitution for this work. USE FABLE (the user's explicit call: this pass sets the
pattern every later extraction copies).
SEQUENCING: fire ONLY after TASK-51 lands AND the planner confirms the stack is COMMITTED (a decomposition
must start from a git baseline — rollback per-step is the safety rail).

## The job
Extract FOUR leaf modules from mapper.js, one at a time, in this order, as PURE MOVES:
1. `targets_db.js` — TARGETS_DB + densestClusterCenter + getBossArenaCentroid's tile-matching core
   (the poe2.getTgtLocations read + pattern match + cluster; the mapper keeps a thin cached wrapper).
2. `visited_trail.js` — visitedTrail state + trailHas/trailLineFrac/trailNextPatrolAng + the segment
   recorder. OWNS its state; exports serialize()/restore()/reset() and mapper's resume envelope calls them
   (mirror navSerialize/navRestore wiring). The nav bus accessors (trailHas/trailLineFrac) re-point here.
3. `movement_broker.js` — the MB object + its constants. Every mapper call site imports it.
4. `map_audit.js` — the audit-file IO (mapAudit + its open/flush latches). logMapSummary STAYS in mapper
   (it reads queue state); only the file-writer moves.

## Rules (from the plan — repeated because they are the review criteria)
- PURE MOVE: code moves verbatim — no renames, no reformats, no "while I'm here" fixes. A bug noticed
  mid-move goes in the report as a NOTE, never an edit.
- BUS PATTERN: a module NEVER imports mapper. Dependencies go in as configure({...}) accessors or call args.
  If a candidate function reaches into mapper state you can't cleanly pass, STOP on that function, leave it
  in mapper, and say so in the report (a partial clean extraction beats a total tangled one).
- Each module: ES module exporting exactly what mapper consumes today (grep proves every moved symbol exists
  exactly ONCE after the move). mapper.js imports at the top with the existing import style.
- Serialization: visited_trail is the only Phase-1 module with persisted state — its serialize/restore must
  produce byte-identical envelope content to today's (same keys, same shapes).
- After EACH module: node --check mapper.js + the new file; then move to the next. All four in one task, but
  the report documents each as its own section with its own symbol inventory.
- NO flag gates — a pure move has no behavior to gate. The rollback is git (per-module sections in the diff).

## Acceptance
- node --check on all five files; every moved symbol greps to exactly one definition; mapper.js shrinks by
  roughly the moved line count (state the before/after line counts per module).
- Live smoke (user): one full map with trail overlay visibly recording, radar/nav routing normal, an audit
  line written at map end, MB arbitration logs unchanged in shape. Any behavioral diff = the move was not
  pure -> the planner reviews that module's diff hunk-by-hunk.
- Report: per-module symbol inventory (functions/state/consts moved), the bus accessors each needed, and
  any function DELIBERATELY left behind with the reason.

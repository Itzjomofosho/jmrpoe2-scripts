# TASK-59R — REFACTOR (not extraction): one movement owner. Intents in, ONE resolver out, legacy writers deleted.

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\navigator.js` into `handoff\pre\TASK-59R\`.
USE FABLE — this is the VERY HARD task the routing rule reserves it for. The user's directive: DON'T
extract-verbatim; REFACTOR. Rollback = the pre-snapshot copies (no flag can gate a structural change).
TASK-59 (pure-move extraction) is CANCELLED — ignore its brief.

## Why this refactor, first
Every yoyo this week — Nav<->chase alternation, checkpoint<->utility flaps, sweep swaps, discover dual-
writer, posture-vs-reach, boss-walk-vs-engaged — is the same structural fact: MOVEMENT HAS NO SINGLE OWNER.
startWalkingTo/moveToward/navTo/sendStop are called directly from ~9 subsystems, and every anti-yoyo rule
we shipped (43-A hold, 47-B engaged, 53-A reach-yield, 56-A arb hold, 58-core chase gate...) is a bilateral
patch between two of them. Refactor the OWNERSHIP once and the class dies.

## The shape
1. `movement_intents.js` (new): submitIntent({owner, kind, x, y, pathType, priority, reason, sticky}) —
   collected per frame. ONE resolve(now) picks the winner under the EXISTING rule set, consolidated:
   dodge/panic > fight > engaged-content > committed content (43-A hold semantics) > utility-committed
   (48-B pair) > nav/explore > idle. Hysteresis/min-dwell/defer-never-ban live HERE once. The resolver is
   the ONLY caller of startWalkingTo/stepPathWalker/sendStop* (the walker fns stay in mapper for now —
   Phase 4 moves them; this task changes WHO calls them).
2. Convert every walking call site to an intent submission. The per-frame winner executes; losers get
   their existing defer semantics (they already re-submit next frame by construction).
3. DELETE (not move) the paths today's rules already superseded, each named in the report with the rule
   that replaced it: the legacy FINDING_BOSS explore block (nav owns explore; keep only a thin nav-null
   >3s fallback that submits a frontier intent), the S5 white-chase (58-core hotfix made it magic+-only —
   fold that INTO the intent priority instead of a scan filter), duplicated stop/plant calls inside runners
   that the resolver now owns.
4. The bilateral gates (43-A/47-B/53-A/56-A/58-core and the [OB] shadow bookkeeping) collapse into resolver
   rules; their log lines keep firing with the same text where feasible (the user reads these logs; the
   forensics vocabulary must survive). The OB shadow ledger keeps recording — it becomes the resolver's
   OWN ledger rather than a parallel observer.
5. Runners/posture/dodge internals are NOT rewritten — they keep their logic and only lose their direct
   movement calls. Dodge keeps its hard priority exactly as today (MB p1 semantics).

## Discipline
- Work in COMPILABLE increments: resolver first (shadow mode: log what it WOULD pick vs what happened,
  one map of shadow logs if the user can run one mid-task), then convert subsystems one at a time,
  deleting each legacy path as its intent replaces it. node --check after every increment.
- Anything you cannot convert cleanly, leave on a direct call + list it in the report's "unconverted
  writers" table — an honest partial beats a broken total. The report MUST contain: intent table (owner ->
  priority/reason), deleted-path list with superseding rule, unconverted writers, and the log-line mapping.
- Perf: the resolver runs per logic frame — zero new scans; intents are built from state the callers
  already had.

## Acceptance (live, user)
- One map end-to-end: no opposite-direction walk pairs within 5s anywhere in the log; every walk line
  names its owner; content completes as today or better; dodge latency unchanged (rolls still instant).
- The resolver's pick log replaces the [MB] BLOCK spam with one readable line per contested frame.

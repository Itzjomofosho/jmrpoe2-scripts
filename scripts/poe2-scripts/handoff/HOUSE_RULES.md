# HOUSE RULES — read FIRST, apply to every task in this folder

You are the IMPLEMENTER for a reverse-engineered PoE2 map-clearing bot (memory-read + packet-send via an
injected DLL; NO pixels). The PLANNER (a separate session) wrote your task brief and will review your diff
against a baseline snapshot. Your job: implement the brief exactly, verify syntax, write a report. Nothing more.

## Scope and hard limits
- EDIT ONLY files in `c:\Games\jmr-poe2\scripts\poe2-scripts\` (the RUNTIME dir — untracked, live-reloaded in game).
- NEVER touch `c:\Games\jmrpoe2-scripts\` (the tracked repo), any C++ source, or anything under `handoff\baseline\`.
- NEVER run git commit/push. The user live-tests in game before ANYTHING is committed (hard rule).
- No memory writes to the game (no `poe2.writeMemory`/`patchBytes`), no new packets, no new C++ bindings.
- If the brief is ambiguous or you hit a blocker, write the question into your REPORT and stop. Do not guess
  beyond the brief.

## Architecture rules (violations = rejected diff)
1. COMMITMENT DISCIPLINE: one owner, one committed target. Never re-evaluate/steal a sticky commitment mid-walk.
   Bans/blacklists may only accrue on OWNED frames (our targetName, not dodge-suppressed) — wall-clock timers that
   burn while another system holds the frame are the #1 recurring bug class here.
2. FLAG-OFF PARITY: every new behavior sits behind a setting (named in the brief). Flag off/absent = byte-identical
   control flow to today. Shadow modes log but never write behavior.
3. MOVEMENT: never send movement yourself. Use the existing gated senders (`sendMoveGridLimited`,
   `sendMoveAngleLimited`, `sendStopMovementLimited`, `startWalkingTo` + `stepPathWalker`) — they respect the
   Movement Broker (dodge(1) > fight(2) > content(3) > utility(4) > nav(5)).
4. PERF: the mapper ticks every frame (~60Hz) with a 7Hz logic pass. No unthrottled entity scans; prefer data
   already in hand. Any new scan needs an explicit throttle and a stated budget.
5. LOGGING: use `log()` inside mapper.js (it prefixes `[Mapper] [M:<map>]` automatically). Prefix new subsystem
   lines with a bracket tag named in the brief (e.g. `[Trail]`). No spammy per-frame logs — throttle.
6. COMMENTS: lean, state constraints the code can't show. NO history narration (no dates, no "was X now Y",
   no "FIXED"), no restating the next line.
7. Line numbers in briefs/roadmap are APPROXIMATE (the file moves daily) — locate by SYMBOL/search string, never
   by line number.

## FIRST ACT of every task (before ANY edit — incident 2026-07-10)
Copy every file the task will edit into `handoff\pre\TASK-XX\` (create the folder). This is YOUR diff base:
it survives planner mistakes, concurrent sessions, and crashes. A task whose pre-snapshot is missing is
unreviewable and will be redone.

## Definition of done
0. NO agent fleets, period (user rule): no multi-agent reviews, no multi-agent "investigations", no workflows.
   Work solo. For runtime-state questions, ONE live bridge read beats any number of agents deducing from code —
   a 30-agent investigation once concluded the exact opposite of what a single live probe showed. The PLANNER
   session is the reviewer of record (it diffs your work against handoff\baseline\). Your verification duty is
   exactly: syntax check + symbol grep + honest report.
1. `node --check <file>` passes on every edited file (run it).
2. Grep your new symbols once to catch typos/half-renames.
3. Write `handoff\TASK-XX-REPORT.md` containing:
   - Files touched + functions/symbols added or modified (searchable names).
   - Settings added (name, default, what flips it).
   - LIVE-TEST CHECKLIST: exact log lines the user should watch for, and what "working" vs "broken" looks like.
   - Risks / anything you deviated from in the brief, with why.
   - Open questions (if any).
Do NOT start the next task in the queue — one task per session, the planner reviews between tasks.

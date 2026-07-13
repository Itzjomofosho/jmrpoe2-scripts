# TASK-56 — The arbiter's own drives ignore engaged content + shrine commit-click never verifies collection

FIRST ACT (HOUSE_RULES): copy `..\mapper.js`, `..\opener.js`, `..\auto_dodge_core.js` into
`handoff\pre\TASK-56\`. USE OPUS 4.8. SEQUENCING: after the TASK-52 decomposition Phase 1 lands (or before
it if the planner reorders — never concurrent). Evidence: C:\tmp\log.txt (Forge 17:46-17:50, 2026-07-13).

## A. THE ENGAGEMENT HOLE: 47-B gates rares/utility/sbox — but not the ARBITER'S OWN drive
Live: 17:48:18 `[ArbShadow] pick=boss committed=-` WHILE `[Engaged] utility start deferred (verisium
engaged)` — the engaged gates held utility/rares off an engaged verisium while the arbiter itself drove the
char to the boss checkpoint, abandoning the encounter (53-C's stale-far retire then killed the phase).
FIX (flag `ARB_ENGAGED_HOLD_ON = true`): pickObjective/the drive dispatch consults engagedContentAnchor()
FIRST — while content is engaged (reached, per 53-C's gate), the pick is THAT content (or a hold at it),
never boss/explore/another content. Same defer-never-abandon shape as every other gate; the encounter's own
caps (fight/total timeouts) bound the hold, so no livelock. Also audit: the boss-defer-spent near-grab
(55-A) and fresh picks must both respect it. State every dispatch path gated.

## B. SHRINE COLLECTION NEVER VERIFIED (opened != collected) + hostile-shrine hazard family
Live: 17:47:01 `[Opener] Opened Shrine (41.2u) commit-click` — but the buff needs the TOUCH; the auto-walk
was contested and nothing checks the shrine went untargetable/consumed. User: "DIDNT get the shrine."
FIX (opener.js, flag `SHRINE_COLLECT_VERIFY_ON = true`): after a Shrine open/commit-click, if the shrine is
STILL targetable after ~3s, it was NOT collected -> clear its cooldown for an immediate re-approach (the
commit-click machinery re-fires; the anti-repeat cap still bounds a genuinely unreachable one). A shrine
that went untargetable = collected (today's assumption, now checked).
+ auto_dodge_core.js, one classify row: the Farudin culture-shrine's lightning storm
(`Environment/shrine/lightning/lightningstorm_trackingbolt`) -> AVOID (six of them tracked the char at
15-27u in the dump). Do NOT classify the shrine entity itself (it's an openable), only the storm ao.

## C. FLIP-WATCH TRUSTS A STATUS READ ON A DE-STREAMED NODE (falsely "completes" far abysses)
Live (Forge 17:46:01-03): abyss:799 committed, char 441u AWAY, walking -- 2s later
`[AbyssSweep] flip-watch (paused-completion, runner never dwelled) -> chest site queued` + `node 799
completed while runner paused`. NOBODY was near the node: abyssNodeStatus on a far/de-streamed entry
returned a garbage 'done'. The OLD committed-node exclusion accidentally masked this; TASK-51 A exposed it.
Cascade: false completion -> phantom 441u chest site -> sweep walks/fails/retires/latches done
(abyss-chest 0/1) -> later abysses read falsely found (summary `abyss 2/2 found (game lists more, unfound)`
-- BOTH were false completions).
STATUS: the guard is PLANNER-IMPLEMENTED (hotfix 2026-07-13 ~18:00, FLIP_TRUST_R=150 in abyssFlipWatch:
far entries are not probed at all, hold last state; grep 'PLANNER HOTFIX'). Do NOT re-implement. YOUR half:
(1) VERIFY the hotfix (parity shape, the paused-completion close case still fires), and (2) AUDIT
abyssNodeStatus -- WHY did it return 'done' for a de-streamed entry at 441u (stale pointer? recycled slab?
default branch?) -- that read is used elsewhere (the runner's done-detection, the sweep probe) and every
consumer needs the same trust rule if the root is the read itself. Fix consumers you can prove unsafe.

## D. THE B2 CONCEDE FIRES MID-WALK: discoverLastHeadingAt is never credited on a SUCCESSFUL heading
ROOT CAUSE PROVEN (Forge 17:53:09-17:54:13, full log): discover drove correctly the whole window (headings
committed 17:53:11 / :28 / :56, JS paths closing 97->61->31->18wp toward the unfound abyss). But the
TASK-49 B2 revealed-map concede reads `now - discoverLastHeadingAt > 8000`, and NOTHING refreshes
discoverLastHeadingAt when a heading SUCCEEDS -- it was stamped once at the first null pass (17:53:09
radar-ban) and never again. The SECOND null pass (17:54:09, lazy-validate banned that pass's winner ->
null) instantly read "8s+ sustained miss" and conceded MID-WALK (`no fog frontier + no routable mass ->
conceded` while an 18wp route was actively closing). The concede released the anti-guillotine -> 4s
fast-out -> `leaving anyway` -> 45s of standing at the portal spot -> portal with the abyss unfound.
FIX: stamp discoverLastHeadingAt = now on EVERY successful heading commit (marker walk, bucket pick,
patrol replacement -- all of them), so the 8s window measures a REAL sustained failure-to-produce-headings,
not the gap between two unrelated null passes. Also: a null pass while the CURRENT walk is still closing
(sticky target progress within the last ~5s) must not count toward the concede at all -- an active walk IS
a heading. One-line-class fixes; verify against the Forge sequence in the report.
ALSO note: `[Nav] hv anchor +shrine@(879,1692)` fired AT the leave verdict -- anchors fed during the leave
window are dead on arrival; harmless, but state whether the leave-gate should drain a just-fed nearby
anchor (planner leans NO -- the portal decision stands; do not implement, just opine).

## E. ABYSSAL DEPTHS: the sub-area entrance masquerades as an unfound abyss (hunt is unwinnable)
Live (Backwash 18:03): map's Abyss bit incomplete because the remainder IS the Abyssal Depths SUB-AREA
(parked capability -- we don't enter). Discover walked its /Abyss/ marker in a loop against the portal
phase ("yoyod and opened port and YOYOD"). PLANNER HOTFIX already excludes the Depths marker from the
marker-first pick (grep 'PLANNER HOTFIX', ~7178) -- but the unfound-abyss HUNT itself still runs (now via
fog buckets, up to the 90s confirmed window) and is unwinnable on these maps.
FIX: when the map has an AbyssalDepths entrance (marker path or the entrance entity) AND the abyss bit is
incomplete AND no other abyss evidence exists (no nodes in queue/scan), treat abyss as NOT-HUNTABLE this
map: discover skips the type (one log line: `[Discover] abyss remainder is the Depths sub-area -> not
huntable`), the cleanup ban-wait doesn't hold for it, the summary tail says `(remainder: Abyssal Depths,
unsupported)`. When the Depths capability lands someday, this gate is where it plugs in.

## Hard limits
- A: the gate consults the EXISTING engagedContentAnchor — no new engagement state; the encounter caps stay
  the bound. B: opener re-verify + one table row. C: a read-trust guard on the flip verdict — do NOT touch
  the 51-A dwell-gate logic itself. D: trace first, fix the named path — no speculative rewrites of the
  cleanup gates. All flagged; off = today byte-parity. node --check all. TEST BEFORE COMMIT.

## Acceptance
- Engaged verisium: no `pick=boss` while engaged (hold line instead); encounter completes, THEN boss.
- A contested shrine commit-click re-approaches until collected or capped; the lightning-storm family gets
  danger zones.
- No flip-watch completion for a node with no live entity + player >150u (the 441u phantom is impossible);
  abyss chest counts stop lying.
- Forge-class post-boss: unfound content -> discover visibly drives or visibly concedes; `leaving anyway`
  can only follow a logged concede.

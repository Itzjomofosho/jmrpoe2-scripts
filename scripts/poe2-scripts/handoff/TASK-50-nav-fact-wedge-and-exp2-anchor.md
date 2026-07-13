# TASK-50 — Navigator fact-wedge (one blocked cell bricks the map) + Exp2 loses the encounter post-activation

FIRST ACT (HOUSE_RULES): copy `..\navigator.js` AND `..\mapper.js` into `handoff\pre\TASK-50\`.
Files: navigator.js (A) + mapper.js (B). USE FABLE. SEQUENCING: if TASK-49 is in flight/unfired, run 49
first or state clearly which landed first — both touch mapper.js. Evidence: C:\tmp\log.txt (Mire,
2026-07-13 14:06-14:10) — the char STOOD STILL for minutes on a mostly-unexplored map.

## A. THE FACT-WEDGE (navigator.js): one blocked-cell fact vetoes EVERY plan, forever, with no appeal
Live chain:
- 14:06:47.961 `[Nav] blocked edge (519,1196)-(567,1334) recorded (leg stuck; 1 facts)` — earned DURING the
  contested verisium approach (posture back-outs + mobs stealing movement; a stuck+dislodge fired 26s later
  on the same ground). The _fighting guard (lastRotationCastAt<2000) did NOT stop the record — find out why
  (first deliverable: name the exact path that recorded it and which guard failed/was missing).
- From then on, EVERY candidate: `plan for poi:...` / `poi:ckpt` / all FOUR region entry doors / `rv:6:6`
  -> `crosses blocked cell 11:26 -> next candidate` -> `all candidates unroutable -> backing off 4s`,
  looping for minutes. A second fact (12:18) joined. On Mire's bridge-weave, one 48u cell sits on the ONLY
  corridor -> permanent full veto = the char stands still while the map is unexplored.
FIX (three prongs, all in navigator.js):
1. FACT-EARNING JUSTICE: leg-stuck fact recording gets the owned-frames discipline (TASK-47's pattern):
   no record when movement was recently stolen (dodge suppress, posture/back-out bus, MB writer above nav,
   or an OB-paused commitment) — mirror runnerSpanStolen's signal set, not just lastRotationCastAt. State
   why the existing guard missed this record.
2. VETO-STORM AMNESTY: when ALL candidates are unroutable and >=1 veto names a blocked cell/edge fact, the
   common-denominator fact(s) are SUSPENDED (removed with a re-earn allowed) and a replan runs immediately:
   `[Nav] fact 11:26 caused a full veto -> amnesty (re-earnable)`. A genuinely-blocked route re-earns the
   fact within one leg (bounded oscillation: an amnestied fact that re-earns 2x becomes exempt from amnesty
   for 5min — it is probably real); a FALSE fact un-bricks the navigator in one cycle. The backoff loop must
   never survive two consecutive full vetoes without an amnesty attempt.
3. ROUTE-AROUND: before vetoing a candidate whose MACRO route crosses a blocked cell, try the radar route
   (poe2.radarFindPath — different grid, full-res, may legitimately route around the cell). Radar route
   clean of the cell -> take it (log `via radar (fact bypass)`), no veto. Keep the macro veto when radar
   also crosses/fails.

## B. EXP2 LOSES THE ENCOUNTER AFTER ACTIVATION (mapper.js): final stage never opened, user collected manually
Live: 14:07:10 `HAMMERED (activate, panel-open, 5 runes)` -> encounter runs -> 14:08:01.987
`[Exp2] remnant 851 gone 30s -> concede` (the activation TRANSFORM changes/de-streams the entity; the
30s missing-entity concede ignored the position anchor) -> 14:08:10 re-acquired and RESTARTED the flow
(`reached (30u) -> clear mobs then open`) as if fresh -> cycled; the final loot stage sat untouched until
the USER clicked it (2x Divine Orb — this was a max-value pick left on the table).
FIX: post-HAMMER the encounter is tracked by the POSITION ANCHOR (exp2CurX/Y — it exists for exactly this),
not the entity id:
- The missing-entity concede may not fire while the encounter at the anchor is still LIVE (an
  Expedition2-family entity/marker/objective within ~40u of the anchor — reuse the loot-ready isTargetable
  read TASK-36/42 built). De-stream/id-churn re-binds to whatever entity is at the anchor.
- A re-acquire at the anchor RESUMES the post-activation phase (waves -> loot-ready -> 5x/500ms open
  ladder), never restarts at 'reached -> open' (re-opening an activated encounter is a no-op that wastes
  the map's most valuable content).
- Keep every existing bound (fight caps, give-up, currency-family fallback). Log the re-bind:
  `[Exp2] anchor re-bind id OLD->NEW (post-activation)`.

## Hard limits
- navigator.js: fact recording/veto/amnesty + the route-around only. mapper.js: the exp2 post-activation
  tracking only. Flags: `NAV_FACT_AMNESTY_ON`, `EXP2_ANCHOR_TRACK_ON` (+ the fact-earning guard rides
  NAV_ON). Flags off = today byte-parity. node --check both; TEST BEFORE COMMIT.
- Do NOT touch the verisium settle gate (crash safety), reward ranking, or the open ladder itself.

## Acceptance
- Mire-class map: a false blocked-cell fact un-bricks within one amnesty cycle (log line present); the
  navigator NEVER loops `all candidates unroutable` more than twice consecutively; facts earned during
  contested movement don't appear at all.
- Verisium: activation -> waves -> final open completes UNATTENDED (the open ladder fires; loot picked);
  a de-stream mid-encounter shows the anchor re-bind line, not a concede/restart cycle.

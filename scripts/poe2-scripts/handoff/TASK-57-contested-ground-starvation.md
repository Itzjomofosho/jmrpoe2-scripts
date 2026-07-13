# TASK-57 — Contested-ground commitment starvation: undrivable-release counts stolen frames + a rare path bypasses the engaged gate

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-57\`. File: mapper.js ONLY. USE OPUS 4.8.
SEQUENCING: fire AFTER TASK-56 lands (same arbiter region). Evidence: C:\tmp\log.txt (VaalFactory
18:41-18:44, 2026-07-13).

## The two live failures (one root: stolen frames read as failure)
1. BREACH CAMPED 2 MINUTES: `[OB] complete content:breach:1140 ... wall=121979ms owned=18599ms
   paused=78374ms frozen=75926ms stolen=154300ms` — an ACTIVATED+STABILISED breach (BreachHandPortal at 11u
   in the dump) was rare-paused (`pause by=rare` 18:43:25) and dodge-frozen for ~2.5min combined. 47-B's
   engaged gate covers the ARBITER's rare-chase — but SOME rare path still claimed (`[OB] claim=rare:NNN
   pri=3 (engage)` lines exist all day). AUDIT: name every code path that produces a rare-layer OB claim /
   steals movement for a rare, and gate each with engagedContentAnchor exactly like the arb chase (the
   'engage' reason path is the suspect — likely the proximity/attack-driven rare engage, not the chase).
2. VERISIUM DROPPED AS "UNDRIVABLE" WHILE STARVED: verisium:2029 claimed 18:43:35 -> rares/dodge/pickit own
   the ground -> `complete (arb-release) owned=3557ms paused=5373ms frozen=8851ms` at 25s wall — the
   ARB_UNDRIVABLE_RELEASE fired on "no drive happening", which is indistinguishable from THEFT. The next
   pick took abyss:1920; the 43-A hold then (correctly) denied verisium's counter-claim
   (`swap ... DENIED (held 3466ms, engaged=1)`) — net: the user killed the rare FOR the verisium and the
   bot walked to an abyss instead.

## FIX (flag `UNDRIVABLE_THEFT_AWARE_ON = true`)
- The undrivable-release clock advances ONLY on frames where the drive was actually free to run: reuse the
  OB record's owned/paused/frozen accounting (it is all there — the release lines print it). Stolen spans
  (paused/frozen) do not count toward ARB_UNDRIVABLE_RELEASE_MS. A commitment with NO runner AND free frames
  still releases at the same bound (true undrivable unchanged).
- The rare-path audit from (1): every rare steal point gated on engagedContentAnchor; a rare INSIDE the
  content's ring is the attack chain's job (kills happen while the content drive continues); defer-never-ban.
- After both: on contested ground the commitment survives until its owned-frames TTL (already just), and
  the breach/verisium runners get their frames back between dodge bursts.

## Hard limits
- mapper.js only. Reuse the OB accounting + engagedContentAnchor — no new state machines. Do NOT touch the
  43-A hold, the TTL-cycle guard (53-B), or the priority ladder. Flag off = today byte-parity. node --check.
  TEST BEFORE COMMIT.

## Acceptance
- An activated breach on mob-dense ground: rare claims defer ([Engaged] lines), the roam owns its frames,
  the white-tail ends it in seconds not minutes; the release line's owned= dominates wall=.
- A contested verisium start: no arb-release with owned < 25% of wall while paused+frozen dominate — the
  commitment survives until driven or its owned-TTL runs out.

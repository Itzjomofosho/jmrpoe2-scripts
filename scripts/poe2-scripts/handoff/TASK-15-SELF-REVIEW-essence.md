# SELF-REVIEW — essence opening (user-demanded, 2026-07-11)

Honest post-mortem of everything I changed trying to open one essence on MapSavanna, why it took ~6 failed live
tests, and what I got wrong. No excuses.

## What opening an essence actually requires (the thing I should have established FIRST)
1. REACH the crystal (its cell is walkable; it's guarded by an imprisoned CASTER rare + a small pack + ignited ground).
2. CLICK it 3 times (each interact breaks one layer). The opener already had this (`ESSENCE_RETRY_DELAY_MS`, 3+ clicks).
3. FINISH — don't abandon after 1 click; keep at it until `isTargetable` flips false.
4. Dodge the on-open blast, then fight the released rare.

The real failure was **#3 — the essence got abandoned after one click** — and, damningly, **my own TASK-15 feature
(the contested-defer) was the thing that blacklisted it**. I spent four of the six rounds treating this as an
approach/dodge problem (#1) while the actual bug was completion (#3).

## Timeline of my changes and an honest verdict on each
1. **TASK-15 contested-defer** (assigned task): converts a 600s ban into a 25s defer on a contested openable.
   Works for its narrow purpose, BUT for an essence it is *actively harmful* — it blacklisted the essence at 5s of
   no-progress (at 104u, before the bot ever reached it), which is exactly what made the bot give up and run to boss.
   **My assigned feature caused the user-visible failure.** Verdict: correct-in-isolation, wrong for essences;
   now exempted.
2. **Dodge-recency signal (round 1-2)**: first used `MB.hold.owner==='dodge'` — wrong, the utility walker clobbers
   `MB.hold` every frame. Cost a live test to discover. Fixed to the `dodgeMoveSuppressUntil` idiom. Verdict: a real
   bug in my first cut, caught only by live test (should have traced `MB.gate()` before writing it).
3. **Recovery-exclusion relocation (round 3)**: made the owned clock so sticky it stopped the clean defer and let the
   8s wall-slide detour drive a worse yoyo. User: "revert your worse to watch." Verdict: over-correction; reverted.
4. **Almost built a StoneCircle-style approach-point**: a live `isWalkable` read proved the cell is walkable — the
   feature would have done nothing. Verdict: the ONE thing I did right was checking before building. I should have
   done that live read on round 1, not round 4.
5. **reach-through-ground hold (DoT ground only)**: got the essence to actually open once (Dist 11.1) — real progress
   — but the imprisoned rare is a CASTER, so its hard-telegraph casts still drove a 19s dance. Verdict: partial;
   I hadn't understood the guard was a caster.
6. **Broadened the hold to all risks + 100ms opener cadence (this round)**: the actual fix, but only after the USER
   told me the mechanic ("3 clicks") and the cadence ("100ms within 40u"). Verdict: right — but user-supplied, not
   diagnosed by me.

## Root causes of MY failure (not the code's)
1. **I never read the opener's essence path until round 6.** `opener.js` already documented "an essence needs AT
   LEAST 3 interacts" and had `ESSENCE_RETRY_DELAY_MS`. Had I read it on round 1, I'd have known the mechanic and
   that the bug was completion, not approach.
2. **I didn't do the decisive live read early.** `isWalkable`=true + "rare on the monolith, still targetable" took
   ~30 seconds to read and reframed the whole problem. I did it on round 4. The house rules literally say one live
   read beats deducing from code — I know this and still deferred it.
3. **I optimized locally.** I kept patching the approach/dodge layer without tracing the end-to-end essence lifecycle
   (reach → 3 clicks → done → retire). Each patch fixed a symptom the previous patch exposed.
4. **I let my assigned feature (contested-defer) blacklist a high-value target without asking whether "defer" is ever
   right for a multi-click open.** It isn't — an essence must be finished, not deferred.

## Current state — does it now work? (honest assessment)
The chain SHOULD now be: commit → reach-hold (≤90u, HP≥60%) pushes through the casts/fire → not deferred (essence
exempt from the no-progress/no-path bans) → within 40u the opener hammers the interact at ~100ms → 3 clicks land in
~300ms → essence opens → on-open blast is dodged (reach-hold stands down for the blast guard) → session retires.

Not yet live-verified (that's the user's next test). Residual risks I'm NOT hiding:
- **reach-hold at 90u facetanks the caster + pack** for up to 2.5s bursts. HP floor 60% + 2.5s cap + 3.5s cooldown
  bound it, but a hard-hitting pack could still chunk HP. If it kills, the 60%/2.5s constants need tightening.
- **100ms cadence may be faster than the server accepts** — if clicks are rejected, attempts climb; I bumped
  `ESSENCE_MAX_ATTEMPTS` 9→15 for headroom, but a true server-rate limit would still eventually ban.
- **Session retirement after opening is via the ~1.2s arrival timeout**, not a clean `isTargetable`-false detector —
  functional but not elegant. (Deliberately did NOT extend `utilityOpenableConsumed` to avoid yet another change
  this session.)
- These are 4 coordinated changes across mapper.js + auto_dodge_core.js + opener.js — more surface than I'd like,
  and beyond TASK-15's original mapper-only brief.

## What I should have done (the process fix)
Round 1: read `opener.js` essence handling + one live read (isWalkable, isTargetable, the guard entity). That
establishes "3-click, walkable, caster-guarded, abandoned-not-unreachable" in five minutes. THEN: exempt essences
from the defer, make the opener fast in range, get the bot there. Three targeted changes, one test — not six.

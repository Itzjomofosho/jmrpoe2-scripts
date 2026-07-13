# TASK-43 REPORT — Arbiter honors runner skip-bans (B) + 3-strike unreachable concession (C)

FIX A (OB_CONTENT_HOLD_ON commitment hold) was already live — NOT touched, per the scope update.
Pre-snapshot: `handoff\pre\TASK-43\mapper.js` (copied before any edit; includes the TASK-44/45/46 runtime state).
Diff vs snapshot: **61 insertions, 0 deletions** (purely additive). `node --check mapper.js` passes.

## Files touched
- `mapper.js` ONLY.

## Symbols added / modified (searchable)

### FIX B — `ARB_RUNNER_BAN_RESPECT = true`
- **`arbRunnerBanExp(e)`** (new, next to `lockIsDone`): returns the runner-level skip-ban expiry ts for a
  contentQueue entry (0 = none). Type → ban-set map: breach→`rotBreachBlacklist`, abyss→`abyssBlacklist`,
  verisium→`exp2Done`, incursion-chest→`incursionRecentlyDone`, incursion-beacon→`incBeaconBlacklist`.
  **ENGAGED override** (the brief's engaged signals): while the runner owns the exact id
  (`rotBreachId===e.id` / `abyssId===e.id` / `exp2Phase!=='idle' && exp2CurId===e.id`) the ban reads 0 —
  critical for breach, whose ACTIVATION path sets a 120s "don't re-walk the gone Brequel" ban at TOUCH
  (`runWalkToBreach`) while `runBreachRoam` still manages the fight. Without the override, FIX B would
  release the commitment mid-breach — the exact thrash this task exists to kill.
- **`_arbRunnerBanLogged`** (new Map): key → ban expiry already logged; gives the brief's one-log-per-ban-instance.
  Cleared per map in `arbReset()`.
- **`pickObjective` candidate scan**: new exclusion after the `lockIsDone` check — a runner-banned entry is not
  a candidate; logs `[Arb] <type>:<id> skip-banned by runner -> not a candidate (<ms>ms)` once per ban instance.
  Placed AFTER `lockIsDone` deliberately: verisium/abyss/incursion bans double as lockIsDone done-signals and
  already `continue` there today (silently) — the genuinely new exclusion is breach, whose `lockIsDone` reads the
  whole-map bit, not the per-Brequel ban. So the new log fires exactly when the new exclusion acts.
- **`arbTerminated`**: new terminator — committed entry runner-banned (and not engaged) → commitment releases.
  Without this, FIX B's candidate exclusion would push a just-runner-skipped committed breach into the
  "out of cands but alive → keep walking toward it" branch (a walk at a target its own runner refused).
- **`nearbyObjectiveBeforeBoss`**: same exclusion. DEVIATION from the brief's literal scope (candidate builder
  only), with reason: this function holds the arena entry expecting "arbTick grabs it next frame"; with FIX B,
  arbTick refuses runner-banned entries, so without the mirror check the hold would wedge at the arena door for
  the full ban duration. Its own doc-comment says it mirrors the arbiter's eligibility gates. Same flag.

### FIX C — `ARB_SKIPBAN_ABANDON_ON = true`, bound `ARB_SKIPBAN_ABANDON_N = 3`
- **`_cqBanStrikes`** (new Map): key → `{n, lastExp}`. Cleared per map in `resetMapper` (next to
  `contentQueue.clear()`).
- **`populateContentQueue` prune loop** (new block between the terrain-beacon delete and the breach2/hive
  marker check — so hives and still-streamed entries are covered too): each DISTINCT ban instance on an ACTIVE
  entry — `max(revisitSkip[key], arbRunnerBanExp(e))`, a moved expiry (>1s) = one strike. **THE BOUND: 3 distinct
  ban instances** (any mix of runner skip-bans and arb/cleanup `revisitSkip` bans — TTL-evict, valve release,
  coord-drive walled, cleanup stuck) → the entry is marked `state='completed'`, `completionSource='abandoned-unreachable'`,
  log `[Arb] <key> skip-banned 3x -> abandoned as unreachable (map completes without it)`.
  Completed-state is the established concession idiom: survives re-discovery (`upsert` keeps completed),
  exits every candidate/cleanup/arena-hold scan, and drops out of `soonestRequiredBanExpiry` so the post-boss
  required fast-out stops waiting out its bans → the map finishes reachable content and portals (the cleanup
  budget was always the hard wall; C stops the budget being burned on re-pursuits).
  Deliberately NOT calling `noteContentCompleted`: that would push the position into `_discCompletedPos` and make
  `hasConfirmedUnfoundContent` claim "another unfound instance exists" — a false discovery signal (the abandoned
  item IS the incomplete bit; there is no sibling to hunt).

## Settings
| Name | Default | What flips it |
|---|---|---|
| `ARB_RUNNER_BAN_RESPECT` | `true` | `false` = arbiter ignores runner skip-bans (today's behavior, byte-parity) |
| `ARB_SKIPBAN_ABANDON_ON` | `true` | `false` = no strike counting, no abandonment (byte-parity) |
| `ARB_SKIPBAN_ABANDON_N` | `3` | strikes before concession |

Flag-off parity walked: every new read sits behind its const; helpers are only invoked from gated sites; the two
new Maps stay empty with flags off and their `clear()` calls are no-ops. `OB_CONTENT_HOLD_ON` / `arbCommitTo`
untouched; navigator.js untouched; no new scans (all additions are O(1) Map reads on data in hand), no movement
sends, no packets, no memory writes.

## LIVE-TEST CHECKLIST (map with two NEAR content items, one hard/unreachable — the Channel pattern)
WORKING looks like:
1. The reachable item is committed and HELD: `[Arb] swap ... DENIED (held Xms, engaged=1) -- commitment holds`
   (FIX A, already live) and NO breach<->verisium ping-pong in the `[ArbShadow] pick=` lines.
2. When a runner gives up on the hard item (e.g. `[Breach] Brequel <id> no progress (closest Xu) -> skip`), the
   VERY NEXT arbiter pass shows `[Arb] breach:<id> skip-banned by runner -> not a candidate (~59000ms)` ONCE,
   and the pick moves to the sibling — no re-pick of the banned item within its ban window.
3. `[Breach] TOUCHED ... -> clearing` is NOT followed by a commitment release or a swap-away (the engaged
   override): the roam runs to `[Breach] cleared/done`.
4. After 3 failed pursuits of a truly walled item:
   `[Arb] <key> skip-banned 3x -> abandoned as unreachable (map completes without it)` — then the map's
   remaining reachable content completes and the bot portals without re-walking the abandoned target.

BROKEN looks like:
- `skip-banned by runner -> not a candidate` spamming every pass for the same ban (log-once regression).
- A commitment released mid-breach right after `TOUCHED` (engaged override failed) — swap-thrash returns.
- The bot standing at the arena door doing nothing (arena-entry hold naming a key the arbiter refuses —
  the `nearbyObjectiveBeforeBoss` mirror should prevent exactly this).
- An `abandoned as unreachable` line for content the bot was actively progressing on (strikes counting
  deliberate management bans — the engaged override should prevent this; report the log if seen).

## Risks / notes
- FIX C counts dwell-cap bans (beacon/hive arrival dwell 'cap') as strikes: a guardian-gated required beacon
  concedes after 3 failed dwell attempts. That matches the brief's intent ("don't block map completion"), but it
  is a concession on REQUIRED content — the map's objective bit stays incomplete and the run proceeds on the
  cleanup budget's terms. Strikes never decay within a map (per-map reset only).
- An abandoned entry counts as "done" in the HUD/MAP-SUMMARY tallies (completed-state side effect); the
  `completionSource='abandoned-unreachable'` marks it distinguishable in any dump.
- For verisium/abyss/incursion, FIX B's exclusion is behaviorally redundant with the existing `lockIsDone`
  gate (their ban Maps double as done-signals); the new behavior is breach + the log line. Stated so the
  reviewer doesn't expect visible changes for those types.

## Open questions
None blocking. If the planner wants FIX C to count ONLY stuck/no-progress bans (excluding dwell-cap retries on
required content), `revisitSkip` would need a reason tag — new state, so left out per the "no new state machines"
hard limit.

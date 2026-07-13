# TASK-53 REPORT — Posture vs approach / TTL release-reclaim cycle / engaged-at-far phase wedge

Model: Opus 4.8. File touched: `mapper.js` ONLY. Pre-snapshot: `handoff/pre/TASK-53/mapper.js` (taken 15:17, before any edit).
`node --check mapper.js` PASSES. All flags default ON; each is off = today's control flow (byte-parity).

## Evidence used
- `C:\tmp\log.txt` (Flotsam, this session) read directly (house-rules: one live read beats deduction).
  - **Feature C confirmed from the log**: `[Engaged] ... (verisium engaged)` fired continuously **15:14:26 → 15:18:46 (>4 min)**;
    at 15:18:46 `[Exp2] remnant 1287 left behind at 1878u (phase fighting) -> retire`. So `exp2Phase` was stuck in a
    POST-OPEN phase (`fighting`) while the char was **1878u** from the stone, and `engagedContentAnchor()` (no proximity
    check) read it ENGAGED the whole time — holding 47-B's rare-chase + utility deferrals hostage. Root cause = a prior
    attempt reached+opened+hammered the stone (phase→fighting), the char was then pulled away, and `_runExpedition2` stopped
    being driven (verisium no longer the committed arbiter goal) so its own "left behind >250u" retire never ran.
  - **Feature B pattern present**: `[OB] would-ban-suppressed content:breach:86 wall=114195ms owned=54898ms cap=90000ms`
    → `[OB] complete ... (arb-release)` (owned < cap). Confirms releases fire with the OB "unjust ban" note; the brief's
    verisium 15:12-15:14 release→same-key-reclaim slice pre-dates this log window but the mechanism is the same.

## What changed (searchable symbols)

### A — POSTURE_REACH_YIELD_ON (posture must not fight a committed reach leg)
- New: `POSTURE_REACH_YIELD_ON` (=true), `POSTURE_REACH_LAT_U` (=30), `_poReachYieldLogAt`, `function postureReachGoal(player)`.
- `postureReachGoal` reuses the runners' OWN walk-phase state (no new state): verisium pre-reach walk
  (`exp2Phase==='walk' && exp2ClearAt===0`) / loot approach; abyss Phase-A reach (`abyssId && !abyssDwell`); breach
  Phase-1 reach (`rotBreachId && !rotBreachActivatedAt`). Returns the reach goal `{x,y}` or null.
- In `fightHoldPostureStep` **section B** (the `_poPress` back-out) only: when a reach leg is active AND the presser is
  **ahead** (`proj>0`) AND within `POSTURE_REACH_LAT_U` of the approach line (`perp<=30`), set `_reachHeldPress` → the
  radial back-out is skipped (the caller stops instead of stepping back; the attack chain kills the presser, then the
  reach resumes). Perpendicular/behind pressers fall through to today's back-out. Ground-hazard step-off, the idle-watch
  nudge (section C), PANIC and dodge are all untouched.
- **Signal for "a reach leg is active"**: `postureReachGoal(player) != null` — i.e. the committed content runner is in its
  pre-engagement WALK phase (each runner's existing phase var). During any ENGAGED clear (abyss dwell, activated breach,
  verisium fighting/loot) it returns null → the back-out behaves exactly as today.

### B — ARB_TTL_CYCLE (TTL release must not instant-reclaim fresh forever)
- New: `ARB_TTL_CYCLE_ON` (=true), `ARB_TTL_CYCLE_MAX` (=2), `ARB_TTL_CYCLE_DEFER_MS` (=60000), `ARB_TTL_CYCLE_PROG_U` (=25);
  state `_arbRelKey/_arbRelAt/_arbRelSince`, `_arbTtlKey/_arbTtlN/_arbTtlLastBestD`, `_arbCommitBestKey/_arbCommitBestD`.
- `arbRelease` stamps `_arbRelKey/_arbRelAt(now)/_arbRelSince(arbCommittedSince)` before clearing the key.
- `arbGoal` tracks the committed entry's closest approach (`_arbCommitBestD`, carried across same-key cycles).
- `arbCommitTo`: an **immediate same-key re-claim on the SAME pick pass** (`_arbRelKey===key && _arbRelAt===now`) =
  a TTL/no-progress cycle. It **carries the lineage forward** (`arbCommittedSince = _arbRelSince`, not `now`) so the cap is
  reached instead of restarting, and increments a per-key counter that **resets on ≥25u reach progress** between cycles.
  After `ARB_TTL_CYCLE_MAX` no-progress cycles it applies a **60s `revisitSkip` DEFER** (NOT the unreachability ban — the
  item stays completable post-boss) and returns false (R4/R5 falls through to other content / boss).
  Log: `[Arb] <key> ttl-cycled 2x without progress -> deferred 60s`.
- A genuine (non-cycle) commit of a key clears its cycle history + best-dist. `arbReset` clears all B state per-map.
- Does NOT weaken the ban suppression (that's arbTerminated's owned-frames justice, untouched) — B changes only the RECLAIM.

### C — ENGAGED_REQUIRE_REACH (engaged anchor gated on physical reach + panel close)
- New: `ENGAGED_REQUIRE_REACH_ON` (=true), `EXP2_ENGAGED_MAX_R` (=250), `exp2DriveAt`, `function exp2EngagedReached()`,
  `function exp2StaleFarTick(player, now)`.
- **Deliverable 1 (trace)**: see Evidence — stale post-open `exp2Phase` (`fighting`) lingering at 1878u while undriven.
- **Deliverable 2a (gate)**: `engagedContentAnchor()`'s verisium branch now also requires `exp2EngagedReached()` — the live
  player within `EXP2_ENGAGED_MAX_R` (250u = the runner's OWN "left behind" retire band; a live wide fight never exceeds it).
  A stale phase hundreds of u away reads NOT engaged → 47-B's deferrals resume. No-anchor / no-live-player-read → true
  (byte-parity, no false flip on a stale frame). Breach/abyss/hive branches unchanged.
- **Deliverable 2b (retire + panel close)**: `exp2StaleFarTick` (once per logic pass, pre-boss/map-complete states) retires a
  post-open phase that is far (>250u) AND undriven (`now - exp2DriveAt >= 1000` — the committed drive's own >250u retire owns
  the driven case). It mirrors the runner's left-behind retire (looted → done+drop anchor; unlooted mid-fight KEEPS the anchor
  for a post-boss resume) and, when the phase is `awaitpick` (select panel open, pick never completed), ESC-closes via the
  existing `poe2.closeAtlas()` path. Log: `[Exp2] stale <phase> left behind <d>u, undriven -> retire[ + ESC-close panel]`.
  `exp2DriveAt` is stamped at the top of `runExpedition2`.

## Settings added (all in mapper.js constants; no UI toggle)
| flag | default | flips |
|---|---|---|
| `POSTURE_REACH_YIELD_ON` | true | A: reach-leg back-out suppression. Off = today's section-B back-out. |
| `ARB_TTL_CYCLE_ON` | true | B: same-key ttl-cycle carry-forward + 2-cycle defer. Off = today's fresh reclaim. |
| `ENGAGED_REQUIRE_REACH_ON` | true | C: engaged-anchor reach gate + stale-far retire. Off = today's phase-only engaged read. |

Tunables: `POSTURE_REACH_LAT_U=30`, `ARB_TTL_CYCLE_MAX=2`, `ARB_TTL_CYCLE_DEFER_MS=60000`, `ARB_TTL_CYCLE_PROG_U=25`, `EXP2_ENGAGED_MAX_R=250`.

## LIVE-TEST CHECKLIST
Map: a verisium behind a contested approach, plus a map that leaves a verisium behind (boss pull / co-located content).
- **A working**: on the reach with hostiles pressing 17-30u, look for `[Posture] reach-yield: hold vs presser Nu ahead (approach x,y)`
  and **no** `No net progress toward Verisium for 8s at 62u (wall-slide?)` loop. The char pushes through (stands + kills, no
  back-out) instead of the step-to-55u/re-approach yo-yo. BROKEN = the wall-slide line still repeats, or the char walks onto packs
  (side-step lost — the perp/proj gate is wrong).
- **B working**: no same-ms `arb-release` → `claim=...(fresh)` pairs repeating on one key. A genuinely unreachable committed content
  shows `[Arb] <key> ttl-cycled 2x without progress -> deferred 60s` once, then the map proceeds (boss / other content) and the item
  is retried post-boss. BROKEN = the release/reclaim pair still repeats every ~75s, or a content that IS being approached (closing
  distance) gets the ttl-cycled defer (the ≥25u progress reset failed).
- **C working**: `[Engaged] ... (verisium engaged)` appears ONLY while the char is actually at/near the stone (a real fight), and
  STOPS within a second of being pulled away. A stale far phase logs `[Exp2] stale fighting left behind Nu, undriven -> retire`
  (once), and a leftover open select panel logs `... -> retire + ESC-close panel`. BROKEN = `[Engaged]` lines persist for minutes
  while the char is doing other content far away (the 15:14-15:18 symptom), or an ESC-close fires while no panel is open (see Risks).

## Risks / deviations
- **Concurrent user edit in the file (NOT mine)**: the diff vs the pre-snapshot includes one foreign line — `'digsite',` added to
  `EXCLUDED_MAP_NAMES` (self-commented `// USER BAN 2026-07-13: Precursor Forge ...`). It was added to the runtime file by the user
  AFTER my 15:17 snapshot, in a region TASK-53 never touches. I left it intact (not mine to revert). Flagging so the reviewer knows
  the working-tree diff carries it; it is unrelated to TASK-53. No foreign DELETIONS occurred (verified: every removed line is one my
  edits replaced).
- **C ESC-close (riskiest bit)**: `exp2StaleFarTick` calls `poe2.closeAtlas()` only when the retiring phase is `awaitpick` (the panel
  is, by construction, the one WE opened and never picked). Precedent: the hammer-never-took path already does the same. If the game
  had already closed that panel externally, a blind ESC could open the pause menu (the atlas-flow caveat). Judged low-probability
  (awaitpick means our open is still outstanding) and gated to that one phase; watch the `+ ESC-close panel` log lines.
- **B under the enforcing OB flag (`objBroker:true`, the default)**: `arbTerminated`'s TTL uses the OB owned clock, which restarts on
  the fresh OB.claim, so carrying `arbCommittedSince` doesn't by itself re-trigger a fast re-terminate there. The **2-cycle defer** is
  what actually bounds the livelock regardless of the trigger branch (a per-frame release trigger → defers in ~2 frames; a 75s owned-TTL
  trigger → defers in ~2 cycles). The carry-forward is still correct/helpful for the wall-clock (`objBroker` off) path and is harmless
  otherwise. I deliberately did NOT reach into OB record internals to seed its owned clock (too invasive; the defer already bounds it).
- **A scope**: `postureReachGoal` covers verisium/abyss/breach reach legs (all cleanly readable in mapper.js). The brief also lists
  "opener commit-walk" — that phase lives in `opener.js` (out of this task's single-file scope), so it is not covered here. If the
  opener commit-walk also needs the yield, it should be a follow-up in opener.js.

## Open questions
- None blocking. If the user wants the engaged-reach band tighter than 250u for post-open phases, `EXP2_ENGAGED_MAX_R` is the single knob
  (but tightening below the ~200u wide-clear radius would flip engaged off mid-legit-fight).

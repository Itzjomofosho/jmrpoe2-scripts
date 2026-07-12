# TASK-42 — Verisium loot-remnant unreachable-loop + first-offered smarts (Cliffside 20:28-20:29, 2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-42\`. File: mapper.js ONLY.
Evidence: C:\tmp\log.txt (Cliffside 20:28:11-20:29:36). TASK-36's settle-open + priority pick + hammer ALL
worked (`OPENED (area clear, 11u settled)`, `SELECT sent`, `HAMMERED`). The failure is AFTER: the char
orbited the reward remnant for ~70s "doing fuck all" until the user pulled it.

## A. THE BUG: loot approach targets the remnant's DEAD-CENTER cell (unwalkable) -> stuck-loop forever
Live: post-hammer, `Walking to Verisium loot at (1208,875)` repeatedly + `No net progress toward Verisium
for 8s at 66u (wall-slide?) -> stuck + dislodge` on a loop, interleaved with pack dodges/back-outs. The
char never reached the remnant, so the C4 loot-open (5x/500ms at <=40u) NEVER FIRED — it gates on arrival,
and arrival never happened. `(1208,875)` is the remnant object's own cell = inside the shrine/pillar
footprint = UNWALKABLE (same class as essence-rock / chest cells the walkableApproachPoint helper exists
for). The approach walked to a wall 66u out and wall-slid until the user intervened.
FIX: the verisium LOOT approach targets a walkable ring point, not the object cell — reuse the SHARED
`walkableApproachPoint(tx, ty, px, py)` helper (essence/chest/stone already use it). Approach to that point;
the existing <=40u loot-open ladder then fires (it measures distance to the REMNANT, unchanged). Verify the
loot-ready re-validate + the 5x/500ms open ladder still gate off the remnant distance, not the ring point.

## B. Approach give-up (no infinite orbit)
Even with the ring fix, a remnant genuinely walled off (or a walkableApproachPoint miss) must not loop
forever. FIX: bound the loot APPROACH — if no net progress toward the ring point for `VERISIUM_LOOT_REACH_MS
= 20000` (owned-time, the established freeze idiom) OR the existing stuck-dislodge fires 3x on this remnant,
concede: log `[Verisium] loot remnant unreachable -> give up (chest stranded)`, mark it done
(`exp2Done.set(id, now+600000)` — the existing give-up shape from the 5-miss path), release. A stranded
verisium chest is a loss; an infinite orbit is a DEAD BOT. Concede.

## C. (minor, no urgency) first-offered pick is dumb
Live: 13 rewards offered, none in VERISIUM_REWARD_PRIORITY -> `picked #0 Eternal March (first-offered)`.
Correct per the current table (all 13 were sub-divine runes/skill effects), but "slot 0" is arbitrary.
OPTIONAL: when nothing matches, prefer a currency-family name (Orb/Rune/Catalyst/Distilled) over a plain
skill-effect if any is offered; else keep first-offered. Ship only if trivial; the user can extend the
priority table instead. Log the fallback reason either way.

## D. Offered-list order is NOT the UI order (user suspicion + structural evidence)
Live: the 20:28 panel read 13 entries with DUPLICATES (#0-#7 unique, #8-#12 repeating the first five) — a
UI panel does not display 13 tiles with 5 repeats, so the raw compute-path array is structurally different
from the display (concatenated per-socket offers / pages?). If read-order != UI-order, the positional logic
(first-offered fallback AND the same-rank lowest-index tiebreak from TASK-36) is meaningless.
FIX: (1) DECODE the 13-entry structure — what are the repeats? (per-socket offer runs? page concatenation?)
Log the finding. (2) Make the UI TREE the order authority where possible: TASK-36's report mentioned a
UI-tree fallback that "walks the tile list in order" — use that walk as the canonical display order (map
compute entries to it by name/idx), or if the tree is unavailable, dedupe the raw array (keep first
occurrence) and SAY in the report that display-order remains unverified. (3) The `[Verisium] rewards:` log
keeps printing the order actually used, so the user can re-verify against the UI on the next live panel.

## Hard limits
- mapper.js only, inside the exp2/verisium block. Reuse walkableApproachPoint (no new helper) + the existing
  exp2Done give-up shape + the owned-time freeze idiom. Flag `VERISIUM_LOOT_REACH_ON = true`; off = today's
  dead-center approach (byte-parity). No change to settle-open / priority / hammer logic (all proven
  working) beyond D's ordering source.

## Acceptance
- `node --check`; parity walk.
- Report per HOUSE_RULES + live checklist: post-hammer the char REACHES the remnant (ring approach, no
  wall-slide loop), the loot-open ladder fires + `TOOK`, loot collected; a walled remnant concedes within
  ~20s with the give-up line instead of orbiting; settle-open/pick/hammer unchanged.

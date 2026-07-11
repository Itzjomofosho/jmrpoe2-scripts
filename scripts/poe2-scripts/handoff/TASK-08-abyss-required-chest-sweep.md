# TASK-08 — Abyss: premature objective-complete prune skips every abyss chest (user P2+P8)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-08\`. File: `..\mapper.js` only.
This is INVESTIGATE-THEN-FIX: the prune mechanism is confirmed; the bit-flip timing needs your investigation.

## Problem (live evidence, FrozenFalls, map objective "Complete all Abysses")
Post-boss cleanup started abyss node (1403,1219); ~10s in: `[Cleanup] objective completed (1 left) -> budget
refreshed` then `[Cleanup] abyss:1377 active but rejected: objective-reads-complete`, queue dropped `abyss:7 →
0` in one pass — and the bot walked away from FOUR lootable AbyssChest* objects (user manually walked back;
opener instantly opened `AbyssChestWeapons/RareFinalGeneric/Armour/RareArmour`). User: "YOU SKIPPED EVERY ABYSS
CHEST WTF!? EVEN AFTER BOSS." And P8: on 'Complete all Abysses' maps the hive rule applies — required means ALL
of them, and the loot at the nodes is the point.

Mechanism (confirmed): `populateContentQueue`'s prune deletes every entry of a type the moment
`objectiveTypeComplete(type)` reads complete (search `objective-reads-complete` and the prune at
`objectiveTypeComplete(e.type, now)) {`). The chests physically OUTLIVE the objective bit.

## Investigate
1. When does the 'Abyss' objective bit actually flip on a multi-abyss map — after the LAST abyss closes, or
   earlier (the log suggests it flipped while 7 queue entries were still active — were those STALE entries for
   already-closed abysses, or live ones)? Use `readMapObjectiveState` reads + the queue's per-entry
   `abyssNodeStatus` where inspectable; a bridge probe on a live abyss map settles it fastest if available.
2. Where do the end-of-abyss chests spawn relative to the tracked node entries (same coords? a final-node
   cluster?), and are they in the opener's candidate reach when the bot stands at the node.

## Fix shape (adapt to findings)
- ABYSS CHEST SWEEP: when the abyss objective flips complete (or an abyss entry is pruned on it), do NOT let the
  positions vanish — collect the pruned abyss node coords into a bounded sweep list; the MAP_COMPLETE cleanup (or
  the pre-boss runner, whichever owns the frame) visits each position within CLEANUP_REACH_LIMIT, holds the
  existing loot-dwell long enough for opener/pickit to clear targetable `AbyssChest*` entities, then retires it.
  Bounded per position (reuse the existing utility/loot dwell caps) and by the cleanup budget — no new unbounded
  states.
- REQUIRED SEMANTICS (P8): verify `isRequiredType('abyss')` is true when the map objective lists Abysses so the
  arbiter treats every node as pri-2 (the hive precedent). If the early bit-flip means "required satisfied" before
  all nodes are done, the CHESTS still get the sweep — required-complete never implies loot-complete.
- Keep the anti-yoyo guarantees: positions are visited from a LIST with per-position retire, never re-scanned
  into fresh commitments; the strict-finish gates are untouched.

## Acceptance
- `node --check mapper.js`.
- Report the investigation answers explicitly (when the bit flips; where chests spawn), symbols added, and a
  live-test checklist: on an abyss map, after the objective completes, the bot visits each abyss site once,
  `[Opener] Opened Chest: AbyssChest…` lines fire, then it moves on within the dwell caps.

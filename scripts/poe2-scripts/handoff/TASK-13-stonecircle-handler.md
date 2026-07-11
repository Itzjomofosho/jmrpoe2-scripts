# TASK-13 — StoneCircle (Runed Monolith) handler + generic interrupt-aware opener retry

FIRST ACT (HOUSE_RULES): copy `..\opener.js` AND `..\mapper.js` into `handoff\pre\TASK-13\`.
Read the memory-derived spec embedded below (source: the TASK-12 session's design + planner constraints).
Two items; A lands first, B rides on it.

## Premise ALREADY PROVEN (planner live probe 2026-07-11) — no verify step needed
The planner fired the opener's exact `0x01A3` open packet at a live rune via the bridge: `isTargetable` flipped
true->false in ONE click. So each rune = one plain interact (the opener's existing `sendOpenPacket` already does
it); build item B directly. Two live facts to USE:
- A `RuneRock_Controller` entity (metadata `.../StoneCircle/Objects/RuneRock_Controller`, NO Targetable component)
  sits EXACTLY at the 3-rock centroid. COMMIT to it as the group anchor + treat it as the unique's spawn point —
  don't compute a centroid. Cluster the `.../Objects/RuneRock` (renderName 'Runed Monolith') entities to their
  nearest Controller.
- Consume signal = `isTargetable` false (Targetable+0x69), exactly as memory says.

## A. Generic interrupt-aware opener retry (opener.js)
A click that doesn't LAND (fired mid-fight, movement cancelled the interact, server ate it) currently just burns
one of the 3 attempts toward the 10-min ban. Add a fast retry lane, distinct from the anti-repeat ban: after a
send, if the target is STILL `isTargetable === true`, still in range, and not banned, the next attempt may fire
after a short landed-check delay (~600ms) WITHOUT that first non-landing send counting toward `OPEN_MAX_ATTEMPTS`
— count an attempt only when we had a fair window (target in range + no movement lock stealing the interact).
Keep it conservative: cap the free retries (2 per target), then normal attempt accounting resumes. Essences keep
their own faster multi-click lane on top (untouched). State the exact rule you implement in the report.

## B. runStoneCircle handler (mapper.js) — the committed content owner
Detection: RuneRock entities (`Metadata/Terrain/.../StoneCircle/Objects/RuneRock`, renderName 'Runed Monolith'),
throttled scan ~800ms; cluster rocks within ~60u into a circle group; commit the NEAREST group.
State machine (mirror `runBreachRoam`'s shape — returns true while it owns the frame):
1. VISIT: while any cached rock reads `isTargetable === true`: walk to the nearest unopened rock
   (`startWalkingTo`, MB content prio 3), park within opener range (~18u), and DWELL until that rock reads
   `isTargetable === false` (the confirmed Targetable+0x69 consume signal) — the opener does the clicking via
   item A's retry. Per-rock timeout 15s -> skip the rock; 2 skipped rocks -> ban the circle, done.
2. FIGHT: all rocks consumed -> a UNIQUE spawns at the centre. Hold near the centroid (stop movement; dodge +
   rotation own the fight), end on unique dead OR 20s cap OR no unique seen within 6s of the last rock.
3. DONE: position-keyed handled-ban on the group (centroid /12 key, the sweep convention); release.
Bounds: per-circle total cap 90s; all clocks freeze on dodge-held frames (the established idiom).

### Integration constraints (the part only the tree knows — violations = rejected diff)
- RETIRE THE OLD OWNERS: the utility layer's `_isMonolith` special-casing (the stand-5s dwell + 15s session in
  the utility flow) and the fallback scanner must NOT offer RuneRocks while this handler exists — one owner.
  Exclude RuneRocks from utility openable candidates; delete or bypass the `_isMonolith` dwell branch (say which).
- Hook points: the ARBITER pre-switch chain beside `runBreachRoam` (pre-boss), and as a MAP_COMPLETE cleanup step
  before the portal phases (so post-boss circles still get done). Not in WALKING_TO_BOSS_MELEE/FIGHTING_BOSS.
- OB: register a commitment (`obClaim`-style adapter, layer 'content', pri 4 optional) on commit and complete on
  done/ban, so the broker's deny/pause narrative covers it. Mirror how the rare/utility adapters do it.
- Kill-switch const `STONECIRCLE_ON = true` (no user setting — house convention), rollback = one token.
- Movement through gated senders only; no new scans beyond the 800ms detection throttle.

## Acceptance
- `node --check` both files. Report per HOUSE_RULES: the verify-first result, item A's exact rule, which old-owner
  code was retired, and a live-test checklist (visit 3 rocks in sequence with consume-confirm dwells, unique
  fought at centre, `[StoneCircle]` log narrative naming each phase).

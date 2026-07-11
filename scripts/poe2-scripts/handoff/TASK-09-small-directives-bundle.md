# TASK-09 — Four small user directives (P3a, P4, P6a, P7) — independent items, one session

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\opener.js` into `handoff\pre\TASK-09\`.
Each item is independent; implement all four; report each separately.

## A. Map-start content wait (P3a — "STOP FOR 4s AND CHECK FOR DELIRIUM")
At zone-in the bot commits to fights/content within ~200ms while `getMapContent()` needs seconds to populate —
delirium mirrors AT THE ENTRANCE get skipped (again). In FINDING_BOSS, when the map is fresh
(`Date.now() - mapStartWallAt < 4000`) AND `poe2.getMapContent()` returns null/empty, HOLD: `sendStopMovementLimited()`
+ `statusMessage = 'Map start: waiting for content stream (Ns)'`, and return before any target selection. Release
the hold the moment content reads non-empty OR at 4s. Combat is unaffected (entity_actions/dodge run regardless;
this only holds the mapper's own walk). Must not trigger on re-enables mid-map: gate on
`mapStartWallAt` freshness only, and skip the hold entirely if a delirium piece was already seen this map
(`deliriumLastSeenAt > 0`) or the objective reads complete.

## B. Essence opener cadence (P4 — "LET OPENER SPAM it every 400ms")
Essences need 3-6 clicks and are still under-opened. In opener.js: for ESSENCE targets specifically, retry delay
→ 400ms (search the essence retry constant, currently ~500ms — verify actual), attempts cap stays 6, range gate
stays ≤40u; confirm the interaction-claim TTL (poe2_cache claim) doesn't throttle consecutive essence clicks below
400ms cadence and that the mapper's essence dwell (`minTouches`) holds long enough for 6 clicks at 400ms (~2.5s+
margin). If the dwell math can't cover it, extend the essence dwell ceiling accordingly and say so.

## C. White-chest yield removal (P6a — "u DONT have to open white chests… urns doesn't matter")
Plain white containers (generic Chest/Urn/Pot/Barrel/Crate/Vase names, non-league) must not attract UTILITY WALKS
or dwell-yields — opener may still open them for free when they happen to be in reach (passive opens stay). In
mapper's openable utility candidate collection (both the opener feed consumption and the fallback scanner), skip
generic containers; KEEP: shrines, strongboxes, and league/special chests (Abyss*, Encounter*, Vaal*, Expedition*,
Breach*, Sanctum*, precursor/relay — mirror the existing special-name conventions you find). State the exact
name-filter you implement in the report.

## D. Strongbox portal hold (P7 — "opened a strongbox then left at end of map")
The portal phase holds for active breach/verisium/hive events but NOT for a just-activated strongbox — the bot
clicked a box, then portaled out mid-event. In the MAP_COMPLETE Phase-4 gate where active events block the portal
(search `finishing the active event before portal`), add the strongbox event: while `_sbOpen`/its open-timestamp
indicates a strongbox event within its existing 28s window (search `_sbOpenAt` / the strongbox event hold in the
utility dwell for the authoritative state), hold the portal with the same bounded pattern. Also confirm the
utility dwell's own 28s strongbox hold wasn't cut short by the MAP_COMPLETE transition — if the state machine can
leave WALKING_TO_UTILITY into MAP_COMPLETE mid-event, the portal-gate hold is the backstop.

## Hard limits
- Four scoped items; nothing else. No new settings (these are user directives, always on).
- Strict-finish gates, OB shadow instrumentation, MB: untouched.

## Acceptance
- `node --check` both files; per-item live-test checklist (A: mirror at entrance gets walked first after a ≤4s
  hold; B: essence gets 4-6 `[Opener]` attempts ~400ms apart; C: zero `Utility select: openable (Chest)` for
  generic containers, shrines/strongboxes unaffected; D: portal waits out a late strongbox event).

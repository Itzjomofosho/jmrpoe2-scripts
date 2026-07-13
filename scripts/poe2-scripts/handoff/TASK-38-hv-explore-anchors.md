# TASK-38 — HV objects (essences / runed monoliths / shrines) as navigator explore anchors

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\navigator.js` into `handoff\pre\TASK-38\`.
Files: mapper.js (the feed — primary) + navigator.js (a 3-line `navRemovePoi` export ONLY).
SEQUENCING: fires AFTER TASK-46 and TASK-43 land — snapshot the then-current files.

## USER RULING (2026-07-12, verbatim intent)
"I'd be happy for u to treat essences/runed monoliths similar to breaches and vaal beacons IF no
breaches/vaal/abyss around — in terms of exploration." I.e. when the map has NO active big content, a
known-but-far essence/monolith/shrine should PULL exploration toward it (like content anchors do), instead
of being serviced only if the walk happens to pass within utility reach.

## What already exists (REUSE, do not rebuild)
- navigator.js: `navAddPoi(gx, gy, kind, key)` is exported and feeds `model.extraPois` ->
  `_refreshPois` -> normal POI candidates (K_POI_BASE scoring, NAV_POI_REACH_U completion, poiDone
  dedup). The insertion point comment names this task. What's MISSING: any removal path — an extraPoi
  lives until model reset, so a consumed object would stay a phantom destination.
- mapper.js: the sleeping-entity/content classification already sees far essences/monoliths/shrines
  (the same reads the utility/opener candidate paths use). Do NOT add a new getAllEntities pass — hook
  the feed into an EXISTING periodic scan's iteration (state which one in the report).
- Servicing on arrival is NOT this task: the existing utility/opener handover owns the object once close
  (essence multi-click lane, shrine interact, imprisoned-rare discipline). The navigator only gets the
  char THERE.

## Implement
1. FEED (mapper.js, flag `NAV_HV_ANCHORS_ON = true`): during an existing periodic scan, for each live
   targetable HV object of the anchor types (`HV_ANCHOR_TYPES`: essence Monolith, StoneCircle Runed
   Monolith, Shrine — NOT strongboxes, NOT doors) farther than ~150u from the player:
   `navAddPoi(gx, gy, 'hv-<type>', key)` with a stable key (position+name, same shape as getOpenKey).
   GATE: feed ONLY when the contentQueue has NO active big-content entry (breach/breach2/abyss/verisium/
   incursion-beacon) — the ruling's "IF no breaches/vaal/abyss around". If big content appears later
   (streamed in), stop feeding NEW anchors; already-fed ones may complete naturally (POIs lose to content
   anchors on score anyway).
2. REMOVAL (navigator.js): export `navRemovePoi(key)` — delete from `model.extraPois` (and nothing else;
   poiDone stays authoritative for reached ones). Mapper calls it when the object becomes untargetable
   (opened/consumed), name-excluded, or opener-hard-banned (`isOpenTargetHardBanned`) — checked in the
   same scan that feeds.
3. LOG: one line per anchor add/remove: `[Nav] hv anchor +essence@(x,y)` / `-essence@(x,y) (consumed|banned)`.
   Throttle: adds are naturally one-shot (dedup by key); no per-frame spam.

## Hard limits
- No new entity scans, no new movement mechanisms, no changes to POI scoring constants (the existing
  K_POI_BASE lane is the design: anchors compete with frontier regions, lose to content/boss).
- Flag-off (`NAV_HV_ANCHORS_ON = false`) = zero navAddPoi calls = today's behavior byte-parity.
- The utility-reach servicing, opener bans, essence imprisoned-rare discipline: UNTOUCHED.

## Acceptance
- `node --check` both; parity walk with the flag off.
- Live, map WITHOUT big content: a far essence/shrine appears as `[Nav] hv anchor +...`, exploration
  detours to it, the utility/opener handover services it on arrival, the anchor is removed (consumed).
- Live, map WITH active breach/abyss: no hv anchors fed (log absent), behavior unchanged.
- A hard-banned/unreachable hv object is removed and never re-fed (no phantom walks).

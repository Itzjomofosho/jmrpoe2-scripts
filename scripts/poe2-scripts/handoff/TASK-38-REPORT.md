# TASK-38 REPORT — HV objects (essence / runed monolith / shrine) as navigator explore anchors

Status: IMPLEMENTED runtime-only, AWAITING LIVE TEST. Flag `NAV_HV_ANCHORS_ON = true`.
Pre-snapshot: `handoff\pre\TASK-38\{mapper.js,navigator.js}` (copied BEFORE any edit).

## Files touched + symbols

### navigator.js
- **`navRemovePoi(key)`** — NEW export. Deletes the matching entry from `model.extraPois` only; returns
  `true` if one was removed. `poiDone` stays authoritative for anchors already reached as destinations
  (untouched). Placed directly after `navAddPoi`. (Body is 6 lines incl. the null/miss guards — the brief
  said "~3-line"; kept it minimal, no extra state.)
- No other navigator change. `navAddPoi`, scoring constants, `extraPois` handling, serialization: UNTOUCHED
  (`extraPois` is deliberately NOT serialized — it is re-fed live each map, so a reload re-hydrates from the
  scan, not the sidecar).

### mapper.js
- **Import** (top): added `navAddPoi, navRemovePoi` to the existing `./navigator.js` import.
- **Feed subsystem** (new block immediately above `getOpenableUtilityCandidates`):
  - `NAV_HV_ANCHORS_ON = true` (the task flag)
  - `HV_ANCHOR_MIN_DIST = 150` (far threshold)
  - `HV_BIG_CONTENT_TYPES` (Set: breach, breach2, abyss, verisium, incursion-beacon, incursion-chest)
  - `hvAnchorFed` (Map: anchor key → {id,x,y,kind}; the fed registry for one-shot add-log + removal)
  - `_hvAnchorType(t)` — opener candidate → 'shrine' | 'essence' | 'monolith' | null (Runed Monolith is
    separated out of the opener's Essence bucket by name, exactly as the utility selector does; strongbox/
    chest/special/door → null)
  - `_hvOpenKey(e)` — `hv:o:<name>:<floorX>:<floorY>` (getOpenKey shape, `hv:`-namespaced; position+name so
    it survives entity-id slab recycle)
  - `_hvBigContentActive()` — true if any active/engaged big-content entry is in `contentQueue`
  - `_hvRemoveAnchor(key, why)` — calls `navRemovePoi`, drops the registry entry, logs the `-` line
  - `feedHvAnchors(player, openerTargets, nearby)` — the feed + removal pass
- **Call site**: one line at the END of `getOpenableUtilityCandidates`, just before `return out;`:
  `if (NAV_ON && NAV_HV_ANCHORS_ON) { try { feedHvAnchors(player, openerTargets, nearby); } catch (_) {} }`
- **Per-map reset**: `hvAnchorFed.clear();` added next to `_cqBanStrikes.clear()` in the mapper RESET fn
  (the same reset that already calls `navReset` → drops `extraPois`).

## Which existing periodic scan the feed hooks into (brief required this stated)

**`getOpenableUtilityCandidates(player)`** — the "utility/opener candidate path" named in the brief. It already
fetches, per pass, two entity lists I reuse with ZERO new scan:
- `openerTargets = getOpenableCandidatesForMapper(maxDist)` — **targetable** essence/shrine/strongbox/etc.
  within `openableWalkRadius` (default 200u). The StoneCircle **Runed Monolith arrives here as type `Essence`**
  (name-tagged) — so all three anchor types come from this one list. `allowBlockedVisibility=true`, so a
  LoF-blocked far object is still included (we anchor to walk there; LoF clears on approach).
- `nearby = POE2Cache.getEntities({lightweight, maxDistance: maxDist+40})` — includes **untargetable**
  entities, used to distinguish CONSUMED (streamed, isTargetable=false) from a mere de-stream.

This function runs frequently during exploration via `gatherUtilityCandidates` (line ~10269) and the
loot-only hv side-step (line ~10274) inside `tryStartUtilityNavigation` (called ~every logic pass in the
non-boss/non-hideout block), and via `hvUtilInsertTarget`. Adds are one-shot and cumulative, so occasional
passes are fine.

### Feed logic
For each targetable HV object in `openerTargets`: hard-banned → drop any anchor + skip; else mark live;
already-fed → skip (one-shot); ≤150u → skip (utility owns it); big content active → skip NEW adds; otherwise
`navAddPoi(gx,gy,'hv-<type>',key)` + log. Already-fed anchors stay live even after big content appears
(brief: "already-fed ones may complete naturally").

### Removal logic (same scan)
- **opener-hard-banned** (`isOpenTargetHardBanned`) — detected in the feed loop (banned objects are still
  targetable, so still in the feed) → `-…(banned)`.
- **consumed / untargetable** — a fed anchor absent from this pass's targetable set is looked up in `nearby`
  by id (+40u position guard); found with `isTargetable !== true` → `-…(consumed)`.
- **de-stream** (walked away, absent from both lists) → KEPT (that is the point of a far anchor).

## Settings added
- `NAV_HV_ANCHORS_ON` (const in mapper.js, default **true**). Flip to `false` to disable: the call site becomes
  a single `if (false)` — zero `navAddPoi`/`navRemovePoi`/scan/log, control flow identical to today.
- Also gated by the existing `NAV_ON` (nav rollback silences the feed) and, by virtue of the host, the existing
  `walkToOpenablesEnabled` / opener `openEssences` / `openShrines` toggles.

## LIVE-TEST CHECKLIST
Run a map **without** big content (no breach/abyss/vaal). Watch `[Mapper] [M:…] [Nav]` lines.

WORKING:
- A far (>150u) essence/shrine/monolith that is NOT on the current walk → `[Nav] hv anchor +essence@(x,y)`
  (or `+shrine@` / `+monolith@`) appears ONCE per object.
- Exploration detours toward it (nav commits a `poi:` objective; it competes with frontier regions, LOSES to
  boss/required content — expected).
- On arrival the existing utility/opener handover services it (essence multi-click / shrine interact) with NO
  change to those systems.
- After it is consumed → `[Nav] hv anchor -essence@(x,y) (consumed)`. No phantom re-walk back to it.
- An unreachable/failed object → `[Nav] hv anchor -…(banned)` after the opener's 3-strike hard-ban; never
  re-fed.

WITH active breach/abyss/verisium/incursion present:
- NO `[Nav] hv anchor +…` lines while that content is active/engaged (gate). Behavior unchanged.

FLAG-OFF parity (`NAV_HV_ANCHORS_ON = false`): no `[Nav] hv anchor` lines ever; explore/utility behavior
byte-identical to baseline.

## Risks / deviations from the brief
1. **Scan reach = "known-but-far", not literally map-wide.** The brief's hard limit "No new entity scans" +
   "hook into an existing scan" forced reuse of the opener feed, which reaches `openableWalkRadius` (~200u).
   So an object is anchored only once it is within ~200u AND >150u away (the "known-but-far" band). An essence
   sitting >200u across the map is not anchored until the player explores within ~200u of it — then it pulls
   the final approach. This matches the ruling's "known-but-far" intent but is NOT unbounded map-wide pull.
   *If the acceptance test places a test essence >200u from the player and expects an immediate detour, it will
   not fire until the player closes to ~200u.* The only truly map-wide per-pass uncapped scan is
   `findBossArenaHint` (getAllEntities), but it is boss-path-gated and NOT called under `NAV_ON` — so it cannot
   host a reliable feed. Flag if wider reach is required (would need a new/widened scan, which the brief forbids).
2. **Coupling.** Feed depends on `walkToOpenablesEnabled` + opener `openEssences`/`openShrines` (the object must
   be in the opener feed). If a user disabled opening those, they are not anchored either — consistent (don't
   pull toward something the opener won't service), but worth knowing.
3. **Monoliths rarely qualify pre-boss.** Runed Monoliths are owned by `runStoneCircle` (its own 90u pre-boss /
   320u post-boss scan). The opener Essence bucket surfaces them ~200u, so the >150u anchor band for monoliths
   is thin pre-boss; post-boss (larger radius) they anchor more readily. Included per `HV_ANCHOR_TYPES`.
4. **Big-content gate types** include `incursion-chest` beyond the brief's explicit list
   (breach/breach2/abyss/verisium/incursion-beacon). This is conservative (fewer anchors when Vaal content is
   around) and safe — under-gating would violate the ruling, over-gating cannot. Easy to trim if undesired.
5. **name-excluded removal** is implicit: a name-excluded essence is dropped by the opener feed itself (falls
   out of `openerTargets`), so it is removed via the consumed/de-stream path rather than an explicit
   name-exclusion check in the mapper (the opener does not export its exclusion predicate).

## Open questions
- Is the ~200u "known-but-far" reach acceptable, or does the acceptance test require unbounded map-wide pull
  toward objects the player has never been near? (See Risk 1 — the latter needs a scan the brief's hard limits
  forbid.)

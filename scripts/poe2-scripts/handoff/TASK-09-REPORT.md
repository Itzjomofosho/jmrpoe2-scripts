# TASK-09 REPORT — Four small user directives (P3a, P4, P6a, P7)

Pre-snapshot: `handoff/pre/TASK-09/{mapper.js,opener.js}` (taken as FIRST ACT, before any edit).
`node --check` passes on both. No git ops. No memory writes / packets / C++ / new settings. Do-not-touch dirs untouched.

Live evidence used (ONE bridge session, read-only, user was mid-map and volunteered a strongbox — HOUSE_RULES rule 0:
one live read beats deduction). **It overturned three things, including a pre-existing bug in the code item D was
supposed to lean on.** All called out below.

> ### ⚠ HEADLINE — a live read falsified the strongbox "opened" marker, and it is a PRE-EXISTING BUG
> The utility dwell (mapper.js ~7664) asserted, in a comment, that a clicked strongbox *"stays TARGETABLE until its
> guard wave dies and it actually OPENS (targetable flips false / entity gone = the real 'opened' marker)"*.
>
> **That is false.** Live read of `ArmourerStrongboxHigh` (id 496), taken with 4 guards alive
> (`UndeadGuardMortarStrongbox` ×2, `UndeadGuardSpearStrongbox`, `SummonRandomPackDaemon`):
>
> All three states observed live on box id 496 (user drove it: sealed → clicked → guards killed):
>
> | state | `isTargetable` | `chestIsOpened` | OLD marker `isTargetable !== true` |
> |---|---|---|---|
> | sealed | `true` | `false` | not opened ✓ |
> | **clicked, 4 guards alive** | **`false`** | **`false`** | **"opened" ✗** |
> | opened, guards dead | `false` | **`true`** | "opened" ✓ |
>
> The CLICK clears `Targetable`. The old marker reads **identically** in the clicked and opened rows — it cannot
> distinguish "guards alive" from "looted". So `_sbOpen` went **true one frame after the click**: the dwell's 28s kite
> hold never engaged, it ran its 3s "drops settling", and left mid-event. **This — not the passive-open path I originally
> inferred from the code — is the root cause of P7 "opened a strongbox then left at end of map."** My portal gate had
> copied the same wrong marker and would have been a silent no-op.
>
> Fixed at both sites to read `chestIsOpened` (mapper.js:7676 dwell, mapper.js:14479 portal gate). The wrong comments
> are corrected in place. Without this, item D does nothing.

---

## Files touched

| File | Item | Symbols added / modified |
|---|---|---|
| `opener.js` | B | `ESSENCE_RETRY_DELAY_MS` (400), `ESSENCE_MAX_ATTEMPTS` (6), `ESSENCE_CLAIM_MS` (350); `shouldSkipOpenTarget`, `markOpenAttempt`, `processAutoOpen` (claim TTL + ban log) |
| `opener.js` | D | `POE2Cache.lastStrongboxOpen` published in `processAutoOpen` |
| `mapper.js` | A | `MAP_START_CONTENT_WAIT_MS` (4000), `_msHoldLogged`, `_msDoneLogged`; hold block in `case STATE.FINDING_BOSS`; resets in `resetMapper` |
| `mapper.js` | B | essence `ceilingMs` 4000 → 6000 in the utility dwell |
| `mapper.js` | C | `LEAGUE_CHEST_RE`; chest branch of `getOpenableUtilityCandidates` |
| `mapper.js` | D | `_sbPortalChkAt`, `_sbPortalLive`, `_sbPortalId`; strongbox hold in the MAP_COMPLETE Phase-4 portal gate; resets in `resetMapper` |

**Settings added: none** (all four are always-on directives, as the brief requires).

---

## A. Map-start content wait (P3a)

Implemented in `case STATE.FINDING_BOSS`, immediately after the two objective-complete early-exits and **before**
`handleDeliriumMirror` / arena / checkpoint / explore — i.e. before any target selection. `break` in this switch is a
true hold: the switch closes at the end of `processMapper` (mapper.js:14532), nothing steps the walker afterward.

Gate: `!_msDoneLogged && deliriumLastSeenAt === 0 && mapStartWallAt > 0`, hold while `content.length === 0 && elapsed < 4000ms`.
Release on first non-empty read **or** at 4s. Emits `sendStopMovementLimited()` (a broker-gated sender) + the
`Map start: waiting for content stream (N.Ns)` status. Combat/dodge are untouched (separate plugins).

Deviation from brief (one, defensive): the brief said "returns null/empty → hold". I made an **unreadable** content list
(`getMapContent` binding absent, or the read throws) distinct from an **empty** one — `_mcLen = -1` never holds. The
codebase always guards this call with `typeof … === 'function'`; a bare try/catch would have turned a missing binding
into a 4s stall on *every* map.

Perf budget: ≤1 `getMapContent()` per FINDING_BOSS logic pass (150ms ⇒ ~7Hz) for at most the first 4s of a map — **≤28
reads/map**, then `_msDoneLogged` latches and it is never read again. Both latches re-arm in `resetMapper`.

### ⚠ Two findings the planner must weigh (neither is a code defect; both bound how well A works)

1. **`getMapContent()` is not delirium-only.** Live read, mid-map: `types = [Expedition2, Ritual, Checkpoint, LeagueContent, Strongbox]`.
   `Checkpoint` and `LeagueContent` entries are in the same list. If a `Checkpoint` streams in on frame 0 — plausible,
   it is a terrain-ish object — then "non-empty" is satisfied instantly and **the hold releases without ever waiting for
   the mirror**. The brief's release condition is what I implemented; whether it *bites* is an empirical question the
   live test will answer. That is exactly why I log the entry count and outcome. If the log shows
   `content ready (N entries) after ~0ms` on every map, the release condition needs to become delirium-aware
   (e.g. hold until a `Delirium` entry appears or 4s elapses) — a one-line change, but a brief change, so I did not make it.
2. **The hold is not airtight.** `tryStartUtilityNavigation()` runs at mapper.js:11783, **before** `switch (currentState)`
   (11792). A shrine/loot candidate at the entrance can therefore take the frame into `WALKING_TO_UTILITY` before
   FINDING_BOSS's hold ever executes. The brief scoped A to FINDING_BOSS, so I implemented it there and stopped. Sealing
   this means gating the pre-switch utility call on the same window — out of brief scope, planner's call.

---

## B. Essence opener cadence (P4)

- Retry delay: the constant was **500ms** (brief guessed "~500ms — verify actual"; confirmed 500, now `ESSENCE_RETRY_DELAY_MS = 400`).
- Attempts cap: stays 6, now named `ESSENCE_MAX_ATTEMPTS`. Range gate ≤40u: **unchanged**, verified at opener.js:670.
- **The claim TTL *was* the real throttle.** `processAutoOpen` returns on *any* live claim including its own
  (opener.js:625 `if (POE2Cache.interactionClaim()) return;`). The essence claim was **450ms** — longer than the 400ms
  target — so the claim, not the retry gap, set the cadence (old effective cadence ≈450–470ms, not 500). Fixed:
  `ESSENCE_CLAIM_MS = 350`, with the invariant `ESSENCE_CLAIM_MS < ESSENCE_RETRY_DELAY_MS` stated at the declaration.
  Pickit's exposure window between our layers is unchanged (was 500−450 = 50ms, now 400−350 = 50ms).
- **Dwell math did NOT cover 6 clicks — ceiling extended, as the brief instructed.** `waitMs` is measured from *arrival*,
  not from the first click. 6 clicks @400ms span 2.0s; `settled` needs +900ms of quiet after the last one ⇒ 2.9s **from
  the first click**. The first click can lag arrival by a live pickit action-claim (≤2.5s) plus the opener scan throttle,
  so the old 4000ms ceiling finished the dwell mid-sequence and banned the monolith half-opened ("handled:opener", 10 min).
  Essence `ceilingMs` 4000 → **6000**. Worst case 2.5s lag + 2.0s span + 0.9s settle = 5.4s < 6.0s. `minTouches` stays 3:
  since 400ms < `settleMs` 900ms, `settled` cannot fire mid-sequence regardless, and raising it to 6 would make `settled`
  unreachable for a monolith that opens in 4 clicks, forcing the ceiling every time.
- In-scope log correction: the ban line printed `after ${OPEN_MAX_ATTEMPTS} attempts` (3) for essences banned at 6. Now
  prints the right cap.

### ⚠ Third throttle the brief did not name: `openCooldownMs`
`processAutoOpen` also gates on `now - lastOpenTime < openCooldownMs` **and** the scan interval (both = the Opener
"cooldown" slider). Essence cadence is `max(claim, openCooldownMs, retry)`. On-disk `data/settings.json`:

| profile | openCooldownMs | openEssences | resulting essence cadence |
|---|---|---|---|
| gertsmerdler, shakabonbon, thebonbon, frenshape, Fartpurpler | 300 | — | **400ms ✓** |
| Fabledcokrag | 294 | true | **400ms ✓** |
| pewpewmadafaaka | 345 | true | **400ms ✓** |
| **Blackicepee** | **795** | **true** | **795ms ✗** |

If the live test runs on **Blackicepee**, essence clicks will land ~795ms apart and P4 will look unfixed. Either lower
that character's Opener cooldown slider to ≤400 before testing, or exempt `type === 'Essence'` from the global open
cooldown/scan throttle — the latter is a behavior change beyond the brief, so I did not make it.

---

## C. White-chest yield removal (P6a)

**Exact filter implemented** (mapper.js, `getOpenableUtilityCandidates`, opener-feed branch, `t.type === 'Chest'` only):

```js
const LEAGUE_CHEST_RE = /league|abyss|breach|expedition|ritual|sanctum|vaal|delirium|incursion|ultimatum|legion|essence|precursor|relay|beacon|encounter|strongbox/i;
// tested against `${e.name} ${e.renderName}` (metadata path + render name)
const isMagicOrHigher = (rarity >= 1) || e.chestIsStrongbox === true;
if (!isMagicOrHigher && !LEAGUE_CHEST_RE.test(name)) continue;   // plain white prop: no walk, no dwell, no yield
```

Kept: shrines, strongboxes, essences, Special/precursor (all separate `t.type`s, never reach this branch), magic-or-better
chests, and any league container at any rarity. Dropped: white non-league containers.

**I did not implement a generic *name* blacklist** (`Chest|Urn|Pot|Barrel|Crate|Vase`), and the live read is why:

- `Metadata/Chests/LeagueExpedition2/HiddenEncounterChest` → `rarity: 0, chestIsStrongbox: false`
- `Metadata/Chests/StrongBoxes/ArmourerStrongboxHigh` → `rarity: 0, chestIsStrongbox: true`
- `Metadata/Chests/PetrosphereCluster02A` → `rarity: 0` (renders as "Chest")
- `Metadata/Chests/CarverTribeCow01` → `rarity: 0`, **renders as "Carcass"** — a generic container the brief's name list
  does not mention. `ForestCache03` renders as "Cache", `CarverTribeWickerBasket01` as "Basket".

So rarity cannot separate league loot from junk, and an enumerated generic-name blacklist silently misses
Carcass/Cache/Basket/Trunk/Sarcophagus. A league **whitelist** is the safe direction: an unknown white prop is skipped
(desired), and an unknown *league* prop is the only failure mode — which the token list covers by metadata convention
(`Metadata/Chests/League*/…`). I dropped `hive` from my first draft because it is a substring of **"Archive"** and, per
the Breach-hive notes, hives are named `Brequel*` — the token bought nothing and risked a false keep. Regex checked
against 8 white + 8 league fixtures: 8 skipped, 8 kept, 0 errors.

**Fallback scanner: no change needed.** It is shrine-only (`if (!isShrine) continue;`, mapper.js:6805) and cannot emit a
container. The MAP_COMPLETE long-range block filters `/precursor/i`. Both verified, neither touched.

### ⚠ Behavior deltas the planner should know
1. **`walkToNormalChestsEnabled` is now inert** (only its default + UI checkbox remain; the candidate path no longer
   reads it). Unavoidable: the directive is "always on", so the setting may not buy a white-chest walk. Recommend the
   planner delete the checkbox in a later pass — removing UI was outside this brief.
2. **This mostly *rescues league chests* rather than removing white walks.** On disk `walkToNormalChestsEnabled = false`
   for every profile that has it, and `isMagicOrHigher` is false for white props — so white chests were **already** not
   attracting walks. But that same gate also dropped **rarity-0 league chests** (the Expedition2 `HiddenEncounterChest`
   above). Those are now kept. Net: white unchanged (still skipped), league chests fixed.
3. **The user's "yield" may not be this code path.** `POE2Cache.requestMovementLock('opener', 2000)` fires on *every*
   successful open including a passive white chest — a 2s mapper stall per urn. The brief explicitly said "passive opens
   stay", so I left it. If the complaint is "it keeps stopping for urns" rather than "it walks to urns", that lock is the
   culprit, not the candidate list.

---

## D. Strongbox portal hold (P7)

Added to the MAP_COMPLETE Phase-4 gate, directly beneath the existing
`finishing the active event before portal` branch (breach / exp2 / hive), with the same bounded shape and the same
"don't touch movement" behavior — dodge/rotation keep fighting the guard wave. 28s window measured **from the click**;
releases the instant the box reads untargetable (opened) or de-streams.

**Two fixes here, not one.** The brief asked me to add a portal-gate hold and to "confirm the utility dwell's own 28s
strongbox hold wasn't cut short by the MAP_COMPLETE transition". It wasn't cut short by the transition — **it was never
running**, because its "opened" marker was wrong (see HEADLINE). Both the dwell and the new gate now read `chestIsOpened`.

**Deviation from the brief, deliberate — the brief pointed me at the wrong state.** It said to read `_sbOpen` / `_sbOpenAt`
"for the authoritative state". Those are **dwell-local**: reset on every fresh dwell (mapper.js:7639), `_sbOpenAt` is
stamped when the box *opens* rather than when it is clicked, and they only exist when the mapper **walked to** the box.
A box the opener takes **passively** (it falls inside the opener's own range during the MAP_COMPLETE sweep) has no dwell
at all, so there is nothing to read. The published event covers both paths.

So the event is published at its source, mirroring the existing `POE2Cache.lastEssenceOpen` convention:

```js
// opener.js, on a successful open
if (target.type === 'Strongbox') POE2Cache.lastStrongboxOpen = { id, x, y, at: now };
```

and the portal gate consumes it, re-checking the box's **`chestIsOpened`** (500ms-throttled, forced fresh on a new box id
so a stale cached value can't let the portal through), then clearing the event once the box reads opened/absent so the
rest of the window stops probing. This covers the dwell case **and** the passive case with one source of truth.
`POE2Cache.lastStrongboxOpen` is cleared in `resetMapper` — entity ids recycle, and a box clicked seconds before the
portal must not phantom-hold the next map.

The gate probes at **300u**, not the dwell's 90u: MAP_COMPLETE retreats and portals well away from the box before this
runs (live: the box sat 132u from the player mid-event, i.e. invisible to a 90u query). Not found at 300u ⇒ treated as
event over (fail-open, same convention as the dwell's "gone = done").

**Dwell 28s hold vs the MAP_COMPLETE transition, as asked:** the transition does not cut it short. While the box is
unopened the dwell returns `true` every pass, which keeps `WALKING_TO_UTILITY`; and `utilitySessionMaxMs` is `0`
(uncapped) when `utilityResumeState === MAP_COMPLETE`, else `45000` for a strongbox — both exceed the 28s hold. The hold
was defeated by the marker bug instead, and the boxes the dwell never owned had no hold at all. Both are now covered.

Bound: the hold sits inside the existing `_portalLootHoldAt` 45s envelope (same as breach/exp2/hive), so a strongbox whose
guards never die cannot trap the map.

---

## LIVE-TEST CHECKLIST

**A — map start.** On zone-in watch for exactly one of:
- `[Mapper] [M:<map>] [MapStart] map content empty -> holding walk up to 4.0s` then
  `[MapStart] content ready (N entries) after <2000ms` → **working**: hold engaged, released on the stream.
- `[MapStart] content ready (N entries) after 0ms` (no holding line) → **the hold never engaged** — this is finding A.1,
  content was already non-empty (probably a Checkpoint). Not a bug; tell the planner, the release condition needs to be
  delirium-aware.
- `[MapStart] content still EMPTY after 4000ms` → plain map, 4s spent, proceeding. Expected on no-content maps.
- `[MapStart] content UNREADABLE …` → binding problem, should never happen.
Status bar during the hold: `Map start: waiting for content stream (N.Ns)`. **Broken** = hold longer than 4s, or the bot
walks while the status shows the hold.
On a delirium map: the mirror at the entrance should be walked **first**, after a ≤4s pause.

**B — essence.** Stand the bot on an essence monolith. Expect **4–6** `[Opener] Opened Essence: …` lines ~**400ms** apart
(±1 frame). **Working** = ≥4 lines, gaps 0.40–0.47s, monolith consumed. **Broken** = gaps ≈0.8s (→ that character's
`openCooldownMs`, see the table above), or gaps ≈0.5s (retry constant didn't take), or the dwell ends before 6 clicks
(`Utility essence dwell y3` then a walk-away → ceiling still too tight). A `[Opener] Blacklisted Essence: … after 6
attempts` line is *correct* behavior for a monolith that genuinely won't consume.

**C — white chests.** Over a map, expect **zero** `Utility select: openable (Chest)` / walks to Chest/Urn/Cache/Basket/
Carcass props. Shrines, strongboxes, essences, precursor relays unaffected. **Positive check (the actual fix):** an
Expedition2 / Abyss / Breach chest **must still be walked to** — if a league chest is now skipped, the whitelist missed a
token and that is a regression. Passive `[Opener] Opened Chest: …` lines while walking past are expected and correct.

**D — strongbox.** Two behaviors to watch, because the marker fix changes the *dwell* as well as the portal.
1. **Dwell (the pre-existing bug):** when the bot walks to a strongbox and clicks it, the status must now read
   `Strongbox: event running -- kiting (Ns)` for the whole guard wave, then `Strongbox: opened -- drops settling`.
   **Working** = it kites the wave and collects. **Broken (i.e. the old behavior)** = it clicks, immediately shows
   `drops settling`, and walks off with guards alive — that means `chestIsOpened` is not the marker after all.
2. **Portal:** click a strongbox near the end of a map and let the objective complete. Expect
   `Map complete: finishing the strongbox event before portal (Ns)` while the wave is alive, and the portal only after the
   box opens. **Working** = no portal until the contents drop. **Broken** = portal opens with the box unopened, or the
   status sticks past ~28s (then the box is unkillable/unreachable and the 45s `_portalLootHoldAt` envelope releases it).

---

## Risks

- **A** can spend a flat 4s at the start of every content-less map. Bounded, once per map, and only in FINDING_BOSS.
- **A** does not cover the pre-switch utility detour (finding A.2) — an entrance shrine still preempts it.
- **B** shortens the essence action-claim to 350ms. Pickit's steal window between layers is unchanged (50ms), but the claim
  is now the shortest in the codebase; if a click is ever observed being cancelled mid-walk on an essence, this is the
  first place to look.
- **C** is a whitelist: an unrecognised **league** container would lose its walk. Token list is derived from the
  `Metadata/Chests/League*` convention and 8 live/known fixtures, not from an exhaustive dump of PoE2 chest metadata.
- **D** adds a 500ms-throttled `getEntities(maxDistance: 300)` in the portal phase, active only for ≤28s after a strongbox
  click and self-cancelling once the box reads opened/absent. Wider than the dwell's 90u probe (justified above); on a
  juiced map a 300u lightweight scan is the cost of ≤56 reads total per strongbox event.
- **D changes live dwell behavior**, not just the portal: the marker fix means the 28s kite hold now actually engages.
  That is the intended P7 behavior, but it is the largest behavioral delta in this task and the bot will now *stand and
  fight* strongbox guard waves it previously abandoned. If a strongbox wave proves lethal, the 28s cap and the dodge are
  the only bounds.
- `POE2Cache.lastStrongboxOpen` is a new shared-cache field (same pattern as `lastEssenceOpen`). No binding, no packet.
- The full `sealed → clicked → opened` transition WAS observed live on box id 496; `chestIsOpened` flips `true` on the
  real open, and both fixed call sites were evaluated against the live entity and computed the intended result
  (`dwell_sbOpen = true`, `portal_eventLive = false`). The marker is verified, not inferred.

## Open questions for the planner

1. **A.1 — is "content non-empty" the right release?** Live read shows `Checkpoint`/`LeagueContent` share the list with
   event content. If the live log shows the hold never engaging, change the release to "a `Delirium` entry appeared, or 4s".
2. **A.2 — seal the pre-switch utility detour** during the map-start window, or accept the leak?
3. **B — `openCooldownMs`.** Exempt essences from the global open cooldown + scan throttle so 400ms holds on every
   profile, or just fix Blackicepee's slider before the combined test?
4. **C — delete the now-inert `walkToNormalChestsEnabled` UI checkbox?** And is the real P6a complaint the opener's
   2s `requestMovementLock` on passive white-chest opens (out of this brief's scope)?

Task complete; stopping here per HOUSE_RULES ("one task per session"). TASK-08 not started.

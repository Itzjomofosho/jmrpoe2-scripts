# TASK-36 REPORT — Verisium stop-and-do + reward prioritization

Pre-snapshot: `handoff\pre\TASK-36\mapper.js` (taken before any edit). Files touched: **mapper.js ONLY**.
`node --check mapper.js` = PASS. Symbol grep = clean (all new symbols resolve, no half-renames).

## Symbols added / modified
- Consts (all near the EXP2_* block): `VERISIUM_STOP_OPEN_ON`, `VERISIUM_REWARD_PRIORITY_ON`,
  `VERISIUM_OPEN_R` (15), `VERISIUM_SETTLE_MS` (300), `VERISIUM_LOOT_OPEN_R` (40),
  `VERISIUM_OPEN_RETRIES` (5), `VERISIUM_OPEN_GAP_MS` (500), `VERISIUM_REWARD_PRIORITY` (the table).
- State: `exp2StillX/Y/At/SeenAt` (settle tracker), `exp2LootFireN/exp2LootFireAt` (loot-open retry ladder;
  reset on the per-remnant commit line, advanced in BOTH pause/steal timer-bump lists per the house pattern).
- Function: `exp2Stationary(player, now)` — rounded grid pos unchanged ≥300ms across CONTIGUOUS samples
  (>500ms call gap = another system owned the frames → restart; never credits unobserved time).
- Modified inside `_runExpedition2`: phase-3 open gate (item A), the awaitpick READ+DECIDE pick (item B),
  the loot phase (item C4: retry ladder at phase top + settled first fire at 40u).

## Settings (consts, per brief — no UI toggles)
| Const | Default | Flips |
|---|---|---|
| `VERISIUM_STOP_OPEN_ON` | `true` | A (15u + settle encounter-open) **and** C4 (40u loot-open + 5x/500ms retry). `false` = today's flow byte-for-byte (30u open-on-arrival, 22u single-fire loot). |
| `VERISIUM_REWARD_PRIORITY_ON` | `true` | B (priority-table pick + `[Verisium] rewards:` log). `false` = today's EXP2_VALUE value-sort + `PICK BY VALUE` log. |

## A — stop-and-do (unparks poe2-verisium-open-while-moving)
Walk-in threshold for the interact goes 30u → `VERISIUM_OPEN_R` 15u; `sendStopMovementLimited(true)` fires
each frame (as before), then the NEW settle gate holds the frame until `exp2Stationary` passes; only then the
existing 5s single-open throttle + `exp2Open`. The OPENED log now carries `, <dist>u settled`. Nothing after
the open changed: `exp2PollAt` seed, 500ms offer polls, select → 1s dwell → hammer all intact (walked the
chain; no orphaned step).

## B — reward prioritization (incl. the THREE mid-session user updates)
`VERISIUM_REWARD_PRIORITY` (index = rank, case-insensitive SUBSTRING matched in rank order so tiered names
never fall through to their bare-name rung; `’`→`'` normalized; leading `Nx ` stripped):

Units correction (user): the poe2db snapshot is MIXED-currency per row — pale-bust icon = DIVINES, ornate
gold = CHAOS, gold face = EXALT; 1 div ≈ 8 chaos ≈ 530 ex. All ranks below are normalized to divines.
Icon-reading assumption (flagged): the named runes + alloys are CHAOS-priced as a family; the fluxes/sagas/
gems/perfect-orbs are DIVINE-priced (pale icon). Exalt-priced anything = dust, excluded.

THE TABLE, final as shipped (user-confirmed in-session; rank = array index + 1):

| Rank | Name | Value in divines (source) |
|---|---|---|
| 1 | mirror of kalandra | 6632 div |
| 2 | hinekora's lock | 1401 div |
| 3 | aldur's legacy | 272 div |
| 4 | thaumaturgic flux (level 20) | 59.6 div |
| 5 | aldur's saga | 48.7 div |
| 6 | perfect flux | 46.9 div |
| 7 | void flux | 38.1 div |
| 8 | uhtred's sidereus | 112 chaos ≈ 14 div |
| 9 | sovereign alloy | 80 chaos ≈ 10 div |
| 10 | transcendent alloy | 69.1 chaos ≈ 8.6 div |
| 11 | perfect exalted orb | ~8 div (user live quote; snapshot 2.54 div — confirm slot) |
| 12 | medved's tending | 51.1 chaos ≈ 6.4 div |
| 13 | perfect chaos orb | 6.2 div |
| 14 | the runebinder's alloy | 44.7 chaos ≈ 5.6 div |
| 15 | uncut spirit gem (level 20) | 4.8 div |
| 16 | katla's gloom | 35.9 chaos ≈ 4.5 div |
| 17 | vorana's carnage | 33.7 chaos ≈ 4.2 div |
| 18 | thrud's might | 24.7 chaos ≈ 3.1 div |
| 19 | uncut skill gem (level 20) | 2.62 div |
| 20 | farrul's rune of the chase | 21 chaos ≈ 2.6 div |
| 21 | very rare unique | ~1.01 div (user ruling; panel spelling "Very Rare Unique item") |
| 22 | divine orb | 1 div |
| 23 | greater chaos orb | unpriced, ladder order |
| 24 | chaos orb | ≈0.125 div |
| 25 | greater exalted orb | unpriced, ladder order |
| 26 | exalted orb | ≈0.002 div |

Divine Orb at rank 22 is the user's rule applied literally: everything worth MORE than 1 divine ranks above
it in price order; Very Rare Unique (~1.01 div) sits directly above it; everything below it and every
UNLISTED name (sub-divine runes, boons) loses to a Divine. `[rarity|unique]` was REMOVED per user — the
panel spelling is the only form matched. No table hit anywhere on the panel → **first offered** (user ruling).

Worked examples (behavior contract):
- Panel `Divine Orb | Kolr's Hunt | Exalted Orb` → picks the Divine (kolr's is unlisted, exalted is rank 26).
- Panel `Divine Orb | Medved's Tending` → picks Medved's Tending (6.4 div > 1 div). Only correct if divine
  offers are typically 1-2 orbs — see the stack nuance below.

Tiebreak within a rank = lowest PANEL index (quantity unreadable; the UI sorts the bigger stack higher).
**Panel order is preserved end-to-end — verified in code**: the compute path (`getExpedition2Offered`) maps the
panel's offered run sequentially (`raw.map(...)`), and the UI-tree fallback walks the tile list in order; the
`#i` in the log is that position. Log format exactly per brief:
`[Verisium] rewards: #0 name | #1 name | ... -> picked #i <name> (rank N | first-offered)` (rank is 1-based
into the table). The offered list is read fresh at every panel-open (`exp2Candidates` nulled at open / new
remnant / blind-hammer — never cached across refreshes).

Pricing decisions the user asked to be told about ("anything missing you tell me"):
- **Excluded as <1 divine (chaos-priced runes/alloys, ÷8)**: ire of aldur 7.03c≈0.88, orb of annulment
  0.75 div, runefather's alloy 5.96c≈0.74, celestial alloy 5.58c≈0.70, betrayal of aldur 5.3c≈0.66,
  breath of aldur 5.17c≈0.65, cadigan's epiphany 5.03c≈0.63, kolr's hunt 4.73c≈0.59, astrid's creativity
  3.95c≈0.49, passion of aldur 3.6c≈0.45, serle's triumph 1.99 (if divine-priced it belongs IN at ~rank 21 —
  icon ambiguous, ruled chaos by rune-family consistency), regal/transmute/augment/chance (dust).
- **Excluded, unpriced**: the green Boons (medved's/uhtred's/vorana's/olroth's boon — user: crap),
  krillson's bay key.
- **Dropped pending real prices (were in on stale June data)**: olroth's saga, hedgewitch assandra's rune
  of wisdom, perfect jeweller's orb, countess seske's rune of archery, medved's/vorana's saga — the June
  "exalted-equiv" units can't be converted to the new economy; give me prices and they slot in.
- **Divine stack nuance**: the snapshot prices per-recipe (Divine Orb x10 = 10 div) but the panel name hides
  quantity — ranks compare names, so a hypothetical x10-divine offer still loses to medved's tending (6.4).
  Same-name stacks are handled (lowest index = bigger stack); cross-name stack-vs-item is not. Flag if the
  big divine stacks actually appear at remnants and 'divine orb' should ride higher.

## C — full-flow walk (verify each leg)
1. Go + clear mobs around: **already matches** — walk-phase clear (≤15s, 60u radius) untouched.
2. Stop → open → pick: **items A + B above**.
3. Fight the waves: **already matches** — T0.4 stand-and-clear + TASK-35 posture (`fightHoldPostureStep`,
   leash 60u), wide/normal caps, controller-gone + tgt-flip exits — all untouched.
4. Reward remnant: **item C4** — approach threshold `EXP2_REACH`(22) → `VERISIUM_LOOT_OPEN_R`(40); the
   existing 2s loot-ready re-validate stays; then settle-gated fire #1; a confirm/retry ladder at the top of
   the loot phase re-fires every 500ms while the remnant stays targetable, up to 5 total; `!isTargetable` =
   TOOK → the existing `exp2LootedAt` 5s-dwell + sweep + 600s done-ban; 5 misses → the existing give-up shape
   (`exp2Done.set(id, now+600000)` + retire), same as loot-never-ready.
No step orphaned: the ladder runs before the dwell/wait branches, so a pending fire can't be misread as
"not ready" (the 15s wait) or as "already looted".

## D — objective-manager conformance (verdict per surface)
| Surface | Verdict | Evidence (symbol) |
|---|---|---|
| queue upsert/dedupe | **PASS** | `populateContentQueue` upserts `verisium` with the phantom guard (`Expedition2Encounter`-only + 40u dup check), gated `_wantVeri` + expedition-skip |
| arbiter pick + ins budget (known1000) + [Ckpt] yield | **PASS** | `CONTENT_POLICY.verisium` (value 115, timeSensitive → `TS_DETOUR_MULT`), generic `classifyObjective` incl. `PREBOSS_KNOWN_BUDGET`/`known1000`; `[Ckpt]` yield generic over `arbLastGoal` |
| OB claim/freeze ladder | **PASS** | `obArbClaim` generic over queue entries; `lockTtlFor('verisium')`=75s; `lockIsDone` reads `exp2Done`; active exp2 phases count as arb progress (`exp2Phase !== 'idle'` block) |
| required-objective drive (pre-boss) | **PASS** | `OBJ_DRIVABLE.Expedition2→verisium`, `CQTYPE_TO_DRIVE`, `objDrivableEnabled`/`typeShouldRun` case verisium, `hasPreBossContentToDo`/`nearestOutstandingRequiredContent` generic, runners at both drive sites (`case 'verisium': run = () => runExpedition2`) |
| completion prune + MAP SUMMARY tally | **PASS** | prune marks done via `exp2Done`; `objectiveTypeComplete` purge tallies `mapCntPurged`; `logMapSummary` counts by type from queue+purged |
| resume persistence (map_state.json) | **PASS (by parity)** | `exp2Done` is NOT persisted — but neither are `incursionRecentlyDone`/`incBeaconBlacklist`/`abyssBlacklist` (only sticky registries persist). Verisium done-state re-derives live: a spent remnant has no `RuneEncounterController` → `exp2Remnants` filters it; completed marker icon 1000 skipped by [Discover] |
| radar marker dim-on-complete | **PASS** | `ML_CONTENT_COLOR.verisium`; `getContentMarkers` sets `done` from `state==='completed'` → `mlDim` + smaller diamond |

**No conformance gaps → no D edits.**

## E — expedition maps keep skipping
Gate exists and covers everything: `exp2RegularExpeditionPresent` (base-game `mapObjectiveExists('Expedition')`
— known from map start, reload-proof — OR the Dannig entity scan) hard-skips at the TOP of `_runExpedition2`,
plus `exp2RegularExpeditionPresentCached` gates the rotation candidate list AND the queue upsert. All new
A/B/C4 code lives inside `_runExpedition2` → inherits the gate. **No new gate added.**

## LIVE-TEST CHECKLIST
- **A (every encounter open)**: `Verisium: -> open Nu` shrinking to ≤15, a frame or two of
  `Verisium: settling to open (Nu)`, then `[Exp2] remnant X -> OPENED (..., Nu settled)`.
  WORKING = the char visibly halts before the panel opens; BROKEN = OPENED while still glide-moving, or
  `settling to open` spinning >2s (settle never passing → tell me, I'll widen the rounding).
- **B (every panel)**: `[Verisium] rewards: #0 ... | #1 ... -> picked #i NAME (rank N)`.
  First panel: confirm `#i` order matches the UI list top-to-bottom (read-order == UI-order).
  A Divine offer is never passed over unless a named >1-divine reward / very-rare-unique is offered too;
  same-name 2x/1x → the LOWER index wins; all-junk panel → `(first-offered)` and it's the panel's first entry.
- **C4 (reward remnant)**: `Verisium: -> loot Nu` stops ≤40u, `loot-ready, settling`, then
  `[Verisium] loot-open fired #1/5 (Nu, settled)` → `[Verisium] loot-open TOOK (fire n/5) -> 5s dwell`.
  A whiff shows `re-fire #2/5 (still targetable)` etc.; 5 misses → `loot-open never took (5x/500ms) -> give up`.
- **E**: on a logbook/expedition map, no `[Exp2]`/`[Verisium]` engagement lines at all (unchanged).

## Risks / deviations
- **C4 rides `VERISIUM_STOP_OPEN_ON`** — the brief named only two flags; A and C4 are both "open" behaviors,
  so they share the flag. Split trivially if wanted.
- The ranked pick only considers PICKABLE offers (`catalogIdx >= 0`) — an unmapped offer physically can't be
  selected (no packet index). If the best-ranked offer is unmapped we take the best mapped one; the log shows
  the full list so this is visible.
- If the reward remnant entity DESPAWNS right after a fire (post-open transform) before the `!tgt` confirm,
  the pre-existing engaged-miss path holds at the position anchor (≤30s) then concedes — unchanged machinery,
  same class as today; pickit still collects during the hold.
- Apostrophe names: matcher normalizes `’`→`'`; the first live `[Verisium] rewards:` line prints names
  verbatim — if an apostrophe name logs but ranks `first-offered`, the DAT uses a third glyph; one-line fix.

## Open questions
1. Perfect Exalted Orb: user quoted ~8 div live, snapshot shows 2.54 div — slotted at ~8 (rank 11);
   move down if the quote was off-the-cuff.
2. Icon-family assumption: named runes + alloys read as CHAOS-priced, fluxes/sagas/gems as DIVINE-priced.
   If any specific row is actually the other icon (esp. uhtred's sidereus 112, medved's tending 51.1,
   serle's triumph 1.99, uncut gems), say which and it moves.
3. Prices wanted to (re)add: olroth's saga, hedgewitch assandra's rune of wisdom, perfect jeweller's orb,
   countess seske's rune of archery, medved's/vorana's saga.

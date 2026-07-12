# TASK-36 — Verisium: stop-and-do + reward prioritization (user ruling 2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-36\`. File: mapper.js ONLY.
NOTE for the implementer: this task is designed to be pure JS against EXISTING bindings. If a required read
(reward names / quantities on the select panel) turns out not to be exposed to JS, do NOT read raw memory
(house rule: no blind memory reads — the DAT pool behind reward names is volatile) and do NOT attempt DLL
changes: STOP, write the report stating exactly which binding is missing, and leave the rest implemented.

## Context (existing machinery — reuse, do not rebuild)
The exp2/verisium chain in mapper.js already: finds encounters, selects via the 00F9+01FD00 chain
(id=Expedition2Encounter), opens the select panel, hammers (exp2Craft), waits the loot-ready isTargetable
flip, and has an ESC-close last-resort. The de-hardcoded C++ recipe/name table landed 2026-07 (commit
fe2c9f0). Memory anchors: poe2-verisium-select-fix, poe2-expedition2-reward-name-chain,
poe2-expedition2-offered-list (the offered array is FREED each refresh -> read AT panel-open, never cache
across refreshes), poe2-verisium-open-while-moving (the parked bug item A fixes).

## A. Stop-and-do (unpark poe2-verisium-open-while-moving)
Live (parked): the OPEN/select fires from ~29u while the char is still moving -> whiffs/half-opens.
FIX: the verisium interaction only fires when: char within 15u of the encounter object AND stationary
(grid pos unchanged ~300ms) — the runner walks in, sends a stop, settles, THEN runs the chain. Reuse the
walk/stop idioms; the TASK-35 posture already owns the fight frames around it (leash 60u — untouched).

## B. Reward prioritization (user ruling — "all the runes are crap, prioritise")
When the select panel offers rewards, score each offered entry and pick the best; ONLY if nothing matches
the table, pick the FIRST offered (user ruling).
Priority table (top = best), matching case-insensitively on the reward NAME:
  1. Divine Orb        (any tier/prefix)
  2. Perfect Chaos Orb
  3. Greater Chaos Orb
  4. Chaos Orb         (the bare name = regular)
  5. Perfect Exalted Orb / Greater Exalted Orb / Exalted Orb (tier order within exalted barely matters —
     implement as three consecutive ranks anyway, it costs nothing)
QUANTITY (user clarification): 2x and 1x of the same orb appear with the SAME name — quantity is NOT a
readable field; the UI sorts the larger stack HIGHER in the list. So the tiebreak within the SAME rank is
LIST POSITION: pick the LOWEST INDEX. This requires the offered-list read to preserve the PANEL's order —
verify that in code (the read should walk the panel array sequentially); include each entry's index in the
log line so the user can confirm read-order == UI-order on the first live panel.
Implement the table as a const array `VERISIUM_REWARD_PRIORITY = ['divine orb', 'perfect chaos orb', ...]`
(index = rank) so the user can extend it later from pricing data without code changes. Name matching: the
bare-name entries must not swallow tiered ones — match 'chaos orb' only when no tier prefix matched (order
the checks by table rank; first table hit = the rank).
LOGGING (load-bearing for the user's validation): at each selection, one line —
`[Verisium] rewards: <#0 name | #1 name | ...> -> picked #i <name> (rank N | first-offered)`.
The offered list is read at panel-open each time (the array is freed on refresh — never cache).

## C. The full flow, verbatim user spec (verify each leg; fix only what deviates)
1. Go to the verisium; CLEAR the mobs around it (existing engage/posture machinery owns this).
2. STOP (item A: within 15u, stationary ~300ms), OPEN the encounter, PICK from the list (item B).
3. FIGHT the waves around it — the existing stand-and-clear with its timeout (T0.4 stand + TASK-35 posture,
   leash 60u; the existing wave/give-up timeouts stay as the bound).
4. THEN the reward remnant: approach to WITHIN 40u (user: 100u technically works — 40u is the reliability
   margin, const `VERISIUM_LOOT_OPEN_R = 40`), and fire the OPEN up to 5 times, 500ms apart, UNTIL it reads
   opened/looted (stop retrying on the opened signal; 5 misses -> the existing give-up path). Const-driven:
   `VERISIUM_OPEN_RETRIES = 5`, `VERISIUM_OPEN_GAP_MS = 500`.
Walk the whole chain in code and confirm A/B did not orphan any step (especially the panel-open wait
between select and read). Where the existing flow already matches a leg, say so in the report — do not
re-engineer working machinery.

## D. Objective-manager conformance (user: "do what we do with other objectives")
Verisium must be a FIRST-CLASS citizen of the objective/content system, exactly like abyss/breach/incursion.
Much is already wired (CONTENT_POLICY value 115 timeSensitive, OBJ_DRIVABLE Expedition2->verisium,
CQTYPE_TO_DRIVE, runners at both drive sites, objectiveTypeComplete phantom gate). AUDIT every surface the
other types have and close any gap, with a per-surface verdict table in the report:
  queue upsert/dedupe | arbiter pick + ins budget (known1000) + [Ckpt] yield | OB claim/freeze ladder |
  required-objective drive (pre-boss) | completion prune + MAP SUMMARY tally | resume persistence
  (map_state.json) | radar marker dim-on-complete.
Fix ONLY conformance gaps — no redesign of the working exp2 chain.

## E. Expedition maps: keep skipping (user ruling "for now")
On expedition-flavored maps (the logbook / Grand Expedition areas from the atlas contentSet block), the
verisium machinery keeps whatever skip/exclusion it has today — do not enable the new flow there. Verify
where that gate lives and state it in the report; if no gate exists, add the cheapest one (area/contentSet
check) so these maps are untouched.

## Hard limits
- mapper.js ONLY (the exp2/verisium block + one const table). No new entity scans; no raw memory reads; no
  DLL edits (STOP + report if a binding is missing). Consts: `VERISIUM_STOP_OPEN_ON = true` (A),
  `VERISIUM_REWARD_PRIORITY_ON = true` (B); flag-off = today's behavior byte-for-byte.

## Acceptance
- `node --check mapper.js`; parity walks.
- Report per HOUSE_RULES + live checklist: the runner stops+settles before every open (no moving opens);
  each selection logs the indexed offered list + the pick with its rank; a Divine offer is never passed
  over; same-rank ties pick the lower index; an all-junk panel picks the first entry; the reward remnant
  opened from <=40u with the 5x/500ms retry (stops on the opened signal); the D conformance table filled
  per surface; expedition maps untouched.

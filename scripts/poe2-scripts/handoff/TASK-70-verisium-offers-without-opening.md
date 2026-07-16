# TASK-70 — Compute verisium offers WITHOUT opening the panel (replicate the catalog rune-filter from the encounter's data)

USE FABLE (hard RE + data-flow). Bridge REQUIRED (live encounter). Depends on TASK-68 (offered-read) landing first.
This is the "construct without opening" the user asked for. STAGED C++ if a binding is needed (cpp-commit-discipline).

## What the IDA dive PROVED (PathOfExile.exe, fresh IDB, 2026-07-14)
The offered recipes are NOT a random roll stored on the encounter -- they are a DETERMINISTIC FILTER of the
full 321-recipe catalog by the encounter's RUNE/TIER data, applied at panel-open. Chain:
- Panel populate `sub_140620BD0` (mode a2). Remnant branch: `v11 = sub_141DE3160((*(*(enc+416))+440)(enc+416), mode)`
  (a red-black-tree map lookup on the ENCOUNTER object `enc = panel+744`, key=mode -> persistent data, NOT a roll).
- `v18 = sub_141DEE730(v11+88, 34738)` -> the encounter's rune/tier record.
- `sub_141E62380(&offered, tier=*(u8)(*(*(v18+16)+120)+196), a5=*(v18+56), matchOnly=(*(v18+88)==3),
  a7=*(v18+60)/*(v18+56), runes=v18+40, filter=*(enc+392), &counter)` BUILDS the offered list:
  iterate catalog (185-byte rows, begin..end): KEEP recipe R iff  `*(R+32) <= a7` (tier) && `a2 in
  [*(R+36) lo .. hi]` (level band) && (rune-slot a5 of R == the placed rune type `*runes`) && the
  rune-availability bitmask (from a 57-byte table via sub_141E61840) has R's bit && the category filter
  `sub_14010F0F0(filter, R+121)` passes. The matched rows == the OFFERED recipes (== the tiles TASK-68 reads
  as visible). Reward name = R+0x2C->+0x20; runeCount = R+0x08; index = (R-rowBegin)/185.

## Phase A — prove the encounter data is READABLE PRE-OPEN (bridge, decisive)
On a remnant, BEFORE opening: find the encounter object the panel would bind (enc). Candidates: the
Expedition2Encounter entity (id, e.g. 1440) or its actor/league sub-object. Read enc+416 -> call vtable[440]
(or read the map it returns) -> mode lookup (sub_141DE3160 logic: 2 rbtrees at +16/+32 keyed by u32 at +8,
value at +5*8) -> +88 -> sub_141DEE730(.,34738) -> the rune/tier record (v18). If that record is populated
before opening -> WITHOUT-OPENING CONFIRMED. If it only populates on open -> report + stop (fall back to the
TASK-68 open-read, which already works).

## Phase B — implement `getVerisiumOffers(encounterEntity)` (C++ binding, staged)
Replicate sub_141E62380's filter in C++ read-only against the live catalog + the encounter's rune/tier record.
Return the same shape as getExpedition2Offered ({name, runeCount, setId, index, address}) so the JS ranker is
unchanged. Then the bot can rank + decide the target recipe WITHOUT opening; open only to send the select+
activate (or, stretch: RE the select/activate packets to fire headless -- separate task, packet-capture).
Verify: getVerisiumOffers(enc) == getExpedition2Offered() (open panel) on the same remnant, several maps.

## Note
sub_141E61840 (the 57-byte rune-availability table) + sub_141DEE730 + sub_14010F0F0 (category filter) each
need a short decompile to pin their exact field reads. The hard part (the filter algorithm + its data source)
is DONE above; Phase B is careful transcription + live validation.

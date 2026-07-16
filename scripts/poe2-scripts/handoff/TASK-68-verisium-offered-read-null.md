# TASK-68 — Verisium offered-read: SOLVED (deterministic C++ patch STAGED) + IDA model of the panel

## STATUS 2026-07-14: FIX WRITTEN (staged in poe2_wrap.cc, awaiting user rebuild + live verify)
GetExpedition2Offered rewritten: walk ui_root[39][3][2][2][0] = the catalog tile POOL; a tile is OFFERED iff
(*(tile+0x180) & 0x800) [visible bit]; recipe = *(tile+0x540) -> index (row-rowBegin)/185; +0x548==table
validates. Replaces the whole-heap {rowPtr,0} scan. Fixed-array (<=32), returns null + JS-diagnostic on path
drift. UI child = *(*(el+0x10)+i*8), count = (*(el+0x18)-*(el+0x10))/8. REBUILD via rebuild_debug.bat.

## IDA MODEL (PathOfExile.exe, IDB fresh-verified vs live) — answers "construct WITHOUT opening?"
The "Runeshape Combinations" panel is a full-catalog TOME: it holds a tile for EVERY recipe (321), cached in
a red-black-tree keyed by recipe ptr (sub_140622570 = lazy get-or-create tile; sub_140618EA0 = tile ctor,
builds runes/reward art from the recipe). The OFFERED recipes are the tiles marked VISIBLE (+0x180 & 0x800)
when the panel opens. CRITICAL for "without opening": the 2 offered recipe-row POINTERS appear ONLY in the UI
tiles + {row,table} wrappers — search_ptr found NONE inside the encounter entity (0x593B1D0DC80) or controller
(0x593B10B6400). So the offered set is NOT stored as recipe pointers on the entity; it is applied to the UI at
open-time. Whether the offered set exists PRE-OPEN as indices/seed on the entity is the one open question ->
settle by either (a) the fresh-UNOPENED-remnant probe (30s: walk to a remnant, DON'T open, probe entity/
controller for {243,244}-type data), or (b) one more IDA layer: find who sets the 0x800 visible bit on offered
tiles (xref the factory sub_140622570 / the +0x180 write) and trace its data source (server packet vs entity
field vs client roll). If the source is a server packet delivered on open -> "without opening" is impossible.

## (historical RE notes below) — Replace getExpedition2Offered's full-heap signature scan with a DETERMINISTIC read (ROOT CAUSE FOUND)

## ROOT CAUSE CONFIRMED (planner live RE, Sanctuary 15:06, panel OPEN)
`GetExpedition2Offered` (poe2_wrap.cc ~9467) does NOT chase a pointer — it **brute-force scans ALL committed
memory** (0x10000000000..0x7ff000000000) every call for a byte-signature: a stride-16 run of {rowPtr, 0}
where rowPtr ∈ [rowBegin,rowEnd) (ScanRegionForExp2Offered ~9439). It returns null when that scan MISSES,
which is inherently unreliable: (a) the region filter requires `MEM_PRIVATE` — an offered array in a MEM_MAPPED
arena is skipped; (b) it takes the FIRST matching run (a false-positive run at a lower address wins); (c) it
is SLOW (full-heap walk) and the heap CHURNS mid-scan on a busy map (Sanctuary had 4300 entities + AV storms
50/sec at jmrpoe2.dll+0x29580F) — the __except just skips a region that moved. INTERMITTENT by construction:
worked SteamingSprings/Deserted, failed Spring_/Oasis/Sanctuary. getExpedition2Recipes (catalog, 321) uses a
DETERMINISTIC chain and always works; getExpedition2Selected has the SAME full-heap-scan fragility (vtable
kSelVtRva) and returns -1 either way. Live proof: offered=NULL while the panel VISIBLY rendered 2 offers
(Medved's Saga, 3x Greater Regal Orb).

## DETERMINISTIC ANCHORS ALREADY FOUND (planner, live 2026-07-14 — offsets are per-session, RE the CHAIN not the values)
- Catalog vec (the {rowBegin,rowEnd} struct): found via `*vec==rowBegin && *(vec+8)==rowEnd`.
- **Exp2 MANAGER struct** (the FindExp2Table target): `table+0x28 == vec`; found it uniquely by search_ptr
  for vec -> table = matchAddr-0x28. table+0 = a PathOfExile.exe vtable; table+0x08 = an unexplored sub-object
  ptr (0x592ACD2C4D0 this session) — CHECK IT FIRST for the offered vector. The manager is STATIC (catalog),
  so the per-encounter OFFERED list likely hangs off the ENCOUNTER not the manager.
- Encounter entity (Expedition2Encounter, id 1440) components: Positioned/BaseEvents/Animated/
  InteractionAction/StateMachine/MinimapIcon/Preload/Brackets/Stats/Buffs/Life/Functions/Targetable/Render.
- Controller entity (RuneEncounterController, id 1441) components: ...+**Inventories**+Actor+Monster+
  Functions+DiesAfterTime+... — the offered recipes may be modeled under Inventories/Functions/StateMachine.

## *** THE ACTUAL BUG (planner live RE, Sanctuary, remnant 1440 still open) ***
The offered-entry STRUCT GREW: it is now **STRIDE 24 = {rowPtr(8), uiTilePtr(8), int32 runeCount+pad(8)}**,
NOT the stride-16 {rowPtr, 0} the scanner (ScanRegionForExp2Offered / Exp2IsRowPtr) assumes. Proof: found the
run by search_ptr'ing the two visible offered reward rows (Medved's Saga idx244 @0x592AD65B064, Greater Regal
Orb idx243 @0x592AD65AFAB) — their references sit exactly 0x18 apart. Dumped the run @0x592AD7736A0:
  +0x00 rowPtr 0x592AD65AD80 | +0x08 0x593AAC7A942 | +0x10 0x17
  +0x18 rowPtr ...AE39        | +0x20 ...9F4         | +0x28 0x15
  +0x48 rowPtr ...AFAB (Greater Regal) | +0x60 rowPtr ...B064 (Medved) | +0x78 ...B11D (Uhtred) ...
Because the scanner steps 16 and requires *(X+8)==0, on a stride-24 run *(X+8) is the uiTilePtr (non-zero) ->
the run never validates -> null. THIS is why it's "intermittent": it fails whenever the panel's offered list
is the new 24-byte layout (and any earlier 16-byte successes were a different/older path or luck). The
`+8==0` gate is the single wrong assumption.
*** CORRECTION (user confirmed the panel offered EXACTLY 2: Greater Regal 243 + Medved 244) ***
The stride-24 run @0x592AD7736A0 holds 243,244,**245,246**... = CONTIGUOUS catalog rows -> it is the CATALOG
(or a rune-tier tile VIEW), NOT the 2-item offered set. 243/244 only looked paired because they're adjacent
in the catalog. So the offered signature is deeper-wrong than stride: NONE of the found row-pointer references
isolate just {243,244} as a 2-entry run -> the offered list almost certainly does NOT store raw recipe-row
pointers. It likely holds N per-offer WRAPPER objects (each -> recipe row + reward), so the whole "scan heap
for a run of rowPtrs" premise is invalid on the current client. RE the offered list FROM THE PANEL: the UI
visualizer on the open "Runeshape Combinations" panel -> the bound list element -> its 2 children -> each
child's recipe/reward pointer. That is the authoritative source; the row-pointer scan should be REPLACED, not
patched to stride-24. (Stride-24 is still the correct decode for the CATALOG-tile struct if ever needed.)

## THE FIX (deterministic; flag none — it's a C++ read correctness fix, but stage + user-rebuild + live-verify)
0. **FIRST + SUFFICIENT-FOR-B: update the offered signature to stride 24.** Exp2 entries are {rowPtr, ptr,
   int}; change ScanRegionForExp2Offered to step 24 and validate `rowPtr∈[rowBegin,rowEnd) && (rowPtr-rowBegin)%185==0`
   at +0, WITHOUT the `+8==0` gate (use the +0x10 int as a sanity bound instead, e.g. 0<runeCount<=15). This
   alone likely fixes it. Confirm the stride at a fresh panel (the 0x18 gap = 24).
1. Find the OFFERED list via a fixed pointer CHAIN (not a scan). Candidates in priority order: manager
   table+0x08 sub-object; the controller's Inventories/Functions component; the open PANEL UI element
   (getUiRoot walk, like getMinimapIcons — the USER'S UI VISUALIZER can pinpoint the "Runeshape Combinations"
   panel element + its data ptr fastest). The offered run keeps its {rowPtr,0} stride-16 shape once located.
2. If a 100%-deterministic owner resists RE, the MINIMUM viable fix is to NARROW the scan: the offered run is
   in the SAME arena as the manager (all 0x592*/0x593* this session) — scan only `table ± ~64MB` instead of
   all memory, and DROP the `MEM_PRIVATE`-only filter (accept MAPPED). That kills the slowness, the churn
   window, and the far false-positives in one change even without a perfect pointer. Keep the run signature.
3. Verify live: at a panel that fails today, the new read returns the offered rows; select lands; encounter
   starts. Cost: one bounded read, no full-heap walk.

## Original brief (superseded by the above; kept for the JS-side context) —
# (old) RE why getExpedition2Offered() intermittently returns null

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-68\`. USE OPUS 4.8.
This is a READ-path RE task. If the fix is C++ (offered-read binding), stage the diff UNCOMMITTED for the
user to rebuild (cpp-commit-discipline, no-blind-memory-writes). Bridge REQUIRED — the user reproduces at a
LIVE remnant with the panel open. Single-client pipe: fire when no other session holds it.

## Evidence (C:\tmp\log.txt Spring_ 14:19-14:20 + planner live probe 2026-07-14)
Chain: reached -> clear -> OPENED (37u) -> "offers unreadable 15s -> BLIND HAMMER" -> 8x "re-HAMMER
(encounter not started yet)" -> "hammer never took (8) -> ESC-close + skip". Planner probe at the panel:
- `getExpedition2Offered()` = **null**  (the compute path supplying offered recipe INDICES is empty)
- `getExpedition2Recipes()` = 321        (full catalog ALIVE -- so exp2CatalogAlive true, which is why the
                                          "recipe bindings DEAD" fast-skip at mapper ~5197 did NOT fire)
- `getExpedition2Selected()` = {selected:-1, runeCount:0}  (nothing committed -- the screenshot's highlighted
                                          combo + "1x Divine Orb" is the panel HOVER preview, not a locked select)
- remnant 1291 Expedition2Encounter tgt:false alive (post-skip state)
CRITICAL: the SAME code fully looted remnants EARLIER THIS SESSION -- SteamingSprings 1124 "SELECT sent:
Uncut Spirit Gem (idx 262, 6 runes)", Deserted 989 -- so getExpedition2Offered WORKED there. This is
INTERMITTENT, not a dead binding. The failure = offered-read null on SOME remnants -> blind ACTIVATE with no
committed SELECT -> encounter never starts (activation REQUIRES a valid select first, per the mapper's own
5167 comment).

## Phase A — RE the null (bridge, user parked at a LIVE readable panel; capture BOTH a working and a null case)
1. Trace getExpedition2Offered in poe2_wrap.cc: what UI-tree / DAT chain does it walk? At the null panel,
   read each hop live (getUiRoot walk) and find WHERE it returns empty -- panel element missing? offered
   sub-list pointer null? count 0? a settle/timing race (offered populates later than the catalog)?
2. Separate the hypotheses with data: (a) TIMING -- offered populates N ms after open; we read too early and
   cache the empty (VERISIUM_PANEL_SETTLE_MS too short for this remnant class). (b) DISTANCE -- opened from
   37u (planner's own 2026-07-14 open-radius relax); does a closer open populate offered? Rule in/out.
   (c) REMNANT-TYPE -- this remnant's offered list lives at a different offset/state than the working ones.
   (d) BINDING -- the compute path drifted for a sub-case the catalog read doesn't cover.
3. The UI name-match FALLBACK (exp2OfferedFromUI) also returned nothing here -- trace why it couldn't read
   the visibly-rendered offers (the panel CLEARLY shows 4 runes + a reward). If the UI tree carries the
   offered runes, a robust UI read is the fix even when the compute path is null.

## Phase B — fix per Phase A's verdict (flag `VERISIUM_OFFERED_FIX_ON = true`, off = today)
- TIMING -> lengthen/adaptive settle for the offered read specifically (poll offered until non-null, bounded,
  before deciding blind).
- UI-READABLE -> make exp2OfferedFromUI read the rendered offered runes reliably (the panel shows them).
- C++ binding gap -> staged getExpedition2Offered fix (user rebuilds).
- REGARDLESS: when offered is genuinely unreadable, do NOT blind-hammer ACTIVATE (proven to never start
  without a select) -- either skip clean+fast (ban 5min, keep mapping) OR, if a SELECT can be sent blindly
  by ranked catalog index, send SELECT-then-verify before any activate. Never flail activate 8x.

## Hard limits
No unverified activate/select packets into the live encounter (cog/DC risk -- this subsystem's whole history).
node --check. TEST BEFORE COMMIT. Report handoff\TASK-68-REPORT.md: the offered-read chain + null point,
the (a)-(d) verdict, working-vs-null diff, the fix + flag-off parity.

## Note for the orchestrator
Rule out the planner's 2026-07-14 open-radius relax (opened at 37u) as a contributor FIRST -- if a closer
open reliably populates offered, the simplest fix is tightening the open for the READ, independent of B.

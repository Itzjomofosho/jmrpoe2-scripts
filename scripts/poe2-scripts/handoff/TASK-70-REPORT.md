# TASK-70 REPORT — Compute Verisium offers WITHOUT opening the panel

## STATUS: STATIC RE **COMPLETE** · Phase A live-confirm + Phase B implementation **BLOCKED (game not running)**
The brief's "hard part" (the offer-filter algorithm + its data source) is fully reverse-engineered and
transcription-ready below, verified against the current fresh IDB (matches the on-disk PathOfExile.exe).
The three things that remain are **runtime-state** questions — which JS entity is `enc`, the `mode` value,
and confirming the record is populated pre-open — and per HOUSE_RULES those are settled by a **live bridge
read, not static deduction**. The bridge pipe is down (game/DLL not injected right now), so:
- Phase A's decisive probe **cannot run** this session.
- Phase B (`getVerisiumOffers`) **cannot be written correctly** — it needs the entity→enc mapping + mode
  from Phase A. Writing it now would be guessing offsets = blind reads. Per HOUSE_RULES ("do not guess
  beyond the brief"; no-blind-memory-reads; "settle runtime questions with one live probe") **I did NOT
  write speculative C++.** A paste-ready Phase A probe + a full Phase B transcription spec are delivered
  instead so the follow-up (with a live remnant) is fast.

> Note on model: the brief says "USE FABLE". This session ran **Opus 4.8 (1M)** — I cannot self-switch model,
> and HOUSE_RULES rule 0 forbids spawning an agent/fleet to do it. Flagging per the model-routing rule.

---

## Files touched
- `handoff/pre/TASK-70/poe2_wrap.cc` — FIRST-ACT snapshot (the diff base; already carries TASK-68's staged
  offered-read rewrite, which TASK-70 builds on).
- `handoff/TASK-70-phaseA-probe.js` — NEW read-only `eval_js` diagnostic (finds `enc` on an unopened
  remnant + dumps the map-getter RVA). `node --check` passes.
- `handoff/TASK-70-REPORT.md` — this file.
- **No behavior code changed.** `src/poe2/poe2_wrap.cc` is untouched by me (its `M` in git = TASK-68).

---

## What the RE PROVED (all offsets from the current IDB; the brief had a5/a7 swapped — corrected here)

### The offer builder — `sub_141E62380` (the algorithm to transcribe)
Iterates the 321-row catalog and KEEPS the rows that become the offered tiles. Inputs, and the exact
per-row (`R`, 185-byte stride) predicate:

Availability bitmask (built first, from `Data/Balance/Expedition2RunesWeights.dat`, 57-byte rows via
`sub_141E61840` → `table+0x28` → {begin,end}): for each row `e`, set bit `i32[e+8]` when
`i32[e+12]-1 == ruleSlot && u64[e+16] == placedRune && level >= i32[e+32]`.

KEEP row `R` iff **all** of:
1. `i32[R+32] <= tierCeiling`                              (recipe tier ≤ ceiling)
2. `level >= i32[R+36] && level <= i32[R+40]`             (level band; band is the qword at R+36: lo=low32, hi=high32)
3. if **not** matchOnly:
   - `ruleSlot < u32[R+8]`                                 (slot in range of recipe's rune count)
   - `u64[ u64[R+16] + 16*ruleSlot ] == placedRune`        (recipe's rune in that slot == the placed rune type)
   - `i32[R+32] == tierCeiling`  **OR**  bit `i32[R+32]` of the availability bitmask is set
4. `filter == 0`  **OR**  `sub_14010F0F0(filter, R+121) == 0`   (category not excluded)

Emit shape per kept row (identical to `getExpedition2Offered`, so the JS ranker is unchanged):
- `name`  = wstr at `u64[R+0x2C] + 0x20`  (fallback wstr at `R+0x18`)
- `runeCount` = `i64[R+0x08]`
- `setId` = `i32[R+0x71]`
- `index` = `(R - rowBegin) / 185`
- `address` = `R`

`sub_14010F0F0(filter, R+121)`: returns 0 (keep) when `*(R+121)==0`; else computes the recipe's category
index `(*(R+121) - *(*(R+129)+40)) / 12` and returns `sub_14013CD10(filter+584, idx)` (excluded-bitset test).

### Where the inputs come from — `sub_140620BD0` / `sub_14061E330` (panel populate)
`enc = *(panel+992)` (outer panel) / `*(panel+744)` (inner). The panel is a **pure consumer**:
```
S       = u64[enc+416]
map     = ( *(u64[S] + 440) )(S)              // VIRTUAL getter, slot[440]
v11     = sub_141DE3160(map, mode)            // 2-rbtree lookup, key=mode  (read-only)
v18     = sub_141DEE730(v11+88, 34738)        // binary-search sorted vec, key 0x87B2  (read-only)
```
From `v18` (the per-mode rune/tier record) and `enc`:
- `level        = u8 [ u64[ u64[v18+16] + 120 ] + 196 ]`
- `matchOnly    = ( i32[v18+88] == 3 )`
- `ruleSlot     = i32[v18+60]`      ← (brief called this "a5=*(v18+56)"; **wrong**, it's `+60`)
- `placedRune   = u64[v18+40]`
- `tierCeiling  = i32[v18+56]`      ← (brief called this "a7 = *(v18+60)/…"; **it's just `+56`**)
- `filter       = u64[enc+392]`

`sub_141DE3160` node layout (for the C++/JS replication): `map+16`=tree1, `map+32`=tree2; node: `+0`=left,
`+16`=right, `+25`=isnil byte, `+32`=key(u32), `+40`=value(ptr). `sub_141DEE730`: 16-byte entries over
`[*(v11+88), *(v11+96))`, `+0`=u16 key, `+8`=value ptr.

Static tables (both located like `FindExp2Table`, by exact DAT path string — no RVA, drift-proof):
- Catalog: `Data/Balance/Expedition2Recipes.dat` (len 35) → `FindExp2Table()`, 185-byte rows.
- Availability: `Data/Balance/Expedition2RunesWeights.dat` (len 40) → **new** locate, 57-byte rows.

---

## Phase A VERDICT (static): "without opening" is **almost certainly POSSIBLE** — needs one live probe to confirm
Every hop from `enc` to `v18` is a **read-only lookup into a persistent container** (vtable getter → rbtree
lookup → binary search). The panel never constructs any of it; it reads `enc+392` and `enc+416` that already
exist on a game-side object. So the rune/tier roll that determines the offers is per-encounter state that is
populated at encounter creation / server sync — i.e. **before** the panel opens. That's the favorable case.

**Not yet confirmable without the bridge (runtime-only):**
1. **enc identity** — which JS-visible object is `enc = panel+992`? (Expedition2Encounter entity 1440, the
   RuneEncounterController 1441, or a component/sub-object of one.) Needed to reach `enc` headless.
2. **map getter behavior** — `vtable[440]` on `S`: does it just `return *(S+K)` (a field → fully walkable,
   zero risk), or does it **lazily construct** the map (then calling it pre-open would create it — a side
   effect, and it'd mean the map is NOT truly pre-open state)? Must decompile the getter once its address
   is known live. The probe dumps its RVA.
3. **mode value** — the `a2` the remnant binds. Small constant; read it live.

HOUSE_RULES is explicit that this class of question is where "a 30-agent investigation once concluded the
exact opposite of what a single live probe showed." So I stop at the static verdict and hand over the probe.

---

## NEXT STEP / LIVE-TEST CHECKLIST (do this at a LIVE, UNOPENED remnant — bridge up)
1. Walk within stream range of a Verisium remnant. **Do NOT open the panel.**
2. Paste `handoff/TASK-70-phaseA-probe.js` into `eval_js`. Expected outcomes:
   - **PASS (favorable):** ≥1 line `ENC? via <comp> … +392(filter)=0x… +416(S)=0x… getter=vtable[440]=0x…`
     with a **non-null filter**. → `enc` and the top of the chain exist pre-open. Record the `via <comp>`
     (that's the entity→enc mapping) and the `getter` RVA.
   - **FAIL / all filters NULL / no candidate:** the data is not on the entity pre-open → **without-opening
     is not viable; fall back to the TASK-68 open-read** (which is the whole point of TASK-68 landing first).
3. Decompile the dumped `getter` RVA (subtract the printed `base`, add `0x140000000`). If it returns a field
   `*(S+K)`: read `map=*(S+K)`, replicate the rbtree + binsearch (layouts above) for `mode` in `0..8`, reach
   `v18`, and dump `level / tierCeiling / ruleSlot / placedRune / matchOnly`. **Non-empty `v18` pre-open ==
   WITHOUT-OPENING CONFIRMED.**
4. Only then implement Phase B (spec above) as a staged, SafeRead-guarded `getVerisiumOffers(entity)` and
   validate `getVerisiumOffers(enc) === getExpedition2Offered()` (open panel) on several remnants.

---

## Risks / deviations / open questions
- **Dependency not landed:** TASK-70 depends on TASK-68 (offered-read) landing; TASK-68 is *staged, not yet
  rebuilt/verified* (no REPORT). The Phase B oracle (`getExpedition2Offered` must be *correct*) is therefore
  itself unproven — validate TASK-68 first, then use it as TASK-70's reference.
- **No C++ written — deliberate.** Blocked on the two live unknowns above (enc identity, getter behavior).
  Writing `getVerisiumOffers` now would guess the entity→enc offset and blindly call/replicate the getter,
  against a subsystem with a cog/DC history (brief's Hard limits). Deferred to post-Phase-A, as the gate demands.
- **Getter lazy-init caveat:** if `vtable[440]` allocates, a headless `getVerisiumOffers` that calls it would
  mutate game state on a closed panel. The follow-up must confirm it's a plain field-return before calling it
  from the binding (or replicate the field read).
- **Brief offset corrections:** `ruleSlot = i32[v18+60]` and `tierCeiling = i32[v18+56]` (the brief swapped
  these / wrote a spurious "/"). `a2` is the **level** band input, not "tier". Verified in `sub_140620BD0`.
- **Probe precision:** `poe2.readMemory(_, 'int64')` returns a JS Number; live heap/exe addresses are < 2^53
  so exact (same assumption the existing scripts rely on). Fine for pointers, not for full 64-bit values.
- **Model:** ran Opus 4.8, not the requested Fable (can't self-switch; no fleets per rule 0).

## Definition-of-done checks I could run (bridge down)
- `node --check handoff/TASK-70-phaseA-probe.js` → **PASS**.
- Symbol grep: chain fns `sub_141E62380 / sub_141DE3160 / sub_141DEE730 / sub_141E61840 / sub_14010F0F0`
  and inputs `sub_140620BD0` all decompiled & cross-checked against the IDB this session.
- No `getVerisiumOffers` binding exists yet (grep-confirmed) — intentionally not added.

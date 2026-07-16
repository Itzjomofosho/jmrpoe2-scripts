// TASK-70 Phase A probe — paste into the bridge `eval_js` at a LIVE, UNOPENED Verisium remnant.
// GOAL: settle "can we compute the offers WITHOUT opening the panel?" by proving the encounter's
//       rune/tier record chain exists on the entity BEFORE the panel is opened.
// READ-ONLY. Uses poe2.readMemory / readCString only. No writes, no packets, no vtable calls.
//
// WHY it can't reach v18 in pure JS: the chain hop enc+416 -> (vtable[440] getter)(S) -> mode-map is a
// VIRTUAL CALL, and there is no callFunction JS binding. Worse, that getter MIGHT lazily construct the
// map on first call — so calling it would MASK whether the map pre-existed (the exact thing Phase A tests).
// Therefore this probe stops at the getter and DUMPS it (as an RVA) for a follow-up decompile:
//   * if the getter turns out to just `return *(S + K)` (a field), the whole chain is JS/C++ walkable
//     with no call — finish it directly.
//   * if it lazily builds, "without opening" reads must instead hook the encounter's server-sync writer.
//
// A "PASS" here = at least one enc candidate on the UNOPENED remnant has BOTH +392 (filter) as a live
// heap ptr AND +416 (S) as an object with an exe-range vtable whose slot[440] is exe-range code. That
// means the top of the deterministic chain is present pre-open. Then decompile the dumped getter RVA to
// finish (or confirm) the walk to v18.
(function () {
  const R = (a, t) => { try { return poe2.readMemory(a, t) || 0; } catch (e) { return 0; } };
  const U64 = a => R(a, 'int64');
  const I32 = a => R(a, 'int32');
  const cstr = a => { try { return poe2.readCString(a) || ''; } catch (e) { return ''; } };

  const base = (typeof poe2.getModuleBase === 'function') ? (poe2.getModuleBase() || 0) : 0;
  // exe .text/.rdata live range (generous 256MB window from the ASLR base); RVA = live - base + 0x140000000
  const inExe = p => base && p > base && p < base + 0x10000000;
  const rva = p => (p && base) ? ('0x' + (p - base + 0x140000000).toString(16)) : '0x0';

  const ents = ((typeof poe2.getAllEntities === 'function') ? poe2.getAllEntities() : poe2.getEntities()) || [];
  const rem = ents.filter(e => /Expedition2Encounter/i.test(e.path || e.name || e.baseEntityPath || ''));
  if (!rem.length) {
    return 'NO Expedition2Encounter entity in range. Walk WITHIN stream range of a remnant and do NOT open it, then re-run.';
  }

  const out = ['base=0x' + base.toString(16) + '  (RVA column = IDA address at imagebase 0x140000000)'];
  for (const e of rem) {
    const entBase = e.address || e.addr || 0;
    out.push('--- Expedition2Encounter id=' + ((e.id >>> 0)) + ' @0x' + entBase.toString(16) + ' path=' + (e.path || e.name || ''));
    if (!entBase) { out.push('  (no address on entity object)'); continue; }

    // enc candidates: the entity base itself + every component pointer (ui_tree.js component-map walk)
    const cands = [{ nm: 'entityBase', p: entBase }];
    try {
      const ed = U64(entBase + 0x08), head = U64(entBase + 0x10);
      if (ed && head) {
        const look = U64(ed + 0x28);
        const bb = U64(look + 0x28), be = U64(look + 0x30);
        if (bb && be > bb) {
          let n = (be - bb) / 16; if (n > 64) n = 64;
          for (let i = 0; i < n; i++) {
            const np = U64(bb + i * 16), idx = I32(bb + i * 16 + 8);
            const cp = U64(head + idx * 8);
            if (cp) cands.push({ nm: 'comp:' + (np ? cstr(np) : '?'), p: cp });
          }
        }
      }
    } catch (_) {}

    let hit = 0;
    for (const c of cands) {
      const filter = U64(c.p + 392);   // enc+392 = category filter (a8)
      const S = U64(c.p + 416);        // enc+416 = data-holder sub-object
      if (!S) continue;
      const vt = U64(S);
      if (!inExe(vt)) continue;        // S must carry an exe vtable
      const getter = U64(vt + 440);    // vtable[440] = the mode-map getter
      if (!inExe(getter)) continue;
      hit++;
      out.push('  ENC? via ' + c.nm + ' @0x' + c.p.toString(16)
        + '  +392(filter)=0x' + filter.toString(16) + (filter ? '' : ' <-- NULL (filter empty; encounter not live?)')
        + '  +416(S)=0x' + S.toString(16)
        + '  S.vtable=' + rva(vt)
        + '  getter=vtable[440]=' + rva(getter) + '  <-- DECOMPILE THIS to finish the chain');
    }
    if (!hit) out.push('  no candidate matched the +392/+416 enc signature (no component has an exe-vtable object at +416).');
  }
  out.push('');
  out.push('NEXT: decompile each dumped getter RVA. If it returns a field of S (e.g. `return *(S+K)`),');
  out.push('read map=*(S+K) then replicate sub_141DE3160(map, mode) + sub_141DEE730(v11+88, 34738) to reach v18,');
  out.push('and dump v18 fields:  level=u8[[[v18+16]+120]+196]  matchOnly=(i32[v18+88]==3)  ruleSlot=i32[v18+60]');
  out.push('placedRune=u64[v18+40]  tierCeiling=i32[v18+56].  Non-empty v18 pre-open == WITHOUT-OPENING CONFIRMED.');
  return out.join('\n');
})();

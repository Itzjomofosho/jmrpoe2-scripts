# TASK-29 REPORT — Required-map completeness bundle (2026-07-12)

Implementer session. Files edited: **`mapper.js`** (A–F) + **`entity_actions.js`** (G only) — both in the RUNTIME dir
`c:\Games\jmr-poe2\scripts\poe2-scripts\`. No commits, no C++, no memory writes, no new packets.
Pre-snapshot: `handoff\pre\TASK-29\{mapper.js,entity_actions.js}` (copied FIRST, before any edit).
`node --check` passes on BOTH files. All new symbols grepped (definition + ≥1 use, no orphans).
Diff vs pre-snapshot: mapper.js ~271 changed/added lines, entity_actions.js ~17.

---

## Settings added (all default ON; flag-off = byte-parity control flow)

| Const | Default | Item | What flips it |
|---|---|---|---|
| *(none — rides `ABYSS_SWEEP_ON`)* | — | A | `ABYSS_SWEEP_ON=false` → whole sweep returns false at top (unchanged) |
| `SBOX_EVENT_HOLD_ON` | `true` | B | false → arm-watch returns immediately, step never owns a frame |
| `BREACH_ADOPT_HARDEN_ON` | `true` | C | false → only the existing queue-entry incidental detector runs |
| `ABYSS_ESSENCE_UNLOCK_ON` | `true` | D | false → `abyssTryEssenceUnlock` returns false → original skip runs |
| `PREBOSS_KNOWN_BUDGET_ON` | `true` | E | false → detour-scaled budget only (`budgetSrc` stays `detour`) |
| `BOSS_DEAD_BIT_ON` | `true` | F | false → today's scan-only (HP/isAlive) death detection |
| `INVULN_GATE_ON` | `true` (pre-existing) | G | false → both new clauses fall through to today's behavior |

Tunable consts added: A `ABYSS_SWEEP_BUDGET_PER_SITE_MS=25000`, `ABYSS_SWEEP_BUDGET_CAP_MS=240000` (floor stays
`ABYSS_SWEEP_BUDGET_MS=90000`); B `SBOX_EVENT_HOLD_ARM_R=60`, `_PLANT_R=14`, `_OWNED_MS=30000`, `_CAP_MS=45000`,
`_SETTLE_MS=3000`, `_FRESH_MS=4000`; D `ABYSS_ESSENCE_UNLOCK_R=120`, `ABYSS_ESSENCE_UNLOCK_MS=25000`; E
`PREBOSS_KNOWN_BUDGET=1000`; F `BOSS_GONE_DEAD_MS=8000`.

---

## Files touched — functions / symbols added or modified (searchable)

### mapper.js
- **A** — `abyssSweepBudgetMs()` (new; scales `max(90s, 25s*abyssSweepCnt.t)` cap 240s). `tryAbyssChestSweep` budget
  check rewritten: PRE-boss (`currentState!==MAP_COMPLETE`) exhaust → **PAUSE** (`return false`, keep sites, no latch,
  log `[AbyssSweep] pre-boss budget …s spent -> N site(s) deferred to post-boss`); POST-boss uses fresh anchor
  `abyssSweepPostStartAt`, exhaust → yield without latch. New state `abyssSweepPostStartAt`, `_abyssSweepBudgetLogAt`
  (+map reset). `abyssSweepDone` now set ONLY by `abyssSweepRetire` draining the list. `obSweepTick` capMs → `abyssSweepBudgetMs()`.
- **B** — `sboxEventArmWatch(now)`, `sboxEventHoldStep(player, now)` (new), state `sboxEventHold`, `sboxEventHoldDone`,
  consts `SBOX_EVENT_HOLD_*`. Hooked right after the beacon-chest-dwell hook (unlocked frames, before the state machine).
  Arms off `POE2Cache.lastStrongboxOpen` (published by opener.js) when a fresh box opened ≤60u and no `utilityActiveTarget`
  owns it. Reset in `resetMapper`.
- **C** — hardened breach-adoption backstop appended after the existing `_brIncChkAt` detector: player-proximity scan
  (`Monsters/Breach` ≤100u, ≥2 mobs) → adopt when uncommitted. Consts `BREACH_ADOPT_HARDEN_ON`, state `_brHardChkAt`,
  `_brLastRoamEndAt` (set in `runBreachRoam`'s finish path → 30s cooldown vs re-adopting stragglers).
- **D** — `abyssNearestUnopenedEssence(player,nx,ny)`, `abyssTryEssenceUnlock(player,now,t)` (new; reuse
  `unopenedEssenceMonoliths()` — no new scan). Called at BOTH abyss skip verdicts in `runAbyssRun` (the `ABYSS_DWELL_MS`
  hard cap AND the `ABYSS_CLEAR_MS` no-mob timeout) → `return false` (yield) to let the side-step open the essence.
  `abyssRequiredMidDrive` un-defers while the unlock is armed. State `abyssEssenceUnlockId`, `abyssEssenceUnlockAt`
  (+map reset). Gated to REQUIRED abyss (optional already gets the mid-drive side-step).
- **E** — `arbBossAnchorKnownConfident(anchor)` (new). `classifyObjective` KNOWN branch widens `budget` to
  `PREBOSS_KNOWN_BUDGET` (1000, above `INS_DETOUR_CAP` by design) + tracks `budgetSrc`. `arbGoal` dbg + `[ArbShadow]`
  log now print `src=<detour|known1000>`. Auto-widens the TASK-26 checkpoint yield (it reads `cl.tier`).
- **F** — new bit-death block in `case STATE.FIGHTING_BOSS` after the HP death loop. `bossScanLastSeenAt` stamped when
  the tracked boss is present in scan (+seed on fight entry, +map reset). When the boss is ABSENT ≥8s AND
  `mapObjectiveComplete('MapBoss')`, run the death routing → MAP_COMPLETE. **Multi-boss guard**: if a genuine outstanding
  "Defeat X" line still has a matching live arena unique, HAND OFF to it (stay in fight) instead. Consts
  `BOSS_DEAD_BIT_ON`, `BOSS_GONE_DEAD_MS`.

### entity_actions.js (G only)
- **G(1)** — invuln-gate HOLD branch now freezes the 3.5s hp-frozen heuristic (`aaStaleTid/aaStaleSince/aaStaleHp`
  reset to the current target each held tick) so a buff flicker can't ban a boss the gate is waiting out.
- **G(2)** — candidate-loop ban filter: `_invulnWatch` (new Set) tracks ids banned while immune; when the immunity buff
  clears the ban is dropped + the entity falls through → re-engages THIS tick. `_invulnWatch.clear()` added to the
  auto-attack-off reset. Both clauses gated by `INVULN_GATE_ON`.

---

## LIVE-TEST CHECKLIST

Run a 6+-site required-abyss map that also has a strongbox, a breach, and a known arena boss (SevenWaters-class).

### A — sweep budget scaling + pre/post split
- **Working**: on a big-queue map, if pre-boss time runs out you see `[AbyssSweep] pre-boss budget <N>s spent -> K
  site(s) deferred to post-boss` (N scales past 90 with site count, capped 240) — and after the boss,
  `[AbyssSweep] -> chest site …` lines resume and retire the remaining sites (`… retired: …`). Final map summary
  reaches `d==t` (all sites clean).
- **Broken**: `abyssSweepDone` latching pre-boss (no post-boss `[AbyssSweep] -> chest site` lines at all), or the old
  `budget …s spent -> N NOT visited` line firing pre-boss and dropping the list.

### B — drive-by strongbox hold
- **Working**: after the opener drive-by-opens a box with no dwell, `[Strongbox] drive-by open at (x,y) id=… , no
  utility owner -> event hold …`, then the bot STAYS and fights the guard wave, then `[Strongbox] event hold done
  (opened + settled) …`. No walking off mid-wave.
- **Broken**: no `[Strongbox]` line after a drive-by open (arm missed), or a hold that never ends (watch for the
  `cap` line as the 30s/45s backstop — a hold ending on `cap` every box means the opened-read isn't landing).
- Note: a box the bot WALKED to still uses the utility strongbox dwell (unchanged) — this hold is only for drive-by opens.

### C — run-through breach adoption
- **Working**: run THROUGH a breach without committing → `[Breach] HARDENED adopt: <N> live breach mobs within 100u of
  player, uncommitted -> adopting clear at (x,y) (queue-entry|mob-centroid)`, then the normal `[Breach] … cleared …`.
- **Broken**: ZERO `[Breach]` lines for the whole map after starting a breach (the TASK-29 bug), or the backstop
  re-adopting a breach we JUST cleared (should be blocked by the 30s cooldown + Breach-complete gate — watch for a
  second `HARDENED adopt` seconds after a `[Breach] … done -> leaving`).

### D — imprisoned-essence wave unlock
- **Working**: on a stalled abyss node whose last mob is imprisoned, `[Abyss] wave stalled, unopened essence at <d>u
  -> opening it first`, then the essence opener runs (utility walks + opens it), the freed mob dies, and the node
  finishes (`[Abyss] node … done/inert -> next` or the loot-dwell path) instead of `[Abyss] node … cap (closed off?)`.
- **Broken**: `[Abyss] node … cap (closed off?) -> next` on a required map with a visible un-opened essence right there,
  and no `wave stalled` line.

### E — known-boss pre-boss content budget
- **Working**: once the arena is located, `[ArbShadow] pick=… ONROUTE ins=… bud=1000 src=known1000 …` for
  beacon/strongbox-class content within a ≤1000u detour, and the bot DOES that content before stepping into the arena
  (`[Ckpt]` yield lines appear for it). `bud` and `src` both visible in the shadow line.
- **Broken**: `src=known1000` never appears even with the arena located (confidence gate too strict — check the
  bossTargetSource / anchor conf), or content with `ins>1000` being pulled pre-boss (should stay `OFFROUTE` → post-boss).

### F — dead-boss detection via MapBoss bit
- **Working**: if the boss dies unobserved (phase / device-recovery), within ~8s you see `Boss DEAD (objective bit;
  corpse never scanned) after <N>s absent from scan` → `State: FIGHTING_BOSS -> MAP_COMPLETE`, NOT the ~20s
  `DODGE-SEES-NONE … boss-doing: ?` wedge.
- **Multi-boss**: on a twin map, if boss #1 vanishes but #2 is alive with an outstanding "Defeat" line, you see
  `Tracked boss gone from scan …s (MapBoss bit) but a live objective boss "<name>" (ID:…) remains -> handoff, staying
  in fight` — it must NOT portal while a real 2nd boss lives.
- **Broken**: MAP_COMPLETE fired while a second required boss is still up (the bit gate should prevent this — if seen,
  the MapBoss bit is coarser than assumed; report it), or the wedge persisting because the bit never reads complete
  (maps with NO MapBoss row fall back to scan-only, unchanged — expected).

### G — invuln-phase ban hangover
- **Working**: during a boss invuln phase you may see `[Rotation] hold: <boss> invulnerable (out-of-range immunity)`
  but you should NOT see `[Rotation] hp frozen 3.5s on <boss> … -> ban 4s` fire against that boss during the phase;
  when the phase ends, damage resumes within a frame or two (no 1–2s dead air).
- **Broken**: `hp frozen 3.5s … -> ban 4s` on the boss during an invuln window, followed by a visible pause after the
  phase ends before shooting resumes.

---

## Risks / deviations / notes
- **D yield semantics**: `abyssTryEssenceUnlock` returning `false` yields the frame while KEEPING the abyss commitment
  (`abyssId`/`abyssDwell` untouched). Verified `arbTick` does NOT release `arbCommittedKey` on a `false` runner return
  (R1/R3 HOLD path re-selects the committed abyss next frame), so the commitment survives while `tryStartUtilityNavigation`
  services the essence. If a future change makes a `false` content-runner return release the arbiter commit, D would
  need a different hold mechanism. Bounded: the node's own `ABYSS_DWELL_MS` cap still runs first each frame, and the
  25s attempt window is one-per-node — an unreachable essence falls through to the original skip.
- **C threshold**: the backstop requires ≥2 live breach mobs within 100u (a real breach spawns many). A trivially-small
  breach with 1 straggler wouldn't adopt via the backstop, but the existing queue-entry detector still covers the
  committed-elsewhere case. Guards: Breach-objective-complete, active hive/verisium, and a 30s post-roam cooldown.
- **G(2) `_invulnWatch` bound**: an id can linger in the set if its ban expires naturally without the buff ever
  clearing while banned; it's cleared on auto-attack toggle-off and only ever holds a handful of banned-immune boss
  ids, so the leak is negligible. No per-map reset in entity_actions (it has no map hook) — toggle-off is the reset.
- **B**: the hold PLANTS at the box (mirrors the beacon-dwell pattern the brief named) and relies on the dodge to peel
  off lethal guard hits; it does not kite. The utility strongbox dwell (walked-to boxes) is unchanged and kites.
- **E log**: `src=…` is now always present in the `[ArbShadow]` line (even flag-off it prints `src=detour`). This is a
  shadow-log text change only — control flow is byte-identical with `PREBOSS_KNOWN_BUDGET_ON=false`.
- **F**: seed of `bossScanLastSeenAt` inside `setState` uses `Date.now()` (setState has no `now` param) — caught +
  fixed during verification. Absence is measured against the fight-frame `now`; the ~ms skew is irrelevant at an 8s bar.

## Open questions
- **F / MapBoss granularity**: I assumed `mapObjectiveComplete('MapBoss')` flips only when the WHOLE defeat line is
  satisfied (all bosses on a twin map). The multi-boss handoff guard makes the wrong-way failure (portal past a live
  boss) safe either way, but if a live twin map shows the bit flipping after the FIRST kill, please note it in review —
  the handoff branch relies on a genuine outstanding "Defeat X" line existing at that moment.
- **B arm radius (60u)**: chosen to match "opened by drive-by within ~60u" from the brief. If drive-by opens are
  landing from further out (opener reach is 80u), the arm may miss some — tune `SBOX_EVENT_HOLD_ARM_R` up to ~80 if the
  live test shows drive-by opens without a `[Strongbox]` line.

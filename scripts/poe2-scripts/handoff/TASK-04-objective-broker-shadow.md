# TASK-04 — Objective Broker: SHADOW registry (roadmap step 6)

FIRST ACT, before ANY edit (HOUSE_RULES, incident 2026-07-10): `Copy-Item ..\mapper.js pre\TASK-04\` (create
`handoff\pre\TASK-04\` if needed). This is your own diff base; a task without its pre-snapshot is unreviewable.

Read `HOUSE_RULES.md` first. Then read `..\MAPPER_ROADMAP.md`: the "### Objective Broker" design section, step
"### 6. Objective Broker — SHADOW registry", AND every "OB vs ..." bullet in the Conflicts section — those
conflicts are the reviewer's checklist for your diff. File: `..\mapper.js` only.

## Problem (why this exists — the structural disease every recent live log shows)
The mapper has ONE Movement Broker gating packet sends, but NOTHING gates GOAL ownership. Multiple layers (arbiter
content commits, rare-clear, delirium mirror, white-mob chase, utility detours, explore legs) each write the shared
walker target in turn; every recent yoyo (mob-chase <-> explore alternation, mirror steals, the 8s
latch->explore->stuck->re-pick loop on Cliffside) is two-plus layers taking turns. The OB is the commitment
registry that will make preemption an explicit PAUSE/RESUME instead of silent theft. This task ships it in SHADOW:
it observes and logs; it changes NOTHING.

## What ships
The OB object beside MB (search `hold: { owner: '', prio: 9, at: 0 }` for MB's shape and neighborhood), implemented
inside mapper.js (module extraction is roadmap step 9, not now), per the roadmap's COMMITMENT RECORD and OB API
paragraphs:
- `OB.claim(rec) / pause(byLayer) / resume(now) / complete(id) / freezeTick(now) / ownedTick(rec, dist, owned, now)`
  with commitment records that MIRROR the layer-native keys (`arbCommittedKey`, `rotRareId`, `deliriumTargetKey`,
  the utility target sig, `revisitKey`) — the layers stay 100% authoritative; OB only records and logs.
- Priority ladder (cross-layer): 1 mirror > 2 required content > 3 rare-clear > 4 optional content > 5 utility
  openable > 6 loot-sweep > 7 explore. Dodge is NOT a commitment (MB prio 1 unchanged).
- Pause stack depth cap 2; deeper would-claims log `[OB] shadow-deny (depth)`.
- Timer registry via accessor closures (`OB.regTimer(name, get, set)`) over the existing module lets — REGISTER the
  timers the roadmap names (delirium, rare 12s, incursion 25s, abyss dwell/loot anchors, arb TTL) but in shadow the
  registry is bookkeeping only.
- Instrument the natural transition points: arbiter commit/terminate (search `arbCommitTo` / `arbTerminated`),
  rare engage (search `runClearNearbyRares` call site in the pre-switch chain), delirium handler entry/exit,
  utility select/finish (search `Utility select:` / `finishUtilityState`), opener/pickit move-lock yield (search
  the delta-advance list, `abyssLootDwellAt +=`). At each: the appropriate OB call, shadow-logged.

## Shadow contract (the whole task)
Flag `currentSettings.objBroker` (default false/absent) — and in THIS task even `true` changes nothing (the ON
behaviors are roadmap steps 7-8, a later task): every OB method records + logs `[OB] claim=<id> pri=N`,
`[OB] pause <id> by=<layer>`, `[OB] resume <id> (paused Nms)`, `[OB] complete <id>`, `[OB] shadow-deny <id> vs <cur>`
(throttle >=1s per line class) and makes ZERO behavioral writes: no timer advances, no ban gating changes, no
walk-backs, no denial actually deferring anyone. The legacy clocks — the opener/pickit advance list and the
arbFrozeAt freeze — stay untouched and authoritative. Byte-parity when the OB calls are removed = your parity bar.

## Traps (from the roadmap Conflicts section — the reviewer will check each)
- OB must MIRROR arbCommittedKey/Since/Ttl, never replace or write them.
- Do NOT touch the 10493-10507-style delta-advance list or the arbFrozeAt block — shadow observes beside them.
- Sanity: a shadow-deny must NEVER fire against the delirium mirror walk (mirror is ladder rank 1).
- OB.complete only clears the record — no pick-next logic inside OB (arbTick/cleanup already pick every frame).
- Line numbers in the roadmap are stale; locate by symbol.

## Acceptance
- `node --check mapper.js`.
- One mixed-content map produces a coherent `[OB]` narrative (claim on arbiter commit, pause on rare engage and on
  utility detour, resume after, complete on arbTerminated) with zero behavior change and no per-frame log spam.
- Report per HOUSE_RULES: the record/ladder shapes as implemented, every instrumentation point (symbol names), the
  timers registered, and the live-test checklist.

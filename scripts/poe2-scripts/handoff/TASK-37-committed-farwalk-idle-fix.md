# TASK-37 — Committed-content far-walk wedge + idle-detector false positives (Spring_ 17:11-17:12, 2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\entity_actions.js` into `handoff\pre\TASK-37\`.
Evidence: user log excerpt (Spring_ 17:11:53-17:12:12+) — "stopped and went to sleep, yielding to content
breach 21xx units from arena, I had to tell it to move."

## A. The sleep-wedge: a committed FAR breach whose runner can't resolve its entity holds the frame forever
Live: `[OB] claim=content:breach:61` + `[ArbShadow] pick=breach:61 ONROUTE ins=0 ... committed=breach:61`
+ `[Ckpt] yielding to route-gated breach:61 (ins=0u)` at 17:11:53 — then NO movement lines of ANY kind
(no Walking-to-*, no Content Revisit) while the commitment re-asserts every ~5-10s (`deny utility:* vs
content:breach:61`) and the char STANDS. The breach entity is ~2100u away — OUT of the live-entity stream:
`nearestBreachPoint` scans live entities (`getEntities nameContains BrequelInitiator`), finds nothing, so
the breach drive builds NO runner. The REVISIT (~5798) and CLEANUP (~5910) switches both have a PHASE-1
"out of stream -> WALK to the remembered pos" fallback; whatever drive path owned THIS frame (the
arbTick-committed / [Ckpt]-yield lane) does not — the commit held, the drive no-oped, the checkpoint walk
never resumed, the bot slept until the user clicked.
FIX:
1. TRACE first (evidence in the report): which drive call chain owned the 17:11:53+ frames (the [Ckpt]
   yield's runner resolve — the bare type->runner helper ~5157? — vs the revisit/cleanup switches).
2. UNIFY: every committed-content drive lane gets the SAME phase-1 treatment — runner unresolvable/false
   while the entry is >~120u away -> WALK to the entry's remembered gridX/Y (the existing phase-1
   commit-latch idiom, pathType with fog-independent macro route) until the entity streams in; the runner
   takes over on resolve.
3. RELEASE VALVE: if the committed entry's drive produces neither a runner NOR walk progress for 6s
   (owned frames, existing freeze idioms respected), release the commitment (arb-release, entry stays
   active for later) and log `[Arb] committed <key> undrivable -> released (no runner, no progress)`.
   Nothing may hold the frame while doing nothing — that is the rule this bug broke.

## B. The [Posture] idle-detector false-positives + stale clock (TASK-35 C defect)
Live: `[Posture] cast-gap 74.7s: no-target-selected -- Ciara ...` 6s after a mapper re-enable (stale
_poIdleSince across resets), and `cast-gap 2.6s: no-target-selected -- Vault Lurker` logged BETWEEN two
successful casts 400ms apart. Cause: the `_acting` read uses the player's action fields
(actionSkillName/hasActiveAction) — the SAME fields the Vastweld capture proved dead/unreliable (anim=1086
act=0 acting=0 mid-attack). The idle detector cries wolf while the rotation is actively casting, and its
nudge can fire mid-fight.
FIX:
1. entity_actions: publish `POE2Cache.lastRotationCastAt = now` at the successful-cast site (the same spot
   that logs `Used <skill>`; one-way bus, one line).
2. mapper `_acting`: `(now - (POE2Cache.lastRotationCastAt || 0)) < 1500` replaces the player-field read
   (keep the dodge-window check). The player action fields must NOT be consulted (proven dead).
3. Reset `_poIdleSince`/`_poGapLogAt`/posture step state in resetMapper (the 74.7s stale-clock).

## C. Macro-corridor commit-latch (Cliffside 17:36-17:37 explore yoyo)
Live: `[Explore] unexplored heading -> (401,452)` STABLE across a full minute — but the macro route under
it flipped corridors on every recompute: `Macro route ... toward (120,559)` -> `(271,608)` -> `(120,559)`
-> `(401,452)` -> `(120,559)` every ~8s, the char walking the first leg of each alternately (the user
watched it yoyo at a checkpoint staircase). Two near-equal-cost corridors around the fog; each repath tips
the coin.
FIX: latch the CORRIDOR per committed heading — once a macro route toward heading H picks its first
intermediate ("toward (x,y)"), KEEP that corridor while the heading is unchanged, releasing only on:
corridor leg reached / net progress toward H stalled >10s / heading changed / leg unwalkable. The
commit-latch idiom already exists (far-explore/revisit) — apply it at the macro-route choice, do not
invent a new mechanism. Log flips: `[Explore] corridor latched toward (x,y) for heading (hx,hy)` and the
release reason. Const `CORRIDOR_LATCH_ON = true`. NOTE for the record: this is an explicit STOPGAP — the
structural fix is the navigator (EXPLORE-REDESIGN 26A/B); keep the latch small.

## D. S5 mob-hold must respect line-of-fire (ledge mobs)
Live: three `[S5] mob hold expired (5s, unkilled) -> ban 10s` in ~90s — fence/ledge mobs with NO
line-of-fire froze the walk 5s each and were never hittable. FIX: the S5 hold only arms when the mob has
LoF from the player (the raycast idiom already used by the posture/cast-gap code, throttled); no LoF ->
skip the hold outright (ban immediately, keep walking). One-line-class change; say where it landed.

## Hard limits
- Files: mapper.js + entity_actions.js (B1 only). A must reuse the existing phase-1 walk idiom (the
  revisit/cleanup code is the reference — copy the pattern, or better, route the broken lane through one
  shared helper). A's release valve uses the existing arb-release path. C reuses the commit-latch idiom at
  the macro-route choice. All new behavior flag-gated: `COMMITTED_FARWALK_ON = true`,
  `IDLE_DETECT_BUS_ON = true`, `CORRIDOR_LATCH_ON = true`; flag-off parity.
- Do NOT start until TASK-36 (verisium, mapper.js) has landed and been reviewed — same file.

## Acceptance
- `node --check` both; parity walks.
- Report per HOUSE_RULES + live checklist: a committed far breach WALKS toward it immediately after the
  [Ckpt] yield (Walking-to line within 2s), runner takes over when it streams in; no commitment ever holds
  the frame >6s without walk progress or a runner (the release line appears instead); zero cast-gap lines
  while the rotation is actively casting; no >60s idle clocks after a mapper toggle.

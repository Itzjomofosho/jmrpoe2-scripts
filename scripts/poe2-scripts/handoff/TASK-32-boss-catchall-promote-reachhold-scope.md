# TASK-32 — Boss survival bundle: catchall promote-on-hit + reach-hold scope + unhittable-boss posture + slam-blindness diag (Greenhouse + IceCave DEATH triage 2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\auto_dodge_core.js` AND `..\mapper.js` AND `..\entity_actions.js` into
`handoff\pre\TASK-32\`.
Evidence: Greenhouse 10:58-11:07 + IceCave 12:33-12:34 (CHAR DIED — "The Frostborn Fiend", one slam;
user: "he does 1 slam and dead, gotta dodge at the right time").

## A. The catchall mute ate the boss's frontal cone (user got hit for 21%)
Live (Rootgrasp fight 11:04:03-11:04:20): cone = unknown anim `anim_1086` -> catchall ROLL x2 -> the 2/10s
budget MUTED it 8s (11:04:05) -> the third cone LANDED (hp 100% -> 79%, 11:04:08.669) -> damage-unmute fired
(too late by design). The tamer (TASK-18) exists to kill false-positive spam; this anim had a 100% hit rate.
FIX (auto_dodge_core.js): PROMOTE-ON-HIT — when the damage-unmute fires for a catchall anim (the existing
`unmuted (hp X% -> Y%)` path), permanently promote that animId (per-map registry) out of the catchall budget:
it never mutes again this map, dodged every time like a known telegraph. Log once:
`[AutoDodge] catchall anim_<id> promoted (it hit us)`. Additionally, anims sourced from a BOSS-rarity entity
get a gentler budget BEFORE any hit: mute 3s (not 8s) — bosses have few anims and the cost of a miss is a
cone to the face. Const `CATCHALL_PROMOTE_ON = true` (covers both).

## B. Reach-hold tanked five lightning booms during the essence approach (user: "stood in essence lightning
## BOOMBOOM ground x5 ... did u see it?")
Live 11:06:41-11:06:52: essence committed at d=301 -> "fighting through (clocks frozen)" approach ->
`reachHoldActive` published for the WHOLE approach -> dodge core's opener-reach hold (auto_dodge_core.js
~1361: "HOLD against ALL risks") tanked repeated lightning ground -> hp to 90%, chicken potion 11:06:55.
The TASK-22 ruling (tank casts/fire so the opener plants its clicks) is for the PLANT — not for a 10s+
walk-in fight.
FIX (mapper.js publisher — scope the flag, do NOT touch the core's hold semantics): publish
`reachHoldActive = true` only while the char is within PLANT range of the openable (<= ~15u) OR an opener
commit-click is in flight (`commitClickSafe`/openCommitAt window); drop it the moment the openable reads
opened/consumed. Outside that window the approach gets NORMAL dodge (ground rolls included) — the walk
machinery already re-approaches after a dodge. Keep the core's 5s cap/1.5s cooldown untouched (it still
backstops the plant window). Also keep the HP<50% floor drop as-is.

## C. THE DEATH: unhittable-boss survival posture (IceCave, char died to one slam)
Live 12:33:05-12:34:04: FIGHTING_BOSS on "The Frostborn Fiend" (5.5M hp, engaged at 37u). The boss's hp
NEVER MOVED the whole fight — SEVEN consecutive `[Rotation] hp frozen 3.5s -> ban 4s` cycles (an invuln
phase/gimmick; the INVULN_GATE buff `no_players_in_range_immunity` never matched, so it's another flavor)
— and the char STOOD STILL at ~38u shooting an invulnerable boss for ~55s until one slam one-shot it (no
chicken line: a true one-shot gives the potion no window; only dodging saves this).
FIX (mapper.js FIGHTING_BOSS): while the committed boss is UNHITTABLE — >= 2 consecutive hp-frozen bans on
it OR its hp unchanged >= 8s while our casts land — enter EVASIVE posture: keep moving on a perpendicular
arc at max engage range (the kiteBoss machinery/moveAngle already exists — reuse), never stationary > 1s;
drop the posture the INSTANT boss hp moves (or the invuln-gate buff clears) and resume the normal fight.
Standing still in front of an invulnerable boss is pure downside — it can hit us, we cannot hit it. Log
edges: `[BossFight] unhittable -> evasive posture` / `-> re-engaging`. Const `UNHITTABLE_EVADE_ON = true`.

## D. The slam was INVISIBLE to the dodge (diagnosis item — bounded TEMP diag)
Same fight: after ONE catchall roll at 12:33:06 (anim_1086 — likely fight-start noise; note the
perfect-window RE finding that 1086 reads as a GENERIC/idle top-level anim id post-patch), the dodge went
COMPLETELY SILENT for the entire minute: zero ROLLs, zero mute/unmute lines, zero `[Dodge] boss fight:`
diag lines (which DID print through the whole Greenhouse fight). The slams produced NO signal — so A's
promote-on-hit can never even see this anim. Prime suspects (rule in/out with the diag, do NOT guess-fix):
(1) TASK-18 CC'd-owner suppression — our build perma-freezes (FreezingMark/Ice*); if the shared-list
verdict held "CC'd" while the boss actually slammed, every catchall was suppressed; (2) the hp-frozen BANS
cleared the boss as rotation target and something downstream keyed dodge boss-scanning off the current
target (the missing [Dodge] diag lines point here too); (3) the slam is a plain melee anim with no
GeometryAttack (known melee-cone RE gap) AND reused a generic id.
FIX: a TIGHT, TEMP `[BossFight]` diagnostic (mapper or dodge core, whichever reads it cheapest): during
FIGHTING_BOSS only, ON-CHANGE only (plus a 2s heartbeat), log the boss's animId, the catchall CC-verdict
for it, whether the dodge boss-scan ran this pass, our aa-ban state on it, and boss hp delta. Explicitly
marked TEMP — it gets REMOVED in a later cleanup task once one Frostborn-class fight is captured (memory
rule: no debug code left behind). Const `BOSSFIGHT_DIAG_ON = true`.

## Hard limits
- Files: auto_dodge_core.js + mapper.js + entity_actions.js (C may need the ban-state read; D's diag goes
  where the reads are cheapest). A's promotion registry resets per map. No changes to known-telegraph
  handling, projectile logic, or the channel-hold. Flag-off parity per const (B rides the existing
  reachHoldActive publisher — flag `REACH_HOLD_PLANT_SCOPE = true` around the narrowed condition, old
  behavior when false). C's evasive posture must NOT fight the dodge (MB dodge holds outrank it — it only
  steers the frames nothing else owns) and aborts if the boss corpse/death routing fires.

## Acceptance
- `node --check` all three; parity walks.
- Report per HOUSE_RULES + live checklist: a boss whose unknown anim hits us once gets dodged EVERY
  subsequent use (promotion line, no repeat hit); an essence approach through ground hazards shows ground
  ROLLs during the walk-in, reach-hold only near the crystal, opener still completes its clicks; an
  unhittable boss phase shows `evasive posture` + visible movement (no standing), instant re-engage on
  hp movement; one boss fight captured with the [BossFight] diag showing anim transitions + CC verdicts.

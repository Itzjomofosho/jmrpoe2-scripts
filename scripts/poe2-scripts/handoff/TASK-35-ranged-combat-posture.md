# TASK-35 — GENERIC ranged combat posture: stop at bow range, back out when pressed (2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\rotation_builder.js` AND `..\auto_dodge_core.js` into
`handoff\pre\TASK-35\`. Files: mapper.js (A/B/C) + rotation_builder.js/auto_dodge_core.js (D only).
Context: user ruling after the SinterRift essence death — "it's not just essence, it's ALL of the same
type". Every combat walk drives TO the target's cell (Walking to Breach Mob / Elite / rare engage / stone
guards), so a BOW build fights everything from melee range. Bosses got a standoff in TASK-32B (kiteBoss
forced, 60u); regular fights never did. TASK-34 adds an essence-scoped posture; THIS task generalizes.

## A. Combat-target walks STOP at bow range
Wherever the mapper walks AT a hostile in order to kill it (rare/unique engage, breach mob chase, the
elite walk, essence/strongbox guard fighting-through, abyss wave mobs), the walk destination is clamped to
`RANGED_ENGAGE_STOP_U = 55` short of the target: approach until the target is ~55u away with line-of-fire,
then STOP walking (the rotation shoots; entity_actions owns the kill). Re-approach only when the target
leaves attack range or LoF breaks. Implement at the SHARED choke (the helper these walks route through —
find it; if they don't share one, a small `clampCombatWalk(tx,ty,player)` used by each call site) — NOT a
per-runner fork. Const `RANGED_POSTURE_ON = true`; off = walks drive to the cell as today (byte-parity).
LoF matters: if the clamped stop has no line-of-fire (wall), keep approaching until it does (the existing
LoF probe idiom in entity_actions is the reference; mapper-side use the raycast helper if one exists, else
approach to 40u and let it fight).

## B. Back-out step when pressed (the non-boss kite floor)
While ANY hostile is inside `RANGED_BACKOUT_U = 30` of the player and the mapper is in a fight-holding
state (engage/fighting-through/guard fights — NOT mid-runner-walk to elsewhere), step AWAY: a short
radial-retreat move (~25u, the boss kite-floor idiom — reuse its step machinery) rate-limited to 1/900ms,
through the gated content/fight sender so dodge (p1) still outranks. Casts continue between steps. This is
the standing "fight better" ruling applied to trash/rares: a bow build never trades at melee range.

## C. NO IDLE STANDING in a fight (user: "as soon as it disappears GOTTA GET BACK IN THE FIGHT")
Observed at the essence post-open AND during breach stabilisation fighting rares: the char STANDS doing
nothing mid-fight. In any fight-holding state (engage, fighting-through, essence post-open, breach
stabilised/defend, strongbox guard hold), the char must at every moment be either (a) casting (rotation has
an eligible target), or (b) executing a posture step (A's approach / B's back-out / an LoF-fix step). If
the rotation has NO eligible target for >1500ms while hostiles are within 70u, emit the cast-gap reason
line (extend the TASK-32B boss cast-gap diag pattern to non-boss fight holds — one throttled line naming
the gate: banned/LoF/not-targetable/no-target-selected) so standing is never silent again, AND nudge: step
toward the nearest un-banned hostile's 55u ring (an LoF/range fix is the most common unblock). Const rides
RANGED_POSTURE_ON.
EXCEPTIONS (user ruling — this build FREEZES targets then channels Snipe into them; posture must
accommodate, not fight it):
1. LIVE CHANNEL: while a rotation channel is live (`POE2Cache.channelHoldActive === true && now <=
   channelHoldUntil` — the bounded read, TASK-30 releases it on target death), NO posture step fires — no
   back-out, no nudge, no approach re-issue. Standing mid-channel IS the fight. The channel self-bounds
   (<=~2.5s timeout + perfect-window release), so this can never wedge the posture.
   SCOPE: this exempts POSTURE STEPS ONLY. The dodge ladder is UNTOUCHED and already channel-aware —
   known telegraphs/geometry/ground/projectiles and PROMOTED catchalls dodge THROUGH channels, hp<70%
   breaks the channel-hold for everything, and the TASK-34 panic egress overrides all. Do not add any new
   channel protection to the dodge core in this task.
2. CC'd HOSTILES ARE NOT THREATS: B's back-out trigger ("hostile inside 30u") counts only hostiles NOT
   currently hard-CC'd (frozen/stunned) — reuse the dodge core's cached CC verdicts (getCatchallCcVerdict /
   the _ccVerdicts read), do NOT add a new scan. A frozen mob at 20u is the snipe window, not a reason to
   step away and waste it. An un-CC'd hostile inside 30u still triggers the back-out as specced.
3. (Defensive, minor) PLAYER hard-CC: while the player itself is frozen/stunned, emit no movement packets
   and count no idle clocks — a queued move firing on unfreeze yanks the char; the cast-gap line reads
   `player CC'd` (throttled).

## D. Channel threat-interrupt (user ruling: "interrupt the wait if trouble afoot" — NOT a cast pre-gate)
The channel's perfect-window WAIT must be interruptible by developing danger a hazard scan can't name: a
live un-CC'd hostile CLOSING on the char mid-channel (no telegraph, no ground — just a melee inbound).
Today nothing breaks the channel for that until it hits.
FIX (one-way bus, the established pattern — rotation must NOT import the dodge core, circular):
1. auto_dodge_core: each pass, publish the nearest UN-CC'd hostile distance from the enemies list already
   in hand + the cached CC verdicts (no new scan): `POE2Cache.channelThreatD = <u>` + `channelThreatAt =
   now`. Frozen/stunned hostiles do NOT count (the snipe-into-frozen-pack play stays untouched).
2. rotation_builder channelArbiterTick: while a channel is armed and elapsed > 300ms, if the bus is fresh
   (<250ms) and `channelThreatD <= CHANNEL_THREAT_R = 35`: release NOW — sendStopAction (it IS channelling)
   + log `Channel released: <skill> (threat at <d>u)`. An early snipe at partial stage beats a face-tank.
3. Symmetric arm-guard, tight: do not ARM a channel when the same bus reads a threat already inside
   CHANNEL_THREAT_R (cast filler this tick instead — the priority loop falls through naturally). This is
   NOT the rejected 100u pre-gate: 35u = something already in your face.
Const `CHANNEL_THREAT_INTERRUPT_ON = true`; off = both files byte-parity.

## Per-content constraints (verify each; list handling in the report)
- ABYSS: node/wave progress may require presence NEAR the node — the back-out must not leave the node's
  progress radius; cap the retreat so the committed node stays within ~60u (read the runner's own radii).
- BREACH: the chase deliberately sweeps wide — A clamps each chase leg's END (stop 55u from the mob), it
  must not stop the sweep itself; the clearing cadence (mob blacklists, closest-D tracking) unchanged.
- STONE CIRCLE / consume walks: walks to ROCKS/objects are NOT combat walks — untouched.
- Melee-profile users: both consts OFF must be byte-parity; note in the report that a melee profile keeps
  today's behavior (the flags are the profile switch for now).

## Hard limits
- mapper.js only; no entity_actions changes (its target selection + cast gates already handle range). Reuse
  the kite/radial-retreat step machinery — a new movement mechanism is an auto-reject. All flag-gated.
- No OB/MB changes; the back-out sends at the owner's existing priority.

## Acceptance
- `node --check`; parity walks.
- Report per HOUSE_RULES + live checklist: engage walks visibly stop ~55u out (log the clamp once per
  target: `[Posture] holding 55u vs <name>`); a mob closing inside 30u triggers visible back-step(s) while
  casts continue; an essence opening flows STRAIGHT into the guard fight (no standing beat); breach
  stabilisation shows continuous cast-or-step (any >1.5s idle emits the cast-gap reason); breach clear rate
  unaffected; abyss nodes still progress; no fight regressions vs bosses (32B standoff untouched).

# TASK-41 — Ground-hazard classification: the boombooms become FIRST-CLASS dodge hazards (2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\auto_dodge_core.js` into `handoff\pre\TASK-41\`. File: auto_dodge_core.js ONLY.
Evidence: three [BlindGround] dumps (Sandspit 16:35, Spring_ 17:10, Cliffside 20:05) + FOUR deaths. The
20:05 death is the complete autopsy: char stood on 2x `grd_Zones/grd_Shocked01` (shocked ground = amplified
damage taken) + 2x `explode_on_death/lightning_beacons` + 2x `explode_on_death/fire_beacons` at 7-8u in a
pack fight -> overlapping detonations under shock amplification = one-shot THROUGH a firing panic egress and
a 90% potion. Reaction cannot beat stacked front-loaded bursts; only never-standing-there can. All killers
are `Renderable/None host=1` entities the ground scan does not read.

## A. The classifier (a WHITELIST of known-damaging effect classes — never "all hostile renderables")
A pattern table over baseEntityPath, per-class severity:
  LETHAL (roll out IMMEDIATELY, pre-detonation):
    /monster_mods\/(fire|lightning|cold|chaos)\/explode_on_death\//i     (the beacons — all elements)
  AVOID (ground hazard: don't stand, egress/roll like a classified GroundEffect):
    /grd_Zones\/grd_/i            (grd_Shocked01 and siblings — the damage-amp carpets)
    /acidic_ground/i              (MudBurrower)
    /quillSpike_poison/i          (QuillCrab)
    /VaalZealotSpearCold\/ao\/ice_proj/i
    /MeleeSpider\/puddle/i
  Table = a const array of {re, sev, radiusMul} so new dumps extend it in one line. EXPLICITLY NOT hazards:
  weather_attachment, breach_attachment, *Scatterer (ambient, host=1 but harmless — the dumps prove the
  flag alone is meaningless).

## B. The scan (reuse the shared per-frame list — the dump already reads exactly this)
In the dodge core's hazard-collection pass: entities from POE2Cache.getSharedEntities() with
entityType !== 'Monster' && isHostile, within ~45u, path matched against the table -> synthesize a ground
hazard { x, y, radius: max(bounds/2 * radiusMul, 12), sev } into the EXISTING hazard list. The existing
ground-dodge machinery (rolls, walkEgress, danger-zone overlay) then handles them like any Vortex/Smoke —
no new dodge mechanics. Throttle the path-match pass (strings are slow): cache verdicts per entity id
(Map id->sev|0, cleared per map), so each entity is pattern-tested ONCE.
LETHAL class: also feeds the at-risk gate at a wider margin (beacon radius + 15u) — the char must LEAVE
before detonation, not after; a LETHAL hazard is never suppressed by the catchall tamer, the channel-hold
(hp>=70% rule does NOT apply — a beacon pile one-shots from full), or the opener reach-hold.

## C. Standing prohibition (the strongbox death posture)
The TASK-35 posture's plant/stand decisions (fight-holds, essence ring, sbox plant) must reject a stand
cell inside any AVOID/LETHAL hazard: before sendStopMovementLimited in a fight-hold, if the player's cell
is inside a classified hazard -> take a posture step out first (the existing back-out machinery; the
hazard list is now visible to it via the same shared read). One throttled log:
`[Posture] standing in <class> -> stepping out`.
(If this needs a mapper.js touch beyond reading the dodge's published hazards, keep it to ONE bus flag —
say so in the report.)

## Hard limits
- auto_dodge_core.js (+ at most one mapper.js bus consumer for C). The table is additive; classified
  GroundEffect behavior unchanged. Per-id verdict cache mandatory (perf lens). Flag
  `GROUND_CLASSIFY_ON = true`; off = byte-parity.
- The [BlindGround] dump STAYS (it is how the table grows).

## Acceptance
- `node --check`; parity walk.
- Report per HOUSE_RULES + live checklist: beacons/shocked ground draw in the danger-zone overlay; the
  char ROLLS OUT of a beacon cluster before detonation (dodge lines name the class); no more standing
  fights on grd_ carpets; weather/breach attachments produce zero hazards; [BlindGround] dumps become
  RARE (the egress backstops only fire for genuinely unknown classes).

# TASK-31 — Utility value filter + HV-utility route-insertion during content + unique-engage 200u (Greenhouse triage 2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-31\`. File: `..\mapper.js` ONLY.
Evidence: C:\tmp\log.txt (Greenhouse 10:58-11:07).

## A. Junk openables burn the cleanup budget (user: "yielding to WHITE CHESTS AND URNS ... no point")
Live: 10 post-boss `Utility select: openable` claims — 8 were plain `Chest`/`Urn` at d=116..291; the essence
Monolith (d=301) was claimed LAST at 11:06:40 because closer junk kept winning; `[Cleanup] budget 150s spent`
fired at 11:06:52 largely spent on urns.
FIX: the openable utility SELECTOR takes only VALUE openables: Shrine*, Strongbox*, Monolith/essence,
abyss/breach/league chests (the existing name/path classes). Plain Chest/Urn/Vase/Barrel/pot classes are OUT
of utility selection entirely — the opener already opportunistically opens anything in passing at <=25-30u,
which is the right amount of effort for them (keep that untouched). Const `UTILITY_OPENABLE_VALUE_ONLY = true`.

## B. High-value utility is INVISIBLE during content commitment (user: "WALKED PASSED ESSENCE going to
## incursion much further away ... you were like 100u near it. COME ON MAN")
Live: during the entire pre-boss content phase there is not ONE essence/shrine line — the Monolith and the
Resistance Shrine only enter the log post-boss (11:05:07 shrine d=140, 11:06:40 essence). Cause:
`[OB] deny utility:* pri=5 vs content pri=4` — while content is committed, utility is never even EVALUATED,
so essences/shrines we walk right past are skipped (this is also the "skipped nearby shrine during abyss").
FIX: route-insertion for HV utility, riding the EXISTING [Ckpt]/route-gate yield machinery (TASK-26 — do NOT
build a parallel mechanism): during content walks and checkpoint walks, an HV openable (essence Monolith,
Shrine, Strongbox — A's value classes, NOT junk) with route insertion <= `HV_UTIL_INS_MAX = 150`u yields
exactly like route-gated content does today (`[Ckpt] yielding to hv-utility ...` log), then resumes. One
yield per openable key (existing blacklist/dedupe). During an ACTIVE abyss/breach wave the runner still owns
the frames (no mid-wave abandonment) — the insertion window is the walk BETWEEN engagements, same as [Ckpt]
today. Const `HV_UTIL_INSERT_ON = true`.

## C. USER RULING — uniques must die (Taua the Ruthless escaped LAST map): engage <=200u
Non-boss UNIQUE-rarity monsters (rogue exiles etc.) within 200u must be engaged and killed, deviating like
the rare-engage does (rare machinery, pri=3 pause) — "should deviate within 200u or so just to get them
dead". FIX: extend the rare-engage eligibility to rarity==Unique entities that are NOT the map-boss
candidate (existing isObjectiveBossCandidate / bossNames exclusion) with radius `UNIQUE_ENGAGE_R = 200`
(rares keep their existing radius). Same commitment discipline, same freeze idioms, log
`[Engage] unique <name> at <d>u -> committing (unique ruling)`. Const `UNIQUE_ENGAGE_ON = true`.

## D. Leave verdict doesn't leave
Live: `[Cleanup] budget 150s spent, content still outstanding -> leaving anyway` 11:06:52 — then a NEW urn
utility claim at 11:06:57 and the map only ended when the user paused at 11:07:27.
FIX: after the leave verdict, the utility selector claims NOTHING new (in-flight claim may finish); the
departure path runs next tick. Log once: `[Cleanup] leave verdict -> utility selection closed`.

## E. Breach loot-wait position (minor — user "could live with it", fix cheaply if trivial)
Live: `[Breach] cleared after 48s -> stand still + collect loot 10s` waits at the breach CENTER; the user
watched the bot run AWAY from where the breach actually closed (last kills/drops) to do so. FIX: anchor the
10s loot-stand at the LAST-KILL position of the breach fight (we track the fight; reuse its last engaged
position) instead of the activation center, if that position is walkable; else keep center.

## Hard limits
- mapper.js only. B MUST reuse the [Ckpt] yield path — a second insertion mechanism is an auto-reject.
  No OB ladder priority changes (the deny stays; B works ABOVE it via yield, exactly like content [Ckpt]).
  All consts flag-off parity. C reuses rare-engage code paths (no new engage state machine).

## Acceptance
- `node --check mapper.js`; parity walks per const.
- Report per HOUSE_RULES + live checklist: a map with an essence/shrine near a content walk shows the
  hv-utility [Ckpt] yield PRE-boss (no more walk-pasts); zero `Utility select: openable (Chest|Urn ...)`
  lines all map; a non-boss unique gets committed + killed within 200u; after "leaving anyway" no new
  utility claims appear.

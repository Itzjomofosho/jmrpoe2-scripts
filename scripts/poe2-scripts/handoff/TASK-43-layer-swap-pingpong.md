# TASK-43 — Arbiter layer-swap ping-pong starves BOTH contents (Channel 21:10, 2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-43\`. File: mapper.js ONLY.
Evidence: C:\tmp\log.txt (Channel 21:09:37-21:11:00). USE OPUS 4.8.

## The failure, from the log
- 21:10:11.107  `[OB] complete content:breach:354 (layer-swap) -> claim=content:verisium:1580`
                `[ArbShadow] pick=verisium:1580 NEAR ins=0 bud=255 src=detour`
- 21:10:11.434  `[Exp2] remnant 1580 reached (22u) -> clear mobs (<=15s) then open`   <- ENGAGED
- 21:10:12.645  `[OB] complete content:verisium:1580 (layer-swap) -> claim=content:breach:354`
                `[ArbShadow] pick=breach:354 ONROUTE ins=29 bud=1000 src=known1000`   <- yanked at 1.2s
- 21:10:12.645  `[Breach] Brequel 354 no progress (closest 60u) -> skip`              <- runner REFUSES
- 21:10:25..59  arb holds pick=breach:354 (src flapping detour<->known1000, bud 320<->1000) doing NOTHING;
                verisium:1580 sits active; nav walks markers
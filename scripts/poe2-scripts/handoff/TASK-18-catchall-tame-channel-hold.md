# TASK-18 — Tame the boss-anim catchall: stop dodge starving Snipe + same-anim yoyo (Willow 2026-07-11)

FIRST ACT (HOUSE_RULES): copy `..\auto_dodge_core.js` AND `..\rotation_builder.js` into `handoff\pre\TASK-18\`.

## User ruling + live evidence
User (2nd time this week): dodge rolls cancel ChannelledSnipe and keep the fight ALIVE longer — "u rolling around
like a moron while my target is frozen". Willow log (C:\tmp\log.txt, 12:55:52-12:56:05): the boss-anim catchall
dodged the SAME animation `boss_telegraph:boss-anim~catchall:anim_1086` **8 times in 13s** (one roll per
minIntervalMs ~1.1-1.2s). A roll cancels the channel; snipe (the build's nuke) never completes; the fight drags —
and a longer fight vs a `stone_circle_killing_potency`-buffed 4.5M boss is more time for everything else to go
wrong (this fight ended in the death TASK-16 covers). TASK-07's animIsAdvancing() gate fixed the FROZEN-anim
false-positives; a LOOPING/repeating anim on a live boss legitimately re-passes it every cycle — by design each
loop is "a new cast". That design starves channels.

## What ships (const `CATCHALL_TAME_ON = true`; flag-off = byte-parity) — all scoped to the BOSS-ANIM
## catchall branches ONLY (the `boss-anim~catchall` + the small-radius fallback at ~512/~731). Geometry AoE,
## ground, projectile-path, melee-cone dodges are UNTOUCHED.
### auto_dodge_core.js
1. **Hard-CC suppression:** if the anim's owner currently has a `frozen` or `electrocuted` buff → skip the
   catchall for it (a hard-CC'd boss's cast does not complete; the visual anim is not a threat). Buff read:
   boss-only scope (1 entity), reuse the existing 50ms buff-cache convention (see rotation's empower_barrage
   gating) — no per-frame WithBuffs on the world.
2. **Per-anim dodge budget:** extend the existing `animCastDodged` bookkeeping with a count per (entityId, animId):
   after **2** dodges of the same anim id within **10s**, suppress further catchall dodges of that (entity, anim)
   for **8s** (log once: `[AutoDodge] catchall anim_1086 x2 in 10s -> muted 8s`). Rationale: we are RANGED; an
   anim we already dodged twice and are still >20u from is demonstrably not hitting us. Budget resets on real
   damage taken (hp dropped >8% since the mute started -> unmute immediately).
3. **Channel-hold:** while `CFG.channelHoldActive === true` AND player hp >= 70% → suppress catchall dodges
   (let the channel finish; perfect-window Snipe is the nuke). Same bus pattern as `reachHoldActive` /
   `bossFightActive` (cfg fields published from outside). hp floor check is cheap (dodge already reads player).
### rotation_builder.js
4. Publish the channel state on the dodge cfg bus: set `autoDodgeCfg.channelHoldActive = true` when a channel
   arms (the `Channel armed:` site, ~1119) and `false` on EVERY exit path — released (perfect window), timeout,
   cancelled, error. Import/access the cfg the same way mapper does (verify the import shape; if
   rotation_builder cannot see autoDodgeCfg cleanly, publish via POE2Cache instead and read that in the core —
   pick one, say which).

## Hard limits
- No new world scans (boss buff read is 1-entity on the 50ms cache; anim budget is a Map on existing state).
- Do NOT touch: geometry/ground/projectile dodge classes, minIntervalMs, boss orbit/kite logic, TASK-07's
  animIsAdvancing gate, the frozen-PLAYER logic. Channel-hold must never override the chicken (potions/exit are
  a different plugin and unaffected).
- Bound everything: mutes expire, channel-hold caps at the channel's own timeoutMs (rotation clears the flag).

## Acceptance
- `node --check` both files; flag-off parity.
- Report per HOUSE_RULES + live-test checklist: boss fight with freeze build → `frozen` boss triggers ZERO
  catchall rolls while frozen; a looping anim mutes after 2 dodges (log line) and unmutes on real damage;
  ChannelledSnipe completes with `PERFECT WINDOW` releases during the fight (was: cancelled by rolls);
  a genuine geometry AoE under the player still dodges INSTANTLY even mid-channel.

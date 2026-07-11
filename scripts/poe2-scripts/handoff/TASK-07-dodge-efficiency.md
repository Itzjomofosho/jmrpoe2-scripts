# TASK-07 — Dodge efficiency: frozen-anim chain-rolls + catch-alls scoped to the real boss fight (user P1+P9)

FIRST ACT (HOUSE_RULES): copy `..\auto_dodge_core.js` AND `..\mapper.js` into `handoff\pre\TASK-07\` before editing.
Files: `..\auto_dodge_core.js` (main) + one small publication edit in `..\mapper.js`.

## Problem (live evidence, user's words)
1. "wtf u dodgin here? NOTHING, i dont get time to cast snipe, u rolling around like a moron while my target is
   frozen." Live log: `ROLL … why=boss_telegraph:boss-anim~catchall:anim_1086` repeating every ~1.3-2s for a whole
   fight, interrupting ChannelledSnipe. ROOT CAUSE (diagnosed): the anim catch-all fingerprints an animation
   instance by its estimated START time (`now - animationProgress*1000`, bucketed to 700ms). A FROZEN/stunned boss
   (this build freezes everything) has `animationProgress` STANDING STILL while `now` advances → the start estimate
   drifts into a fresh bucket every 700ms → a "new instance" → chain-roll at minIntervalMs forever.
2. "you're still running from UNIQUE mobs (rogue exiles), dodging away then picking something else instead of
   killing them. The snipe rolls away are making map bosses slow." The two boss catch-alls (the named floor-up
   catch-all and the animation-only catch-all) fire on EVERY unique in boss mode — rogue exiles met mid-clear
   trigger constant rolls that displace the bot and break its target.

## What ships
### 1. Frozen/paused animation gate (the P1 fix)
In the animation-only catch-all branch (search `boss-anim~catchall`), track per-entity animation advancement:
a small module Map `_animAdv` (id -> { dur, prog, at }). Each scan that reaches the branch for an entity:
- If the tracked entry has the SAME animationDuration and `|animationProgress - prev.prog| < 0.04` across
  `now - prev.at >= 250ms` → the animation is NOT ADVANCING (frozen/stunned/paused). SKIP the branch entirely
  (no hazard push). A boss that isn't animating isn't attacking.
- Otherwise update the entry and proceed. Prune entries older than ~5s opportunistically (the map stays tiny).
This kills the drift class at the source: no advancing animation → no instance → no fingerprint churn.

### 2. Scope BOTH boss catch-alls to the actual boss fight (the P9 fix)
- mapper.js: in the dodge cfg publication block (search `autoDodgeCfg.arenaCX` — same block), publish
  `autoDodgeCfg.bossFightActive = (currentState === STATE.FIGHTING_BOSS)`. One line; nulled/false implicitly
  otherwise (set it explicitly false in the same else-branch that nulls arena fields).
- auto_dodge_core.js: `AUTO_DODGE_DEFAULTS.bossFightActive: false`. Gate the ANIMATION-ONLY catch-all AND the
  named floor-up catch-all (search `boss-cast` / the `effectiveRadius < minRadius && isBoss` branch) on
  `CFG.bossFightActive === true`. Everything else (real geometry telegraphs, projectiles, ground, melee nets,
  rare-surround) stays exactly as-is for uniques/exiles — they keep normal dodging, they lose only the
  synthetic catch-all rolls.

## Hard limits
- Do NOT touch `animCastDodged`, the deny-name list, or the distance/hp gates already in the anim branch — the
  new advancement gate composes IN FRONT of them.
- No changes to minIntervalMs, channel protection, MB, or any hazard class other than the two catch-alls.
- Flag-off parity is N/A (no new user setting) but the two behavior changes must be exactly scoped: with
  `bossFightActive` true and an advancing animation, today's behavior is unchanged.

## Acceptance
- `node --check` both files.
- Report per HOUSE_RULES with a live-test checklist covering: (a) frozen boss → ZERO `boss-anim~catchall` rolls
  while frozen, snipe channels complete; (b) rogue exile mid-map → no `~catchall` rolls at all (geometry dodges
  still allowed); (c) a real un-frozen boss wave (Caedron class) still gets its one roll per cast.

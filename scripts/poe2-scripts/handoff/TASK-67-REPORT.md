# TASK-67 REPORT — brief root-cause DISPROVEN; delivered a breach move-while-attacking fix instead (per live user redirect)

## TL;DR
- The TASK-67 brief's root cause (**"breach is timeSensitive → the ENTRY expired/pruned during the pause"**) is **contradicted by its own cited log**. `expireAt` is a **dead field** (only ever set to `0`, never read anywhere in the runtime dir); `timeSensitive` is **scoring-only** (never an expiry mechanism). The Oasis breach **genuinely completed in-game** — it did not expire. So the briefed fix (#1/#2 target a dead field; #3 explicitly excludes the terminator that actually fired) would be a **no-op** that fails acceptance.
- I raised this to the user. They redirected (AskUserQuestion → **"Fix breach clearing"**) after a NEW live breach-collapse (Spring_, 14:14) and the ask: *"explore in a few directions moving while attacking."*
- **Implemented:** a flag-gated **move-while-attacking breach clear** — during the active-clear phase the char CIRCLES the breach ring while the rotation fires, instead of beelining into single mobs / planting in the swarm's burst. `mapper.js` only. Flag off = byte-parity. `node --check` passes.

---

## Evidence that the brief is mis-diagnosed (Oasis, C:\tmp\log.txt, 13:56)

Timeline: `13:56:08` arb commits `breach:235` (NEAR, reachable) → `13:56:12` `[OB] pause content:breach:235 by=rare` (a rare pack spawned **on top of** the breach; the fight owned every frame) → `13:56:23.722` `resume` + `[OB] complete content:breach:235 (arb-release) owned=0ms paused=11652ms`.

**The breach was never "expired" — it genuinely finished:**
- `13:59:58` Pickit: `13x Breach Splinter` + `Brequel/FruitCurrency` (breach loot).
- `14:02:56` `[Discover] gate: … Breach exists=1 complete=1` and `skipping done-icon marker icon=30 @(656,1208) BrequelInitiator` — a **spent** breach hand at exactly breach:235's position (icon 30 = spent, per TASK-63).

**Why `arbTerminated` fired at owned=0 (proven by elimination):** for a `breach`, every *silent* `arbTerminated` branch reduces to `mapObjectiveComplete('Breach')` — the entry-death (`!e`/prune), `objectiveTypeComplete`, and `lockIsDone` branches all read the same base-game bitfield; the runner-ban branch (`rotBreachBlacklist`) has **no silent set-site** (every `.set()` logs a `[Breach]` line or sets `rotBreachActivatedAt`+adopt-log — none appeared); the TTL branch needs `owned>0` and is frozen during a pause by `obContentOwnedMs` (TASK-47). So the terminator was `mapObjectiveComplete('Breach') === true` — a **genuine game completion**, correctly released. The `owned=0ms "complete"` log is **honest**.

**What actually happened:** the co-located rare fight's AoE brushed the Brequel → the breach opened, spawned, and finished **incidentally with `owned=0` because our breach runner never got a frame** (paused the whole 11.6s). No proper clear/loot-dwell; the bot left for boss. This is a *breach-clearing / adopt* gap, **not** a queue-lifecycle gap.

### Expiry table for `timeSensitive` types (brief deliverable)
`CONTENT_POLICY` timeSensitive = `verisium`, `breach`, `delirium`. For **every** type — timeSensitive or not — there is **no queue-lifecycle timer** that ages an entry during a pause:

| Type | `.expireAt` | `.timeSensitive` (entry field) | Queue removal path | Ages during a claim-pause? |
|---|---|---|---|---|
| verisium | `0`, never read | never read | `exp2Done` done-signal / objectiveTypeComplete | No |
| breach | `0`, never read | never read | `mapObjectiveComplete('Breach')` / objectiveTypeComplete | No |
| delirium | (mirror, not in contentQueue) | — | — | No |
| breach2 / abyss / incursion-* | `0`, never read | never read | per-type done-signal / objectiveTypeComplete | No |

- `expireAt`: across the **entire** runtime scripts dir it appears once — `mapper.js` populate, set to `0` — never read, never assigned nonzero.
- `timeSensitive` (policy) is read only in `classifyObjective` (TS detour-cost multiplier) and `arbHysteresis` (time-sensitive preempts, margin 0). Neither prunes/terminates an entry.
- The only removals are genuine **done-signals** or the type-agnostic **10-min stale** (`now - lastSeenAt > 600000`, same for all types) — neither is timeSensitive-driven, and the commit TTL is OWNED-ms (frozen during a pause since TASK-47).

**Conclusion:** brief fixes #1 (`expireAt += pausedSpan`) and #2 ("gate the expireAt assignment") have **no live target**; fix #3 excludes objective-signal terminators, which is exactly what fired → **no behavior change** on the repro. Faithful implementation = dead code that fails acceptance. **Not implemented.**

---

## What I implemented instead (user redirect: "Fix breach clearing")

New live repro (Spring_, breach:50, 14:14–14:15, user log): breach TOUCHED, then the runner **beelined to single mobs in a zig-zag** (center 794,242 → chased 940,263 / 724,317 / 650,333 = 150–170u out), got **PANIC-egressed twice** (`hp -30%`/`hp -16%` → "leaving the fight" / "walking out S"), i.e. **fled the breach mid-clear**. User: *"breach collapse cuz we didnt stabilise or go far enuff"* + *"explore in a few directions moving while attacking."* A breach **grows while you kill inside it and collapses when you plant in the burst or leave the ring**.

**Fix:** move-while-attacking active-clear. When a breach mob is present (and after the melee-press standoff escape), instead of the nearest-mob beeline / standoff-stand, the char **circles the breach center in a rotating direction** while the rotation fires; the orbit radius tracks the current mob's ring so **wide breaches still get covered** (no "left without finishing" regression), and a **wedge fallback** hands off to the legacy BFS/macro route so walls still get routed around.

### Files / symbols
`mapper.js` (RUNTIME dir) only:
- **`breachSweepStep(player, now, mob)`** — new. The orbital move-while-attacking step (gated senders only; returns true).
- **`runBreachRoam`** mob-branch — one gated insert after the swarm-standoff escape: `if (BREACH_SWEEP_ON) { rotBreachChaseMoveAt = 0; return breachSweepStep(...); }`. Legacy chase (dp>55 route / dp<=55 stand) is untouched and runs only when the flag is off.
- Constants: `BREACH_SWEEP_ON`, `BREACH_SWEEP_LEAD`, `BREACH_SWEEP_MIN_R`, `BREACH_SWEEP_WEDGE_MS`.
- Vars: `_brSweepActAt`, `_brSweepDir`, `_brSweepWedgeAt`, `_brSweepPX`, `_brSweepPY`, `_brSweepRouteLogAt` (per-breach reset keyed on `rotBreachActivatedAt`).

### Setting
- `BREACH_SWEEP_ON = true` (house-convention const, no UI toggle). **Set false = byte-identical legacy** nearest-mob chase / standoff-stand. Nothing else new runs when off (the function is never called; constants/vars inert).

### Flag-off parity
The only reachable behavioral change is behind `if (BREACH_SWEEP_ON)`. Target-tracking (3164–3166), the swarm-standoff escape (3169–3170), and the done/collapse/loot/spawn-grace/stabilised/no-mob branches are unchanged. Completion state (`rotBreachLastMobAt`, `rotBreachStabilised`) is stamped earlier in `runBreachRoam`, so the early return skips nothing that ends a breach.

---

## LIVE-TEST CHECKLIST (Spring_-class breach)
Enter a breach with `clearBreach` on; watch `[Mapper]` breach lines.
- **WORKING:**
  - `[Breach] TOUCHED … -> clearing`, then `Breach: strafe-clear <mob> Nu [stab] (Ns)` status (not `running to`/`standoff`) — the char **keeps circling** the center while shooting, covering the ring in successive bearings.
  - Far/wide rings still clear: on a walled straggler you'll see `[Breach] sweep wedged -> macro route/BFS to <mob>` (throttled 3s), then it routes and resumes circling.
  - **Fewer/zero** `[AutoDodge] PANIC egress … leaving the fight` during the clear (continuous motion sheds the swarm's sustained damage).
  - Normal completion: `[Breach] STABILISED …`, `white-tail … -> done`, `cleared after Ns -> collect loot`, `done -> leaving`, then `[Pickit]` Breach Splinters — ideally more than the ~10 in the repro.
- **BROKEN (report):**
  - Char orbits an **empty arc** while mobs sit on the far side untouched (would mean the orbit isn't tracking mob density — needs a mob-bearing bias, noted below).
  - Stutter / move spam on the orbit (the gated senders should throttle it; if not, raise the cadence).
  - Any wide breach that ends with elites still alive at the edge (a "left without finishing" regression) — set `BREACH_SWEEP_ON=false` and compare.
- **Instant rollback:** `BREACH_SWEEP_ON=false` → today's behavior exactly.

---

## Risks / deviations / open items
- **Deviation from brief:** did NOT implement fixes #1/#2/#3 (disproven above; the user redirected). Touched the breach **runner + movement**, which the brief's hard limits forbade — explicitly authorized by the user's AskUserQuestion answer.
- **NOT MINE — concurrent edits in the file:** a separate uncommitted **verisium** hotfix (false-loot / open-radius relax at `~5185`, offer-read FAIL diagnostic at `~5237`, `exp2OpenApAt`/`exp2OfferDiagAt` at `~4823`) landed on disk *after* my `handoff/pre/TASK-67/mapper.js` snapshot (14:03). Those are **not** part of TASK-67 — do not attribute them to this diff. My changes are only in `~2275–2306` and `~3045–3172`.
- **Scoped to the active-clear standoff/close phase.** The **far-chase beeline** (dp>55 route branch) is unchanged, and the **panic/blind egress fleeing the breach** lives in `auto_dodge_core.js` (not touched). The sweep reduces the burst that triggers those, but if the char still flees a breach, a follow-up should **leash egress to the breach ring** while `rotBreachActivatedAt>0`.
- **Tuning knobs:** `BREACH_SWEEP_LEAD` (orbit arc-ahead), `BREACH_SWEEP_MIN_R`, `BREACH_SWEEP_WEDGE_MS`. The orbit currently self-propels off the **player's** ring bearing (covers all directions over time) — if it wastes time on empty arcs, bias the target toward the nearest mob's bearing.
- **Generalization:** the user's phrasing ("explore in a few directions moving while attacking") may want move-while-attacking beyond breaches (rares/general fights). Left out of scope; flag one if wanted.
- **The Oasis owned=0 gap is still open** (option B in the redirect): an incidentally-run breach under a co-located preemptor gets no proper adopt/clear/loot. Separate task if the user wants it.
- **TEST BEFORE COMMIT** — not committed; awaiting the user's live retest.

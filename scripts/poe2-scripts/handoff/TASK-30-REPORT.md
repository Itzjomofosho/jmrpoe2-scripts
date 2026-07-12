# TASK-30 REPORT — stale-channel wedge fix + stationary watchdog + fog-anchor yoyo latch

Runtime-only edits (untracked `c:\Games\jmr-poe2\scripts\poe2-scripts\`). NOT committed. Pre-snapshots in
`handoff\pre\TASK-30\` (rotation_builder.js, entity_actions.js, mapper.js). `node --check` passes on all three.

Solo work per HOUSE_RULES §0 (no fleets/workflows) — the session's "ultracode" default is overridden by that rule.

---

## A. Stale-channel movement wedge (BUG FIX on the release path — not flag-gated)

**Mechanism confirmed:** every channel release path lived inside `executeRotation`, which `entity_actions`
only calls WITH a combat target. When Snipe's target dies the tick the channel arms, `executeRotation` stops
being called → no release, no stop → char stands channelling in-game (28s/48s live) ignoring our move packets.

### Files / symbols
- **rotation_builder.js**
  - `channelArbiterTick()` — NEW **exported** function. Contains the extracted release arbiter. O(1) early-out
    (`if (!_activeChannel) return false`) so it's safe to run every frame. Returns `true` while still
    channelling (caller must not start new skills), `false` when nothing armed / released this tick.
  - `_isChannelling(player)` — NEW. Reads the live stage the SAME way `_perfectWindowOpen` does
    (`actor+0x228 → ctrl+0x1A8`); `stage > 0` ⇒ genuinely mid-channel. **No new RE, no new offsets** (reuses
    the perfect-window read). Gates the stop so we only send it when actually channelling (preserves the old
    "don't send a stale stop when not channelling" rule).
  - `_channelTargetGone(targetId)` — NEW. Target-death detection via `POE2Cache.getSharedEntities()` (the
    shared per-frame scan auto-attack already runs → free when cached). Absent from list OR `isAlive===false`
    OR `hp<=0` ⇒ gone.
  - `_releaseChannel(player, reason)` — NEW. Clears `_activeChannel` + published hold; sends `sendStopAction()`
    only when `_isChannelling`. Used by stale / timeout / target-death releases.
  - `_activeChannel` now carries `targetId` (set at arm from `targetEntity.id`).
  - `executeRotation` inline arbiter block (stale/perfect/timeout) **replaced** by
    `if (channelArbiterTick()) { _lastNoFireReason = 'channeling'; return false; }`.
- **entity_actions.js**
  - Imports `channelArbiterTick`; calls it **unconditionally at the top of `onDraw`** (before
    `processAutoAttack`), so it ticks every frame even with zero targets / auto-attack off / UI hidden.

### Behavior changes vs. today (intentional, per brief A-2/A-3)
- **Timeout release now gated on `_isChannelling`** (was unconditional stop). Skips the stop only when we are
  genuinely not channelling (the old stale-packet fear); in the wedge case we ARE channelling → stop is sent.
- **Stale path now sends a stop** when channelling (was "nuking without stop"). The `[Rotation] Channel STALE`
  warn line is GONE; releases now log `[Rotation] Channel released: <skill> (<reason>, stop|no stop -- not channelling)`.
- **Target-death fast release** at `elapsed>300ms` when the cast target is dead/gone (release ~sub-second
  instead of waiting the ~1.7s timeout).

---

## B. Mapper stationary watchdog (defense-in-depth) — `STATIONARY_UNSTICK_ON = true`

**mapper.js**, inside `stepPathWalker` (right after the arrival check, before repath). While a walk is owned
and neither a dodge roll (`dodgeMoveSuppressUntil` / MB dodge hold) nor the opener reach-hold
(`autoDodgeCfg.reachHoldActive`) is intentionally holding us, if grid pos hasn't moved >3u for 3s →
`log('[Mapper] stationary 3s while walking -> unstick (stop + resend)')`, `sendStopAction()` (imported from
rotation_builder), then `lastMoveTime = 0` to re-issue the current move this tick. Throttled to once / 5s.

- New state: `_statUnstickAnchorX/Y`, `_statUnstickSince`, `_statUnstickLastAt` (reset per map in the reset fn).
- **Existing stall clocks untouched** (own tracker; counts as no walk progress). Flag off ⇒ block never runs.

---

## C. Fog-anchor yoyo latch — `FOG_ANCHOR_LATCH_ON = true`

**Root cause:** the `WALKING_TO_BOSS_CHECKPOINT` re-entry gate (`if (bossTgtFound && !(...cooldown...))`) used the
**10s** `bossCheckpointApproachCooldownUntil`, while the other fog-block guards (arena fast-path, checkpoint
discovery) use the **25s** `fogBlockedAnchorUntil`. At 10s the gate re-rammed the sealed checkpoint while the
25s guards still blocked ⇒ the ~10s WALKING↔FINDING 180° yoyo.

**mapper.js**, FINDING_BOSS case, just before that re-entry gate:
- On the fog-unreachable verdict (`… fog-unreachable 5s … -> HOLD as bearing`) also set
  `fogAnchorLatchActive` + log `[Mapper] boss anchor fog-latched -> explore until pathable`.
- New gate block computes `_fogLatched`: while latched, probe pathability to the **live** `bossGridX/Y` every
  ~3s with `jsBfsPath` (the walker's own fog-gated `isWalkable` BFS — caps out at long range, returns a path
  only once revealed terrain connects). Path found → release + `[Mapper] boss anchor pathable -> resuming
  checkpoint`. Safety cap `FOG_ANCHOR_LATCH_MAX_MS = 25000` (aligned to `fogBlockedAnchorUntil`) →
  `[Mapper] boss anchor fog-latch 25s cap -> allowing checkpoint retry`.
- Re-entry gate condition gains `&& !_fogLatched`. Flag off ⇒ `_fogLatched` always false ⇒ byte-parity.
- New state: `fogAnchorLatchActive/SetAt/ProbeAt` (reset per map). All existing explore machinery unchanged —
  the latch only stops the flip-flop (staying in FINDING_BOSS keeps the explore target sticky by itself).

---

## Settings / consts added (all default-on kill-switches, house style)
| const | file | default | flip effect |
|---|---|---|---|
| `STATIONARY_UNSTICK_ON` | mapper.js | `true` | false ⇒ watchdog block never runs (byte-parity) |
| `FOG_ANCHOR_LATCH_ON` | mapper.js | `true` | false ⇒ `_fogLatched` always false, gate unchanged (byte-parity) |
| `FOG_ANCHOR_LATCH_MAX_MS` | mapper.js | `25000` | latch safety cap |

Part A is a bug fix on the release path (not flag-gated), per brief.

---

## LIVE-TEST CHECKLIST
**A (channel wedge):** kill a target mid-Snipe-channel (let the boss die the instant the channel arms).
- GOOD: `[Rotation] Channel released: ChannelledSnipe (target gone@…ms, stop)` **or** `(timeout@…ms, stop)`
  within ~2.5s; char immediately walkable; NO `[Rotation] Channel STALE` line the whole map; no 28s/48s standstill.
- BAD: `Channel STALE` appears, or char stands channelling >3s, or a `Channel released: … (no stop -- not
  channelling)` line while the char is visibly still channelling (⇒ `stage>0==channelling` assumption wrong; see Risks).

**B (stationary watchdog):** on any forced wedge (if reproducible).
- GOOD: `[Mapper] stationary 3s while walking -> unstick (stop + resend)` fires ≤ once/5s and the char resumes.
- BAD: it fires while the char is legitimately dodging/opening (should be suppressed), or spams faster than 5s.

**C (fog-anchor yoyo):** map start with a far fog-blocked boss anchor.
- GOOD: exactly ONE `[Mapper] boss anchor fog-latched -> explore until pathable`, then steady exploring — NO
  repeated `WALKING_TO_BOSS_CHECKPOINT ↔ FINDING_BOSS` flip every ~10s. Eventually either `boss anchor pathable
  -> resuming checkpoint` (route revealed) or `… fog-latch 25s cap -> allowing checkpoint retry`.
- BAD: still flipping every ~10s, or latch never releases even after you can clearly path to the boss.

---

## Risks / assumptions / deviations
1. **`stage > 0 == still channelling`** (`_isChannelling`) is taken from the brief (A-2, planner-asserted). If
   the stage sits at 0 during the early channel and only jumps at the perfect window, a timeout release could
   skip the stop and leave the wedge — but **Part B's stationary watchdog is the backstop** (it sends
   `sendStopAction` after 3s of no movement regardless). Worth confirming on the live A test above.
2. **Target-death detection** uses `getSharedEntities()` (SHARED_RADIUS, 128-nearest cap). A live target beyond
   that radius reads as "gone" → early release. Harmless (early release just re-fires the rotation) and the
   Snipe target is by definition near. Timeout still covers it if the list is momentarily stale.
3. **Per-frame arbiter scope:** the unconditional tick lives in `entity_actions.onDraw`, per brief. If
   `entity_actions` were disabled while some other driver (SpikenQOL bot) armed a channel, the per-frame release
   wouldn't run — but the SpikenQOL path also drives `executeRotation`, and Part B still backstops movement.
   No extra call site added (staying within the brief's named path).
4. **Part C probe = `jsBfsPath`**, not the walk's full `computePath` cascade. Deliberate: `findPathTerrain` is
   fog-INDEPENDENT (would release the latch instantly), and `computePath` mutates `currentPath`. `jsBfsPath` is
   the fog-gated, result-only method whose long-range cap + reveal-gating make it the correct "route actually
   opened" signal. It probes the live `bossGridX/Y` so a better checkpoint streaming in releases the latch
   naturally.
5. **Latch cap aligned to 25s** (not the 45s I first wrote) to stay in lockstep with `fogBlockedAnchorUntil`,
   which already guards the arena fast-path / checkpoint-discovery re-commits. A longer cap would let those
   guards expire while the latch still blocks (or the arena fast-path bypass the latch at 25s). Noted since the
   brief said "~3s probe" / "keep ONE explore target until reached/timeout" without pinning the cap.

## Open questions
- None blocking. The only thing needing live confirmation is Risk #1 (the `stage>0` channelling semantics) —
  the A checklist calls out exactly what a wrong assumption looks like, and Part B backstops it either way.

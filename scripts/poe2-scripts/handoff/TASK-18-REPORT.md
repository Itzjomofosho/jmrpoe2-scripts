# TASK-18 REPORT — Catchall tame: hard-CC suppression + per-anim dodge budget + channel-hold

Pre-snapshot: `handoff\pre\TASK-18\` (auto_dodge_core.js, rotation_builder.js) — taken before any edit.
`node --check`: PASS on both files (exit 0 each, run individually).

## Files touched + symbols

### auto_dodge_core.js
- **Import added:** `POE2Cache` from `./poe2_cache.js` (poe2_cache has no local imports — no cycle).
- **New consts (state block after `animIsAdvancing`, ~line 84):**
  `CATCHALL_TAME_ON` (=true, the master flag), `CATCHALL_BUDGET_N` (2), `CATCHALL_BUDGET_WINDOW_MS` (10000),
  `CATCHALL_MUTE_MS` (8000), `CATCHALL_UNMUTE_HP_DROP` (8), `CATCHALL_HOLD_HP_FLOOR` (70), `CC_BUFF_TTL_MS` (50).
- **New state:** `_ccVerdicts` (Map, entityId → 50ms hard-CC verdict), `_catchallDodges` (Map, `entityId|hazardName`
  → {times[], muteUntil, hpAtMute}), `_chHoldActive`, `_playerHpPct`, `_ccLogAt`, `_chHoldLogAt`.
- **New functions:**
  - `_ownerHardCCd(entityId)` — boss-only buff probe: filters `POE2Cache.getSharedEntities()` (lightweight +
    includeBuffs, per-frame cached, already built every frame by auto-attack during combat) to the one owner id;
    verdict cached 50ms (the C++ buff-cache granularity). EXACT match on buff names `frozen` / `electrocuted`
    (`includes('frozen')` would false-positive `cannot_be_frozen`-style auras into a permanent suppression).
  - `_catchallSuppressed(entityId, hazardName)` — the gate both catchall branches call before pushing:
    channel-hold (hp ≥ 70%) → budget mute (with damage-unmute check) → hard-CC'd owner. Cheap checks first;
    the buff probe runs last and only for live catchall candidates.
  - `_noteCatchallDodge(h, now)` — budget bookkeeping at the roll site; keys off the hazard's existing
    `name` + `entityId` (no change to hazard object shape).
- **Modified sites (all inside the two catchall branches / runAutoDodge only):**
  - Anim catchall (`boss-anim~catchall`, ~613): hazard name hoisted into `_abName` (identical string), push
    condition gains `&& !(CATCHALL_TAME_ON && _catchallSuppressed(e.id || 0, _abName))`.
  - Small-radius boss-cast fallback (~830): same pattern with `_bcName`.
  - `runAutoDodge` (~1232): per-scan compute of `_playerHpPct` (pooled hp+es %, same convention as
    `shouldRespectHpGate`) and `_chHoldActive` (`POE2Cache.channelHoldActive === true && now <= channelHoldUntil`).
  - Roll site (~1438): `_noteCatchallDodge(h, now)` next to the existing `dodgedActions.set` mark, so the budget
    counts exactly the catchall hazards actually rolled against — across anim INSTANCES (the fingerprint-bucket
    drift that produced 8 rolls in 13s in Willow), which `animCastDodged` alone cannot see.
- **Untouched, verified:** geometry/ground/projectile/melee branches, `minIntervalMs`, `animIsAdvancing` (TASK-07),
  frozen-PLAYER logic, boss orbit/kite, chicken (different plugin).

### rotation_builder.js
- **New function:** `_publishChannelHold(untilMs)` (~868, next to `_activeChannel`) — sets
  `POE2Cache.channelHoldActive` + `POE2Cache.channelHoldUntil`.
- **Call sites:** arm (`Channel armed:` site, ~1132) publishes `startedAt + timeoutMs`; all three exit paths —
  STALE nuke (~920), PERFECT WINDOW release (~928), timeout release (~934) — publish 0. These are the only four
  `_activeChannel` transitions in the file (no other cancel/error path exists; a rotation error mid-channel is
  covered by the `channelHoldUntil` deadline, see Bounds).

## Transport decision (brief said "pick one, say which")
**Picked: POE2Cache.** `autoDodgeCfg` is a mapper-PRIVATE const (not exported), and rotation_builder importing
auto_dodge_core would be circular (auto_dodge_core already imports `buildDirectionalPacket` from rotation_builder).
rotation_builder already imports POE2Cache. The core folds the published state into its own per-scan locals; the
`CFG.channelHoldActive` shape from the brief became `_chHoldActive` (module-local) since the cfg object belongs
to the mapper.

## Settings
- `CATCHALL_TAME_ON` — const in auto_dodge_core.js (~line 91), default **true** per the brief. Flip to `false`
  for byte-identical control flow: both push conditions short-circuit before calling any new code, the per-scan
  state block is skipped, the roll-site hook is skipped, and the hoisted `_abName`/`_bcName` consts produce
  identical strings to the old inline expressions. rotation_builder's publish is unconditional but inert — the
  dodge core is the only reader and it only reads under the flag (deviation noted below).
- Tunables (same const block): budget 2 dodges / 10s window, 8s mute, 8% hp-drop unmute, 70% channel-hold floor.

## Bounds (brief: "bound everything")
- Mute expires at 8s; damage-unmute clears it earlier.
- Channel-hold is double-bounded: rotation clears the flag on every exit path, AND the core requires
  `now <= channelHoldUntil` (= startedAt + timeoutMs, itself capped at `_CHANNEL_TIMEOUT_CAP_MS` 3000 + jitter),
  so a rotation that stops ticking mid-channel can never wedge the hold on for more than the channel's own timeout.
- `_ccVerdicts` pruned >64 entries (1s stale), `_catchallDodges` pruned >128 entries (30s-idle, unmuted).

## Perf budget
- Channel-hold + budget checks: O(1) Map/bool work, only on catchall candidates (10Hz boss scan).
- Hard-CC probe: no new native scan in practice — the shared list is already built every frame by auto-attack
  during combat; the probe filters it in JS (≤128 entries) at most once per 50ms per entity. Worst case (auto-attack
  idle mid-boss-fight): one lightweight+buffs 500u shared scan per 100ms dodge scan, only while a catchall
  candidate is live. No per-frame WithBuffs on the world anywhere.

## LIVE-TEST CHECKLIST
1. **Hard-CC suppression** (freeze build, boss fight): while the boss is visibly frozen/electrocuted, expect
   `[AutoDodge] catchall skipped (owner frozen/electrocuted)` (throttled 2s) and **ZERO**
   `[AutoDodge] ROLL ... why=boss_telegraph:boss-anim~catchall...` lines until the CC drops.
   **Broken:** catchall ROLL lines while the boss stands frozen.
2. **Per-anim budget** (looping anim, the Willow class): first two rolls of the same anim proceed as today, then
   `[AutoDodge] catchall anim_XXXX x2 in 10s -> muted 8s` and no further catchall rolls of that anim for 8s.
   **Broken:** a 3rd+ roll of the same `boss-anim~catchall:anim_XXXX` with no mute line (the 8-rolls-in-13s yoyo).
3. **Damage-unmute:** while muted, take a real hit (>8% effective hp) → `[AutoDodge] catchall anim_XXXX unmuted
   (hp 91% -> 78%)` and catchall dodging of that anim resumes immediately.
   **Broken:** hp visibly dropping during a mute with no unmute line.
4. **Channel-hold:** after `[Rotation] Channel armed: ChannelledSnipe ...`, a catchall candidate logs
   `[AutoDodge] catchall held (channel active, hp XX%)` (throttled 2s) instead of rolling, and the channel ends in
   `[Rotation] Channel released: ... (PERFECT WINDOW @...)` during the boss fight (was: cancelled by rolls).
   **Broken:** a catchall ROLL mid-channel at hp ≥ 70%, or a hold persisting after the release/timeout line.
5. **Hold floor:** if hp < 70% mid-channel, catchall dodges resume (may cancel the channel — intended survival valve).
6. **Untouched classes:** a genuine geometry AoE / ground effect under the player still rolls INSTANTLY even
   mid-channel and even while an anim is muted — ROLL lines whose `why=` is NOT `~catchall` must be unaffected.
7. **Flag-off parity spot-check (optional):** set `CATCHALL_TAME_ON = false` → behavior and logs identical to
   baseline; none of the new log lines can appear.

## Deviations from the brief (with why)
- **Transport = POE2Cache**, not a direct `autoDodgeCfg` write (sanctioned fallback; reasons above). The publish in
  rotation_builder is unconditional rather than flag-gated: the flag lives in the core (the only reader), and gating
  the publisher would need a second flag or a circular import.
- **"hp" = pooled hp+es** for both the 70% floor and the 8% drop, matching the existing `shouldRespectHpGate`
  convention — ES absorbs damage first, so hp-only would miss real damage on an ES buffer.
- **Budget covers BOTH catchall branches** (the brief's flag-scope header lists both): keyed `(entityId, hazardName)`
  — anim name for the anim branch (`boss-anim~catchall:anim_1086`, matching the brief's log example), skill name for
  the cast fallback (`<skill>~catchall`). "animId" extended naturally to the action-based fallback.
- **Extra log lines** beyond the brief's single mute line: throttled `catchall skipped (owner frozen/electrocuted)`,
  throttled `catchall held (channel active...)`, and per-event `catchall ... unmuted (...)` — the live-test checklist
  is unverifiable without positive signals; all are flag-gated and throttled/eventful.
- **Fast re-mute:** dodge times are kept (not cleared) when a mute is set, so after a natural 8s expiry a single
  further dodge inside the still-open 10s window re-mutes at `x3`. Intended — the budget's premise (we're ranged,
  it isn't hitting us) holds; damage-unmute (which DOES clear the times) is the safety valve.

## Risks
- If the boss is outside the shared list (beyond its 500u radius or dropped by the 128-nearest cap in an extreme
  swarm), `_ownerHardCCd` returns false → catchall behaves exactly as today (fail-open toward dodging). Same for
  missing/empty `buffs`.
- Buff-name assumption: hard-CC ids are exactly `frozen` / `electrocuted` (per the game's buff ids; buff_diag can
  confirm live). If the freeze debuff carries a different id on some bosses, feature 1 silently no-ops (safe).
- `stunned` is NOT treated as hard CC (brief listed frozen/electrocuted only).

## Open questions
None blocking.

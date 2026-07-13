# TASK-56 REPORT — arbiter engaged-gate + shrine collect-verify + abyss trust audit + discover heading stamp + Depths gate

Implementer: Opus 4.8. Pre-snapshot: `handoff/pre/TASK-56/` (mapper.js, opener.js, auto_dodge_core.js — all copied
BEFORE any edit, md5-verified). All three files `node --check` clean. Runtime dir only; no C++, no commits, no memory
writes. TEST BEFORE COMMIT.

---

## FILES TOUCHED

- `mapper.js` — Parts A, C (comment only), D, E
- `opener.js` — Part B (shrine collect-verify)
- `auto_dodge_core.js` — Part B (one classify row)

---

## PART A — ARB_ENGAGED_HOLD_ON (mapper.js)

The engaged-gate family (47-B rares, 53-C reach, the utility/sbox/hv-insert start gates) stood every OTHER system down
at a physically-engaged encounter — but nothing gated `pickObjective` itself. Live 17:48:18 it returned `{kind:'boss'}`
(the engaged verisium had fallen out of its `cands` via a filter) while `[Engaged] utility start deferred` held utility
off the SAME verisium → `arbTick` fell through to the boss walk → encounter abandoned.

**Symbols added:** `ARB_ENGAGED_HOLD_ON` (const, default `true`), `_arbEngagedHoldLogAt`, `arbEngagedRunner(why,player,now)`,
`arbEngagedHold(anchor,player,now)`, `arbEngagedHoldGoal(anchor,player,now)`.

**Mechanism.** A gate at the TOP of `pickObjective` (right after `arbBossDeferSpent = _bossDeferSpent`, BEFORE the
55-A defer-spent boss-return block): while `engagedContentAnchor()` is non-null it returns a synthetic content goal
(`key='engaged:<why>'`) whose `run()` drives that encounter's own runner (`runExpedition2`/`runAbyssRun`/`runBreachRoam`/
`runHiveDefense`) and, if the runner can't act this frame, HOLDS at the anchor (walk-back + stand, MB content(3)).
`arbTick` treats the true drive as handled → never falls through to boss.

**Every dispatch path gated (per brief):** placed upstream of ALL of pickObjective's return points, so each is bypassed
while engaged — the 55-A defer-spent boss return (`if(!ARB_DEFER_SPENT_GRAB_ON) return {kind:'boss'}`), the
`_deferNearOnly` near-grab, the `cands` scan, R1 committed-hold, R4 fresh, R5 boss. Because `arbTick` returns true while
engaged, the downstream boss-find / checkpoint-yield / `nearbyObjectiveBeforeBoss` paths never receive the frame either.
The gate sits AFTER the boss-defer bookkeeping so the fast-out clock stays frozen through the encounter (clean resume).

**Where the hole actually was:** breach + hive are already driven by dedicated pre-`arbTick` hooks (`runBreachRoam` @15949,
`runHiveDefense` @15952 — both return before `arbTick`), so the real hole was **verisium + abyss** (no pre-arbTick hook;
driven only by `arbTick`→`pickObjective`). The gate fixes those two and backstops breach/hive for the frames where their
hooks decline while the engaged state still stands. No double-drive: when those hooks return false they also clear their
engaged state (`rotBreachActivatedAt`/`hiveDefStart`), so `engagedContentAnchor()` is null by the time the gate runs.

**No livelock:** the hold releases itself when the encounter's own caps clear the engaged state (verisium 53-C retire/ESC,
abyss dwell caps + `abyssId=0`, breach completion clears `rotBreachActivatedAt`, hive 240s cap). Synthetic key never
matches `arbCommittedKey`, so `arbValveTick` no-ops (can't release the hold) and the prior commitment is left untouched
(it self-reconciles via `arbTerminated` when the engaged state clears).

**Flag off** (`ARB_ENGAGED_HOLD_ON=false`) → gate absent → byte-identical.

---

## PART B — SHRINE_COLLECT_VERIFY_ON (opener.js) + lightning-storm row (auto_dodge_core.js)

### B1 opener.js — shrine collection verify
A shrine buff needs the TOUCH; a "successful" open packet only means the send left. A contested auto-walk whiffs it and
nothing checked (17:47:01 `Opened Shrine (41.2u) commit-click` → "DIDNT get the shrine").

**Symbols added:** `SHRINE_COLLECT_VERIFY_ON` (const, default `true`), `SHRINE_VERIFY_MS=3000`, `SHRINE_VERIFY_GONE_MS=8000`,
`SHRINE_VERIFY_SCAN_R=120`, `shrineVerify` (Map), `_shrineVerifyScanAt`, `runShrineCollectVerify(now)`.

**Mechanism.** Every successful `Shrine`-type open records `{id,x,y,at}` in `shrineVerify`. `runShrineCollectVerify` (called
early in `processAutoOpen`, before the open-cooldown return, throttled 500ms) re-reads each shrine ~3s later via a 120u
lightweight scan:
- **still targetable** = NOT collected → clear its cooldown (`openCommitAt.delete`, `rec.lastAttemptTime=0`) so the
  commit-click machinery re-approaches now; **KEEP `rec.attempts`/`freeRetries`/`banned`** → the anti-repeat cap still
  bounds a genuinely unreachable one. Logs `[Opener] shrine NOT collected (still targetable Nu ...) -> cleared cooldown,
  re-approaching`. If already hard-banned → drop (concede, bounded).
- **untargetable/consumed** = collected → drop (today's silent assumption, now confirmed).
- **un-findable past 8s** (walked away / de-streamed) → drop. `pruneOpenBlacklist` also drops entries >30s (safety).

Loop terminates when the shrine goes untargetable OR the cap bans it (re-added by each successful re-open).

### B2 auto_dodge_core.js — one classify row
Added to `GROUND_CLASS_TABLE`: `{ re: /shrine\/lightning\/lightningstorm/i, sev: 1, radiusMul: 1.0 }` — the Farudin
culture-shrine's lightning storm (`Environment/shrine/lightning/lightningstorm_trackingbolt`, six bolts tracked the char
at 15-27u). Scoped to the `shrine/lightning/lightningstorm` segment so the shrine **openable** (a Metadata object, no such
path, and not hostile so it never reaches `classifyGroundPath` anyway) never matches — only the storm ao. sev 1 = AVOID.
Verified the soft-strip regex (`/chill|shock|ignit|burn|abysscrack/i`) does NOT match `lightningstorm_trackingbolt`, so
the zone isn't stripped.

**NOTE (risk):** `classifyGroundPath` ground classification only runs in dodge `mode==='boss'||'rare'` (existing gate for
the whole table — flameblast/acidic_ground/etc. share it). If the culture-shrine fires while dodge mode is off/default,
the row won't produce a zone. The brief asked for "one classify row" (table parity), so I matched the existing behavior;
mode-gating is out of scope. Flagged if a live test shows the storm hits while not in boss/rare mode.

---

## PART C — flip-watch hotfix VERIFY + abyssNodeStatus AUDIT (mapper.js, comment only)

**VERIFY (PLANNER HOTFIX, `FLIP_TRUST_R=150`).** Correct. The distance guard sits after the committed-in-loot-dwell skip
(4161) and before the `abyssNodeStatus` probe: a far entry is `continue`d (no probe, no `_abyssFlipSt` update → holds last
state, no flip). The evidenced 441u false-complete is now impossible (441 > 150). **Paused-completion (51-A) still fires:**
a genuinely-paused runner is AT its node (close, <150u — the paused case is close by definition), so it passes the guard,
the observed active→done flip fires, the chest site queues, and the stranded runner state releases. Parity shape intact
(whole fn gated by `ABYSS_FLIP_WATCH_ON`).

**AUDIT — why `abyssNodeStatus` returned 'done' for a de-streamed 441u entry (ROOT proven):** a compound default-to-'done'
on an unreadable entry —
1. `abyssIconType(gx,gy)` returns `null` — it looks for a `getQuestMarkers` marker within 10u of the node's grid; a far/
   de-streamed node's marker de-streamed with it → no match.
2. The fallback `dumpEntityComponents(ent.address)` reads a **STALE/recycled address** — `contentQueue` caches `address`
   at populate-time (`contentQueue.set(... address:address||0 ...)`, ~7559) and never refreshes it; after de-stream it
   points at a recycled slab.
3. The `else`/`catch` branches **default to `'done'`** — a read failure is indistinguishable from a genuine spent node.
   (Not a crash — the address is non-zero garbage, so the dump runs and just fails the `TriggerableBlockage` regex.)

**CONSUMERS — only one is unsafe, already fixed:**
- `abyssFlipWatch` (4165) — iterates de-streamed `contentQueue` entries → THE unsafe consumer → fixed by the hotfix.
- `getAbyssNodes` (3786), `runAbyssRun` done-detect (3958), `abyssTryEssenceUnlock` (3770), `abyssSweepProbeSite` (4211),
  minimap layer (~20330): all read entities from **live `poe2.getEntities` scans (streamed-only)** or, in `runAbyssRun`,
  handle the de-stream case by **distance** (the `!nodes.some(n=>n.id===abyssId)` branch, 3886) — never by
  `abyssNodeStatus`. **Proven safe.**

**Action:** since no additional consumer is provably unsafe (and the hard-limit forbids speculative rewrites / touching the
51-A dwell-gate), I made **no behavior change** — only added a lean TRUST BOUNDARY comment above `abyssNodeStatus`
documenting that a 'done' is trustworthy only for a streamed/near entity and that de-streamed callers must distance-gate
(as the hotfix does), so a future consumer can't reintroduce the bug.

---

## PART D — DISC_HEADING_STAMP_ON: discover heading stamp + active-walk concede guard (mapper.js)

The B2 revealed-map concede reads `now - discoverLastHeadingAt`, but that clock was refreshed ONLY by the re-pick block
(a fresh marker/bucket/patrol pick, line ~7387). A long STICKY walk / frontier-crawl toward an unfound target committed
headings the whole time yet never restamped it, so the clock aged across the walk; a transient null re-pick (radar-ban /
lazy-validate) then read "8s+ sustained miss" and conceded MID-WALK while an 18wp route was actively closing (Forge
17:53:09 → 17:54:09 → `leaving anyway` → portal, abyss unfound).

**Symbols added:** `DISC_HEADING_STAMP_ON` (const, default `true`), `DISC_ACTIVE_WALK_MS=5000`.

**Fix 1 (an active walk IS a heading):** restamp `discoverLastHeadingAt = now` on (a) every `_dstep==='walking'` frame
(after `stepPathWalker`) and (b) every fresh frontier-crawl hop commit. `'stuck'/'no_path'` do NOT stamp → the 8s window
still fires on a genuinely dead map. During a true null famine the walk path (7329+) is never reached (the null re-pick
`return false`s early), so the clock ages and concede still fires.

**Fix 2 (null-while-closing doesn't count):** in all three concede blocks (DISC_POSTCOMPLETE_FIX_ON, COVERAGE_SWEEP_ON,
patrol-else) a guard `if (Number.isFinite(discoverTgtX) && now - discoverProgAt < DISC_ACTIVE_WALK_MS) return false;`
returns before latching — a null pick while the sticky target progressed within 5s is not a famine. Bounded: once
`discoverProgAt` ages past 5s the guard stops and the 8s concede evaluates → no livelock.

Verified against the Forge sequence: the last successful heading was ~13s before the second null pass; with Fix 1 the
sticky-walk/crawl frames now restamp `discoverLastHeadingAt` throughout that 13s, so `now - discoverLastHeadingAt < 8000`
→ no concede; and even if it hadn't, Fix 2's `discoverProgAt < 5s` guard blocks the concede while the 18wp route closes.

**Flag off** → only the re-pick block stamps (today) and the concede is unguarded → byte-parity.

**OPINE (leave-gate draining a just-fed anchor — planner leans NO, do not implement):** Agree — NO. The portal is a
terminal verdict; draining a just-fed nav anchor to re-open the map for a speculative nearby openable would add a NEW way
to defer the portal, which is exactly what the leave-gate exists to bound. The `[Nav] hv anchor +shrine@(...)` fed at the
leave window is a harmless unused nav hint (dead on arrival). If a nearby openable genuinely deserves servicing before
leaving, that's already the MAP_COMPLETE leave-gate utility pass's job (openables within 320u, on the way out) — not a
reactive anchor drain. The portal decision stands.

---

## PART E — ABYSS_DEPTHS_GATE_ON: Abyssal Depths not-huntable gate (mapper.js)

When the map's Abyss bit is incomplete because the remainder IS the Abyssal Depths SUB-AREA (a parked-capability door we
don't enter), there is no huntable abyss node — the unfound-abyss hunt runs the full 90s window unwinnably (Backwash 18:03
"yoyod and opened port and YOYOD"). The marker-first pick is already hotfixed; the fog-bucket hunt still ran.

**Symbols added:** `ABYSS_DEPTHS_GATE_ON` (const, default `true`), `_abyssDepthsAt`/`_abyssDepthsVal`/`_abyssDepthsLogged`,
`abyssRemainderIsDepths(now)` (cached 3s).

**Detection (`abyssRemainderIsDepths`):** abyss objective (Abyss OR AbyssDepths bit) incomplete AND no other abyss evidence
(no active abyss in `contentQueue`, none from `getAbyssNodes`) AND an AbyssalDepths entrance present (a `getQuestMarkers`
path matching `/AbyssalDepths|Abyss.*Depths/i` — same regex as the planner hotfix — or a `nameContains:'AbyssalDepths'`
entity). Logs the one line `[Discover] abyss remainder is the Depths sub-area -> not huntable` once per map.

**Applied (abyss type skipped when detected):**
- `hasUnfoundListedContent` — the single lever: discover's own `if(!_unfound) return false` stops the hunt, AND the
  cleanup ban-wait hold (`if(!discoverConceded && hasUnfoundListedContent(now)) mapCompleteCleanupNoProgressSince = now`,
  ~19014) no longer resets for it (so the map leaves on schedule instead of waiting the 90s window).
- `hasConfirmedUnfoundContent` — the phantom "one more" for abyss is suppressed.
- discover `_unfoundTypes` builder — abyss never enters the fog-bucket marker hunt.
- map summary — abyss tail reads `(remainder: Abyssal Depths, unsupported)`; if no abyss row exists (pure-Depths map) the
  content string gets `[abyss remainder: Abyssal Depths, unsupported]` appended (honest tail, not "game lists more").

`_abyssDepthsAt/Val/Logged` reset per map in `resetMapper`. When the Depths capability lands someday, `abyssRemainderIsDepths`
is where it plugs in (return false + drive the entrance instead of skipping).

**Flag off** → abyss stays "unfound" → today's unwinnable hunt runs → byte-parity.

**NOTE (heuristic risk, brief-sanctioned):** the "no abyss evidence" condition can transiently hold on a map that has BOTH
a real abyss node (momentarily de-streamed/not-yet-queued) AND a Depths entrance; the 3s cache re-evaluates and clears the
gate once the real node streams. The brief specified exactly this condition ("no nodes in queue/scan").

---

## LIVE-TEST CHECKLIST

**A (engaged hold).** Engage a verisium/abyss; watch the shadow log. Expect `[ArbShadow] pick=engaged:verisium` (or
`engaged:abyss`) and a throttled `[Arb] engaged-hold: <why> -> drive/hold, no boss/other pick` — NOT `pick=boss` — while
engaged; encounter completes, THEN the boss pick appears. BROKEN = `pick=boss` while `[Engaged]` lines are firing, or the
char walks off an engaged verisium toward the boss checkpoint.

**B1 (shrine verify).** Open a shrine where the walk-in gets contested. WORKING = `[Opener] shrine NOT collected (still
targetable ...) -> cleared cooldown, re-approaching`, then re-approach until collected (the line stops) or the anti-repeat
ban caps it. BROKEN = `Opened Shrine` with no follow-up and the shrine still standing (buff never gained). A cleanly
collected shrine produces NO `NOT collected` line (goes untargetable).

**B2 (lightning storm).** On a Farudin culture-shrine with the lightning storm, in boss/rare dodge mode, expect a danger
zone / avoidance around the storm bolts (the shrine openable itself must still be openable — no phantom hazard on it).

**C (abyss trust).** No `[AbyssSweep] flip-watch (...)` completion for a node with no live entity while the player is >150u
away (the 441u phantom is impossible). Abyss chest counts in the map summary stop over-reporting false completions.

**D (discover heading).** Forge-class post-boss with unfound content: discover must VISIBLY drive (`[Discover] ... marker
at ...` / `exploring toward ...`) or VISIBLY concede (`[Discover] no fog frontier + no routable mass -> conceded`) — and
`leaving anyway` can only follow a logged concede, never fire mid-walk while a route is closing.

**E (Depths gate).** On an AbyssalDepths-remainder map: expect ONE `[Discover] abyss remainder is the Depths sub-area ->
not huntable`, no abyss fog-hunt / portal-yoyo, the map leaves without waiting the 90s abyss window, and the summary tail
reads `(remainder: Abyssal Depths, unsupported)`.

---

## RISKS / DEVIATIONS

- **B2 mode-gating** (noted above): the classify row inherits the boss/rare-only gate of the whole ground-class table.
- **A cosmetic:** the one-time `[Arb] boss-defer budget spent` transition log may be skipped if the budget flips spent
  DURING an engagement (the gate returns before that block). Harmless log-timing only.
- **E heuristic** (noted above): brief-sanctioned "no abyss evidence" transient window, self-healing via the 3s cache.
- **C:** made NO code behavior change (audit + verify + doc comment only) — the only unsafe consumer was already hotfixed
  and the hard-limit forbids speculative rewrites. If the planner wants `abyssNodeStatus` hardened at the root
  (return an explicit 'unknown' for unreadable entries), that requires auditing every consumer's `!== 'active'` handling
  and is a larger change than this brief scoped.

## OPEN QUESTIONS

None blocking. One for the planner's judgment: should `abyssNodeStatus` be hardened at the root (Part C) in a future task,
or is the per-consumer trust rule (distance-gate at the call site, as the hotfix does) the preferred long-term shape?

# TASK-55 REPORT — boss-defer starve / sweep A<->B swap / mirror never-detected

Implementer: Opus 4.8. File touched: **mapper.js ONLY**. Pre-snapshot: `handoff/pre/TASK-55/mapper.js` (copied FIRST).
`node --check mapper.js` → **PASS**. All new symbols grepped, single-definition, reset per-map. NOT committed (TEST BEFORE COMMIT).
A / B / C are independently flagged; every flag off = today's byte-parity control flow.

---

## A. BOSS-DEFER-SPENT — near content grabbed, latch made visible (flag `ARB_DEFER_SPENT_GRAB_ON = true`)

**Symbols added/modified** (all in `pickObjective` + module state):
- `const ARB_DEFER_SPENT_GRAB_ON = true;` `let arbDeferSpentSaidAt = 0;` (near `arbDeferLogAt`, ~5696).
- `pickObjective`: replaced the silent `if (_bossDeferSpent) return {kind:'boss'}` with a logged, flag-gated block that
  sets `_deferNearOnly` and falls through to the scan (flag off still returns boss immediately — byte-parity).
- Candidate scan: `if (_deferNearOnly) elig = elig && cl.dist <= ARB_GRAB_DIST;` (after the phase-elig / overtime block).
- Commitment R1/R3 "out of cands but alive" branch: `_farUnderDefer` guard — a FAR (`>ARB_GRAB_DIST`) committed entry
  dropped from cands by near-only is CONCEDED (arbRelease) instead of chased; a NEAR committed entry stays in cands and holds.
- Reset: `arbDeferSpentSaidAt = 0;` added to the per-map `arbBossDefer*` reset line.

**Budget mechanics untouched** (per hard limit): `arbBossDeferSince/ImprovedAt/BestDist`, `PREBOSS_HOLD_BUDGET_MS` (240s),
`PREBOSS_BOSS_FASTOUT_MS` (30s), and the `_bossDeferSpent` computation are byte-identical. Only the *treatment* of the spent
state changed: `arbBossDeferSpent` still latches and still keeps `_bossDriveLootOnly` true (still heading bossward). When the
absolute 240s cap trips, near content is grabbed once each then boss; the cap is never refreshed by content engagement, so the
boss is not deferred forever.

**Behavior**: defer-spent + flag on → log the flip once, then run a **near-only** candidate scan (≤260u). If any ≤260u content is
eligible → claim & drive it (the R4 fresh pick / commitment hold now sees it). No ≤260u content → R5 returns boss (far content =
post-boss cleanup). A ≤260u item that engages refreshes the fast-out → the budget un-spends → normal flow resumes.

**A#3 — WHY the Port verisium never got path-order-noted (from `C:\tmp\log.txt`, Port 16:07–16:10):**
- Boss belief `arena_tgt centroid=(2645,2185) conf=0.9` (16:05:10) — a CONFIDENT anchor, so the defer budget was legitimately
  running. It was **fog-latched / unreachable** the whole window (`boss anchor fog-latched -> explore` / `fog-latch 25s cap`
  repeating 16:05–16:07). No boss approach → the 30s fast-out spent the budget → `_bossDeferSpent` latched.
- `[ArbShadow] pick=boss committed=-` throughout; **zero** arb classify/defer/commit/path-order lines ever name the verisium.
  That is the proof: the OLD `if (_bossDeferSpent) return {kind:'boss'}` fired **before** the candidate loop, and the path-order
  recording lives **inside** that loop — so the verisium was never classified, so it could not be path-order-noted **regardless of
  its distance**. The mechanism, not the geometry, is the cause.
- The verisium's coords are not in the log (nothing classified it), so I cannot state its exact distance. The player was doing the
  abyss sweep around (1668–1783, 1185–1300); the boss anchor (2645,2185) is ~1365u from there and unreachable. If the verisium
  sat ≤260u of the sweep path, the fix now claims it pre-boss; if it was genuinely far off-route, post-boss cleanup owning it is
  correct — and the new 60s "`active but refused`" line now names it either way. This log is the **worst case** the fix targets:
  the boss it forced the bot toward was itself unpathable, so refusing ALL content starved the map with no boss progress possible.

**New log lines (A):**
- `[Arb] boss-defer budget spent -> content deferred to post-boss` — once, on the false→true flip.
- `[Arb] boss-defer spent: <key> <N>u active but refused -> post-boss cleanup` — ≤1/60s while a >260u item sits refused.

---

## B. SWEEP-LAYER HOLD — the A<->B "yoyo" (flag `OB_SWEEP_HOLD_ON = true`)

**Symbols added/modified:**
- `const OB_SWEEP_HOLD_ON = true;` (next to `OB_COMPLETE_RELEASE_ON`, ~1503).
- `OB.claim` intra-layer handoff: deny an incoming sweep claim whose head is `r.committed === false`
  (log `[OB] sweep-hold <cur> vs <new> (uncommitted head) -- commitment holds`, throttled 2s). Non-sweep layers
  (`committed` undefined) and the flag-off path fall straight through to today's handoff.
- `obSweepTick`: added `committed: !!s.startAt` to the claim record (the only place `committed` is set).

**What the evidence actually shows (important — read before judging):** I traced the exact swaps in the log. The sweep's REAL
movement was already correct nearest-neighbor and already holds a committed head (the `!abyssSweepSites[0].startAt` gate on the
sort). Two of the three "swap" classes are NOT defects:
- `complete sweep:X -> claim=sweep:Y` every ~10–15s = the legitimate per-site retire→advance (each site takes that long to loot).
- The A→B→A the brief cites (`139x99 → 144x108 → 149x99`, the middle claim 0.16s long, 16:08:59.872→16:09:00.035) is a **0.16s
  OB-shadow-log flash**: on the retire frame `obSweepTick` claims the freshly-shifted `array[0]` (144, `startAt=0`) *before* the
  next-frame retire-boundary re-sort settles on the actual nearest (149). The bot never walked toward 144 that frame (the walk
  target was set to 149). `obOn()` is off in these runs (`shadow-deny` lines), so OB does not drive — the flash is purely the log.

**Fix result** (faithful to the brief, minimal): the transient head (`committed=false`) is now DENIED at the intra-layer handoff,
so the OB record holds its committed head until a genuinely-serviced sibling replaces it. The A→B→A flash becomes:
`[OB] sweep-hold 139x99 vs 144x108 (uncommitted head)` then a single clean `complete 139x99 -> claim=sweep:149x99` — i.e. the
brief's "hold-deny log appears instead." **Real movement is unchanged** (it was already nearest-neighbor); this is a shadow-record
correctness fix. Reuses the broker's existing deny path (`this.say` + `return false`) — no second hold implementation; the layer +
`committed` field is the "layer parameter." NOTE: arbCommitTo/OB_CONTENT_HOLD_ON (43-A) is the arbiter's own commitment on a
DIFFERENT subsystem — the sweep is a self-driven runner mirrored into the OB broker — so the hold necessarily lives in
`OB.claim`, not `arbCommitTo`; that is the closest literal reuse the two code paths allow.

---

## C. DELIRIUM MIRROR — start-commit + drift instrumentation (flag `MIRROR_START_COMMIT_ON = true`)

**Symbols added/modified:**
- `const MIRROR_START_COMMIT_ON = true; const MIRROR_START_COMMIT_MS = 60000;` (next to `DELIRIUM_REACH`).
- `let _mirDetectedThisMap, _mirStartLogged, _mirNotDetLogged, _mirDriftChkAt` (instrumentation latches; reset per-map).
- `findDeliriumMirror`: for the first 60s (`_startCommit`), acquisition `_reach = Infinity` **and** the fog-walkable neighborhood
  gate is bypassed — so a listed start mirror at ANY distance is committed. Flag off / after 60s = the exact 500u@30s / 200u tiers.
- `handleDeliriumMirror`: instrumentation — `[Mirror] detected (x,y) Nu` on first sighting; `[Mirror] start mirror at (x,y) Nu`
  once when start-commit surfaces a mirror the normal reach would have missed (`d > normReach`); `[Mirror] listed but NOT
  detected` once (drift alarm) when the objective row lists Delirium but `getMapContent` surfaced no piece for 30s and none was
  ever detected (5s-throttled `mapObjectiveExists` probe).

**Behavior**: the committed mirror already persists past 60s via the existing `holdKey` retention bypass; the owned-progress cap
(10s no-progress) + blacklist bound a genuinely unreachable one (unchanged). The drift line makes any FUTURE real
`getMapContent` drift name itself (the Port drift the planner ruled out would have printed it).

**Deviation / risk to flag**: the brief says "commit at ANY distance," so `_reach = Infinity` with only the cap+blacklist as the
bound. During the first 60s this also applies to Delirium **shard pieces** (not just the start mirror — they share `type:Delirium`),
so a far shard could be chased for up to one cap window before blacklist. Same failure mode as today, wider radius; if far-map
misreads appear, a sane cap (e.g. 1200u) on `_startCommit` reach is the knob. Flagged, not changed (honoring the brief's wording).

---

## LIVE-TEST CHECKLIST

**A — a map with near content + a spent/fog-latched boss defer:**
- WORKING: `[Arb] boss-defer budget spent -> content deferred to post-boss` prints once, then ≤260u content is actually claimed &
  run pre-boss (`[ArbShadow] pick=content committed=<key>` instead of endless `pick=boss committed=-`); >260u content shows
  `[Arb] boss-defer spent: <key> <N>u active but refused` ≤1/60s.
- BROKEN: still `pick=boss committed=-` with a ≤260u active item sitting for minutes; or the bot chases FAR content post-spend
  (the `_farUnderDefer` concede failed); or it never engages the boss at all after the 240s cap (budget mechanics disturbed).

**B — a map with 2+ abyss chest sites cleared in sequence:**
- WORKING: OB log shows `[OB] sweep-hold <old> vs <transient> (uncommitted head)` at the retire boundary, then a single clean
  `complete <old> -> claim=<next>`; no 0.16s A→B→A flash. Movement stays nearest-neighbor (no real back-and-forth to one site).
- BROKEN: a genuine repeated walk to the SAME site (movement, not just log) — that would be a NEW bug, not this one; or the OB
  sweep record freezes on the first site (the hold denied a legit committed advance).

**C — the next Delirium map (`deliriumMirrorEnabled=true`):**
- WORKING: `[Mirror] detected (x,y) Nu` early; if the mirror was off the opening path, `[Mirror] start mirror at (x,y) Nu ->
  committing` and the bot walks back into it BEFORE the boss walk. Delirium objective completes.
- DRIFT VISIBLE (the point of the instrumentation): if a real binding drift returns, `[Mirror] listed but NOT detected` prints
  once ~30s in — that names the failure instead of a silent skip.
- BROKEN: bot drags 600u+ to a phantom far shard and burns a cap window (the "any distance" risk above) — if seen, apply the
  distance cap knob.

## OPEN QUESTIONS
- None blocking. B's premise (a harmful movement yoyo) was largely a shadow-log artifact — the fix is faithful and harmless but the
  visible win is the log, not motion. If the planner intended a real movement change, the sweep site sort (not the OB shadow) is
  where it would live; say so and I'll move it.

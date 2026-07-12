# TASK-43 — Arbiter thrashes two contested content items, completes NEITHER (Channel 21:10, 2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-43\`. File: mapper.js ONLY.
Evidence: C:\tmp\log.txt (Channel 21:10:11-21:10:59). User: "didn't start verisium or breach". Two NEAR
content items (breach:354, verisium:1580) — the arbiter LAYER-SWAPS between them ~1/s and finishes neither.

## THE CORE BUG: content-vs-content layer-swap violates "one committed goal" -> starves BOTH
USER CORRECTION: the breach is "right there, easily accessible" — NOT walled. So "no progress 60u" is a
SYMPTOM, not a cause: the arbiter LAYER-SWAPS between breach:354 and verisium:1580 ~1/s on ins fluctuation
(both NEAR), so NEITHER gets the sustained frames it needs — the breach never walks its last 60u, the
verisium is reached then swapped off before it can clear+open ("yoyo dodged, no mobs"). The intra-layer
swap (obArb.claim, mapper.js ~1570: `cur.layer===r.layer -> layer-swap`) fires on ANY sibling claim, with
zero commitment hold. This is the exact anti-yoyo the OB was built to stop — applied to preemption but NOT
to intra-layer content siblings.
Concrete log trace:
- 21:10:11.1 swap breach->verisium; 21:10:11.4 `Exp2 remnant 1580 reached -> clear mobs`
- 21:10:12.6 swap verisium->breach (verisium abandoned 1.2s after reaching it); `Breach ... no progress 60u`
- then pick=breach:354 at :25/:35/:46 interleaved — never held long enough to close 60u.
Secondary: the arbiter also re-picks breach inside its own runner skip-ban (rotBreachBlacklist set at the
`no progress -> skip`, not read by the candidate builder) — but with the swap fixed, the breach shouldn't
be hitting that skip in the first place.

## FIX A (THE fix) — content commitment hold: don't layer-swap off an active sibling
In obArb.claim's intra-layer branch (`cur.layer === r.layer`, mapper.js ~1570): a committed content item
HOLDS until it is done, failed, or genuinely stuck — the arbiter may NOT swap to a co-located content
sibling just because the sibling's ins momentarily reads lower. DENY the intra-layer swap (challenger
defers, retries next frame — the established commitment-discipline "defer, never ban") while the current
item is making progress OR engaged. Allow the swap ONLY when the current item is: (a) stuck/skip-banned by
its runner (see B), or (b) genuinely outranked by the ladder (a higher-priority LAYER, which is already the
cross-layer path, not this branch). Minimum commitment: a freshly-committed content item holds at least
`OB_CONTENT_MIN_HOLD_MS = 4000` (mirrors the navigator's NAV_MIN_DWELL) before ANY sibling swap, so ins
jitter can't thrash it. Reuse each runner's engaged signal (exp2Phase !== 'idle'/'walk', rotBreachActivatedAt
/ rotBreachId===cur.id, abyssId===cur.id). Log: `[OB] swap denied: <cur> committed (<held>ms, engaged=<b>)
vs <r>`.

## FIX B — the arbiter honors content skip-bans (secondary, for the genuinely-stuck case)
The content candidate builder (arbTick's queue scan) must EXCLUDE an entry whose runner-level skip-ban is
live: breach in `rotBreachBlacklist`, abyss in `abyssBlacklist`, verisium `exp2Done` (map each drivable
type to its existing ban set — they exist; the arbiter isn't reading them). Not a candidate until the ban
expires. Log once: `[Arb] <type>:<id> skip-banned by runner -> not a candidate (<ms>ms)`. With A, a
progressing breach won't hit its skip-ban; B stops the re-pick if it ever legitimately does.

## FIX C — genuinely-unreachable content must not block map completion
If a content item is skip-banned 3x (truly walled), mark it done/abandoned (the navigator's blocked-edge
concession pattern) so a "complete all X" map still finishes the REACHABLE content and portals. State the
bound in the report.

## Hard limits
- mapper.js only (the arbiter/obArb block + the candidate builder). Reuse the EXISTING runner ban sets and
  engaged signals — no new state machines. This is the LEGACY arbiter (objBroker), NOT the navigator —
  do not touch navigator.js. Flags: A behind `OB_CONTENT_HOLD_ON = true`, B behind
  `ARB_RUNNER_BAN_RESPECT = true`; flag-off = today's thrash (byte-parity) so the fix is isolatable.

## Acceptance
- `node --check mapper.js`; parity walk.
- Report per HOUSE_RULES + live checklist: on a map with two NEAR content items where one is unreachable —
  the reachable one is committed, ENGAGED, and COMPLETED without a swap-away; the unreachable one is
  skip-banned and not re-picked within its ban; `[OB] swap denied ... engaged` appears; no
  breach<->verisium ping-pong; the map's reachable content all completes.

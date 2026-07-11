# TASK-25 — Persist boss-locating HINTS across resume (micro-task)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-25\`. File: `..\mapper.js` ONLY.

## Evidence (C:\tmp\log.txt, Spring_ 20:41, post-reload)
Resume restored trail/bans/sweep-sites perfectly (sweep site finished 8s after inject — the system works). But the
bot then RAN BACK WEST from the boss's doorstep (~3163,307): the forward-bias had no boss bearing (zero
[FwdExplore] lines) because `bossBearingCache` / `fogBlockedAnchorX/Y(+Until)` / `bossArenaCacheX/Y` were wiped
with the goals — and its centroid fallback correctly pointed at the remaining unexplored mass, which sat behind.
Mass-logic right, boss-logic absent.

## What ships
Add to the TASK-23 sidecar (serializeMapState/applyMapState, same envelope, same flag `MAP_RESUME_ON`):
- `bossBearingCache` {x,y} + its freshness anchor (persist the REMAINING freshness, not the raw ts — or simply
  re-stamp `bossBearingAt = now` on restore with a note; pick one, say which),
- `fogBlockedAnchorX/Y` + remaining `fogBlockedAnchorUntil` window (persist as remaining-ms, restore as now+rem),
- `bossArenaCacheX/Y` (+ any paired validity flag the walker checks).
These are HINTS — pure map-local coordinates earned by exploration, no entity pointers/ids — exactly the sidecar's
state class. GOALS still never persist (no bossTgt/committed keys/state machine).
Restore order: apply BEFORE the first explore pick after resume so `_fwdExploreBearing` sees them on pass one.
Log the restored hints in the existing `[Resume]` line (`bossHints=arena|bearing|fog-anchor|none`).

## Hard limits
- mapper.js only; ~15 lines in serialize/apply + the log field. No picker/bias changes. Flag-off parity rides
  MAP_RESUME_ON (already gated).

## Acceptance
- `node --check mapper.js`.
- Report per HOUSE_RULES: reload mid-map after the boss bearing was known -> `[Resume] ... bossHints=...` shows it,
  first [FwdExplore] line uses src boss-cache/arena/fog-anchor (not centroid), explore continues TOWARD the boss.

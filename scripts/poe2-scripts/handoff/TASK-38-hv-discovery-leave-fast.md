# TASK-38 — Entity-informed HV discovery + post-complete "leave fast" (user rulings 2026-07-12 17:21 + 21:0x)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\navigator.js` into `handoff\pre\TASK-38\`. Files:
mapper.js + navigator.js (unless the STEP-0 verification shows a C++ binding is needed — then STOP after
step 0 and report; user must rebuild).
NOTE: written before TASK-39/40 landed — the NAVIGATOR now exists (navigator.js) with a purpose-built
`navAddPoi(gx, gy, kind, key)` insertion point; item C feeds THAT, not the legacy machinery.

## SECOND RULING (user, folded in): hv objects are EXPLORE anchors when nothing big is known
"Treat essences/runed monoliths similar to breaches and vaal beacons IF no breaches/vaal/abyss around —
in terms of exploration. Nothing big found -> go for the smaller things; still do the essences/shrines
opportunistically as before."
Implementation: hv objects discovered in A enter the navigator as POIs (`navAddPoi(kind:'hv')`) with a
score tier BELOW content anchors and boss belief but competitive with plain frontier regions — i.e. when
no big content and no boss belief exists, the navigator explores TOWARD known essences/monoliths instead
of blind fog. The TASK-31 hv-utility [Ckpt] servicing is unchanged (reaching one services it exactly as
today — the navigator only chooses the direction). Suggested: a K_HV_BASE below K_POI_BASE (the navigator's
scoring is one function — state the chosen constant + rationale in the report).

## The ruling
Spring_ 17:19:40 map complete with EVERYTHING done (objectives, abyss+chests, breach, essences) -> the
coverage sweep still burned ~2min cycling mass targets (17:19:53-17:21:40, repeat picks) until the user
paused. Ruling: once objectives + queued content + hv-utility are all serviced, LEAVE. Exploration after
that point is justified ONLY by evidence of un-serviced high-value objects (stone/summoning circles,
essences, and the user-ticked utility classes) — not by unexplored mass.

## STEP 0 — verify map-wide entity access (the enabler)
The C++ EntityInspector reads the FULL map entity list (awake 0x6d8 + sleeping 0x6e8 — the log line
`map-sourced entities: N`). Verify what JS can reach TODAY: does poe2.getAllEntities (or any existing
binding) return SLEEPING far entities (an essence Monolith 2000u away, unvisited)? Test-read in a live map
via a console probe if the bridge is available; otherwise a temp log probe the user can trigger. If
sleeping entities are NOT reachable from JS: STOP after documenting exactly what binding is missing
(name + which C++ list) — the planner will spec the C++ side for a user rebuild.

## A. HV registry from the map-wide list
A throttled (5-10s) pass over the map-wide list collecting UN-SERVICED hv objects into a registry:
essence Monoliths (not opened), stone-circle RuneRocks, strongboxes (not opened), shrines (not used),
+ the user-ticked utility classes (read the same settings the utility selector honors). Registry entries:
type, gridX/Y, id, firstSeen. Serviced/blacklisted keys drop out (reuse the existing blacklists/keys).
Bound: read-only pass, no per-entity component reads beyond what the list row carries (perf lens).

## B. Post-complete: HV-targeted sweep REPLACES blanket mass coverage
In the MAP_COMPLETE cleanup phase, after objectives/content/utility settle: if the registry holds
un-serviced hv entries -> drive them like cleanup content (the phase-1 coord walk from TASK-37, nearest
first, existing session caps); when the registry is EMPTY -> skip the mass coverage sweep entirely and
portal out. The COVERAGE_SWEEP mass machinery stays behind its flag for rollback but the default flow is:
hv-empty = leave. Const `HV_LEAVE_FAST_ON = true`; off = today's coverage behavior.

## C. (Same registry, pre-boss bonus — only if trivially cheap) known-from-start content
If STEP 0 shows sleeping entities readable: feed essence Monoliths/strongboxes into the EXISTING content
machinery at map start (the hv-utility [Ckpt] insertion + arbiter budgets already handle routing) so the
"you can see it from spawn" essences get done during natural traversal, not at the end. If this needs more
than plumbing the registry into the existing feeds, defer it to its own task — say so in the report.

## Hard limits
- Reuse: TASK-37's phase-1 walk, existing blacklists/session caps, the utility settings reads. No new
  movement mechanisms, no OB ladder changes. Flag-off parity. The registry pass must be cheap (throttled,
  no uncapped per-entity reads) — the perf lens rule stands.

## Acceptance
- `node --check`; parity walks.
- Report per HOUSE_RULES + live checklist: a fully-cleared map portals out within ~15s of the last hv
  service (no mass-coverage cycling); a map with a far unvisited essence walks to it post-complete and
  services it, THEN leaves; step-0 findings documented either way.

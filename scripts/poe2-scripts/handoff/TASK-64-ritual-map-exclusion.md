# TASK-64 — Exclude Ritual-rolled maps at ATLAS SELECTION (content-based ban, like EXCLUDED_MAP_NAMES but read from the node)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-64\`. USE OPUS 4.8.
BRIDGE: single-client pipe — make sure no other Claude session holds it; probes below need it + the user
parked at the ATLAS (hideout, atlas open) with at least one Ritual-rolled node visible.

## Evidence + user ruling (SteamingSprings 2026-07-14 ~09:00)
Main objectives: "Defeat Manassa..." + **"Complete all Ritual Altars"** — the bot has NO ritual handler
(getMapObjectives live-read: Ritual done:false, unfinishable). USER: "we need to EXCLUDE RITUAL MAPS using
atlas explorer... this map is clear all rituals and we dont have that yet." Same class as the existing
EXCLUDED_MAP_NAMES ban (see the banned-maps symbol in mapper.js), but keyed on the node's ROLLED CONTENT,
not its name — ritual is a roll, not a map identity.

## Phase A — prove the read (bridge, user parked at the atlas)
Rolled content IS atlas-visible (rolled-content-nodes memory: content nodes are atlas-only/dormant in-map).
Find where "Ritual" is readable per node, in order of promise:
1. `poe2.getAtlasNodes()` — dump one Ritual-rolled node vs a non-ritual neighbor; diff ALL fields. The
   content icons the user sees on hover exist SOMEWHERE on the node/UI.
2. The node's DAT row (node+0x300 readspec) is name/boss/mods — rolled content is NOT DAT; if getAtlasNodes
   lacks it, look at the node's content-icon list the atlas hover panel renders (same icon-store family as
   getMinimapIcons? probe whether the atlas screen has an equivalent descriptor vector).
3. STATID DRIFT WARNING (atlas-statid-drift memory): if the read goes through stats, resolve by id STRING,
   NEVER by row number — rows shift every patch.
GATE: if the read needs a new C++ binding, STOP after Phase A and report the shape (cpp-commit-discipline).

## Phase B — wire the exclusion (mapper.js only, flag `EXCLUDED_MAP_CONTENT_ON = true`)
- `EXCLUDED_MAP_CONTENT = ['Ritual']` (extensible list; content-name match, case-insensitive).
- In the atlas map-selection filter (same place EXCLUDED_MAP_NAMES is consulted): a candidate node rolling
  any excluded content is skipped with `[Atlas] node <name> skipped: rolls Ritual` (throttled).
- STARVATION GUARD: if exclusion empties the candidate set, log `[Atlas] all candidates roll excluded
  content -> picking least-bad anyway` and proceed un-filtered — never brick map selection.
- Flag off = today, byte-parity. node --check. TEST BEFORE COMMIT.

## Acceptance
Live: a Ritual-rolled node visibly skipped in the selection log; a normal node selected + run; no selection
starvation. Report handoff\TASK-64-REPORT.md: Phase A field/offset table, the exact read chain, symbols.

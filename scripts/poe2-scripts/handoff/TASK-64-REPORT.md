# TASK-64 REPORT — Exclude Ritual-rolled maps at atlas selection (rolled-content ban)

Implementer: Opus 4.8. Files edited: `mapper.js` (runtime dir only). No C++, no repo, no commit.
Pre-snapshot: `handoff/pre/TASK-64/mapper.js` (copied before any edit).

## Phase A — the read (PROVEN LIVE, no new binding needed → gate passed)

The user's atlas inspector already prints `Content (base-game, at rest): Mechanics: Ritual` for
Hidden Grotto. Found its source in `atlas_plugin.js` (`readContentTraits` / `readMechanics`) and
reused the exact primitives — the same ones `atlasNodeHasDelirium` in mapper.js already uses. Read is
pure JS over `poe2.getAtlasNodes()` + `poe2.readMemory`; **no new C++ binding**, so I proceeded to Phase B.

### Field / offset table (atlas EndgameMapPin `node = atlas.nodes[i].address`)
| what | offset | shape | notes |
|---|---|---|---|
| Channel A begin/end | `node+0x368` / `node+0x370` | `vector<uint8>` | each byte = **EndgameMapContent.dat** row idx |
| Channel B begin/end | `node+0x350` / `node+0x358` | `{u16 statId, u16 weight}` (4B stride) | statId = 1-based **Stats.dat** row |

### The read chain used for Ritual
**Ritual lives in Channel B, statId `26739`** (`map_atlas_node_has_ritual`, weight always 64). This
contradicts the memory readspec's guess ("Ritual = Channel A idx 4"): live, **every** Ritual node
carried 26739 in B with an **empty** Channel A (Ritual behaves like Delirium — Channel-B-only). Two
independent live probes over the full 641-node atlas confirmed it and cross-validated the statId band
against the user's own screenshots:
- **Hidden Grotto** (idx 19) & **Backwash** (idx 5/20/46) → `26739` = the "Mechanics: Ritual" popup ✓
- **Slick** (the Delirium map) → `26737`+`26714` (delirium+fog), **not** 26739 ✓
- Powerful-Boss nodes → `19545` **and** the Channel-A `PowerfulMapBoss` byte ⇒ the statId band is
  **not shifted** in the current patch ✓

The read maps both channels to content-name strings and matches against an exclusion list, so it is
extensible and covers content that lives in either channel.

## Phase B — the exclusion (mapper.js)

All additions sit inside/next to the existing atlas-node filter (`getAtlasNodeFilterDecision` /
`findFirstUncompletedNode`), mirroring the shipped `atlasNodeHasDelirium` / `atlasNodeIsLogbook` bans.

### Symbols added (searchable)
- `EXCLUDED_MAP_CONTENT_ON` (const, **true**) — kill-switch. Off/absent = today's control flow, byte-parity.
- `EXCLUDED_MAP_CONTENT = ['Ritual']` — content-name list, case-insensitive, extensible.
- `EXCLUDED_MAP_CONTENT_SET` — lowercased Set for membership.
- `ENDGAME_MAP_CONTENT` — 66-row Channel-A index→id table (duplicated from `atlas_plugin.js`).
- `MAP_CONTENT_STATS` — Channel-B statId→name {19545 Boss, 26737 Delirium, 26738 Abyss, **26739 Ritual**, 26740 Incursion, 26741 Breach}.
- `atlasNodeContentNames(node)` — union of rolled content names from both channels; `[]` on any unreadable node.
- `atlasNodeHasExcludedContent(node)` — true if any rolled name ∈ EXCLUDED_MAP_CONTENT.
- `excludedContentBlockedLastLogged` — log-on-change state (drift tell).

### Wiring
- `getAtlasNodeFilterDecision(node, opts)` — new **last** rule (after every name/type ban, so those
  keep the reason): returns `{blocked:true, reason:'excluded-map-content'}`. Gated by the flag and by
  `!opts.skipContent`.
- `findFirstUncompletedNode()` — counts `excludedContentBlocked`; logs the count on-change; **starvation
  guard**: if the content ban emptied the candidate set, re-picks with `{skipContent:true}` (hard bans
  still apply) and logs the least-bad line. Blacklist-clear retry left unchanged.

### Settings
| name | default | flips |
|---|---|---|
| `EXCLUDED_MAP_CONTENT_ON` | `true` | set `false` = feature off, byte-identical to pre-task |
| `EXCLUDED_MAP_CONTENT` | `['Ritual', 'Delirium']` | add content names (e.g. `'Vaal Beacon'`, `'Abyss'`) to extend the ban |

**Delirium hard-ban (added per user directive "make sure we aren't doing rituals/deliriums"):**
`'Delirium'` is in the list as a GUARANTEED exclusion independent of the `runDeliriumMaps` setting.
Interaction: with `runDeliriumMaps` off (default), the dedicated delirium filter (reason `'delirium'`)
fires first; with it on, the content ban (reason `'excluded-map-content'`) is the backstop — so delirium
is excluded either way. `runDeliriumMaps` is therefore effectively superseded (to re-enable delirium,
remove `'Delirium'` from `EXCLUDED_MAP_CONTENT` AND set the toggle). Delirium is matched via Channel-B
stat 26737, which covers both the Mirror and the fog nodes (fog ⊂ mirror).

### Mechanic ENUM reference (for the orchestrator) — statId → label → in-game "Area contains …"
Channel-B rolled mechanics, `node+0x350`(begin)/`+0x358`(end), 4-byte `{u16 statId, u16 weight}`.
statIds are **Stats.dat row numbers that drift per patch** — resolve by the id STRING, never trust the
number blindly (memory `poe2-atlas-statid-drift`). Live-validated 2026-07-14 (atlas ~2528 pins).

| statId | Stats.dat id | label (`MAP_CONTENT_STATS`) | in-game "Area contains" | live count |
|---|---|---|---|---|
| 19545 | `map_contains_powerful_map_boss` | PowerfulMapBoss | a Powerful Map Boss | 97 |
| 26737 | `map_atlas_node_has_delirium` | Delirium | a Mirror of Delirium (+fog%) | 21 |
| 26738 | `map_atlas_node_has_abyss` | Abyss | an Abyss | 44 |
| 26739 | `map_atlas_node_has_ritual` | Ritual | Ritual Altars | 16 |
| 26740 | `map_atlas_node_has_incursion` | **Vaal Beacon** | **Vaal Beacons** | 48 |
| 26741 | `map_atlas_node_has_breach` | Breach | Breaches | 19 |

⚠ **26740 gotcha:** internal id says `incursion`, but the game displays "Vaal Beacons" (ground-truth:
Sun Temple popup; its maps are Vaal-themed — Vaal City, Sun Temple, Bazaar). Same table lives in
`atlas_plugin.js` (`MECHANIC_STATS`) and `mapper.js` (`MAP_CONTENT_STATS`) — a re-derive updates BOTH.
The ubiquitous stat 26103 (~most nodes) is NOT a content mechanic; ignore it.

Explorer companion (atlas_plugin.js, display/debug only — no bot behavior): "Area contains …" line,
per-mechanic list tags/colors, content filter + one-click buttons (Ritual/Breach/Abyss/Vaal Beacon/
Delirium). Reads the same channels; user-validated 2026-07-14.

## LIVE-TEST CHECKLIST (user, parked at the atlas / running maps)
- **Working:** on atlas selection you see `[Atlas] Content filter: N node(s) blocked (rolls Ritual)`;
  a **non-Ritual** node is selected and run; Ritual maps (e.g. Hidden Grotto, Backwash, Slick-with-ritual)
  are never entered. (Live dry-run at report time: 42 considered → 4 Ritual blocked → 38 clean → picked a clean node, no starvation.)
- **Starvation path (rare):** if literally every available node rolls Ritual, expect
  `[Atlas] all candidates roll excluded content -> picking least-bad anyway` and a map still starts —
  it must never hang with no pick.
- **Broken / drift tell:** a known-Ritual atlas that logs `0 node(s) blocked` = the statId row moved on
  a patch → re-derive `26739` (see the code comment + memory `poe2-atlas-statid-drift`), don't assume the code is wrong.
- **Flag-off parity:** set `EXCLUDED_MAP_CONTENT_ON = false` → selection identical to before this task.

## Risks / deviations from the brief
1. **Channel B, not the "content-name-in-Channel-A" the brief assumed.** Live truth: Ritual is a
   Stats.dat flag (26739), so this ban carries the **same statId-drift risk as the existing Delirium
   ban** and cannot be resolved by id-string at runtime (no binding — same constraint delirium accepted).
   Mitigated with the drift-tell log + a comment; cross-validated live vs the user's screenshots.
2. **Skip log is a count-on-change line, not per-node `node <name> skipped: rolls Ritual`.** Chose the
   sibling Delirium pattern to honor HOUSE_RULES rule 5 (no spam — 45 ritual nodes/pass would flood).
   The count line still proves the ban fired and doubles as the drift tell.
3. Both channels are read (not just B) so the list is genuinely extensible (Channel-A contents like
   Irradiated/Simulacrum work if added). Cost is selection-time only (not per-frame), same order as the
   delirium read already paid per node.

## Open questions
- None blocking. Future: if you want other rolls banned (Abyss/Incursion/Breach are already in the
  statId map; Channel-A contents resolve via the 66-row table), just add the name to `EXCLUDED_MAP_CONTENT`.

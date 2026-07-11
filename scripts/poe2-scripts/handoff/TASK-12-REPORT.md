# TASK-12 REPORT — Essences skipped altogether: investigate-then-fix

## TL;DR
Investigated with **live bridge reads on a real unopened essence** (player walked to one; probed before/after a
manual click). The task brief's 4 hypotheses were built on the codebase's model that "essence = the Monolith object
the opener clicks." **That model is actually correct** — so H1/H3/H4 are FALSE and **H2 (no walk path) is TRUE**, but
with a sharper root cause than the brief guessed: the essence's clickable object is the **lowest-priority utility
openable (22, no selection bonus)**, so a co-located pack-loot drop (+20) or shrine (+16) always steals the committed
walk and **the object is never reached to be clicked open**. The imprisoned rare is correctly skipped (it is
**invulnerable until the object is clicked**).

Fix = give the real essence object a selection bias so it wins the committed walk + user-directed click cadence +
the mandated throttled skip/trace logs. `entity_actions.js` was **NOT** touched (the skip is correct).

---

## Which hypothesis was TRUE — live-read evidence

Live probe of a real unopened essence (area "Gallows"-family map, player Blackicepee). The essence in this build is
an **imprisoned rare monster** ("Pack Werewolf") + a **co-located clickable object** (`MiscellaneousObjects/Monolith`).

| probe | essence object (id 716) | imprisoned rare (id 729) |
|---|---|---|
| `name` | `Metadata/MiscellaneousObjects/Monolith` | `Monsters/Werewolves/WerewolfPack1@79` |
| `renderName` | *(empty)* | `Pack Werewolf` |
| `rarity` / type | Renderable | **2 (rare)** / Monster |
| `isTargetable` (unopened) | **true** | true |
| `isObjectiveDone` | false | false |
| position | (595, 1062) | (595, 1062) — **dist 0** |
| in opener's 128-cap `getEntities` feed | **yes** | — |
| `isEssenceEntity()` match | **yes** (`/miscellaneousobjects/monolith`) | — |
| AFTER one manual click | **GONE (consumed/de-streamed)** | GONE (released → user 1-shot it) |

**Confirmed mechanic (user + probe):** click the object **≥3×** (retries because mid-fight interact packets get
interrupted/dropped) → object is **consumed/removed** → the rare is **released** → **kill the released rare** →
essences drop. The rare is invulnerable while imprisoned, so skipping it pre-release is correct.

| Hyp | Verdict | Evidence |
|---|---|---|
| H1 LoF/visibility gate (shrine class) | **FALSE** | Walk feed `getOpenableCandidatesForMapper`→`collectOpenTargets(allowBlockedVisibility=true)` already bypasses the essence LoF gate; opener click path already exempts essences from the walkable-LoS gate. Live: object `isTargetable=true`, in the 128-cap feed. |
| **H2 No walk path** | **TRUE** | The object's only approach vector is the utility openable walk (imprisoned-rare skip removed the combat approach). It enters the feed correctly but is the **lowest-priority openable (22, no bonus)** vs shrine (26+16) and loot (18+20), so the pack's on-the-spot loot/shrine always steals the committed walk → object never reached → never clicked → "skipped altogether." |
| H3 40u reach mismatch | **FALSE** | Utility arrives ≤20u; opener clicks essences ≤40u and scans ≤`maxDistance`(36–49u). 20 < 40 < 49 → once reached, it clicks. |
| H4 Name/exclusion drift | **FALSE** | `isEssenceEntity` matches the live object name; `excludeChestNames="Royal Trove, Atziri's Vault"` doesn't match; `openEssences=true`, `walkToOpenablesEnabled=true` for the active mappers (live settings.json). |

Corroborating: the user ran a **separate live shrine test with opener+mapper on → "Shrine opening OK."** That proves
the walk→open pipeline works; the essence-only failure is the essence-only ranking deficiency above.

---

## Files touched + symbols

### `opener.js`
- **Essence click cadence (USER-DIRECTED, live)** — `ESSENCE_RETRY_DELAY_MS` 400→**250**, `ESSENCE_MAX_ATTEMPTS`
  6→**9**, `ESSENCE_CLAIM_MS` 350→**200** (must stay < retry). Reason the user gave: needs ≥3 lands and retries
  because a mid-fight interact can be interrupted; stop-on-consumed prevents overspam (an opened/de-streamed object
  drops out of `collectOpenTargets`). **This adjusts TASK-09 cadence numbers — see Deviations.**
- **`logEssenceSkip(entity, reason)`** + `_essenceSkipLogAt` throttle (5s). Mandated skip-log, mirrors the mapper's
  shrine skip-log. Fires in `collectOpenTargets`' Essence bucket when an essence is dropped by:
  `untargetable (opened or guarded)` / `no Targetable component` / `name-excluded` / `LoF-blocked at Nu (>40u)`.

### `mapper.js`
- **`selectBestUtilityCandidate`** — new `isEssence`/`essenceBonus` (**+24**). Scoped to the *real* essence object
  (`meta.openableType==='Essence'` AND NOT `runerock|runed monolith|stonecircle`). Effective score 22+24=46 now
  beats co-located loot (38) and shrine (42) → essence wins the committed walk. **The reachability fix.**
- **`getOpenableUtilityCandidates`** — throttled diagnostic `[Utility] essence object (<name>) d=<n> -> committing walk`
  / `-- IGNORED (utility blacklist)` (key `util:ess:cand`, 3s). Scoped to the real essence object (excludes Runed
  Monoliths). Confirms the object reached the mapper feed and whether the blacklist is hiding it.

### `entity_actions.js` — **NOT edited by TASK-12.** (See Concurrent-edit note.)

No base `c.priority` change (verified `c.priority` is read only in the selection score, so a selection-only bias is
sufficient and doesn't perturb the Runed-Monolith path).

## Settings added
**None** (per brief: "No new settings"). All changes are unconditional fixes; there is no flag-off variant.

---

## LIVE-TEST CHECKLIST
Run a map with an essence (imprisoned rare + its clickable object), opener + mapper ON.

**WORKING looks like:**
1. `[Utility] essence object (Monolith) d=<dist> -> committing walk` (object reached the mapper feed)
2. `[Utility] select: openable (Monolith) d=<dist>` (it won selection — the fix)
3. bot walks up and stands on it; `[Opener] Opened Essence: Monolith ...` **repeats a few times ~250ms apart**, then stops
4. the released rare is then **attacked and killed** (auto-attack; the object is gone so `isEssenceImprisoned` no longer skips it), essences drop and pickit grabs them

**BROKEN looks like (and what it means):**
- No `[Utility] essence object ...` line at all → object dropped by the opener bucket → look for `[Opener] essence
  skip (<name>): <reason>` (untargetable / name-excluded / LoF). That names the residual gate.
- `[Utility] essence object ... -> committing walk` fires but no `[Utility] select` → still losing selection to
  something (raise `essenceBonus`), OR `Utility skip: openable -> live abyss/verisium objective` (co-located
  objective wins) OR a boss-approach distance cap.
- `[Utility] select` fires but bot doesn't move / `Utility paused (movement broker)` → movement-broker starvation by
  the dangerous imprisoned rare (Periodic Cold Explosions etc.) keeping dodge/fight armed — that would be the next
  fix (not reproduced live this session; see Open Questions).
- `... -- IGNORED (utility blacklist)` → it was banned earlier (timeout/no-progress); check why it timed out.

---

## Risks / Deviations from brief
1. **Cadence numbers changed (250/9/200) — brief said "do not touch TASK-09 cadence."** Overridden by the **user's
   explicit live instruction** ("interact ~3–9× at 250ms until opened … because mid-fight the interact gets
   interrupted"). Dwell/ceiling numbers were **not** touched. Flagging for the planner since it crosses the brief's
   guard.
2. **The fix is scoped to the real essence object and deliberately excludes the Runed Monolith** (`renderName "Runed
   Monolith"`, StoneCircle) — which the user clarified is a **separate mechanic** (3 stones, 1 click each, all 3 →
   unique spawn) and the **next task**. So essence changes won't perturb that flow.
3. **Root cause is code-verified (lowest-priority openable) but the exact runtime "no walk" instance was not
   reproduced by the bot** — the essence was consumed during the manual live investigation. The diagnostic logs are
   in place so the next live map names any residual gate itself (per brief).

## Concurrent-edit note (IMPORTANT for the planner)
`diff handoff/pre/TASK-12/entity_actions.js entity_actions.js` shows **`[BossDiag]` / boss-invuln-ban changes that
are NOT from TASK-12** — they appeared in the runtime file after my 07:55 pre-snapshot, i.e. a **concurrent session**
is editing `entity_actions.js` (boss damageability investigation). **User-confirmed acceptable ("another session,
all good").** TASK-12 made **zero** edits to that file. Do not attribute those lines to this task.

## Open questions / observations (not fixed — for planner + the next monolith task)
- **Latent dwell-classification quirk** (`runUtilityNavigationStep`): `_nm` reads `utilityActiveTarget.name/.path/
  .openableType/.metaName`, all of which are `undefined` for opener candidates (the name lives at `.meta.name`), so
  `_nm=''` and the essence-dwell branch (`isEssence`, 6000ms ceiling / 3-touch) **never triggers**. It's currently
  benign only because `_isMonolith` (which *does* read `meta.name`='Monolith') routes the essence into the "Runed
  Monolith stand-5s" dwell, which happens to hold long enough for the opener's ≤9×250ms clicks. This conflates the
  essence with the Runed-Monolith mechanic and should be cleaned up when the **Runed Monolith task** lands.
- **`isEssenceEntity` classifies BOTH the essence object AND Runed Monoliths as type 'Essence'** (renderName "Runed
  Monolith" contains "monolith"). The opener distinguishes them via a RuneRock name check (20u gate); the mapper
  selection/trace changes here exclude Runed Monoliths explicitly. The next task will want a clean split.
- **User note carried to next task:** the Runed Monolith may also need >1 click per stone on interrupt (same
  mid-fight reasoning as essences).
- **Generic interrupt-retry (user):** the "retry the interact if it got interrupted mid-fight" behavior should be a
  **generic opener** property for ALL openables (currently the fast multi-click retry is essence-only via
  `ESSENCE_*`; other types use `OPEN_RETRY_DELAY_MS=2500`/`OPEN_MAX_ATTEMPTS=3`). Essences additionally need >1
  *successful* click (multi-layer). Suggest a follow-up that adds interrupt-aware retry to the generic path (a click
  that didn't land — target still targetable and we're in range — retries fast; distinct from the anti-repeat ban).

## Acceptance
- `node --check opener.js` ✓ / `node --check mapper.js` ✓
- New symbols grepped: `logEssenceSkip`, `_essenceSkipLogAt`, `essenceBonus`, `_isRealEssence`, `util:ess:cand`,
  cadence constants (250/9/200) ✓
- `entity_actions.js` unchanged by this task ✓

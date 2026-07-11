/**
 * Opener Plugin
 * 
 * Automatically opens nearby chests (and later doors/objects) when within range.
 * Uses shared POE2Cache for per-frame caching.
 * Settings are persisted per player.
 * 
 * PERFORMANCE OPTIMIZED: Uses shared POE2Cache for per-frame caching
 * NOTE: Do NOT call POE2Cache.beginFrame() here - it's called once in main.js
 */

import { POE2Cache, poe2 } from './poe2_cache.js';
import { Settings } from './Settings.js';

// Plugin name for settings
const PLUGIN_NAME = 'opener';

// Default settings
const DEFAULT_SETTINGS = {
  enabled: false,              // Auto-open disabled by default (user must opt-in)
  maxDistance: 80,             // Max distance to auto-open
  openCooldownMs: 300,         // Cooldown between open attempts (ms)
  visibilityMode: 1,           // 0=Off, 1=Line of Fire, 2=Walkable LoS
  openStrongboxes: false,      // Don't auto-open strongboxes by default (dangerous!)
  openNormalChests: true,      // Open normal chests
  openEssences: true,          // Open essence monoliths
  openShrines: true,           // Open shrines (default ON)
  openDoors: true,             // Open doors (default ON)
  openPrecursorRelay: true,    // Click the Precursor Relay (Atlas Points console) -- default ON
  excludeChestNames: "Royal Trove, Atziri's Vault",  // Exclude these chests by name
  showLastOpened: true         // Show last opened chest info
};

// Current settings (will be loaded from file)
let currentSettings = { ...DEFAULT_SETTINGS };
let currentPlayerName = null;
let settingsLoaded = false;

// Settings - using MutableVariable for ImGui bindings
const enabled = new ImGui.MutableVariable(DEFAULT_SETTINGS.enabled);
const maxDistance = new ImGui.MutableVariable(DEFAULT_SETTINGS.maxDistance);
const openCooldownMs = new ImGui.MutableVariable(DEFAULT_SETTINGS.openCooldownMs);
const visibilityMode = new ImGui.MutableVariable(DEFAULT_SETTINGS.visibilityMode);
const openStrongboxes = new ImGui.MutableVariable(DEFAULT_SETTINGS.openStrongboxes);
const openNormalChests = new ImGui.MutableVariable(DEFAULT_SETTINGS.openNormalChests);
const openEssences = new ImGui.MutableVariable(DEFAULT_SETTINGS.openEssences);
const openShrines = new ImGui.MutableVariable(DEFAULT_SETTINGS.openShrines);
const openDoors = new ImGui.MutableVariable(DEFAULT_SETTINGS.openDoors);
const openPrecursorRelay = new ImGui.MutableVariable(DEFAULT_SETTINGS.openPrecursorRelay);
const excludeChestNames = new ImGui.MutableVariable(DEFAULT_SETTINGS.excludeChestNames);
const showLastOpened = new ImGui.MutableVariable(DEFAULT_SETTINGS.showLastOpened);

// Auto-open state
let lastOpenTime = 0;
let lastOpenedChestName = "";
let lastOpenedChestId = 0;
let lastOpenedChestDistance = 0;
const visibilityCache = new Map();  // key -> { result, timestamp }
const VISIBILITY_CACHE_TTL = 500;
const doorSkipUntil = new Map(); // key -> timestamp ms

// General anti-repeat blacklist for EVERY opener target type (mirrors pickit's
// pickupAttempts). Doors keep their own smart pre-skip above; this is the universal
// backstop. After OPEN_MAX_ATTEMPTS opens that didn't make a target go away (chest ->
// opened / shrine|essence -> non-targetable), the target is banned so the opener AND the
// mapper stop hammering it -- e.g. StoneCircle runes that never consume on a plain
// interact. Keyed by position+name so it survives entity-id slab recycle.
const openBlacklist = new Map(); // key -> { attempts, lastAttemptTime, banned, until }
const OPEN_RETRY_DELAY_MS = 2500; // min gap between attempts on the same target
const OPEN_MAX_ATTEMPTS = 3;      // attempts before a long ban
const OPEN_BAN_MS = 600000;       // 10 min: effectively the rest of the map
// An essence object needs AT LEAST 3 interacts to open (each click breaks one layer). Keep clicking at
// ESSENCE_RETRY_DELAY_MS and STOP the instant it's consumed -- an opened/de-streamed object drops out of
// collectOpenTargets (isTargetable flips false / entity gone), so the cap is only a backstop for a stuck object.
const ESSENCE_RETRY_DELAY_MS = 250;  // gap between clicks on the same essence object
const ESSENCE_MAX_ATTEMPTS = 15;     // >= the ~3 layers, extra headroom at the 100ms in-range cadence for missed/late sends before a fair ban
// A RuneRock (StoneCircle "Runed Monolith") is NOT a multi-layer essence: a LIVE one consumes in ONE click; a spent /
// already-used rune re-streams clickable (isTargetable true) but never consumes. So cap it at 3 (not the 9-layer
// essence budget) -> we stop hammering a dead rune fast instead of burning ~7s of clicks on it. Fast cadence kept.
const RUNEROCK_MAX_ATTEMPTS = 3;
const ESSENCE_CLAIM_MS = 200;        // MUST stay < ESSENCE_RETRY_DELAY_MS: processAutoOpen returns on ANY live claim,
                                     // including our own, so a longer claim -- not the retry gap -- sets the real cadence
// USER: within opener reach (~40u) HAMMER the multi-click open at ~100ms/tick -- a fast retry gap + a short own-claim
// so the next layer's click fires immediately once we're standing on it. Farther out keep the slower gap so a far
// auto-walk fire doesn't burn the attempt cap. Claim MUST stay < the retry gap (else the own-claim self-blocks).
const ESSENCE_FAST_RANGE = 40;       // <= this (opener reach) uses the in-range cadence
const ESSENCE_RETRY_FAST_MS = 200;   // click gap within ESSENCE_FAST_RANGE (user: 100ms fired wasted interacts between the ~800ms real clicks)
const ESSENCE_CLAIM_FAST_MS = 150;   // own-claim within range (< ESSENCE_RETRY_FAST_MS so it never self-blocks the next click)
// INTERRUPT-AWARE RETRY (generic, NON-essence): a click that never LANDS -- fired mid-fight, movement cancelled the
// interact, the server ate it -- used to burn one of the OPEN_MAX_ATTEMPTS toward the 10-min ban. A send now COUNTS
// as a real attempt only when it had a FAIR WINDOW (target in range + no non-opener movement lock stealing the
// interact). An unfair send is a FREE retry: it re-fires fast (OPEN_LAND_CHECK_MS instead of the 2.5s anti-repeat
// gap) and does NOT count, capped at OPEN_FREE_RETRIES per target -- after which normal accounting resumes so a
// genuinely stuck target still bans. Essences are EXEMPT (their own faster multi-click lane already owns them).
const OPEN_LAND_CHECK_MS = 600;   // re-fire gap while a target still has free retries (the fast lane)
const OPEN_FREE_RETRIES = 2;      // non-counting re-sends per target before the ban cap starts accruing
const OPEN_FAIR_RANGE = 30;       // <= this counts as "in range" for the fair-window test (an interact this close lands without a long auto-walk)
// UNFAIR-SEND HOLD (non-essence): a send beyond OPEN_FAIR_RANGE while a NON-opener movement lock/walk owns the
// character can never land -- the character is being driven elsewhere, so the interact's auto-walk is stomped -- and
// it only burns free-retries then real attempts toward a 10-min ban (live: shrine 45.3u/38.1u whiffed while the
// mapper walked to a breach mob, leaving it unopened + on its way to banned). HELD sends fire nothing, charge
// nothing, and stay candidates; they re-fire for real once the character is in range (<= OPEN_FAIR_RANGE) or
// movement is free. Reuses the exact _fairWindow read from the markOpenAttempt call site.
const OPEN_UNFAIR_HOLD_ON = true; // flag-off = byte-identical send path (parity); gates BOTH the hold and commit-to-click
// COMMIT-TO-CLICK (rides the same OPEN_UNFAIR_HOLD_ON gate): when the hold would fire on a non-essence target within
// OPEN_COMMIT_RANGE and the mapper says it's safe (POE2Cache.commitClickSafe -- not dodging, not a boss walk-in/fight),
// claim our OWN movement lock for OPEN_COMMIT_MS and fire once. The mapper's existing yield IS the stop (it stops
// re-driving its walk); the interact's auto-walk carries the character into range for the window. One commit per
// target per the 2.5s anti-repeat gap (openCommitAt); a mid-commit dodge flips commitClickSafe false + steals movement,
// so the send just doesn't land = a free retry. No new stop packets, no MB bypass.
const OPEN_COMMIT_MS = 800;       // movement-lock window granted to the commit's auto-walk (< the 2000ms open dwell -> release fast if it didn't land)
const OPEN_COMMIT_RANGE = 50;     // only commit-walk a held target this close (get-closer-and-commit; farther stays held)
const openCommitAt = new Map();   // getOpenKey -> last commit ts (enforces the per-target 2.5s commit gap, OPEN_RETRY_DELAY_MS)
// ABYSS CHEST range gate: a drive-by interact sent while the mapper owns movement never lands beyond ~25u (live:
// one clean open at 24.4u; 32.9u+ all whiffed with distance INCREASING) -- it only burns the free-retry/attempt
// budget toward a 10-min ban the sweep then can't crack. Candidates keep flowing (collect path untouched); only
// the SEND is gated. clearOpenBansNear lifts already-burned bans once the sweep is standing at the site.
const OPENER_ABYSS_RANGE_ON = true;   // kill-switch: false = send at any range + clearOpenBansNear no-ops (parity)
const ABYSS_CHEST_SEND_RANGE = 25;    // max distance an /abysschest/i interact may be sent from
let lastBlacklistPrune = 0;

// Throttled diagnostic: an essence object is seen but a filter drops it before it can be a target. Mirrors the
// mapper's shrine skip-log so the next live map names any residual essence skip itself.
let _essenceSkipLogAt = 0;
function logEssenceSkip(entity, reason) {
  const now = Date.now();
  if (now - _essenceSkipLogAt < 5000) return;
  _essenceSkipLogAt = now;
  const nm = ((entity && (entity.renderName || entity.name)) || 'essence').split('/').pop();
  console.log(`[Opener] essence skip (${nm}): ${reason}`);
}

// Scan throttle + cached result (perf):
// processAutoOpen used to run a full collectOpenTargets() every frame whenever
// the open-cooldown had elapsed, which meant 60Hz scans in empty rooms (the
// cooldown only advances on a SUCCESSFUL open). lastScanTime floors scan
// frequency at min(openCooldownMs, 150ms). cachedScanTargets/cachedScanFrame
// let the UI "Targets in range: N" label reuse the same scan result instead
// of running collectOpenTargets a second time per frame.
let lastScanTime = 0;
let cachedScanTargets = [];
let cachedScanFrame = -1;

const VISIBILITY_MODE = {
  OFF: 0,
  LINE_OF_FIRE: 1,
  LINE_OF_SIGHT: 2
};

/**
 * Load settings for the current player
 */
function loadPlayerSettings() {
  const player = POE2Cache.getLocalPlayer();
  if (!player || !player.playerName) {
    return false;
  }
  
  // Check if player changed
  if (currentPlayerName !== player.playerName) {
    currentPlayerName = player.playerName;
    currentSettings = Settings.get(PLUGIN_NAME, DEFAULT_SETTINGS);
    
    // Apply loaded settings to MutableVariables
    enabled.value = currentSettings.enabled;
    maxDistance.value = currentSettings.maxDistance;
    openCooldownMs.value = currentSettings.openCooldownMs;
    visibilityMode.value = (typeof currentSettings.visibilityMode === 'number')
      ? currentSettings.visibilityMode
      : DEFAULT_SETTINGS.visibilityMode;
    openStrongboxes.value = currentSettings.openStrongboxes;
    openNormalChests.value = currentSettings.openNormalChests;
    openEssences.value = currentSettings.openEssences !== undefined ? currentSettings.openEssences : DEFAULT_SETTINGS.openEssences;
    openShrines.value = currentSettings.openShrines;
    openDoors.value = currentSettings.openDoors !== undefined ? currentSettings.openDoors : DEFAULT_SETTINGS.openDoors;
    openPrecursorRelay.value = currentSettings.openPrecursorRelay !== undefined ? currentSettings.openPrecursorRelay : DEFAULT_SETTINGS.openPrecursorRelay;
    excludeChestNames.value = currentSettings.excludeChestNames;
    showLastOpened.value = currentSettings.showLastOpened;
    
    console.log(`[Opener] Loaded settings for player: ${player.playerName}`);
    settingsLoaded = true;
    return true;
  }
  return false;
}

/**
 * Save a single setting
 */
function saveSetting(key, value) {
  currentSettings[key] = value;
  Settings.set(PLUGIN_NAME, key, value);
}

/**
 * Save all current settings
 */
function saveAllSettings() {
  currentSettings.enabled = enabled.value;
  currentSettings.maxDistance = maxDistance.value;
  currentSettings.openCooldownMs = openCooldownMs.value;
  currentSettings.visibilityMode = visibilityMode.value;
  currentSettings.openStrongboxes = openStrongboxes.value;
  currentSettings.openNormalChests = openNormalChests.value;
  currentSettings.openEssences = openEssences.value;
  currentSettings.openShrines = openShrines.value;
  currentSettings.openDoors = openDoors.value;
  currentSettings.openPrecursorRelay = openPrecursorRelay.value;
  currentSettings.excludeChestNames = excludeChestNames.value;
  currentSettings.showLastOpened = showLastOpened.value;
  
  Settings.setMultiple(PLUGIN_NAME, currentSettings);
}

/**
 * Check if chest/object name is excluded
 */
function isExcludedByName(entity) {
  if (!excludeChestNames.value || excludeChestNames.value.trim().length === 0) {
    return false;
  }
  
  // Get render name (human-readable name)
  const renderName = (entity.renderName || "").toLowerCase();
  if (!renderName) return false;
  
  // Parse exclusion list (comma-separated)
  const excludes = excludeChestNames.value.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
  
  // Check if render name contains any excluded name
  for (const exclude of excludes) {
    if (renderName.includes(exclude)) {
      return true;
    }
  }
  
  return false;
}

function isDoorEntity(entity) {
  const name = (entity.name || "").toLowerCase();
  const renderName = (entity.renderName || "").toLowerCase();
  return name.includes('door') || renderName.includes('door');
}

function getDoorKey(entity) {
  if (!entity) return '';
  if (entity.id && entity.id !== 0) return `id:${entity.id}`;
  const gx = Number.isFinite(entity.gridX) ? Math.floor(entity.gridX) : 0;
  const gy = Number.isFinite(entity.gridY) ? Math.floor(entity.gridY) : 0;
  return `sig:${(entity.name || '').toLowerCase()}:${gx}:${gy}`;
}

function shouldSkipDoor(entity, now) {
  const key = getDoorKey(entity);
  if (!key) return false;
  const until = doorSkipUntil.get(key) || 0;
  return until > now;
}

function markSkipDoor(entity, now, ttlMs = 7000) {
  const key = getDoorKey(entity);
  if (!key) return;
  doorSkipUntil.set(key, now + Math.max(500, Math.floor(ttlMs)));
}

function isLikelyAlreadyOpenDoor(entity) {
  if (!entity) return false;
  const name = `${entity.name || ''}`.toLowerCase();
  const renderName = `${entity.renderName || ''}`.toLowerCase();
  const anim = `${entity.animationName || ''}`.toLowerCase();

  // Transition-like objects can include "door" in metadata but are not door opens.
  if (name.includes('transition') || renderName.includes('transition') || name.includes('areatransition')) return true;

  // Common opened/opening animation labels.
  if (anim.includes('opened') || anim.includes('open_idle') || anim === 'open') return true;
  if (anim.includes('open') && !anim.includes('close')) return true;

  return false;
}

// --- General anti-repeat blacklist (all target types) ---
function getOpenKey(entity) {
  if (!entity) return '';
  const gx = Number.isFinite(entity.gridX) ? Math.floor(entity.gridX) : null;
  const gy = Number.isFinite(entity.gridY) ? Math.floor(entity.gridY) : null;
  const nm = (entity.name || entity.renderName || '').toLowerCase();
  // Position+name is stable for static openables and survives entity-id slab recycle.
  if (gx !== null && gy !== null && nm) return `o:${nm}:${gx}:${gy}`;
  if (entity.id) return `id:${entity.id}`;
  return '';
}

// banOnly=true ignores the short per-attempt cooldown and only hides hard-banned targets
// (used for the mapper candidate path so it doesn't thrash walking toward a target that is
// merely mid-cooldown between opener attempts).
function shouldSkipOpenTarget(entity, now, banOnly) {
  const key = getOpenKey(entity);
  if (!key) return false;
  const rec = openBlacklist.get(key);
  if (!rec) return false;
  if (rec.banned) return rec.until > now;
  if (banOnly) return false;
  // ESSENCE monoliths need MANY clicks (each interact breaks ONE layer -- user: 'try harder, more aggressively'):
  // re-click fast instead of the generic 2.5s gap, or the imprisoned-rare wait expires mid-open.
  // GENERIC (interrupt-aware retry): a not-yet-consumed target that hasn't been charged a real attempt yet AND
  // still has free retries left re-fires on the fast landed-check gap, so a transient interrupt gets retried
  // quickly; once a real attempt is charged (rec.attempts>0) or the free retries are spent, the normal gap resumes.
  let gap;
  if (rec.t === 'Essence') {
    // USER: within opener reach hammer the click at 100ms/tick; farther, keep the slower gap so a far auto-walk fire
    // doesn't burn the attempt cap.
    let _ed = Infinity;
    try { const _pl = POE2Cache.getLocalPlayer(); if (_pl && Number.isFinite(_pl.gridX) && Number.isFinite(entity.gridX)) _ed = Math.hypot(entity.gridX - _pl.gridX, entity.gridY - _pl.gridY); } catch (_) {}
    gap = _ed <= ESSENCE_FAST_RANGE ? ESSENCE_RETRY_FAST_MS : ESSENCE_RETRY_DELAY_MS;
  } else {
    gap = ((rec.attempts || 0) === 0 && (rec.freeRetries || 0) < OPEN_FREE_RETRIES) ? OPEN_LAND_CHECK_MS : OPEN_RETRY_DELAY_MS;
  }
  return (now - rec.lastAttemptTime) < gap;
}

// A strongbox's contents are gated until its GUARD pack dies: clicking while guards live is a no-op that burns
// an anti-repeat attempt (3 no-ops = 10-min ban -> contents stranded) AND takes the 2s movement lock (plants the
// player inside the guard fight). Skip guarded boxes each scan until the pack is dead. 500ms-cached per box.
let _sbGuardAt = 0, _sbGuardVal = false, _sbGuardKey = '';
function strongboxGuardsNear(entity) {
  const now = Date.now();
  const key = getOpenKey(entity);
  if (key === _sbGuardKey && now - _sbGuardAt < 500) return _sbGuardVal;
  _sbGuardKey = key; _sbGuardAt = now; _sbGuardVal = false;
  try {
    for (const m of (poe2.getEntities({ type: 'Monster', aliveOnly: true, lightweight: true, maxDistance: 160 }) || [])) {
      if (!m.isHostile || m.isTargetable === false) continue;
      if (Math.hypot((m.gridX || 0) - entity.gridX, (m.gridY || 0) - entity.gridY) < 60) { _sbGuardVal = true; break; }
    }
  } catch (_) {}
  return _sbGuardVal;
}

// Returns true only on the attempt that escalates the target to a hard ban (for logging).
// fairWindow (item A): a NON-essence send with no fair window (out of range, or a non-opener movement lock stealing
// the interact) gets up to OPEN_FREE_RETRIES free (non-counting) re-sends before the ban cap starts to accrue.
function markOpenAttempt(entity, now, type, fairWindow) {
  const key = getOpenKey(entity);
  if (!key) return false;
  let rec = openBlacklist.get(key);
  if (!rec) { rec = { attempts: 0, lastAttemptTime: 0, banned: false, until: 0, freeRetries: 0 }; openBlacklist.set(key, rec); }
  if (type) rec.t = type;
  rec.lastAttemptTime = now;   // stamped BEFORE the free-retry return so the fast lane's next gap is measured from it
  // INTERRUPT-AWARE FREE RETRY (non-essence): a send that never had a fair shot at landing must not burn an attempt.
  // Essences are exempt -- their multi-click sequence NEEDS every click to count against ESSENCE_MAX_ATTEMPTS.
  if (rec.t !== 'Essence' && !fairWindow && (rec.freeRetries || 0) < OPEN_FREE_RETRIES) {
    rec.freeRetries = (rec.freeRetries || 0) + 1;
    return false;
  }
  rec.attempts++;
  // ESSENCE: opening is a MULTI-CLICK sequence by design (each interact breaks one layer), so the generic 3-attempt
  // cap banned half-opened monoliths for 10 minutes. USER SPEC: 6 attempts, 400ms gap, only within 40u.
  // RUNEROCK is the exception INSIDE the essence bucket: a live rune consumes in ONE click, a spent one never does ->
  // cap at 3 so we don't waste ~7s hammering a dead (already-used) rune (user: 'only 3 attempts, EXCEPT essence').
  const _cap = isRuneRockEntity(entity) ? RUNEROCK_MAX_ATTEMPTS : (rec.t === 'Essence' ? ESSENCE_MAX_ATTEMPTS : OPEN_MAX_ATTEMPTS);
  if (!rec.banned && rec.attempts >= _cap) {
    rec.banned = true;
    rec.until = now + OPEN_BAN_MS;
    return true;
  }
  return false;
}

function pruneOpenBlacklist(now) {
  for (const [key, rec] of openBlacklist) {
    if (rec.banned) { if (rec.until <= now) openBlacklist.delete(key); }
    else if (now - rec.lastAttemptTime > 60000) openBlacklist.delete(key); // stale, never escalated
  }
  for (const [key, ts] of openCommitAt) if (now - ts > 60000) openCommitAt.delete(key); // commit gaps go stale with the target
}

// Lift drive-by whiff bans once the caller is STANDING at a site: delete every openBlacklist record whose key
// position is within r of (x,y) and whose name matches nameRe (keys are `o:<name>:<gx>:<gy>`; metadata names can
// hold ':' so the tail two segments are the coords). Deleting resets attempts + free retries -- a ban-burned chest
// gets a full fresh budget. The mapper calls this once per sweep-site arrival, never per frame.
function clearOpenBansNear(x, y, r, nameRe) {
  if (!OPENER_ABYSS_RANGE_ON) return 0;
  let n = 0;
  for (const key of openBlacklist.keys()) {
    if (!key.startsWith('o:')) continue;
    const parts = key.split(':');
    if (parts.length < 4) continue;
    const gx = Number(parts[parts.length - 2]), gy = Number(parts[parts.length - 1]);
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
    if (Math.hypot(gx - x, gy - y) > r) continue;
    if (nameRe && !nameRe.test(parts.slice(1, parts.length - 2).join(':'))) continue;
    openBlacklist.delete(key);
    n++;
  }
  if (n) console.log(`[Opener] cleared ${n} open-ban(s) near (${Math.round(x)},${Math.round(y)}) r=${r}`);
  return n;
}

// TASK-23 RESUME: the mapper persists the anti-repeat blacklist across a mid-map Uninject->Inject so a
// banned/already-used openable (spent shrine, dead rune, popped chest) is not re-tried after the reload.
// serialize -> plain [[key, rec]...] pairs (JSON-safe); restore merges them back, keeping whichever record
// has the newer lastAttemptTime (a live one that streamed since the reload wins over the persisted copy).
// No timestamp is bit-truncated (Date.now() overflows int32); numbers pass through as-is.
function serializeOpenBlacklist() {
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;
  const out = [];
  for (const [key, rec] of openBlacklist) {
    if (typeof key !== 'string' || !key || !rec) continue;
    out.push([key, {
      attempts: num(rec.attempts), lastAttemptTime: num(rec.lastAttemptTime),
      banned: !!rec.banned, until: num(rec.until), freeRetries: num(rec.freeRetries), t: rec.t
    }]);
  }
  return out;
}
function restoreOpenBlacklist(arr) {
  if (!Array.isArray(arr)) return 0;
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;
  let n = 0;
  for (const pair of arr) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const key = pair[0], rec = pair[1];
    if (typeof key !== 'string' || !key || !rec || typeof rec !== 'object') continue;
    const cur = openBlacklist.get(key);
    if (cur && num(cur.lastAttemptTime) >= num(rec.lastAttemptTime)) continue;   // live record already newer -> keep it
    openBlacklist.set(key, {
      attempts: num(rec.attempts), lastAttemptTime: num(rec.lastAttemptTime),
      banned: !!rec.banned, until: num(rec.until), freeRetries: num(rec.freeRetries), t: rec.t
    });
    n++;
  }
  return n;
}

// A hard-banned target must vanish from EVERY candidate source. collectOpenTargets already filters it for the
// opener and for getOpenableCandidatesForMapper, but the mapper's fallback shrine scanner builds candidates
// straight off getEntities and would keep walking to a shrine the opener has given up on.
function isOpenTargetHardBanned(entity) {
  const key = getOpenKey(entity);
  if (!key) return false;
  const rec = openBlacklist.get(key);
  return !!(rec && rec.banned && rec.until > Date.now());
}

// Portals/teleporters must NEVER be auto-opened: interacting warps the player out of
// the area. PoE2's MultiplexPortal lives under the Monolith metadata dir, so the
// Essence bucket (isEssenceEntity) classified it as a monolith and the opener logged
// "Opened Essence: MultiplexPortal" right next to the player. A per-classifier guard
// isn't enough -- this is also enforced as a hard final filter in collectOpenTargets,
// which is the single chokepoint for both processAutoOpen() and the mapper candidates.
function isWarpOrPortalEntity(entity) {
  const name = (entity?.name || "").toLowerCase();
  const renderName = (entity?.renderName || "").toLowerCase();
  if (!name && !renderName) return false;
  if (name.includes('multiplexportal') || renderName.includes('multiplexportal')) return true;
  if (name.includes('portal') || renderName.includes('portal')) return true;
  return false;
}

function isShrineEntity(entity) {
  const name = (entity?.name || "").toLowerCase();
  const renderName = (entity?.renderName || "").toLowerCase();
  if (!name && !renderName) return false;

  // Never treat a portal/teleporter as a shrine (interacting warps the player).
  // Shared guard; also applied as a hard final filter in collectOpenTargets.
  if (isWarpOrPortalEntity(entity)) return false;

  // Common direct matches.
  if (name.includes('shrine') || renderName.includes('shrine')) return true;

  // Metadata fallback for shrine-like openables.
  if ((name.includes('/shrines/') || name.includes('\\shrines\\')) && !name.includes('waypoint')) return true;
  return false;
}

function isSpecialInteractableEntity(entity) {
  const name = (entity?.name || "").toLowerCase();
  const renderName = (entity?.renderName || "").toLowerCase();
  if (!name && !renderName) return false;

  // Known anomaly/hengestone interactables (example: Draiocht Hengestone).
  if (renderName.includes('hengestone')) return true;
  // Monolith is handled in Essence bucket, not generic Special.
  if (name.includes('/miscellaneousobjects/monolith') || name.includes('\\miscellaneousobjects\\monolith')) return false;
  if ((name.includes('/endgame/anomalyobject') || name.includes('\\endgame\\anomalyobject')) && !name.includes('effect')) return true;
  // Precursor Relay (Atlas Points console) -- optional toggle, default ON. render "Precursor Relay" /
  // name Metadata/MiscellaneousObjects/AtlasPointDoodad. (Special bucket is always-on; gate per-setting.)
  if (openPrecursorRelay.value && (renderName.includes('precursor relay') || name.includes('atlaspointdoodad'))) return true;
  return false;
}

function isEssenceEntity(entity) {
  const name = (entity?.name || "").toLowerCase();
  const renderName = (entity?.renderName || "").toLowerCase();
  if (!name && !renderName) return false;

  // NOTE: StoneCircle "Runed Monolith" (Metadata/Terrain/.../StoneCircle/Objects/RuneRock)
  // matches via renderName "monolith" even though it's a terrain rune-puzzle, not a loot
  // essence. We deliberately do NOT hard-exclude it: live-RE found no "spent" flag beyond
  // Targetable+0x69 (consumed -> non-targetable, already skipped). Un-consumed runes that a
  // plain interact can't trigger are handled by the general anti-repeat blacklist
  // (markOpenAttempt/OPEN_MAX_ATTEMPTS) -- attempt a few times, then ban for the map.
  return (
    name.includes('/miscellaneousobjects/monolith') ||
    name.includes('\\miscellaneousobjects\\monolith') ||
    renderName.includes('monolith')
  );
}

// A StoneCircle "Runed Monolith" (RuneRock) -- a terrain rune-puzzle, distinct from a loot essence. Matches the rock
// path/renderName but NOT a plain essence "Monolith". Used to give it the short 3-attempt cap (not the essence 9).
function isRuneRockEntity(entity) {
  const nm = ((entity && (entity.name || entity.renderName)) || '');
  return /runerock|runed monolith|stonecircle/i.test(nm);
}

function passesVisibilityCheck(player, entity, maxDist) {
  if (visibilityMode.value === VISIBILITY_MODE.OFF) return true;
  if (!player || !entity || player.gridX === undefined || entity.gridX === undefined) return true;

  const fromX = Math.floor(player.gridX);
  const fromY = Math.floor(player.gridY);
  const toX = Math.floor(entity.gridX);
  const toY = Math.floor(entity.gridY);
  const checkDist = maxDist || maxDistance.value || DEFAULT_SETTINGS.maxDistance;
  const entityId = entity.id || 0;
  const cacheKey = `${entityId}:${visibilityMode.value}:${checkDist}`;
  const now = Date.now();

  const cached = visibilityCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < VISIBILITY_CACHE_TTL) {
    return cached.result;
  }

  let result = true;
  try {
    if (visibilityMode.value === VISIBILITY_MODE.LINE_OF_FIRE) {
      if (typeof poe2.hasLineOfFire === 'function') {
        result = poe2.hasLineOfFire(fromX, fromY, toX, toY, checkDist);
      } else if (typeof poe2.isWithinLineOfSight === 'function') {
        result = poe2.isWithinLineOfSight(fromX, fromY, toX, toY, checkDist);
      }
    } else if (visibilityMode.value === VISIBILITY_MODE.LINE_OF_SIGHT) {
      if (typeof poe2.isWithinLineOfSight === 'function') {
        result = poe2.isWithinLineOfSight(fromX, fromY, toX, toY, checkDist);
      } else if (typeof poe2.hasLineOfFire === 'function') {
        result = poe2.hasLineOfFire(fromX, fromY, toX, toY, checkDist);
      }
    }
  } catch (e) {
    result = true;  // fail open to avoid blocking opener due to api/read issues
  }

  visibilityCache.set(cacheKey, { result, timestamp: now });
  return result;
}

function collectOpenTargets(maxDist, includeDoors, allowBlockedVisibility = false) {
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) return [];

  const targetsToOpen = [];
  const seenIds = new Set();
  const now = Date.now();

  if (openNormalChests.value || openStrongboxes.value) {
    const chests = POE2Cache.getEntities({ type: "Chest", maxDistance: maxDist, lightweight: true });
    for (const entity of chests) {
      if (!entity.gridX || entity.isLocalPlayer) continue;
      if (!entity.id || entity.id === 0) continue;
      if (entity.chestIsOpened === true) continue;
      if (entity.isTargetable !== true) continue;
      if (isExcludedByName(entity)) continue;

      let shouldOpen = false;
      let objectType = "Unknown";
      if (entity.chestIsStrongbox === true && openStrongboxes.value) {
        shouldOpen = true;
        objectType = "Strongbox";
      } else if (entity.chestIsStrongbox === false && openNormalChests.value) {
        shouldOpen = true;
        objectType = "Chest";
      }
      if (!shouldOpen) continue;

      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!allowBlockedVisibility && !passesVisibilityCheck(player, entity, maxDist)) continue;
      targetsToOpen.push({ entity: entity, distance: dist, type: objectType });
      seenIds.add(entity.id);
    }
  }

  if (openShrines.value) {
    // Do not restrict shrine scan by entity type; shrine objects may appear
    // as non-monster entities depending on area/version.
    // lightweight=true: opener only reads name/renderName/grid/id/isTargetable/
    // chestIs*/animationName/entityType -- all populated under lightweight, which
    // skips Buffs/Stats/Mods/WorldItem (the expensive buff_cache_mutex_ path).
    const nearby = POE2Cache.getEntities({ maxDistance: maxDist, lightweight: true });
    for (const entity of nearby) {
      if (!Number.isFinite(entity.gridX) || !Number.isFinite(entity.gridY) || entity.isLocalPlayer) continue;
      if (!entity.id || entity.id === 0) continue;
      if (seenIds.has(entity.id)) continue;
      if (!isShrineEntity(entity)) continue;
      if (entity.isTargetable !== true) continue;

      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // NO visibility gate for shrines: a shrine sits on an UNWALKABLE cell (you stand adjacent), so a LoF/LoS probe
      // to it reads blocked at EVERY range -- gating a shrine on that signal can only ever skip it. The open-side
      // walkable-cell gate and the attempt blacklist bound a genuinely unreachable one.
      targetsToOpen.push({ entity: entity, distance: dist, type: "Shrine" });
      seenIds.add(entity.id);
    }
  }

  // Essence interactables (Monolith) - explicit bucket so mapper/opener logs
  // show these as "Essence" instead of generic special objects.
  if (openEssences.value) {
    const nearby = POE2Cache.getEntities({ maxDistance: maxDist, lightweight: true });
    for (const entity of nearby) {
      if (!Number.isFinite(entity.gridX) || !Number.isFinite(entity.gridY) || entity.isLocalPlayer) continue;
      if (!entity.id || entity.id === 0) continue;
      if (seenIds.has(entity.id)) continue;
      if (!isEssenceEntity(entity)) continue;
      if (entity.isTargetable !== true) { logEssenceSkip(entity, ('isTargetable' in entity) ? 'untargetable (opened or guarded)' : 'no Targetable component'); continue; }
      if (isExcludedByName(entity)) { logEssenceSkip(entity, 'name-excluded'); continue; }

      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!allowBlockedVisibility && !passesVisibilityCheck(player, entity, maxDist) && dist > 40) { logEssenceSkip(entity, `LoF-blocked at ${dist.toFixed(0)}u (>40u)`); continue; }
      targetsToOpen.push({ entity: entity, distance: dist, type: "Essence" });
      seenIds.add(entity.id);
    }
  }

  // Special clickable objects (e.g. Draiocht Hengestone anomaly objects).
  // These can be mission/map progression interactables that should be opened like shrines.
  {
    const nearby = POE2Cache.getEntities({ maxDistance: maxDist, lightweight: true });
    for (const entity of nearby) {
      if (!Number.isFinite(entity.gridX) || !Number.isFinite(entity.gridY) || entity.isLocalPlayer) continue;
      if (!entity.id || entity.id === 0) continue;
      if (seenIds.has(entity.id)) continue;
      if (!isSpecialInteractableEntity(entity)) continue;
      if (entity.isTargetable !== true) continue;
      if (isExcludedByName(entity)) continue;

      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!allowBlockedVisibility && !passesVisibilityCheck(player, entity, maxDist) && dist > 40) continue;
      targetsToOpen.push({ entity: entity, distance: dist, type: "Special" });
      seenIds.add(entity.id);
    }
  }

  if (includeDoors && openDoors.value) {
    const allNearby = POE2Cache.getEntities({ maxDistance: maxDist, lightweight: true });
    for (const entity of allNearby) {
      if (!entity.gridX || entity.isLocalPlayer) continue;
      if (!entity.id || entity.id === 0) continue;
      if (seenIds.has(entity.id)) continue;
      if (shouldSkipDoor(entity, now)) continue;
      if (entity.isTargetable !== true) continue;
      if (!isDoorEntity(entity)) continue;
      if (isLikelyAlreadyOpenDoor(entity)) {
        markSkipDoor(entity, now, 12000);
        continue;
      }
      if (entity.entityType === 'Chest') continue;
      if ((entity.name || "").toLowerCase().includes('shrine')) continue;
      if (isExcludedByName(entity)) continue;

      const dx = entity.gridX - player.gridX;
      const dy = entity.gridY - player.gridY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Doors often report blocked LoS/LoF while still being valid interactables
      // in narrow tiles/corridors. Keep far-distance visibility checks, but allow
      // close door opens to avoid getting stuck at map doors.
      if (!allowBlockedVisibility && !passesVisibilityCheck(player, entity, maxDist) && dist > 36) continue;
      targetsToOpen.push({ entity: entity, distance: dist, type: "Door" });
      seenIds.add(entity.id);
    }
  }

  // HARD GUARD (always-on, covers EVERY bucket above + the mapper candidate path):
  // strip any warp/teleporter. MultiplexPortal classifies as an Essence monolith, so
  // the essence bucket would otherwise open it ("Opened Essence: MultiplexPortal") and
  // warp the player out of the map. This is the single chokepoint shared by
  // processAutoOpen() and getOpenableCandidatesForMapper(), so filtering here is
  // sufficient no matter which bucket classified the entity.
  // allowBlockedVisibility is the mapper candidate path -> banOnly so the mapper won't
  // thrash on a target that is only mid-cooldown between opener attempts; the opener path
  // (allowBlockedVisibility=false) honors the short cooldown too.
  return targetsToOpen.filter(t =>
    !isWarpOrPortalEntity(t.entity) &&
    !shouldSkipOpenTarget(t.entity, now, allowBlockedVisibility));
}

function getOpenableCandidatesForMapper(maxDist) {
  loadPlayerSettings();
  const effectiveDist = Math.max(20, Math.floor(maxDist || maxDistance.value || 200));
  // Mapper needs walk-target candidates even when LoF/LoS is currently blocked,
  // so it can path to the object and let opener interact once in range.
  const targets = collectOpenTargets(effectiveDist, false, true);
  if (targets.length === 0) return [];
  targets.sort((a, b) => a.distance - b.distance);
  return targets;
}

function getOpenerCooldownMs() {
  loadPlayerSettings();
  const v = Math.floor(openCooldownMs.value || DEFAULT_SETTINGS.openCooldownMs || 300);
  return Math.max(0, v);
}

/**
 * Send open/interact packet
 * Packet: 01 A3 01 20 00 C2 66 04 00 FF 08 [ID: 4 bytes BE] [gridX: 4 bytes BE] [gridY: 4 bytes BE]
 *
 * 050b game-patch update: entity-targeted packets now require the target's
 * INTEGER grid (BE u32) appended after the entity ID. Normal chests sometimes
 * tolerate the legacy 15-byte form (server ignores or accepts), but special
 * interactables (ScarabAmbushLandmarkChest, etc.) DC on the truncated packet.
 * Rotation_builder.buildTargetPacket already does this; opener was missed.
 */
function sendOpenPacket(entityId, gridX, gridY) {
  const id = entityId | 0;
  const bytes = [
    0x01, 0xA3, 0x01, 0x20, 0x00, 0xC2, 0x66, 0x04,
    0x00, 0xFF, 0x08,  // 0x00 = interact/open action
    (id >> 24) & 0xFF,  // Big endian: MSB first
    (id >> 16) & 0xFF,
    (id >> 8) & 0xFF,
    id & 0xFF           // LSB last
  ];
  if (gridX !== undefined && gridX !== null && gridY !== undefined && gridY !== null) {
    const gx = Math.floor(gridX);
    const gy = Math.floor(gridY);
    bytes.push((gx >>> 24) & 0xFF, (gx >>> 16) & 0xFF, (gx >>> 8) & 0xFF, gx & 0xFF);
    bytes.push((gy >>> 24) & 0xFF, (gy >>> 16) & 0xFF, (gy >>> 8) & 0xFF, gy & 0xFF);
  }
  return poe2.sendPacket(new Uint8Array(bytes));
}

/**
 * Auto-open logic (runs ALWAYS, even when window is collapsed)
 */
function processAutoOpen() {
  if (!enabled.value) {
    return;
  }

  const now = Date.now();

  // Prune the anti-repeat blacklist (expired bans + stale un-escalated entries).
  if (now - lastBlacklistPrune > 5000) { lastBlacklistPrune = now; pruneOpenBlacklist(now); }

  // ONE ACTION SLOT: a live claim means an interaction is already in flight -- pickit walking an item down,
  // or our OWN previous open still auto-walking. Firing now would REPLACE that action server-side (the open
  // that "never opened" / the item that never got picked), and the cancelled target still burned one of its
  // retry attempts toward its map-ban. Waiting the claim out costs <=2.5s and makes every attempt real.
  // Ordering effect: loot drains before chests open (chests drop MORE loot into the same dwell).
  if (POE2Cache.interactionClaim && POE2Cache.interactionClaim()) return;

  if (now - lastOpenTime < openCooldownMs.value) {
    return;
  }

  // Throttle the SCAN itself (not just successful opens). lastOpenTime only
  // advances on a successful sendOpenPacket, so empty rooms previously scanned
  // every frame. Scan rate now follows the cooldown slider directly -- bump
  // openCooldownMs in the UI to reduce scan frequency further. Default 300ms
  // = 3.3Hz scans; raise to 500-1000ms for noticeably less CPU work in juiced
  // maps if reaction latency is acceptable.
  const scanInterval = openCooldownMs.value;
  if (now - lastScanTime < scanInterval) {
    return;
  }
  lastScanTime = now;

  const targetsToOpen = collectOpenTargets(maxDistance.value, true);
  cachedScanTargets = targetsToOpen;
  cachedScanFrame = POE2Cache.getFrameNumber();

  if (targetsToOpen.length > 0) {
    // Sort by distance (closest first)
    targetsToOpen.sort((a, b) => a.distance - b.distance);
    
    // WALKABLE GATE (USER): only open a target we can actually REACH -- skip any whose straight line is wall-blocked
    // (isWithinLineOfSight = walkable-grid line). UNCONDITIONAL (independent of the visibilityMode toggle, which is
    // OFF here) so a walled chest can't be 're-opened' forever (the 0xC0 spam). Picks the nearest REACHABLE target;
    // if every in-range target is wall-blocked this scan, skip (the mapper's no-progress watchdog moves us on).
    // Fail-open if the binding/read is unavailable.
    const _pl = POE2Cache.getLocalPlayer();
    let target = null, _committing = false;   // _committing: the selected target is a commit-to-click (shorter lock, per-target 2.5s gap)
    // ESSENCE is TIME-SENSITIVE: the attack side skips the imprisoned rare only ~12s waiting for us to START the
    // monolith, so open essences FIRST and EXEMPT them from the walkable-LoS gate -- you stand adjacent + sendOpenPacket
    // auto-walks/routes via the GAME pathfinder. REGRESSION CAUSE: once the mapper stopped engaging the imprisoned rare,
    // the bot sits FARTHER from the monolith, its straight-line LoS reads wall-blocked, the gate skipped it, and the
    // essence was never started (then the 12s safety let the rare get attacked imprisoned = wasted). The anti-repeat
    // blacklist (markOpenAttempt/OPEN_MAX_ATTEMPTS) still bounds a genuinely-unreachable monolith to a few attempts.
    const ordered = targetsToOpen.filter(t => t.type === 'Essence').concat(targetsToOpen.filter(t => t.type !== 'Essence'));
    for (const t of ordered) {
      if (t.type === 'Essence') {
        // RuneRock/StoneCircle = a PROXIMITY terrain puzzle, not an exploding essence: clicks from 20u+ are
        // no-ops that burn the attempt budget (live: 'Opened Essence: RuneRock Dist: 35.7' did nothing).
        const _isRuneRock = /runerock|runed monolith|stonecircle/i.test((t.entity && (t.entity.renderName || t.entity.name)) || '');
        if ((t.distance || 0) > (_isRuneRock ? 20 : 40)) continue;
        target = t; break;                      // priority + gate-exempt (the mapper/rare-engage parks us adjacent)
      }
      // Abyss chest beyond send range: keep it visible as a candidate, just don't fire (whiffs burn the ban budget).
      if (OPENER_ABYSS_RANGE_ON && (t.distance || 0) > ABYSS_CHEST_SEND_RANGE
          && /abysschest/i.test(`${(t.entity && (t.entity.name || t.entity.renderName)) || ''}`)) continue;
      if (t.type === 'Strongbox' && strongboxGuardsNear(t.entity)) continue;   // guards alive -> wait, don't burn attempts/locks
      // UNFAIR-SEND HOLD (non-essence): no fair window = beyond OPEN_FAIR_RANGE AND something else drives the
      // character -- a NON-opener movement lock OR a live MAPPER WALK (the mapper registers no lock, so it was
      // invisible to the TASK-21 hold: the 45.3u/38.1u "shrine NEXT TO ME didn't go" whiffs happened during a plain
      // mapper walk). Either way the interact's auto-walk is stomped -> the send whiffs. HOLD (skip the send, charge
      // nothing, stay a candidate); in range OR movement free sends as today. Essences/RuneRocks never reach here
      // (essence lane breaks/continues above); the abyss-chest 25u gate above is stricter and stays.
      if (OPEN_UNFAIR_HOLD_ON && (t.distance || 0) > OPEN_FAIR_RANGE) {
        let _mlH = { locked: false, source: '' };
        try { if (POE2Cache.isMovementLocked) _mlH = POE2Cache.isMovementLocked(); } catch (_) {}
        const _foreignLock = _mlH.locked && _mlH.source !== 'opener';
        const _mapperDriving = (now - (POE2Cache.mapperDrivingAt || 0)) < 600;   // movement-state bus: mapper walked within 600ms
        if (_foreignLock || _mapperDriving) {
          // COMMIT-TO-CLICK (get closer and commit): a held target within OPEN_COMMIT_RANGE, when the mapper says it's
          // safe (POE2Cache.commitClickSafe -- not dodging, not a boss walk-in/fight), earns ONE interact. Claim our
          // OWN OPEN_COMMIT_MS movement lock (the mapper yields to it exactly as for any open -> the yield IS the stop),
          // fire, and let the interact's auto-walk carry us in for the window. One commit per target per the 2.5s gap
          // (openCommitAt); a mid-commit dodge flips commitClickSafe false + steals movement, so the send just doesn't
          // land = a free retry (the markOpenAttempt landing/free-retry accounting below applies unchanged).
          if ((t.distance || 0) <= OPEN_COMMIT_RANGE && POE2Cache.commitClickSafe === true
              && (now - (openCommitAt.get(getOpenKey(t.entity)) || 0)) >= OPEN_RETRY_DELAY_MS) {
            target = t; _committing = true; break;   // gate-exempt like the essence lane (auto-walk routes around walls)
          }
          continue;   // held: the send can't land, don't burn the budget
        }
      }
      let reachable = true;
      try {
        if (_pl && t.entity && typeof poe2.isWithinLineOfSight === 'function') {
          const tx = Math.floor(t.entity.gridX), ty = Math.floor(t.entity.gridY);
          // ONLY gate openables whose OWN cell is WALKABLE (ground chests). A SHRINE sits on an UNWALKABLE cell (you
          // stand ADJACENT) -> a cell-LOS ALWAYS fails for it (live-RE: shrineCellWalkable=false), so don't gate
          // those (the mapper's no-progress blacklist catches a genuinely unreachable one). The 0xC0 walled chest
          // has a WALKABLE cell, so the wall-on-the-line check still skips it.
          const cellWalkable = (typeof poe2.isWalkable === 'function') ? poe2.isWalkable(tx, ty) : true;
          if (cellWalkable) {
            reachable = poe2.isWithinLineOfSight(Math.floor(_pl.gridX), Math.floor(_pl.gridY), tx, ty, (t.distance || 0) + 12);
          }
        }
      } catch (_) { reachable = true; }
      if (reachable) { target = t; break; }
    }
    if (!target) return;
    const success = sendOpenPacket(target.entity.id, target.entity.gridX, target.entity.gridY);
    
    if (success) {
      lastOpenedChestName = target.entity.name || "Unknown";
      lastOpenedChestId = target.entity.id;
      lastOpenedChestDistance = target.distance;
      lastOpenTime = now;
      // Universal anti-repeat: count this attempt; a target that won't go away gets banned. FAIR WINDOW (item A) =
      // close enough to interact + no NON-opener movement lock driving the character (which would cancel the
      // interact's auto-walk); an unfair send gets a free (non-counting) retry so a mid-fight / locked interrupt
      // doesn't burn the ban budget. Our own 'opener' lock (a prior open's auto-walk) does not count as stealing.
      let _fairWindow = true;
      try {
        const _ml = POE2Cache.isMovementLocked ? POE2Cache.isMovementLocked() : { locked: false, source: '' };
        _fairWindow = (target.distance || 0) <= OPEN_FAIR_RANGE && !(_ml.locked && _ml.source !== 'opener');
      } catch (_) {}
      const justBanned = markOpenAttempt(target.entity, now, target.type, _fairWindow);
      if (target.type === "Door") {
        // Even when a door is already open, interaction can report success.
        // Suppress quick retries to avoid repeated opener-yield loops.
        markSkipDoor(target.entity, now, 9000);
      }

      // Request movement lock so mapper yields while game auto-walks to open. Q1 (USER): 2s dwell on a successful open
      // -> stand still + let pickit grab the drop, don't run off (1500 -> 2000). COMMIT-TO-CLICK grants a SHORTER lock
      // (OPEN_COMMIT_MS): release fast if the walk-in didn't land so the mapper resumes -- convergence relies on the
      // next commit 2.5s later, not on pinning the mapper. A commit that DID land opens the target -> it leaves the
      // candidate list -> no further commits (the short lock never shortens a real open's dwell, only a far walk-in).
      POE2Cache.requestMovementLock('opener', _committing ? OPEN_COMMIT_MS : 2000);
      if (_committing) openCommitAt.set(getOpenKey(target.entity), now);   // stamp the per-target 2.5s commit gap
      // Hold the action slot for the walk+open so pickit / the next open can't cancel it (TTL scales with the walk).
      // Essence: SHORT claim -- the multi-click sequence must re-fire at ESSENCE_RETRY_DELAY_MS, and the own claim
      // would otherwise self-block the next layer's click.
      if (POE2Cache.claimInteraction) POE2Cache.claimInteraction('opener', target.entity.id,
        target.type === 'Essence'
          ? ((target.distance || 0) <= ESSENCE_FAST_RANGE ? ESSENCE_CLAIM_FAST_MS : ESSENCE_CLAIM_MS)
          : Math.min(2500, 600 + (target.distance || 0) * 30));
      // Essence opens can detonate HUGE explosions under the player (user) -- publish each click so the mapper's
      // dodge arms a danger circle at the monolith and keeps the player out of the blast footprint while clicking.
      // NOT for RuneRock/StoneCircle: the puzzle rocks don't explode, and the phantom hazard was shoving the
      // player AWAY from the rock it needs to stand next to.
      if (target.type === 'Essence' && !/runerock|runed monolith|stonecircle/i.test((target.entity.renderName || target.entity.name) || '')) {
        try { POE2Cache.lastEssenceOpen = { x: target.entity.gridX, y: target.entity.gridY, at: now }; } catch (_) {}
      }
      // A strongbox CLICK only ACTIVATES the box -- its guard wave spawns and the box does not open until that wave
      // dies (the click itself clears Targetable, so only chestIsOpened marks the real open). Publish it so the mapper's
      // portal gate can wait the event out: a box taken PASSIVELY (it fell inside the opener's range, so no utility
      // dwell ever committed to it) has nothing else holding the map open.
      if (target.type === 'Strongbox') {
        try { POE2Cache.lastStrongboxOpen = { id: target.entity.id, x: target.entity.gridX, y: target.entity.gridY, at: now }; } catch (_) {}
      }

      const shortName = lastOpenedChestName.split('/').pop() || lastOpenedChestName;
      const idHex = `0x${lastOpenedChestId.toString(16).toUpperCase()}`;

      console.log(`[Opener] Opened ${target.type}: ${shortName} (ID: ${idHex}, Dist: ${target.distance.toFixed(1)})`);
      if (_committing) console.log(`[Opener] commit-click ${shortName} at ${target.distance.toFixed(0)}u`);
      if (justBanned) {
        const _banCap = isRuneRockEntity(target.entity) ? RUNEROCK_MAX_ATTEMPTS : (target.type === 'Essence' ? ESSENCE_MAX_ATTEMPTS : OPEN_MAX_ATTEMPTS);
        console.log(`[Opener] Blacklisted ${target.type}: ${shortName} after ${_banCap} attempts (won't retry this map)`);
      }
    }
  }
}

function onDraw() {
  // NOTE: Do NOT call POE2Cache.beginFrame() here!
  // It should only be called ONCE per frame in main.js
  
  // Load player settings if not loaded or player changed
  loadPlayerSettings();
  
  // Auto-open runs FIRST, before any window checks (runs even when UI is hidden)
  processAutoOpen();
  
  // Skip UI drawing if UI is hidden (F12 toggle)
  if (!Plugins.isUiVisible()) return;
  
  // Now render the UI window
  ImGui.setNextWindowSize({x: 400, y: 350}, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({x: 1300, y: 10}, ImGui.Cond.FirstUseEver);  // Position after other plugins
  ImGui.setNextWindowCollapsed(true, ImGui.Cond.Once);  // Start collapsed
  
  if (!ImGui.begin("Auto Opener", null, ImGui.WindowFlags.None)) {
    ImGui.end();
    return;
  }
  
  // Get player for UI display
  const player = POE2Cache.getLocalPlayer();
  if (!player || player.gridX === undefined) {
    ImGui.textColored([1.0, 0.5, 0.5, 1.0], "Waiting for player...");
    ImGui.end();
    return;
  }
  
  // Header
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Auto Chest/Object Opener");
  ImGui.separator();
  
  // Enable/Disable toggle
  const prevEnabled = enabled.value;
  ImGui.checkbox("Enable Auto-Open", enabled);
  if (prevEnabled !== enabled.value) {
    saveSetting('enabled', enabled.value);
  }
  
  if (enabled.value) {
    ImGui.sameLine();
    ImGui.textColored([0.5, 1.0, 0.5, 1.0], "** ACTIVE **");
  } else {
    ImGui.sameLine();
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "(Disabled)");
  }
  
  ImGui.separator();
  
  // Settings
  ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Settings:");
  
  const prevDist = maxDistance.value;
  ImGui.sliderInt("Max Distance", maxDistance, 20, 200);
  if (prevDist !== maxDistance.value) {
    saveSetting('maxDistance', maxDistance.value);
  }
  
  const prevCooldown = openCooldownMs.value;
  ImGui.sliderInt("Cooldown (ms)", openCooldownMs, 100, 1000);
  if (prevCooldown !== openCooldownMs.value) {
    saveSetting('openCooldownMs', openCooldownMs.value);
  }

  ImGui.text("Visibility Check:");
  const prevVisibilityMode = visibilityMode.value;
  if (ImGui.radioButton("Off##openervis", visibilityMode.value === VISIBILITY_MODE.OFF)) {
    visibilityMode.value = VISIBILITY_MODE.OFF;
  }
  ImGui.sameLine();
  if (ImGui.radioButton("Line of Fire##openervis", visibilityMode.value === VISIBILITY_MODE.LINE_OF_FIRE)) {
    visibilityMode.value = VISIBILITY_MODE.LINE_OF_FIRE;
  }
  ImGui.sameLine();
  if (ImGui.radioButton("Walkable LoS##openervis", visibilityMode.value === VISIBILITY_MODE.LINE_OF_SIGHT)) {
    visibilityMode.value = VISIBILITY_MODE.LINE_OF_SIGHT;
  }
  if (prevVisibilityMode !== visibilityMode.value) {
    saveSetting('visibilityMode', visibilityMode.value);
    visibilityCache.clear();
  }
  if (ImGui.isItemHovered()) {
    ImGui.setTooltip("Off: no visibility check\nLine of Fire: projectile blocking\nWalkable LoS: walkability-based");
  }
  
  ImGui.separator();
  
  // Object type filters
  ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Open:");
  
  const prevStrongboxes = openStrongboxes.value;
  ImGui.checkbox("Strongboxes", openStrongboxes);
  if (prevStrongboxes !== openStrongboxes.value) {
    saveSetting('openStrongboxes', openStrongboxes.value);
  }
  
  ImGui.sameLine();
  const prevNormalChests = openNormalChests.value;
  ImGui.checkbox("Normal Chests", openNormalChests);
  if (prevNormalChests !== openNormalChests.value) {
    saveSetting('openNormalChests', openNormalChests.value);
  }
  
  const prevShrines = openShrines.value;
  ImGui.checkbox("Shrines (targetable)", openShrines);
  if (prevShrines !== openShrines.value) {
    saveSetting('openShrines', openShrines.value);
  }

  ImGui.sameLine();
  const prevEssences = openEssences.value;
  ImGui.checkbox("Essences", openEssences);
  if (prevEssences !== openEssences.value) {
    saveSetting('openEssences', openEssences.value);
  }
  
  const prevDoors = openDoors.value;
  ImGui.checkbox("Doors", openDoors);
  if (prevDoors !== openDoors.value) {
    saveSetting('openDoors', openDoors.value);
  }

  const prevRelay = openPrecursorRelay.value;
  ImGui.checkbox("Precursor Relay", openPrecursorRelay);
  if (prevRelay !== openPrecursorRelay.value) {
    saveSetting('openPrecursorRelay', openPrecursorRelay.value);
  }

  ImGui.separator();
  
  // Name exclusion filter
  ImGui.textColored([0.5, 1.0, 1.0, 1.0], "Exclude by Name:");
  ImGui.textColored([0.6, 0.6, 0.6, 1.0], "(Comma-separated, partial match)");
  
  const prevExcludeNames = excludeChestNames.value;
  ImGui.inputText("##excludenames", excludeChestNames, 256);
  if (prevExcludeNames !== excludeChestNames.value) {
    saveSetting('excludeChestNames', excludeChestNames.value);
  }
  
  ImGui.separator();
  
  // Display options
  const prevShowLast = showLastOpened.value;
  ImGui.checkbox("Show Last Opened", showLastOpened);
  if (prevShowLast !== showLastOpened.value) {
    saveSetting('showLastOpened', showLastOpened.value);
  }
  
  // Status display
  ImGui.separator();
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Status:");
  
  if (enabled.value) {
    const timeSinceLastOpen = Date.now() - lastOpenTime;
    const cooldownRemaining = Math.max(0, openCooldownMs.value - timeSinceLastOpen);
    
    if (cooldownRemaining > 0) {
      ImGui.textColored([1.0, 0.5, 0.0, 1.0], `Cooldown: ${cooldownRemaining}ms`);
    } else {
      ImGui.textColored([0.5, 1.0, 0.5, 1.0], "Ready to open");
    }
    
    // Show last opened chest info
    if (showLastOpened.value && lastOpenedChestName && lastOpenTime > 0) {
      ImGui.separator();
      ImGui.textColored([0.8, 0.8, 1.0, 1.0], "Last Opened:");
      
      const shortName = lastOpenedChestName.split('/').pop() || lastOpenedChestName;
      const idHex = `0x${lastOpenedChestId.toString(16).toUpperCase()}`;
      
      ImGui.text(`  Name: ${shortName}`);
      ImGui.text(`  ID: ${idHex}`);
      ImGui.text(`  Distance: ${lastOpenedChestDistance.toFixed(1)}`);
      
      const timeAgo = ((Date.now() - lastOpenTime) / 1000).toFixed(1);
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], `  (${timeAgo}s ago)`);
    }
  } else {
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "Auto-open is disabled");
  }
  
  // Count nearby targets (for info). Reuses the scan result populated by
  // processAutoOpen so the UI doesn't re-scan the entire entity list per frame.
  // If the cached scan is from this frame, use exact count; otherwise fall back
  // to the last known count (up to ~150ms stale -- cosmetic only).
  if (enabled.value) {
    const targetCount = (cachedScanFrame === POE2Cache.getFrameNumber())
      ? cachedScanTargets.length
      : (cachedScanTargets ? cachedScanTargets.length : 0);
    
    ImGui.separator();
    if (targetCount > 0) {
      ImGui.textColored([1.0, 1.0, 0.5, 1.0], `Targets in range: ${targetCount}`);
    } else {
      ImGui.textColored([0.6, 0.6, 0.6, 1.0], "No targets in range");
    }
  }
  
  ImGui.end();
}

export const openerPlugin = {
  onDraw: onDraw
};

export { getOpenableCandidatesForMapper, getOpenerCooldownMs, isExcludedByName, isOpenTargetHardBanned, clearOpenBansNear, serializeOpenBlacklist, restoreOpenBlacklist };

console.log("[Opener] Plugin loaded (using shared POE2Cache)");


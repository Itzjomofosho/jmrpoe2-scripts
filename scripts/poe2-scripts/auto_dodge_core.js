import { buildDirectionalPacket } from './rotation_builder.js';
import { POE2Cache } from './poe2_cache.js';

const poe2 = new POE2();
const G2W = 250.0 / 23.0;
const TWO_PI = Math.PI * 2;

const RARITY_NORMAL = 0;
const RARITY_MAGIC = 1;
const RARITY_RARE = 2;
const RARITY_UNIQUE = 3;

const PROJECTILE_KEYWORDS = [
  'projectile', 'missile', 'metadata/projectiles',
  'arrow', 'bolt', 'spear', 'spike', 'shot',
  'fireball', 'iceshot', 'lightning_arrow',
  'cannonball', 'throwingknife', 'thrown',
  'spike_projectile', 'ranged_attack',
];

// Named-action danger patterns for the boss/rare MELEE-SLAM and CHARGE branches (the aoe0 geo0 gr0 blind spot --
// these carry no aoe/geometry/ground flag, so they're matched by NAME). nameMatches() lowercases + substring-tests.
const SLAM_KEYWORDS = ['melee', 'slam', 'smash', 'stomp', 'crush', 'cleave', 'sweep', 'overhead', 'pound', 'groundslam', 'emptyaction'];
const CHARGE_KEYWORDS = ['charge', 'driveby', 'rush', 'leap', 'dash', 'lunge', 'gapclose'];
// DANGER skills: lethal delayed-AoE detonations (corpse explosion / detonate-dead / self-destruct) that carry NO readable
// geometry (aoe0 geo0) so nothing sees them, and are lethal from ANY rarity (a normal CorpseExploder killed the player).
// Dodged rarity-INDEPENDENTLY as a circle at the detonation spot -- distinct from a melee swing (rare+ gated). Kept tight
// to avoid over-matching a benign "explosion" cosmetic.
const DANGER_KEYWORDS = ['detonate', 'deadarea', 'corpseexplo', 'corpsedetonat', 'selfdestruct', 'suicide', 'skittermine'];

const DODGE_ROLL_BYTES = [0x80, 0x00, 0x00, 0x40];

const SCAN_INTERVAL_MS = 100;
// Rare/map-clear mode does a FULL poe2.getEntities() scan every gate -- on dense (~21k-entity) maps this is the
// dominant per-frame lag AND runs 100% of the time (a rare is always near a big pack). Boss mode stays 100ms
// (survival); rare mode eases to ~6Hz -- projectile ETAs run 500-900ms so 160ms scan latency still catches them.
const RARE_SCAN_INTERVAL_MS = 160;

// Damaging DEPLOYABLE-AoE path keywords (.ao path) for HOSTILE persistent fields (tornado/cloud/fire/storm/degen/etc.)
// that have NO GroundEffect component AND no active action -> they slip through every dodge branch (DODGE-SEES:NONE) and
// kill us (the ChaosGodOwl tornado). Curated from PoE hazard types -- exCore2/EffectZones uses the same path-regex model
// (it ships empty for the user to fill). Only applied to non-Monster (NPC/Effect) HOSTILE entities with our own (friendly)
// deployables excluded, so a broad list is SAFE: escaping a hostile field is always correct, and we never flee a monster
// body or our own Tornado Shot. If a boss's field path isn't caught, add its keyword here (validate via the [Dodge] log).
const DANGEROUS_EFFECT_RX = /tornado|cyclone|storm|whirl|twister|vortex|hurricane|maelstrom|tempest|firestorm|meteor|comet|magma|lava|ember|ignit|burning|cinder|flame|pyroclast|scorch|caustic|poison|toxic|corrosive|plague|blight|desecrat|contagi|blizzard|glacial|frostbolt|icestorm|shockground|lightningground|thunder|beam|laser|deathray|nova|shockwave|quake|tremor|eruption|cloud|miasma|spore|gascloud|smoke|noxious|degen|hazard|damagezone|deathzone|explos/i;
const PROJ_HISTORY_TTL = 2000;
const DODGED_ACTION_TTL_MS = 1500;
const PLAYER_BODY_WORLD = 100;   // player hit radius (world units) for the T0.1 projectile collision test -- 55 UNDER-dodged (projectiles landed); generous so we catch hits + near-hits

// PHANTOM-PROJECTILE GATE: the projectile FIRST-SIGHT rotation fallback fabricates an 800-speed lane along a
// stationary shot/arrow-named entity's facing before two velocity samples exist. Spent projectiles, own
// non-tornado deployables and arrow-named ground scenery that stream in facing the player each rolled a phantom
// dodge with NO shooter present. A real thrown projectile has a live hostile near the player -- require one.
// Read the PREVIOUS pass's count: this pass's enemies[] is still being built when the projectile branch runs
// (same-pass ordering). false = fabricate-always (today's byte-for-byte behavior).
const PROJ_FALLBACK_NEEDS_SHOOTER = true;
const PROJ_SHOOTER_RANGE_GRID = 120;
const PROJ_SHOOTER_RANGE_SQ = (PROJ_SHOOTER_RANGE_GRID * G2W) * (PROJ_SHOOTER_RANGE_GRID * G2W);
let _prevPassHostileNear = 0;   // live hostiles within PROJ_SHOOTER_RANGE of the player, last pass (shooter presence)

const projHistory = new Map();
const dodgedActions = new Map();
const animCastDodged = new Map();   // anim-catchall fp -> anim-END expiry: dodgedActions' 1500ms TTL is shorter than the 7s casts this covers (review: chain-rolls) -- once rolled, the whole animation instance stays suppressed
const movePosHistory = new Map();   // entityId -> {d,time}: prev dist-to-player, to detect a MoveDaemon DIVE (closing speed)

// ANIM-ADVANCEMENT ANCHOR for the anim catch-all: entityId -> {dur,prog,at,seen}. `prog`/`at` move ONLY when the clip
// really advances, so a stationary clip accumulates elapsed time against a fixed anchor. `seen` refreshes every sample
// and drives pruning: pruning on `at` would drop a frozen boss's anchor and re-arm the chain-roll on any freeze longer
// than the prune window.
const _animAdv = new Map();
const ANIM_ADV_EPS = 0.04;        // seconds of clip advance that still counts as "playing"
const ANIM_ADV_WINDOW_MS = 250;   // same clip, no advance for this long => frozen/stunned/paused
const ANIM_ADV_PRUNE_MS = 5000;   // drop anchors of entities we stopped sampling

// A frozen boss holds animationProgress fixed while wall-clock advances, so the anim-instance fingerprint
// (start = now - prog, 700ms buckets) drifts into a fresh bucket forever => one catch-all roll per minIntervalMs for
// the whole freeze. An animation that is not advancing is not attacking. First sample of an entity is optimistic:
// advancement takes two samples to observe.
function animIsAdvancing(id, dur, prog) {
  const now = Date.now();
  const prev = _animAdv.get(id);
  if (!prev) {
    for (const [_k, _v] of _animAdv) if (now - _v.seen > ANIM_ADV_PRUNE_MS) _animAdv.delete(_k);   // bounded by uniques in scan range
    _animAdv.set(id, { dur, prog, at: now, seen: now });
    return true;
  }
  prev.seen = now;
  if (prev.dur !== dur || Math.abs(prog - prev.prog) >= ANIM_ADV_EPS) {
    prev.dur = dur; prev.prog = prog; prev.at = now;   // re-anchor: a new clip, or real advance
    return true;
  }
  return (now - prev.at) < ANIM_ADV_WINDOW_MS;   // stationary: still "playing" until the window proves it frozen
}

// CATCHALL TAME -- scoped to the two BOSS-ANIM catchall branches ONLY (boss-anim~catchall + the
// small-radius boss-cast fallback); geometry/ground/projectile/melee dodge classes untouched. A LOOPING
// boss anim legitimately re-passes animIsAdvancing every cycle (each loop = "a new cast"), so the
// catchall rolled the same anim once per minIntervalMs for a whole fight, cancelling every ChannelledSnipe.
// Three catchall-only suppressors: hard-CC'd owner (a frozen/electrocuted boss's cast never completes),
// a per-(entity,anim) dodge budget (we are RANGED -- an anim dodged twice that still hasn't hit us isn't
// hitting us), and a channel-hold published by rotation_builder via POE2Cache. false = byte-identical flow.
const CATCHALL_TAME_ON = true;
const CATCHALL_BUDGET_N = 2;             // same-(entity,anim) dodges inside the window before muting
const CATCHALL_BUDGET_WINDOW_MS = 10000;
const CATCHALL_MUTE_MS = 8000;
const CATCHALL_UNMUTE_HP_DROP = 8;       // effective-hp (hp+es) % drop since mute start = real damage -> unmute
const CATCHALL_HOLD_HP_FLOOR = 70;       // channel-hold only holds while player effective-hp >= this %
const CC_BUFF_TTL_MS = 50;               // per-entity hard-CC verdict cache (the C++ buff-cache granularity)
const _ccVerdicts = new Map();           // entityId -> {at, cc}
const _catchallDodges = new Map();       // entityId|hazardName -> {times:[], muteUntil, hpAtMute}
let _chHoldActive = false;               // computed once per scan from POE2Cache.channelHoldActive/Until
let _playerHpPct = 100;                  // effective (hp+es) % from this scan's player read
let _ccLogAt = 0, _chHoldLogAt = 0;      // suppress-log throttles

// Hard-CC probe scoped to ONE entity id: walks the shared per-frame entity list (lightweight+buffs,
// already built every frame by auto-attack during combat -> no new native scan) and caches the verdict
// 50ms. EXACT buff-name match: includes('frozen') would also match cannot_be_frozen-style auras and
// permanently suppress the catchall on such a boss.
function _ownerHardCCd(entityId) {
  if (!entityId) return false;
  const now = Date.now();
  const c = _ccVerdicts.get(entityId);
  if (c && now - c.at < CC_BUFF_TTL_MS) return c.cc;
  let cc = false;
  try {
    const shared = POE2Cache.getSharedEntities();
    if (shared) for (const se of shared) {
      if ((se.id || 0) !== entityId) continue;
      if (se.buffs) for (const b of se.buffs) {
        const bn = b && b.name;
        if (bn === 'frozen' || bn === 'electrocuted') { cc = true; break; }
      }
      break;
    }
  } catch (e) {}
  if (_ccVerdicts.size > 64) for (const [_k, _v] of _ccVerdicts) if (now - _v.at > 1000) _ccVerdicts.delete(_k);
  _ccVerdicts.set(entityId, { at: now, cc });
  return cc;
}

// Gate for BOTH catchall branches (and only them): true = don't synthesize the hazard this scan.
// Cheap checks first; the buff probe runs last and only for live catchall candidates.
function _catchallSuppressed(entityId, hazardName) {
  const now = Date.now();
  if (_chHoldActive && _playerHpPct >= CATCHALL_HOLD_HP_FLOOR) {
    if (now - _chHoldLogAt > 2000) { _chHoldLogAt = now; (CFG.log || console.log)('[AutoDodge] catchall held (channel active, hp ' + Math.round(_playerHpPct) + '%)'); }
    return true;
  }
  const st = _catchallDodges.get(entityId + '|' + hazardName);
  if (st && st.muteUntil > now) {
    if (_playerHpPct <= st.hpAtMute - CATCHALL_UNMUTE_HP_DROP) {
      st.muteUntil = 0; st.times.length = 0;   // real damage while muted: the anim IS reaching us -- dodge it again
      (CFG.log || console.log)('[AutoDodge] catchall ' + hazardName.split(':').pop() + ' unmuted (hp ' + Math.round(st.hpAtMute) + '% -> ' + Math.round(_playerHpPct) + '%)');
    } else return true;
  }
  if (_ownerHardCCd(entityId)) {
    if (now - _ccLogAt > 2000) { _ccLogAt = now; (CFG.log || console.log)('[AutoDodge] catchall skipped (owner frozen/electrocuted)'); }
    return true;
  }
  return false;
}

// Budget bookkeeping: called only for catchall hazards actually rolled against (the dodgedActions mark).
function _noteCatchallDodge(h, now) {
  if (h.kind !== 'boss_telegraph' || !h.name || h.name.indexOf('~catchall') < 0) return;
  const k = (h.entityId || 0) + '|' + h.name;
  let st = _catchallDodges.get(k);
  if (!st) {
    if (_catchallDodges.size > 128) for (const [_k, _v] of _catchallDodges) if (_v.muteUntil < now && (!_v.times.length || now - _v.times[_v.times.length - 1] > 30000)) _catchallDodges.delete(_k);
    st = { times: [], muteUntil: 0, hpAtMute: 100 };
    _catchallDodges.set(k, st);
  }
  while (st.times.length && now - st.times[0] > CATCHALL_BUDGET_WINDOW_MS) st.times.shift();
  st.times.push(now);
  if (st.times.length >= CATCHALL_BUDGET_N && st.muteUntil <= now) {
    st.muteUntil = now + CATCHALL_MUTE_MS;
    st.hpAtMute = _playerHpPct;
    (CFG.log || console.log)('[AutoDodge] catchall ' + h.name.split(':').pop() + ' x' + st.times.length + ' in 10s -> muted 8s');
  }
}

let lastDodgeAt = 0;
let lastScanAt = 0;
let lastHazards = [];
let _lastHazardsAt = 0;   // ts of the last hazard scan -> the debug overlay won't draw a stale (last-fight) set
let lastDecision = '';
let lastChosenDir = null;
let walkEgress = null;   // {dx,dy} unit heading when a single roll won't clear the hazard -> mapper keeps walking us out
let _egressHoldAt = 0;   // when the current escape heading was committed (held 2.5s -- anti direction-thrash)
let _egActiveSince = 0, _egProgAt = 0, _egPX = 0, _egPY = 0, _egCoolUntil = 0;   // escape progress watchdog state
let _reachHeldSince = 0, _reachHoldCool = 0;   // opener-reach hold: continuous in-field hold ts + post-cap walk-out cooldown
let _rollFails = 0, _lastRollPX = NaN, _lastRollPY = NaN, _lastRollT = 0;        // roll-displacement guard (rolling into a wall)
let blinkSkillCache = null;
let blinkLastCheck = 0;
let _dbgActions = [], _dbgAt = 0;   // diag: what nearby enemies are CASTING this scan (vs what we classify)
let _arenaShadowLogAt = 0;          // [ArenaShell] dodge would-penalize log throttle (>=2s)

export const AUTO_DODGE_DEFAULTS = {
  enabled: true,
  catBossTelegraphs: true,
  catRareEliteTelegraphs: true,
  catProjectiles: true,
  catGroundEffects: true,
  reachHoldActive: false,       // mapper-published: committed to a close openable + healthy -> hold against ALL risks (casts/fire) so the walker plants + the opener clicks; self-capped in-core + stands down for the on-open blast guard. false = byte-parity.
  catMeleeSwings: true,
  catDodgeInDangerZone: false,
  minSourceRarity: RARITY_NORMAL,
  bossMinRarity: RARITY_UNIQUE,
  rareEliteMinRarity: RARITY_MAGIC,
  meleeMinRarity: RARITY_NORMAL,
  meleeRangeWorld: 300,         // a no/low-aoe swing within this of us = a melee cone (targetless unique swings included)
  catNamedMelee: true,          // dodge NAMED boss/rare melee+slam+charge actions (Melee/DriveByCharge/EmptyActionSpell...)
  slamBaseReachWorld: 150,      // floor slam radius (world) when actionSkillRange + aoe both read 0 (un-populated)
  slamMaxReachWorld: 1700,      // clamp a junk SkillRange read (slab recycle) -> never a galaxy-wide "slam"
  chargeHalfAngleDeg: 22,       // half-width of the charge lane cone
  slamBoundsK: 2.0,             // entity-size scale: a BIG boss's boundsRadius*K out-reaches the flat floor; a small rare stays ~150
  slamBoundsFloorWorld: 60,     // additive melee reach beyond the monster's model bounds (boundsRadius*K + this)
  meleeReachCapWorld: 900,      // separate (lower) clamp for the MELEE path so a junk read can't become a 1700-world cone
  genericMeleeMinRarity: RARITY_RARE, // aoe0/geo0 generic swings (EmptyActionAttack/Melee) => rare+ only (over-dodge guard)
  genericMeleeOnSight: false,   // OFF until live-tested: fire a rare+ generic swing ON-SIGHT (bypass windup wait). false = windup-timed (parity)
  catMoveDaemonDive: false,     // OFF until live-tested: rare+ MoveDaemon CLOSING fast within range = a dive (a normal walk is NEVER dodged)
  moveDaemonDiveRangeWorld: 520,// only weigh a move as a dive when the mob is already this close (world)
  moveDaemonDiveSpeed: 700,     // min closing speed (world u/s toward the player) to call a move a dive, not a walk
  catDangerSkills: true,        // dodge lethal delayed-AoE detonations (corpse explosion / detonate-dead) regardless of the caster's rarity
  dangerReachFloorWorld: 250,   // floor radius (world) for a danger detonation when aoe/SkillRange read 0 (bigger than a melee swing -- corpse AoE is wide)
  minRadiusWorld: 0,
  minDurationMs: 0,
  lookaheadMs: 500,
  projLookaheadMs: 950,         // PROJECTILE roll window (wider than melee 500): a projectile on a collision course is rolled up to this ETA so a spear at eta 650-900 is actually dodged, not just "seen". Collision-course-gated so it doesn't over-dodge.
  minIntervalMs: 1800,
  postDodgeLockoutMs: 800,
  estimatedRollDist: 46,
  hpGateEnabled: false,
  hpGatePercent: 80,
  useBlink: false,
  scanRangeWorld: 2500,
  showDebug: false,
  allowList: '',
  denyList: '',
  mode: 'boss', // 'boss' | 'rare' | 'off' -- mapper sets this per frame
  catHazardMonsters: true,
  hazardMonsterRadius: 90,
  hazardMonsterKeywords: 'funguszombie,fungus,fungalburst,mushroom,volatile,detonat,suicide,bomb,kamikaze,corpse,explod',
  bossAreaTreatNormalAsHazard: true,
  // ARENA SHELL (mapper-published, boss mode only): disc keeping dodge landings off the invisible arena wall. null =
  // no shell -> penalty inert. arenaEnforce gates whether the penalty is APPLIED to scoring ('on') or only shadow-logged.
  arenaCX: null, arenaCY: null, arenaR: null, arenaEnforce: false,
  // Mapper-published: true only inside the real boss fight. The two synthetic BOSS CATCH-ALLS (anim-only, named
  // floor-up) fire on ANY unique in boss mode -- a rogue exile met on the walk-in got rolled away from instead of
  // killed. Real geometry telegraphs / projectiles / ground / melee nets stay live for uniques regardless.
  bossFightActive: false,
};

let CFG = { ...AUTO_DODGE_DEFAULTS };

function parseList(text) {
  if (!text) return [];
  return text.split(/[\n,]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
}

function nameMatches(name, list) {
  if (!name) return false;
  const lower = name.toLowerCase();
  for (const item of list) if (lower.includes(item)) return true;
  return false;
}

function isProjectileEntity(e) {
  const p = (e.path || '').toLowerCase();
  const n = (e.name || '').toLowerCase();
  for (const kw of PROJECTILE_KEYWORDS) {
    if (p.indexOf(kw) >= 0 || n.indexOf(kw) >= 0) return true;
  }
  if (!e.hasLife && !e.hasActor && !e.hasPlayer) {
    const bx = e.boundsX || 0;
    const by = e.boundsY || 0;
    if (bx > 0 && bx < 60 && by > 0 && by < 60 && p.indexOf('metadata/effects') >= 0) return true;
  }
  return false;
}

function getEntityRarity(e) {
  if (typeof e.rarity === 'number') return e.rarity;
  const sub = (e.entitySubtype || '').toString();
  if (sub.includes('Unique')) return RARITY_UNIQUE;
  if (sub.includes('Rare')) return RARITY_RARE;
  if (sub.includes('Magic')) return RARITY_MAGIC;
  return RARITY_NORMAL;
}

function dist2d(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

// Entity-SCALED melee reach (world): the REAL SkillRange stat, else the action aoe, else the monster's own body
// (boundsRadius*K + floor) -- so a BIG boss's swing reaches the player while a small rare stays ~150. Junk-clamped (a
// slab-recycled SkillRange/bounds read can never become a galaxy-wide "swing"). Shared by the named-slam + isMelee paths.
function meleeReachWorld(e, aoe) {
  const boundsR = Math.max(e.boundsX || 0, e.boundsY || 0);
  const scaled = boundsR * (CFG.slamBoundsK || 2.0) + (CFG.slamBoundsFloorWorld || 60);
  const r = Math.max((e.actionSkillRange > 0 ? e.actionSkillRange * G2W : 0), aoe || 0, scaled, CFG.slamBaseReachWorld || 150);
  return Math.min(r, CFG.meleeReachCapWorld || 900);   // lower cap than slamMaxReachWorld -- a junk read can't become a 1700-world cone
}

function detectBlinkSkill() {
  const now = Date.now();
  if (blinkSkillCache && now - blinkLastCheck < 2000) return blinkSkillCache;
  blinkLastCheck = now;
  const player = poe2.getLocalPlayer();
  if (!player || !player.activeSkills) { blinkSkillCache = null; return null; }
  for (const skill of player.activeSkills) {
    const n = (skill.skillName || skill.resolvedName || skill.skillType || '').toLowerCase();
    if (n.includes('blink')) {
      blinkSkillCache = skill;
      return skill;
    }
  }
  blinkSkillCache = null;
  return null;
}

function int32BE(value) {
  const v = Math.round(value) | 0;
  return [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
}

function gridVectorToScreenAngleDeg(dx, dy) {
  const screenX = dx - dy;
  const screenY = (dx + dy) / 2;
  return Math.atan2(screenY, screenX) * 180 / Math.PI;
}

function angleToDeltas(angleDegrees, distance) {
  if (distance === 0) return { dx: 0, dy: 0 };
  const rad = angleDegrees * Math.PI / 180;
  const screenX = Math.cos(rad);
  const screenY = Math.sin(rad);
  const isoX = screenX + screenY;
  const isoY = -screenX + screenY;
  const mag = Math.sqrt(isoX * isoX + isoY * isoY);
  return {
    dx: Math.round((isoX / mag) * distance),
    dy: Math.round((isoY / mag) * distance),
  };
}

function collectHazardsAndEnemies(player, now, allowList, denyList) {
  const out = [];
  const enemies = [];
  const px = player.worldX;
  const py = player.worldY;
  const maxRangeGrid = CFG.scanRangeWorld / G2W;

  let entities;
  try {
    entities = poe2.getEntities({ maxDistance: maxRangeGrid });
  } catch (e) { return { hazards: out, enemies }; }
  if (!entities) return { hazards: out, enemies };

  const enemyRangeWorld = (CFG.estimatedRollDist * 2 + 20) * G2W;
  const enemyRangeSq = enemyRangeWorld * enemyRangeWorld;
  const seenProjIds = new Set();
  const minRadius = CFG.minRadiusWorld;
  const minDurMs = CFG.minDurationMs;
  const lookahead = CFG.lookaheadMs;
  const mode = CFG.mode || 'boss';
  const hazardMonsterKeywords = parseList(CFG.hazardMonsterKeywords);
  if (CFG.debug) _dbgActions = [];

  for (const e of entities) {
    if (e.isLocalPlayer) continue;

    const ewx = e.worldX || 0;
    const ewy = e.worldY || 0;

    if (e.hasActor && e.isAlive && !e.isFriendly
        && !/^metadata\/npc\//i.test(e.path || e.name || '')) {   // friendly NPCs (Alva) read reaction=2 MonsterUnique -- they fed 'rare surround'/telegraph rolls
      const ddx = ewx - px;
      const ddy = ewy - py;
      if ((ddx * ddx + ddy * ddy) <= enemyRangeSq) {
        const _eAct = (e.actionSkillName || e.currentActionName || '').toLowerCase();
        enemies.push({
          wx: ewx,
          wy: ewy,
          radius: Math.max((e.boundsX || 0), (e.boundsY || 0), 30),
          rarity: getEntityRarity(e),
          acting: !!e.hasActiveAction && !!_eAct && _eAct !== 'move' && _eAct !== 'walk' && _eAct !== 'run' && _eAct !== 'idle',   // T0.3: actually doing something (not frozen/idle)?
        });
      }
    }

    if ((mode === 'boss' || mode === 'rare') && CFG.catProjectiles && isProjectileEntity(e) && e.id) {
      // OWN-FIRE FILTER (user: 'you dodge over NOTHING, red circles show nothing'): our IceShot arrows and
      // TornadoShotTornado deployables MATCH the projectile keywords ('shot'/'arrow'), and projectile entities
      // don't reliably populate isFriendly -- the bot was dodging its own fire all fight. ownerId is stamped
      // on player-fired projectiles; the tornado name catches the deployable even when ownerId reads 0.
      if (e.isFriendly || e.isMine || (e.ownerId && player.id && e.ownerId === player.id)
          || /tornadoshottornado/i.test(e.name || e.path || '')) continue;
      seenProjIds.add(e.id);
      const nameForFilter = e.name || e.path || '';
      if (/minion/i.test(nameForFilter)) continue;   // USER DIRECTIVE: ignore MINION projectiles (boss fight or not)
      if (denyList.length && nameMatches(nameForFilter, denyList)) continue;
      if (allowList.length && !nameMatches(nameForFilter, allowList)) continue;

      const prev = projHistory.get(e.id);
      let vx = 0, vy = 0;
      if (prev) {
        const dt = (now - prev.time) / 1000;
        if (dt > 0.001 && dt < 1.0) {
          vx = (ewx - prev.wx) / dt;
          vy = (ewy - prev.wy) / dt;
          if (prev.vx !== 0 || prev.vy !== 0) {
            vx = vx * 0.6 + prev.vx * 0.4;
            vy = vy * 0.6 + prev.vy * 0.4;
          }
        }
      }
      let speed = Math.sqrt(vx * vx + vy * vy);
      if (speed < 50 && prev) {
        // MEASURED slow across scans = a hovering deployable/field, NOT a flying projectile. The rotation
        // fallback below was fabricating an 800-speed lane along its facing -- every time it happened to
        // face the player, a phantom collision course rolled us. First sight (no history) keeps the fallback
        // (a real spear needs it before two samples exist).
        projHistory.set(e.id, { wx: ewx, wy: ewy, time: now, vx: 0, vy: 0, cvg: 0 });
        continue;
      }
      if (speed < 50 && typeof e.rotationZ === 'number'
          && (!PROJ_FALLBACK_NEEDS_SHOOTER || _prevPassHostileNear >= 1)) {   // no live shooter near the player => this stationary shot-named entity is spent/scenery/own fire, not an incoming lane
        const rot = e.rotationZ;
        const fallbackSpeed = 800;
        vx = Math.cos(rot) * fallbackSpeed;
        vy = Math.sin(rot) * fallbackSpeed;
        speed = fallbackSpeed;
      }
      const rec = { wx: ewx, wy: ewy, time: now, vx, vy, cvg: (prev && prev.cvg) || 0 };
      projHistory.set(e.id, rec);

      if (speed < 50) continue;

      const toPlayerX = px - ewx;
      const toPlayerY = py - ewy;
      const distToPlayer = Math.sqrt(toPlayerX * toPlayerX + toPlayerY * toPlayerY);
      if (distToPlayer < 1) continue;
      const dotPerSpeed = (vx * toPlayerX + vy * toPlayerY) / (speed * distToPlayer);
      // SEEKER detection: heading keeps pointing AT the player across consecutive scans = it re-aims (homing) -- linear
      // lane extrapolation misses it while we move, and it proximity-fuses. cvg >= 3 (~300ms of sustained convergence).
      rec.cvg = dotPerSpeed > 0.85 ? rec.cvg + 1 : 0;
      const homing = rec.cvg >= 3;
      if (dotPerSpeed < 0.3) continue;

      const eta = distToPlayer / speed * 1000;
      if (eta > lookahead * 2 && eta > 600) continue;

      // Homing: the impact IS the player (it will reach us) with a proximity-fuse blast -> guarantees the risk test fires
      // and the direction scorer pushes AWAY from the incoming line instead of a lane-sidestep it just re-tracks.
      const radius = homing ? Math.max((e.boundsX || 0), (e.boundsY || 0), 80) : Math.max((e.boundsX || 0), (e.boundsY || 0), 30);
      const t = Math.max(0, Math.min(1, eta / 1000));
      out.push({
        kind: 'projectile',
        startX: ewx,          // T0.1: spawn point -> the flight segment (start->impact) is the collision test in playerAtRisk
        startY: ewy,
        impactX: homing ? px : ewx + vx * t,
        impactY: homing ? py : ewy + vy * t,
        radius,
        etaMs: eta,
        score: homing ? 14 : 10,
        name: (e.name || e.path || 'projectile') + (homing ? '~seek' : ''),
        sourceRarity: RARITY_NORMAL,
        entityId: e.id,
      });
      continue;
    }

    // STATUE LASER TARGET: an invisible entity (e.g. InvisibleFire/MDVaalBossStatueLaserTarget) marks where a
    // statue beam LANDS -- no action, no projectile, no geometry; presence alone = danger. Circle it in boss AND
    // rare mode (arena statues keep firing after the boss dies).
    if ((mode === 'boss' || mode === 'rare') && e.isAlive !== false && /invisiblefire|lasertarget/i.test(e.name || '')) {
      const _lr = Math.max(CFG.hazardMonsterRadius, 120);
      const _ld = dist2d(px, py, ewx, ewy);
      out.push({
        kind: 'hazard_monster', impactX: ewx, impactY: ewy, radius: _lr,
        etaMs: _ld < _lr ? 0 : Math.max(0, (_ld - _lr) * 50), score: 12, name: e.name || 'laser_target',
      });
      continue;
    }

    // FUNGAL BURST SPAWNERS (live-RE'd): FungalBurstMushrooms/FungalBurstSpawner(+FungusBehemothPit) -- hostile
    // mushroom TERRAIN with no Life/Actor (the hazard-monster branch can't see them) that chain-explodes underfoot;
    // they RING the Fungus Behemoth pit (standing on one mid-boss = death). Presence = danger circle sized by the
    // spawner's bounds; boss AND rare mode. The sustained walk-egress keeps us out of the patch.
    if ((mode === 'boss' || mode === 'rare') && /fungalburst/i.test(e.name || '')) {
      const _fr = Math.max((e.boundsX || 0) * 1.2, CFG.hazardMonsterRadius);
      const _fd = dist2d(px, py, ewx, ewy);
      out.push({
        kind: 'hazard_monster', impactX: ewx, impactY: ewy, radius: _fr,
        etaMs: _fd < _fr ? 0 : Math.max(0, (_fd - _fr) * 50), score: 11, name: e.name || 'fungal_burst',
      });
      continue;
    }

    // BOSS TARGET MARKER (live-RE'd on GuillotineExecutioner "Incarnation of Death"): 30 serialized
    // ExecutionerBossTargetMarker entities sit at (0,0) until the boss ARMS one -- the armed one carries the
    // real coords of the incoming drop (the anvil). Marker-with-real-coords = impact incoming at that spot;
    // dormant (0,0) ones self-exclude by distance. Same presence-only contract as the laser above.
    if ((mode === 'boss' || mode === 'rare') && /bosstargetmarker/i.test(e.name || '')) {
      const _mr = Math.max(CFG.hazardMonsterRadius, 100);
      const _md = dist2d(px, py, ewx, ewy);
      out.push({
        kind: 'hazard_monster', impactX: ewx, impactY: ewy, radius: _mr,
        etaMs: _md < _mr ? 0 : Math.max(0, (_md - _mr) * 50), score: 12, name: e.name || 'boss_target_marker',
      });
      continue;
    }

    // HAZARD MONSTER: normal-rarity self-detonating actors (e.g. FungusZombie "exploding mushrooms").
    // Rarity gate / ground-effect category / actionSkillAoE all miss these -- match by metadata name.
    if (mode === 'boss' && CFG.catHazardMonsters && e.hasActor && e.isAlive && !e.isFriendly &&
        nameMatches((e.name || '').toLowerCase(), hazardMonsterKeywords)) {
      const radius = Math.max(e.boundsX || 0, e.boundsY || 0, CFG.hazardMonsterRadius);
      const d = dist2d(px, py, ewx, ewy);
      out.push({
        kind: 'hazard_monster',
        impactX: ewx,
        impactY: ewy,
        radius,
        etaMs: d < radius ? 0 : Math.max(0, (d - radius) * 50),
        score: 11,
        name: e.name || 'hazard_monster',
        sourceRarity: RARITY_NORMAL,
        entityId: e.id || 0,
        fingerprint: e.id,
      });
      continue;
    }

    // Ground effects (shocked/ignited/caustic) now handled in BOSS *and* RARE (map-clearing) mode -- previously boss-only,
    // so the bot walked through shocked/ignited ground while clearing and took the damage with no reaction (user 2026-07-03
    // "ignited ground bad", "standing next to shocked ground"). Safe to enable now that the +0x48 radius reads REAL (185w
    // live-verified), not the old phantom-40w floor that inflated many small patches into a wall + fled into a corner.
    if ((mode === 'boss' || mode === 'rare') && CFG.catGroundEffects) {
      const isGfxByComponent = !!e.hasGroundEffect;
      const isGfxByPath = !isGfxByComponent && e.path && (e.path.includes('ground_effect') || e.path.includes('GroundEffect'));
      if (isGfxByComponent || isGfxByPath) {
        if (e.isFriendly) continue;
        const gname = e.groundEffectName || e.name || e.path || '';
        if (denyList.length && nameMatches(gname, denyList)) continue;
        if (allowList.length && !nameMatches(gname, allowList)) continue;

        // TRUE damage radius from GroundEffect+0x48 (grid units -> world via G2W). The old model-bounds (~30) gave a
        // bogus 40 floor, so screen-filling clouds (CausticCloud ~282 world) read as tiny -> bot stood in them + died.
        // Clamp the radius: +0x48-as-radius is a 2-sample RE -- a recycled-slab junk value (the AV-storm note) or a
        // per-type growth COUNTER could read huge and make the bot flee a small puddle screen-wide. Real clouds top
        // out ~282 world; cap at 350 so a bad read can't trigger a panic-dodge.
        // The +0x48 radius field (groundEffectRadiusGrid) isn't in the LIVE DLL yet (uncommitted C++ edit) -> undefined at
        // runtime -> falls back to ~40w model bounds. NOTE: a 110w boss-mode floor was tried and BACKFIRED -- it inflated
        // each of the MANY small IgnitedGround patches into overlapping 110w fields, so the dodge saw a wall of fire and
        // fled repeatedly into a corner ("burnt me into the wall"). Reverted to 40. Big single clouds (Caustic ~282w)
        // still under-read until the DLL is REBUILT to emit the real per-effect radius -- a flat floor can't fix both.
        const G_RAD = Math.min((e.groundEffectRadiusGrid > 0) ? e.groundEffectRadiusGrid * G2W : Math.max((e.boundsX || 0), (e.boundsY || 0), 40), 350);
        const radius = G_RAD;
        const d = dist2d(px, py, ewx, ewy);
        if (d > radius + CFG.estimatedRollDist * G2W + 30) continue;
        out.push({
          kind: 'ground',
          impactX: ewx,
          impactY: ewy,
          radius,
          etaMs: d < radius ? 0 : Math.max(0, (d - radius) * 50),
          score: 8,
          name: gname,
          sourceRarity: RARITY_NORMAL,
          entityId: e.id || 0,
        });
        continue;
      }
    }

    // HOSTILE DEPLOYABLE-AoE FIELD (2026-07-02): boss/rare tornados/clouds/fire-fields are NPC/Effect DEPLOYABLES -- no
    // GroundEffect component AND no active action (a persistent field, not "acting"), so they fall through the ground-
    // effect branch above AND the actor gate below (!hasActiveAction -> skip) -> DODGE-SEES:NONE -> the bot stands in them
    // and dies (the ChaosGodOwl tornado). Catch a HOSTILE, NON-Monster (so we flee FIELDS, never a monster body or our own
    // friendly Tornado Shot) entity whose .ao path is a damaging field (DANGEROUS_EFFECT_RX). Radius from bounds (live
    // tornado read ~85w), floor 90, cap 350. No `continue`: a field has no action so the gate below skips it anyway; if a
    // matched entity also acts, it keeps its real telegraph. This only ADDS coverage so it can't regress the dodge.
    // GATE: NPC/Effect ONLY -- NOT Renderable. The map is full of HOSTILE Renderable DECORATIONS (live-verified on Rudja's
    // mine: Mine/HorizontalBeam, BeastCorruption/GroundCorruption, Quarry clutter -- all isHostile:true) whose paths match
    // the hazard list; fleeing those would strand the bot mid-map. Real damaging FIELDS are NPC deployables (the Tornado
    // Shot type) or Effect entities. Boss CASTS (flame etc.) are active actions -> handled by the geometry/actor branch below.
    if ((mode === 'boss' || mode === 'rare') && (e.entityType === 'NPC' || e.entityType === 'Effect') && !e.isFriendly && !e.isAllied) {
      const _dp = ((e.baseEntityPath || e.path || e.name || '') + '');
      if (DANGEROUS_EFFECT_RX.test(_dp) && !(denyList.length && nameMatches(_dp, denyList))) {
        const radius = Math.min(Math.max((e.boundsX || 0), (e.boundsY || 0), 90), 350);
        const d = dist2d(px, py, ewx, ewy);
        if (d <= radius + CFG.estimatedRollDist * G2W + 30) {
          out.push({ kind: 'ground', impactX: ewx, impactY: ewy, radius,
            etaMs: d < radius ? 0 : Math.max(0, (d - radius) * 50), score: 9,
            name: _dp.split('/').pop(), sourceRarity: RARITY_NORMAL, entityId: e.id || 0 });
        }
      }
    }

    // ANIMATION-ONLY BOSS CAST (Caedron frontal wave / Manassa class): some boss attacks carry NO action object at
    // all -- hasActiveAction FALSE while a LONG animation plays (live dump mid-wave: boss-doing none aoe=0 geo=0
    // dur=7.0 prog=0.6). The actor gate below drops them -> DODGE-SEES-NONE while the wave lands. In boss mode, an
    // ENGAGED (hp<max: dormant idle-loop bosses stay exempt) unique with a playing long animation and no action =
    // an unnamed attack: synthesize a floor-radius telegraph at us. Review hardening: (a) caster must be within
    // 1400w (a cross-arena idler can't put us "inside" a player-centered circle); (b) animationName, when readable,
    // filters reposition/idle clips -- and is surfaced in the hazard name so live logs can grow the deny list;
    // (c) ONE roll per animation INSTANCE for real: dodgedActions' 1500ms TTL is shorter than these casts, so a
    // rolled fingerprint is promoted into animCastDodged with an anim-END expiry (no chain-rolls, no channel spam).
    if (mode === 'boss' && CFG.bossFightActive === true && CFG.catBossTelegraphs && e.hasActor && !e.hasActiveAction && e.isAlive && !e.isFriendly
        && (e.healthCurrent || 0) < (e.healthMax || 1) && dist2d(px, py, ewx, ewy) <= 1400
        && getEntityRarity(e) === RARITY_UNIQUE
        && !/minion/i.test(e.name || '') && !/^metadata\/npc\//i.test(e.path || e.name || '')) {
      const _adur = e.animationDuration || 0, _aprog = e.animationProgress || 0;
      const _anm = (e.animationName || '').toLowerCase();
      if (_adur >= 1.5 && _aprog >= 0.25 && (_adur - _aprog) > 0.35
          && !(_anm && /idle|walk|run|move|turn|stand|death|spawn|emerge|taunt/.test(_anm))
          && animIsAdvancing(e.id || 0, _adur, _aprog)) {   // frozen/stunned clip = not attacking (sampled last: only clips that reach the push)
        const _nowA = Date.now();
        const _abFp = (e.id || 0) + '_anim_' + Math.round((_nowA - _aprog * 1000) / 700);
        for (const [_k3, _exp3] of animCastDodged) if (_exp3 < _nowA) animCastDodged.delete(_k3);
        if (dodgedActions.has(_abFp)) animCastDodged.set(_abFp, _nowA + Math.max(0, _adur - _aprog) * 1000 + 2000);
        const _abName = 'boss-anim~catchall' + (_anm ? ':' + _anm : '');
        if (!animCastDodged.has(_abFp) && !dodgedActions.has(_abFp)
            && !(CATCHALL_TAME_ON && _catchallSuppressed(e.id || 0, _abName))) {
          out.push({
            kind: 'boss_telegraph', impactX: px, impactY: py, radius: Math.max(minRadius, 260),
            etaMs: Math.min((_adur - _aprog) * 1000, 900), score: 11,
            name: _abName,
            sourceRarity: RARITY_UNIQUE, entityId: e.id || 0, fingerprint: _abFp,
          });
        }
      }
    }

    if (!e.hasActor || !e.hasActiveAction || !e.isAlive || e.isFriendly) continue;
    if (/minion/i.test(e.name || '')) continue;   // USER DIRECTIVE: NEVER dodge MINION attacks, even on bosses -- only the actual boss matters
    if (/^metadata\/npc\//i.test(e.path || e.name || '')) continue;   // friendly NPCs (Alva = reaction2 MonsterUnique) act constantly; their swings are not telegraphs

    if (CFG.debug) {
      _dbgActions.push({ n: (e.name || '').split('/').pop(), sk: e.actionSkillName || e.currentActionName || '?',
        aoe: e.actionSkillAoE || 0, geo: e.hasGeometryAttack ? (e.geometryShape || 0) : 0, gr: Math.round(e.geometryRadius || 0),
        tgt: (e.actionTargetX || e.actionTargetY) ? 1 : 0, rar: getEntityRarity(e), d: Math.round(dist2d(px, py, ewx, ewy) / G2W) });
    }

    const tx = e.actionTargetX;
    const ty = e.actionTargetY;
    const hasTarget = !!(tx || ty);
    let twx, twy;
    if (hasTarget) {
      twx = tx * G2W; twy = ty * G2W;
    } else {
      // No actionTarget = a melee swing aimed at US (unique/boss melee usually sets none). Aim the cone at
      // the player so we still dodge it; skip only if the caster is too far to be a melee threat. THE GAP:
      // `if (!tx && !ty) continue;` silently dropped every targetless unique swing -> we never dodged them.
      // FIX (verify): a rare+ NAMED slam/charge out-reaches the flat 300 -> gate it by the SCALED reach, else this
      // line drops a big-boss targetless slam BEFORE the named block ever runs (the DODGE-SEES:NONE death). Trash
      // (below rare, or unnamed) keeps the flat 300 so nothing new is over-dodged.
      const _rar = getEntityRarity(e);
      const _sn = e.actionSkillName || e.currentActionName || e.name || '';
      const _gate = (_rar >= RARITY_RARE && (nameMatches(_sn, SLAM_KEYWORDS) || nameMatches(_sn, CHARGE_KEYWORDS)))
        ? meleeReachWorld(e, e.actionSkillAoE || 0) + CFG.estimatedRollDist * G2W
        : CFG.meleeRangeWorld;
      if (dist2d(ewx, ewy, px, py) > _gate) continue;
      twx = px; twy = py;
    }
    const aoe = e.actionSkillAoE || 0;
    const animDur = e.animationDuration || 0;
    const animProg = e.animationProgress || 0;
    const remainMs = (animDur - animProg) * 1000;

    // Geometry-attack telegraph: derive a real radius/shape (geometryRadius is GRID units -> *G2W).
    // NEVER zero: geometryRadius==0 means "use distance-to-target"; fall back to aoe then dist(caster,target).
    const hasGeo = !!e.hasGeometryAttack;
    const geoRadiusGrid = e.geometryRadius || 0;
    let effectiveRadius = aoe;
    let geoShape = 0;
    if (hasGeo) {
      geoShape = e.geometryShape || 0;
      const casterToTarget = dist2d(ewx, ewy, twx, twy);
      effectiveRadius = geoRadiusGrid > 0 ? geoRadiusGrid * G2W : (aoe > 0 ? aoe : casterToTarget);
    }

    if (animDur > 0 && remainMs < 50) continue;
    if (animDur > 0 && (animDur * 1000) < minDurMs) continue;

    const isMelee = aoe <= 0 && dist2d(ewx, ewy, twx, twy) < CFG.meleeRangeWorld;
    const rarity = getEntityRarity(e);
    const isBoss = rarity === RARITY_UNIQUE;
    const isRareElite = rarity === RARITY_RARE || rarity === RARITY_MAGIC;

    const skillName = e.actionSkillName || e.currentActionName || e.name || '';
    if (denyList.length && nameMatches(skillName, denyList)) continue;
    if (allowList.length && !nameMatches(skillName, allowList)) continue;

    // ---- NAMED BOSS/RARE MELEE-SLAM / CHARGE (the aoe0 geo0 gr0 blind spot) -----------------------------------
    // These carry NO aoe/geometry/ground flag, so the geometry branches never fire and the isMelee block below drops
    // anything past its hardcoded 200u reach -- which is why a 54u/125u boss slam logged DODGE-SEES:NONE. Match by
    // ACTION NAME, size the threat from the REAL actionSkillRange stat (aoe / floor fallback, junk clamp), emit a
    // circle (slam) or a lane cone (charge), and let chooseDodgeDirection roll out/perpendicular. One dodge per action
    // (fingerprint), rarity-gated, windup-timed. Reuses the existing boss/rare_telegraph hazard handling.
    {
      const _isCharge = nameMatches(skillName, CHARGE_KEYWORDS);
      const _isDanger = CFG.catDangerSkills && nameMatches(skillName, DANGER_KEYWORDS);   // corpse/dead-area detonation -- lethal from ANY rarity
      const _isSlam = !_isCharge && !_isDanger && nameMatches(skillName, SLAM_KEYWORDS);
      const _skl = (skillName || '').toLowerCase();
      const _isMove = _skl === 'move' || _skl === 'walk' || _skl === 'run' || _skl === 'idle'
        || _skl.includes('flee') || _skl.includes('face') || _skl.includes('turn');
      // GENERIC melee = a swing with NO readable telegraph geometry (aoe0 geo0) -- EmptyActionAttack/Melee live here.
      // At rare+ we CAN fire ON-SIGHT (bypass the windup-tail wait), behind genericMeleeOnSight (default OFF until live-
      // tested). Trash (normal/magic) stays windup-timed to avoid over-dodge.
      const _genericMelee = (aoe <= 0) && !hasGeo;
      const _fireOnSight = CFG.genericMeleeOnSight && _genericMelee && rarity >= (CFG.genericMeleeMinRarity != null ? CFG.genericMeleeMinRarity : RARITY_RARE);
      // MOVEDAEMON DIVE (behind catMoveDaemonDive, default OFF): a rare+ boss animating 'Move'/'MoveDaemon' CLOSING on us
      // fast within dive range is a gap-closer, not a walk. Hard-guarded (rarity + closing SPEED + range) so a normal
      // reposition is NEVER dodged.
      let _isDive = false;
      const _isMoveAction = _skl === 'move' || _skl === 'movedaemon';
      if (_isMoveAction && CFG.catMoveDaemonDive && (mode === 'boss' || mode === 'rare') && rarity >= RARITY_RARE) {
        const _dNow = dist2d(ewx, ewy, px, py);
        if (_dNow <= (CFG.moveDaemonDiveRangeWorld || 520)) {
          const _prev = movePosHistory.get(e.id || 0);
          movePosHistory.set(e.id || 0, { d: _dNow, time: now });
          if (_prev && now > _prev.time) {
            const _closeSpeed = (_prev.d - _dNow) / ((now - _prev.time) / 1000);   // world u/s toward the player (+ = closing)
            if (_closeSpeed >= (CFG.moveDaemonDiveSpeed || 700)) _isDive = true;
          }
        }
      }
      const _namedFp = (e.id || 0) + '_' + (e.actionPtr || 0);
      // windup tail (or no duration -> fire on sight); a rare+ GENERIC swing bypasses the windup wait ONLY when enabled.
      const _windupOk = !(animDur > 0) || remainMs <= CFG.lookaheadMs || _fireOnSight;
      if ((_isSlam || _isCharge || _isDive || _isDanger) && (!_isMove || _isDive) && CFG.catNamedMelee
          && (mode === 'boss' || mode === 'rare') && (rarity >= CFG.meleeMinRarity || _isDanger)
          && !dodgedActions.has(_namedFp) && _windupOk) {
        // per-action reach: entity-SCALED (real SkillRange -> aoe -> boundsRadius*K+floor -> 150), junk-clamped, so a
        // BIG boss's swing reaches us while a small rare stays ~150. A DANGER detonation floors WIDER (corpse AoE).
        const _reachWorld = _isDanger ? Math.max(meleeReachWorld(e, aoe), CFG.dangerReachFloorWorld || 250) : meleeReachWorld(e, aoe);
        if (_isCharge || _isDive) {
          // CHARGE/DIVE: a line hit toward the action TARGET (else toward us). Narrow lane cone -> roll PERPENDICULAR out.
          const _cdx = (hasTarget ? twx : px) - ewx, _cdy = (hasTarget ? twy : py) - ewy;
          const _cl = Math.sqrt(_cdx * _cdx + _cdy * _cdy) || 1;
          const _laneLen = (hasTarget ? dist2d(ewx, ewy, twx, twy) : dist2d(ewx, ewy, px, py)) + CFG.estimatedRollDist * G2W + 120;
          out.push({
            kind: isBoss ? 'boss_telegraph' : 'rare_telegraph', name: skillName,
            impactX: ewx + (_cdx / _cl) * _laneLen * 0.5, impactY: ewy + (_cdy / _cl) * _laneLen * 0.5,
            radius: _laneLen,
            coneOriginX: ewx, coneOriginY: ewy, coneDirX: _cdx / _cl, coneDirY: _cdy / _cl,
            coneHalfAngle: (CFG.chargeHalfAngleDeg || 22) * Math.PI / 180,
            etaMs: Math.max(0, remainMs), score: isBoss ? 12 : 8,
            sourceRarity: rarity, entityId: e.id || 0, fingerprint: _namedFp,
          });
          continue;
        }
        // OVER-DODGE GUARD: only a threat if WE are within striking distance of the caster. A GENERIC swing -> player-
        // aimed 120deg CONE (toward the action target if set, else us) so pointInHazard drops swings aimed elsewhere AND
        // the perpendicular sidestep works. A REAL radial slam (aoe/geo readable) keeps the circle at its impact spot.
        if (_genericMelee && !_isDanger) {
          if (dist2d(ewx, ewy, px, py) <= _reachWorld + CFG.estimatedRollDist * G2W) {
            const _sdx = (hasTarget ? twx : px) - ewx, _sdy = (hasTarget ? twy : py) - ewy;
            const _sl = Math.sqrt(_sdx * _sdx + _sdy * _sdy) || 1;
            out.push({
              kind: isBoss ? 'boss_telegraph' : 'rare_telegraph', name: skillName,
              impactX: ewx + (_sdx / _sl) * _reachWorld * 0.5, impactY: ewy + (_sdy / _sl) * _reachWorld * 0.5,
              radius: _reachWorld,
              coneOriginX: ewx, coneOriginY: ewy, coneDirX: _sdx / _sl, coneDirY: _sdy / _sl,
              coneHalfAngle: Math.PI / 3,   // 120deg total, aimed at the player/target
              etaMs: Math.max(0, remainMs), score: isBoss ? 12 : 7,
              sourceRarity: rarity, entityId: e.id || 0, fingerprint: _namedFp,
            });
            continue;
          }
        } else {
          // SLAM: circle at the impact (the targeted spot, else us). Only a threat if WE are inside it.
          const _ix = hasTarget ? twx : px, _iy = hasTarget ? twy : py;
          if (dist2d(_ix, _iy, px, py) <= _reachWorld + CFG.estimatedRollDist * G2W) {
            out.push({
              kind: isBoss ? 'boss_telegraph' : 'rare_telegraph', name: skillName,
              impactX: _ix, impactY: _iy, radius: _reachWorld,
              etaMs: Math.max(0, remainMs), score: isBoss ? 12 : 7,
              sourceRarity: rarity, entityId: e.id || 0, fingerprint: _namedFp,
            });
            continue;
          }
        }
      }
    }

    if (isMelee) {
      if (mode !== 'boss' && mode !== 'rare') continue;
      if (!CFG.catMeleeSwings) continue;
      if (rarity < CFG.meleeMinRarity) continue;
      if (animDur > 0 && remainMs > lookahead) continue;
      const skillLower = (skillName || '').toLowerCase();
      if (skillLower === 'move' || skillLower === 'walk' || skillLower === 'run' || skillLower === 'idle'
        || skillLower.includes('flee') || skillLower.includes('face') || skillLower.includes('turn')) continue;   // reposition/move anims are NOT attacks -- don't dodge them
      const meleeFp = (e.id || 0) + '_' + (e.actionPtr || 0);
      if (dodgedActions.has(meleeFp)) continue;
      const distToPlayer = dist2d(px, py, ewx, ewy);
      const meleeReach = meleeReachWorld(e, aoe);   // entity-SCALED (was flat 200): big boss out-reaches, small rare ~150, cap 900
      if (distToPlayer > meleeReach + CFG.estimatedRollDist * G2W) continue;
      const dirX = twx - ewx;
      const dirY = twy - ewy;
      const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
      if (dirLen < 1) continue;
      out.push({
        kind: 'melee',
        impactX: ewx + (dirX / dirLen) * meleeReach * 0.5,
        impactY: ewy + (dirY / dirLen) * meleeReach * 0.5,
        radius: meleeReach,
        coneOriginX: ewx,
        coneOriginY: ewy,
        coneDirX: dirX / dirLen,
        coneDirY: dirY / dirLen,
        coneHalfAngle: Math.PI / 3,
        etaMs: Math.max(0, remainMs),
        score: isBoss ? 9 : 6,
        name: skillName,
        sourceRarity: rarity,
        entityId: e.id || 0,
        fingerprint: meleeFp,
      });
      continue;
    }

    // BOSS-CAST CATCH-ALL (user: 'you didn't dodge a SINGLE thing he cast'): a unique's cast with NO readable
    // geometry (aoe0 geo0, name matching no slam/charge/danger keyword -- Malgor's whole kit) fell through every
    // branch = DODGE-SEES:NONE for the entire fight. Any surviving boss action in boss mode becomes a floor-radius
    // circle at its aim point (target coords, or us), windup-timed + fingerprinted (one dodge per cast). Trash and
    // rares keep the strict branches -- this only widens BOSSES, where an undodged cast is the death class.
    if (effectiveRadius < minRadius && isBoss && mode === 'boss' && CFG.bossFightActive === true && CFG.catBossTelegraphs) {
      // Covers BOTH no-geometry casts (radius 0) AND small-readable-radius casts: the min-radius gate below
      // silently dropped a boss cast whose readable radius was tiny -- for bosses, floor it up instead.
      // REPOSITION GUARD: move/idle actions fall through the named block WITHOUT a continue -- a WALKING boss
      // must not become a phantom hazard (constant false circles at his move target).
      const _skl2 = (skillName || '').toLowerCase();
      if (!_skl2 || _skl2 === 'move' || _skl2 === 'movedaemon' || _skl2 === 'walk' || _skl2 === 'run' || _skl2 === 'idle'
          || _skl2.includes('flee') || _skl2.includes('face') || _skl2.includes('turn')) continue;
      const _bcFp = (e.id || 0) + '_' + (e.actionPtr || 0);
      const _bcName = (skillName || 'boss-cast') + '~catchall';
      if (!dodgedActions.has(_bcFp) && !(animDur > 0 && remainMs > lookahead)
          && !(CATCHALL_TAME_ON && _catchallSuppressed(e.id || 0, _bcName))) {
        out.push({
          kind: 'boss_telegraph', impactX: twx, impactY: twy, radius: Math.max(minRadius, 240),
          etaMs: Math.max(0, remainMs), score: 11, name: _bcName,
          sourceRarity: rarity, entityId: e.id || 0, fingerprint: _bcFp,
        });
      }
      continue;
    }
    if (effectiveRadius <= 0) continue;
    if (effectiveRadius < minRadius) continue;
    let treatAsBoss = false;
    if (isBoss) {
      if (!CFG.catBossTelegraphs) continue;
      if (rarity < CFG.bossMinRarity) continue;
      treatAsBoss = true;
    } else if (isRareElite) {
      if (!CFG.catRareEliteTelegraphs) continue;
      if (rarity < CFG.rareEliteMinRarity) continue;
    } else if (mode === 'boss' && CFG.bossAreaTreatNormalAsHazard && rarity === RARITY_NORMAL && effectiveRadius > 0) {
      treatAsBoss = true; // normal-rarity geometry telegraph in a boss area -> treat as boss_telegraph
    } else {
      continue;
    }
    if (remainMs > lookahead && animDur > 0) continue;
    const aoeFp = (e.id || 0) + '_' + (e.actionPtr || 0);
    if (dodgedActions.has(aoeFp)) continue;

    // Shape 2(Cone)/3(Rect) = cone (reuse melee cone fields); 1(Circle)/4(Nova) = circle ignoring angle.
    if (hasGeo && (geoShape === 2 || geoShape === 3)) {
      const dirX = twx - ewx;
      const dirY = twy - ewy;
      const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
      if (dirLen < 1) continue;
      const halfAngle = ((e.geometryAngle > 0 ? e.geometryAngle : 120) / 2) * Math.PI / 180;
      out.push({
        kind: treatAsBoss ? 'boss_telegraph' : 'rare_telegraph',
        impactX: ewx + (dirX / dirLen) * effectiveRadius * 0.5,
        impactY: ewy + (dirY / dirLen) * effectiveRadius * 0.5,
        radius: effectiveRadius,
        coneOriginX: ewx,
        coneOriginY: ewy,
        coneDirX: dirX / dirLen,
        coneDirY: dirY / dirLen,
        coneHalfAngle: halfAngle,
        etaMs: Math.max(0, remainMs),
        score: treatAsBoss ? 12 : 7,
        name: skillName,
        sourceRarity: rarity,
        entityId: e.id || 0,
        fingerprint: aoeFp,
      });
      continue;
    }

    out.push({
      kind: treatAsBoss ? 'boss_telegraph' : 'rare_telegraph',
      impactX: twx,
      impactY: twy,
      radius: effectiveRadius,
      etaMs: Math.max(0, remainMs),
      score: treatAsBoss ? 12 : 7,
      name: skillName,
      sourceRarity: rarity,
      entityId: e.id || 0,
      fingerprint: aoeFp,
    });
  }

  for (const [id, entry] of projHistory) {
    if (!seenProjIds.has(id) && now - entry.time > PROJ_HISTORY_TTL) {
      projHistory.delete(id);
    }
  }
  for (const [fp, t] of dodgedActions) {
    if (now - t > DODGED_ACTION_TTL_MS) dodgedActions.delete(fp);
  }
  for (const [id, entry] of movePosHistory) {
    if (now - entry.time > PROJ_HISTORY_TTL) movePosHistory.delete(id);
  }

  // SOFT-GROUND TRAVERSAL EXEMPTION (user): chilled/shocked/ignited/burning floors are only a threat UNDER
  // FIRE -- the slow/degen alone can't kill a moving character, and roll-thrashing across every puddle turned
  // Slick's floors into a minutes-long crawl. Strip them when NO hostile is within ~70 grid AND nothing in
  // scan range is actively attacking (the line-of-fire proxy); any threat reinstates the zones (slowed under
  // fire IS lethal). Truly lethal ground (caustic/degen pools) never matches and is never stripped.
  if (out.length) {
    // Soft list includes spent ABYSS CRACKS: post-event crack scenery classifies as a ground hazard and had the
    // bot rolling 'over nothing' while walking the abyss trail; during the live event its mobs are within 70u
    // anyway, so the zones re-arm exactly when they matter. NOTE: the earlier `en.acting` clause is GONE --
    // wandering counts as an action, so any moving mob within ~112u was re-arming every puddle (rolls over nothing).
    const _soft = /chill|coldsnap|shock|ignit|burn|abysscrack/i;
    const _r70sq = (70 * G2W) * (70 * G2W);
    let _hostileNear = false;
    for (const en of enemies) {
      const _dx = en.wx - px, _dy = en.wy - py;
      if (_dx * _dx + _dy * _dy <= _r70sq) { _hostileNear = true; break; }
    }
    if (!_hostileNear) {
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].kind === 'ground' && _soft.test(out[i].name || '')) out.splice(i, 1);
      }
    }
  }

  // Cache shooter presence for NEXT pass's projectile first-sight rotation fallback (enemies[] is complete here).
  if (PROJ_FALLBACK_NEEDS_SHOOTER) {
    let _near = 0;
    for (const en of enemies) {
      const _dx = en.wx - px, _dy = en.wy - py;
      if (_dx * _dx + _dy * _dy <= PROJ_SHOOTER_RANGE_SQ) _near++;
    }
    _prevPassHostileNear = _near;
  }
  return { hazards: out, enemies };
}

function hazardPenalty(wx, wy, h) {
  if (h.coneOriginX !== undefined) {
    const dx = wx - h.coneOriginX;
    const dy = wy - h.coneOriginY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > h.radius || len < 1) return 0;
    const dot = (dx * h.coneDirX + dy * h.coneDirY) / len;
    const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (ang >= h.coneHalfAngle) return 0;
    return h.score * (1 - len / h.radius);
  }
  const dx = wx - h.impactX;
  const dy = wy - h.impactY;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d >= h.radius) return 0;
  return h.score * (1 - d / h.radius);
}

function pointInHazard(wx, wy, h) {
  return hazardPenalty(wx, wy, h) > 0;
}

// T0.1: does the projectile's flight segment (spawn -> extrapolated impact at ETA) pass within (its radius + the player
// body) of the player? Reuses segmentIntersectsCircle. This is the ACTUAL-COLLISION test the old ETA-alone check missed
// -- in a dense pack most projectiles are loosely toward the player (dot>0.3) but MISS; ETA-alone rolled on every one.
function projectileThreatensPlayer(px, py, h) {
  if (h.startX === undefined) return true;   // no spawn recorded -> permissive fallback
  return segmentIntersectsCircle(h.startX, h.startY, h.impactX, h.impactY, px, py, (h.radius || 30) + PLAYER_BODY_WORLD);
}

function playerAtRisk(px, py, hazards) {
  for (const h of hazards) {
    if (h.kind === 'projectile') {
      if (h.etaMs <= (CFG.projLookaheadMs || CFG.lookaheadMs) && projectileThreatensPlayer(px, py, h)) return true;   // wider projectile window: roll a spear at eta 650-900, not just <=500 (collision-course-gated)
      continue;
    }
    if (pointInHazard(px, py, h)) return true;
  }
  return false;
}

function scoreCandidatePos(wx, wy, hazards) {
  let score = 0;
  for (const h of hazards) score += hazardPenalty(wx, wy, h);
  return score;
}

function enemyPenalty(wx, wy, enemies) {
  let total = 0;
  for (const e of enemies) {
    const dx = wx - e.wx;
    const dy = wy - e.wy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const buffer = e.radius + 50;
    if (d < buffer) total += 20 * (1 - d / buffer);
  }
  return total;
}

function segmentIntersectsCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / lenSq : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const px = ax + t * dx;
  const py = ay + t * dy;
  const ddx = px - cx;
  const ddy = py - cy;
  return (ddx * ddx + ddy * ddy) < r * r;
}

function pathEnemyPenalty(ax, ay, bx, by, enemies) {
  let total = 0;
  for (const e of enemies) {
    if (segmentIntersectsCircle(ax, ay, bx, by, e.wx, e.wy, e.radius + 20)) total += 50;
  }
  return total;
}

function directionalBias(dx, dy, px, py, hazards, enemies) {
  let bias = 0;
  for (const h of hazards) {
    let tx, ty;
    if (h.coneOriginX !== undefined) {
      tx = h.coneOriginX - px; ty = h.coneOriginY - py;
    } else {
      tx = h.impactX - px; ty = h.impactY - py;
    }
    const mag = Math.sqrt(tx * tx + ty * ty);
    if (mag < 1) continue;
    const dot = (dx * tx + dy * ty) / mag;
    if (dot > 0) bias += dot * h.score * 0.6;
  }
  for (const e of enemies) {
    const tx = e.wx - px;
    const ty = e.wy - py;
    const mag = Math.sqrt(tx * tx + ty * ty);
    if (mag < 1) continue;
    const dot = (dx * tx + dy * ty) / mag;
    if (dot > 0) bias += dot * 8;
  }
  return bias;
}

function isPathWalkable(pgx, pgy, dx, dy, gridDist) {
  if (!poe2.isWalkable) return true;
  try {
    const gx1 = Math.floor(pgx + dx * gridDist * 0.5);
    const gy1 = Math.floor(pgy + dy * gridDist * 0.5);
    if (!poe2.isWalkable(gx1, gy1)) return false;
    const gx2 = Math.floor(pgx + dx * gridDist);
    const gy2 = Math.floor(pgy + dy * gridDist);
    if (!poe2.isWalkable(gx2, gy2)) return false;
  } catch (e) { return true; }
  return true;
}

// Open-space penalty: rolling to a spot with walls on several sides backs the bot into a corner (live: "always
// going south-east + stuck in the corner"). Count blocked neighbours around the roll DESTINATION; each adds score
// so a cornered landing is strongly deprioritised vs an open one. Fog-safe (isWalkable reads the revealed area).
function clearancePenalty(pgx, pgy, dx, dy, rollGrid) {
  if (!poe2.isWalkable) return 0;
  const gx = Math.floor(pgx + dx * rollGrid), gy = Math.floor(pgy + dy * rollGrid);
  let blocked = 0;
  const step = 12;
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * TWO_PI;
    try { if (!poe2.isWalkable(Math.floor(gx + Math.cos(ang) * step), Math.floor(gy + Math.sin(ang) * step))) blocked++; } catch (e) {}
  }
  return blocked * 16;   // 1 wall ~ +16; a 3-walled corner ~ +48-80 -> taken only if every open dir is more dangerous
}

// ARENA SHELL penalty (GRID space): a roll landing outside the arena wall (r-4) costs +140; within 10u of the edge
// grades +0..80. Returns 0 when no shell is published (CFG.arena* null) -> byte parity. Applied to scoring only when
// CFG.arenaEnforce ('on'); otherwise computed for the shadow log.
function arenaShellPenalty(pgx, pgy, dx, dy, rollGrid) {
  if (!Number.isFinite(CFG.arenaCX) || !Number.isFinite(CFG.arenaR)) return 0;
  const lx = pgx + dx * rollGrid, ly = pgy + dy * rollGrid;
  const d = Math.hypot(lx - CFG.arenaCX, ly - CFG.arenaCY);
  const edge = CFG.arenaR - 4;
  if (d > edge) return 140;
  if (d > edge - 10) return ((d - (edge - 10)) / 10) * 80;
  return 0;
}

function chooseDodgeDirection(player, hazards, enemies) {
  const rollWorld = CFG.estimatedRollDist * G2W;
  const rollGrid = CFG.estimatedRollDist;
  const px = player.worldX;
  const py = player.worldY;
  const pgx = player.gridX || 0;
  const pgy = player.gridY || 0;

  // GOAL BIAS: when APPROACHING a far nav target (boss/content), prefer rolls that gain ground on it. Without this the
  // boss-dodge's enemy-bias rolls AWAY from the boss while the nav pushes toward it -> cancels forward progress (the
  // WALKING_TO_BOSS_MELEE 'yoyo'). Only active when the goal is FAR (>70) so it auto-disables in melee / at the boss.
  let goalNX = 0, goalNY = 0, goalActive = false;
  if (Number.isFinite(CFG.goalX) && Number.isFinite(CFG.goalY)) {
    const gdx = CFG.goalX - pgx, gdy = CFG.goalY - pgy, gl = Math.hypot(gdx, gdy);
    if (gl > 70) { goalNX = gdx / gl; goalNY = gdy / gl; goalActive = true; }
  }

  const candidates = [];
  const N = 8;
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * TWO_PI;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const endX = px + dx * rollWorld;
    const endY = py + dy * rollWorld;
    const midX = px + dx * (rollWorld * 0.5);
    const midY = py + dy * (rollWorld * 0.5);
    let score = scoreCandidatePos(endX, endY, hazards) + scoreCandidatePos(midX, midY, hazards) * 0.5;
    score += enemyPenalty(endX, endY, enemies) + enemyPenalty(midX, midY, enemies) * 0.5;
    score += pathEnemyPenalty(px, py, endX, endY, enemies);
    score += directionalBias(dx, dy, px, py, hazards, enemies);
    score += clearancePenalty(pgx, pgy, dx, dy, rollGrid);   // avoid rolling into corners / walls
    if (goalActive) score -= (dx * goalNX + dy * goalNY) * (CFG.goalBiasWeight || 16);  // dodge TOWARD the nav goal, not backward
    const arenaPen = arenaShellPenalty(pgx, pgy, dx, dy, rollGrid);
    if (CFG.arenaEnforce) score += arenaPen;                 // 'on': steer the pick inside the wall; 'shadow': logged only
    candidates.push({ dx, dy, score, angle, arenaPen });
  }
  // PERPENDICULAR ESCAPES (opt-in via CFG.perpendicularDodge; OFF -> block skipped, behavior is the 8-dir verbatim).
  // For each DIRECTIONAL hazard (cone/charge/melee axis, or a projectile flight line) push the two +-90deg sidesteps,
  // scored with the SAME terms as the 8 fixed dirs. Circles/ground carry no direction -> skipped (continue), so the
  // radial 8-dir still covers them unchanged. A perpendicular is chosen only if it scores lowest AND is path-walkable.
  if (CFG.perpendicularDodge) {
    for (const h of hazards) {
      let axX, axY;
      if (h.coneDirX !== undefined) { axX = h.coneDirX; axY = h.coneDirY; }         // cone / charge / melee (already unit)
      else if (h.startX !== undefined && h.impactX !== undefined) {                 // projectile: axis from the flight segment
        axX = h.impactX - h.startX; axY = h.impactY - h.startY;
        const l = Math.hypot(axX, axY); if (l < 1) continue; axX /= l; axY /= l;
      } else continue;                                                              // circle / ground -> radial 8-dir covers it
      for (const s of [1, -1]) {
        const dx = -axY * s, dy = axX * s;
        const endX = px + dx * rollWorld, endY = py + dy * rollWorld;
        const midX = px + dx * (rollWorld * 0.5), midY = py + dy * (rollWorld * 0.5);
        let score = scoreCandidatePos(endX, endY, hazards) + scoreCandidatePos(midX, midY, hazards) * 0.5;
        score += enemyPenalty(endX, endY, enemies) + enemyPenalty(midX, midY, enemies) * 0.5;
        score += pathEnemyPenalty(px, py, endX, endY, enemies);
        score += directionalBias(dx, dy, px, py, hazards, enemies);
        score += clearancePenalty(pgx, pgy, dx, dy, rollGrid);
        if (goalActive) score -= (dx * goalNX + dy * goalNY) * (CFG.goalBiasWeight || 16);
        const arenaPen = arenaShellPenalty(pgx, pgy, dx, dy, rollGrid);
        if (CFG.arenaEnforce) score += arenaPen;
        candidates.push({ dx, dy, score, angle: Math.atan2(dy, dx), arenaPen });
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  // Best WALKABLE candidate, sweeping ALL of them -- the old top-3-then-blind-candidates[0] fallback meant a
  // cliff-edge pick could return an unwalkable heading: the roll fired into the void, displaced 0, the roll-fail
  // guard latched, and the bot STOOD and ate the fight (user: 'at least roll the other way when not moving').
  // Sorted by risk first, so this still takes the least-risky escape that actually MOVES us; candidates[0]
  // only when truly boxed in on every side.
  let winner = null;
  for (const c of candidates) {
    if (isPathWalkable(pgx, pgy, c.dx, c.dy, rollGrid)) { winner = c; break; }
  }
  if (!winner) winner = candidates[0];
  // ARENA SHELL shadow log: in 'shadow' (arena* published but not enforced), report the WINNER's would-be penalty if
  // nonzero. In 'on' the penalty already shaped the pick; in 'off'/no-shell CFG.arenaR is null -> skipped (parity).
  if (Number.isFinite(CFG.arenaR) && !CFG.arenaEnforce && winner && winner.arenaPen > 0) {
    const _n = Date.now();
    if (_n - _arenaShadowLogAt > 2000) {
      _arenaShadowLogAt = _n;
      const dirN = ((Math.round(Math.atan2(winner.dy, winner.dx) / (Math.PI / 4)) % 8) + 8) % 8;
      (CFG.log || console.log)(`[ArenaShell] dodge would-penalize dir=${dirN} p=${Math.round(winner.arenaPen)} (shadow)`);
    }
  }
  return winner;
}

function shouldRespectHpGate(player) {
  if (!CFG.hpGateEnabled) return true;
  const hp = (player.healthCurrent || 0) + (player.esCurrent || 0);
  const max = (player.healthMax || 0) + (player.esMax || 0);
  if (max <= 0) return true;
  const pct = (hp / max) * 100;
  return pct <= CFG.hpGatePercent;
}

function performDodge(worldDx, worldDy, label) {
  let mag = Math.sqrt(worldDx * worldDx + worldDy * worldDy);
  if (mag < 0.001) { worldDx = 1; worldDy = 0; mag = 1; }
  const ux = worldDx / mag;
  const uy = worldDy / mag;
  const gridDist = Math.max(18, Math.min(90, CFG.estimatedRollDist));
  const gridDx = ux * gridDist;
  const gridDy = uy * gridDist;
  const screenAngle = gridVectorToScreenAngleDeg(gridDx, gridDy);
  const deltas = angleToDeltas(screenAngle, gridDist);

  // Post-patch dodge = a SINGLE 01 A3 skill-activate (buildDirectionalPacket -- the same shape our attacks
  // use). The old executeChanneledSkill wrapper fired 02 D0 channel packets that DC'd the client (2026-06-21).
  const blink = CFG.useBlink ? detectBlinkSkill() : null;
  const skillBytes = (blink && blink.packetBytes && blink.packetBytes.length >= 4) ? blink.packetBytes : DODGE_ROLL_BYTES;
  let ok = false;
  try { poe2.sendPacket(buildDirectionalPacket(skillBytes, deltas.dx, deltas.dy)); ok = true; }
  catch (e) { ok = false; }
  lastDecision = ok ? ((skillBytes === DODGE_ROLL_BYTES ? 'ROLL ' : 'BLINK ') + label + ' d=' + deltas.dx + ',' + deltas.dy) : 'roll failed';
  if (ok) (CFG.log || console.log)('[AutoDodge] ' + lastDecision);
  return ok;
}

export function runAutoDodge(cfg) {
  if (cfg) CFG = cfg;
  const now = Date.now();
  // NOTE: the roll cooldown does NOT gate the scan anymore -- it only gates the roll itself (bottom). The scan
  // must keep running between rolls so walkEgress stays live while standing inside a big hazard (the Aurelian
  // ring death: one 44u roll can't clear it, and between rolls nothing walked us out).
  const _scanGate = (CFG.mode === 'boss') ? SCAN_INTERVAL_MS : RARE_SCAN_INTERVAL_MS;
  if (now - lastScanAt < _scanGate) return false;
  lastScanAt = now;

  const player = poe2.getLocalPlayer();
  if (!player || !player.isAlive || !player.worldX) { lastDecision = 'no player'; walkEgress = null; return false; }
  // never re-fire mid-roll. (Channel protection is now LAZY -- see the arbiter after the nets -- so a normal auto-attack
  // NEVER suppresses dodging; only an actual channel does, and only vs a soft risk.)
  if (player.hasActiveAction) {
    const ps = (player.actionSkillName || player.currentActionName || '').toLowerCase();
    if (ps.includes('dodge') || ps.includes('roll') || ps.includes('blink')) {
      lastDecision = 'already dodging';
      return false;
    }
  }
  if (!shouldRespectHpGate(player)) { lastDecision = 'hp gate blocked'; walkEgress = null; return false; }

  // Catchall-tame scan state: effective hp% (budget damage-unmute + the channel-hold floor) and the
  // rotation-published channel hold. channelHoldUntil bounds the hold to the channel's own timeout even
  // if rotation dies mid-channel and never clears the flag.
  if (CATCHALL_TAME_ON) {
    const _thp = (player.healthCurrent || 0) + (player.esCurrent || 0);
    const _tmx = (player.healthMax || 0) + (player.esMax || 0);
    _playerHpPct = _tmx > 0 ? (_thp / _tmx) * 100 : 100;
    _chHoldActive = POE2Cache.channelHoldActive === true && now <= (POE2Cache.channelHoldUntil || 0);
  }

  const allowList = parseList(CFG.allowList);
  const denyList = parseList(CFG.denyList);

  const result = collectHazardsAndEnemies(player, now, allowList, denyList);
  const hazards = result.hazards;
  const enemies = result.enemies;
  // BOSS-OPENER GUARD (user: 'you take the first initial hit RIGHT AWAY -- he flops onto the player'):
  // activation slams carry NO readable telegraph (the boss 'rises' with an untyped action), so the scan sees
  // nothing until the hit lands. For ~2.2s after engagement the boss position IS a hazard circle -- the normal
  // roll/egress machinery backs us out of opener range, then the guard expires and the fight proceeds.
  if (now < _openerGuardUntil) {
    hazards.push({ kind: 'boss_telegraph', impactX: _openerX, impactY: _openerY, radius: 300, etaMs: 200,
      score: 15, name: 'BossOpener', sourceRarity: RARITY_UNIQUE });
  }
  lastHazards = hazards; _lastHazardsAt = now;

  if (CFG.debug && (now - _dbgAt > 400) && (_dbgActions.length || hazards.length)) {
    _dbgAt = now;
    const acts = _dbgActions.slice(0, 5).map(a => `${a.n}/${a.sk}[r${a.rar} aoe${a.aoe} geo${a.geo}gr${a.gr} tgt${a.tgt} ${a.d}u]`).join(' ') || 'nothing';
    const haz = hazards.map(h => `${h.kind}:${(h.name || '').split('/').pop()}@eta${Math.round(h.etaMs || 0)}`).join(' ') || 'NONE';
    (CFG.log || console.log)(`[Dodge] mode=${CFG.mode} | BOSS-DOING: ${acts} | DODGE-SEES: ${haz}`);
  }

  let atRisk = playerAtRisk(player.worldX, player.worldY, hazards);
  const hardRisk = atRisk;   // T0.2: the HARD signal (real collision / standing in a zone) BEFORE the soft proximity nets add to it

  if (!atRisk && CFG.catDodgeInDangerZone) {
    let inZone = false;
    for (const h of hazards) {
      if (h.kind === 'ground' || h.kind === 'hazard_monster' || h.kind === 'boss_telegraph' || h.kind === 'rare_telegraph') {
        if (pointInHazard(player.worldX, player.worldY, h)) { inZone = true; break; }
      }
    }
    if (inZone) {
      const meleeRangeWorld = 280;
      for (const en of enemies) {
        const dx = player.worldX - en.wx;
        const dy = player.worldY - en.wy;
        if ((dx * dx + dy * dy) < meleeRangeWorld * meleeRangeWorld) { atRisk = true; break; }
      }
    }
  }

  // BOSS-PROXIMITY SAFETY NET: an action-less boss melee emits NO hazard (DODGE-SEES: NONE) -> at melee range we'd eat it
  // undodged (the death). During the FIGHT, a UNIQUE within ~melee we see no hazard for IS the threat -> force a roll.
  // Pairs with the mapper kite-floor (keeps us OUT of this range); this covers the moment the boss closes in.
  if (!atRisk && CFG.mode === 'boss' && CFG.bossEngaged) {   // T0.3: don't blind-roll while channelling (`mode` local-scope ReferenceError fixed earlier)
    const closeSq = (55 * G2W) * (55 * G2W);
    for (const en of enemies) {
      if (en.rarity !== RARITY_UNIQUE) continue;
      if (!en.acting) continue;   // T0.3: a FROZEN/idle boss emits no telegraph -> not a threat, don't force a roll
      const ddx = en.wx - player.worldX, ddy = en.wy - player.worldY;
      if (ddx * ddx + ddy * ddy <= closeSq) { atRisk = true; break; }
    }
  }

  // RARE-MODE SURROUND SAFETY NET: a melee pack of low-rarity trash (r0/r2, action 'Melee'/'DoNothing', aoe0 geo0 gr0)
  // emits NO hazard -> DODGE-SEES:NONE and the bot stood still while surrounded and ALMOST DIED. Mirror the boss net but
  // key off the already-collected `enemies` array (fields wx/wy/rarity/acting -- no extra scan). Fire ONLY on a GENUINE
  // dangerous surround so we don't re-introduce over-dodging: >=3 acting hostiles inside strike range (55u), OR a
  // rare/unique (rarity>=MAGIC) acting point-blank (40u). The roll direction is handled by chooseDodgeDirection, which
  // already repels from the enemy centroid AND biases toward CFG.goalX/goalY -> it rolls OUT of the cluster toward the
  // nav goal (reposition, not flee). processAutoAttack (entity_actions, separate module) keeps attacking the pack, so
  // this escape does NOT deadlock/flee: we roll once (~1.8s throttle) then resume killing from the new position.
  if (!atRisk && CFG.mode === 'rare') {
    const strikeSq = (55 * G2W) * (55 * G2W);
    const pointBlankSq = (40 * G2W) * (40 * G2W);
    let meleeCount = 0, elitePointBlank = false;
    for (const en of enemies) {
      if (!en.acting) continue;   // idle/frozen mobs aren't swinging -> not a surround threat
      const ddx = en.wx - player.worldX, ddy = en.wy - player.worldY;
      const dSq = ddx * ddx + ddy * ddy;
      if (dSq <= strikeSq) meleeCount++;
      if (en.rarity >= RARITY_MAGIC && dSq <= pointBlankSq) elitePointBlank = true;
    }
    if (meleeCount >= 3 || elitePointBlank) { atRisk = true; lastDecision = 'rare surround (' + meleeCount + ' melee)'; }
  }

  // T0.2 COMMIT ARBITER: while committed to an attack/channel, only break it for a HARD risk (real collision / standing
  // in damage) -- a soft proximity net alone must NOT cancel the snipe (the "dodges out, nothing lands" bug).
  // CHANNEL PROTECTION (narrow + LAZY): only if a SOFT proximity net (not a hard collision/zone) flagged us AND the player
  // is actually CHANNELLING (e.g. Snipe) do we HOLD -- so a channel isn't cancelled for nothing. getBuffs runs ONLY in
  // this rare branch (no per-tick cost). A hard risk always dodges; a normal auto-attack never reaches here.
  if (atRisk && !hardRisk) {
    let _channelling = false;
    try { const _b = poe2.getBuffs ? poe2.getBuffs() : null; if (_b) for (const b of _b) { if ((b.name || '').toLowerCase().includes('channel')) { _channelling = true; break; } } } catch (e) {}
    if (_channelling) { lastDecision = 'channelling -> hold (soft risk only)'; return false; }
  }
  // INTERACT LOCK (user 'thread safe'): while opener/pickit hold the movement lock (game auto-walk to open/grab),
  // a SOFT-risk roll cancels their interact -- hold it. A HARD risk (standing in damage / real collision) still rolls.
  // SOFT risks (proximity nets / rare-surround) hold during an interact lock AND during a content combat hold
  // (user: 'APPROACH the mobs, dodge when NECESSARY'): a breach clear spent minutes rolling AWAY from the rares
  // the runner had to reach -- the runner's standoff logic owns spacing there. HARD risks (telegraphs, ground,
  // collision-course projectiles) always roll.
  if (atRisk && !hardRisk && (CFG.interactLockHeld || CFG.holdSoftRisks)) { lastDecision = (CFG.interactLockHeld ? 'interact lock' : 'combat hold') + ' -> hold (soft risk)'; return false; }
  // OPENER-REACH HOLD (mapper: committed to a close openable, healthy): an essence is a 3-click open guarded by an
  // imprisoned CASTER + fire. HOLD STILL and TANK it -- casts, projectiles, fire, AND the per-click blast -- so the
  // opener lands all 3 clicks. Rolling away after each click (the old blast stand-down) yoyo'd it forever and opened
  // nothing (8+ clicks, never finished). SURVIVABILITY is the mapper's HP floor: it drops this flag the instant
  // HP < 50%, and the dodge re-arms to roll us out to recover. The 5s cap / 1.5s cooldown is only a stuck-hold backstop.
  if (atRisk && CFG.reachHoldActive === true && now >= _reachHoldCool) {
    if (!_reachHeldSince) _reachHeldSince = now;
    if (now - _reachHeldSince <= 5000) { walkEgress = null; lastDecision = 'opener-reach hold'; return false; }
    _reachHoldCool = now + 1500; _reachHeldSince = 0;   // capped -> release briefly to recover, then re-hold
  } else if (!(atRisk && CFG.reachHoldActive === true)) {
    _reachHeldSince = 0;
  }
  if (hazards.length === 0 && !atRisk) { lastDecision = 'no hazards'; walkEgress = null; return false; }
  if (!atRisk) { lastDecision = 'not at risk (' + hazards.length + ' hazards)'; walkEgress = null; return false; }

  // WHY are we dodging (user: name the trigger in every roll line): the containing/colliding hazard for a hard
  // risk, else which proximity net fired.
  let riskWhy = '';
  if (hardRisk) {
    for (const h of hazards) {
      if (h.kind !== 'projectile' && pointInHazard(player.worldX, player.worldY, h)) { riskWhy = h.kind + ':' + ((h.name || '?').split('/').pop()); break; }
    }
    if (!riskWhy) riskWhy = 'projectile-path';
  } else {
    riskWhy = lastDecision && lastDecision.includes('surround') ? lastDecision : 'proximity-net';
  }
  // DoT ground (map-mod burning/chilled/shocked, caustic, abyss cracks): rolling doesn't cancel the burn -- it
  // dances in place on cooldown while the walker drags us back through (user DIED yoyoing in IgnitedGround).
  // These escape by SUSTAINED goal-biased walk-out only (flagged here, applied below).
  const _dotGroundRisk = riskWhy.startsWith('ground:') && /chill|coldsnap|shock|ignit|burn|caustic|abysscrack/i.test(riskWhy);

  const choice = chooseDodgeDirection(player, hazards, enemies);
  if (!choice) { walkEgress = null; return false; }
  lastChosenDir = choice;

  // WALK-OUT: sustained egress whenever a roll won't finish the job -- the roll's endpoint is STILL inside a
  // hazard (a field bigger than the ~500-world roll), OR we're standing inside one and the roll is on cooldown.
  // Exported EVERY scan (not just roll frames) so the mapper keeps moving us out between rolls.
  const rollReady = now - lastDodgeAt >= CFG.minIntervalMs;
  const _rollW = (CFG.estimatedRollDist || 46) * G2W;
  const _ex = player.worldX + choice.dx * _rollW, _ey = player.worldY + choice.dy * _rollW;
  let _endIn = false, _plyIn = false;
  for (const h of hazards) {
    if (h.kind === 'projectile') continue;
    if (!_endIn && pointInHazard(_ex, _ey, h)) _endIn = true;
    if (!_plyIn && pointInHazard(player.worldX, player.worldY, h)) _plyIn = true;
    if (_endIn && _plyIn) break;
  }
  // STICKY ESCAPE HEADING (the 'just rolling in boss room' bug): inside a room-wide field (fungal pit), the
  // per-scan re-score flipped the best direction every 1-2s -> roll NE, roll SW, dance in place forever. Once an
  // escape heading is chosen, HOLD it 2.5s (commitment discipline) so rolls + egress walk push one straight line
  // out of the field; re-picked only when the hold ages out (blocked routes self-resolve via the fresh choice).
  const _insideField = _endIn || _plyIn;
  if (_endIn || (_plyIn && (!rollReady || _dotGroundRisk))) {
    if (!walkEgress || now - _egressHoldAt > 2500) { walkEgress = { dx: choice.dx, dy: choice.dy }; _egressHoldAt = now; }
    // ESCAPE PROGRESS WATCHDOG (Slick 6-min wall livelock): the escape must actually MOVE us. The deterministic
    // scorer re-picked the same blocked 45deg forever while the char sat wedged on a wall. No displacement >15w
    // for 2.2s -> ROTATE the held heading 90deg (systematic sweep). Continuously inside >14s -> stand down 4s so
    // the mapper's pathfinder can route around the pool instead of the straight-line push.
    if (!_egActiveSince) { _egActiveSince = now; _egProgAt = now; _egPX = player.worldX; _egPY = player.worldY; }
    if (Math.hypot(player.worldX - _egPX, player.worldY - _egPY) > 15) {
      _egPX = player.worldX; _egPY = player.worldY; _egProgAt = now;
    } else if (now - _egProgAt > 2200 && walkEgress) {
      walkEgress = { dx: -walkEgress.dy, dy: walkEgress.dx };
      _egressHoldAt = now; _egProgAt = now;
      lastDecision = 'egress rotate (heading blocked)';
    }
    if (now - _egActiveSince > 14000) { walkEgress = null; _egCoolUntil = now + 4000; _egActiveSince = 0; }
  } else {
    walkEgress = null;
    _egActiveSince = 0;
  }
  if (walkEgress && now < _egCoolUntil) walkEgress = null;   // stand-down: pathfinder owns movement for a beat
  // DoT GROUND = WALK OUT, NEVER ROLL: the sticky egress (set above, goal-biased so escape IS progress) owns the
  // exit; the roll stays reserved for real telegraphs (a telegraph landing while we stand in burn still rolls --
  // riskWhy picks the containing telegraph, not the ground). Stand-down window still lets the pathfinder cross
  // a patch deliberately.
  if (_dotGroundRisk && _insideField) { lastDecision = 'walk-out ' + riskWhy + ' (no roll)'; return false; }
  if (!rollReady) return false;   // roll gated, egress already exported -- the walk-out continues meanwhile

  // ROLL-DISPLACEMENT GUARD: consecutive rolls that moved us <12w = rolling into a wall; stop rolling (walk-only
  // escape) until real displacement resumes. Kills the every-1.4s same-angle roll spam while wedged.
  if (_rollFails >= 2 && _insideField) {
    if (Number.isFinite(_lastRollPX) && Math.hypot(player.worldX - _lastRollPX, player.worldY - _lastRollPY) > 40) _rollFails = 0;   // we've since moved -> rolls useful again
    else { lastDecision = 'roll suppressed (no displacement)'; return false; }
  }

  // Inside a field, roll ALONG the held escape heading, not the freshly re-scored one.
  const _rdx = (walkEgress && _insideField) ? walkEgress.dx : choice.dx;
  const _rdy = (walkEgress && _insideField) ? walkEgress.dy : choice.dy;
  const ok = performDodge(_rdx, _rdy, 'angle=' + ((Math.atan2(_rdy, _rdx) * 180 / Math.PI) | 0) + ' why=' + riskWhy);
  if (ok) {
    if (Number.isFinite(_lastRollPX) && now - _lastRollT < 4000
        && Math.hypot(player.worldX - _lastRollPX, player.worldY - _lastRollPY) < 12) _rollFails++;
    else _rollFails = 0;
    _lastRollPX = player.worldX; _lastRollPY = player.worldY; _lastRollT = now;
  }
  if (ok) {
    lastDodgeAt = now;
    for (const h of hazards) {
      if (!h.fingerprint) continue;
      if (h.kind === 'projectile') continue;
      if (pointInHazard(player.worldX, player.worldY, h)) {
        dodgedActions.set(h.fingerprint, now);
        if (CATCHALL_TAME_ON) _noteCatchallDodge(h, now);
      }
    }
  }
  return ok;
}

export function autoDodgeStatus() {
  return { lastDecision, hazards: lastHazards.length, walkEgress };
}

// Boss just ENGAGED (targetable flip / fight entry): arm the opener guard around its position (grid coords).
let _openerGuardUntil = 0, _openerX = 0, _openerY = 0;
export function noteBossEngaged(gridX, gridY) {
  if (!Number.isFinite(gridX) || !Number.isFinite(gridY)) return;
  _openerGuardUntil = Date.now() + 2200;
  _openerX = gridX * G2W;
  _openerY = gridY * G2W;
}

// DEBUG OVERLAY: draw the danger zones the dodge currently SEES (lastHazards) in RED -- so the user can compare what the
// dodge detects vs what's actually on the floor. RED RING = a circle hazard (ground/slam/nova/projectile impact); RED
// CONE = a charge/melee/geo-cone telegraph. Hazard coords are WORLD (impactX/coneOrigin from entity worldX/Y; radius WORLD).
// A floor hazard with NO red ring = the dodge isn't detecting it (the "doesn't dodge floor" bug, made visible).
export function drawDangerZones(playerWorldZ) {
  if (Date.now() - _lastHazardsAt > 1500) return;     // stale -> don't draw the last fight's zones
  let dl; try { dl = ImGui.getForegroundDrawList(); } catch (e) { return; }
  if (!dl || !lastHazards || !lastHazards.length) return;
  const RED = 0xFF0000FF;                              // IM_COL32(255,0,0,255)
  const z = playerWorldZ || 0;
  for (const h of lastHazards) {
    try {
      if (h.coneOriginX !== undefined) {
        const o = poe2.worldToScreen(h.coneOriginX, h.coneOriginY, z); if (!o) continue;
        const baseA = Math.atan2(h.coneDirY, h.coneDirX);
        const N = 16; let prev = null;
        for (let i = 0; i <= N; i++) {
          const a = baseA - h.coneHalfAngle + (2 * h.coneHalfAngle) * (i / N);
          const s = poe2.worldToScreen(h.coneOriginX + Math.cos(a) * h.radius, h.coneOriginY + Math.sin(a) * h.radius, z);
          if (s) { if (i === 0 || i === N) dl.addLine({ x: o.x, y: o.y }, { x: s.x, y: s.y }, RED, 2); if (prev) dl.addLine({ x: prev.x, y: prev.y }, { x: s.x, y: s.y }, RED, 2); prev = s; } else prev = null;
        }
      } else {
        const c = poe2.worldToScreen(h.impactX, h.impactY, z); if (!c) continue;
        const e = poe2.worldToScreen(h.impactX + h.radius, h.impactY, z); if (!e) continue;
        const r = Math.max(4, Math.hypot(e.x - c.x, e.y - c.y));
        dl.addCircle({ x: c.x, y: c.y }, r, RED, 28, 2);
      }
    } catch (err) {}
  }
}

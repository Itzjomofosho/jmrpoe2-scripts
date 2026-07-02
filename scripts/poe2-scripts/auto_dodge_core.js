import { buildDirectionalPacket } from './rotation_builder.js';

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

const DODGE_ROLL_BYTES = [0x80, 0x00, 0x00, 0x40];

const SCAN_INTERVAL_MS = 100;
// Rare/map-clear mode does a FULL poe2.getEntities() scan every gate -- on dense (~21k-entity) maps this is the
// dominant per-frame lag AND runs 100% of the time (a rare is always near a big pack). Boss mode stays 100ms
// (survival); rare mode eases to ~6Hz -- projectile ETAs run 500-900ms so 160ms scan latency still catches them.
const RARE_SCAN_INTERVAL_MS = 160;
const PROJ_HISTORY_TTL = 2000;
const DODGED_ACTION_TTL_MS = 1500;
const PLAYER_BODY_WORLD = 100;   // player hit radius (world units) for the T0.1 projectile collision test -- 55 UNDER-dodged (projectiles landed); generous so we catch hits + near-hits

const projHistory = new Map();
const dodgedActions = new Map();

let lastDodgeAt = 0;
let lastScanAt = 0;
let lastHazards = [];
let _lastHazardsAt = 0;   // ts of the last hazard scan -> the debug overlay won't draw a stale (last-fight) set
let lastDecision = '';
let lastChosenDir = null;
let walkEgress = null;   // {dx,dy} unit heading when a single roll won't clear the hazard -> mapper keeps walking us out
let blinkSkillCache = null;
let blinkLastCheck = 0;
let _dbgActions = [], _dbgAt = 0;   // diag: what nearby enemies are CASTING this scan (vs what we classify)

export const AUTO_DODGE_DEFAULTS = {
  enabled: true,
  catBossTelegraphs: true,
  catRareEliteTelegraphs: true,
  catProjectiles: true,
  catGroundEffects: true,
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
  minRadiusWorld: 0,
  minDurationMs: 0,
  lookaheadMs: 500,
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
  hazardMonsterKeywords: 'funguszombie,fungus,mushroom,volatile,detonat,suicide,bomb,kamikaze,corpse,explod',
  bossAreaTreatNormalAsHazard: true,
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

    if (e.hasActor && e.isAlive && !e.isFriendly) {
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
      if (e.isFriendly) continue;
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
      if (speed < 50 && typeof e.rotationZ === 'number') {
        const rot = e.rotationZ;
        const fallbackSpeed = 800;
        vx = Math.cos(rot) * fallbackSpeed;
        vy = Math.sin(rot) * fallbackSpeed;
        speed = fallbackSpeed;
      }
      projHistory.set(e.id, { wx: ewx, wy: ewy, time: now, vx, vy });

      if (speed < 50) continue;

      const toPlayerX = px - ewx;
      const toPlayerY = py - ewy;
      const distToPlayer = Math.sqrt(toPlayerX * toPlayerX + toPlayerY * toPlayerY);
      if (distToPlayer < 1) continue;
      const dotPerSpeed = (vx * toPlayerX + vy * toPlayerY) / (speed * distToPlayer);
      if (dotPerSpeed < 0.3) continue;

      const eta = distToPlayer / speed * 1000;
      if (eta > lookahead * 2 && eta > 600) continue;

      const radius = Math.max((e.boundsX || 0), (e.boundsY || 0), 30);
      const t = Math.max(0, Math.min(1, eta / 1000));
      out.push({
        kind: 'projectile',
        startX: ewx,          // T0.1: spawn point -> the flight segment (start->impact) is the collision test in playerAtRisk
        startY: ewy,
        impactX: ewx + vx * t,
        impactY: ewy + vy * t,
        radius,
        etaMs: eta,
        score: 10,
        name: e.name || e.path || 'projectile',
        sourceRarity: RARITY_NORMAL,
        entityId: e.id,
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

    if (mode === 'boss' && CFG.catGroundEffects) {
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

    if (!e.hasActor || !e.hasActiveAction || !e.isAlive || e.isFriendly) continue;
    if (/minion/i.test(e.name || '')) continue;   // USER DIRECTIVE: NEVER dodge MINION attacks, even on bosses -- only the actual boss matters

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
      if (dist2d(ewx, ewy, px, py) > CFG.meleeRangeWorld) continue;
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
      const _isSlam = !_isCharge && nameMatches(skillName, SLAM_KEYWORDS);
      const _skl = (skillName || '').toLowerCase();
      const _isMove = _skl === 'move' || _skl === 'walk' || _skl === 'run' || _skl === 'idle'
        || _skl.includes('flee') || _skl.includes('face') || _skl.includes('turn');
      const _namedFp = (e.id || 0) + '_' + (e.actionPtr || 0);
      if ((_isSlam || _isCharge) && !_isMove && CFG.catNamedMelee && (mode === 'boss' || mode === 'rare')
          && rarity >= CFG.meleeMinRarity && !dodgedActions.has(_namedFp)
          && (!(animDur > 0) || remainMs <= CFG.lookaheadMs)) {            // windup tail (or no duration -> fire on sight)
        // per-action reach: REAL SkillRange stat -> aoe -> floor; clamp a junk read.
        let _reachWorld = Math.max((e.actionSkillRange > 0 ? e.actionSkillRange * G2W : 0), aoe, CFG.slamBaseReachWorld || 150);
        _reachWorld = Math.min(_reachWorld, CFG.slamMaxReachWorld || 1700);
        if (_isCharge) {
          // CHARGE: a line hit toward the action TARGET (else toward us). Narrow lane cone -> roll PERPENDICULAR out.
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
        // SLAM: circle at the impact (the targeted spot, else us). Only a threat if WE are inside it -- a slam aimed
        // elsewhere leaves the player out of the circle so pointInHazard skips it. Centered-on-us slams roll for i-frames.
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
      const meleeReach = 200;
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
      if (h.etaMs <= CFG.lookaheadMs && projectileThreatensPlayer(px, py, h)) return true;   // T0.1: imminent AND on a collision course
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
    candidates.push({ dx, dy, score, angle });
  }
  candidates.sort((a, b) => a.score - b.score);
  for (let i = 0; i < Math.min(3, candidates.length); i++) {
    const c = candidates[i];
    if (isPathWalkable(pgx, pgy, c.dx, c.dy, rollGrid)) return c;
  }
  return candidates[0];
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
  if (now - lastDodgeAt < CFG.minIntervalMs) return false;
  const _scanGate = (CFG.mode === 'boss') ? SCAN_INTERVAL_MS : RARE_SCAN_INTERVAL_MS;
  if (now - lastScanAt < _scanGate) return false;
  lastScanAt = now;

  const player = poe2.getLocalPlayer();
  if (!player || !player.isAlive || !player.worldX) { lastDecision = 'no player'; return false; }
  // never re-fire mid-roll. (Channel protection is now LAZY -- see the arbiter after the nets -- so a normal auto-attack
  // NEVER suppresses dodging; only an actual channel does, and only vs a soft risk.)
  if (player.hasActiveAction) {
    const ps = (player.actionSkillName || player.currentActionName || '').toLowerCase();
    if (ps.includes('dodge') || ps.includes('roll') || ps.includes('blink')) {
      lastDecision = 'already dodging';
      return false;
    }
  }
  if (!shouldRespectHpGate(player)) { lastDecision = 'hp gate blocked'; return false; }

  const allowList = parseList(CFG.allowList);
  const denyList = parseList(CFG.denyList);

  const result = collectHazardsAndEnemies(player, now, allowList, denyList);
  const hazards = result.hazards;
  const enemies = result.enemies;
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
  if (hazards.length === 0 && !atRisk) { lastDecision = 'no hazards'; return false; }
  if (!atRisk) { lastDecision = 'not at risk (' + hazards.length + ' hazards)'; return false; }

  const choice = chooseDodgeDirection(player, hazards, enemies);
  if (!choice) return false;
  lastChosenDir = choice;

  // WALK-OUT: if the roll's endpoint is STILL inside a hazard (overlapping clouds / a field, or one bigger than the
  // ~500-world roll), flag a sustained egress so the mapper keeps moving us OUT instead of going passive between rolls.
  const _rollW = (CFG.estimatedRollDist || 46) * G2W;
  const _ex = player.worldX + choice.dx * _rollW, _ey = player.worldY + choice.dy * _rollW;
  let _stillIn = false;
  for (const h of hazards) { if (h.kind !== 'projectile' && pointInHazard(_ex, _ey, h)) { _stillIn = true; break; } }
  walkEgress = _stillIn ? { dx: choice.dx, dy: choice.dy } : null;

  const ok = performDodge(choice.dx, choice.dy, 'angle=' + ((choice.angle * 180 / Math.PI) | 0));
  if (ok) {
    lastDodgeAt = now;
    for (const h of hazards) {
      if (!h.fingerprint) continue;
      if (h.kind === 'projectile') continue;
      if (pointInHazard(player.worldX, player.worldY, h)) {
        dodgedActions.set(h.fingerprint, now);
      }
    }
  }
  return ok;
}

export function autoDodgeStatus() {
  return { lastDecision, hazards: lastHazards.length, walkEgress };
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

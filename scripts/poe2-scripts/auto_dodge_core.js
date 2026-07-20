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
// TASK-76 A3: admit RENDERABLE spell-fields into the DANGEROUS_EFFECT_RX branch by path NAMESPACE. The
// Renderable ban protects against hostile decoration clutter (Metadata/Terrain, Effects/Environment,
// weather_attachments, Monsters/*/attachments paths -- none live under this prefix), but a monster's
// corpse/cloud/nova field (death_spores class) is a Renderable under Spells/monsters_effects/ -- the
// type-only ban made every lethal one need a hand-written GROUND_CLASS_TABLE row. isFriendly/isAllied
// still exclude own/allied fields. off = NPC/Effect-only gate, byte-parity.
const SPELL_FIELD_RENDERABLE_ON = true;
const SPELL_FIELD_RENDERABLE_RX = /^metadata\/effects\/spells\/monsters_effects\//i;
// Roll AWAY from a wide melee telegraph's CASTER (the Zekoa gorilla-slam rule; see the anchor block in
// chooseDodgeDirection). Weight sits above the goal bias (16) and the kite bias (26) -- an active slam
// outranks both; hazard-overlap penalties still dominate all biases.
const TELE_AWAY_ON = true;
const TELE_AWAY_W = 34;
// DODGE CLAIM: stop a mid-cast + claim a short window before rolling so the auto-attack
// loop can't cancel the roll animation with the next queued attack packet.
const DODGE_CLAIM_ON = true;
const DODGE_CLAIM_MS = 600;
// DOUBLE DODGE (tracking swing, Riverside death #9 Zekoa): a boss swing that RE-AIMS during windup out-ranges
// one roll -- when the already-dodged instance still covers the player right after roll #1, chain exactly one
// re-roll (the game's dodge has no cooldown; minIntervalMs is our own cadence and yields here).
const DOUBLE_DODGE_ON = true;
const DOUBLE_DODGE_WINDOW_MS = 2600;   // re-roll must directly follow roll #1 (windup-remainder scale)
const _ddFp = new Map();               // action fingerprint -> at; ONE chained re-roll per instance
// HEADHUNTER FRIENDLY-SOURCE EXEMPTION (USER 2026-07-18): a hazard cast by the player's own stolen ability
// (HH attaches FRIENDLY daemons that cast the dead rare's effect) must never be dodged. ownerId is DEAD
// (live-probed: 0 on every entity) -- the truth-teller is the TEAM word: own burned_ground reads teamId=1
// friendly/isMine chain, the enemy explode_on_death beside it reads teamId=0 hostile (live probe 2026-07-18
// with 24 HH stacks up). teamId===1 (player team) or isMine -> ours, skip; rows without teamId unaffected.
const FRIENDLY_SOURCE_EXEMPT_ON = true;
let _satWasOn = false;   // arena-saturation edge-log latch
// ROLL RESERVE (IceCave death #7): with an acting UNIQUE within 65u, the rare-surround net must not spend
// the roll -- boss openers/telegraphs own it. false = today's surround net verbatim.
const ROLL_RESERVE_ON = true;
// TASK-80: the PATH tells the truth; type/hostility fields lie. A Metadata/Effects/ path is an effect no
// matter what entityType it wears (Creek fire breach: flame_wall typed Monster, host=1, 4u away -- the type
// veto blinded every hazard pass to it). B admits Monster-TYPED entities into the DANGEROUS_EFFECT_RX branch
// when the ANCHORED guard below matches; a real monster BODY lives under Metadata/Monsters/ and can never
// pass it, so "never flee a monster body" survives intact. off = NPC/Effect/Renderable gate only, byte-parity.
const MONSTER_TYPED_EFFECT_ON = true;
const MONSTER_EFFECT_PATH_RX = /^metadata\/effects\//i;
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
// ACTION RECOVERY. The flattened entity snapshot reports hasActiveAction=false for actions the Actor's own
// action manager is still holding -- a boss/rare mid-cast that the whole hazard scan then skips (the
// DODGE-SEES:NONE class). The manager is read only for the entities that matter (rare+, in range, no action
// in the snapshot) and the recovered action flows through the EXISTING classification: names resolve to real
// skills (GroundSlam / ShieldCharge / ...) so slam/charge/generic-melee branches size and aim them as usual.
// Unknown type IDs resolve to null and are IGNORED -- a hazard is never invented from a number.
// false = a locomotion action still falls through the named-melee block into the geometry branches (today's
// path); the shared isLocomotionActionName gate at the melee/boss-cast sites stays either way.
const LOCOMOTION_GUARD_ON = true;
const SOFT_GROUND_BLEED_ON = true;   // false = blood/bleed puddles stay roll-eligible ground hazards
const ARENA_INTERIOR_PREF_ON = true; // false = the original outside/rim penalty curve (140 / 10u band / 80)
const DLL_ACTION_RECOVER_ON = true;
const DLL_ACTION_RECOVER_RANGE_WORLD = 1600;
const DLL_ACTION_DEDUP_TTL_MS = 30000;
const dllActionDodged = new Map();      // recovered fingerprint -> roll ts: one roll per action SEQUENCE
const dllActionTypeNames = new Map();   // typeId -> resolved name (or '') -- the lookup is a static hash table
let _dllActionApiOff = false;           // binding genuinely missing -> stop trying for this session
let _dllActionLogAt = 0;
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

// PROMOTE-ON-HIT + gentler boss budget: a catchall anim that actually REACHES us (the damage-unmute path) is
// PROMOTED out of the budget for the rest of the map -- never muted again, dodged every use like a known
// telegraph (a boss cone with a ~100% hit rate must not sit muted for 8s while the third one lands). Boss-
// sourced catchalls also get a SHORTER pre-hit mute (a boss has few anims and a missed cone is a face-full).
// Registry keyed exactly like _catchallDodges; entity ids are per map-instance and resetCatchallPromotions()
// clears it on map change (mapper resetMapper). Off = byte-identical to the pre-task budget.
const CATCHALL_PROMOTE_ON = true;
const CATCHALL_MUTE_BOSS_MS = 3000;      // boss-rarity catchall mute duration (vs CATCHALL_MUTE_MS 8s)
const _catchallPromoted = new Set();     // entityId|hazardName -> promoted (bypasses every catchall suppressor)

// TASK-54 A -- CATCHALL ROLL-CADENCE CAP: a PROMOTED catchall re-promotes on EVERY boss hit, so a proven-dead
// anim read (anim_1086: reads mid-slam AND at idle, never changes) drove one roll per hit -> the boat-deck yoyo
// (30+ rolls in 60s). Promote-on-hit stays (survival), but a promoted SIGNATURE may drive at most ONE roll per
// CATCHALL_ROLL_CD_MS -- between rolls the standoff/evade layers own survival (they exist for exactly this). Not
// 1086-specific: dead-anim bosses are the majority, so this caps cadence for ALL promoted catchalls. Timestamp is
// stamped when we actually roll against the signature (_noteCatchallDodge). off = promoted dodges every scan (parity).
const CATCHALL_ROLL_CD_ON = true;
const CATCHALL_ROLL_CD_MS = 4000;
const _catchallRollAt = new Map();       // signature key (entityId|hazardName) -> last roll-against ts
let _cdSuppressN = 0, _cdSuppressLogAt = 0, _cdSuppressName = '';   // throttled "on cooldown (Nx suppressed)" log

// TASK-54 D -- ROLL-INTO-WALL FEEDBACK: invisible arena boundaries are NOT in the walkable grid, so a landing
// pre-check can't fully catch them (the char rolled back into an invisible arena edge 3x at a fight start). Two
// layers: (PRE) down-score a roll bearing whose landing cell is unwalkable, or (when the arena shell is known)
// outside the shell disc; (POST -- the honest signal) ~400ms after each roll, if we moved < a fraction of the
// roll's expected distance the bearing hit a wall -> ban that +-45deg sector for this fight (20s) so the NEXT
// roll picks elsewhere. off = today's scoring + no sector bans (byte-parity). Only the roll DESTINATION scoring
// and the post-roll ban change; the roll TRIGGERS (telegraph/panic/catchall) are untouched.
const ROLL_WALL_FEEDBACK_ON = true;
const ROLL_WALL_MEASURE_MS = 400;         // measure displacement this long after a roll
const ROLL_WALL_MAX_MEASURE_MS = 1200;    // ...but ignore a stale measurement older than this (other movement muddies it)
const ROLL_WALL_MOVE_FRAC = 0.4;          // displacement < this * expected roll distance = the bearing hit a wall
const ROLL_WALL_BAN_MS = 20000;           // banned sector duration (this fight)
const ROLL_WALL_BAN_HALF_DEG = 45;        // sector half-width around the blocked bearing
const ROLL_WALL_UNWALK_PEN = 200;         // PRE score penalty: landing cell not walkable
const ROLL_WALL_SECTOR_PEN = 260;         // PRE score penalty: bearing inside a banned sector (> the arena 140 so it loses)

// TASK-33 -- BLIND-DAMAGE EGRESS: on-death explosion circles (and any future un-classified damaging ground) never
// enter the hazard list, so the per-type dodge can't see them and the char potion-chains to death standing still.
// Damage-driven, type-blind backstop: a >=BLIND_EGRESS_DROP_PCT drop in pooled hp+es within BLIND_EGRESS_WINDOW_MS
// while the hazard list is EMPTY = standing in something invisible -> walk out (BLIND_EGRESS_HOLD_MS) toward the most-
// open ground away from the kill-zone. Requires the hazard list empty: when a hazard IS visible the normal dodge owns
// the frame (backstop, not a competitor). off = byte-parity.
const BLIND_EGRESS_ON = true;
const BLIND_EGRESS_DROP_PCT = 15;        // pooled hp+es drop (percentage points, max-in-window - current) that arms egress
const BLIND_EGRESS_WINDOW_MS = 2500;     // ...over this rolling window
const BLIND_EGRESS_HOLD_MS = 1500;       // committed walk-out per arm; re-armed (fresh window) while the drain continues
// TASK-33 B -- unknown-ground capture (TEMP diag, removed with the other TEMP diags in the cleanup task).
const BLIND_GROUND_DUMP_ON = true;
const BLIND_GROUND_DUMP_RANGE_U = 30;    // grid units around the player to dump (matches the "within 30u" brief)
const BLIND_GROUND_DUMP_THROTTLE_MS = 5000;

// TASK-34 C -- PANIC EGRESS: the blind egress above requires the hazard list EMPTY, which makes it structurally
// blind during fights -- exactly where the essence deaths happen. A drain this fast is proof the current tactic is
// failing regardless of what is visible: walk out REGARDLESS of the hazard list, overriding the rolls-in-place,
// the channel-hold, and the reach-hold (a plant is already lethal at that drain -- the holds' own hp floors agree,
// this just reacts faster). It does NOT cancel a roll already in flight (the 'already dodging' bail runs first;
// the frame is taken next scan). Reuses the TASK-33 ring buffer, heading chooser, and escape watchdog. off = parity.
const PANIC_EGRESS_ON = true;
const PANIC_DROP_PCT = 25;               // pooled hp+es drop (percentage points, max-in-window - current) that arms it
const PANIC_WINDOW_MS = 2000;            // ...over this window (tighter than the 2.5s blind ring it reads from)
const PANIC_HOLD_MS = 1500;              // committed walk-out per arm; re-armed while the drain continues
// TASK-72 A2 (STALL_WAKE_ON): scans stopped >600ms = the delta windows above were BLIND to whatever landed
// during the gap (swap-chain recreate / PSO storm). Low pooled HP on wake -> arm the SAME committed walk-out
// the PANIC trigger uses, immediately, and restart the hp ring so pre-stall samples can't double-fire.
const STALL_WAKE_ON = true;
const STALL_WAKE_GAP_MS = 600;
const STALL_WAKE_HP_FRAC = 0.75;
let _dodgeTickAt = 0;
let _stallWakeLogAt = 0; // log throttle only -- the arm itself re-fires on every qualifying gap
// HP-egress vs geometry-egress (Willow 41-min wedge): the calm gate must gate on BEING HURT, not on dodging
// geometry. A field walk-out from a PERMANENT trap beam re-stamps forever at 100% hp -- feeding it to the
// calm gate deadlocked activation AT the hazard (the gate held the bot in the beam corridor that generated
// the egresses that held the gate). _lastHpEgressAt = PANIC/blind/stall-wake only (real damage); the calm
// gate consumes THAT. _lastEgressAt keeps the union for any consumer that wants "movement is owned".
let _lastHpEgressAt = 0;
let _lastEgressAt = 0;   // last ts any egress (PANIC/blind/field walk-out) was armed or active -- exported for the mapper's calm gate (TASK-72 B)

// TASK-35 D -- CHANNEL THREAT BUS: each scan, publish the nearest UN-CC'd hostile distance (grid units) so
// rotation_builder's channel arbiter can break a perfect-window WAIT for a melee closing with no telegraph
// (POE2Cache.channelThreatD + channelThreatAt; one-way, rotation must not import this file -- circular).
// Reads the enemies list already in hand + the cached CC verdicts -- no new scan. Frozen/stunned hostiles do
// NOT count: sniping into a frozen pack is the play, not a threat. off = nothing published (byte-parity).
const CHANNEL_THREAT_INTERRUPT_ON = true;
const CHANNEL_THREAT_PROBE_U = 50;       // CC-probe band: beyond this a hostile can't flip the reader's <=35u verdict -> take as-is

// TASK-41 -- GROUND-HAZARD CLASSIFICATION: the [BlindGround] killers (explode_on_death beacons, grd_ damage-amp
// carpets, acidic/quill/puddle spawns) are Renderable/None host=1 entities -- no GroundEffect component, no action,
// not NPC/Effect -- so every branch below is blind to them and the char stands on stacked detonations (the
// shocked-ground + beacon-pile one-shot THROUGH a firing panic egress). A WHITELIST over baseEntityPath (never
// "all hostile renderables": weather_attachment / breach_attachment / *Scatterer are host=1 and harmless, the
// dumps prove the flag alone is meaningless) synthesizes them into the normal hazard list; the existing
// roll/walk-egress/overlay machinery handles them like any Vortex. sev 2 (LETHAL) additionally arms the at-risk
// gate at radius + GROUND_LETHAL_MARGIN_U (leave BEFORE detonation) and is never held by the reach-hold or the
// channel protection (a beacon pile one-shots from full hp). Path verdicts are cached per entity id (each entity
// pattern-tested ONCE), cleared per map alongside the catchall promotions. off = byte-parity.
const GROUND_CLASSIFY_ON = true;
const GROUND_CLASSIFY_RANGE_U = 45;      // classify shared-list entities within this many grid units of the player
const GROUND_LETHAL_MARGIN_U = 15;       // LETHAL at-risk margin (grid) beyond the hazard radius
const GROUND_CLASS_FLOOR_W = 12 * G2W;   // min hazard radius (world): a beacon's model bounds under-read its blast
const GROUND_CLASS_CAP_W = 350;          // junk-bounds clamp, same cap as the other ground branches
const SERVER_GROUND_HAZARD_ON = true;    // TASK-76 A1: gates the VisibleServerGroundEffect row below
// TASK-80 A: the PATH tells the truth; type/hostility fields lie. A curated GROUND_CLASS_TABLE entry has
// already been proven lethal and must not re-prove hostility per-instance (Creek death: grd_Burning01 sat
// 1u away wearing host=0 -- whitelisted since TASK-41, vetoed every frame). Table matches classify past the
// Monster/!isHostile veto in the classify pass; the veto still drops every NON-match before the push.
const TABLE_TRUMPS_HOSTILITY_ON = true;
// TASK-83: calm-tier ground traversal -- outside boss mode, sev!=2 ground hazards strip whenever no RARE/UNIQUE
// is within 70u AND no non-ground hazard is live (see the soft-ground exemption block in collectHazardsAndEnemies).
// false = the name-gated soft strip runs verbatim.
const CALM_TIER_GROUND_ON = true;
// SATURATION guard (death fix 2026-07-20): calm-tier's ONLY threat test was "no rare/unique <=70u" -- it
// ignored pack DENSITY and how much ground was stacked. Live death: a Magic/Normal Vaal Savage + Stigmata
// pack with an 11-hazard carpet (cold beams, chilled, ice-shot cones) read "no live threat", the bot walked
// THROUGH all of it during a verisium defend, ate -55% HP in 2s and died before egress. A stacked carpet OR
// a dense pack is NOT calm -> dodge it (fight better, not flee). A stray puddle or two with <PACK mobs still
// walks through (the original TASK-83 intent).
const CALM_MAX_GROUND = 4;               // >= this many strippable ground hazards = a carpet, not a puddle -> dodge
const CALM_MAX_PACK = 4;                 // >= this many hostiles within 70u = a pack -> dodge even with no rare/unique
let _calmWasStripping = false;           // entry-edge log latch for the calm strip
// sev 2 = LETHAL (pre-detonation exit), 1 = AVOID (don't stand; egress like a classified GroundEffect).
// radiusMul scales the entity's half-bounds; the floor carries when the model under-reads. One line per new
// [BlindGround] class -- the dump stays on exactly so this table can grow.
const GROUND_CLASS_TABLE = [
  { re: /monster_mods\/(fire|lightning|cold|chaos)\/explode_on_death\//i, sev: 2, radiusMul: 1.5 },
  // TASK-48: flameblast charge-up carpets (AnchoriteMother m_flameblast_NN.ao, b=32) -- four overlapped = the
  // Backwash death. Generic over Spells/monsters_effects so every act's variant/re-skin classifies; the beacon
  // row above wins first for monster_mods paths (no 'flameblast' substring there anyway).
  { re: /Spells\/monsters_effects\/.*flameblast/i, sev: 1, radiusMul: 1.0 },
  // Lobbed monster mortars (Akthi/MudBurrower mortar.ao b=52 + mortar_impact.ao, 4u off the char at the
  // AridPlains death): a marked blast zone that detonates -- LETHAL, leave before impact. Generic over
  // monsters_effects so every act's mortar user classifies; sev 2 keeps it armed through the calm tier
  // ("no explosive projectiles" is the user's own exception).
  { re: /Spells\/monsters_effects\/.*mortar/i, sev: 2, radiusMul: 1.5 },
  // Delayed-detonation blasts (Epitaph 08:59 DEATH: WifeMonster/delayed_blast_01.ao at 1u, -43%/2s while
  // DODGE-SEES-NONE): a marked ground blast that detonates -- LETHAL, leave before impact. Generic over
  // monsters_effects so every act's delayed_blast classifies; sev 2 = flee even through the calm tier.
  { re: /Spells\/monsters_effects\/.*(?:delayed_blast|_blast_|delayed_detonation)/i, sev: 2, radiusMul: 1.5 },
  { re: /grd_Zones\/grd_/i, sev: 1, radiusMul: 1.0 },
  { re: /acidic_ground/i, sev: 1, radiusMul: 1.0 },
  { re: /quillSpike_poison/i, sev: 1, radiusMul: 1.0 },
  { re: /VaalZealotSpearCold\/ao\/ice_proj/i, sev: 1, radiusMul: 1.0 },
  { re: /MeleeSpider\/puddle/i, sev: 1, radiusMul: 1.0 },
  // TASK-56 B: the Farudin culture-shrine's lightning storm (Environment/shrine/lightning/lightningstorm_trackingbolt) --
  // six tracking bolts homed the char at 15-27u in the dump. Requires the 'shrine/lightning/lightningstorm' segment so the
  // shrine OPENABLE itself (a Metadata object, no such path) never matches -- we dodge the storm ao, not the collectible.
  { re: /shrine\/lightning\/lightningstorm/i, sev: 1, radiusMul: 1.0 },
  // TASK-76 A1: the generic SERVER-side spell ground (boss lightning/fire/caustic) -- no GroundEffect component,
  // no danger keyword in the path, so both hazard paths are blind to it. sev 1 ONLY: the type is shared with
  // benign/friendly ground, so a false positive costs one step-out, never a pre-detonation flee; the classify
  // pass's isHostile gate is the ownership filter. off = row absent (byte-parity).
  ...(SERVER_GROUND_HAZARD_ON ? [{ re: /ground_effects\/VisibleServerGroundEffect/i, sev: 1, radiusMul: 1.0 }] : []),
  // The monster-mod ELEMENTAL GROUND class (monster_mods/<element>/<x>_ground/): live-verified blind --
  // shocked_ground.ao matched NOTHING here and nothing in DANGEROUS_EFFECT_RX either, because that list's
  // 'shockground'/'lightningground' keywords carry no underscore while every real path does (…/shocked_ground/).
  // Sits AFTER the explode_on_death row so those keep sev 2 (first match wins); this covers the sibling grounds
  // (shocked/burning/chilled/…) as a namespace instead of one keyword per element.
  ...(SERVER_GROUND_HAZARD_ON ? [{ re: /monster_mods\/(fire|lightning|cold|chaos)\/[^/]*ground/i, sev: 1, radiusMul: 1.0 }] : []),
];
const _groundClassCache = new Map();     // entity id -> table entry | 0
// STATIC-HAZARD HABITUATION (Willow 41-min wedge: alternating rolls vs two PERMANENT trap beams at 100% hp
// for the whole window): a hazard id live >20s with the player OUTSIDE its radius and pooled hp never down
// >5% is scenery at this range -- mute its proximity-band reactions 60s. Muting NEVER survives proximity:
// the moment the player is INSIDE the radius the mute clears and full reaction resumes, and ANY >5% pooled
// drop clears the whole ledger (the damage might be it). Per-map cleared with the class cache.
const HAZARD_HABIT_ON = true;
const _hazHabit = new Map();             // entity id -> { firstAt, hpFirst, muteUntil, logged }
// SELF-ATTACHED EFFECT DETECTOR (user runs a HEADHUNTER: killed rares' mod effects re-spawn ON the player
// under the same monster_mods/... paths the hazard system watches, wearing host=1 -- ownership fields LIE
// for effect entities, live-proven by the player's own wind_Knockback.ao reading host=1). An effect that
// stays centered ON us (<~4u) across samples while WE moved is ours -- never a hazard. A monster's ground
// effect stays where it was cast and a homing bolt approaches at VARYING offset, so neither can satisfy
// "constant near-zero offset while the player displaces" -- the TASK-56 tracking-bolt protection survives.
const SELF_EFFECT_ON = true;
const _selfFx = new Map();               // entity id -> { hx, hy, px, py, at, n, attached, logged }
function _selfAttached(id, name, hwx, hwy, pwx, pwy, now) {
  if (!SELF_EFFECT_ON || !id) return false;
  let s = _selfFx.get(id);
  if (!s) { if (_selfFx.size > 512) _selfFx.clear(); _selfFx.set(id, s = { hx: hwx, hy: hwy, px: pwx, py: pwy, at: now, n: 0, attached: false, logged: false }); return false; }
  if (s.attached) return true;
  if (now - s.at < 300) return false;                       // sample cadence floor (scan runs 100-160ms)
  const offNow = dist2d(hwx, hwy, pwx, pwy);
  const playerMoved = dist2d(pwx, pwy, s.px, s.py);
  // centered ON us (<~4u world) while we displaced (>~3u this sample) -> one attachment vote; drifting off
  // resets. 3 consecutive votes = attached for the entity's lifetime (ids are per map-instance).
  if (offNow < 100 && playerMoved > 70) s.n++;
  else if (offNow >= 160) s.n = 0;
  s.hx = hwx; s.hy = hwy; s.px = pwx; s.py = pwy; s.at = now;
  if (s.n >= 3) {
    s.attached = true;
    if (!s.logged) { s.logged = true; (CFG.log || console.log)('[AutoDodge] self-attached effect: ' + name + ' follows the player -> not a hazard'); }
    return true;
  }
  return false;
}
function _habitMuted(id, name, outside, hpFrac, now) {
  if (!HAZARD_HABIT_ON || !id) return false;
  let h = _hazHabit.get(id);
  if (!h) { if (_hazHabit.size > 512) _hazHabit.clear(); _hazHabit.set(id, h = { firstAt: now, hpFirst: hpFrac, muteUntil: 0, logged: false }); }
  if (hpFrac < h.hpFirst - 0.05) { _hazHabit.clear(); return false; }   // took damage -> forget habituation, react fully
  if (!outside) { h.muteUntil = 0; return false; }                      // inside the radius -> always react + un-mute
  if (now < h.muteUntil) return true;
  if (now - h.firstAt > 20000) {
    h.muteUntil = now + 60000;
    if (!h.logged) { h.logged = true; (CFG.log || console.log)('[AutoDodge] habituated: ' + name + ' (static 20s, no damage) -> ignoring while outside its radius'); }
    return true;
  }
  return false;
}

function classifyGroundPath(path) {
  if (!path) return 0;
  for (const c of GROUND_CLASS_TABLE) if (c.re.test(path)) return c;
  return 0;
}

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
  const key = entityId + '|' + hazardName;
  // Promoted (it has hit us before this map): dodge every time like a known telegraph -- bypass ALL catchall
  // suppressors, the channel-hold included (a proven-lethal cone outranks protecting a Snipe channel).
  if (CATCHALL_PROMOTE_ON && _catchallPromoted.has(key)) {
    // TASK-54 A: cap the promoted-catchall roll cadence -- at most one roll per CATCHALL_ROLL_CD_MS per signature.
    if (CATCHALL_ROLL_CD_ON) {
      const _lr = _catchallRollAt.get(key) || 0;
      if (now - _lr < CATCHALL_ROLL_CD_MS) {
        _cdSuppressN++; _cdSuppressName = hazardName.split(':').pop();
        if (now - _cdSuppressLogAt > 10000) {
          _cdSuppressLogAt = now;
          (CFG.log || console.log)('[AutoDodge] catchall ' + _cdSuppressName + ' on cooldown (' + _cdSuppressN + 'x suppressed)');
          _cdSuppressN = 0;
        }
        return true;   // on cooldown -> don't synthesize the hazard; standoff/evade own survival this window
      }
    }
    return false;
  }
  if (_chHoldActive && _playerHpPct >= CATCHALL_HOLD_HP_FLOOR) {
    if (now - _chHoldLogAt > 2000) { _chHoldLogAt = now; (CFG.log || console.log)('[AutoDodge] catchall held (channel active, hp ' + Math.round(_playerHpPct) + '%)'); }
    return true;
  }
  const st = _catchallDodges.get(key);
  if (st && st.muteUntil > now) {
    if (_playerHpPct <= st.hpAtMute - CATCHALL_UNMUTE_HP_DROP) {
      st.muteUntil = 0; st.times.length = 0;   // real damage while muted: the anim IS reaching us -- dodge it again
      if (CATCHALL_PROMOTE_ON && !_catchallPromoted.has(key)) {
        if (_catchallPromoted.size > 128) _catchallPromoted.clear();   // bounded; a map rarely promotes more than a handful
        _catchallPromoted.add(key);
        (CFG.log || console.log)('[AutoDodge] catchall ' + hazardName.split(':').pop() + ' promoted (it hit us)');
      }
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
  // TASK-54 A: stamp the roll-against time for the cadence cap (before the promoted early-return -- promoted
  // catchalls are exactly the ones the cap governs). The boss-anim catchall circle is centered on the player,
  // so a roll while at-risk stands INSIDE it -> this fires reliably for the dead-anim case.
  if (CATCHALL_ROLL_CD_ON) {
    _catchallRollAt.set(k, now);
    if (_catchallRollAt.size > 128) for (const [_k, _v] of _catchallRollAt) if (now - _v > 30000) _catchallRollAt.delete(_k);
  }
  if (CATCHALL_PROMOTE_ON && _catchallPromoted.has(k)) return;   // promoted anim: no budget, never mutes again
  let st = _catchallDodges.get(k);
  if (!st) {
    if (_catchallDodges.size > 128) for (const [_k, _v] of _catchallDodges) if (_v.muteUntil < now && (!_v.times.length || now - _v.times[_v.times.length - 1] > 30000)) _catchallDodges.delete(_k);
    st = { times: [], muteUntil: 0, hpAtMute: 100 };
    _catchallDodges.set(k, st);
  }
  while (st.times.length && now - st.times[0] > CATCHALL_BUDGET_WINDOW_MS) st.times.shift();
  st.times.push(now);
  if (st.times.length >= CATCHALL_BUDGET_N && st.muteUntil <= now) {
    const _muteMs = (CATCHALL_PROMOTE_ON && (h.sourceRarity || 0) >= RARITY_UNIQUE) ? CATCHALL_MUTE_BOSS_MS : CATCHALL_MUTE_MS;
    st.muteUntil = now + _muteMs;
    st.hpAtMute = _playerHpPct;
    (CFG.log || console.log)('[AutoDodge] catchall ' + h.name.split(':').pop() + ' x' + st.times.length + ' in 10s -> muted ' + (_muteMs / 1000) + 's');
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
let _egStartX = 0, _egStartY = 0;   // egress ARM point (not the 15w progress stamps) -- the DoT discriminator measures from here
let _egCycleWhy = '', _egCycleN = 0, _egArmLogAt = 0;   // 2026-07-16 anti-tug-of-war: consecutive fruitless 14s walk-out cycles vs the same hazard + throttled arm log (the in-field walk-out was SILENT and unbounded -> a 37-min dodge-vs-nav yoyo nobody could see in the log)
let _reachHeldSince = 0, _reachHoldCool = 0;   // opener-reach hold: continuous in-field hold ts + post-cap walk-out cooldown
let _rollFails = 0, _lastRollPX = NaN, _lastRollPY = NaN, _lastRollT = 0;        // roll-displacement guard (rolling into a wall)
let _rollWallBans = [];             // TASK-54 D: [{ang, until}] blocked-bearing sector bans this fight
let _pendRoll = null;               // TASK-54 D: {ang, px, py, at, expDist} a roll awaiting its ~400ms displacement check
// TASK-73 B/C: boss kite-floor integrity. The mapper publishes POE2Cache.bossKite {x,y,floor,at} (grid; one-way,
// same idiom as channelThreatD) from its FIGHTING_BOSS kite block. While the boss is inside that floor:
// B rejects roll bearings that end NET-CLOSER to the boss (radial-out preference; walls/sector bans may still
// force inward), C converts the field walk-out heading to radial-out so the dodge's own movement IS the retreat.
const BOSS_ROLL_RADIAL_ON = true;
const BOSS_KITE_RESUME_ON = true;
const BOSS_KITE_STALE_MS = 1500;    // bossKite older than this = the mapper isn't in its kite block -> ignore
const BOSS_RADIAL_BIAS_W = 26;      // radial-out score preference (goal-bias is 16; hazard terms dominate both)
let _bkrLast = null;                // chooser's kite gate this scan (roll-log marker)
let blinkSkillCache = null;
let blinkLastCheck = 0;
let _dbgActions = [], _dbgAt = 0;   // diag: what nearby enemies are CASTING this scan (vs what we classify)
let _arenaShadowLogAt = 0;          // [ArenaShell] dodge would-penalize log throttle (>=2s)
// TASK-33 blind-damage egress state (reuses walkEgress + the _eg* escape-watchdog vars above -- no second mechanism).
let _blindHpHist = [];              // {pct,at} ring over BLIND_EGRESS_WINDOW_MS -- pooled hp+es per scan (no new read)
let _blindEgressUntil = 0;          // committed walk-out active-until ts
let _blindGroundDumpAt = 0;         // [BlindGround] one-shot throttle
let _blindKillZone = null;          // {x,y,at} most-recent nearby-enemy centroid (world) -> "away from where mobs die"
let _panicUntil = 0;                // TASK-34 C: committed PANIC walk-out active-until ts (shares the _eg* watchdog)

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

// Locomotion / facing / idle anims are NEVER attack telegraphs. Residual geometry on a WALKING rare emitted
// rare_telegraph:Move and yanked the mapper off content. A gap-closing dive is separate (catMoveDaemonDive +
// closing-speed gate) and is deliberately NOT matched here. Empty name = nothing to read = not a telegraph.
function isLocomotionActionName(skillName) {
  const s = (skillName || '').toLowerCase();
  if (!s) return true;
  return s === 'move' || s === 'movedaemon' || s === 'walk' || s === 'run' || s === 'idle'
    || s.includes('flee') || s.includes('face') || s.includes('turn');
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

// Returns `e` unchanged, or a shallow clone carrying the action the action manager still holds.
// CONFIRMED current actions only: a queued action has not started (its target coords read as garbage) and is
// logged as diagnostics, never rolled against.
function recoverDllCurrentAction(e, now, mode, px, py) {
  if (!DLL_ACTION_RECOVER_ON || _dllActionApiOff) return e;
  if (mode !== 'boss' && mode !== 'rare') return e;
  // Cheapest gates first: this runs per entity per scan, the manager read is the only expensive part.
  if (e.hasActiveAction || !e.hasActor || !e.isAlive || e.isFriendly || !e.actorComponentPtr) return e;
  if (dist2d(px, py, e.worldX || 0, e.worldY || 0) > DLL_ACTION_RECOVER_RANGE_WORLD) return e;
  if (getEntityRarity(e) < RARITY_RARE) return e;

  try {
    const state = poe2.getActionManagerState(e.actorComponentPtr);
    if (!state) return e;
    const action = state.hasCurrentAction && state.currentAction;
    if (!action || (!action.ptr && action.typeId == null)) return e;

    const typeId = Number(action.typeId || 0);
    let typeName = dllActionTypeNames.get(typeId);
    if (typeName === undefined) {
      typeName = String(poe2.getActionTypeName(typeId) || '');
      dllActionTypeNames.set(typeId, typeName);
    }
    if (!typeName || /^unknown/i.test(typeName)) return e;   // no name = no evidence; never guess a hazard

    const seq = Number(state.sequenceCounter || 0);
    const actionKey = 'dll:' + String(action.ptr || typeId) + ':' + seq;
    const fp = (e.id || 0) + '_' + actionKey;
    // The manager's target fields are raw and can hold uninitialised junk (a queued slot reads
    // targetX=-802409456). Only a target plausibly near the caster is trusted; anything else drops to 0/0,
    // which the classifier reads as "aimed at us" -- the same handling a targetless melee swing gets.
    let atx = Number(action.targetX || 0), aty = Number(action.targetY || 0);
    if (!Number.isFinite(atx) || !Number.isFinite(aty)
        || Math.hypot(atx - (e.gridX || 0), aty - (e.gridY || 0)) > 400) { atx = 0; aty = 0; }
    if (CFG.debug && now - _dllActionLogAt > 2000) {
      _dllActionLogAt = now;
      (CFG.log || console.log)('[AutoDodge] recovered action ' + typeName + ' seq=' + seq
        + (state.hasQueuedAction ? ' queued=1' : ''));
    }
    return {
      ...e,
      hasActiveAction: true,
      actionPtr: actionKey,
      currentActionTypeId: typeId,
      currentActionName: typeName,
      actionTargetX: atx,
      actionTargetY: aty,
      _dllActionFp: fp,
    };
  } catch (err) {
    const msg = String((err && (err.message || err)) || '');
    if (/not a function|undefined/i.test(msg)) _dllActionApiOff = true;
    if (now - _dllActionLogAt > 5000) {
      _dllActionLogAt = now;
      (CFG.log || console.log)('[AutoDodge] action recovery unavailable: ' + msg);
    }
    return e;
  }
}

function collectHazardsAndEnemies(player, now, allowList, denyList) {
  const out = [];
  const enemies = [];
  const px = player.worldX;
  const py = player.worldY;
  const maxRangeGrid = CFG.scanRangeWorld / G2W;
  // pooled hp fraction for the static-hazard habituation ledger (hp+es -- the same pool PANIC reads)
  const _habHp = (player.healthCurrent || 0) + (player.esCurrent || 0);
  const _habMx = (player.healthMax || 0) + (player.esMax || 0);
  const _habHpFrac = _habMx > 0 ? _habHp / _habMx : 1;

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

  for (let e of entities) {
    if (e.isLocalPlayer) continue;
    // HH friendly-source: our own stolen-ability effects (team 1 / isMine) are never hazards NOR enemies.
    if (FRIENDLY_SOURCE_EXEMPT_ON && (e.isMine === true || Number(e.teamId) === 1)) continue;

    const ewx = e.worldX || 0;
    const ewy = e.worldY || 0;
    e = recoverDllCurrentAction(e, now, mode, px, py);

    if (e.hasActor && e.isAlive && !e.isFriendly
        && !/^metadata\/npc\//i.test(e.path || e.name || '')) {   // friendly NPCs (Alva) read reaction=2 MonsterUnique -- they fed 'rare surround'/telegraph rolls
      const ddx = ewx - px;
      const ddy = ewy - py;
      if ((ddx * ddx + ddy * ddy) <= enemyRangeSq) {
        const _eAct = (e.actionSkillName || e.currentActionName || '').toLowerCase();
        enemies.push({
          id: e.id || 0,   // TASK-35 D: lets the threat bus consult the cached CC verdict per hostile
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
    // TASK-76 A3 exception: a Renderable under Spells/monsters_effects/ is a monster's SPELL FIELD, not a decoration
    // (SPELL_FIELD_RENDERABLE_RX) -- admitted so corpse-AoE/cloud/nova Renderables reach the same push path.
    // TASK-80 B exception: a Monster-TYPED entity under Metadata/Effects/ is an effect too (Creek flame_wall);
    // the anchored MONSTER_EFFECT_PATH_RX keeps every real body (Metadata/Monsters/) out.
    if ((mode === 'boss' || mode === 'rare')
        && (e.entityType === 'NPC' || e.entityType === 'Effect'
            || (SPELL_FIELD_RENDERABLE_ON && e.entityType === 'Renderable'
                && SPELL_FIELD_RENDERABLE_RX.test((e.baseEntityPath || e.path || e.name || '') + ''))
            || (MONSTER_TYPED_EFFECT_ON && e.entityType === 'Monster'
                && MONSTER_EFFECT_PATH_RX.test((e.baseEntityPath || e.path || e.name || '') + '')))
        && !e.isFriendly && !e.isAllied) {
      const _dp = ((e.baseEntityPath || e.path || e.name || '') + '');
      if (DANGEROUS_EFFECT_RX.test(_dp) && !(denyList.length && nameMatches(_dp, denyList))) {
        const radius = Math.min(Math.max((e.boundsX || 0), (e.boundsY || 0), 90), 350);
        const d = dist2d(px, py, ewx, ewy);
        if (d <= radius + CFG.estimatedRollDist * G2W + 30
            && !_selfAttached(e.id || 0, _dp.split('/').pop(), ewx, ewy, px, py, now)
            && !_habitMuted(e.id || 0, _dp.split('/').pop(), d > radius, _habHpFrac, now)) {
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
          // anim_1086/1087 = the numeric LOCOMOTION/IDLE pair (log-proven on FIVE bosses 2026-07-18: Akthi
          // burrow, Malgor dormant walk, Connal intro, Port idle -- present at idle AND mid-damage, zero
          // telegraph signal). The deny list growing from live logs is this filter's designed feedback loop.
          && !(_anm && /idle|walk|run|move|turn|stand|death|spawn|emerge|taunt|anim_1086|anim_1087/.test(_anm))
          && animIsAdvancing(e.id || 0, _adur, _aprog)) {   // frozen/stunned clip = not attacking (sampled last: only clips that reach the push)
        const _nowA = Date.now();
        const _abFp = (e.id || 0) + '_anim_' + Math.round((_nowA - _aprog * 1000) / 700);
        for (const [_k3, _exp3] of animCastDodged) if (_exp3 < _nowA) animCastDodged.delete(_k3);
        if (dodgedActions.has(_abFp)) animCastDodged.set(_abFp, _nowA + Math.max(0, _adur - _aprog) * 1000 + 2000);
        const _abName = 'boss-anim~catchall' + (_anm ? ':' + _anm : '');
        if (!animCastDodged.has(_abFp) && !dodgedActions.has(_abFp)
            && !(CATCHALL_TAME_ON && _catchallSuppressed(e.id || 0, _abName))) {
          // BOSS-centered, distance-scaled: centering this hazard on the PLAYER meant we
          // were always standing inside our own synthetic circle -> roll, walk back in, roll again (yoyo).
          // Centered on the boss, escaping AWAY actually leaves the hazard. The sibling geometry path below
          // is already boss-centered; this catchall was the last player-centered emit.
          const _abDist = dist2d(px, py, ewx, ewy);
          out.push({
            kind: 'boss_telegraph', impactX: ewx, impactY: ewy,
            radius: Math.max(220, Math.min(480, _abDist * 0.75 + 80)),
            etaMs: Math.min((_adur - _aprog) * 1000, 900), score: 11,
            name: _abName,
            sourceRarity: RARITY_UNIQUE, entityId: e.id || 0, fingerprint: _abFp,
          });
        }
      }
    }

    if (!e.hasActor || !e.hasActiveAction || !e.isAlive || e.isFriendly) continue;
    // A recovered action stays "current" far longer than dodgedActions' 1.5s TTL, so one action SEQUENCE gets
    // one roll (a new cast bumps sequenceCounter -> fresh fingerprint). EXEMPT the double-dodge window: a
    // tracking swing that re-aims through roll #1 must still reach the chained re-roll at the roll gate.
    if (e._dllActionFp && dllActionDodged.has(e._dllActionFp)
        && !(DOUBLE_DODGE_ON && now - lastDodgeAt < DOUBLE_DODGE_WINDOW_MS)) continue;
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
      const _isMove = isLocomotionActionName(skillName);
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
      // Pure locomotion (and NOT a gap-closing dive) never reaches a telegraph branch. Without this the action
      // falls THROUGH this block with no continue and residual aoe/geometry on a walking rare becomes a
      // rare_telegraph roll at its move destination.
      if (LOCOMOTION_GUARD_ON && _isMove && !_isDive) continue;
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
      if (isLocomotionActionName(skillName)) continue;   // reposition/move anims are NOT attacks -- don't dodge them
      const meleeFp = (e.id || 0) + '_' + (e.actionPtr || 0);
      const distToPlayer = dist2d(px, py, ewx, ewy);
      const meleeReach = meleeReachWorld(e, aoe);   // entity-SCALED (was flat 200): big boss out-reaches, small rare ~150, cap 900
      // TRACKING SWING: 'one dodge per cast' assumed static geometry, but a boss swing RE-AIMS during its
      // windup -- after roll #1 the muted instance kept tracking and landed on the roll's endpoint (its reach
      // out-ranges one roll). The mute only holds while we are OUTSIDE the swing's current reach; still
      // covered = still a live hazard (feeds the walk-out and the chained double-dodge at the roll gate).
      if (dodgedActions.has(meleeFp) && distToPlayer > meleeReach) continue;
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
      // REPOSITION GUARD: a WALKING boss must not become a phantom hazard (false circles at his move target).
      if (isLocomotionActionName(skillName)) continue;
      const _bcFp = (e.id || 0) + '_' + (e.actionPtr || 0);
      const _bcName = (skillName || 'boss-cast') + '~catchall';
      const _bcR = Math.max(minRadius, 240);
      // Tracking re-arm (same rule as melee): the aim point twx/twy is re-read every scan, so a cast that
      // re-aims onto us after roll #1 is covered again -> the mute lifts while it covers the player.
      const _bcCover = dist2d(px, py, twx, twy) <= _bcR;
      if ((!dodgedActions.has(_bcFp) || _bcCover) && !(animDur > 0 && remainMs > lookahead)
          && !(CATCHALL_TAME_ON && _catchallSuppressed(e.id || 0, _bcName))) {
        out.push({
          kind: 'boss_telegraph', impactX: twx, impactY: twy, radius: _bcR,
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
  // Sequence fingerprints are unique per cast; this prune only bounds memory.
  for (const [fp, t] of dllActionDodged) {
    if (now - t > DLL_ACTION_DEDUP_TTL_MS) dllActionDodged.delete(fp);
  }
  for (const [id, entry] of movePosHistory) {
    if (now - entry.time > PROJ_HISTORY_TTL) movePosHistory.delete(id);
  }

  // TASK-41: whitelist-classified ground hazards from the SHARED per-frame list -- the same read the [BlindGround]
  // dump uses, so a class the dump names is a one-line table entry away from being dodged. Cheap gates first
  // (type/hostile/distance); the per-id verdict cache means the path regexes run once per entity, ever.
  if (GROUND_CLASSIFY_ON && (mode === 'boss' || mode === 'rare')) {
    let shared = null;
    try { shared = POE2Cache.getSharedEntities(); } catch (e) {}
    if (shared && shared.length) {
      const pgx = player.gridX || 0, pgy = player.gridY || 0;
      const rangeSq = GROUND_CLASSIFY_RANGE_U * GROUND_CLASSIFY_RANGE_U;
      for (const se of shared) {
        if (!se || se.isLocalPlayer) continue;
        // TASK-80 A: table match is checked FIRST -- a vetoed (Monster-typed or host=0) entity still reaches
        // classifyGroundPath, and a table hit classifies regardless (the path tells the truth; type/hostility
        // fields lie). Non-matches fall out at `if (!cls)` exactly as the veto would have dropped them, so the
        // veto's only surviving job is the flag-off pre-filter. Bypass conditions: never our own/allied
        // effects, and a Monster-typed match must sit under Metadata/Effects/ -- a monster BODY
        // (Metadata/Monsters/) can never classify even if a table regex somehow matched it.
        const vetoed = (se.entityType === 'Monster' || !se.isHostile);
        if (vetoed && !TABLE_TRUMPS_HOSTILITY_ON) continue;
        const gdx = (se.gridX || 0) - pgx, gdy = (se.gridY || 0) - pgy;
        if (gdx * gdx + gdy * gdy > rangeSq) continue;
        const sid = se.id || 0;
        const sePath = se.baseEntityPath || se.path || se.name || '';
        let cls = sid ? _groundClassCache.get(sid) : undefined;
        if (cls === undefined) {
          cls = classifyGroundPath(sePath);
          if (sid) {
            if (_groundClassCache.size > 8192) _groundClassCache.clear();   // runaway guard; the per-map clear is the real bound
            _groundClassCache.set(sid, cls);
          }
        }
        if (!cls) continue;
        if (FRIENDLY_SOURCE_EXEMPT_ON && (se.isMine === true || Number(se.teamId) === 1)) continue;   // HH: own stolen ground (team word = truth)
        if (vetoed) {
          if (se.isFriendly || se.isAllied) continue;
          if (se.entityType === 'Monster' && !MONSTER_EFFECT_PATH_RX.test(sePath)) continue;
        }
        const bw = Math.max(se.boundsX || 0, se.boundsY || 0);
        const radius = Math.min(Math.max(bw * 0.5 * cls.radiusMul, GROUND_CLASS_FLOOR_W), GROUND_CLASS_CAP_W);
        const wx = (se.gridX || 0) * G2W, wy = (se.gridY || 0) * G2W;
        const d = dist2d(px, py, wx, wy);
        if (_selfAttached(sid, (se.baseEntityPath || se.name || 'classified').split('/').pop(), wx, wy, px, py, now)) continue;
        if (_habitMuted(sid, (se.baseEntityPath || se.name || 'classified').split('/').pop(), d > radius, _habHpFrac, now)) continue;
        out.push({
          kind: 'ground', impactX: wx, impactY: wy, radius,
          etaMs: d < radius ? 0 : Math.max(0, (d - radius) * 50),
          score: cls.sev === 2 ? 13 : 8,
          name: (se.baseEntityPath || se.name || 'classified').split('/').pop(),
          sev: cls.sev,
          sourceRarity: RARITY_NORMAL, entityId: sid,
        });
      }
    }
  }

  // SOFT-GROUND TRAVERSAL EXEMPTION (user): chilled/shocked/ignited/burning floors are only a threat UNDER
  // FIRE -- the slow/degen alone can't kill a moving character, and roll-thrashing across every puddle turned
  // Slick's floors into a minutes-long crawl. Strip them when NO hostile is within ~70 grid AND nothing in
  // scan range is actively attacking (the line-of-fire proxy); any threat reinstates the zones (slowed under
  // fire IS lethal). Truly lethal ground (caustic/degen pools) never matches and is never stripped.
  // TASK-83 CALM TIER (USER RULING 2026-07-18 -- the build runs a HEADHUNTER: buffs are kill-fed and duration-
  // limited, so speed IS power): "I am happy to keep ALL dodging logic during boss." "Otherwise: no rares/uniques
  // and no explosive projectiles and shit -- we're OK to run through things." Shocked/chilled(/soft) ground: "not
  // a big deal, we can walk through it, we just need to keep moving -- if no mobs within ~60u and no OTHER
  // projectiles, we are OK." Outside boss mode: strip EVERY sev!=2 ground hazard when (1) no RARE/UNIQUE hostile
  // is within 70u (normal/magic mobs are HH food -- the old any-hostile re-arm was the roll-yoyo) and (2) no
  // non-ground hazard is live in this scan. Homing names (/tracking|homing/) stay armed: the shrine trackingbolt
  // is pushed as 'ground' but behaves like a projectile (TASK-56). sev 2 (explode_on_death) is LETHAL always.
  // Boss mode and flag-off keep the name-gated soft strip below verbatim.
  if (out.length) {
    // Soft list includes spent ABYSS CRACKS: post-event crack scenery classifies as a ground hazard and had the
    // bot rolling 'over nothing' while walking the abyss trail; during the live event its mobs are within 70u
    // anyway, so the zones re-arm exactly when they matter. NOTE: the earlier `en.acting` clause is GONE --
    // wandering counts as an action, so any moving mob within ~112u was re-arming every puddle (rolls over nothing).
    // blood/bleed: residual boss-death puddles are scenery, not a telegraph -- they were re-arming ROLLs
    // long after the fight with no hostiles left. Soft class = walk out of it, never roll.
    const _soft = SOFT_GROUND_BLEED_ON ? /chill|coldsnap|shock|ignit|burn|abysscrack|blood|bleed/i
      : /chill|coldsnap|shock|ignit|burn|abysscrack/i;
    const _r70sq = (70 * G2W) * (70 * G2W);
    const _calmEligible = CALM_TIER_GROUND_ON && mode !== 'boss';
    let _hostileNear = false, _eliteNear = false, _packNear = 0;
    for (const en of enemies) {
      const _dx = en.wx - px, _dy = en.wy - py;
      if (_dx * _dx + _dy * _dy <= _r70sq) {
        _hostileNear = true;
        _packNear++;
        if (_calmEligible && en.rarity >= RARITY_RARE) _eliteNear = true;
      }
    }
    // SATURATION: count the ground hazards calm would walk through -- a carpet (>= CALM_MAX_GROUND) or a dense
    // pack (>= CALM_MAX_PACK) is a real threat even with no rare/unique, so it is NOT calm -> dodge instead.
    let _groundStrip = 0;
    for (const h of out) { if (h.kind === 'ground' && h.sev !== 2 && !/tracking|homing/i.test(h.name || '')) _groundStrip++; }
    const _saturated = _groundStrip >= CALM_MAX_GROUND || _packNear >= CALM_MAX_PACK;
    let _calm = _calmEligible && !_eliteNear && !_saturated;
    if (_calm) for (const h of out) { if (h.kind !== 'ground') { _calm = false; break; } }
    if (_calm) {
      let _stripped = 0;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].kind === 'ground' && out[i].sev !== 2 && !/tracking|homing/i.test(out[i].name || '')) { out.splice(i, 1); _stripped++; }
      }
      if (_stripped > 0 && !_calmWasStripping) (CFG.log || console.log)(`[Dodge] calm-tier: walking through ${_stripped} ground hazard(s) (no rare/unique <=70u, no live threat)`);
      _calmWasStripping = _stripped > 0;
    } else {
      _calmWasStripping = false;
      if (!_hostileNear) {
        for (let i = out.length - 1; i >= 0; i--) {
          // TASK-41: sev 2 (LETHAL beacons) never strips -- they detonate with the pack already dead. AVOID carpets
          // (grd_Shocked01 matches /shock/) stay strippable: an amp carpet only matters under fire.
          if (out[i].kind === 'ground' && out[i].sev !== 2 && _soft.test(out[i].name || '')) out.splice(i, 1);
        }
      }
    }
  }

  // BOSS-ARENA SATURATION (Connal/Willow 17:50, USER "ran at a wall, yoyo'd, then stood eating"): the arena
  // carried up to 34 live hazards -- beacons/vortex/beams carpeting the floor. At that density per-hazard
  // PREEMPTIVE rolls are meaningless: every direction scores bad, the chooser pinballs the char wall-to-wall,
  // and when the boss closes nothing can pick a heading so it plants. At >=SATURATION hazards in boss mode the
  // distant carpet is TERRAIN, not events -- keep only what threatens NOW: any non-ground kind (telegraphs/
  // projectiles/melee), sev2 lethals actually close (radius+25), and ground we are INSIDE (radius+8; the
  // walk-out owns those). Position discipline (kite ring/posture) owns the rest of the frame.
  const ARENA_SATURATION_N = 8;
  if (mode === 'boss' && out.length >= ARENA_SATURATION_N) {
    const _kept = [];
    for (const h of out) {
      if (h.kind !== 'ground') { _kept.push(h); continue; }
      const _hd = dist2d(px, py, h.impactX, h.impactY);
      if (h.sev === 2) { if (_hd <= h.radius + 25) _kept.push(h); continue; }
      if (_hd <= h.radius + 8) _kept.push(h);
    }
    if (_kept.length !== out.length) {
      if (!_satWasOn) { _satWasOn = true; (CFG.log || console.log)(`[Dodge] arena saturated (${out.length} hazards) -> positional mode (kept ${_kept.length})`); }
      out.length = 0;
      for (const h of _kept) out.push(h);
    }
  } else if (_satWasOn && out.length < ARENA_SATURATION_N - 2) _satWasOn = false;

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

// ARENA SHELL penalty (GRID space): when the disc is known, prefer the INTERIOR, not the rim. Outside the wall
// (r-4) is near-forbidden; the outer band grades up so rolls land toward the centre instead of sliding along an
// invisible wall. Returns 0 when no shell is published (CFG.arena* null) -> byte parity. Applied to scoring only
// when CFG.arenaEnforce ('on'); otherwise computed for the shadow log.
function arenaShellPenalty(pgx, pgy, dx, dy, rollGrid) {
  if (!Number.isFinite(CFG.arenaCX) || !Number.isFinite(CFG.arenaR)) return 0;
  const lx = pgx + dx * rollGrid, ly = pgy + dy * rollGrid;
  const d = Math.hypot(lx - CFG.arenaCX, ly - CFG.arenaCY);
  const edge = CFG.arenaR - 4;
  const outside = ARENA_INTERIOR_PREF_ON ? 220 : 140;
  const band = ARENA_INTERIOR_PREF_ON ? 22 : 10;
  const rim = ARENA_INTERIOR_PREF_ON ? 140 : 80;
  if (d > edge) return outside;
  if (d > edge - band) return ((d - (edge - band)) / band) * rim;
  return 0;
}

// TASK-54 D (PRE): additive penalty if this bearing's GRID landing cell is unwalkable, or the bearing sits inside
// a blocked-sector ban. Same dx/dy grid convention as clearancePenalty. Returns 0 when the feedback flag is off
// (byte-parity). NOT forbidden -- heavy penalties so an open, un-banned bearing wins, but a fully boxed-in fight
// still takes the least-bad option.
function rollWallPenalty(pgx, pgy, dx, dy, rollGrid, now) {
  if (!ROLL_WALL_FEEDBACK_ON) return 0;
  let pen = 0;
  if (poe2.isWalkable) {
    try {
      const gx = Math.floor(pgx + dx * rollGrid), gy = Math.floor(pgy + dy * rollGrid);
      if (!poe2.isWalkable(gx, gy)) pen += ROLL_WALL_UNWALK_PEN;
    } catch (e) {}
  }
  if (_rollSectorBanned(Math.atan2(dy, dx), now)) pen += ROLL_WALL_SECTOR_PEN;
  return pen;
}

// TASK-54 D ban predicate (extracted verbatim), shared with the TASK-73 radial-out winner sweep.
function _rollSectorBanned(ang, now) {
  if (!_rollWallBans.length) return false;
  const half = ROLL_WALL_BAN_HALF_DEG * Math.PI / 180;
  for (const b of _rollWallBans) {
    if (b.until <= now) continue;
    let d = Math.abs(ang - b.ang) % TWO_PI; if (d > Math.PI) d = TWO_PI - d;
    if (d <= half) return true;
  }
  return false;
}

// TASK-73: the boss kite gate -- non-null only in boss mode with a FRESH bossKite publication and the boss
// inside its floor. Grid-space {bx,by,d,ax,ay}; (ax,ay) = unit boss->player = the radial-out bearing.
function _bossKiteRadial(pgx, pgy, now) {
  if (CFG.mode !== 'boss') return null;
  let bk = null; try { bk = POE2Cache.bossKite; } catch (e) { return null; }
  if (!bk || !Number.isFinite(bk.x) || !Number.isFinite(bk.floor)) return null;
  if (now - (bk.at || 0) > BOSS_KITE_STALE_MS) return null;
  const dx = pgx - bk.x, dy = pgy - bk.y;
  const d = Math.hypot(dx, dy);
  if (d >= bk.floor || d < 0.5) return null;
  return { bx: bk.x, by: bk.y, d, ax: dx / d, ay: dy / d };
}

// TASK-54 D (POST): the honest wall signal. ~400ms after a roll fired, if the char barely moved the bearing hit
// an invisible wall -> ban its +-45deg sector for this fight so the next roll goes elsewhere. Runs every scan
// (prunes expired bans regardless of the pending roll). Displacement measured in world; expDist is world too.
function _checkRollWall(player, now) {
  if (_rollWallBans.length) { let _live = false; for (const b of _rollWallBans) if (b.until > now) { _live = true; break; } if (!_live) _rollWallBans = []; else _rollWallBans = _rollWallBans.filter(b => b.until > now); }
  if (!ROLL_WALL_FEEDBACK_ON || !_pendRoll) return;
  const age = now - _pendRoll.at;
  if (age < ROLL_WALL_MEASURE_MS) return;              // not yet time to measure
  const pr = _pendRoll; _pendRoll = null;              // one-shot
  if (age > ROLL_WALL_MAX_MEASURE_MS) return;          // stale -> other movement muddied it, don't judge
  const moved = Math.hypot(player.worldX - pr.px, player.worldY - pr.py);
  if (moved >= ROLL_WALL_MOVE_FRAC * pr.expDist) return;   // rolled fine -> no ban
  _rollWallBans.push({ ang: pr.ang, until: now + ROLL_WALL_BAN_MS });
  if (_rollWallBans.length > 12) _rollWallBans.shift();
  const dirN = ((Math.round(pr.ang / (Math.PI / 4)) % 8) + 8) % 8;
  (CFG.log || console.log)('[AutoDodge] roll bearing ' + dirN + ' blocked (moved ' + Math.round(moved / G2W) + 'u) -> sector banned 20s');
}

function chooseDodgeDirection(player, hazards, enemies) {
  const now = Date.now();
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

  // TASK-73 B: boss inside the kite floor -> prefer radial-out bearings and mark NET-CLOSER landings so the
  // winner sweep can refuse them (a telegraph/proximity roll must not carry a bow build INTO the opener).
  const bkr = BOSS_ROLL_RADIAL_ON ? _bossKiteRadial(pgx, pgy, now) : null;
  _bkrLast = bkr;
  // TELEGRAPH-AWAY anchor (Zekoa slam: a 44u DIAGONAL from 27u landed inside the real hit -- unreadable-geometry
  // melee (EmptyActionAttack, aoe0/geo0) is modeled as an under-read cone, so a lateral exit clears the MODEL and
  // eats the SLAM). For a wide/radial melee telegraph the only safe bearing family is RADIALLY AWAY FROM THE
  // CASTER -- enforced here for EVERY mode/state (the kite gate above only exists inside FIGHTING_BOSS's floor).
  // Narrow lanes (charges, coneHalfAngle < ~40deg) are excluded: perpendicular IS the correct escape there.
  let tele = null;
  if (TELE_AWAY_ON) {
    let _td = Infinity;
    for (const h of hazards) {
      if (!h || (h.kind !== 'boss_telegraph' && h.kind !== 'rare_telegraph')) continue;
      if (Number.isFinite(h.coneHalfAngle) && h.coneHalfAngle < 0.7) continue;   // narrow lane -> perpendicular logic owns it
      const _owx = Number.isFinite(h.coneOriginX) ? h.coneOriginX : h.impactX;
      const _owy = Number.isFinite(h.coneOriginY) ? h.coneOriginY : h.impactY;
      if (!Number.isFinite(_owx)) continue;
      const _ogx = _owx / G2W, _ogy = _owy / G2W;
      const _d = Math.hypot(pgx - _ogx, pgy - _ogy);
      const _rG = (h.radius || 0) / G2W;
      if (_d <= _rG + (CFG.estimatedRollDist || 46) + 8 && _d < _td) { _td = _d; tele = { gx: _ogx, gy: _ogy, d: _d }; }
    }
    if (tele) {
      if (tele.d > 0.5) { tele.ax = (pgx - tele.gx) / tele.d; tele.ay = (pgy - tele.gy) / tele.d; }
      else { tele.ax = 1; tele.ay = 0; }   // caster exactly on us -> arbitrary away dir, the reject still applies
    }
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
    score += rollWallPenalty(pgx, pgy, dx, dy, rollGrid, now);   // TASK-54 D: unwalkable landing / banned wall-sector
    if (goalActive) score -= (dx * goalNX + dy * goalNY) * (CFG.goalBiasWeight || 16);  // dodge TOWARD the nav goal, not backward
    const arenaPen = arenaShellPenalty(pgx, pgy, dx, dy, rollGrid);
    if (CFG.arenaEnforce) score += arenaPen;                 // 'on': steer the pick inside the wall; 'shadow': logged only
    let inward = false;
    if (bkr) {
      score -= (dx * bkr.ax + dy * bkr.ay) * BOSS_RADIAL_BIAS_W;   // TASK-73 B radial-out preference
      inward = Math.hypot((pgx + dx * rollGrid) - bkr.bx, (pgy + dy * rollGrid) - bkr.by) < bkr.d - 1;
    }
    let inwardTele = false;
    if (tele) {
      score -= (dx * tele.ax + dy * tele.ay) * TELE_AWAY_W;        // away from the slam CASTER
      inwardTele = Math.hypot((pgx + dx * rollGrid) - tele.gx, (pgy + dy * rollGrid) - tele.gy) < tele.d - 1;
    }
    candidates.push({ dx, dy, score, angle, arenaPen, inward, inwardTele });
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
        score += rollWallPenalty(pgx, pgy, dx, dy, rollGrid, now);   // TASK-54 D: unwalkable landing / banned wall-sector
        if (goalActive) score -= (dx * goalNX + dy * goalNY) * (CFG.goalBiasWeight || 16);
        const arenaPen = arenaShellPenalty(pgx, pgy, dx, dy, rollGrid);
        if (CFG.arenaEnforce) score += arenaPen;
        let inward = false;
        if (bkr) {
          score -= (dx * bkr.ax + dy * bkr.ay) * BOSS_RADIAL_BIAS_W;   // TASK-73 B radial-out preference
          inward = Math.hypot((pgx + dx * rollGrid) - bkr.bx, (pgy + dy * rollGrid) - bkr.by) < bkr.d - 1;
        }
        let inwardTele = false;
        if (tele) {
          score -= (dx * tele.ax + dy * tele.ay) * TELE_AWAY_W;        // away from the slam CASTER
          inwardTele = Math.hypot((pgx + dx * rollGrid) - tele.gx, (pgy + dy * rollGrid) - tele.gy) < tele.d - 1;
        }
        candidates.push({ dx, dy, score, angle: Math.atan2(dy, dx), arenaPen, inward, inwardTele });
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
  // TASK-73 B + telegraph-away: the best walkable candidate that lands net-FARTHER from both the kite boss
  // and the slam CASTER, outside banned sectors. Only when every such bearing is inward/banned/blocked does
  // the sweep below (today's behavior) pick, so a boxed-in fight still rolls inward rather than into a wall.
  if (bkr || tele) {
    for (const c of candidates) {
      if (c.inward || c.inwardTele || _rollSectorBanned(c.angle, now)) continue;
      if (isPathWalkable(pgx, pgy, c.dx, c.dy, rollGrid)) { winner = c; break; }
    }
  }
  if (!winner) for (const c of candidates) {
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
  // DODGE CLAIM: a queued attack packet on the next tick CANCELS the roll animation
  // mid-play ("rolls only land at the end of the fight"). Stop a mid-cast so the roll executes NOW
  // (via the bus fn entity_actions publishes -- no opcode duplication), then claim a short window that
  // processAutoAttack honors before re-firing attacks. Roll interrupted anyway = attacks stall <=600ms.
  if (DODGE_CLAIM_ON) {
    try {
      const _pl = poe2.getLocalPlayer();
      if (_pl && _pl.hasActiveAction && POE2Cache.stopAction) POE2Cache.stopAction();
    } catch (e) {}
    try { POE2Cache.dodgeRollUntil = Date.now() + DODGE_CLAIM_MS; } catch (e) {}
  }
  let ok = false;
  try { poe2.sendPacket(buildDirectionalPacket(skillBytes, deltas.dx, deltas.dy)); ok = true; }
  catch (e) { ok = false; }
  lastDecision = ok ? ((skillBytes === DODGE_ROLL_BYTES ? 'ROLL ' : 'BLINK ') + label + ' d=' + deltas.dx + ',' + deltas.dy) : 'roll failed';
  if (ok) (CFG.log || console.log)('[AutoDodge] ' + lastDecision);
  return ok;
}

// ---- TASK-33: BLIND-DAMAGE EGRESS ----------------------------------------------------------------------------
const _BLIND_COMPASS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
function _blindDirName(dx, dy) {
  return _BLIND_COMPASS[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];
}

// No hazard geometry exists to flee, so score the 8 world-bearings by OPEN WALKABLE ground (reuses isPathWalkable +
// clearancePenalty, same dx/dy convention as chooseDodgeDirection), tie-broken toward the away-from-kill-zone vector.
// Returns a unit {dx,dy}.
function chooseBlindEgressHeading(player, awayX, awayY) {
  const rollGrid = CFG.estimatedRollDist || 46;
  const pgx = player.gridX || 0, pgy = player.gridY || 0;
  let best = null;
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * TWO_PI;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let score = clearancePenalty(pgx, pgy, dx, dy, rollGrid);        // blocked-neighbour count*16 -> lower = more open
    if (!isPathWalkable(pgx, pgy, dx, dy, rollGrid)) score += 1000;  // an unwalkable bearing only if every open one is worse
    score -= (dx * awayX + dy * awayY) * 8;                          // tie-break (< the 16 openness step): pull away from the kill-zone
    if (!best || score < best.score) best = { dx, dy, score };
  }
  return best || { dx: awayX || 1, dy: awayY || 0 };
}

// TEMP diag (TASK-33 B -- removed with the other TEMP diags in the cleanup task): name the invisible damaging ground
// so a follow-up can classify it. One-shot per blind-egress arm, 5s throttle. Reads the SHARED per-frame list (no new
// scan); non-monster entities within BLIND_GROUND_DUMP_RANGE_U (grid) of the player, nearest first. NOTE: the lightweight
// shared payload carries no hasGroundEffect/groundEffectRadiusGrid -- bounds are the footprint proxy and the id lets a
// follow-up re-read the full entity for the +0x48 radius.
function _dumpBlindGround(player, now) {
  if (now - _blindGroundDumpAt < BLIND_GROUND_DUMP_THROTTLE_MS) return;
  _blindGroundDumpAt = now;
  let shared; try { shared = POE2Cache.getSharedEntities(); } catch (e) { return; }
  if (!shared || !shared.length) return;
  const pgx = player.gridX || 0, pgy = player.gridY || 0;
  const rSq = BLIND_GROUND_DUMP_RANGE_U * BLIND_GROUND_DUMP_RANGE_U;
  const found = [];
  for (const se of shared) {
    if (se.isLocalPlayer) continue;
    if (se.hasActor && se.isAlive && (se.healthMax || 0) > 0) continue;   // living creatures are already named; the mystery is the ground/effect entity
    const ddx = (se.gridX || 0) - pgx, ddy = (se.gridY || 0) - pgy;
    const dSq = ddx * ddx + ddy * ddy;
    if (dSq > rSq) continue;
    found.push({ se, d: Math.sqrt(dSq) });
  }
  if (!found.length) { (CFG.log || console.log)('[BlindGround] no non-monster entities within ' + BLIND_GROUND_DUMP_RANGE_U + 'u'); return; }
  found.sort((a, b) => a.d - b.d);
  (CFG.log || console.log)('[BlindGround] ' + found.length + ' non-monster within ' + BLIND_GROUND_DUMP_RANGE_U + 'u (nearest first):');
  for (let i = 0, n = Math.min(found.length, 12); i < n; i++) {
    const se = found[i].se;
    (CFG.log || console.log)('[BlindGround]   ' + (se.baseEntityPath || se.name || '?')
      + ' type=' + (se.entityType || '?') + '/' + (se.entitySubtype || '?')
      + ' host=' + (se.isHostile ? 1 : 0)
      + ' b=' + Math.round(se.boundsX || 0) + 'x' + Math.round(se.boundsY || 0)
      + ' id=0x' + ((se.id || 0) >>> 0).toString(16)
      + ' d=' + Math.round(found[i].d) + 'u');
  }
}

// Called ONLY at the "no visible hazard" bail (hazard list empty AND no proximity net fired). Detects a fast pooled-hp
// drop over the window and drives the EXISTING walkEgress + escape-watchdog state (no second escape mechanism). Returns
// true while an egress is active (walkEgress set -- caller must NOT clear it); false = no blind risk (caller bails).
function _tryBlindEgress(player, enemies, now) {
  const _active = now < _blindEgressUntil;   // committed hold: keep walking out for the rest of the hold even if this
                                             // scan's instantaneous drop dipped (a potion tick masks it mid-exit)
  let drop = 0;
  if (_blindHpHist.length) {
    const cur = _blindHpHist[_blindHpHist.length - 1].pct;
    let mx = cur;
    for (const s of _blindHpHist) if (s.pct > mx) mx = s.pct;
    drop = mx - cur;
  }
  const _triggered = drop >= BLIND_EGRESS_DROP_PCT;
  if (!_triggered && !_active) return false;   // no drain, no committed hold -> normal bail clears walkEgress

  // BOUNDS: the explicit "tank it" holds and the egress stand-down own the frame -> blind egress steps aside. The
  // channel/reach holds have their OWN hp floors that release when it turns lethal, at which point this re-engages.
  if (_chHoldActive && _playerHpPct >= CATCHALL_HOLD_HP_FLOOR) { _blindEgressUntil = 0; _egActiveSince = 0; return false; }
  if (CFG.reachHoldActive === true) { _blindEgressUntil = 0; _egActiveSince = 0; return false; }
  if (now < _egCoolUntil) { _blindEgressUntil = 0; _egActiveSince = 0; return false; }

  // AWAY-FROM-KILL-ZONE prior: on-death circles spawn where mobs die = where we've been shooting.
  let awayX = 0, awayY = 0;
  if (_blindKillZone && now - _blindKillZone.at <= BLIND_EGRESS_WINDOW_MS) {
    const kx = player.worldX - _blindKillZone.x, ky = player.worldY - _blindKillZone.y;
    const kl = Math.hypot(kx, ky);
    if (kl > 1) { awayX = kx / kl; awayY = ky / kl; }
  }

  const _fresh = !_active || !walkEgress;   // a new arm (prior hold lapsed / heading cleared) -> new heading + log
  if (_fresh) {
    const h = chooseBlindEgressHeading(player, awayX, awayY);
    walkEgress = { dx: h.dx, dy: h.dy };
    _egActiveSince = now; _egProgAt = now; _egPX = player.worldX; _egPY = player.worldY;
    _egStartX = player.worldX; _egStartY = player.worldY;
    (CFG.log || console.log)('[AutoDodge] blind egress: hp -' + Math.round(drop) + '% in ' + (BLIND_EGRESS_WINDOW_MS / 1000)
      + 's, no visible hazard -> walking out ' + _blindDirName(h.dx, h.dy));
    if (BLIND_GROUND_DUMP_ON) _dumpBlindGround(player, now);
  }
  // DoT DISCRIMINATOR (Headland 16:45 thrash -- ignite ticking after the field was already left): the drain
  // still TRIGGERING after we moved well clear of the arm point means the damage rides the PLAYER, not the
  // ground -- walking cannot fix it and every re-armed leg bleeds HH uptime. Stand down + cool; a real unseen
  // ground stops draining the moment we are out, so it never trips this.
  if (_triggered && _egActiveSince && Math.hypot(player.worldX - _egStartX, player.worldY - _egStartY) > 250) {
    walkEgress = null; _egCoolUntil = now + 8000; _egActiveSince = 0; _blindEgressUntil = 0;
    (CFG.log || console.log)('[AutoDodge] blind egress: still draining after moving out -> DoT on player, stand-down 8s');
    lastDecision = 'blind egress DoT stand-down';
    return false;
  }
  if (_triggered) _blindEgressUntil = now + BLIND_EGRESS_HOLD_MS;   // fresh window each trigger while the drain continues

  // PROGRESS WATCHDOG (same state + thresholds as the in-field egress): moved >15w -> progress; wedged >2.2s ->
  // rotate the held heading 90deg; continuously active >14s -> stand down 4s so the pathfinder can route around it.
  if (Math.hypot(player.worldX - _egPX, player.worldY - _egPY) > 15) {
    _egPX = player.worldX; _egPY = player.worldY; _egProgAt = now;
  } else if (now - _egProgAt > 2200 && walkEgress) {
    walkEgress = { dx: -walkEgress.dy, dy: walkEgress.dx };
    _egProgAt = now;
  }
  if (now - _egActiveSince > 14000) { walkEgress = null; _egCoolUntil = now + 4000; _egActiveSince = 0; _blindEgressUntil = 0; lastDecision = 'blind egress stand-down'; return false; }

  _lastEgressAt = now; _lastHpEgressAt = now;   // HP-driven (the calm gate consumes _lastHpEgressAt)
  lastDecision = 'blind egress (hp -' + Math.round(drop) + '%)';
  return true;
}

// TASK-34 C: heavy-drain override, checked BEFORE the risk arbitration/holds (unlike _tryBlindEgress, which only
// runs at the empty-hazard bail and steps aside for the holds). Same walkEgress + _eg* watchdog state -- only one
// of the two runs per scan (this one returns first), so the shared state never double-drives.
function _tryPanicEgress(player, now) {
  const _active = now < _panicUntil;   // committed hold: keep walking out even if a potion tick masks the drop
  let drop = 0;
  if (_blindHpHist.length) {
    const cur = _blindHpHist[_blindHpHist.length - 1].pct;
    let mx = cur;
    for (const s of _blindHpHist) if (now - s.at <= PANIC_WINDOW_MS && s.pct > mx) mx = s.pct;
    drop = mx - cur;
  }
  const _triggered = drop >= PANIC_DROP_PCT;
  if (!_triggered && !_active) return false;
  if (now < _egCoolUntil) { _panicUntil = 0; return false; }   // escape machinery just stood down wedged -- pathfinder owns

  // Away from the enemy centroid (the fight we are leaving), most-open ground wins ties.
  let awayX = 0, awayY = 0;
  if (_blindKillZone && now - _blindKillZone.at <= BLIND_EGRESS_WINDOW_MS) {
    const kx = player.worldX - _blindKillZone.x, ky = player.worldY - _blindKillZone.y;
    const kl = Math.hypot(kx, ky);
    if (kl > 1) { awayX = kx / kl; awayY = ky / kl; }
  }

  const _fresh = !_active || !walkEgress;
  if (_fresh) {
    const h = chooseBlindEgressHeading(player, awayX, awayY);
    walkEgress = { dx: h.dx, dy: h.dy };
    _egActiveSince = now; _egProgAt = now; _egPX = player.worldX; _egPY = player.worldY;
    (CFG.log || console.log)('[AutoDodge] PANIC egress: hp -' + Math.round(drop) + '% in '
      + (PANIC_WINDOW_MS / 1000) + 's -> leaving the fight');
    // Fights are where the invisible boombooms actually kill (all three ground deaths) -- name the culprit on
    // THIS trigger too, not only at the empty-hazard blind path (5s throttle + non-living filter live in the dump).
    if (BLIND_GROUND_DUMP_ON) _dumpBlindGround(player, now);
  }
  if (_triggered) _panicUntil = now + PANIC_HOLD_MS;   // fresh window each trigger while the drain continues

  // PROGRESS WATCHDOG (shared state + thresholds): moved >15w -> progress; wedged >2.2s -> rotate the heading 90deg;
  // continuously active >14s -> stand down 4s so the pathfinder can route around whatever is penning us in.
  if (Math.hypot(player.worldX - _egPX, player.worldY - _egPY) > 15) {
    _egPX = player.worldX; _egPY = player.worldY; _egProgAt = now;
  } else if (now - _egProgAt > 2200 && walkEgress) {
    walkEgress = { dx: -walkEgress.dy, dy: walkEgress.dx };
    _egProgAt = now;
  }
  if (now - _egActiveSince > 14000) { walkEgress = null; _egCoolUntil = now + 4000; _egActiveSince = 0; _panicUntil = 0; lastDecision = 'panic egress stand-down'; return false; }

  _lastEgressAt = now; _lastHpEgressAt = now;   // HP-driven (the calm gate consumes _lastHpEgressAt)
  lastDecision = 'PANIC egress (hp -' + Math.round(drop) + '%)';
  return true;
}

export function runAutoDodge(cfg) {
  if (cfg) CFG = cfg;
  const now = Date.now();
  // NOTE: the roll cooldown does NOT gate the scan anymore -- it only gates the roll itself (bottom). The scan
  // must keep running between rolls so walkEgress stays live while standing inside a big hazard (the Aurelian
  // ring death: one 44u roll can't clear it, and between rolls nothing walked us out).
  const _scanGate = (CFG.mode === 'boss') ? SCAN_INTERVAL_MS : RARE_SCAN_INTERVAL_MS;
  if (now - lastScanAt < _scanGate) return false;
  const _swGap = _dodgeTickAt ? now - _dodgeTickAt : 0;   // TASK-72 A2: scan-cadence gap (baseline 100/160ms)
  _dodgeTickAt = now;
  lastScanAt = now;

  const player = poe2.getLocalPlayer();
  if (!player || !player.isAlive || !player.worldX) { lastDecision = 'no player'; walkEgress = null; return false; }
  // TASK-54 D: measure the previous roll's actual displacement (~400ms later) -> ban a wall-blocked bearing sector.
  // Runs before the mid-roll bail below so a stale pending measurement is always resolved/pruned.
  _checkRollWall(player, now);
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

  // TASK-72 A2: stall wake-up on a shaky char -> instant PANIC egress. Don't wait for the -X%/2s windows to
  // accumulate post-wake samples; the ring restart keeps pre-stall samples from double-firing them.
  if (STALL_WAKE_ON && _swGap > STALL_WAKE_GAP_MS) {
    const _swHp = (player.healthCurrent || 0) + (player.esCurrent || 0);
    const _swMx = (player.healthMax || 0) + (player.esMax || 0);
    const _swFrac = _swMx > 0 ? _swHp / _swMx : 1;
    if (_swFrac < STALL_WAKE_HP_FRAC) {
      _blindHpHist.length = 0;
      _panicUntil = now + PANIC_HOLD_MS;   // _tryPanicEgress's committed-hold path arms walkEgress this scan
      _lastEgressAt = now; _lastHpEgressAt = now;   // HP-driven (the calm gate consumes _lastHpEgressAt)
      if (now - _stallWakeLogAt > 3000) {
        _stallWakeLogAt = now;
        (CFG.log || console.log)('[AutoDodge] stall-wake ' + _swGap + 'ms at ' + Math.round(_swFrac * 100) + '% -> PANIC egress');
      }
    }
  }

  // Catchall-tame scan state: effective hp% (budget damage-unmute + the channel-hold floor) and the
  // rotation-published channel hold. channelHoldUntil bounds the hold to the channel's own timeout even
  // if rotation dies mid-channel and never clears the flag.
  if (CATCHALL_TAME_ON) {
    const _thp = (player.healthCurrent || 0) + (player.esCurrent || 0);
    const _tmx = (player.healthMax || 0) + (player.esMax || 0);
    _playerHpPct = _tmx > 0 ? (_thp / _tmx) * 100 : 100;
    _chHoldActive = POE2Cache.channelHoldActive === true && now <= (POE2Cache.channelHoldUntil || 0);
  }

  // TASK-33: sample pooled hp+es every scan (reuses the player read already in hand -- no new entity scan) into a
  // short ring, so a fast drop with NOTHING in the hazard list can be detected at the "no visible hazard" bail below.
  // TASK-34 C reads the same ring (narrower window) for the PANIC override.
  if (BLIND_EGRESS_ON || PANIC_EGRESS_ON) {
    const _bhp = (player.healthCurrent || 0) + (player.esCurrent || 0);
    const _bmx = (player.healthMax || 0) + (player.esMax || 0);
    _blindHpHist.push({ pct: _bmx > 0 ? (_bhp / _bmx) * 100 : 100, at: now });
    while (_blindHpHist.length && now - _blindHpHist[0].at > BLIND_EGRESS_WINDOW_MS) _blindHpHist.shift();
  }

  const allowList = parseList(CFG.allowList);
  const denyList = parseList(CFG.denyList);

  const result = collectHazardsAndEnemies(player, now, allowList, denyList);
  const hazards = result.hazards;
  const enemies = result.enemies;
  // TASK-33: remember the kill-zone (nearby-enemy centroid) each scan -> blind egress heads AWAY from where mobs
  // die/explode. World coords, matching player.worldX/Y. Reuses the enemies list already collected (no new scan).
  if ((BLIND_EGRESS_ON || PANIC_EGRESS_ON) && enemies.length) {
    let _sx = 0, _sy = 0;
    for (const _en of enemies) { _sx += _en.wx; _sy += _en.wy; }
    _blindKillZone = { x: _sx / enemies.length, y: _sy / enemies.length, at: now };
  }
  // TASK-35 D: publish the channel threat bus. Nearest-first so the CC probe usually runs once; an id-less
  // entry can't be verified CC'd -> counts as a threat (conservative).
  if (CHANNEL_THREAT_INTERRUPT_ON) {
    let _td = Infinity;
    const _cand = [];
    for (const _en of enemies) _cand.push({ d: Math.hypot(_en.wx - player.worldX, _en.wy - player.worldY) / G2W, id: _en.id });
    _cand.sort((a, b) => a.d - b.d);
    for (const _c of _cand) {
      if (_c.d > CHANNEL_THREAT_PROBE_U) { _td = _c.d; break; }
      if (!_ownerHardCCd(_c.id)) { _td = _c.d; break; }
    }
    try { POE2Cache.channelThreatD = _td; POE2Cache.channelThreatAt = now; } catch (e) {}
  }
  // BOSS-OPENER GUARD (user: 'you take the first initial hit RIGHT AWAY -- he flops onto the player'):
  // activation slams carry NO readable telegraph (the boss 'rises' with an untyped action), so the scan sees
  // nothing until the hit lands. For ~2.2s after engagement the boss position IS a hazard circle -- the normal
  // roll/egress machinery backs us out of opener range, then the guard expires and the fight proceeds.
  if (now < _openerGuardUntil) {
    hazards.push({ kind: 'boss_telegraph', impactX: _openerX, impactY: _openerY, radius: 300, etaMs: 200,
      score: 15, name: 'BossOpener', sourceRarity: RARITY_UNIQUE });
  }
  lastHazards = hazards; _lastHazardsAt = now;

  // TASK-41: publish the classified ground hazards (GRID coords) so the mapper's plant/stand decisions can
  // reject a stand cell inside one (fightHoldPostureStep). One-way bus, same pattern as the channel threat
  // bus; published every scan (empty included) so the consumer can gate on freshness.
  if (GROUND_CLASSIFY_ON) {
    const _gh = [];
    for (const h of hazards) if (h.sev) _gh.push({ gx: h.impactX / G2W, gy: h.impactY / G2W, r: h.radius / G2W, sev: h.sev, cls: h.name });
    try { POE2Cache.groundHazards = _gh; POE2Cache.groundHazardsAt = now; } catch (e) {}
  }

  if (CFG.debug && (now - _dbgAt > 400) && (_dbgActions.length || hazards.length)) {
    _dbgAt = now;
    const acts = _dbgActions.slice(0, 5).map(a => `${a.n}/${a.sk}[r${a.rar} aoe${a.aoe} geo${a.geo}gr${a.gr} tgt${a.tgt} ${a.d}u]`).join(' ') || 'nothing';
    const haz = hazards.map(h => `${h.kind}:${(h.name || '').split('/').pop()}@eta${Math.round(h.etaMs || 0)}`).join(' ') || 'NONE';
    (CFG.log || console.log)(`[Dodge] mode=${CFG.mode} | BOSS-DOING: ${acts} | DODGE-SEES: ${haz}`);
  }

  // TASK-34 C: PANIC override BEFORE the risk arbitration -- a >=25%-in-2s pooled drain walks out regardless of the
  // hazard list and of every hold below (channel/interact/reach). walkEgress is exported; the mapper walks us out.
  if (PANIC_EGRESS_ON && _tryPanicEgress(player, now)) return false;

  let atRisk = playerAtRisk(player.worldX, player.worldY, hazards);
  let hardRisk = atRisk;   // T0.2: the HARD signal (real collision / standing in a zone) BEFORE the soft proximity nets add to it

  // TASK-41: a LETHAL classified hazard (explode_on_death beacon) arms the at-risk gate at radius + 15u -- the
  // char must LEAVE before detonation, not react after. HARD risk by construction, so the channel protection and
  // the interact/combat holds (soft-only) never hold it; the reach-hold bypass is explicit below.
  let _lethalHaz = null;
  if (GROUND_CLASSIFY_ON) {
    const _lm = GROUND_LETHAL_MARGIN_U * G2W;
    for (const h of hazards) {
      if (h.sev !== 2) continue;
      if (dist2d(player.worldX, player.worldY, h.impactX, h.impactY) <= h.radius + _lm) { _lethalHaz = h; break; }
    }
    if (_lethalHaz) { atRisk = true; hardRisk = true; }
  }

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
    // ROLL RESERVE (IceCave 08:37 DEATH #7): the 'elite point-blank' arm fired off the BOSS ITSELF standing
    // close -- a blind repositioning roll that burned the cooldown 0.5s before its OPENER telegraph spawned;
    // the slam at 16u then only got a walk-out. A UNIQUE never arms this net (boss telegraphs/kite own it),
    // and while an acting unique is within reserve range the trash-count arm stands down too: the roll is
    // RESERVED for the boss. Trash-surround while bossless keeps today's net exactly.
    const _rsvSq = (65 * G2W) * (65 * G2W);
    let meleeCount = 0, elitePointBlank = false, _uniqueClose = false;
    for (const en of enemies) {
      if (!en.acting) continue;   // idle/frozen mobs aren't swinging -> not a surround threat
      const ddx = en.wx - player.worldX, ddy = en.wy - player.worldY;
      const dSq = ddx * ddx + ddy * ddy;
      if (ROLL_RESERVE_ON && en.rarity === RARITY_UNIQUE && dSq <= _rsvSq) _uniqueClose = true;
      if (dSq <= strikeSq) meleeCount++;
      if (en.rarity >= RARITY_MAGIC && !(ROLL_RESERVE_ON && en.rarity === RARITY_UNIQUE) && dSq <= pointBlankSq) elitePointBlank = true;
    }
    if (_uniqueClose) { /* reserved for the boss */ }
    else if (meleeCount >= 3 || elitePointBlank) { atRisk = true; lastDecision = 'rare surround (' + meleeCount + ' melee)'; }
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
  // TASK-41: `!_lethalHaz` -- the reach-hold tanks casts/fire for the opener, but a beacon pile one-shots from
  // full hp; a LETHAL classified hazard always takes the frame.
  if (atRisk && !_lethalHaz && CFG.reachHoldActive === true && now >= _reachHoldCool) {
    if (!_reachHeldSince) _reachHeldSince = now;
    if (now - _reachHeldSince <= 5000) { walkEgress = null; lastDecision = 'opener-reach hold'; return false; }
    _reachHoldCool = now + 1500; _reachHeldSince = 0;   // capped -> release briefly to recover, then re-hold
  } else if (!(atRisk && CFG.reachHoldActive === true)) {
    _reachHeldSince = 0;
  }
  if (hazards.length === 0 && !atRisk) {
    // TASK-33: nothing visible to dodge, but pooled hp+es may be dropping fast -> we could be standing in an
    // un-classified damaging ground (on-death explosion circles). Walk out; a real hazard (hazards.length>0, handled
    // above) or a stopped drain hands the frame straight back to the normal dodge.
    if (BLIND_EGRESS_ON) {
      if (_tryBlindEgress(player, enemies, now)) return false;   // egress active -> walkEgress held, mapper walks us out
      _blindEgressUntil = 0; _egActiveSince = 0;
    }
    lastDecision = 'no hazards'; walkEgress = null; return false;
  }
  if (!atRisk) { lastDecision = 'not at risk (' + hazards.length + ' hazards)'; walkEgress = null; return false; }

  // WHY are we dodging (user: name the trigger in every roll line): the containing/colliding hazard for a hard
  // risk, else which proximity net fired.
  let riskWhy = '';
  if (hardRisk) {
    // TASK-41: a LETHAL hazard names the risk even when we ALSO stand in something else (the autopsy stack:
    // shocked carpet + beacons -- naming the carpet would route into the walk-only DoT path while the pile
    // detonates). 'lethal:' deliberately never matches the 'ground:' DoT test -> rolls stay allowed.
    if (_lethalHaz) {
      riskWhy = 'lethal:' + ((_lethalHaz.name || '?').split('/').pop());
    } else {
      for (const h of hazards) {
        if (h.kind !== 'projectile' && pointInHazard(player.worldX, player.worldY, h)) { riskWhy = h.kind + ':' + ((h.name || '?').split('/').pop()); break; }
      }
      if (!riskWhy) riskWhy = 'projectile-path';
    }
  } else {
    riskWhy = lastDecision && lastDecision.includes('surround') ? lastDecision : 'proximity-net';
  }
  // DoT ground (map-mod burning/chilled/shocked, caustic, abyss cracks): rolling doesn't cancel the burn -- it
  // dances in place on cooldown while the walker drags us back through (user DIED yoyoing in IgnitedGround).
  // These escape by SUSTAINED goal-biased walk-out only (flagged here, applied below).
  const _dotGroundRisk = riskWhy.startsWith('ground:')
    && (SOFT_GROUND_BLEED_ON ? /chill|coldsnap|shock|ignit|burn|caustic|abysscrack|blood|bleed/i
      : /chill|coldsnap|shock|ignit|burn|caustic|abysscrack/i).test(riskWhy);

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
  // DoT CARPET AT HEALTHY HP (the 37-min silent yoyo, 2026-07-16): a chilled/low-dps carpet is a slow, not a
  // killer -- fighting the walker over it (walk-out pulls out, nav pulls back through, forever) costs the whole
  // map. Under no HP pressure, don't arm the walk-out for the ground-DoT class at all; the walker crosses the
  // patch normally, and the PANIC/blind egress still own a real HP collapse the instant one starts.
  const _dotCalm = _dotGroundRisk && _playerHpPct >= 80;
  if (!_dotCalm && (_endIn || (_plyIn && (!rollReady || _dotGroundRisk)))) {
    if (!walkEgress || now - _egressHoldAt > 2500) {
      let _egDx = choice.dx, _egDy = choice.dy;
      // TASK-73 C: inside the boss kite floor the walk-out IS the retreat -- the hazard-scored heading can be
      // tangential/inward, and the dodge then owns every frame while pinning the char at melee. Radial-out wins
      // when its path is walkable; a walled retreat keeps the scored heading (never walk into a wall for this).
      if (BOSS_KITE_RESUME_ON) {
        const _bk = _bossKiteRadial(player.gridX || 0, player.gridY || 0, now);
        if (_bk && isPathWalkable(player.gridX || 0, player.gridY || 0, _bk.ax, _bk.ay, CFG.estimatedRollDist || 46)) { _egDx = _bk.ax; _egDy = _bk.ay; }
      }
      walkEgress = { dx: _egDx, dy: _egDy }; _egressHoldAt = now;
      _lastEgressAt = now;   // TASK-72 B: field walk-out arm/re-arm (<=2.5s cadence) feeds the calm gate
      // The arm was SILENT (only rolls log) -- name it, throttled, so a walk-out vs walker contention is
      // readable from the log instead of manifesting as an unexplained yoyo.
      if (now - _egArmLogAt > 8000) { _egArmLogAt = now; (CFG.log || console.log)('[AutoDodge] field walk-out: ' + riskWhy + (_dotGroundRisk ? ' (DoT carpet)' : '')); }
    }
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
    if (now - _egActiveSince > 14000) {
      // CYCLE ESCALATION (anti tug-of-war): a stand-down that re-arms 4s later against the SAME hazard, over and
      // over, is the walker and the walk-out fighting -- 3 fruitless 14s cycles = concede the field to the
      // pathfinder for 20s (it routes AROUND; the straight-line push clearly can't leave). Named, so it's visible.
      walkEgress = null; _egActiveSince = 0;
      _egCycleN = (_egCycleWhy === riskWhy) ? _egCycleN + 1 : 1; _egCycleWhy = riskWhy;
      _egCoolUntil = now + (_egCycleN >= 3 ? 20000 : 4000);
      if (_egCycleN >= 3) (CFG.log || console.log)('[AutoDodge] field walk-out CYCLING vs "' + riskWhy + '" (' + _egCycleN + 'x14s, still inside) -> stand down 20s (pathfinder owns)');
    }
  } else {
    walkEgress = null;
    _egActiveSince = 0;
    _egCycleN = 0; _egCycleWhy = '';   // genuinely left the field -> the cycle broke honestly
  }
  if (walkEgress && now < _egCoolUntil) walkEgress = null;   // stand-down: pathfinder owns movement for a beat
  // DoT GROUND = WALK OUT, NEVER ROLL: the sticky egress (set above, goal-biased so escape IS progress) owns the
  // exit; the roll stays reserved for real telegraphs (a telegraph landing while we stand in burn still rolls --
  // riskWhy picks the containing telegraph, not the ground). Stand-down window still lets the pathfinder cross
  // a patch deliberately.
  if (_dotGroundRisk && _insideField) { lastDecision = 'walk-out ' + riskWhy + ' (no roll)'; return false; }
  if (!rollReady) {
    // DOUBLE DODGE (tracking swing): roll #1 fired, but an already-dodged boss/rare swing RE-AIMED and still
    // covers us at the landing spot -- one chained re-roll per action instance, only fresh after a roll.
    // Static casts are untouched: their mute holds because we end up outside their (fixed) geometry.
    let _dd = null;
    if (DOUBLE_DODGE_ON && now - lastDodgeAt < DOUBLE_DODGE_WINDOW_MS) {
      for (const [_f, _t] of _ddFp) if (now - _t > 6000) _ddFp.delete(_f);
      for (const h of hazards) {
        if (h.kind !== 'melee' && h.kind !== 'boss_telegraph') continue;
        if ((h.sourceRarity || 0) < RARITY_RARE) continue;
        if (!h.fingerprint || !dodgedActions.has(h.fingerprint) || _ddFp.has(h.fingerprint)) continue;
        if (pointInHazard(player.worldX, player.worldY, h)) { _dd = h; break; }
      }
    }
    if (!_dd) return false;   // roll gated, egress already exported -- the walk-out continues meanwhile
    _ddFp.set(_dd.fingerprint, now);
    (CFG.log || console.log)('[AutoDodge] DOUBLE DODGE: ' + ((_dd.name || _dd.kind) + '').split('/').pop() + ' tracked through roll #1 -> chained re-roll');
  }

  // ROLL-DISPLACEMENT GUARD: consecutive rolls that moved us <12w = rolling into a wall; stop rolling (walk-only
  // escape) until real displacement resumes. Kills the every-1.4s same-angle roll spam while wedged.
  if (_rollFails >= 2 && _insideField) {
    if (Number.isFinite(_lastRollPX) && Math.hypot(player.worldX - _lastRollPX, player.worldY - _lastRollPY) > 40) _rollFails = 0;   // we've since moved -> rolls useful again
    else { lastDecision = 'roll suppressed (no displacement)'; return false; }
  }

  // Inside a field, roll ALONG the held escape heading, not the freshly re-scored one.
  const _rdx = (walkEgress && _insideField) ? walkEgress.dx : choice.dx;
  const _rdy = (walkEgress && _insideField) ? walkEgress.dy : choice.dy;
  const ok = performDodge(_rdx, _rdy, 'angle=' + ((Math.atan2(_rdy, _rdx) * 180 / Math.PI) | 0) + ' why=' + riskWhy + (_bkrLast ? ' kite-radial' : ''));
  if (ok) {
    if (Number.isFinite(_lastRollPX) && now - _lastRollT < 4000
        && Math.hypot(player.worldX - _lastRollPX, player.worldY - _lastRollPY) < 12) _rollFails++;
    else _rollFails = 0;
    _lastRollPX = player.worldX; _lastRollPY = player.worldY; _lastRollT = now;
    // TASK-54 D: arm the wall-feedback measurement for THIS roll (bearing = the direction actually rolled).
    if (ROLL_WALL_FEEDBACK_ON) _pendRoll = { ang: Math.atan2(_rdy, _rdx), px: player.worldX, py: player.worldY, at: now, expDist: _rollW };
  }
  if (ok) {
    lastDodgeAt = now;
    for (const h of hazards) {
      if (!h.fingerprint) continue;
      if (h.kind === 'projectile') continue;
      if (pointInHazard(player.worldX, player.worldY, h)) {
        dodgedActions.set(h.fingerprint, now);
        if (String(h.fingerprint).includes('_dll:')) dllActionDodged.set(h.fingerprint, now);
        if (CATCHALL_TAME_ON) _noteCatchallDodge(h, now);
      }
    }
  }
  return ok;
}

export function autoDodgeStatus() {
  return { lastDecision, hazards: lastHazards.length, walkEgress, lastEgressAt: _lastEgressAt, lastHpEgressAt: _lastHpEgressAt };
}

// TASK-32 D: read-only peek at the cached hard-CC verdict for one entity (the catchall CC probe). Returns null
// when the dodge never probed this id (itself diagnostic). No new scan -- reads _ccVerdicts populated by the
// live catchall path.
export function getCatchallCcVerdict(entityId) {
  const c = _ccVerdicts.get(entityId);
  if (!c) return null;
  return { cc: c.cc, ageMs: Date.now() - c.at };
}

// TASK-32 A: clear the per-map promote-on-hit registry. Called by the mapper on map change (resetMapper).
// TASK-41 rides along: entity ids are per map-instance, so the ground-class verdict cache clears here too.
export function resetCatchallPromotions() {
  _hazHabit.clear();   // static-hazard habituation is per-map (ids recycle across maps)
  _selfFx.clear();     // self-attached effect ledger is per-map (same id-recycle reason)
  _catchallPromoted.clear();
  _groundClassCache.clear();
  // TASK-54 A/D: entity ids + arena geometry are per map-instance -> the roll-cadence stamps and the wall-sector
  // bans clear here too (a new map's boss/arena starts with a clean cadence + no stale banned bearings).
  _catchallRollAt.clear();
  _rollWallBans = [];
  _pendRoll = null;
  dllActionDodged.clear();   // recovered-action sequences are per map-instance (entity ids recycle)
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

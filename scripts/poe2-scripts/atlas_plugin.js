/**
 * Atlas Plugin - Displays atlas node information
 * 
 * Screen position = Rel * Zoom
 * Square size = 37.03703703704 * Zoom
 */

const poe2 = new POE2();

// Plugin state
let lastAtlasData = null;
let lastPopupRect = null;
let selectedNodeIndex = -1;
let selectedNodeKey = null; // stable grid-pos key of the selected node (survives UI slot recycling)

// Map-info content-category cache (node index -> {label,color}|null); throttled in onDrawUI
// because the DAT-row reads aren't free and node addresses drift every frame.
let mapInfoCache = {};
let mapInfoCacheTime = 0;

// Stage 2: action results (cleared when selection changes)
let lastActivationResult = null;   // { index, success, activationX, activationY, error? }
let lastActivationTime = 0;
let lastProbeResult = null;        // { index, data, error? }
let lastProbeTime = 0;

// Settings
const showOnlyVisible = new ImGui.MutableVariable(false);
const selectableOnly = new ImGui.MutableVariable(false);
const showTraits = new ImGui.MutableVariable(true);
const highlightSelected = new ImGui.MutableVariable(true);
const highlightAll = new ImGui.MutableVariable(true);
const sortByDistance = new ImGui.MutableVariable(false);

// Filter
let filterText = "";

// --- Route planner (Terrain::WorldMapConnections web graph) state ---
// The DLL feeds node.neighbors (Location-keyed adjacency, container+0x590) and
// meta.exactGraph. This plans an optimal hop-path from the best AVAILABLE start
// (or a picked node) to a desired name/trait. See computeRoute + G below.
let route = null;            // { startIdx, goalIdx, path:[idx], hops, dist, disconnected? }
let routeGoalAddr = 0;       // explicit goal = a node picked in the list; 0 = use Desired text
let desiredText = "";        // route target: name / trait search
const drawRoute = new ImGui.MutableVariable(true);
const drawWebEdges = new ImGui.MutableVariable(false);
const frontierStart = new ImGui.MutableVariable(true);

// Special trait colors (ABGR format for ImGui)
const COLOR_DEFAULT = 0xFF00FF00;       // Green
const COLOR_SELECTED = 0xFF00FFFF;      // Yellow/Cyan
const COLOR_UNIQUE = 0xFFFF00FF;        // Magenta (unique maps)
const COLOR_BOSS = 0xFF0000FF;          // Red (deadly boss)
const COLOR_ABYSS = 0xFFFF8800;         // Orange (abyss overrun)
const COLOR_MOMENT = 0xFFFFFF00;        // Cyan (moment of zen)
const COLOR_NEXUS = 0xFF8800FF;         // Purple (corrupted nexus)
const COLOR_CLEANSE = 0xFF88FF88;       // Light green (cleansed)
const COLOR_ARROW = 0xFF00FFFF;         // Yellow for off-screen arrow

// Base square size (will be multiplied by zoom)
const BASE_SQUARE_SIZE = 37.03703703704;

function getSpecialTraitFlags(node) {
  const flags = {
    unique: false,
    boss: false,
    abyss: false,
    moment: false,
    nexus: false,
    cleanse: false
  };
  
  if (!node.traits) return flags;
  
  for (const trait of node.traits) {
    const name = (trait.name || "").toLowerCase();
    if (name.includes("unique")) flags.unique = true;
    if (name.includes("boss")) flags.boss = true;
    if (name.includes("abyss")) flags.abyss = true;
    if (name.includes("moment")) flags.moment = true;
    if (name.includes("nexus")) flags.nexus = true;
    if (name.includes("cleanse")) flags.cleanse = true;
  }
  
  // Also check fullName for special indicators
  const fullName = (node.fullName || "").toLowerCase();
  if (fullName.includes("unique")) flags.unique = true;
  
  return flags;
}

function hasAnySpecialTrait(flags) {
  return flags.unique || flags.boss || flags.abyss || flags.moment || flags.nexus || flags.cleanse;
}

function getSpecialTraitString(flags) {
  const parts = [];
  if (flags.unique) parts.push("unique");
  if (flags.boss) parts.push("boss");
  if (flags.abyss) parts.push("abyss");
  if (flags.moment) parts.push("moment");
  if (flags.nexus) parts.push("nexus");
  if (flags.cleanse) parts.push("cleanse");
  return parts.join(" ");
}

// Selectable / "able to activate" = the in-game gate sub_140B0F560(node), which
// for the live cases reduces to (node+815 & 3) == 1. Confirmed A/B: Canyon
// (clickable) = 1; Pit ("visible but I haven't reached it") = 0. Opening a
// non-selectable node just toggles the popup closed, so flag/dim them here.
function isNodeSelectable(node) {
  if (!node || !node.address) return false;
  try { return (poe2.readMemory(Math.floor(node.address) + 815, "int32") & 3) === 1; }
  catch (e) { return false; }
}

// Verified map-info read (9-agent workflow, 2026-06-21): node+0x300 -> EndgameMaps.dat
// row (SHARED per base-map-type, UNALIGNED), row deref -> WorldAreas record. Returns
// name/flavor/contentSet/boss/intrinsic-mods for map-filtering. BIOME + the rolled blue
// affixes ("115% increased Experience") are NOT DAT cells -> not available here.
function readMapInfo(nodeAddr) {
  if (!nodeAddr) return null;
  const node = Math.floor(nodeAddr);
  const u64 = (a) => { const lo = poe2.readMemory(a, "int32") >>> 0, hi = poe2.readMemory(a + 4, "int32") >>> 0; return hi * 4294967296 + lo; };
  const heap = (p) => p > 0x10000000000 && p < 0x100000000000;
  const wstr = (p) => { try { if (!heap(p)) return null; const s = poe2.readWideString(p); return (s && s.length < 256) ? s : null; } catch (e) { return null; } };
  try {
    const row = u64(node + 0x300);     if (!heap(row)) return null;
    const rowMeta = u64(row);          if (!heap(rowMeta)) return null;
    const info = {
      baseMapName: wstr(u64(rowMeta + 0x08)),   // "Confluence" (node+0x2E0 is empty for maps)
      areaId:      wstr(u64(rowMeta + 0x00)),   // "MapSevenWaters"
      flavorText:  wstr(u64(row + 0x20)),       // "Where nomads share tales..."
      mapTypeTag:  poe2.readMemory(rowMeta + 0x2A, "int32") & 0xFFFF,
      contentSet:  null, firstPack: null, intrinsicMods: [],
    };
    const csFK = u64(row + 0x6c);                                // content-set FK
    if (heap(csFK)) info.contentSet = wstr(u64(csFK));           // "CorruptedMap" / "BreachTowerBoss" / ...
    const mpCount = u64(row + 0x10), mpArr = u64(row + 0x18);    // monster-pack / boss FK array
    if (mpCount > 0 && mpCount < 1000 && heap(mpArr)) {
      const p0 = u64(mpArr);
      if (heap(p0)) info.firstPack = wstr(u64(p0));              // "chaos-vulturedemon"
    }
    const cnt = u64(rowMeta + 269), arr = u64(rowMeta + 277);    // m_MapMods (DECIMAL offsets), 16B stride
    if (cnt > 0 && cnt < 32 && heap(arr)) {
      for (let k = 0; k < cnt; k++) {
        const rk = u64(arr + 16 * k);
        if (heap(rk)) { const id = wstr(u64(rk)); if (id) info.intrinsicMods.push(id); }
      }
    }
    return info;
  } catch (e) { return null; }
}

// Classify the map's content set (the REAL content discriminator — the old trait
// classByte is always 0, so trait coloring never fired). null = plain "CorruptedMap".
function classifyContent(cs) {
  if (!cs) return null;
  const s = cs.toLowerCase();
  if (s === "corruptedmap") return null;
  if (s.includes("boss"))      return { label: "Boss",      color: [1.0, 0.55, 0.0, 1.0] };
  if (s.includes("unique"))    return { label: "Unique",    color: [1.0, 0.3, 1.0, 1.0] };
  if (s.includes("breach"))    return { label: "Breach",    color: [0.65, 0.45, 1.0, 1.0] };
  if (s.includes("delirium"))  return { label: "Delirium",  color: [0.8, 0.8, 1.0, 1.0] };
  if (s.includes("abyss"))     return { label: "Abyss",     color: [0.3, 1.0, 0.3, 1.0] };
  if (s.includes("incursion")) return { label: "Incursion", color: [0.4, 1.0, 0.6, 1.0] };
  if (s.includes("reliquary")) return { label: "Reliquary", color: [1.0, 0.85, 0.2, 1.0] };
  if (s.includes("tower"))     return { label: "Tower",     color: [0.5, 0.8, 1.0, 1.0] };
  if (s.includes("hub"))       return { label: "Hub",       color: [0.0, 1.0, 1.0, 1.0] };
  if (s.includes("camp") || s.includes("kingsmarch")) return { label: "Town",  color: [0.7, 0.7, 0.7, 1.0] };
  if (s.includes("hidden") || s.includes("vault"))    return { label: "Vault", color: [0.9, 0.7, 0.3, 1.0] };
  return { label: cs, color: [0.6, 1.0, 0.6, 1.0] };
}

// ImGui text fns are printf-style; escape % in any data string we display.
function esc(s) { return String(s).replace(/%/g, "%%"); }

function u64r(a) { const lo = poe2.readMemory(a, "int32") >>> 0, hi = poe2.readMemory(a + 4, "int32") >>> 0; return hi * 4294967296 + lo; }

// Stable per-node identity = atlas grid position (node+0x320/+0x324). The atlas recycles
// its UI slots, so a stored list INDEX can point at a different map by the time you click
// Open (the "I clicked Canyon, Razed Fields opened" bug). We key selection on this grid
// pos and re-sync selectedNodeIndex to whatever slot currently holds it, every frame.
function gridKey(node) {
  if (!node || !node.address) return null;
  const a = Math.floor(node.address);
  try { return (poe2.readMemory(a + 0x320, "int32") | 0) + "," + (poe2.readMemory(a + 0x324, "int32") | 0); }
  catch (e) { return null; }
}
function syncSelection() {
  if (selectedNodeKey == null || !lastAtlasData || !lastAtlasData.nodes) return;
  const nodes = lastAtlasData.nodes;
  if (selectedNodeIndex >= 0 && selectedNodeIndex < nodes.length && gridKey(nodes[selectedNodeIndex]) === selectedNodeKey) return; // still correct
  for (let i = 0; i < nodes.length; i++) { if (gridKey(nodes[i]) === selectedNodeKey) { selectedNodeIndex = i; return; } }
}

// Per-node CONTENT read AT REST from BASE-GAME arrays (NOT the fragile UI widget tree),
// solved by the 2nd workflow. Channel A: node+0x368(begin)/+0x370(end) = byte array, each
// byte = row index into EndgameMapContent.dat (66 rows, dumped below). Verbatim keys,
// popup-CLOSED. (Order = data-file; stable within a patch — re-dump if a patch shifts it.)
const ENDGAME_CONTENT = ["PowerfulMapBoss","Breach","Expedition","Delirium","Ritual","Irradiated","AbyssOverrun","Incursion","Abyss","QuestArea","BreachCity","HildaHuntBoss","EssenceOverrun","StrongboxMonsterousTreasure","AzmeriSpiritGuide","MagicMonsters","RogueExileHuntingGrounds","ShrinesReaseSpirits","EssenceTwinned","EssenceTransfer","AzmeriSpiritHighPower","AzmeriMovingMaps","AzmeriMovingMapsUpgraded","StrongboxUnique","StrongboxOpenTwiceChance","ShrineEffect","ShrinePackSize","ShrineElementalBonus","ShrineExiry","ShrineRogueExile","RogueExileTwin","RogueExilePossesOnSpiritDeath","StoneCircleDoubleBoss","StoneCircleExtras","MapChanged","RogueExileUpgraded","BreachHive","Simulacrum","OneOfAll","ItemRarity","BossUniqueItem","BossUltimarumKey","BossSanctumKey","AzmeriSpiritBossPossessed","GiantMonsters","RareCurrencyOnly","StoneCircleBossEmpoweredPerEnemySlain","Headhunter","AzmeriSpiritSwarm","MapBossesInArea","CorruptionRandomArea","TabletDoubleEffect","ExceptionalItemChance","WaterBiome","MountainBiome","GrassBiome","ForestBiome","SwampBiome","DesertBiome","ImmuredFuryQuest","AllDropsNotEquipment","ExperienceGain","AllDropsNotGold","LivesAndEffectiveness","ItemRarityGreater","DuplicatedRares"];
// Channel B: node+0x350(begin)/+0x358(end) = {u16 statId, u16 weight} = Stats.dat rolled
// mechanic presence. Known statIds (full resolution would need the Stats table base):
const MECHANIC_STATS = { 19544: "Powerful Boss", 26734: "Delirium", 26735: "Abyss", 26736: "Ritual", 26737: "Incursion", 26738: "Breach" };

function readContentTraits(nodeAddr) {
  if (!nodeAddr) return [];
  const node = Math.floor(nodeAddr);
  const b = u64r(node + 0x368), e = u64r(node + 0x370);
  if (!(b > 0x10000000000 && b < 0x100000000000) || e < b || e - b > 0x800) return [];
  const out = [];
  for (let q = b; q < e; q++) { const i = poe2.readMemory(q, "int8") & 0xFF; out.push(i < 66 ? ENDGAME_CONTENT[i] : ("#" + i)); }
  return out;
}
function readMechanics(nodeAddr) {
  if (!nodeAddr) return [];
  const node = Math.floor(nodeAddr);
  const b = u64r(node + 0x350), e = u64r(node + 0x358);
  if (!(b > 0x10000000000 && b < 0x100000000000) || e <= b || e - b > 0x1000) return [];
  const out = [];
  for (let q = b; q < e; q += 4) { const id = poe2.readMemory(q, "int16") & 0xFFFF; const nm = MECHANIC_STATS[id]; if (nm && out.indexOf(nm) < 0) out.push(nm); }
  return out;
}
// Classify a content-traits list -> {label,color} (primary content for the list color).
function classifyTraits(traits) {
  if (!traits || !traits.length) return null;
  const has = (re) => traits.some(t => re.test(t));
  if (has(/Boss|HildaHunt/)) return { label: "Boss", color: [1.0, 0.55, 0.0, 1.0] };
  if (has(/Breach/))         return { label: "Breach", color: [0.65, 0.45, 1.0, 1.0] };
  if (has(/Delirium/))       return { label: "Delirium", color: [0.8, 0.8, 1.0, 1.0] };
  if (has(/Abyss/))          return { label: "Abyss", color: [0.3, 1.0, 0.3, 1.0] };
  if (has(/Incursion/))      return { label: "Incursion", color: [0.4, 1.0, 0.6, 1.0] };
  if (has(/Ritual/))         return { label: "Ritual", color: [1.0, 0.4, 0.4, 1.0] };
  if (has(/Expedition/))     return { label: "Expedition", color: [0.9, 0.8, 0.5, 1.0] };
  if (has(/Essence/))        return { label: "Essence", color: [0.5, 0.9, 1.0, 1.0] };
  if (has(/Simulacrum/))     return { label: "Simulacrum", color: [0.7, 0.7, 1.0, 1.0] };
  if (has(/Headhunter/))     return { label: "Headhunter", color: [1.0, 0.6, 0.2, 1.0] };
  if (has(/Azmeri|Spirit/))  return { label: "Azmeri", color: [0.6, 1.0, 0.8, 1.0] };
  if (has(/Shrine/))         return { label: "Shrine", color: [0.7, 1.0, 0.7, 1.0] };
  if (has(/Exile/))          return { label: "Exile", color: [1.0, 0.7, 0.4, 1.0] };
  if (has(/StoneCircle/))    return { label: "StoneCircle", color: [0.8, 0.7, 0.5, 1.0] };
  if (has(/Strongbox/))      return { label: "Strongbox", color: [0.9, 0.8, 0.4, 1.0] };
  if (has(/Biome/))          return null;
  return { label: traits[0], color: [0.6, 1.0, 0.6, 1.0] };
}

function nodeMatchesFilter(node, filter) {
  if (!filter || filter.length === 0) return true;
  
  const lowerFilter = filter.toLowerCase();
  const flags = getSpecialTraitFlags(node);
  
  // Check name
  const shortName = (node.shortName || "").toLowerCase();
  const fullName = (node.fullName || "").toLowerCase();
  if (shortName.includes(lowerFilter) || fullName.includes(lowerFilter)) return true;
  
  // Check traits
  if (node.traits) {
    for (const trait of node.traits) {
      const traitName = (trait.name || "").toLowerCase();
      if (traitName.includes(lowerFilter)) return true;
    }
  }
  
  // Check special trait keywords
  const specialStr = getSpecialTraitString(flags);
  if (specialStr.includes(lowerFilter)) return true;
  
  return false;
}

function rectsOverlap(rect1, rect2) {
  return !(rect1.x + rect1.width < rect2.x ||
           rect2.x + rect2.width < rect1.x ||
           rect1.y + rect1.height < rect2.y ||
           rect2.y + rect2.height < rect1.y);
}

// ---------------------------------------------------------------------------
// Route planner: optimal hop-path over the real WorldMapConnections web graph.
// node.neighbors are loaded-pin indices resolved by the DLL from the master
// connection array (pins_container+0x590). Undirected, unit-weight -> BFS/Dijkstra.
// ---------------------------------------------------------------------------
const G = {
  adj: null, builtFor: -1, edges: 0, exact: false,
  ensure(nodes, meta) { if (this.builtFor !== nodes.length || !this.adj) this.build(nodes, meta); },
  build(nodes, meta) {
    const N = nodes.length;
    this.adj = new Array(N);
    for (let i = 0; i < N; i++) this.adj[i] = [];
    this.builtFor = N; this.edges = 0; this.exact = false;
    if (!meta || !meta.exactGraph) return;   // DLL didn't supply real edges
    for (let i = 0; i < N; i++) {
      const nb = nodes[i].neighbors;
      if (!nb || !nb.length) continue;
      for (const j of nb) {
        if (j < 0 || j >= N || j === i) continue;
        if (!this.adj[i].includes(j)) { this.adj[i].push(j); this.edges++; }
        if (!this.adj[j].includes(i)) { this.adj[j].push(i); this.edges++; }
      }
    }
    if (this.edges > 0) this.exact = true;
  },
  // Dijkstra rooted at `target`; prev[v] = next hop from v toward target.
  fromTarget(nodes, target) {
    const N = nodes.length;
    const dist = new Array(N).fill(Infinity);
    const prev = new Array(N).fill(-1);
    const vis = new Array(N).fill(false);
    dist[target] = 0;
    for (let it = 0; it < N; it++) {
      let u = -1, bd = Infinity;
      for (let k = 0; k < N; k++) if (!vis[k] && dist[k] < bd) { bd = dist[k]; u = k; }
      if (u < 0) break;
      vis[u] = true;
      const adj = this.adj[u] || [];
      for (const v of adj) if (dist[u] + 1 < dist[v]) { dist[v] = dist[u] + 1; prev[v] = u; }
    }
    return { dist, prev };
  },
};

function indexByAddr(nodes, addr) {
  const a = Math.floor(addr);
  for (let i = 0; i < nodes.length; i++) if (Math.floor(nodes[i].address) === a) return i;
  return -1;
}

// "Completed" = grid-state low2 == 3 (node+0x32F & 3); available/frontier == 1
// is isNodeSelectable() above. Both read the same byte the game gates clicks on.
function isCompletedNode(node) {
  if (!node || !node.address) return false;
  try { return (poe2.readMemory(Math.floor(node.address) + 0x32F, "int32") & 3) === 3; }
  catch (e) { return false; }
}

// Goal from the Desired text: nearest-to-centre node matching name/trait, not completed.
function findGoalIndex(nodes) {
  if (!desiredText) return -1;
  const vp = ImGui.getMainViewport();
  const cx = (vp ? vp.size.x : 1920) / 2, cy = (vp ? vp.size.y : 1080) / 2;
  let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (isCompletedNode(n)) continue;
    if (!nodeMatchesFilter(n, desiredText)) continue;
    const dx = (n.screenX || 0) - cx, dy = (n.screenY || 0) - cy, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function computeRoute(nodes) {
  G.ensure(nodes, lastAtlasData);
  // Goal: an explicitly picked list node (routeGoalAddr) overrides Desired text.
  let goal, explicit = false;
  if (routeGoalAddr) { goal = indexByAddr(nodes, routeGoalAddr); explicit = true; }
  else goal = findGoalIndex(nodes);
  if (goal < 0) { route = null; return null; }
  if (!explicit && isCompletedNode(nodes[goal])) { route = null; return null; }

  const { dist, prev } = G.fromTarget(nodes, goal);
  // Best start = the available node with the shortest path to goal. The goal
  // itself is a candidate: if it's already available, dist==0 -> "available now".
  let start = -1, bd = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    if (frontierStart.value && !isNodeSelectable(nodes[i])) continue;
    if (dist[i] < bd) { bd = dist[i]; start = i; }
  }
  if (start < 0 || !isFinite(bd)) {
    route = { startIdx: -1, goalIdx: goal, path: [goal], hops: 0, dist: 0, disconnected: true };
    return route;
  }
  const path = [];
  for (let c = start; c >= 0; c = prev[c]) { path.push(c); if (c === goal) break; }
  route = { startIdx: start, goalIdx: goal, path, hops: path.length - 1, dist: bd };
  return route;
}

// Screen centre of a node's icon (top-left screenX/Y + half the zoomed square).
function nodeCenter(n) {
  const h = BASE_SQUARE_SIZE * (n.zoomX || 1) * 0.5;
  return { x: (n.screenX || 0) + h, y: (n.screenY || 0) + h };
}

// onDraw: always-on per-frame work. Refresh data, draw the on-atlas overlays.
// Runs regardless of F12 UI visibility so the colored squares + arrow still
// render when the plugin manager's settings panel is hidden.
function onDraw() {
  const atlas = poe2.getAtlasNodes();
  if (atlas && atlas.isValid) {
    lastAtlasData = atlas;
  }

  if (!atlas) return;

  // Keep the selection pinned to the node you actually picked, even as the atlas recycles
  // UI slots (re-points selectedNodeIndex by the stable grid key).
  syncSelection();

  // Get popup rect to avoid drawing over it
  lastPopupRect = poe2.getAtlasPopupRect();

  // Get viewport size for off-screen detection
  const viewport = ImGui.getMainViewport();
  const screenWidth = viewport ? viewport.size.x : 1920;
  const screenHeight = viewport ? viewport.size.y : 1080;

  drawOverlays(screenWidth, screenHeight);
}

// onDrawUI: settings window. The framework only calls this when the plugin
// manager UI is visible (F12), which makes it dockable + registers the plugin
// in the settings panel alongside chicken/esp/etc. Same pattern as chicken.js.
function onDrawUI() {
  ImGui.setNextWindowSize({ x: 480, y: 500 }, ImGui.Cond.FirstUseEver);
  ImGui.setNextWindowPos({ x: 10, y: 250 }, ImGui.Cond.FirstUseEver);

  // Use cached data drawn by onDraw. If nothing cached yet, just show a hint.
  const viewport = ImGui.getMainViewport();
  const screenWidth = viewport ? viewport.size.x : 1920;
  const screenHeight = viewport ? viewport.size.y : 1080;

  if (ImGui.begin("Atlas Explorer")) {
    if (ImGui.button("Refresh")) {
      lastAtlasData = poe2.getAtlasNodes();
    }
    ImGui.sameLine();
    
    ImGui.checkbox("Visible Only", showOnlyVisible);
    ImGui.sameLine();
    ImGui.checkbox("Accessible Only", selectableOnly);
    ImGui.sameLine();
    ImGui.checkbox("Traits", showTraits);
    
    ImGui.checkbox("Highlight Selected", highlightSelected);
    ImGui.sameLine();
    ImGui.checkbox("Highlight All", highlightAll);
    ImGui.sameLine();
    ImGui.checkbox("Sort by Distance", sortByDistance);
    
    // Filter input
    ImGui.text("Filter:");
    ImGui.sameLine();
    ImGui.setNextItemWidth(200);
    const filterVar = new ImGui.MutableVariable(filterText);
    if (ImGui.inputText("##filter", filterVar)) {
      filterText = filterVar.value;
    }
    ImGui.sameLine();
    if (ImGui.button("Clear")) {
      filterText = "";
    }
    
    ImGui.separator();
    
    if (!lastAtlasData || !lastAtlasData.isValid) {
      ImGui.textColored([1.0, 0.5, 0.0, 1.0], "Atlas panel not visible");
      ImGui.text("Open the atlas in-game to see node data.");
      ImGui.end();
      return;
    }
    
    syncSelection(); // keep selectedNodeIndex pinned to the picked node (slot-recycle safe)

    const visibleCount = lastAtlasData.nodes.filter(n => n.isVisible).length;
    const filteredCount = lastAtlasData.nodes.filter(n => nodeMatchesFilter(n, filterText)).length;
    ImGui.text(`Nodes: ${lastAtlasData.nodeCount} total, ${visibleCount} visible, ${filteredCount} match`);
    
    // Legend (content categories from the DAT contentSet)
    ImGui.textColored([1.0, 0.55, 0.0, 1.0], "Boss");
    ImGui.sameLine();
    ImGui.textColored([1.0, 0.3, 1.0, 1.0], "Unique");
    ImGui.sameLine();
    ImGui.textColored([0.65, 0.45, 1.0, 1.0], "Breach");
    ImGui.sameLine();
    ImGui.textColored([0.8, 0.8, 1.0, 1.0], "Delirium");
    ImGui.sameLine();
    ImGui.textColored([0.3, 1.0, 0.3, 1.0], "Abyss");
    ImGui.sameLine();
    ImGui.textColored([0.5, 0.8, 1.0, 1.0], "Tower");
    ImGui.sameLine();
    ImGui.textColored([0.0, 1.0, 1.0, 1.0], "Hub");
    ImGui.sameLine();
    ImGui.textColored([1.0, 0.85, 0.2, 1.0], "Reliquary");
    
    ImGui.separator();

    // ---- Route Planner (WorldMapConnections web graph) ----
    G.ensure(lastAtlasData.nodes, lastAtlasData);
    ImGui.textColored([0.6, 1.0, 0.7, 1.0], "Route Planner: best available start -> desired");
    ImGui.textDisabled(`web ${G.edges}${G.exact ? " exact" : " (rebuild/reinject DLL for edges)"}`);
    ImGui.setNextItemWidth(200);
    const desiredVar = new ImGui.MutableVariable(desiredText);
    if (ImGui.inputText("Desired (name/trait)##rp", desiredVar)) desiredText = desiredVar.value;
    ImGui.sameLine();
    ImGui.checkbox("Start on available", frontierStart);
    if (ImGui.button("Find Route")) { routeGoalAddr = 0; computeRoute(lastAtlasData.nodes); }
    ImGui.sameLine();
    if (ImGui.button("Rebuild Web")) G.build(lastAtlasData.nodes, lastAtlasData);
    ImGui.sameLine();
    if (ImGui.button("Clear Route")) { route = null; routeGoalAddr = 0; }
    ImGui.sameLine();
    ImGui.checkbox("Draw route", drawRoute);
    ImGui.sameLine();
    ImGui.checkbox("Web", drawWebEdges);
    // Route to the node currently selected in the list (overrides Desired text).
    if (selectedNodeIndex >= 0 && selectedNodeIndex < lastAtlasData.nodes.length) {
      const selNode = lastAtlasData.nodes[selectedNodeIndex];
      if (ImGui.button("Route to selected")) {
        routeGoalAddr = selNode.address ? Math.floor(selNode.address) : 0;
        computeRoute(lastAtlasData.nodes);
      }
      ImGui.sameLine();
      ImGui.textDisabled(`-> ${selNode.shortName || selNode.fullName || "<unnamed>"}`);
    }
    // Route result summary.
    if (route) {
      const gNode = lastAtlasData.nodes[route.goalIdx];
      ImGui.textColored([1, 1, 0.5, 1], `Goal: ${gNode ? (gNode.shortName || gNode.fullName || "?") : "?"}`);
      if (route.startIdx >= 0 && route.startIdx === route.goalIdx) {
        ImGui.textColored([0.4, 1.0, 0.4, 1], "Available now - start this map directly (0 hops)");
        ImGui.sameLine();
        if (ImGui.button("Open##rp") && gNode) { try { poe2.selectAtlasNode(gNode.address); } catch (e) {} }
      } else if (route.startIdx >= 0) {
        const sNode = lastAtlasData.nodes[route.startIdx];
        ImGui.textColored([0.2, 1.0, 0.7, 1], `Start: ${sNode.shortName || sNode.fullName || "?"}  ->  ${route.hops} hops`);
        ImGui.sameLine();
        if (ImGui.button("Open Start##rp")) { try { poe2.selectAtlasNode(sNode.address); } catch (e) {} }
      } else if (route.disconnected) {
        ImGui.textColored([1, 0.5, 0.3, 1], "No path from an available node - try Rebuild Web or a closer goal.");
      }
    }

    ImGui.separator();

    const availWidth = ImGui.getContentRegionAvail().x;
    const leftPaneWidth = availWidth * 0.4;
    
    // Left pane - Node list
    ImGui.beginChild("NodeList", { x: leftPaneWidth, y: 0 }, ImGui.ChildFlags.Border);
    
    // Build filtered list with indices
    const screenCenterX = screenWidth / 2;
    const screenCenterY = screenHeight / 2;
    
    let filteredNodes = [];
    // Throttle the per-node DAT-row reads to ~1.3 Hz. Node addrs drift each frame so a
    // refresh re-reads the live address, but contentSet is stable per base-map-type.
    const nowMs = Date.now();
    const mapInfoStale = (nowMs - mapInfoCacheTime > 750);
    if (mapInfoStale) { mapInfoCache = {}; mapInfoCacheTime = nowMs; }
    for (let i = 0; i < lastAtlasData.nodes.length; i++) {
      const node = lastAtlasData.nodes[i];

      if (showOnlyVisible.value && !node.isVisible) continue;
      if (!nodeMatchesFilter(node, filterText)) continue;
      if (selectableOnly.value && !isNodeSelectable(node)) continue;

      // Calculate distance from screen center
      const dx = (node.screenX || 0) - screenCenterX;
      const dy = (node.screenY || 0) - screenCenterY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (mapInfoStale) {
        const mi = readMapInfo(node.address);
        // Prefer the REAL per-node content (base-game, at rest) for the list color;
        // fall back to the base-map content-set category.
        mapInfoCache[i] = classifyTraits(readContentTraits(node.address)) || (mi ? classifyContent(mi.contentSet) : null);
      }

      filteredNodes.push({ index: i, node: node, distance: distance,
        selectable: isNodeSelectable(node), content: mapInfoCache[i] || null });
    }
    
    // Sort by distance if enabled
    if (sortByDistance.value) {
      filteredNodes.sort((a, b) => a.distance - b.distance);
    }
    
    // Render the list
    for (const item of filteredNodes) {
      const node = item.node;
      const i = item.index;
      const flags = getSpecialTraitFlags(node);
      
      // Color: prefer the real content category (from the DAT contentSet); the old trait
      // classByte is dead/always-0, so those flags rarely fire — keep them as a fallback.
      let textColor = null;
      if (item.content) textColor = item.content.color;
      else if (flags.boss) textColor = [1.0, 0.0, 0.0, 1.0];
      else if (flags.unique) textColor = [1.0, 0.0, 1.0, 1.0];
      else if (flags.nexus) textColor = [1.0, 0.0, 0.53, 1.0];
      else if (flags.abyss) textColor = [0.0, 0.53, 1.0, 1.0];
      else if (flags.moment) textColor = [0.0, 1.0, 1.0, 1.0];
      else if (flags.cleanse) textColor = [0.53, 1.0, 0.53, 1.0];
      else if (!node.isVisible) textColor = [0.5, 0.5, 0.5, 1.0];
      else if (!item.selectable) textColor = [0.45, 0.45, 0.45, 1.0]; // visible but not reachable (can't Open)

      if (textColor) {
        ImGui.pushStyleColor(ImGui.Col.Text, textColor);
      }

      const displayName = node.shortName || node.fullName || "<unnamed>";
      const distLabel = sortByDistance.value ? ` (${item.distance.toFixed(0)})` : "";
      const lockLabel = item.selectable ? "" : " [locked]";
      const contentLabel = item.content ? ` <${item.content.label}>` : "";
      const label = `[${i}] ${displayName}${distLabel}${contentLabel}${lockLabel}`;
      
      if (ImGui.selectable(label, selectedNodeIndex === i)) {
        selectedNodeIndex = i;
        selectedNodeKey = gridKey(node);   // lock to the node's stable grid position
      }
      
      if (textColor) {
        ImGui.popStyleColor();
      }
    }
    
    ImGui.endChild();
    ImGui.sameLine();
    
    // Right pane - Details
    ImGui.beginChild("NodeDetails", { x: 0, y: 0 }, ImGui.ChildFlags.Border);
    
    if (selectedNodeIndex >= 0 && selectedNodeIndex < lastAtlasData.nodes.length) {
      const node = lastAtlasData.nodes[selectedNodeIndex];
      const flags = getSpecialTraitFlags(node);
      
      ImGui.text(`Index: ${selectedNodeIndex}`);
      if (node.address) {
        const addrHex = "0x" + Math.floor(node.address).toString(16).toUpperCase();
        ImGui.text(`Address: ${addrHex}`);
      }

      ImGui.separator();

      if (node.shortName) ImGui.text(`Name: ${node.shortName}`);
      if (node.fullName) ImGui.textWrapped(`Full: ${node.fullName}`);
      
      ImGui.separator();
      
      // Coords (formerly Rel*Zoom)
      ImGui.textColored([1.0, 1.0, 0.5, 1.0], 
        `Coords: ${node.screenX?.toFixed(1)}, ${node.screenY?.toFixed(1)}`);
      
      ImGui.text(`Visible: ${node.isVisible ? "Yes" : "No"}`);

      const selectable = isNodeSelectable(node);
      ImGui.textColored(selectable ? [0.4, 1.0, 0.4, 1.0] : [1.0, 0.5, 0.3, 1.0],
        `Selectable: ${selectable ? "YES - can Open / Traverse" : "NO - not reached / locked"}`);

      // --- Map Info (verified DAT-row reads; node+0x300 -> EndgameMaps row) ---
      const mapInfo = readMapInfo(node.address);
      if (mapInfo) {
        ImGui.separator();
        ImGui.textColored([0.6, 0.9, 1.0, 1.0], "Map Info:");
        if (mapInfo.baseMapName) ImGui.bulletText(`Base map: ${esc(mapInfo.baseMapName)}`);
        if (mapInfo.contentSet) {
          const cc = classifyContent(mapInfo.contentSet);
          ImGui.bullet(); ImGui.sameLine();
          ImGui.textColored(cc ? cc.color : [0.8, 0.8, 0.8, 1.0],
            `Content: ${esc(mapInfo.contentSet)}${cc ? " [" + cc.label + "]" : ""}`);
        }
        if (mapInfo.firstPack) ImGui.bulletText(`Boss/pack: ${esc(mapInfo.firstPack)}`);
        if (mapInfo.intrinsicMods && mapInfo.intrinsicMods.length) {
          ImGui.bulletText(`Intrinsic (${mapInfo.intrinsicMods.length}): ${esc(mapInfo.intrinsicMods.join(", "))}`);
        }
        if (mapInfo.mapTypeTag) ImGui.bulletText(`Type tag: ${mapInfo.mapTypeTag}`);
        if (mapInfo.flavorText) ImGui.textWrapped(`"${esc(mapInfo.flavorText)}"`);
      }

      // Traverse-packet prediction. Captured opcode is 0x00F7, format:
      //   00 F7 01 [BE int32 a] [BE int32 b]
      // where (a, b) = atlas grid coords at node+0x320 / node+0x324 (confirmed
      // by dump<->capture correlation: Backwash dump had +0x320=16,+0x324=20 and
      // an earlier traverse of a same-row node sent (2, 20)). The old +0x2C8 key
      // was wrong (always 0 on 050b).
      if (node.address) {
        const nb = Math.floor(node.address);
        const a = (poe2.readMemory(nb + 0x320, "int32") >>> 0);
        const b = (poe2.readMemory(nb + 0x324, "int32") >>> 0);
        const be = (v) => [(v>>>24)&0xFF,(v>>>16)&0xFF,(v>>>8)&0xFF,v&0xFF]
          .map(x => x.toString(16).toUpperCase().padStart(2,"0")).join(" ");
        ImGui.separator();
        ImGui.textColored([0.6, 1.0, 0.6, 1.0], "Traverse key (node+0x320/+0x324):");
        ImGui.text(`  a=${a}  b=${b}`);
        ImGui.textColored([1.0, 1.0, 0.6, 1.0], `  Predicted packet: 00 F7 01 ${be(a)} ${be(b)}`);
      }

      // Check if off-screen
      const pos = { x: node.screenX || 0, y: node.screenY || 0 };
      const isOffScreen = pos.x < 0 || pos.y < 0 || pos.x > screenWidth || pos.y > screenHeight;
      if (isOffScreen) {
        ImGui.textColored([1.0, 0.5, 0.0, 1.0], "Off-screen (arrow shown)");
      }
      
      // Show special flags
      if (hasAnySpecialTrait(flags)) {
        ImGui.separator();
        ImGui.text("Special:");
        if (flags.unique) ImGui.sameLine(), ImGui.textColored([1.0, 0.0, 1.0, 1.0], "[Unique]");
        if (flags.boss) ImGui.sameLine(), ImGui.textColored([1.0, 0.0, 0.0, 1.0], "[Boss]");
        if (flags.abyss) ImGui.sameLine(), ImGui.textColored([0.0, 0.53, 1.0, 1.0], "[Abyss]");
        if (flags.moment) ImGui.sameLine(), ImGui.textColored([0.0, 1.0, 1.0, 1.0], "[Moment]");
        if (flags.nexus) ImGui.sameLine(), ImGui.textColored([1.0, 0.0, 0.53, 1.0], "[Nexus]");
        if (flags.cleanse) ImGui.sameLine(), ImGui.textColored([0.53, 1.0, 0.53, 1.0], "[Cleanse]");
      }
      
      if (showTraits.value) {
        // Content/traits read AT REST from base-game arrays (node+0x368 EndgameMapContent +
        // node+0x350 Stats) - NOT the fragile UI widget tree. Works with the popup closed.
        const ct = readContentTraits(node.address);
        const mech = readMechanics(node.address);
        if (ct.length || mech.length) {
          ImGui.separator();
          ImGui.textColored([1.0, 0.8, 0.2, 1.0], "Content (base-game, at rest):");
          for (const t of ct) {
            ImGui.bullet(); ImGui.sameLine();
            const cc = classifyTraits([t]);
            ImGui.textColored(cc ? cc.color : [0.8, 1.0, 0.8, 1.0], esc(t));
          }
          if (mech.length) ImGui.bulletText(`Mechanics: ${esc(mech.join(", "))}`);
        } else {
          ImGui.separator();
          ImGui.textDisabled("Content: (none on this node)");
        }
      }

      // --- Stage 2: Action buttons + result display ---
      ImGui.separator();

      // Open this node's TPM (the in-game node-click). Calls poe2.selectAtlasNode
      // -> C++ sub_140B8FF70(WorldScreen, node) (RVA 0xB8FF70). REQUIRES the atlas
      // open at the map device; only selectable "frontier" nodes open (others
      // toggle closed). Selectable = (node+815 & 3) == 1.
      if (ImGui.button("Open (Select)")) {
        try {
          // Select by the displayed node's address DIRECTLY. The previous fresh-regrid
          // re-resolution WAS the bug: getAtlasNodes() recycles addresses, so the
          // grid-key match landed on the WRONG node (-> wrong map / The Burning
          // Monolith). LIVE-PROVEN: selectAtlasNode(node.address) sets the popup source
          // + selection to the right map. The index/key were never the problem.
          const selArg = (node && node.address) ? node.address : selectedNodeIndex;
          const r = poe2.selectAtlasNode(selArg);
          const okSel = (r && typeof r === "object") ? !!r.success : !!r;
          lastActivationResult = { index: selectedNodeIndex, success: okSel, select: true, diag: "addr" };
          lastActivationTime = Date.now();
          console.log(`[Atlas] Open/select node ${selectedNodeIndex} '${node.shortName||""}' -> ${okSel ? "OPEN" : "not selectable / closed"}`);
        } catch (e) {
          lastActivationResult = { index: selectedNodeIndex, error: String(e) };
          lastActivationTime = Date.now();
          console.log(`[Atlas] Open/select node ${selectedNodeIndex} error: ${e}`);
        }
      }
      if (ImGui.isItemHovered()) {
        ImGui.setTooltip("Opens this node's TPM popup (calls the node-click handler\nsub_140B8FF70 via selectAtlasNode). REQUIRES the atlas open at the\nmap device. Only selectable 'frontier' nodes open; others toggle closed.");
      }
      ImGui.sameLine();

      if (ImGui.button("Traverse (send)")) {
        try {
          // Build + send the real traverse packet (opcode 0x00F7), verified by
          // dump<->capture correlation: payload = 00 F7 01 [BE a][BE b] where
          // (a,b) = atlas grid coords at node+0x320 / node+0x324. This is exactly
          // what the game's TRAVERSE button sends. REQUIRES a waystone in the map
          // device (the 0x01 byte), same precondition as a manual traverse.
          const nb = Math.floor(node.address);
          const a = poe2.readMemory(nb + 0x320, "int32") >>> 0;
          const b = poe2.readMemory(nb + 0x324, "int32") >>> 0;
          const pkt = new Uint8Array([
            0x00, 0xF7, 0x01,
            (a>>>24)&0xFF, (a>>>16)&0xFF, (a>>>8)&0xFF, a&0xFF,
            (b>>>24)&0xFF, (b>>>16)&0xFF, (b>>>8)&0xFF, b&0xFF,
          ]);
          const hex = Array.from(pkt).map(x=>x.toString(16).toUpperCase().padStart(2,"0")).join(" ");
          const ok = poe2.sendPacket(pkt);
          lastActivationResult = { index: selectedNodeIndex, success: ok, a, b };
          lastActivationTime = Date.now();
          console.log(`[Atlas] Traverse node ${selectedNodeIndex} '${node.shortName||""}' (a=${a},b=${b}) sent=${ok} pkt=${hex}`);
        } catch (e) {
          lastActivationResult = { index: selectedNodeIndex, error: String(e) };
          lastActivationTime = Date.now();
          console.log(`[Atlas] Traverse node ${selectedNodeIndex} error: ${e}`);
        }
      }
      if (ImGui.isItemHovered()) {
        ImGui.setTooltip("Sends the real 0xF7 traverse packet (00 F7 01 + BE(a) + BE(b)\nfrom node+0x320/+0x324). REQUIRES a waystone in the map device,\njust like clicking TRAVERSE manually. This actually travels.");
      }
      ImGui.sameLine();
      if (ImGui.button("Probe Node")) {
        try {
          const r = poe2.probeAtlasNode(selectedNodeIndex);
          lastProbeResult = { index: selectedNodeIndex, data: r };
          lastProbeTime = Date.now();
        } catch (e) {
          lastProbeResult = { index: selectedNodeIndex, error: String(e) };
          lastProbeTime = Date.now();
          console.log(`[Atlas] Probe node ${selectedNodeIndex} error: ${e}`);
        }
      }
      if (ImGui.isItemHovered()) {
        ImGui.setTooltip("Read richer node data (completion, locked state, full traits).");
      }

      // Show recent activation result (within 30s) for this node
      if (lastActivationResult && lastActivationResult.index === selectedNodeIndex
          && Date.now() - lastActivationTime < 30000) {
        ImGui.separator();
        if (lastActivationResult.error) {
          ImGui.textColored([1.0, 0.3, 0.3, 1.0], `Activation error: ${lastActivationResult.error}`);
        } else {
          const ok = !!lastActivationResult.success;
          ImGui.textColored(ok ? [0.3, 1.0, 0.3, 1.0] : [1.0, 0.5, 0.0, 1.0],
                            `Activation: ${ok ? "SUCCESS" : "FAILED"}`);
          if (lastActivationResult.diag) ImGui.textColored([0.7, 0.85, 1.0, 1.0], `Resolve: ${esc(lastActivationResult.diag)}`);
          if (lastActivationResult.activationX !== undefined) {
            const xHex = (lastActivationResult.activationX >>> 0).toString(16).toUpperCase().padStart(8, "0");
            const yHex = (lastActivationResult.activationY >>> 0).toString(16).toUpperCase().padStart(8, "0");
            ImGui.text(`Key X: ${lastActivationResult.activationX} (0x${xHex})`);
            ImGui.text(`Key Y: ${lastActivationResult.activationY} (0x${yHex})`);
          }
        }
      }

      // Show recent probe result (within 30s) for this node
      if (lastProbeResult && lastProbeResult.index === selectedNodeIndex
          && Date.now() - lastProbeTime < 30000) {
        ImGui.separator();
        if (lastProbeResult.error) {
          ImGui.textColored([1.0, 0.3, 0.3, 1.0], `Probe error: ${lastProbeResult.error}`);
        } else {
          ImGui.textColored([0.5, 0.8, 1.0, 1.0], "Probe data:");
          const d = lastProbeResult.data;
          if (d && typeof d === "object") {
            for (const [key, val] of Object.entries(d)) {
              if (val === null || val === undefined) {
                ImGui.bulletText(`${key}: <null>`);
              } else if (typeof val === "object") {
                const s = JSON.stringify(val);
                ImGui.bulletText(`${key}: ${s.length > 100 ? s.substring(0, 97) + "..." : s}`);
              } else {
                ImGui.bulletText(`${key}: ${val}`);
              }
            }
          } else {
            ImGui.text(String(d));
          }
        }
      }
    } else {
      ImGui.textDisabled("Select a node");
    }
    
    ImGui.endChild();
  }
  ImGui.end();
}

function drawOverlays(screenWidth, screenHeight) {
  if (!lastAtlasData) return;
  
  const dl = ImGui.getBackgroundDrawList();
  if (!dl) return;
  
  const screenCenter = { x: screenWidth / 2, y: screenHeight / 2 };
  
  // Draw all nodes
  for (let i = 0; i < lastAtlasData.nodes.length; i++) {
    const node = lastAtlasData.nodes[i];
    
    const pos = { x: node.screenX || 0, y: node.screenY || 0 };
    const zoom = node.zoomX || 1;
    const squareSize = BASE_SQUARE_SIZE * zoom;
    
    const isSelected = (i === selectedNodeIndex);
    const flags = getSpecialTraitFlags(node);
    const hasSpecial = hasAnySpecialTrait(flags);
    
    // Check if on-screen
    const margin = 50;
    const isOnScreen = pos.x > -margin && pos.y > -margin && 
                       pos.x < screenWidth + margin && pos.y < screenHeight + margin;
    
    // Determine if we should draw this node
    const shouldDraw = (highlightAll.value) || 
                       (highlightSelected.value && isSelected) ||
                       hasSpecial;
    
    if (!shouldDraw) continue;
    
    // If selected and off-screen, draw arrow
    if (isSelected && !isOnScreen) {
      drawArrowToTarget(dl, screenCenter, pos, screenWidth, screenHeight, COLOR_ARROW);
      continue;
    }
    
    if (!isOnScreen) continue;
    
    // Check if this square would overlap with the popup
    if (lastPopupRect) {
      const squareRect = {
        x: pos.x,
        y: pos.y,
        width: squareSize,
        height: squareSize
      };
      if (rectsOverlap(squareRect, lastPopupRect)) {
        continue;
      }
    }
    
    // Determine color and thickness based on traits
    let color = COLOR_DEFAULT;
    let thickness = 1;
    
    if (flags.boss) { color = COLOR_BOSS; thickness = 2; }
    else if (flags.unique) { color = COLOR_UNIQUE; thickness = 2; }
    else if (flags.nexus) { color = COLOR_NEXUS; thickness = 2; }
    else if (flags.abyss) { color = COLOR_ABYSS; thickness = 2; }
    else if (flags.moment) { color = COLOR_MOMENT; thickness = 2; }
    else if (flags.cleanse) { color = COLOR_CLEANSE; thickness = 2; }
    
    // Dim non-visible nodes
    if (!node.isVisible && !hasSpecial) {
      color = 0x80808080;
      thickness = 1;
    }
    
    // Selected node gets extra highlight
    if (isSelected) {
      color = COLOR_SELECTED;
      thickness = 3;
    }
    
    // Draw square
    const topLeft = { x: pos.x, y: pos.y };
    const bottomRight = { x: pos.x + squareSize, y: pos.y + squareSize };
    
    dl.addRect(topLeft, bottomRight, color, 0, 0, thickness);
    
    // Draw extra ring for special nodes
    if (hasSpecial && !isSelected) {
      const offset = 3;
      const outerTopLeft = { x: pos.x - offset, y: pos.y - offset };
      const outerBottomRight = { x: pos.x + squareSize + offset, y: pos.y + squareSize + offset };
      dl.addRect(outerTopLeft, outerBottomRight, color, 0, 0, 1);
    }
    
    // Draw label for selected node (index + name so it matches the list; real content
    // from the base-game arrays, NOT the dead UI-trait field that showed "?, ?").
    if (isSelected) {
      const label = `[${i}] ${node.shortName || "Node " + i}`;
      dl.addText(label, { x: pos.x + squareSize + 5, y: pos.y }, 0xFF00FFFF);
      const ct = readContentTraits(node.address);
      if (ct.length > 0) {
        dl.addText(ct.join(", "), { x: pos.x + squareSize + 5, y: pos.y + 16 }, 0xFF88CCFF);
      }
    }
  }

  // ---- Web edges + planned route (WorldMapConnections graph) ----
  const nodesArr = lastAtlasData.nodes;
  const onScr = (p) => p.x > -40 && p.y > -40 && p.x < screenWidth + 40 && p.y < screenHeight + 40;
  if (drawWebEdges.value && G.adj && G.builtFor === nodesArr.length) {
    for (let i = 0; i < nodesArr.length; i++) {
      const pa = nodeCenter(nodesArr[i]); const aOn = onScr(pa);
      for (const j of G.adj[i]) {
        if (j <= i) continue;
        const pb = nodeCenter(nodesArr[j]);
        if (!aOn && !onScr(pb)) continue;
        dl.addLine(pa, pb, 0x60B0B0B0, 1);
      }
    }
  }
  if (drawRoute.value && route && route.path && route.path.length) {
    let prev = null;
    for (const idx of route.path) {
      const c = nodeCenter(nodesArr[idx]);
      if (prev) dl.addLine(prev, c, 0xFF33FFFF, 3);   // yellow route
      prev = c;
    }
    const g = nodesArr[route.goalIdx];
    if (g) {
      const gp = nodeCenter(g);
      dl.addCircle(gp, BASE_SQUARE_SIZE * (g.zoomX || 1) * 0.5 + 6, 0xFF00FF00, 20, 3);
      dl.addText("GOAL: " + (g.shortName || g.fullName || "") + (route.hops ? "  (" + route.hops + " hops)" : ""),
                 { x: gp.x + 10, y: gp.y - 18 }, 0xFF00FF00);
    }
    if (route.startIdx >= 0) {
      const s = nodesArr[route.startIdx];
      const sp = nodeCenter(s);
      dl.addCircle(sp, BASE_SQUARE_SIZE * (s.zoomX || 1) * 0.5 + 6, 0xFF00FFAA, 20, 3);
      dl.addText("START: " + (s.shortName || s.fullName || ""), { x: sp.x + 10, y: sp.y - 18 }, 0xFF00FFAA);
    }
  }
}

function drawArrowToTarget(dl, screenCenter, targetPos, screenWidth, screenHeight, color) {
  const dx = targetPos.x - screenCenter.x;
  const dy = targetPos.y - screenCenter.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  if (dist < 1) return;
  
  const dirX = dx / dist;
  const dirY = dy / dist;
  
  const margin = 40;
  let t = 10000;
  
  if (Math.abs(dirX) > 0.001) {
    const tx1 = (margin - screenCenter.x) / dirX;
    const tx2 = ((screenWidth - margin) - screenCenter.x) / dirX;
    if (tx1 > 0) t = Math.min(t, tx1);
    if (tx2 > 0) t = Math.min(t, tx2);
  }
  if (Math.abs(dirY) > 0.001) {
    const ty1 = (margin - screenCenter.y) / dirY;
    const ty2 = ((screenHeight - margin) - screenCenter.y) / dirY;
    if (ty1 > 0) t = Math.min(t, ty1);
    if (ty2 > 0) t = Math.min(t, ty2);
  }
  
  const tipX = screenCenter.x + dirX * t;
  const tipY = screenCenter.y + dirY * t;
  
  const lineStart = { x: screenCenter.x + dirX * 50, y: screenCenter.y + dirY * 50 };
  const lineEnd = { x: tipX, y: tipY };
  
  dl.addLine(lineStart, lineEnd, color, 3);
  
  const arrowSize = 15;
  const perpX = -dirY;
  const perpY = dirX;
  
  const p1 = { x: tipX, y: tipY };
  const p2 = { x: tipX - dirX * arrowSize + perpX * arrowSize * 0.5, 
               y: tipY - dirY * arrowSize + perpY * arrowSize * 0.5 };
  const p3 = { x: tipX - dirX * arrowSize - perpX * arrowSize * 0.5, 
               y: tipY - dirY * arrowSize - perpY * arrowSize * 0.5 };
  
  dl.addTriangleFilled(p1, p2, p3, color);
  
  if (lastAtlasData && selectedNodeIndex >= 0 && selectedNodeIndex < lastAtlasData.nodes.length) {
    const node = lastAtlasData.nodes[selectedNodeIndex];
    const label = node.shortName || `Node ${selectedNodeIndex}`;
    const labelX = tipX - dirX * 25;
    const labelY = tipY - dirY * 25;
    dl.addText(label, { x: labelX, y: labelY }, color);
  }
}

export const atlasPlugin = {
  onDraw: onDraw,
  onDrawUI: onDrawUI
};

console.log("Atlas Explorer plugin loaded");

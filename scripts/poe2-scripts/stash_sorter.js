/**
 * Stash Sorter — read-on-view stash indexer + rules-based deposit.
 *
 * SAFE by design. Two pieces, neither needs force-loading:
 *   1. Indexer: records each stash tab's contents the moment it's loaded (i.e. as you view
 *      tabs during normal play). Persisted to disk, so the index survives sessions. Open each
 *      tab once to index it — unviewed tabs can't be read (they load lazily; see force-load RE).
 *   2. Deposit: scans your backpack and moves each item INTO the stash tab its first matching
 *      rule names. Moves are view-independent (no need to open the destination tab) and paced
 *      (one move every ~Delay ms) to stay human-like. Requires your stash to be OPEN.
 *
 * All reads/moves go through the C++ SDK via inventory.js (no raw memory here).
 */

import { INV, readInventory, getStashTabs, moveByHandle, tabIdByName, requestStashTab, unloadedTabs } from './inventory.js';

const PLUGIN_NAME = 'stash_sorter';
const DATA_FILE = '../../data/stash_sorter.json';   // account-wide (rules + last-seen tab index)

// ===================== persistence =====================

let store = { rules: [], index: {} };   // index keyed by tab name -> { tabId, invId, count, items[], updated }
let storeLoaded = false;
let dirty = false;
let lastSave = 0;

function fileExists(p) { try { fs.access(p, 0); return true; } catch (e) { return false; } }

function loadStore() {
  if (storeLoaded) return;
  storeLoaded = true;
  if (fileExists(DATA_FILE)) {
    try {
      const d = fs.readFile(DATA_FILE);
      if (d) { const p = JSON.parse(d); store.rules = p.rules || []; store.index = p.index || {}; }
    } catch (e) { console.error('[StashSorter] load error:', e); }
  }
  if (!store.rules.length) store.rules = defaultRules();
}

function saveStore() {
  try { fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2)); dirty = false; lastSave = Date.now(); }
  catch (e) { console.error('[StashSorter] save error:', e); }
}
function markDirty() { dirty = true; }
function saveIfDirty() { if (dirty && Date.now() - lastSave > 5000) saveStore(); }

// ===================== rules =====================

// rule: { id, label, tab, enabled, pathContains[], nameContains[], minRarity, maxRarity }
function defaultRules() {
  return [
    { id: 1, label: 'Skill / Support Gems', tab: 'Gem',  enabled: true,  pathContains: ['/Gems/', 'SkillGem', 'SupportGem'], nameContains: [], minRarity: -1, maxRarity: -1 },
    { id: 2, label: 'Currency',             tab: 'Sales', enabled: true, pathContains: ['/Currency/'], nameContains: [], minRarity: -1, maxRarity: -1 },
    { id: 3, label: 'Waystones',            tab: '2',    enabled: false, pathContains: ['Waystone', '/Maps/'], nameContains: [], minRarity: -1, maxRarity: -1 },
  ];
}
function nextRuleId() { let m = 0; for (const r of store.rules) if (r.id > m) m = r.id; return m + 1; }
function splitCsv(s) { return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); }

function ruleMatches(rule, it) {
  if (!rule.enabled) return false;
  const hasCrit = (rule.pathContains && rule.pathContains.length) ||
                  (rule.nameContains && rule.nameContains.length) ||
                  rule.minRarity >= 0 || rule.maxRarity >= 0;
  if (!hasCrit) return false;   // a rule with no criteria never matches (avoids dumping everything)
  const path = (it.path || '').toLowerCase();
  const name = ((it.unique || '') + ' ' + (it.base || '')).toLowerCase();
  if (rule.pathContains && rule.pathContains.length &&
      !rule.pathContains.some(function (s) { return s && path.indexOf(s.toLowerCase()) >= 0; })) return false;
  if (rule.nameContains && rule.nameContains.length &&
      !rule.nameContains.some(function (s) { return s && name.indexOf(s.toLowerCase()) >= 0; })) return false;
  if (rule.minRarity >= 0 && (it.rarity || 0) < rule.minRarity) return false;
  if (rule.maxRarity >= 0 && (it.rarity || 0) > rule.maxRarity) return false;
  return true;
}
function ruleForItem(it) { for (const r of store.rules) if (ruleMatches(r, it)) return r; return null; }

// ===================== indexer (read-on-view) =====================

let lastIndexTime = 0;
function indexLoadedTabs() {
  const now = Date.now();
  if (now - lastIndexTime < 1500) return;
  lastIndexTime = now;
  const tabs = getStashTabs();   // ALL tabs; index every LOADED one (incl empty, so 0-item tabs are recorded)
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    if (!t.loaded || !t.name || t.tabId == null) continue;
    const inv = readInventory(t.invId);
    if (!inv) continue;
    const prev = store.index[t.name];
    if (prev && prev.count === inv.items.length && prev.tabId === t.tabId) { prev.updated = now; continue; }
    store.index[t.name] = {
      tabId: t.tabId, invId: t.invId, count: inv.items.length, updated: now,
      items: inv.items.map(function (it) {
        return { name: it.unique || it.base, path: it.path, rarity: it.rarity, stack: it.stack, w: it.w, h: it.h, x: it.x, y: it.y };
      }),
    };
    markDirty();
  }
}

// ===================== deposit (bag -> tabs by rule) =====================

let depositQueue = [];      // [{ handle, tabId, tabName, itemName, rule }]
let lastMoveTime = 0;
let depositLog = [];        // recent results, newest first
let depositActive = false;

// Plan what would move. Returns { jobs[], unmatched, unknownTab, byTab{} }.
function planDeposit() {
  const bag = readInventory(INV.MAIN);
  const out = { jobs: [], unmatched: 0, unknownTab: 0, byTab: {} };
  if (!bag) return out;
  for (let i = 0; i < bag.items.length; i++) {
    const it = bag.items[i];
    if (it.handle == null) continue;
    const r = ruleForItem(it);
    if (!r) { out.unmatched++; continue; }
    const tabId = tabIdByName(r.tab);
    if (tabId == null) { out.unknownTab++; continue; }
    out.jobs.push({ handle: it.handle, tabId: tabId, tabName: r.tab, itemName: it.unique || it.base || '(item)', rule: r.label });
    out.byTab[r.tab] = (out.byTab[r.tab] || 0) + 1;
  }
  return out;
}

let _planCache = null, _planTime = 0;
function planDepositCached() {
  const now = Date.now();
  if (_planCache && now - _planTime < 250) return _planCache;
  _planCache = planDeposit(); _planTime = now;
  return _planCache;
}

function startDeposit() {
  const plan = planDeposit();
  depositQueue = plan.jobs;
  depositActive = depositQueue.length > 0;
  depositLog = [];
}
function stopDeposit() { depositQueue = []; depositActive = false; }

function processQueue(delayMs) {
  if (!depositActive || !depositQueue.length) { depositActive = depositQueue.length > 0; return; }
  const now = Date.now();
  if (now - lastMoveTime < delayMs) return;
  lastMoveTime = now;
  const job = depositQueue.shift();
  let ok = false;
  try { ok = moveByHandle('in', job.tabId, job.handle); } catch (e) { ok = false; }
  depositLog.unshift({ itemName: job.itemName, tabName: job.tabName, ok: ok });
  if (depositLog.length > 40) depositLog.length = 40;
  if (!depositQueue.length) depositActive = false;
}

// ===================== force-load (request unopened tabs from the server, paced) =====================

let loadQueue = [];        // [{tabId, name}] tabs still to request
let loadActive = false;
let lastLoadReq = 0;
const LOAD_DELAY = 450;    // ms between tab requests (human-paced; don't spam)

function startLoadAll() { loadQueue = unloadedTabs(); loadActive = loadQueue.length > 0; }
function stopLoadAll() { loadQueue = []; loadActive = false; }

function processLoadQueue() {
  if (!loadActive || !loadQueue.length) { loadActive = loadQueue.length > 0; return; }
  const now = Date.now();
  if (now - lastLoadReq < LOAD_DELAY) return;
  lastLoadReq = now;
  const t = loadQueue.shift();
  try { requestStashTab(t.tabId); } catch (e) {}
  if (!loadQueue.length) loadActive = false;
}

// ===================== UI =====================

const RARITY_NAMES = ['Normal', 'Magic', 'Rare', 'Unique'];
const RARITY_COLORS = [[0.8, 0.8, 0.8, 1], [0.3, 0.5, 1, 1], [1, 1, 0.3, 1], [1, 0.5, 0, 1]];
const RARITY_FILTER = ['Any', 'Normal+', 'Magic+', 'Rare+', 'Unique'];

// ImGui.text/textColored/tooltip are printf-style — escape % in any game/user text.
function esc(s) { return String(s == null ? '' : s).replace(/%/g, '%%'); }

// edit-form state (persists across frames)
const fLabel = new ImGui.MutableVariable('');
const fPath = new ImGui.MutableVariable('');
const fName = new ImGui.MutableVariable('');
const vDelay = new ImGui.MutableVariable(300);
let fTabName = '';
let fRarity = 0;          // index into RARITY_FILTER
let editingId = null;     // null = adding a new rule

function loadFormFromRule(r) {
  editingId = r.id;
  fLabel.value = r.label || '';
  fPath.value = (r.pathContains || []).join(', ');
  fName.value = (r.nameContains || []).join(', ');
  fTabName = r.tab || '';
  fRarity = r.minRarity >= 0 ? r.minRarity + 1 : 0;
}
function clearForm() {
  editingId = null; fLabel.value = ''; fPath.value = ''; fName.value = ''; fTabName = ''; fRarity = 0;
}
function saveForm() {
  const rule = {
    id: editingId != null ? editingId : nextRuleId(),
    label: fLabel.value || '(rule)',
    tab: fTabName,
    enabled: true,
    pathContains: splitCsv(fPath.value),
    nameContains: splitCsv(fName.value),
    minRarity: fRarity > 0 ? fRarity - 1 : -1,
    maxRarity: -1,
  };
  const i = editingId != null ? store.rules.findIndex(function (r) { return r.id === editingId; }) : -1;
  if (i >= 0) store.rules[i] = rule; else store.rules.push(rule);
  editingId = rule.id;
  saveStore();
}

function tabNameCombo(label) {
  const tabs = getStashTabs() || [];
  if (ImGui.beginCombo(label, fTabName || '(pick tab)', ImGui.ComboFlags.None)) {
    for (let i = 0; i < tabs.length; i++) {
      const nm = tabs[i].name;
      if (ImGui.selectable(nm + '##t' + tabs[i].tabId, nm === fTabName)) fTabName = nm;
    }
    ImGui.endCombo();
  }
}

function onDrawUI() {
  loadStore();

  ImGui.setNextWindowSize({ x: 460, y: 640 }, ImGui.Cond.FirstUseEver);
  if (!ImGui.begin('Stash Sorter')) { ImGui.end(); return; }

  const tabs = getStashTabs() || [];
  const loadedCount = tabs.filter(function (t) { return t.loaded; }).length;

  ImGui.textColored([0.6, 0.85, 1, 1], 'Load-all reads every tab without opening it (hideout). Deposit needs the stash open.');
  if (!tabs.length) ImGui.textColored([1, 0.5, 0.2, 1], 'No stash data (open your stash / are you in game?)');
  else ImGui.text('Stash tabs: ' + tabs.length + '   |   loaded now: ' + loadedCount + '   |   indexed: ' + Object.keys(store.index).length);

  // ---------- Force-load (read tabs without opening them) ----------
  ImGui.separator();
  ImGui.textColored([1, 1, 0.4, 1], 'Force-load tabs (read without opening)');
  const nUnloaded = tabs.filter(function (t) { return !t.loaded; }).length;
  if (loadActive) {
    ImGui.textColored([0.4, 1, 0.4, 1], 'Loading... ' + loadQueue.length + ' left');
    ImGui.sameLine();
    if (ImGui.button('Stop##load')) stopLoadAll();
  } else if (nUnloaded > 0) {
    if (ImGui.button('Load all ' + nUnloaded + ' unopened tab(s)')) startLoadAll();
    ImGui.sameLine();
    ImGui.textColored([0.6, 0.6, 0.6, 1], 'requests each from server, paced (works in hideout, stash closed)');
  } else {
    ImGui.textColored([0.5, 0.85, 0.5, 1], 'All tabs loaded - full stash readable + indexed.');
  }

  // ---------- Deposit ----------
  ImGui.separator();
  ImGui.textColored([1, 1, 0.4, 1], 'Deposit backpack by rules');
  const plan = planDepositCached();
  const tabSummary = Object.keys(plan.byTab).map(function (k) { return k + ' (' + plan.byTab[k] + ')'; }).join(', ');
  ImGui.text('Will move ' + plan.jobs.length + ' item(s)' + (tabSummary ? ' -> ' + esc(tabSummary) : ''));
  if (plan.unmatched) { ImGui.sameLine(); ImGui.textColored([0.6, 0.6, 0.6, 1], '| no rule: ' + plan.unmatched); }
  if (plan.unknownTab) { ImGui.sameLine(); ImGui.textColored([1, 0.5, 0.2, 1], '| unknown tab: ' + plan.unknownTab); }

  ImGui.sliderInt('Delay (ms/move)', vDelay, 120, 1000);
  if (!depositActive) {
    const can = plan.jobs.length > 0;
    if (can) {
      if (ImGui.button('Deposit Now (' + plan.jobs.length + ')')) startDeposit();
    } else {
      ImGui.textColored([0.6, 0.6, 0.6, 1], 'Nothing to deposit (no matching items, or destination tabs not found).');
    }
  } else {
    ImGui.textColored([0.4, 1, 0.4, 1], 'Depositing... ' + depositQueue.length + ' left');
    ImGui.sameLine();
    if (ImGui.button('Stop')) stopDeposit();
  }

  if (depositLog.length && ImGui.collapsingHeader('Deposit log')) {
    if (ImGui.beginChild('##deplog', { x: 0, y: 120 }, ImGui.ChildFlags.Border)) {
      for (let i = 0; i < depositLog.length; i++) {
        const e = depositLog[i];
        ImGui.textColored(e.ok ? [0.5, 1, 0.5, 1] : [1, 0.4, 0.4, 1], (e.ok ? '-> ' : 'x  ') + esc(e.itemName) + '  ->  ' + esc(e.tabName));
      }
      ImGui.endChild();
    }
  }

  // ---------- Rules ----------
  ImGui.separator();
  ImGui.textColored([1, 1, 0.4, 1], 'Rules  (first match wins)');
  if (ImGui.beginChild('##rules', { x: 0, y: 150 }, ImGui.ChildFlags.Border)) {
    for (let i = 0; i < store.rules.length; i++) {
      const r = store.rules[i];
      const en = new ImGui.MutableVariable(!!r.enabled);
      if (ImGui.checkbox('##en' + r.id, en)) { r.enabled = en.value; saveStore(); }
      ImGui.sameLine();
      const crit = []
        .concat((r.pathContains || []).map(function (s) { return 'path~' + s; }))
        .concat((r.nameContains || []).map(function (s) { return 'name~' + s; }));
      if (r.minRarity >= 0) crit.push('>=' + (RARITY_NAMES[r.minRarity] || r.minRarity));
      const col = r.enabled ? [0.9, 0.9, 0.9, 1] : [0.5, 0.5, 0.5, 1];
      ImGui.textColored(col, esc(r.label) + '  ->  [' + esc(r.tab || '?') + ']');
      if (ImGui.isItemHovered() && crit.length) { ImGui.beginTooltip(); ImGui.text(esc(crit.join('\n'))); ImGui.endTooltip(); }
      ImGui.sameLine();
      if (ImGui.smallButton('Edit##' + r.id)) loadFormFromRule(r);
      ImGui.sameLine();
      if (ImGui.smallButton('X##' + r.id)) { store.rules.splice(i, 1); saveStore(); if (editingId === r.id) clearForm(); i--; }
    }
    ImGui.endChild();
  }

  // edit form
  ImGui.textColored([0.6, 0.85, 1, 1], editingId != null ? 'Editing rule' : 'New rule');
  ImGui.inputText('Label##f', fLabel);
  ImGui.inputText('Path contains (csv)##f', fPath);
  ImGui.inputText('Name contains (csv)##f', fName);
  tabNameCombo('Destination tab##f');
  if (ImGui.beginCombo('Min rarity##f', RARITY_FILTER[fRarity], ImGui.ComboFlags.None)) {
    for (let i = 0; i < RARITY_FILTER.length; i++) if (ImGui.selectable(RARITY_FILTER[i] + '##r' + i, i === fRarity)) fRarity = i;
    ImGui.endCombo();
  }
  if (ImGui.button(editingId != null ? 'Save rule' : 'Add rule')) { if (fTabName) saveForm(); }
  ImGui.sameLine();
  if (ImGui.button('New / clear')) clearForm();

  // ---------- Index browser ----------
  ImGui.separator();
  if (ImGui.collapsingHeader('Stash index (' + Object.keys(store.index).length + ' tabs)')) {
    const names = Object.keys(store.index);
    if (ImGui.beginChild('##idx', { x: 0, y: 200 }, ImGui.ChildFlags.Border)) {
      for (let n = 0; n < names.length; n++) {
        const nm = names[n];
        const e = store.index[nm];
        const ageS = Math.floor((Date.now() - (e.updated || 0)) / 1000);
        if (ImGui.treeNode(esc(nm) + '  [tab ' + e.tabId + ']  (' + e.count + ' items, ' + ageS + 's ago)##idx' + n)) {
          for (let k = 0; k < e.items.length; k++) {
            const it = e.items[k];
            ImGui.textColored(RARITY_COLORS[it.rarity || 0], '  ' + esc(it.name || '(item)') + (it.stack > 1 ? ' x' + it.stack : ''));
          }
          ImGui.treePop();
        }
      }
      if (!names.length) ImGui.textColored([0.6, 0.6, 0.6, 1], '(none yet — open some tabs)');
      ImGui.endChild();
    }
    if (ImGui.smallButton('Clear index')) { store.index = {}; saveStore(); }
  }

  ImGui.end();
}

// ===================== lifecycle =====================

function onTick() {
  loadStore();
  indexLoadedTabs();
  processQueue(vDelay.value || 300);
  processLoadQueue();
  saveIfDirty();
}

function onDisable() { if (dirty) saveStore(); stopDeposit(); }

export const stashSorterPlugin = {
  onTick: onTick,
  onDrawUI: onDrawUI,
  onDisable: onDisable,
};

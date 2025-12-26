/**
 * Rotation Builder
 * 
 * Build custom skill rotations with conditions and save them
 */

const poe2 = new POE2();

// Rotation data structure - loaded from file
let rotations = [];
let currentRotationName = "default";
let availableRotations = [];  // List of all saved rotation names
const ROTATIONS_FILE = "rotations.json";
const rotationNameInput = new ImGui.MutableVariable("default");

// UI state
let editingIndex = -1;
const newSkillName = new ImGui.MutableVariable("New Skill");
const newSkillPacket = new ImGui.MutableVariable("01 84 01 85 00 00 40 04 01 FF 00");

// Condition editing
let selectedConditionType = 0;  // Index into CONDITION_TYPES
let selectedOperator = 0;       // Index into OPERATORS
const conditionValue = new ImGui.MutableVariable(0);
const conditionStringValue = new ImGui.MutableVariable("");

// Condition types
const CONDITION_TYPES = [
  { id: 'distance', label: 'Distance to target', unit: 'units' },
  { id: 'monster_health_pct', label: 'Monster Health %', unit: '%' },
  { id: 'monster_max_health', label: 'Monster Max HP', unit: 'hp' },
  { id: 'monster_current_health', label: 'Monster Current HP', unit: 'hp' },
  { id: 'monster_rarity', label: 'Monster Rarity', unit: 'rarity' },
  { id: 'monster_has_buff', label: 'Monster has buff', unit: 'buff_name' },
  { id: 'player_health', label: 'Player Health %', unit: '%' },
  { id: 'player_mana', label: 'Player Mana', unit: 'points' },
  { id: 'player_es', label: 'Player ES %', unit: '%' },
  { id: 'player_has_buff', label: 'Player has buff', unit: 'buff_name' }
];

// Rarity values for conditions
const RARITY_VALUES = {
  NORMAL: 0,
  MAGIC: 1,
  RARE: 2,
  UNIQUE: 3
};

const RARITY_LABELS = ['Normal', 'Magic', 'Rare', 'Unique'];

const OPERATORS = ['>', '<', '>=', '<=', '==', '!='];

// Load rotations from file
function loadRotations() {
  try {
    const data = fs.readFile(ROTATIONS_FILE);  // lowercase 'fs'
    if (data) {
      const parsed = JSON.parse(data);
      availableRotations = Object.keys(parsed);
      rotations = parsed[currentRotationName] || [];
      console.log(`[Rotation] Loaded ${rotations.length} skills for rotation: ${currentRotationName}`);
      console.log(`[Rotation] Available rotations: ${availableRotations.join(', ')}`);
    }
  } catch (e) {
    console.log("[Rotation] No saved rotations, starting fresh");
    rotations = [];
    availableRotations = [];
  }
}

// Switch to a different rotation
function switchRotation(rotationName) {
  // Save current before switching
  saveRotations();
  
  // Load new rotation
  currentRotationName = rotationName;
  loadRotations();
}

// Save rotations to file
function saveRotations() {
  try {
    // Load existing data
    let allRotations = {};
    try {
      const existing = fs.readFile(ROTATIONS_FILE);  // lowercase 'fs'
      if (existing) {
        allRotations = JSON.parse(existing);
      }
    } catch (e) {
      // No existing file
    }
    
    // Update current rotation
    allRotations[currentRotationName] = rotations;
    
    // Save
    fs.writeFile(ROTATIONS_FILE, JSON.stringify(allRotations, null, 2));  // lowercase 'fs'
    console.log(`[Rotation] Saved ${rotations.length} skills`);
  } catch (e) {
    console.error("[Rotation] Failed to save:", e);
  }
}

// Evaluate a condition
function evaluateCondition(condition, player, target, distance) {
  const { type, operator, value, stringValue } = condition;
  
  let actual = 0;
  
  switch (type) {
    case 'distance':
      actual = distance;
      break;
      
    case 'monster_health':  // Legacy support
    case 'monster_health_pct':
      if (!target || !target.healthMax || target.healthMax === 0) return false;
      actual = (target.healthCurrent / target.healthMax) * 100;
      break;
      
    case 'monster_max_health':
      if (!target) return false;
      actual = target.healthMax || 0;
      break;
      
    case 'monster_current_health':
      if (!target) return false;
      actual = target.healthCurrent || 0;
      break;
      
    case 'monster_rarity':
      if (!target) return false;
      actual = target.rarity || 0;  // 0=Normal, 1=Magic, 2=Rare, 3=Unique
      break;
      
    case 'monster_has_buff':
      if (!target || !target.buffs) return false;
      return target.buffs.some(b => b.name && b.name.includes(stringValue || ''));
      
    case 'player_health':
      if (!player || !player.healthMax || player.healthMax === 0) return false;
      actual = (player.healthCurrent / player.healthMax) * 100;
      break;
      
    case 'player_mana':
      if (!player) return false;
      actual = player.manaCurrent || 0;
      break;
      
    case 'player_es':
      if (!player || !player.esMax || player.esMax === 0) return false;
      actual = (player.esCurrent / player.esMax) * 100;
      break;
      
    case 'player_has_buff':
      if (!player || !player.buffs) return false;
      return player.buffs.some(b => b.name && b.name.includes(stringValue || ''));
      
    default:
      return false;
  }
  
  // Apply operator
  const threshold = parseFloat(value) || 0;
  switch (operator) {
    case '>': return actual > threshold;
    case '<': return actual < threshold;
    case '>=': return actual >= threshold;
    case '<=': return actual <= threshold;
    case '==': return Math.abs(actual - threshold) < 0.01;
    case '!=': return Math.abs(actual - threshold) >= 0.01;
    default: return false;
  }
}

// Check if all conditions pass
function checkConditions(skill, player, target, distance) {
  if (!skill.conditions || skill.conditions.length === 0) {
    return true;  // No conditions = always true
  }
  
  // All conditions must pass (AND logic)
  for (const condition of skill.conditions) {
    if (!evaluateCondition(condition, player, target, distance)) {
      return false;
    }
  }
  
  return true;
}

// Execute rotation on target
function executeRotation(targetEntity, distance) {
  const player = poe2.getLocalPlayer();
  if (!player) return false;
  
  // Find first skill where all conditions pass
  for (const skill of rotations) {
    if (!skill.enabled) continue;
    
    if (checkConditions(skill, player, targetEntity, distance)) {
      // Build packet: 11 template bytes + 4 ID bytes (big-endian)
      const packet = new Uint8Array([
        ...skill.packetBytes,
        (targetEntity.id >> 24) & 0xFF,
        (targetEntity.id >> 16) & 0xFF,
        (targetEntity.id >> 8) & 0xFF,
        targetEntity.id & 0xFF
      ]);
      
      // Debug log packet construction
      const packetHex = Array.from(packet).map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
      console.log(`[Rotation] Packet: ${packetHex}`);
      console.log(`[Rotation] Template: ${skill.packetBytes.map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase()}`);
      console.log(`[Rotation] Target ID: 0x${targetEntity.id.toString(16).toUpperCase()}`);
      
      const success = poe2.sendPacket(packet);
      console.log(`[Rotation] Used ${skill.name} on target (success=${success})`);
      return true;
    }
  }
  
  return false;  // No skill matched conditions
}

// Parse packet string to bytes
function parsePacketString(str) {
  const hex = str.replace(/\s+/g, '');  // Remove spaces
  const bytes = [];
  
  for (let i = 0; i < hex.length && i < 22; i += 2) {  // Max 11 bytes
    const byte = parseInt(hex.substr(i, 2), 16);
    if (!isNaN(byte)) {
      bytes.push(byte);
    }
  }
  
  return bytes;
}

// Draw rotation builder UI
function drawRotationBuilder() {
  ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Rotation Builder");
  ImGui.separator();
  
  // Rotation management
  ImGui.text(`Current Rotation: ${currentRotationName}`);
  
  if (ImGui.collapsingHeader("Rotation Management")) {
    ImGui.text("Save Current Rotation As:");
    ImGui.inputText("##rotname", rotationNameInput);
    ImGui.sameLine();
    if (ImGui.button("Save")) {
      currentRotationName = rotationNameInput.value || "default";
      saveRotations();
      console.log(`[Rotation] Saved as: ${currentRotationName}`);
    }
    
    ImGui.separator();
    ImGui.text("Load Rotation:");
    
    if (availableRotations.length > 0) {
      for (const rotName of availableRotations) {
        const isCurrent = (rotName === currentRotationName);
        if (isCurrent) {
          ImGui.textColored([0.5, 1.0, 0.5, 1.0], `- ${rotName} (current)`);
        } else {
          if (ImGui.button(rotName)) {
            switchRotation(rotName);
          }
        }
      }
    } else {
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], "(No saved rotations)");
    }
  }
  
  ImGui.separator();
  
  ImGui.textWrapped("Build custom skill rotations with conditions. Skills are tried in order from top to bottom.");
  ImGui.textColored([0.5, 1.0, 1.0, 1.0], "AUTO-ATTACK:");
  ImGui.bulletText("When you hold auto-attack key, rotation executes on nearest target");
  ImGui.bulletText("Target ID is automatically added to packet (last 4 bytes)");
  ImGui.bulletText("Example: Packet '01 84 01 85...' + ID '0x6E' = full attack packet");
  
  ImGui.separator();
  
  // Add new skill
  if (ImGui.collapsingHeader("Add New Skill")) {
    ImGui.text("Skill Name:");
    ImGui.inputText("##skillname", newSkillName);
    
    ImGui.text("Packet Template (first 11 bytes in hex):");
    ImGui.inputTextWithHint("##packet", newSkillPacket, "01 84 01 85 00 00 40 04 01 FF 00");
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "Format: 11 bytes separated by spaces");
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "Target ID (last 4 bytes) added automatically");
    
    if (ImGui.button("Add Skill to Rotation")) {
      const bytes = parsePacketString(newSkillPacket.value);
      if (bytes.length === 11) {
        rotations.push({
          enabled: true,
          name: newSkillName.value || `Skill ${rotations.length + 1}`,
          packetBytes: bytes,
          conditions: []
        });
        saveRotations();
        console.log(`[Rotation] Added skill: ${newSkillName.value}`);
        
        // Reset inputs
        newSkillName.value = "New Skill";
        newSkillPacket.value = "01 84 01 85 00 00 40 04 01 FF 00";
      } else {
        console.error(`[Rotation] Invalid packet - expected 11 bytes, got ${bytes.length}`);
      }
    }
  }
  
  ImGui.separator();
  
  // Rotation list
  ImGui.text(`Rotation: ${currentRotationName} (${rotations.length} skills)`);
  ImGui.beginChild("RotationList", {x: 0, y: 400}, true);
  
  for (let i = 0; i < rotations.length; i++) {
    const skill = rotations[i];
    
    ImGui.pushID(i);
    
    // Enable/disable toggle
    const enabledColor = skill.enabled ? [0.2, 0.7, 0.2, 1.0] : [0.5, 0.5, 0.5, 1.0];
    ImGui.pushStyleColor(ImGui.Col.Button, enabledColor);
    if (ImGui.button(skill.enabled ? "ON##" + i : "OFF##" + i, {x: 40, y: 20})) {
      skill.enabled = !skill.enabled;
      saveRotations();
    }
    ImGui.popStyleColor(1);
    ImGui.sameLine();
    
    // Skill name
    if (skill.enabled) {
      ImGui.textColored([0.5, 1.0, 0.5, 1.0], `${i+1}. ${skill.name}`);
    } else {
      ImGui.textColored([0.5, 0.5, 0.5, 1.0], `${i+1}. ${skill.name} (disabled)`);
    }
    
    // Show packet
    const packetStr = skill.packetBytes.map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
    ImGui.text(`   Packet: ${packetStr}`);
    
    // Show conditions with delete buttons
    if (skill.conditions && skill.conditions.length > 0) {
      ImGui.text(`   Conditions (all must be true):`);
      for (let c = 0; c < skill.conditions.length; c++) {
        const cond = skill.conditions[c];
        const condType = CONDITION_TYPES.find(t => t.id === cond.type);
        const label = condType ? condType.label : cond.type;
        const unit = condType ? condType.unit : '';
        
        // Format value display (special case for rarity)
        let valueStr;
        if (unit === 'rarity' && typeof cond.value === 'number') {
          valueStr = RARITY_LABELS[cond.value] || cond.value;
        } else {
          valueStr = cond.stringValue || cond.value;
        }
        
        // Hide unit for rarity (already shown as name)
        const displayUnit = (unit === 'rarity') ? '' : unit;
        
        ImGui.pushID(`cond${c}`);
        if (ImGui.button("X##delcond")) {
          skill.conditions.splice(c, 1);
          saveRotations();
        }
        ImGui.popID();
        ImGui.sameLine();
        ImGui.text(`${label} ${cond.operator} ${valueStr} ${displayUnit}`);
      }
    } else {
      ImGui.textColored([0.7, 0.7, 0.7, 1.0], "   (No conditions - always use)");
    }
    
    // Buttons
    const isEditing = (editingIndex === i);
    if (ImGui.button(isEditing ? "Done##" + i : "Add Condition##" + i)) {
      editingIndex = isEditing ? -1 : i;
    }
    ImGui.sameLine();
    if (ImGui.button("Delete##" + i)) {
      rotations.splice(i, 1);
      if (editingIndex === i) editingIndex = -1;
      saveRotations();
    }
    ImGui.sameLine();
    if (i > 0 && ImGui.button("Up##" + i)) {
      [rotations[i], rotations[i-1]] = [rotations[i-1], rotations[i]];
      if (editingIndex === i) editingIndex = i - 1;
      else if (editingIndex === i - 1) editingIndex = i;
      saveRotations();
    }
    ImGui.sameLine();
    if (i < rotations.length - 1 && ImGui.button("Down##" + i)) {
      [rotations[i], rotations[i+1]] = [rotations[i+1], rotations[i]];
      if (editingIndex === i) editingIndex = i + 1;
      else if (editingIndex === i + 1) editingIndex = i;
      saveRotations();
    }
    
    // Show condition builder if editing this skill
    if (editingIndex === i) {
      ImGui.indent();
      //ImGui.textColored([1.0, 1.0, 0.5, 1.0], "Add Condition:");
      
      // Condition type dropdown
      ImGui.separator();
      ImGui.text("Type:");
      for (let ct = 0; ct < CONDITION_TYPES.length; ct++) {
        if (ImGui.radioButton(CONDITION_TYPES[ct].label + "##ct" + ct, selectedConditionType === ct)) {
          selectedConditionType = ct;
        }
      }
      
      ImGui.text("Operator:");
      for (let op = 0; op < OPERATORS.length; op++) {
        if (ImGui.radioButton(OPERATORS[op] + "##op" + op, selectedOperator === op)) {
          selectedOperator = op;
        }
        if (op < OPERATORS.length - 1) ImGui.sameLine();
      }
      
      ImGui.text("Value:");
      const selectedType = CONDITION_TYPES[selectedConditionType];
      if (selectedType.unit === 'buff_name') {
        ImGui.inputTextWithHint("##condvalue", conditionStringValue, "flask_effect_life");
      } else if (selectedType.unit === 'rarity') {
        // Show rarity selection buttons
        ImGui.textColored([0.7, 0.7, 0.7, 1.0], "0=Normal, 1=Magic, 2=Rare, 3=Unique");
        for (let r = 0; r < RARITY_LABELS.length; r++) {
          if (ImGui.radioButton(RARITY_LABELS[r] + "##rar" + r, conditionValue.value === r)) {
            conditionValue.value = r;
          }
          if (r < RARITY_LABELS.length - 1) ImGui.sameLine();
        }
      } else {
        ImGui.inputFloat("##condvalue", conditionValue, 1, 10);
      }
      
      if (ImGui.button("Add This Condition")) {
        const newCond = {
          type: selectedType.id,
          operator: OPERATORS[selectedOperator],
          value: conditionValue.value,
          stringValue: conditionStringValue.value
        };
        
        if (!skill.conditions) skill.conditions = [];
        skill.conditions.push(newCond);
        saveRotations();
        console.log(`[Rotation] Added condition to ${skill.name}`);
      }
      ImGui.sameLine();
      if (skill.conditions && skill.conditions.length > 0 && ImGui.button("Clear All Conditions")) {
        skill.conditions = [];
        saveRotations();
      }
      
      ImGui.unindent();
    }
    
    ImGui.separator();
    ImGui.popID();
  }
  
  ImGui.endChild();
  
  if (rotations.length === 0) {
    ImGui.textColored([0.7, 0.7, 0.7, 1.0], "No skills added. Add skills above to build your rotation.");
  }
  
  ImGui.separator();
  ImGui.textWrapped("Skills are tried in order. First skill where all conditions pass will be used.");
  ImGui.textWrapped("Example: Put high-damage skills with mana requirements first, basic attack last as fallback.");
}

export function drawRotationTab() {
  drawRotationBuilder();
}

export function executeRotationOnTarget(targetEntity, distance) {
  return executeRotation(targetEntity, distance);
}

// Initialize - load rotations on first call
let initialized = false;
export function initialize() {
  if (!initialized) {
    loadRotations();
    initialized = true;
  }
}

console.log("Rotation Builder loaded");

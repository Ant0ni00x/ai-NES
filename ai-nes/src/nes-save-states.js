// =============================================================================
// SAVE STATE IMPLEMENTATION
// Add this to nes-embed.js or import as a separate module
// =============================================================================
// SAVE STATE MODULE
// Usage: import { initSaveStates } from './nes-save-states.js';
//        initSaveStates(nes, logStatus);
// =============================================================================

const SAVE_STATE_PREFIX = 'nes_savestate_';
const SAVE_STATE_VERSION = 1;

// References set by init()
let nes = null;
let logStatus = (msg, type) => {}; // No-op logger for production

// Quick save held in memory
let quickSaveData = null;

/**
 * Initialize the save state module
 * @param {NES} nesInstance - The NES emulator instance
 * @param {Function} [logger] - Optional status logger function(msg, type)
 */
export function initSaveStates(nesInstance, logger) {
  nes = nesInstance;
  if (logger) logStatus = logger;
  
  // Register keyboard shortcuts
  document.addEventListener('keydown', handleSaveStateKeys);
}

/**
 * Save current emulator state to localStorage
 * @param {number} slot - Save slot number (0-9)
 * @returns {boolean} Success
 */
export function saveState(slot = 0) {
  if (!nes || !nes.rom) {
    logStatus('❌ No ROM loaded', 'error');
    return false;
  }
  
  try {
    const state = {
      version: SAVE_STATE_VERSION,
      timestamp: Date.now(),
      romHash: getRomHash(),
      data: nes.toJSON()
    };
    
    const key = SAVE_STATE_PREFIX + slot;
    localStorage.setItem(key, JSON.stringify(state));
    
    logStatus(`💾 State saved to slot ${slot}`, 'success');
    return true;
  } catch (err) {
    logStatus(`❌ Save failed: ${err.message}`, 'error');
    return false;
  }
}

/**
 * Load emulator state from localStorage
 * @param {number} slot - Save slot number (0-9)
 * @returns {boolean} Success
 */
export function loadState(slot = 0) {
  if (!nes || !nes.rom) {
    logStatus('❌ No ROM loaded', 'error');
    return false;
  }
  
  try {
    const key = SAVE_STATE_PREFIX + slot;
    const saved = localStorage.getItem(key);
    
    if (!saved) {
      logStatus(`❌ No save state in slot ${slot}`, 'error');
      return false;
    }
    
    const state = JSON.parse(saved);
    
    if (state.version !== SAVE_STATE_VERSION) {
      logStatus(`❌ Save state version mismatch (expected ${SAVE_STATE_VERSION}, got ${state.version})`, 'error');
      return false;
    }

    if (state.romHash && state.romHash !== getRomHash()) {
      logStatus('❌ Save state is from a different ROM', 'error');
      return false;
    }
    
    nes.fromJSON(state.data);
    
    logStatus(`📂 State loaded from slot ${slot}`, 'success');
    return true;
  } catch (err) {
    logStatus(`❌ Load failed: ${err.message}`, 'error');
    return false;
  }
}

/**
 * Quick save to memory (not persisted)
 * @returns {boolean} Success
 */
export function quickSave() {
  if (!nes || !nes.rom) {
    logStatus('❌ No ROM loaded', 'error');
    return false;
  }
  
  quickSaveData = {
    version: SAVE_STATE_VERSION,
    timestamp: Date.now(),
    romHash: getRomHash(),
    data: nes.toJSON()
  };
  logStatus('⚡ Quick saved', 'success');
  return true;
}

/**
 * Quick load from memory
 * @returns {boolean} Success
 */
export function quickLoad() {
  if (!quickSaveData) {
    logStatus('❌ No quick save', 'error');
    return false;
  }
  
  if (!nes || !nes.rom) {
    logStatus('❌ No ROM loaded', 'error');
    return false;
  }
  
  if (quickSaveData.version !== SAVE_STATE_VERSION) {
    logStatus(`❌ Quick save version mismatch (expected ${SAVE_STATE_VERSION}, got ${quickSaveData.version})`, 'error');
    return false;
  }

  if (quickSaveData.romHash && quickSaveData.romHash !== getRomHash()) {
    logStatus('❌ Quick save is from a different ROM', 'error');
    return false;
  }

  nes.fromJSON(quickSaveData.data);
  logStatus('⚡ Quick loaded', 'success');
  return true;
}

/**
 * Delete a save state
 * @param {number} slot - Save slot number (0-9)
 */
export function deleteState(slot = 0) {
  const key = SAVE_STATE_PREFIX + slot;
  localStorage.removeItem(key);
  logStatus(`🗑️ Slot ${slot} deleted`, 'info');
}

/**
 * List all save states
 * @returns {Array} Array of {slot, timestamp, romHash}
 */
export function listStates() {
  const states = [];
  
  for (let i = 0; i < 10; i++) {
    const key = SAVE_STATE_PREFIX + i;
    const saved = localStorage.getItem(key);
    
    if (saved) {
      try {
        const state = JSON.parse(saved);
        states.push({
          slot: i,
          timestamp: new Date(state.timestamp).toLocaleString(),
          romHash: state.romHash || 'unknown'
        });
      } catch (e) {
        // Corrupted save, skip
      }
    }
  }
  
  return states;
}

/**
 * Check if a slot has a save state
 * @param {number} slot - Save slot number (0-9)
 * @returns {boolean}
 */
export function hasState(slot = 0) {
  return localStorage.getItem(SAVE_STATE_PREFIX + slot) !== null;
}

/**
 * Download save state as a file
 * @param {number} slot - Save slot number
 */
export function downloadState(slot = 0) {
  const key = SAVE_STATE_PREFIX + slot;
  const saved = localStorage.getItem(key);
  
  if (!saved) {
    logStatus(`❌ No save state in slot ${slot}`, 'error');
    return;
  }
  
  const blob = new Blob([saved], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `savestate_slot${slot}.json`;
  a.click();
  
  URL.revokeObjectURL(url);
  logStatus(`📥 Downloaded slot ${slot}`, 'success');
}

/**
 * Import save state from file
 * @param {File} file - JSON file to import
 * @param {number} slot - Target slot
 * @returns {Promise<boolean>} Success
 */
export function importState(file, slot = 0) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const state = JSON.parse(e.target.result);
        if (!state.data || !state.version) {
          throw new Error('Invalid save state format');
        }
        if (state.version !== SAVE_STATE_VERSION) {
          throw new Error(`Save state version mismatch (expected ${SAVE_STATE_VERSION}, got ${state.version})`);
        }
        
        const key = SAVE_STATE_PREFIX + slot;
        localStorage.setItem(key, e.target.result);
        logStatus(`📤 Imported to slot ${slot}`, 'success');
        resolve(true);
      } catch (err) {
        logStatus(`❌ Import failed: ${err.message}`, 'error');
        resolve(false);
      }
    };
    
    reader.onerror = () => {
      logStatus('❌ Failed to read file', 'error');
      resolve(false);
    };
    
    reader.readAsText(file);
  });
}

/**
 * Simple ROM hash for identifying saves
 * @returns {string}
 */
function getRomHash() {
  if (!nes || !nes.romData) return 'unknown';
  
  let hash = 0;
  const len = Math.min(1024, nes.romData.length);
  for (let i = 0; i < len; i++) {
    hash = ((hash << 5) - hash) + nes.romData[i];
    hash |= 0;
  }
  return hash.toString(16);
}

/**
 * Keyboard shortcut handler
 * F5 = Quick Save, F8 = Quick Load
 * 1-9 = Load slot, Shift+1-9 = Save to slot
 */
function handleSaveStateKeys(e) {
  // Ignore if typing in an input
  if (document.activeElement.tagName === 'INPUT' || 
      document.activeElement.tagName === 'TEXTAREA') {
    return;
  }
  
  // F5 = Quick Save
  if (e.keyCode === 116) {
    e.preventDefault();
    quickSave();
  }
  // F8 = Quick Load
  else if (e.keyCode === 119) {
    e.preventDefault();
    quickLoad();
  }
  // Shift + 1-9 = Save to slot
  else if (e.shiftKey && e.keyCode >= 49 && e.keyCode <= 57) {
    e.preventDefault();
    saveState(e.keyCode - 49);
  }
  // 1-9 = Load from slot (no modifiers)
  else if (!e.shiftKey && !e.ctrlKey && !e.altKey && e.keyCode >= 49 && e.keyCode <= 57) {
    e.preventDefault();
    loadState(e.keyCode - 49);
  }
}

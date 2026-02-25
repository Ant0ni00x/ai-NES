// =============================================================================
// SAVE STATE IMPLEMENTATION
// Add this to nes-embed.js or import as a separate module
// =============================================================================
// SAVE STATE MODULE
// Usage: import { initSaveStates } from './nes-save-states.js';
//        initSaveStates(nes, logStatus);
// =============================================================================

const SAVE_STATE_PREFIX = 'nes_savestate_';
const SAVE_STATE_VERSION = 3; // v3: strict versioned save state format

// References set by init()
let nes = null;
let logStatus = (msg, type) => {}; // No-op logger for production

// Quick save held in memory (uncompressed for speed)
let quickSaveData = null;

// =============================================================================
// COMPRESSION UTILITIES - Base64 encoding for typed arrays
// Reduces save state size by ~30-40% compared to JSON arrays
// =============================================================================

/**
 * Encode Uint8Array to Base64 string (more compact than JSON arrays)
 * @param {Uint8Array} uint8Array
 * @returns {string}
 */
function uint8ToBase64(uint8Array) {
  const CHUNK_SIZE = 0x8000; // 32KB chunks to avoid call stack limits
  let result = '';
  for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
    const chunk = uint8Array.subarray(i, i + CHUNK_SIZE);
    result += String.fromCharCode.apply(null, chunk);
  }
  return btoa(result);
}

/**
 * Decode Base64 string to Uint8Array
 * @param {string} base64
 * @returns {Uint8Array}
 */
function base64ToUint8(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Recursively convert typed arrays to Base64 in state object
 * @param {Object} obj
 * @returns {Object}
 */
function compressState(obj) {
  if (obj === null || obj === undefined) return obj;

  // Handle typed arrays - convert to Base64
  if (obj instanceof Uint8Array) {
    return { __t__: 'u8', __d__: uint8ToBase64(obj) };
  }
  if (obj instanceof Int32Array) {
    const bytes = new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    return { __t__: 'i32', __d__: uint8ToBase64(bytes) };
  }
  if (obj instanceof Uint32Array) {
    const bytes = new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    return { __t__: 'u32', __d__: uint8ToBase64(bytes) };
  }
  if (obj instanceof Int8Array) {
    const bytes = new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    return { __t__: 'i8', __d__: uint8ToBase64(bytes) };
  }

  // Handle regular arrays (may contain typed arrays or primitives)
  if (Array.isArray(obj)) {
    // Check if it's a large numeric array (likely from typed array conversion)
    if (obj.length > 100 && typeof obj[0] === 'number') {
      // Convert to Uint8Array if values are in byte range
      const allBytes = obj.every(v => Number.isInteger(v) && v >= 0 && v <= 255);
      if (allBytes) {
        return { __t__: 'u8', __d__: uint8ToBase64(new Uint8Array(obj)) };
      }
    }
    return obj.map(compressState);
  }

  // Handle plain objects
  if (typeof obj === 'object') {
    const result = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = compressState(obj[key]);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Recursively restore typed arrays from Base64 in state object
 * @param {Object} obj
 * @returns {Object}
 */
function decompressState(obj) {
  if (obj === null || obj === undefined) return obj;

  // Handle compressed typed arrays
  if (typeof obj === 'object' && obj.__t__ && obj.__d__) {
    const bytes = base64ToUint8(obj.__d__);
    switch (obj.__t__) {
      case 'u8': return bytes;
      case 'i8': return new Int8Array(bytes.buffer);
      case 'i32': return new Int32Array(bytes.buffer);
      case 'u32': return new Uint32Array(bytes.buffer);
      default: return bytes;
    }
  }

  if (Array.isArray(obj)) {
    return obj.map(decompressState);
  }

  if (typeof obj === 'object') {
    const result = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = decompressState(obj[key]);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Get CRC32 hash of ROM for reliable identification
 * Uses the ROM's built-in CRC32 function if available
 * @returns {string}
 */
function getRomHash() {
  if (!nes || !nes.rom) return 'unknown';

  // Use ROM's CRC32 if available (preferred - full ROM hash)
  if (nes.rom.getCRC32) {
    return nes.rom.getCRC32().toString(16).toUpperCase().padStart(8, '0');
  }

  // Fallback: Simple hash of first 1KB
  if (!nes.romData) return 'unknown';
  let hash = 0;
  const len = Math.min(1024, nes.romData.length);
  for (let i = 0; i < len; i++) {
    hash = ((hash << 5) - hash) + nes.romData[i];
    hash |= 0;
  }
  return hash.toString(16);
}

// =============================================================================
// PUBLIC API
// =============================================================================

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
    const rawState = nes.toJSON();
    const compressedState = compressState(rawState);

    const state = {
      version: SAVE_STATE_VERSION,
      timestamp: Date.now(),
      romHash: getRomHash(),
      data: compressedState
    };

    const key = SAVE_STATE_PREFIX + slot;
    const json = JSON.stringify(state);
    localStorage.setItem(key, json);

    // Report size saved
    const sizeKB = (json.length / 1024).toFixed(1);
    logStatus(`💾 State saved to slot ${slot} (${sizeKB} KB)`, 'success');
    return true;
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      logStatus('❌ Save failed: localStorage full', 'error');
    } else {
      logStatus(`❌ Save failed: ${err.message}`, 'error');
    }
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

    // Strict version compatibility
    if (state.version !== SAVE_STATE_VERSION) {
      logStatus(`❌ Save state version not supported (got v${state.version}, expected v${SAVE_STATE_VERSION})`, 'error');
      return false;
    }

    if (state.romHash && state.romHash !== getRomHash()) {
      logStatus('⚠️ Save state may be from a different ROM', 'warning');
      // Continue anyway - user might be loading intentionally
    }

    nes.fromJSON(decompressState(state.data));

    logStatus(`📂 State loaded from slot ${slot}`, 'success');
    return true;
  } catch (err) {
    logStatus(`❌ Load failed: ${err.message}`, 'error');
    return false;
  }
}

/**
 * Quick save to memory (not persisted, no compression for speed)
 * @returns {boolean} Success
 */
export function quickSave() {
  if (!nes || !nes.rom) {
    logStatus('❌ No ROM loaded', 'error');
    return false;
  }

  // Quick save stores raw state in memory (faster than compression)
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
    logStatus(`❌ Quick save version not supported (got v${quickSaveData.version}, expected v${SAVE_STATE_VERSION})`, 'error');
    return false;
  }

  if (quickSaveData.romHash && quickSaveData.romHash !== getRomHash()) {
    logStatus('⚠️ Quick save may be from a different ROM', 'warning');
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
 * List all save states with metadata
 * @returns {Array} Array of {slot, timestamp, romHash, sizeKB}
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
          romHash: state.romHash || 'unknown',
          version: state.version ?? 'unknown',
          sizeKB: (saved.length / 1024).toFixed(1)
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
 * Get total localStorage usage by save states
 * @returns {{used: number, slots: number}}
 */
export function getStorageUsage() {
  let totalBytes = 0;
  let slotCount = 0;

  for (let i = 0; i < 10; i++) {
    const saved = localStorage.getItem(SAVE_STATE_PREFIX + i);
    if (saved) {
      totalBytes += saved.length;
      slotCount++;
    }
  }

  return {
    usedKB: (totalBytes / 1024).toFixed(1),
    slots: slotCount
  };
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
          throw new Error(`Save state version not supported (v${state.version}, expected: v${SAVE_STATE_VERSION})`);
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

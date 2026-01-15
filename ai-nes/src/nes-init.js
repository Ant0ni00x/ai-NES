import { NES, Controller, applyCompatibilityFixes, initSaveStates, saveState, loadState, quickSave, quickLoad } from './index.js';
import { NESDebug } from '../debug/debug.js';

// =============================================================================
// CONSTANTS
// =============================================================================
const SCREEN_WIDTH = 256;
const SCREEN_HEIGHT = 240;
const FRAMEBUFFER_SIZE = SCREEN_WIDTH * SCREEN_HEIGHT;

const AUDIO_BUFFER_SIZE = 4096; // Samples per batch sent to the worklet
const AUDIO_RING_BUFFER_SIZE = 8192; // Worklet ring buffer (power of two)
const AUDIO_TARGET_BUFFER_MS = 80; // Keep this much audio queued to avoid underruns
const AUDIO_MAX_CATCHUP_FRAMES = 4; // Cap extra frames per tick
const AUDIO_PREFILL_MAX_FRAMES = 8; // Cap initial prefill work

// =============================================================================
// STATE
// =============================================================================
let canvasCtx, imageData, framebufferU32;

// Audio
let audioCtx, gainNode, audioWorkletNode;
let audioQueuedSamples = 0;
let audioTimeRef = 0;

// Sample accumulator - batches samples before sending to AudioWorklet
const sampleBatchL = new Float32Array(AUDIO_BUFFER_SIZE);
const sampleBatchR = new Float32Array(AUDIO_BUFFER_SIZE);
let batchPos = 0;

let emulationRunning = false;
let fastForward = false;

// Gamepad
let gamepadIndex = null;
const gamepadState = new Array(16).fill(false);
const GAMEPAD_MAP = {
  0: Controller.BUTTON_B, 1: Controller.BUTTON_A,
  2: Controller.BUTTON_A, 3: Controller.BUTTON_B,
  8: Controller.BUTTON_SELECT, 9: Controller.BUTTON_START,
  12: Controller.BUTTON_UP, 13: Controller.BUTTON_DOWN,
  14: Controller.BUTTON_LEFT, 15: Controller.BUTTON_RIGHT
};

// =============================================================================
// NES
// =============================================================================
export const nes = new NES({
  
  onFrame(fb24) {
    for (var i = 0; i < FRAMEBUFFER_SIZE; i++) {
      framebufferU32[i] = 0xFF000000 | fb24[i];
    }
  },
  onAudioSample(l, r) {
    // Batch samples for AudioWorklet
    sampleBatchL[batchPos] = l;
    sampleBatchR[batchPos] = r;
    batchPos++;

    // Flush when batch is full
    if (batchPos >= sampleBatchL.length) {
      flushAudio();
    }
  }
});

// Expose NES instance to window for external access
window.nes = nes;

// Debug module - F9 triggers snapshot at scanline 241
const nesDebug = new NESDebug(nes);
nesDebug.bindKey(document, 'F9');
window.nesDebug = nesDebug;

// Wrap PPU step to check for scanline-triggered debug snapshots
const originalPpuStep = nes.ppu.step.bind(nes.ppu);
nes.ppu.step = function() {
  const result = originalPpuStep();
  if (this.cycle === 0) {
    nesDebug.checkTrigger();
  }
  return result;
};

// =============================================================================
// AUDIO - Modern AudioWorklet-only implementation
// =============================================================================
async function initAudio() {
  audioCtx = new AudioContext({ latencyHint: 'playback' });
  nes.opts.sampleRate = audioCtx.sampleRate;
  if (nes.papu) {
    nes.papu.setSampleRate(audioCtx.sampleRate, true);
  }

  gainNode = audioCtx.createGain();
  gainNode.gain.value = 0.5; // Matches volume slider default
  gainNode.connect(audioCtx.destination);

  // Inline AudioWorklet code for single-file bundle
  const workletCode = `
class NESAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) ? options.processorOptions : {};
    const requestedSize = opts.bufferSize || 8192;
    const isPowerOfTwo = (requestedSize & (requestedSize - 1)) === 0;
    this.bufferSize = isPowerOfTwo ? requestedSize : 8192;
    this.bufferMask = this.bufferSize - 1;
    this.samplesL = new Float32Array(this.bufferSize);
    this.samplesR = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.port.onmessage = (event) => {
      if (event.data.type === 'samples') {
        const { left, right } = event.data;
        const count = left.length;
        for (let i = 0; i < count; i++) {
          const nextIndex = (this.writeIndex + 1) & this.bufferMask;
          if (nextIndex === this.readIndex) {
            this.readIndex = (this.readIndex + 1) & this.bufferMask;
          }
          this.samplesL[this.writeIndex] = left[i];
          this.samplesR[this.writeIndex] = right[i];
          this.writeIndex = nextIndex;
        }
      } else if (event.data.type === 'reset') {
        this.samplesL.fill(0);
        this.samplesR.fill(0);
        this.writeIndex = 0;
        this.readIndex = 0;
      }
    };
  }
  available() {
    return (this.writeIndex - this.readIndex) & this.bufferMask;
  }
  process(inputs, outputs, parameters) {
    const outputL = outputs[0][0];
    const outputR = outputs[0][1];
    const len = outputL.length;
    const avail = this.available();
    if (avail >= len) {
      for (let i = 0; i < len; i++) {
        outputL[i] = this.samplesL[this.readIndex];
        outputR[i] = this.samplesR[this.readIndex];
        this.readIndex = (this.readIndex + 1) & this.bufferMask;
      }
    } else {
      let lastL = 0, lastR = 0;
      for (let i = 0; i < len; i++) {
        if (i < avail) {
          lastL = outputL[i] = this.samplesL[this.readIndex];
          lastR = outputR[i] = this.samplesR[this.readIndex];
          this.readIndex = (this.readIndex + 1) & this.bufferMask;
        } else {
          const fade = 1 - ((i - avail) / (len - avail));
          outputL[i] = lastL * fade;
          outputR[i] = lastR * fade;
        }
      }
    }
    return true;
  }
}
registerProcessor('nes-audio-processor', NESAudioProcessor);
`;

  const blob = new Blob([workletCode], { type: 'application/javascript' });
  const workletUrl = URL.createObjectURL(blob);

  await audioCtx.audioWorklet.addModule(workletUrl);
  audioWorkletNode = new AudioWorkletNode(audioCtx, 'nes-audio-processor', {
    numberOfInputs: 0,
    outputChannelCount: [2],
    processorOptions: { bufferSize: AUDIO_RING_BUFFER_SIZE }
  });
  audioWorkletNode.connect(gainNode);

  URL.revokeObjectURL(workletUrl);
}

function resetAudioQueue() {
  audioQueuedSamples = 0;
  audioTimeRef = audioCtx ? audioCtx.currentTime : 0;
}

function syncAudioTime() {
  if (audioCtx) audioTimeRef = audioCtx.currentTime;
}

function updateAudioQueueEstimate() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  if (!audioTimeRef) {
    audioTimeRef = now;
    return;
  }
  const consumed = (now - audioTimeRef) * audioCtx.sampleRate;
  if (consumed <= 0) return;
  audioQueuedSamples = Math.max(0, audioQueuedSamples - consumed);
  audioTimeRef = now;
}

function targetAudioSamples() {
  return audioCtx
    ? Math.floor(audioCtx.sampleRate * (AUDIO_TARGET_BUFFER_MS / 1000))
    : 0;
}

function topUpAudioBuffer(maxFrames = AUDIO_MAX_CATCHUP_FRAMES) {
  if (!audioCtx) return;
  const target = targetAudioSamples();
  let guard = maxFrames;
  while ((audioQueuedSamples + batchPos) < target && guard > 0) {
    nes.frame();
    guard--;
  }
}

function flushAudio() {
  if (!audioWorkletNode || batchPos === 0) return;

  // Send current batch to AudioWorklet
  const left = sampleBatchL.subarray(0, batchPos);
  const right = sampleBatchR.subarray(0, batchPos);
  audioWorkletNode.port.postMessage({ type: 'samples', left, right });
  audioQueuedSamples = Math.min(
    audioQueuedSamples + batchPos,
    AUDIO_RING_BUFFER_SIZE - 1
  );
  batchPos = 0;
}

function initAudioToggles() {
  const buttons = document.querySelectorAll('.audio-toggle');
  if (!buttons.length || !nes?.papu) return;

  buttons.forEach((button) => {
    const channel = button.dataset.channel;
    if (!channel) return;
    button.addEventListener('click', () => {
      const active = !button.classList.contains('active');
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      nes.papu.setChannelSolo(channel, active);
    });
  });

  const mixButton = document.getElementById('audio-mix');
  mixButton?.addEventListener('click', () => {
    nes.papu.resetChannelMix();
    buttons.forEach((button) => {
      button.classList.remove('active');
      button.setAttribute('aria-pressed', 'false');
    });
  });
}

// =============================================================================
// MAIN LOOP
// =============================================================================
function onAnimationFrame() {
  requestAnimationFrame(onAnimationFrame);
  if (!emulationRunning) return;
  
  updateAudioQueueEstimate();

  // Fast Forward: Run multiple frames per update
  const speed = fastForward ? 4 : 1;
  for (let i = 0; i < speed; i++) {
      nes.frame();
  }
  if (!fastForward) {
    topUpAudioBuffer(AUDIO_MAX_CATCHUP_FRAMES);
  }
  flushAudio();

  // Fix: Properly convert 32-bit RGB to RGBA byte order for canvas
  for (let i = 0; i < FRAMEBUFFER_SIZE; i++) {
    const rgb = framebufferU32[i];
    const base = i * 4;
    imageData.data[base + 0] = (rgb >> 16) & 0xFF;  // R
    imageData.data[base + 1] = (rgb >> 8) & 0xFF;   // G
    imageData.data[base + 2] = rgb & 0xFF;          // B
    imageData.data[base + 3] = 0xFF;                // A (opaque)
  }
  canvasCtx.putImageData(imageData, 0, 0);

  pollGamepad();
}

// =============================================================================
// INPUT
// =============================================================================
function pollGamepad() {
  if (gamepadIndex === null) return;
  const gp = navigator.getGamepads()[gamepadIndex];
  if (!gp) return;
  
  for (const [btn, nesBtn] of Object.entries(GAMEPAD_MAP)) {
    const pressed = gp.buttons[btn]?.pressed ?? false;
    if (pressed !== gamepadState[btn]) {
      gamepadState[btn] = pressed;
      pressed ? nes.buttonDown(1, nesBtn) : nes.buttonUp(1, nesBtn);
    }
  }
}

function handleKey(callback, e) {
  const map = {
    38: Controller.BUTTON_UP, 40: Controller.BUTTON_DOWN,
    37: Controller.BUTTON_LEFT, 39: Controller.BUTTON_RIGHT,
    65: Controller.BUTTON_A, 81: Controller.BUTTON_A,
    83: Controller.BUTTON_B, 79: Controller.BUTTON_B,
    9: Controller.BUTTON_SELECT, 13: Controller.BUTTON_START
  };
  if (map[e.keyCode] !== undefined) {
    callback(1, map[e.keyCode]);
    e.preventDefault();
  }
}

// =============================================================================
// INIT
// =============================================================================
function nesInit(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return false;
  
  // Explicitly set internal resolution to match NES output
  canvas.width = SCREEN_WIDTH;
  canvas.height = SCREEN_HEIGHT;
  
  canvasCtx = canvas.getContext('2d');
  imageData = canvasCtx.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  canvasCtx.fillStyle = 'black';
  canvasCtx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

  // Create framebuffer for receiving NES output (32-bit RGB)
  framebufferU32 = new Uint32Array(FRAMEBUFFER_SIZE);
  return true;
}

async function nesBoot(romData) {
  if (!audioCtx) await initAudio();

  // Reset audio state
  batchPos = 0;
  resetAudioQueue();
  audioWorkletNode?.port.postMessage({ type: 'reset' });

  // Load ROM - now accepts Uint8Array directly (modern, hardware-accurate)
  nes.loadROM(romData);

  // Apply compatibility fixes (header corrections, etc.)
  applyCompatibilityFixes(nes, logStatus);

  initSaveStates(nes, logStatus);

  // Pre-buffer audio to target to reduce startup underruns
  topUpAudioBuffer(AUDIO_PREFILL_MAX_FRAMES);
  flushAudio();

  // Now start audio playback
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  syncAudioTime();

  emulationRunning = true;
  requestAnimationFrame(onAnimationFrame);
}

async function nesLoadUrl(canvasId, path) {
  if (!nesInit(canvasId)) return;
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Pass Uint8Array directly - no string conversion needed
    const romData = new Uint8Array(await res.arrayBuffer());
    await nesBoot(romData);
  } catch (e) {
    logStatus(`Failed: ${e.message}`, 'error');
  }
}

async function nesLoadData(canvasId, romData) {
  if (!nesInit(canvasId)) return;
  // romData should be Uint8Array
  await nesBoot(romData);
}

// =============================================================================
// UI
// =============================================================================
function logStatus(msg, type = 'info') {
  const s = document.getElementById('status');
  if (!s) return;
  if (s.innerHTML.includes('Waiting')) s.innerHTML = '';
  s.innerHTML += `<div class="${type}">${msg}</div>`;
  s.scrollTop = s.scrollHeight;
}

function hideOverlay() {
  const o = document.getElementById('overlay');
  if (o) { o.style.opacity = '0'; setTimeout(() => o.style.display = 'none', 300); }
}

async function startEmulator() {
  hideOverlay();
  logStatus('▶️ Starting...', 'success');
  await nesLoadUrl('nes-canvas', 'roms/Gauntlet.nes');
  logStatus('✓ ROM loaded', 'info');
  if (nes?.rom) logStatus(`📋 PCB: NES-${nes.rom.getPcbClass()} (Mapper ${nes.rom.mapperType})`, 'info');
}

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('gameContainer')?.classList.remove('drag-over');
  
  const file = e.dataTransfer.files[0];
  if (!file?.name.toLowerCase().endsWith('.nes')) {
    logStatus('❌ Drop a .nes file', 'error');
    return;
  }
  
  hideOverlay();
  logStatus(`📦 Loading: ${file.name}`, 'info');
  
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      // Pass Uint8Array directly - modern, hardware-accurate approach
      await nesLoadData('nes-canvas', new Uint8Array(ev.target.result));
      logStatus('✓ ROM loaded', 'success');
      if (nes?.rom) logStatus(`📋 PCB: NES-${nes.rom.getPcbClass()} (Mapper ${nes.rom.mapperType})`, 'info');
    } catch (err) {
      logStatus(`❌ ${err.message}`, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function setVolume(v) { if (gainNode) gainNode.gain.value = v * v; }
function pause() { emulationRunning = false; audioCtx?.suspend(); }
function resume() {
  emulationRunning = true;
  if (audioCtx) {
    audioCtx.resume().then(syncAudioTime);
  }
}

export { pause, resume, setVolume };

// =============================================================================
// EVENTS
// =============================================================================
document.addEventListener('keydown', e => {
    handleKey(nes.buttonDown, e);
    if (e.key === 'f' || e.key === 'F') fastForward = true;
});
document.addEventListener('keyup', e => {
    handleKey(nes.buttonUp, e);
    if (e.key === 'f' || e.key === 'F') fastForward = false;
});

window.addEventListener('gamepadconnected', e => {
  gamepadIndex = e.gamepad.index;
  const s = document.getElementById('gamepadStatus');
  if (s) { s.textContent = `Gamepad: ${e.gamepad.id.slice(0,15)}...`; s.className = 'connected'; }
});

window.addEventListener('gamepaddisconnected', e => {
  if (gamepadIndex === e.gamepad.index) {
    gamepadIndex = null;
    const s = document.getElementById('gamepadStatus');
    if (s) { s.textContent = 'Gamepad: Not connected'; s.className = 'disconnected'; }
  }
});

window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('overlay')?.addEventListener('click', startEmulator);
  const gc = document.getElementById('gameContainer');
  if (gc) {
    gc.addEventListener('drop', handleDrop);
    gc.addEventListener('dragover', e => { e.preventDefault(); gc.classList.add('drag-over'); });
    gc.addEventListener('dragleave', () => gc.classList.remove('drag-over'));
  }
  
  // Zapper / Mouse Support
  const canvas = document.getElementById('nes-canvas');
  if (canvas) {
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('mousemove', e => {
      // Use offsetX/Y to correctly handle CSS borders and padding
      const scaleX = SCREEN_WIDTH / canvas.clientWidth;
      const scaleY = SCREEN_HEIGHT / canvas.clientHeight;
      const x = Math.floor(e.offsetX * scaleX);
      const y = Math.floor(e.offsetY * scaleY);
      if (x >= 0 && x < 256 && y >= 0 && y < 240) {
        nes.zapperMove(x, y);
      }
    });
    canvas.addEventListener('mousedown', e => { if (e.button === 0) nes.zapperFireDown(); });
    canvas.addEventListener('mouseup', e => { if (e.button === 0) nes.zapperFireUp(); });
  }
  
  document.getElementById('volume')?.addEventListener('input', e => setVolume(e.target.value / 100));
  initAudioToggles();
});

document.getElementById('btn-save')?.addEventListener('click', () => {
  const slot = parseInt(document.getElementById('save-slot').value);
  saveState(slot);
});

document.getElementById('btn-load')?.addEventListener('click', () => {
  const slot = parseInt(document.getElementById('save-slot').value);
  loadState(slot);
});

document.getElementById('btn-reset')?.addEventListener('click', () => {
  logStatus('🔄 System Reset', 'info');
  nes.reset();
});

// Load ROM button
document.getElementById('btn-load-rom')?.addEventListener('click', () => {
  document.getElementById('rom-file')?.click();
});

document.getElementById('rom-file')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.nes')) {
    logStatus('❌ Please select a .nes file', 'error');
    return;
  }

  hideOverlay();
  logStatus(`📦 Loading: ${file.name}`, 'info');

  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      await nesLoadData('nes-canvas', new Uint8Array(ev.target.result));
      logStatus('✓ ROM loaded', 'success');
      if (nes?.rom) logStatus(`📋 PCB: NES-${nes.rom.getPcbClass()} (Mapper ${nes.rom.mapperType})`, 'info');
    } catch (err) {
      logStatus(`❌ ${err.message}`, 'error');
    }
  };
  reader.readAsArrayBuffer(file);

  // Reset file input so the same file can be loaded again
  e.target.value = '';
});

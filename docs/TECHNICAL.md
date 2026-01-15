# AI-NES Technical Documentation

This document covers the internal architecture and key implementation details of the AI-NES emulator, with emphasis on **correct hardware modeling** and the **capability-driven mapper system**.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [CPU (6502)](#cpu-6502)
3. [PPU (Picture Processing Unit)](#ppu-picture-processing-unit)
4. [PPU <-> Mapper Contract (Core Design)](#ppu--mapper-contract-core-design)
5. [APU (Audio Processing Unit)](#apu-audio-processing-unit)
6. [Memory Mappers](#memory-mappers)
7. [Audio System](#audio-system)
8. [Save State System](#save-state-system)
9. [Timing and Synchronization](#timing-and-synchronization)
10. [Performance Optimizations](#performance-optimizations)
11. [Debugging Guide](#debugging-guide)
12. [References](#references)

---

## Architecture Overview

The emulator follows a component-based design mirroring the NES hardware:

```
┌─────────────────────────────────────────────────────────┐
│                        NES Class                        │
│  (Orchestrator - handles frame loop, component wiring)  │
├─────────────┬─────────────┬─────────────┬───────────────┤
│    CPU      │     PPU     │    PAPU     │   Mapper      │
│   (6502)    │  (Graphics) │   (Audio)   │ (Bank Switch) │
└─────────────┴─────────────┴─────────────┴───────────────┘
```

The **NES class** orchestrates timing and wiring. Each component is isolated and communicates through explicit, well‑defined interfaces.

### Frame Execution Flow

```javascript
// nes.js - frame() method
1. PPU starts frame (startFrame)
2. Loop until frame complete:
   a. CPU executes instruction (cpu.step), returns cycle count
   b. APU clocks for those cycles (audio sample generation)
   c. PPU advances by cycles * 3, minus any cycles already advanced by catchUp()
   d. Mapper cpuClock handles cycle-based timing (MMC5)
3. PPU endFrame pushes the framebuffer to onFrame
```

The CPU calls `nes.catchUp()` before PPU register access, OAM DMA, and mapper IO, which advances the PPU to the exact cycle for that bus event. The main loop then skips those already-advanced cycles using `ppuCyclesToSkip` and `cpuCyclesToSkip`.

---

## CPU (6502)

### Implementation Highlights

- **Typed Array Memory**: Uses `Uint8Array(0x10000)` for 64KB address space
- **Pre-computed Opcode Table**: `OPDATA` array built at module load time
- **Undocumented Opcodes**: Most common unofficial instructions implemented; remaining opcodes default to NOP (JAM/KIL not emulated)
- **Open Bus Latch**: `dataBus` tracks last value for open bus reads

### Opcode Data Encoding

Each opcode is packed into a 32-bit integer:
```
Bits 0-7:   Instruction type (INS_ADC, INS_AND, etc.)
Bits 8-15:  Addressing mode (ADDR_IMM, ADDR_ZP, etc.)
Bits 16-23: Instruction size in bytes
Bits 24-31: Base cycle count
```

### Addressing Modes

| Mode | Code | Example | Description |
|------|------|---------|-------------|
| Immediate | `ADDR_IMM` | `LDA #$44` | Value in next byte |
| Zero Page | `ADDR_ZP` | `LDA $44` | Address in zero page |
| Zero Page,X | `ADDR_ZPX` | `LDA $44,X` | ZP + X register |
| Absolute | `ADDR_ABS` | `LDA $4400` | 16-bit address |
| Absolute,X | `ADDR_ABSX` | `LDA $4400,X` | Abs + X (page cross +1 cycle) |
| Indirect,X | `ADDR_PREIDXIND` | `LDA ($44,X)` | Pre-indexed indirect |
| Indirect,Y | `ADDR_POSTIDXIND` | `LDA ($44),Y` | Post-indexed indirect |

### IRQ Handling

Three IRQ types are supported:
```javascript
CPU.IRQ_NORMAL = 0;  // Mapper IRQs (e.g., MMC3 scanline counter)
CPU.IRQ_NMI = 1;     // VBlank NMI from PPU
CPU.IRQ_RESET = 2;   // System reset
```

---

## PPU (Picture Processing Unit)

### Rendering Pipeline

The PPU renders 262 scanlines per frame:
- Scanlines 0-239: Visible frame (240 lines)
- Scanline 240: Post-render (idle)
- Scanlines 241-260: VBlank (NMI asserted at scanline 241, cycle 1)
- Scanline 261: Pre-render (clears flags, odd-frame cycle skip)

### Key Registers

| Address | Name | Purpose |
|---------|------|---------|
| $2000 | PPUCTRL | NMI enable, sprite size, pattern tables |
| $2001 | PPUMASK | Rendering enable, clipping |
| $2002 | PPUSTATUS | VBlank flag, sprite 0 hit |
| $2005 | PPUSCROLL | Scroll position (write x2) |
| $2006 | PPUADDR | VRAM address (write x2) |
| $2007 | PPUDATA | VRAM read/write |
---

---

## PPU ↔ Mapper Contract (Core Design)

The PPU avoids mapper ID checks and relies on capability flags plus guarded hook calls. Each mapper declares **what behaviors it supports** through capability flags. This design prevents common emulator pitfalls:

- Fixing one mapper breaking another
- Hidden method-presence heuristics
- Mapper ID checks scattered through the PPU

Instead, each mapper becomes **self‑contained**, and the PPU becomes **stable infrastructure**.

### Behavioral Capability Flags

| Capability Flag | Meaning | Required Method(s) |
|----------------|--------|--------------------|
| `hasScanlineIrq` | A12-based IRQ clocking | `clockScanline()` |
| `hasNametableOverride` | Mapper owns nametable reads/writes (ExRAM/fill) | `readNametable(addr, context)`, `setNametableByte(addr, val)` |
| `hasPerTileAttributes` | ExRAM provides per-tile palette bits | `getExtendedAttributeByte(x, y)` |

**Rule:** If a capability flag is `true`, the corresponding method **must exist**.

---

### Core Mapper Hooks

- `ppuRead(addr, context)` for CHR ROM/RAM fetches (`bg`, `sprite`, `attribute`).
- `ppuWrite(addr, value)` for CHR-RAM writes.
- `onPpuRegisterWrite(addr, value)` observes `$2000/$2001/$2006` for MMC5 state tracking.
- `onEndScanline(scanline)` is called at cycle 4 for scanline-based logic (MMC5 timing).
- `cpuClock(cycles)` and `onNmiVectorRead()` provide cycle and NMI-vector timing (MMC5).

---

### Context-Aware PPU Reads (MMC5)

MMC5 relies on the PPU passing context into mapper hooks so it can select the correct CHR bank and attribute source:

- `readNametable(addr, 'tile' | 'attribute' | 'cpu')`
- `ppuRead(addr, 'bg' | 'sprite')`

When `hasPerTileAttributes` is set, the PPU uses `getExtendedAttributeByte()` to pull palette bits from ExRAM. This keeps the PPU mapper-agnostic while allowing MMC5 split-screen and ExRAM modes.

---

### Sprite 0 Hit Detection

The sprite 0 hit flag is set when an opaque pixel of sprite 0 overlaps an opaque background pixel. This is used by games for split-screen effects.

```javascript
// Checked during scanline rendering
if (sprite0_pixel_opaque && background_pixel_opaque) {
  setStatusFlag(STATUS_SPRITE0HIT, true);
}
```

### MMC2/MMC4 Latch Triggering

For mappers with CHR latches (MMC2, MMC4), latch updates happen inside the mapper `ppuRead()` based on the **actual pattern fetch address**. Because the PPU calls `ppuRead()` for every background and sprite fetch (both bitplanes), latch timing matches real hardware.

---

### MMC2 / MMC4 CHR Latch Accuracy

MMC2/MMC4 latch switching is triggered by **specific pattern fetch addresses**:

- `$0FD8-$0FDF` and `$0FE8-$0FEF` (low pattern table)
- `$1FD8-$1FDF` and `$1FE8-$1FEF` (high pattern table)

To correctly emulate this behavior, the PPU computes **real pattern fetch addresses** for both bitplanes:

- `tileBase + (tileIndex << 4) + fineY`
- `tileBase + (tileIndex << 4) + fineY + 8`

This is critical for games like **Mike Tyson’s Punch‑Out!**, which rely on mid‑frame CHR bank switching for large animated sprites.

---

## APU (Audio Processing Unit)

### Channel Overview

| Channel | Type | Description |
|---------|------|-------------|
| Square 1 | Pulse | Variable duty cycle (12.5%, 25%, 50%, 75%) |
| Square 2 | Pulse | Same as Square 1 |
| Triangle | Triangle | Fixed waveform, no volume control |
| Noise | Noise | Pseudo-random, two modes |
| DMC | Sample | Delta-modulation playback |
---


### Frame Counter

The APU frame counter drives envelope, length counter, and sweep updates:

```
Mode 0 (4-step):  Clocks at frames 1, 2, 3, 4 (generates IRQ at 4)
Mode 1 (5-step):  Clocks at frames 1, 2, 3, 5 (no IRQ)
```

### Sample Generation

The `sample()` method mixes all channels using the NES's non-linear mixing:

```javascript
// Lookup tables for accurate mixing
square_table[n] = 95.52 / (8128.0 / n + 100)
tnd_table[n] = 163.67 / (24329.0 / n + 100)
```

DC offset removal is applied to prevent speaker damage from sustained offsets.

AI-NES builds 16x resolution DAC tables, applies stereo panning weights per channel, and removes DC separately for left/right output.

---

## Memory Mappers

### Mapper 4 (MMC3)

Used by many popular games including Super Mario Bros. 2, Super Mario Bros. 3, and Kirby's Adventure.

**PRG Banking:**
- 8KB banks switchable at $8000 and $A000
- $C000 and $E000 can be fixed to last banks or swapped

**CHR Banking:**
- 2KB banks at $0000/$0800 or $1000/$1800
- 1KB banks at $1000-$1C00 or $0000-$0C00

**IRQ Counter:**

MMC3 IRQs are driven by **A12 rising edges**, not by generic scanline counters.

**Implementation Notes:**

- The PPU calls `checkA12(addr)` on pattern fetches.
- Rising edges are filtered (A12 must be low long enough) before clocking.
- IRQs are isolated to mappers that declare `hasScanlineIrq`.

This prevents MMC3 timing logic from affecting other mappers.

---

```javascript
checkA12(addr) {
  if (this.nes.mmap && this.nes.mmap.hasScanlineIrq) {
    const a12 = (addr >> 12) & 1;
    const currentScanline = this.scanline;
    const currentCycle = this.cycle;
    if (a12 === 1 && this.ppuA12Prev === 0) {
      const cyclesSinceHigh = (currentScanline === this.lastA12HighScanline)
        ? (currentCycle - this.lastA12HighCycle)
        : 1000;
      // Filter: A12 must be low long enough to count as a clock
      if (cyclesSinceHigh > 12) {
        this.nes.mmap.clockScanline();
      }
    }
    if (a12 === 1) {
      this.lastA12HighScanline = currentScanline;
      this.lastA12HighCycle = currentCycle;
    }
    this.ppuA12Prev = a12;
  }
}
```
---

### Mapper 9 (MMC2)

Used exclusively by Punch-Out!! Features unique CHR latches.

**Latch Mechanism:**

MMC2 latch switching is triggered by **specific pattern fetch addresses**:
- `$0FD8-$0FDF` and `$0FE8-$0FEF` (low pattern table)
- `$1FD8-$1FDF` and `$1FE8-$1FEF` (high pattern table)

To correctly emulate this behavior, the mapper watches the actual fetch addresses inside `ppuRead()`, and the PPU supplies real pattern addresses for both bitplanes.

Two latches control CHR bank selection. Latches change state when specific tiles ($FD or $FE) are fetched:

**Why This Matters:**

This is critical for games like **Mike Tyson's Punch‑Out!!**, which rely on mid‑frame CHR bank switching for large animated sprites. The latch triggers mid-frame to swap CHR banks, creating smooth animation without CPU intervention.

---

```javascript
ppuRead(address) {
  if (address < 0x2000) {
    const page = (address >> 12) & 1;
    if (page === 0) {
      if (address >= 0x0FD8 && address <= 0x0FDF) this.latch0 = 0xFD;
      else if (address >= 0x0FE8 && address <= 0x0FEF) this.latch0 = 0xFE;
    } else {
      if (address >= 0x1FD8 && address <= 0x1FDF) this.latch1 = 0xFD;
      else if (address >= 0x1FE8 && address <= 0x1FEF) this.latch1 = 0xFE;
    }
    // Select bank based on latch values...
  }
  return null;
}
```
---

### Mapper 10 (MMC4)

Similar to MMC2 but with 16KB PRG banking instead of 8KB. Used by Fire Emblem and Famicom Wars.

---

### Mapper 5 (MMC5)

MMC5 introduces advanced features:

- Extended nametable mapping (ExRAM)
- Fill‑mode backgrounds
- Split‑screen scrolling
- Separate BG and sprite CHR modes (A13)
- MMC5 expansion audio mixed into output (pulse + PCM; PCM IRQs partially implemented, read-mode IRQs not emulated)

These features are enabled through capability flags:

- `hasNametableOverride`
- `hasPerTileAttributes`

Additional MMC5 behavior is wired through hooks like `ppuRead()` context, `onPpuRegisterWrite()`, `onEndScanline()`, and `cpuClock()`.

The PPU remains mapper‑agnostic while still supporting MMC5's complexity.

---

### Mapper 69 (Sunsoft FME-7 / Sunsoft 5B)

Mapper 69 provides:

- 8KB PRG bank switching ($8000-$DFFF) with fixed last bank
- 1KB CHR bank switching
- Banked RAM/ROM mapping at $6000-$7FFF
- 16-bit CPU-cycle IRQ counter
- Sunsoft 5B audio registers tracked (audio not mixed)

---

## Audio System

### AudioWorklet Architecture

```
┌─────────────────┐         postMessage          ┌─────────────────┐
│  Main Thread    │ ───────────────────────────▶ │  Audio Thread   │
│                 │                              │                 │
│  NES.frame()    │     { type: 'samples',       │  NESAudioProc   │
│       │         │       left: Float32[],       │       │         │
│       ▼         │       right: Float32[] }     │       ▼         │
│  onAudioSample  │                              │  Ring Buffer    │
│  (2048 batch)   │                              │  (8192 samples) │
│       │         │                              │       │         │
│       ▼         │                              │       ▼         │
│  flushAudio()   │                              │  process()      │
│                 │                              │  (128 samples)  │
└─────────────────┘                              └─────────────────┘
```
---

### Expansion Audio Mixing

Expansion audio sources (such as MMC5) register with the APU and are clocked alongside native channels. The APU sums expansion output into the stereo mix before DC removal, allowing mapper-specific audio without coupling mapper logic to the APU core.

---

### Ring Buffer Implementation

The worklet uses a power-of-2 sized ring buffer for efficient wrapping:

```javascript
this.bufferSize = 8192;
this.bufferMask = this.bufferSize - 1;

// Write (main thread sends samples)
this.samplesL[this.writeIndex] = sample;
this.writeIndex = (this.writeIndex + 1) & this.bufferMask;

// Read (audio thread consumes)
output[i] = this.samplesL[this.readIndex];
this.readIndex = (this.readIndex + 1) & this.bufferMask;

// Available samples
available = (this.writeIndex - this.readIndex) & this.bufferMask;
```
---

### Underrun Handling

When the buffer runs dry, the worklet fades to silence to avoid clicks:

```javascript
if (i < available) {
  lastL = outputL[i] = this.samplesL[this.readIndex++];
} else {
  const fade = 1 - ((i - available) / (len - available));
  outputL[i] = lastL * fade;
}
```
---

### Fallback to ScriptProcessor

For browsers without AudioWorklet, a deprecated but functional ScriptProcessor is used:

```javascript
scriptProcessor = audioCtx.createScriptProcessor(512, 0, 2);
scriptProcessor.onaudioprocess = (e) => {
  // Read directly from the fallback ring buffer
  for (let i = 0; i < len; i++) {
    outL[i] = fallbackL[fallbackRead];
    fallbackRead = (fallbackRead + 1) & AUDIO_BUFFER_MASK;
  }
};
```

The AudioContext sample rate is used to set `nes.opts.sampleRate`, so the PAPU generates samples at the hardware-backed rate.

---

## Save State System

The save state system enables saving and restoring the complete emulator state.

### Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│                    nes-save-states.js                      │
├────────────────────────────────────────────────────────────┤
│  initSaveStates(nes, logger)  ←── Initialize with NES ref  │
│           │                                                │
│           ▼                                                │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │  saveState(n)   │    │  loadState(n)   │                │
│  │       │         │    │       │         │                │
│  │       ▼         │    │       ▼         │                │
│  │  nes.toJSON()   │    │  nes.fromJSON() │                │
│  │       │         │    │       ▲         │                │
│  │       ▼         │    │       │         │                │
│  │  localStorage   │───▶│  localStorage   │                │
│  └─────────────────┘    └─────────────────┘                │
│                                                            │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │  quickSave()    │    │  quickLoad()    │                │
│  │       │         │    │       │         │                │
│  │       ▼         │    │       ▼         │                │
│  │  Memory Only    │◀──▶│  Memory Only    │                │
│  └─────────────────┘    └─────────────────┘                │
└────────────────────────────────────────────────────────────┘
```
---

### State Serialization

Each component implements `toJSON()` and `fromJSON()` methods using the `JSON_PROPERTIES` pattern from `utils.js`:

```javascript
// Example from cpu.js
static JSON_PROPERTIES = [
  "mem",              // 64KB RAM
  "cyclesToHalt",
  "irqRequested",
  "irqType",
  "REG_ACC",          // Accumulator
  "REG_X",            // X Register
  "REG_Y",            // Y Register
  "REG_SP",           // Stack Pointer
  "REG_PC",           // Program Counter
  "REG_STATUS",       // Status Register
  "F_CARRY",          // Flags...
  "F_ZERO",
  // ... etc
];

toJSON() {
  return toJSON(this);  // utils.js helper
}

fromJSON(s) {
  fromJSON(this, s);    // utils.js helper
}
```
---

### Save State Format

```javascript
{
  version: 1,                    // Format version for future compatibility
  timestamp: 1702500000000,      // Unix timestamp
  romHash: "a1b2c3d4",          // Hash of first 1KB of ROM (for validation)
  data: {
    cpu: { mem: [...], REG_PC: 0x8000, ... },
    ppu: { vramMem: [...], scanline: 0, ... },
    papu: { square1: {...}, triangle: {...}, ... },
    mmap: { /* mapper-specific state */ }
  }
}
```
---

### Storage Locations

| Type | Storage | Key Format | Persistence |
|------|---------|------------|-------------|
| Slot saves | localStorage | `nes_savestate_0` - `nes_savestate_9` | Permanent |
| Quick save | Memory | JavaScript variable | Session only |
| Export | File | `savestate_slot0.json` | User manages |

### ROM Hash Verification

A simple hash of the first 1KB of ROM data identifies which game the save belongs to:

```javascript
function getRomHash() {
  if (!nes.romData) return 'unknown';
  
  let hash = 0;
  const len = Math.min(1024, nes.romData.length);
  for (let i = 0; i < len; i++) {
    hash = ((hash << 5) - hash) + nes.romData[i];
    hash |= 0;  // Convert to 32-bit integer
  }
  return hash.toString(16);
}
```
---

Save state loads are rejected when the ROM hash or save state version does not match the current ROM.

### Keyboard Shortcut Handler

```javascript
function handleSaveStateKeys(e) {
  // Ignore if typing
  if (document.activeElement.tagName === 'INPUT' || 
      document.activeElement.tagName === 'TEXTAREA') {
    return;
  }
  
  if (e.keyCode === 116) {        // F5 = Quick Save
    e.preventDefault();
    quickSave();
  }
  else if (e.keyCode === 119) {   // F8 = Quick Load
    e.preventDefault();
    quickLoad();
  }
  else if (e.shiftKey && e.keyCode >= 49 && e.keyCode <= 57) {
    e.preventDefault();
    saveState(e.keyCode - 49);    // Shift+1-9 = Save to slot
  }
  else if (e.keyCode >= 49 && e.keyCode <= 57) {
    e.preventDefault();
    loadState(e.keyCode - 49);    // 1-9 = Load from slot
  }
}
```

### Integration Example

```javascript
// nes-init.js
import { initSaveStates } from './index.js';

async function nesBoot(romData) {
  // ... audio init, etc ...
  
  nes.loadROM(romData); // Uint8Array
  
  // Initialize save states after ROM is loaded
  initSaveStates(nes, logStatus);
  
  // ... start emulation ...
}
```

---

## Timing and Synchronization

### NES Timing Constants

| Component | Frequency | Notes |
|-----------|-----------|-------|
| CPU | 1.789773 MHz | NTSC master clock / 12 |
| PPU | 5.369318 MHz | 3x CPU clock |
| APU Frame | 240 Hz | Controls envelope/sweep |
---

### Frame Timing

At 60 FPS (NTSC):
- ~29,780 CPU cycles per frame
- ~89,342 PPU cycles per frame
- Audio samples per frame = `sampleRate / 60` (about 800 at 48kHz)

Sub-instruction sync comes from `cpu.cycleOffset` and `nes.catchUp()`, which advance the PPU to the exact dot before register or mapper access, then skip those cycles in the main loop.
---

### requestAnimationFrame Loop

The emulator runs one NES frame per browser animation frame:

```javascript
function onAnimationFrame() {
  requestAnimationFrame(onAnimationFrame);
  if (!emulationRunning) return;
  
  const speed = fastForward ? 4 : 1;
  for (let i = 0; i < speed; i++) {
    nes.frame();      // Run one NES frame
  }
  flushAudio();       // Send accumulated samples to worklet
  
  // Convert 0xRRGGBB framebuffer to RGBA
  for (let i = 0; i < FRAMEBUFFER_SIZE; i++) {
    const rgb = framebufferU32[i];
    const base = i * 4;
    imageData.data[base + 0] = (rgb >> 16) & 0xFF;
    imageData.data[base + 1] = (rgb >> 8) & 0xFF;
    imageData.data[base + 2] = rgb & 0xFF;
    imageData.data[base + 3] = 0xFF;
  }
  canvasCtx.putImageData(imageData, 0, 0);
}
```

This ties emulation to the display refresh rate (~60Hz), which closely matches NTSC timing.

---

## Performance Optimizations

### CPU Optimizations

1. **Pre-computed opcode table** — Built once at module load
2. **Typed arrays** — `Uint8Array` for memory
3. **Bitwise operations** — Fast flag manipulation
4. **Local variable caching** — Avoid repeated property access in hot loops
---

### PPU Optimizations

1. **Scanline/pixel rendering** — Only render during visible scanlines
2. **Shift-register pipeline** — Constant-time pixel decode per dot
3. **Uint32Array framebuffer** — Fast 32-bit writes for RGB output
---

### Memory Layout

```javascript
// Framebuffer holds 0xRRGGBB pixels, converted to RGBA each frame
const framebufferU32 = new Uint32Array(FRAMEBUFFER_SIZE);
const imageData = canvasCtx.getImageData(0, 0, 256, 240);
```

---

## Why Capability‑Driven Design Matters

This design prevents common emulator pitfalls:

- Fixing one mapper breaking another
- Hidden method-presence heuristics
- Mapper ID checks scattered through the PPU

Instead, each mapper becomes **self‑contained**, and the PPU becomes **stable infrastructure**.

---

## Debugging Guide

### F9 Snapshot

The debug module (see `debug/debug.js`) binds to F9 by default. It prints a snapshot of PPU state, mapper registers, CHR samples, and MMC5 audio registers when a Mapper 005 ROM is loaded. This is useful for comparing against Mesen-style reference dumps.

### Common Issues

**Black screen:**
- Check mapper support for the ROM
- Verify ROM header is valid (starts with "NES\x1a")

**Garbled graphics:**
- Almost always CHR banking or latch timing
- Verify mapper `ppuRead()` address handling for latch ranges
- Verify mirroring mode is correct

**No audio:**
- Check browser console for AudioContext errors
- Ensure user interaction before audio init (browser autoplay policy)

**Status Bar Issues (MMC3):**
- IRQ counter timing issue
- Verify A12 rising edges
- Check IRQ counter reload timing

**Split screen issues (MMC5):**
- Verify `onEndScanline()` is running and IRQ/vsplit state changes are correct
- Ensure ExRAM and per-tile attributes are in the expected mode

**Save state not loading:**
- Check browser console for JSON parse errors
- Version/ROM mismatches hard-fail (ensure same ROM and save state version)
- localStorage may be full — clear old saves
---


### Useful Console Commands

```javascript
// Access emulator internals
nes.cpu.REG_PC.toString(16)  // Current program counter
nes.ppu.scanline             // Current scanline
nes.rom.mapperType           // Loaded mapper number
nes.mmap.irqCounter          // MMC3 IRQ counter value

// Save state debugging
listStates()                 // Show all save slots (if exported in your integration)
localStorage                 // View raw storage
```

---

## References

- [NESDev Wiki](https://www.nesdev.org/wiki/) — Comprehensive NES hardware documentation
- [6502 Instruction Reference](https://www.masswerk.at/6502/6502_instruction_set.html)
- [MMC2 Documentation](https://www.nesdev.org/wiki/MMC2)
- [MMC3 Documentation](https://www.nesdev.org/wiki/MMC3)
- [MMC5 Documentation](https://www.nesdev.org/wiki/MMC5)

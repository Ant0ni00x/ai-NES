# ai-NES Technical Documentation

This document covers the internal architecture and key implementation details of the ai-NES emulator, with emphasis on **correct hardware modeling** and the **capability-driven mapper system**.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [CPU (2A03 / 6502-derived)](#cpu-2a03--6502-derived)
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
│   (2A03)    │  (Graphics) │   (Audio)   │ (Bank Switch) │
└─────────────┴─────────────┴─────────────┴───────────────┘
```

The **NES class** orchestrates timing and wiring. Each component is isolated and communicates through explicit, well‑defined interfaces.

### Frame Execution Flow

```javascript
// nes.js - frame() method
1. PPU starts frame (startFrame)
2. Loop until ppu.frameComplete:
   a. CPU executes instruction (cpu.step), returns cycle count
   b. CPU internally clocks PPU + mapper per cycle via _startCycle()/_endCycle()
   c. APU clocks for the returned cycles (papu.clockFrameCounter)
3. PPU signals frame completion via sendFrame()
```

The CPU is the timing anchor. Each CPU memory access calls `_startCycle()` which increments cycle counters, clocks the PPU (`ppu.clockCpuCycle()`), and clocks mapper hooks (`mapper.step(1)` and `mapper.cpuClock(1)`). `_endCycle()` updates NMI/IRQ edge and level state.

`NES.catchUp()` is intentionally a no-op — the old external catch-up path has been replaced by the CPU's internal per-cycle pipeline.

---

## CPU (2A03 / 6502-derived)

Source: `src/cpu.js`

### Implementation Highlights

- **Typed Array Memory**: `Uint8Array(0x800)` for internal RAM (`ram`), mirrored to `Uint8Array(0x10000)` (`mem`) for debug compatibility
- **Method-Reference Opcode Table**: `_buildOpTable()` produces a 256-element array of bound instruction handler functions (not packed integers)
- **Address Mode Table**: `_buildAddrModeTable()` produces a parallel 256-element array of addressing mode enum values
- **Undocumented Opcodes**: Extensive unofficial instruction support (SLO, RLA, SRE, RRA, SAX, LAX, DCP, ISB, AAC, ASR, ARR, ATX, AXS, SHY, SHX, SHAA, SHAZ, TAS, ANE, LAS, HLT)
- **Open Bus Latch**: `dataBus` tracks the last value read or written on the data bus
- **Region-Aware Clock Divider**: NTSC=6, PAL=8, Dendy=7/8 (`startClockCount`/`endClockCount`)

### Opcode Dispatch

Each opcode is dispatched through two pre-built 16×16 lookup tables flattened to 256 entries:

```javascript
// Instruction handler table — maps opcode byte to a bound method
this.opTable = this._buildOpTable();
// Address mode table — maps opcode byte to an AM enum value (0–17)
this.addrModeTable = this._buildAddrModeTable();
```

### Addressing Modes

| Enum | Code | Example | Description |
|------|------|---------|-------------|
| `AM.Imm` | 3 | `LDA #$44` | Value in next byte |
| `AM.Zero` | 5 | `LDA $44` | Address in zero page |
| `AM.ZeroX` | 6 | `LDA $44,X` | ZP + X register |
| `AM.ZeroY` | 7 | `STX $44,Y` | ZP + Y register |
| `AM.Abs` | 12 | `LDA $4400` | 16-bit address |
| `AM.AbsX` | 13 | `LDA $4400,X` | Abs + X (page cross +1 cycle) |
| `AM.AbsXW` | 14 | `STA $4400,X` | Abs + X (always performs dummy read) |
| `AM.AbsY` | 15 | `LDA $4400,Y` | Abs + Y (page cross +1 cycle) |
| `AM.AbsYW` | 16 | `STA $4400,Y` | Abs + Y (always performs dummy read) |
| `AM.IndX` | 9 | `LDA ($44,X)` | Pre-indexed indirect |
| `AM.IndY` | 10 | `LDA ($44),Y` | Post-indexed indirect |
| `AM.IndYW` | 11 | `STA ($44),Y` | Post-indexed indirect (always dummy read) |
| `AM.Ind` | 8 | `JMP ($4400)` | Indirect (JMP only) |
| `AM.Rel` | 4 | `BEQ $44` | Relative branch offset |
| `AM.Acc` | 1 | `ASL A` | Accumulator |
| `AM.Imp` | 2 | `CLC` | Implied |

The `*W` variants (AbsXW, AbsYW, IndYW) are used by write instructions to always perform a dummy read on the un-adjusted address, matching real hardware behavior.

### IRQ Handling

Four IRQ source flags are OR'd into the interrupt mask:

```javascript
this.IRQ_NMI = 1;       // VBlank NMI from PPU
this.IRQ_NORMAL = 2;    // Mapper IRQs (e.g., MMC3 scanline counter)
this.IRQ_DMC = 4;       // DMC sample playback IRQ
this.IRQ_EXTERNAL = 8;  // External mapper IRQs (e.g., FME-7 cycle counter)
```

NMI uses edge detection (checked at end of each CPU cycle). IRQ uses level detection. Reset is handled by dedicated `powerOn()` and `reset()` methods, not through the IRQ mask.

### Cycle Pipeline

Each memory access goes through cycle boundaries:

- `_startCycle()`: increments CPU cycle counters, clocks PPU (`ppu.clockCpuCycle()`), clocks mapper (`mapper.step(1)` and `mapper.cpuClock(1)`)
- `_endCycle()`: updates NMI/IRQ edge/level state

### DMA

- `$4014` OAM DMA is initiated by CPU IO write and executed by `PPU.doDMA()`
- DMA stalls CPU using `cpu.haltCycles(513 + parity)`

### Reset / Power-On

- `powerOn()` initializes RAM pattern (`hardware`, `all_zero`, `all_ff`, `random`) and runs startup cycles (8-cycle startup delay before first instruction)
- `reset()` is soft reset behavior (preserves A/X/Y, decrements SP by 3, reloads reset vector)

---

## PPU (Picture Processing Unit)

Source: `src/ppu.js`

### Rendering Pipeline

The PPU renders 262 scanlines per frame (NTSC):
- Scanlines 0–239: Visible frame (240 lines)
- Scanline 240: Post-render (idle)
- Scanlines 241–260: VBlank (NMI asserted at scanline 241)
- Scanline 261 (internally -1): Pre-render (clears flags, odd-frame cycle skip on NTSC)

### Region Timing

`PPU.setRegion(region)` configures:

- `ntsc`: 3 PPU steps per CPU cycle, odd-frame skip enabled
- `pal`: 16/5 PPU steps per CPU cycle, no odd-frame skip
- `dendy`: 3 PPU steps per CPU cycle, Dendy scanline model

`PPU.clockCpuCycle()` uses accumulator-based stepping for non-integer ratios.

### Key Registers

| Address | Name | Purpose |
|---------|------|---------|
| $2000 | PPUCTRL | NMI enable, sprite size, pattern tables |
| $2001 | PPUMASK | Rendering enable, clipping |
| $2002 | PPUSTATUS | VBlank flag, sprite 0 hit |
| $2003 | OAMADDR | OAM address |
| $2004 | OAMDATA | OAM data read/write |
| $2005 | PPUSCROLL | Scroll position (write x2) |
| $2006 | PPUADDR | VRAM address (write x2, 3-cycle delayed update) |
| $2007 | PPUDATA | VRAM read/write |

### VRAM and Mapper-Visible Bus Addressing

All VRAM reads/writes route through:

- `setBusAddress(addr)` — updates bus address, calls mapper address hook when enabled, applies fallback A12 tracking path when needed
- `readVram(addr, context)` / `writeVram(addr, value, context)`

Context labels (`bg`, `sprite`, `tile`, `attribute`, `cpu`) are forwarded to mapper hooks.

### NMI Behavior

- `beginVBlank()` sets VBlank status and updates NMI state
- Delayed NMI assertion modeled via `nmiDelay`
- CPU line is asserted through `cpu.setNmiFlag()`

---

## PPU ↔ Mapper Contract (Core Design)

The PPU avoids mapper ID checks and relies on capability flags plus guarded hook calls. Each mapper declares **what behaviors it supports** through capability flags. This design prevents common emulator pitfalls:

- Fixing one mapper breaking another
- Hidden method-presence heuristics
- Mapper ID checks scattered through the PPU

Instead, each mapper becomes **self‑contained**, and the PPU becomes **stable infrastructure**.

### Behavioral Capability Flags

| Capability Flag | Meaning | Gate Mechanism |
|----------------|--------|----------------|
| `hasVramAddressHook` | Mapper needs per-address bus notifications | `notifyVramAddressChange(addr, context)` — primary timing-critical gate |
| `hasScanlineIrq` | Fallback A12 scanline-counter path | `scanlineCounter(context)` — used when mapper lacks dedicated VRAM hook |
| `hasChrLatch` | PPU bus snooping for latch-based CHR switching | Mapper watches addresses via VRAM hook |
| `hasNametableOverride` | Mapper owns nametable reads/writes (ExRAM/fill) | PPU checks `typeof mapper.readNametable === "function"` |
| `hasPpuA13ChrSwitch` | A13-based CHR bank selection | Mapper uses A13 to switch BG vs sprite CHR banks |

**Rule:** If a capability flag is `true`, the corresponding method **must exist**. In practice, the PPU also uses method-presence checks (`typeof mapper.readNametable === "function"`) as a guard for nametable overrides.

---

### Core Mapper Hooks

Defined in `src/mappers/mapper-base.js`:

**CPU Bus:**
- `cpuRead(addr)` — CPU read interception
- `cpuWrite(addr, value)` — CPU write interception (register writes, bank switching)

**PPU Bus:**
- `ppuRead(addr, context, mapperContext)` — CHR ROM/RAM fetches (`bg`, `sprite`, `attribute`, `cpu`)
- `ppuWrite(addr, value, context, mapperContext)` — CHR-RAM writes
- `readNametable(addr, context, mapperContext)` — nametable read override (MMC5 ExRAM/fill)
- `setNametableByte(addr, value, mapperContext)` — nametable write override

**Timing/Event Hooks:**
- `notifyVramAddressChange(addr, mapperContext)` — per-address bus change notifications (primary A12 IRQ path for MMC3/MMC2/MMC4)
- `onPpuRegisterWrite(addr, value, mapperContext)` — observes `$2000/$2001/$2006` writes for mapper state tracking
- `onStartScanline(scanline, renderingEnabled, mapperContext)` — called at scanline start
- `onEndScanline(scanline, mapperContext)` — called at cycle 4 for scanline-based logic (MMC5 timing)
- `processCpuClock()` via `cpuClock(cycles)` — per-CPU-cycle timing hook
- `onNmiVectorRead()` — NMI vector timing hook (MMC5)

---

### A12 / IRQ Model

Mapper 4/47 use `notifyVramAddressChange(...)` with PPU clock context for A12 edge-qualified IRQ timing. These mappers declare `enableVramAddressHook() { return true; }` which sets `hasVramAddressHook = true` during mapper initialization.

The PPU retains a fallback A12 tracking path for mappers that use `hasScanlineIrq` + `scanlineCounter(...)` instead of the dedicated VRAM address hook:

```javascript
_checkA12Fallback(addr) {
  const mapper = this.nes.mmap;
  if (!mapper || mapper.hasVramAddressHook) return;
  if (!mapper.hasScanlineIrq) return;

  const a12 = (addr >> 12) & 0x01;
  if (a12 === 1 && this.ppuA12Prev === 0) {
    let cyclesSinceHigh = 1000;
    if (this.scanline === this.lastA12HighScanline) {
      cyclesSinceHigh = this.cycle - this.lastA12HighCycle;
    }
    if (cyclesSinceHigh > 12) {
      mapper.scanlineCounter(this.getMapperContext());
    }
  }
  if (a12 === 1) {
    this.lastA12HighScanline = this.scanline;
    this.lastA12HighCycle = this.cycle;
  }
  this.ppuA12Prev = a12;
}
```

---

### Sprite 0 Hit Detection

The sprite 0 hit flag is set when an opaque pixel of sprite 0 overlaps an opaque background pixel. This is used by games for split-screen effects.

```javascript
// Checked during scanline rendering
if (
  spriteIndex === 0 &&         // Sprite 0
  bgPixelOpaque &&             // Background pixel not transparent
  sprite0Visible &&            // Sprite 0 present on this scanline
  cycle !== 256 &&             // Not at pixel 256 (hardware quirk)
  bgRenderingEnabled &&        // Background rendering enabled
  !(status & SPRITE0_HIT) &&  // Not already flagged
  cycle > leftColumnClip       // Not in left-margin clip region
) {
  status |= STATUS_SPRITE0_HIT;
}
```

### MMC2/MMC4 Latch Triggering

For mappers with CHR latches (MMC2, MMC4), latch updates happen inside the mapper's `notifyVramAddressChange()` method based on the **actual VRAM bus address**. Both mappers declare `enableVramAddressHook() { return true; }` to receive per-address notifications.

Latch-triggering address ranges:
- `$0FD8–$0FDF` and `$0FE8–$0FEF` (low pattern table)
- `$1FD8–$1FDF` and `$1FE8–$1FEF` (high pattern table)

The PPU computes **real pattern fetch addresses** for both bitplanes:

- `tileBase + (tileIndex << 4) + fineY` (low bitplane)
- `tileBase + (tileIndex << 4) + fineY + 8` (high bitplane)

This is critical for games like **Mike Tyson's Punch‑Out!!**, which rely on mid‑frame CHR bank switching for large animated sprites.

---

## APU (Audio Processing Unit)

Source: `src/apu.js`

### Channel Overview

| Channel | Type | Class | Description |
|---------|------|-------|-------------|
| Square 1 | Pulse | `ChannelSquare` | Variable duty cycle (12.5%, 25%, 50%, 75%) with sweep |
| Square 2 | Pulse | `ChannelSquare` | Same as Square 1 |
| Triangle | Triangle | `ChannelTriangle` | Fixed waveform (32-step sequence), no volume control |
| Noise | Noise | `ChannelNoise` | 15-bit shift register, two modes (normal/tight) |
| DMC | Sample | `ChannelDM` | Delta-modulation playback with IRQ support |

### Frame Counter

The APU frame counter drives envelope, length counter, and sweep updates:

```
Mode 0 (4-step):  Clocks at cycles 7457, 14913, 22371, 29829
                   Quarter frame + Half frame pattern; generates IRQ at step 4
Mode 1 (5-step):  Clocks at cycles 7457, 14913, 22371, 29829, 37281
                   No IRQ generated
```

### Sample Generation

The `sample()` method mixes all channels using the NES's non-linear mixing with 16x resolution DAC lookup tables:

```javascript
// Square table: 31 * 16 = 496 entries
buildSquareTable() {
  const table = new Float32Array(31 << 4);
  for (let i = 0; i < table.length; i++) {
    const n = i * 0.0625; // i / 16
    table[i] = n === 0 ? 0 : 95.52 / (8128.0 / n + 100);
  }
}

// TND table: 203 * 16 = 3248 entries
buildTndTable() {
  const table = new Float32Array(203 << 4);
  for (let i = 0; i < table.length; i++) {
    const n = i * 0.0625;
    table[i] = n === 0 ? 0 : 163.67 / (24329.0 / n + 100);
  }
}
```

### Stereo Panning

Per-channel stereo panning weights allow positioning each channel in the stereo field:

```javascript
this.panning = {
  square1:   { l: 0.5, r: 0.5 },
  square2:   { l: 0.5, r: 0.5 },
  triangle:  { l: 0.5, r: 0.5 },
  noise:     { l: 0.5, r: 0.5 },
  dmc:       { l: 0.5, r: 0.5 },
  expansion: { l: 0.5, r: 0.5 },
};
```

TND mixing applies weighted channel contributions: `tri * 3 + noi * 2 + dmc * 1`.

### DC Offset Removal

A single-pole high-pass filter with 10 Hz cutoff removes sustained DC offsets separately for left/right output:

```javascript
this.dcLeft += (sampleL - this.dcLeft) * this.dcAlpha;
this.dcRight += (sampleR - this.dcRight) * this.dcAlpha;
sampleL -= this.dcLeft;
sampleR -= this.dcRight;
```

### Expansion Audio Bus

Mappers register expansion audio sources through the APU:

- `papu.setExpansionAudioSource(name, source)` — registers a named audio source
- `papu.clearExpansionAudioSources()` — removes all expansion sources
- Sources implement `getSample()` and optionally `clock(cycles)`

Expansion sources are clocked each CPU cycle and mixed into stereo output with panning weights before DC removal.

Current implementations:
- **Mapper 69 (Sunsoft 5B)**: Active synthesis path — 3-channel tone generator with envelope, returns real audio samples
- **Mapper 5 (MMC5)**: Register state tracked; `getSample()` currently returns 0 (audio stub)

---

## Memory Mappers

Sources: `src/mappers/mapper-base.js`, `src/mappers/mapper-factory.js`

### Supported Mappers

| Mapper | Name | File | Key Features |
|--------|------|------|-------------|
| 0 | NROM | mapper000.js | Basic (no banking) |
| 1 | MMC1 (SxROM) | mapper001.js | Shift-register PRG/CHR banking |
| 2 | UxROM | mapper002.js | PRG banking only |
| 3 | CNROM | mapper003.js | CHR banking only |
| 4 | MMC3 | mapper004.js | A12-IRQ, advanced banking |
| 5 | MMC5 | mapper005.js | ExRAM, split-screen, expansion audio |
| 4:1 | MMC6 | mapper006.js | MMC3 variant with WRAM protect |
| 7 | AxROM | mapper007.js | PRG banking + 1-screen mirror |
| 9 | MMC2 | mapper009.js | Dual CHR latch (Punch-Out!!) |
| 10 | MMC4 | mapper010.js | Dual CHR latch (16KB PRG) |
| 11 | Color Dreams | mapper011.js | Simple PRG/CHR banking |
| 21 | VRC4 | mapper021.js | Konami expansion |
| 25 | VRC2/VRC4 | mapper025.js | Konami with IRQ |
| 34 | BNROM/NINA | mapper034.js | Submapper-aware (BNROM + NINA-001/002) |
| 47 | NES-QJ | mapper047.js | MMC3 extension |
| 66 | GxROM | mapper066.js | Simple PRG/CHR banking |
| 69 | FME-7/5B | mapper069.js | Sunsoft with expansion audio + IRQ |
| 79 | NINA-03/06 | mapper079.js | Simple PRG/CHR banking |
| 144 | — | (aliased to 11) | Color Dreams variant |

### BaseMapper Responsibilities

- Owns PRG/CHR/RAM address decoding and mapping tables
- Manages Save RAM / Work RAM / Mapper RAM / CHR RAM allocation
- Handles mirroring selection and nametable RAM routing (H/V/1-screen/4-screen)
- Provides register-range mapping and bus conflict handling controls

### Factory and Registration

`mapper-factory.js` supports:

- Mapper ID registration and submapper-specific registration (`mapperId:submapper`)
- Runtime capability checks (`isMapperSupported`)
- Legacy mapper-4 CRC32 compatibility path to force MMC6 class for known titles

---

### Mapper 4 (MMC3)

Used by many popular games including Super Mario Bros. 2, Super Mario Bros. 3, and Kirby's Adventure.

**PRG Banking:**
- 8KB banks switchable at $8000 and $A000
- $C000 and $E000 can be fixed to last banks or swapped

**CHR Banking:**
- 2KB banks at $0000/$0800 or $1000/$1800
- 1KB banks at $1000-$1C00 or $0000-$0C00

**IRQ Counter:**

MMC3 IRQs are driven by **A12 rising edges** via the VRAM address hook:

- The mapper declares `enableVramAddressHook() { return true; }`
- The PPU calls `notifyVramAddressChange(addr, context)` on every bus address change
- Mapper filters A12 rising edges (must be low long enough) before clocking the IRQ counter
- This avoids using the generic scanline counter fallback path

---

### Mapper 9 (MMC2)

Used exclusively by Punch-Out!! Features unique CHR latches.

**Latch Mechanism:**

MMC2 latch switching is triggered by **VRAM bus addresses** via `notifyVramAddressChange()`:

- `$0FD8–$0FDF` and `$0FE8–$0FEF` (low pattern table)
- `$1FD8–$1FDF` and `$1FE8–$1FEF` (high pattern table)

Two latches control CHR bank selection. Latches change state when specific tile pattern addresses ($FD or $FE range) appear on the bus, triggering mid-frame CHR bank switching for large animated sprites.

---

### Mapper 10 (MMC4)

Similar to MMC2 but with 16KB PRG banking instead of 8KB and 4KB CHR page size. Used by Fire Emblem and Famicom Wars. Same latch mechanism via VRAM address hook.

---

### Mapper 5 (MMC5)

MMC5 introduces advanced features:

- Extended nametable mapping (ExRAM)
- Fill-mode backgrounds
- Split-screen scrolling
- Separate BG and sprite CHR modes (A13-based)
- MMC5 expansion audio (register state tracked; audio output is currently a stub returning 0)

MMC5 provides `readNametable()` and `setNametableByte()` methods. The PPU detects these via method-presence checks (`typeof mapper.readNametable === "function"`) and delegates nametable reads/writes to the mapper when present.

Additional MMC5 behavior is wired through hooks: `ppuRead()` context, `onPpuRegisterWrite()`, `onEndScanline()`, and `processCpuClock()`.

---

### Mapper 69 (Sunsoft FME-7 / Sunsoft 5B)

Mapper 69 provides:

- 8KB PRG bank switching ($8000-$DFFF) with fixed last bank
- 1KB CHR bank switching
- Banked RAM/ROM mapping at $6000-$7FFF
- 16-bit CPU-cycle IRQ counter (via `processCpuClock()`)
- **Sunsoft 5B audio**: 3-channel tone generator with envelope, actively synthesized and mixed into APU output via the expansion audio bus

---

## Audio System

Source: `src/nes-init.js`

### AudioWorklet Architecture

```
┌─────────────────┐         postMessage          ┌─────────────────┐
│  Main Thread    │ ───────────────────────────▶ │  Audio Thread   │
│                 │                              │                 │
│  NES.frame()    │     { type: 'samples',       │  NESAudioProc   │
│       │         │       left: Float32[],       │       │         │
│       ▼         │       right: Float32[] }     │       ▼         │
│  onAudioSample  │                              │  Ring Buffer    │
│  (4096 batch)   │                              │  (8192 samples) │
│       │         │                              │       │         │
│       ▼         │                              │       ▼         │
│  flushAudio()   │                              │  process()      │
│                 │                              │  (128 samples)  │
└─────────────────┘                              └─────────────────┘
```

### Audio Constants

```javascript
AUDIO_BUFFER_SIZE      = 4096  // Samples per batch sent to worklet
AUDIO_RING_BUFFER_SIZE = 8192  // Worklet ring buffer (power of two)
AUDIO_TARGET_BUFFER_MS = 80    // Keep this much audio queued to avoid underruns
```

The AudioContext sample rate is used to configure the APU: `nes.papu.setSampleRate(audioCtx.sampleRate)`.

### Ring Buffer Implementation

The worklet uses a power-of-2 sized ring buffer for efficient wrapping:

```javascript
this.bufferSize = 8192;
this.bufferMask = this.bufferSize - 1;

// Write (main thread sends samples via postMessage)
this.samplesL[this.writeIndex] = sample;
this.writeIndex = (this.writeIndex + 1) & this.bufferMask;

// Read (audio thread consumes in process())
output[i] = this.samplesL[this.readIndex];
this.readIndex = (this.readIndex + 1) & this.bufferMask;

// Available samples
available = (this.writeIndex - this.readIndex) & this.bufferMask;
```

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

### Overrun Handling

When the write pointer catches up with the read pointer, the oldest unread sample is dropped:

```javascript
const nextIndex = (this.writeIndex + 1) & this.bufferMask;
if (nextIndex === this.readIndex) {
  this.readIndex = (this.readIndex + 1) & this.bufferMask; // Drop oldest
}
```

No ScriptProcessor fallback is present — the frontend is AudioWorklet-only.

---

## Save State System

Source: `src/nes-save-states.js`

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
│  │  Base64 Compress│    │  Base64 Decomp  │                │
│  │       │         │    │       │         │                │
│  │       ▼         │    │       ▼         │                │
│  │  localStorage   │───▶│  localStorage   │                │
│  └─────────────────┘    └─────────────────┘                │
│                                                            │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │  quickSave()    │    │  quickLoad()    │                │
│  │       │         │    │       │         │                │
│  │       ▼         │    │       ▼         │                │
│  │  Memory Only    │◀──▶│  Memory Only    │                │
│  │  (uncompressed) │    │  (uncompressed) │                │
│  └─────────────────┘    └─────────────────┘                │
└────────────────────────────────────────────────────────────┘
```

### Version Policy

Save states use **strict v3 format** only. All components (NES, CPU, PPU, PAPU, BaseMapper) enforce `stateVersion === 3` in their `fromJSON()` methods. Older versions are intentionally rejected with no backward compatibility path.

### State Serialization

Each component implements `toJSON()` and `fromJSON()` methods. The NES-level serialization wraps component state:

```javascript
// nes.js toJSON()
{
  stateVersion: 3,
  cpu: { stateVersion: 3, ram: [...], A, X, Y, SP, P, PC, dataBus, ... },
  ppu: { stateVersion: 3, vramMem: [...], palette: [...], scanline, cycle, v, t, x, w, ... },
  papu: { stateVersion: 3, ... },
  mmap: { /* mapper-specific state */ }
}
```

### Typed Array Compression

Typed arrays are compressed to tagged base64 objects for ~30–40% size reduction:

```javascript
{ __t__: 'u8',  __d__: '<base64>' }  // Uint8Array
{ __t__: 'i8',  __d__: '<base64>' }  // Int8Array
{ __t__: 'i32', __d__: '<base64>' }  // Int32Array
{ __t__: 'u32', __d__: '<base64>' }  // Uint32Array
```

Quick saves store raw (uncompressed) state in memory for speed.

### Save State Wrapper Format

```javascript
{
  version: 3,                    // Strict v3 format
  timestamp: 1702500000000,      // Unix timestamp (ms)
  romHash: "A1B2C3D4",          // CRC32 (preferred) or fallback hash
  data: { /* compressed state */ }
}
```

### ROM Hash Verification

ROM identity is verified using CRC32 when available (computed by `rom.getCRC32()`), falling back to a simple hash of the first 1KB of ROM data:

```javascript
function getRomHash() {
  if (nes.rom && typeof nes.rom.getCRC32 === 'function') {
    const crc = nes.rom.getCRC32();
    if (crc !== null && crc !== undefined) {
      return crc.toString(16).toUpperCase().padStart(8, '0');
    }
  }
  // Fallback: simple hash of first 1KB
  let hash = 0;
  const len = Math.min(1024, nes.romData.length);
  for (let i = 0; i < len; i++) {
    hash = ((hash << 5) - hash) + nes.romData[i];
    hash |= 0;
  }
  return hash.toString(16);
}
```

ROM hash mismatch is warned, not hard-blocked.

### Storage Locations

| Type | Storage | Key Format | Persistence |
|------|---------|------------|-------------|
| Slot saves | localStorage | `nes_savestate_0` – `nes_savestate_9` | Permanent |
| Quick save | Memory | JavaScript variable (uncompressed) | Session only |
| Export | File | `savestate_slot0.json` | User manages |

### Additional API

- `deleteState(slot)` — remove a save state
- `listStates()` — list all saves with metadata
- `hasState(slot)` — check if slot exists
- `getStorageUsage()` — get total localStorage size used
- `downloadState(slot)` — export save to file
- `importState(file, slot)` — import save from file

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
| PPU | 5.369318 MHz | 3x CPU clock (NTSC), 16/5x (PAL) |
| APU Frame | 240 Hz | Controls envelope/sweep |

### Frame Timing

At 60 FPS (NTSC):
- ~29,780 CPU cycles per frame
- ~89,342 PPU cycles per frame
- Audio samples per frame = `sampleRate / 60` (about 800 at 48kHz)

### CPU-Driven Timing Model

The CPU is the timing anchor. Each CPU memory access calls `_startCycle()` which:
1. Increments CPU cycle counters
2. Clocks PPU via `ppu.clockCpuCycle()` (region-aware: 3 PPU dots per CPU cycle for NTSC, accumulator-based for PAL)
3. Clocks mapper via `mapper.step(1)` and `mapper.cpuClock(1)` compatibility hooks
4. `_endCycle()` then updates NMI/IRQ edge/level state

This means bus-visible events (PPU register IO, DMA, mapper register writes) happen in deterministic cycle order without a separate catch-up scheduler.

### requestAnimationFrame Loop

The emulator runs one NES frame per browser animation frame with frame-pacing:

```javascript
function onAnimationFrame(timestamp) {
  requestAnimationFrame(onAnimationFrame);
  if (!emulationRunning) return;

  if (!fastForward) {
    const frameIntervalMs = getFrameIntervalMs();
    const elapsed = timestamp - lastFrameTime;
    if (elapsed < frameIntervalMs) return;
    lastFrameTime = timestamp - (elapsed % frameIntervalMs);
  }

  const speed = fastForward ? 4 : 1;
  for (let i = 0; i < speed; i++) {
    nes.frame();
  }
  if (!fastForward) {
    topUpAudioBuffer(AUDIO_MAX_CATCHUP_FRAMES);
  }
  flushAudio();

  // Convert 0xRRGGBB framebuffer to RGBA for canvas
  for (let i = 0; i < FRAMEBUFFER_SIZE; i++) {
    const rgb = framebufferU32[i];
    const base = i << 2;
    imageData.data[base]     = (rgb >> 16) & 0xFF;  // R
    imageData.data[base + 1] = (rgb >> 8) & 0xFF;   // G
    imageData.data[base + 2] = rgb & 0xFF;          // B
    imageData.data[base + 3] = 0xFF;                // A
  }
  canvasCtx.putImageData(imageData, 0, 0);
}
```

Frame pacing clamps `lastFrameTime` to prevent spiral-of-death after tab suspension. Fast forward mode (F key held) runs 4 frames per update and skips audio top-up.

---

## Performance Optimizations

### CPU Optimizations

1. **Method-reference opcode table** — 256-element dispatch array built once at construction
2. **Typed arrays** — `Uint8Array` for RAM, separate 2KB mirror and 64KB debug view
3. **Bitwise operations** — Fast flag manipulation
4. **Per-cycle hooks** — Compact `_startCycle()`/`_endCycle()` for mapper/PPU timing

### PPU Optimizations

1. **Scanline/pixel rendering** — Only render during visible scanlines
2. **Shift-register pipeline** — Constant-time pixel decode per dot
3. **Uint32Array framebuffer** — Fast 32-bit writes for RGB output
4. **Accumulator-based stepping** — Handles non-integer PPU/CPU ratios (PAL) without floating point

### Memory Layout

```javascript
// PPU outputs 24-bit 0xRRGGBB pixels; frontend converts to RGBA each frame
const framebufferU32 = new Uint32Array(FRAMEBUFFER_SIZE);
const imageData = canvasCtx.getImageData(0, 0, 256, 240);
```

---

## Debugging Guide

### F9 Snapshot

The debug module (`debug/debug.js`) binds to F9 by default. It captures state at **scanline 241** and prints a comprehensive snapshot to the console:

- PPU registers ($2000–$2007), scroll info (fine X, VRAM address, latch address, write toggle)
- Nametables and attribute tables ($2000–$2FFF)
- Palette ($3F00–$3F1F), OAM (first 8 sprites decoded)
- CHR ROM/RAM samples ($0000–$1FFF)
- **MMC5-specific state** when Mapper 005 is loaded: PRG/CHR modes, ExRAM mode, nametable mapping, fill mode, vertical split, IRQ/multiplier, audio channels, internal state

Output format follows Mesen-comparable style for reference comparison.

### Common Issues

**Black screen:**
- Check mapper support for the ROM
- Verify ROM header is valid (starts with "NES\x1a")
- Verify reset vector is reachable

**Garbled graphics:**
- Almost always CHR banking or latch timing
- Verify mapper `notifyVramAddressChange()` or `ppuRead()` address handling
- Verify mirroring mode is correct

**No audio:**
- Check browser console for AudioContext errors
- Ensure user interaction before audio init (browser autoplay policy)
- Verify expansion audio source registration for mapper-specific audio

**Status Bar Issues (MMC3):**
- IRQ counter timing issue
- Verify A12 rising edges via `notifyVramAddressChange()`
- Check IRQ counter reload timing

**Split screen issues (MMC5):**
- Verify `onEndScanline()` is running and IRQ/vsplit state changes are correct
- Ensure ExRAM and per-tile attributes are in the expected mode

**Save state not loading:**
- Check browser console for errors
- Version mismatch hard-fails (must be strict v3)
- ROM hash mismatch triggers warning
- localStorage may be full — clear old saves

### Useful Console Commands

```javascript
// Access emulator internals
nes.cpu.PC.toString(16)     // Current program counter
nes.cpu.A                   // Accumulator
nes.ppu.scanline            // Current scanline
nes.ppu.cycle               // Current PPU cycle
nes.ppu.v                   // Current VRAM address
nes.rom.mapperType          // Loaded mapper number
nes.mmap                    // Active mapper instance

// Save state debugging
listStates()                // Show all save slots
localStorage                // View raw storage
```

---

## References

- [NESDev Wiki](https://www.nesdev.org/wiki/) — Comprehensive NES hardware documentation
- [Mesen2](https://github.com/SourMesen/Mesen2) — Reference emulator (Mesen-aligned baseline)
- [6502 Instruction Reference](https://www.masswerk.at/6502/6502_instruction_set.html)
- [MMC2 Documentation](https://www.nesdev.org/wiki/MMC2)
- [MMC3 Documentation](https://www.nesdev.org/wiki/MMC3)
- [MMC5 Documentation](https://www.nesdev.org/wiki/MMC5)

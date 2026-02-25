# ai-NES Architecture

This document details the architectural decisions behind ai-NES, specifically focusing on the **Capability-Driven Mapper System**, the **CPU-Driven Timing Model**, and the **AudioWorklet Pipeline** as implemented in the current codebase.

## 1. Capability-Driven Mapper System

Traditional NES emulators often rely on "Monolithic Switch Statements" or "Mapper ID Checks" scattered throughout the PPU and CPU cores. For example:

```javascript
// Traditional (Bad) Approach in PPU
if (this.mapper.id === 4 || this.mapper.id === 6) {
    this.mapper.clockIrq();
}
if (this.mapper.id === 9) {
    this.mapper.latchChr();
}
```

This approach is fragile. Adding a new mapper requires modifying the core PPU logic, risking regressions for every other game.

### The ai-NES Approach

ai-NES inverts this dependency. The PPU and CPU are **mapper-agnostic**. They do not know or care which mapper ID is loaded. Instead, they interact with mappers through a defined set of **Behavioral Capabilities** and **guarded hook calls**.

### How It Works

1.  **Declaration:** When a mapper is instantiated, it sets boolean flags indicating which hardware features it supports. Some flags are set automatically by the base class (e.g., `hasVramAddressHook` is set when a mapper overrides `enableVramAddressHook()`).
2.  **Contract:** If a mapper sets a flag or implements a hook method, it **must** provide a correct implementation.
3.  **Execution:** The PPU checks the *capability* or *method presence*, not the *ID*.

```javascript
// AI-NES Approach in PPU — flag-gated hook
if (mapper.hasVramAddressHook) {
    mapper.notifyVramAddressChange(addr, mapperContext);
}

// AI-NES Approach in PPU — method-presence guard
if (typeof mapper.readNametable === "function") {
    value = mapper.readNametable(addr, context, mapperContext);
}
```

### Core Capabilities

| Capability Flag | Description | Gate Mechanism | Used By |
| :--- | :--- | :--- | :--- |
| `hasVramAddressHook` | Mapper needs per-address PPU bus notifications. Primary timing-critical gate. | `notifyVramAddressChange(addr, context)` | MMC3, MMC2, MMC4 |
| `hasScanlineIrq` | Fallback A12 scanline-counter path (used when mapper lacks dedicated VRAM hook). | `scanlineCounter(context)` | — |
| `hasChrLatch` | PPU bus snooping for latch-based CHR switching. | Mapper watches addresses via VRAM hook | MMC2, MMC4 |
| `hasNametableOverride` | Mapper owns nametable data (ExRAM/fill). | PPU checks `typeof mapper.readNametable === "function"` | MMC5 |
| `hasPpuA13ChrSwitch` | A13-based CHR bank selection for separate BG/sprite banks. | Mapper uses A13 to switch CHR banks | MMC5 |

**Note:** `hasVramAddressHook` is automatically set by the base class when a mapper overrides `enableVramAddressHook() { return true; }`. The PPU calls `notifyVramAddressChange()` on every bus address change, which is how MMC3 detects A12 rising edges and how MMC2/MMC4 detect latch-triggering pattern addresses.

### Mapper Hooks (No Flag Required)

These hook methods are called when present, guarded by `typeof` checks or always invoked:

- `ppuRead(addr, context, mapperContext)` and `ppuWrite(addr, value, context, mapperContext)` handle CHR ROM/RAM and context-specific fetches (`bg`, `sprite`, `attribute`, `cpu`).
- `readNametable(addr, context, mapperContext)` and `setNametableByte(addr, value, mapperContext)` override nametable reads/writes (MMC5 ExRAM/fill).
- `onPpuRegisterWrite(addr, value, mapperContext)` observes `$2000/$2001/$2006` for mapper state tracking.
- `onEndScanline(scanline, mapperContext)` is called at cycle 4 when rendering is enabled, for scanline-based logic.
- `onStartScanline(scanline, renderingEnabled, mapperContext)` is called at scanline start.
- `processCpuClock()` via `cpuClock(cycles)` supports per-CPU-cycle timing (MMC5, FME-7).
- `onNmiVectorRead()` supports NMI vector timing (MMC5).

### Benefits

1.  **Isolation:** MMC3 A12 timing is opt-in via `hasVramAddressHook`, so other mappers never touch that path.
2.  **Extensibility:** New mappers slot in as isolated modules with explicit hooks and capabilities.
3.  **Accuracy:** CHR reads flow through `ppuRead()` on every fetch, enabling latch-based mappers like MMC2/MMC4 to react to real PPU addresses.

## 2. CPU-Driven Timing Model

To support advanced mappers like MMC5, which monitor the PPU bus to detect "In-Frame" status versus "VBlank" status, the emulator cannot run the CPU and PPU in large batches. They must be tightly interleaved.

### The Per-Cycle Pipeline

ai-NES uses the CPU as the timing anchor. Every CPU memory access goes through cycle boundaries that clock the PPU and mapper in lockstep:

```javascript
// src/cpu.js — simplified
_startCycle() {
  this.cycleCount++;
  // Clock PPU (region-aware: 3 dots per CPU cycle for NTSC, accumulator-based for PAL)
  this.nes.ppu.clockCpuCycle();
  // Clock mapper hooks
  const mapper = this.nes.mmap;
  if (mapper) {
    mapper.step(1);
    if (mapper._hasCpuClockHook) mapper.cpuClock(1);
  }
}

_endCycle() {
  // NMI edge detection, IRQ level detection
}
```

The main frame loop is therefore simple:

```javascript
// src/nes.js — frame()
frame() {
  ppu.startFrame();
  while (!ppu.frameComplete && !this.break) {
    const cpuCycles = cpu.step();  // internally clocks PPU + mapper
    if (emulateSound) {
      papu.clockFrameCounter(cpuCycles);
    }
  }
}
```

**`NES.catchUp()` is intentionally a no-op.** The old external catch-up path has been fully replaced by the CPU's internal per-cycle pipeline. There is no separate PPU scheduler — bus-visible events (PPU register IO, DMA, mapper register writes) happen in deterministic cycle order because PPU and mapper clocks are integrated into every CPU bus access.

### Why This Matters

- If a game writes to a PPU register or mapper address mid-instruction, the PPU is already advanced to the exact dot for that bus access.
- MMC5's in-frame detection works because `onEndScanline()` fires at the correct cycle relative to PPU rendering.
- A12 rising edges for MMC3 IRQs are detected at the precise cycle when the PPU bus address changes.

## 3. AudioWorklet Pipeline

Audio is handled on a dedicated thread using the `AudioWorklet` API, preventing UI jank or garbage collection pauses from causing audio glitches.

### Architecture

```text
APU sample() -> batch (4096) -> postMessage -> AudioWorklet ring (8192)
        ^                                  |
        |                                  v
    queue estimator <--- currentTime <--- output mix -> destination
```

### Details

- **Ring Buffer:** The worklet keeps an 8192-sample circular buffer for each stereo channel (power of two, configurable). Uses bitmask wrapping for zero-branch index arithmetic.
- **Batching:** The main thread accumulates 4096 samples per channel before posting to the worklet via `postMessage`.
- **Target Queue:** The main loop tracks queued samples using `audioCtx.currentTime` and keeps roughly 80ms of audio buffered, topping up with a few extra frames when needed to avoid underruns.
- **Underrun Handling:** When the buffer runs dry, the last available sample fades linearly to silence to avoid audible clicks.
- **Overrun Handling:** When writes catch up with reads, the oldest unread sample is dropped to maintain synchronization.
- **Prefill:** On boot, a short prefill warms the queue before playback starts to prevent startup crackles.
- **Latency Hint:** The `AudioContext` uses `latencyHint: 'playback'` to favor stability over minimal latency.

## 4. Expansion Audio Mixing

Expansion audio is modeled as optional sources that register with the APU. This keeps mapper audio code isolated while still feeding the main mix:

1. A mapper creates an expansion audio module and registers it via `papu.setExpansionAudioSource(name, source)`.
2. The APU clocks expansion sources (`source.clock(1)`) alongside its own channels each CPU cycle.
3. Expansion `getSample()` output is summed into the final stereo mix with per-channel panning weights, before DC removal.

Current implementations:

| Mapper | Module | Status |
| :--- | :--- | :--- |
| 69 (Sunsoft 5B) | `Sunsoft5BAudio` | Active — 3-channel tone generator with envelope, returns real audio samples |
| 5 (MMC5) | `Mmc5Audio` | Stub — register state tracked, `getSample()` returns 0 |

This allows mapper-specific audio without coupling mapper logic to the APU internals. Adding a new expansion audio source requires only implementing `clock(cycles)` and `getSample()` and registering with the APU.

## 5. Debug Snapshot (F9)

The debug module (`debug/debug.js`, bound to F9 by default) captures state at **scanline 241** and outputs a comprehensive snapshot to the console:

- PPU registers, scroll info, VRAM address state
- Nametables, attribute tables, palette, OAM
- CHR ROM/RAM samples
- MMC5-specific state when a Mapper 005 ROM is loaded (PRG/CHR modes, ExRAM, split-screen, IRQ, audio registers, internal timing state)

Output format follows Mesen-comparable style for reference comparison during accuracy checks.

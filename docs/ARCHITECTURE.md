# AI-NES Architecture

This document details the architectural decisions behind AI-NES, specifically focusing on the **Capability-Driven Mapper System** and the **Cycle-Interleaved Timing Model** as implemented in the current codebase.

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

### The AI-NES Approach

AI-NES inverts this dependency. The PPU and CPU are **mapper-agnostic**. They do not know or care which mapper ID is loaded. Instead, they interact with mappers through a defined set of **Behavioral Capabilities**.

### How It Works

1.  **Declaration:** When a mapper is instantiated, it sets boolean flags indicating which hardware features it supports.
2.  **Contract:** If a mapper sets a flag (e.g., `hasScanlineIrq = true`), it **must** implement the corresponding interface method (e.g., `clockScanline()`).
3.  **Execution:** The PPU checks the *capability*, not the *ID*.

```javascript
// AI-NES (Good) Approach in PPU
if (this.nes.mmap.hasScanlineIrq) {
    this.nes.mmap.clockScanline();
}
```

### Core Capabilities

| Capability Flag | Description | Required Method | Used By |
| :--- | :--- | :--- | :--- |
| `hasScanlineIrq` | Mapper wants A12-based scanline IRQ clocking. | `clockScanline()` | MMC3 |
| `hasNametableOverride` | Mapper owns nametable data (ExRAM/fill). | `readNametable(addr, context)`, `setNametableByte(addr, val)` | MMC5 |
| `hasPerTileAttributes` | Mapper supplies per-tile attribute data from ExRAM. | `getExtendedAttributeByte(x, y)` | MMC5 |

### Mapper Hooks (No Flag Required)

- `ppuRead(addr, context)` and `ppuWrite(addr, value)` handle CHR ROM/RAM and context-specific fetches (`bg`, `sprite`, `attribute`).
- `onPpuRegisterWrite(addr, value)` observes `$2000/$2001/$2006` for MMC5 state tracking.
- `onEndScanline(scanline)` is called at dot 341 for scanline-based logic.
- `cpuClock(cycles)` and `onNmiVectorRead()` support cycle and NMI-vector timing (MMC5).

### Benefits

1.  **Isolation:** MMC3 IRQ timing is opt-in via `hasScanlineIrq`, so other mappers never touch that path.
2.  **Extensibility:** New mappers slot in as isolated modules with explicit hooks and capabilities.
3.  **Accuracy:** CHR reads flow through `ppuRead()` on every fetch, enabling latch-based mappers like MMC2/MMC4 to react to real PPU addresses.

## 2. Cycle-Interleaved Timing

To support advanced mappers like MMC5, which monitor the PPU bus to detect "In-Frame" status versus "VBlank" status, the emulator cannot run the CPU and PPU in large batches.

### The `catchUp()` Mechanism

AI-NES uses a `catchUp()` system to keep the PPU synchronized with the CPU at the sub-instruction level.

1.  **Cycle Counting:** The CPU counts cycles for every instruction step.
2.  **Memory Access:** Before the CPU reads or writes to a hardware register (PPU, APU, Mapper), it calls `nes.catchUp()`.
3.  **Interleaving:** `catchUp()` runs the PPU for exactly the number of cycles that have passed since the last sync.

```javascript
// src/nes.js
catchUp() {
  const target = this.cpu.cycleOffset || 0;
  if (target > this.ppuCaughtUp) {
    const cycles = target - this.ppuCaughtUp;
    // Strictly interleave PPU and Mapper clocks
    for (let i = 0; i < cycles; i++) {
      this.ppu.step();
      this.ppu.step();
      this.ppu.step();
      // Clock mapper (for MMC5 timing)
      if (this.mmap && this.mmap.cpuClock) this.mmap.cpuClock(1);
    }
    this.ppuCaughtUp = target;
    this.ppuCyclesToSkip += cycles * 3;
    this.cpuCyclesToSkip += cycles;
  }
}
```

This ensures that if a game writes to a PPU register or mapper address mid-instruction, the PPU is already advanced to the exact dot for that bus access, preserving precise raster timing.

## 3. AudioWorklet Architecture

Audio is handled on a dedicated thread using the `AudioWorklet` API, preventing UI jank or garbage collection pauses from causing audio glitches.

- **Ring Buffer:** The worklet keeps a 16384-sample circular buffer for each channel (power of two).
- **Batching:** The main thread batches 4096 samples before posting to the worklet.
- **Target Queue:** The main loop tracks queued samples using `audioCtx.currentTime` and keeps roughly 80ms of audio buffered, topping up with a few extra frames when needed to avoid underruns.
- **Prefill:** On boot, a short prefill warms the queue before playback starts to prevent startup crackles.
- **Latency Hint:** The `AudioContext` uses `latencyHint: 'playback'` to favor stability over minimal latency.

### Audio Queue Flow (Simplified)

```text
APU sample() -> batch (4096) -> postMessage -> AudioWorklet ring (16384)
        ^                                  |
        |                                  v
    queue estimator <--- currentTime <--- output mix -> destination
```

## 4. Expansion Audio Mixing

Expansion audio is modeled as optional sources that register with the APU. This keeps mapper audio code isolated while still feeding the main mix:

1. A mapper creates an expansion audio module (e.g., MMC5) and registers it via `papu.setExpansionAudioSource('mmc5', source)`.
2. The APU clocks expansion sources alongside its own channels each CPU step.
3. Expansion samples are summed into the final stereo mix before DC removal.

This allows mapper-specific audio (MMC5 pulse + PCM) without coupling mapper logic to the APU internals.

## 5. Debug Snapshot (F9)

The debug module (bound to F9 by default) outputs a snapshot of PPU + mapper state to the console, including MMC5 audio registers when a Mapper 005 ROM is loaded. This is used to compare against reference emulator snapshots during accuracy checks.

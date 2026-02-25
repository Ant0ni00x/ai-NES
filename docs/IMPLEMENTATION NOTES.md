# Technical Implementation Notes

This document outlines the core technical goals, architectural decisions, and major implementation milestones of the ai-NES emulator.

## 1. Project Goals & Philosophy

The primary objective is to create a **hardware-accurate NES emulator** with the following principles:

- **Pure JavaScript:** The entire emulator core (CPU, PPU, APU) is written in standard JavaScript. This ensures maximum portability and avoids reliance on compilers (e.g., Emscripten) or browser-specific technologies like WebAssembly.
- **Reference Quality Code:** The codebase is designed to be modular, readable, and well-documented. The goal is for the source to serve as a learning tool and a clear reference for how the NES hardware functions, rather than being heavily optimized to the point of obscurity.
- **Hardware Accuracy over Hacks:** The emulator avoids game-specific hacks. Compatibility is achieved by emulating the hardware's behavior and quirks as precisely as possible, so that games run correctly without special treatment.

## 2. Core Architecture

The emulator is built on a modular design that mirrors the physical components of the NES console.

- **`nes.js` (The Motherboard):** Acts as the central hub, owning the CPU, PPU, and APU instances. It contains the main emulation loop (`frame()`) which drives the components and synchronizes their timing.
- **`cpu.js` (The Processor):** A 6502 CPU core responsible for executing game logic. It is designed to be replaceable, provided the new core adheres to the established interface for memory access and interrupts.
- **`ppu.js` (The Graphics Chip):** A Picture Processing Unit core that handles all aspects of rendering, including background and sprite processing, scrolling, and palette management.
  - **Rendering:** Pixel rendering occurs at the start of the cycle *before* state updates to match hardware pipeline delay.
  - **Scrolling:** Full "Loopy" register implementation (v, t, x, w) for precise scrolling.
- **`apu.js` (Audio):** Implements the NES APU, mixes expansion audio sources, and streams through `AudioWorklet` with a queued ring buffer (no ScriptProcessor fallback).
- **`mappers/` (Game Cartridges):** Game-specific hardware mappers are implemented as separate modules. This isolates the logic for complex mappers (like MMC1 or MMC3) and prevents a change in one from breaking another.

## 3. CPU Core & PPU Synchronization

Achieving timing accuracy between the CPU and PPU was a primary focus. The synchronization model evolved over several iterations.

- **Cycle-Accurate Stepping:** `cpu.step()` executes one instruction and returns a cycle count. The main loop clocks the APU for that count.

- **Evolution of the Timing Model:**
  - *Early approach:* An external `catchUp()` mechanism ran the PPU forward in bursts before PPU register accesses, with `cycleOffset` tracking sub-instruction timing and `cpuCyclesToSkip` preventing double-counting.
  - *Current approach:* `NES.catchUp()` is intentionally a **no-op**. The CPU now internally clocks the PPU and mapper on every bus access cycle via `_startCycle()` and `_endCycle()`. Each `_startCycle()` call increments CPU cycle counters, clocks the PPU (`ppu.clockCpuCycle()`), and clocks mapper hooks (`mapper.step(1)` + `mapper.cpuClock(1)`). This eliminates the need for external catch-up scheduling entirely — PPU and mapper state is always in sync at every cycle boundary.

- **PPU Dummy Fetches:** To support mappers that rely on "snooping" the PPU bus for state detection (like MMC5's scanline detection), the PPU performs dummy nametable fetches at cycles 337 and 339. These fetches are unused by the PPU itself but are critical for the mapper to detect the end of a scanline.

- **Hardware-Accurate Instruction Behavior:**
  - **Read-Modify-Write (RMW) Instructions:** Instructions like `ASL`, `DEC`, `INC`, `LSR`, `ROL`, and `ROR` perform a "dummy write" of the original value back to memory before writing the modified value. This is a subtle hardware behavior required by some mappers and hardware tests.
  - **Cycle Counting:** The cycle counting logic correctly accounts for penalties from page-crosses and taken branches, ensuring the total duration of every instruction is accurate.

## 4. APU Implementation & Refinement

A complete audit and refactoring of the APU (Audio Processing Unit) was performed to ensure hardware accuracy.

- **Triangle Channel:** Corrected the timer period calculation to `timer + 1` to match hardware specifications.
- **Noise Channel:** Implemented the hardware-accurate Linear Feedback Shift Register (LFSR).
  - Uses a 15-bit shift register.
  - Feedback is calculated using Bit 0 XOR Bit 1 (Mode 0) or Bit 0 XOR Bit 6 (Mode 1).
  - This fixes sound effects in games like *Contra* (explosions) and *Balloon Fight*.
- **Architecture:** Refactored channel logic into modular classes (`SquareChannel`, `TriangleChannel`, `NoiseChannel`, `DmcChannel`) with standardized timer clocking methods.
- **Mixing:** Unified the sampling and mixing pipeline with non-linear NES-style lookup tables (16x resolution DAC), per-channel stereo panning, and DC offset removal.
- **Expansion Audio:** Mapper audio sources register with the APU via `papu.setExpansionAudioSource(name, source)` and are mixed into the stereo output before DC removal. Sources implement `getSample()` and optionally `clock(cycles)`.

## 5. Game Compatibility: The NROM Gauntlet

The first major goal was to achieve high compatibility with NROM (Mapper 0) games. This provided a stable, hardware-accurate foundation before tackling complex mappers. The process revealed and resolved several critical, subtle bugs.

### Milestone 1: The PPU Warm-up Period
- **Symptom:** Early games like *Donkey Kong* had graphical glitches on boot.
- **Cause:** On a real NES, the PPU ignores writes to most control registers for the first ~30,000 cycles after power-on. The emulator's warm-up logic was too lenient.
- **Resolution:** Implemented a strict warm-up period where writes to `$2000` (PPUCTRL), `$2001` (PPUMASK), `$2005` (PPUSCROLL), and `$2006` (PPUADDR) are ignored. This prevents games from configuring the PPU before it is ready.

### Milestone 2: The Controller Read Quirk
- **Symptom:** *Mario Bros.* would run but freeze on a grey screen, never loading its palette.
- **Cause:** The game's input loop expected to read a `1` from the controller port (`$4016`) after reading the 8 button bits. The emulator was returning `0`, causing an infinite loop in the game's VBlank routine.
- **Resolution:** The `controller.js` logic was corrected to return `1` on the 9th and subsequent reads, matching the hardware and fixing the hang.

### Milestone 3: RAM Initialization State
- **Symptom:** Some early games still failed to boot correctly, even though the code seemed to be running.
- **Cause:** Real NES hardware has random data in RAM on power-on. However, many early games were developed on systems that likely had zero-initialized RAM and were programmed with this implicit assumption.
- **Resolution:** Added a configurable `ramInitPattern` (`'all_zero'`, `'all_ff'`, `'random'`). The default is hardware-like `'random'`, but compatibility can force `'all_zero'` for early titles that assume clean RAM.

### Milestone 4: The Scroll Register Breakthrough (The Final NROM Bug)
- **Symptom:** *Donkey Kong* and *10-Yard Fight* had garbage tiles on the bottom half of the screen, but would "fix themselves" after a gameplay demo cycle.
- **Investigation:** By comparing logs with Mesen and analyzing the game's behavior, we determined the PPU's internal VRAM address register (`v`) was being corrupted on the pre-render scanline (scanline 261).
- **Cause:** The emulator was unconditionally copying the vertical scroll bits from the temporary register (`t`) to the main register (`v`) during the pre-render scanline. Hardware documentation and analysis of other emulators confirmed this copy should **only** occur if rendering is enabled. When a game disabled rendering to update VRAM, this unconditional copy would corrupt the VRAM address.
- **Resolution:** The `copyVerticalBits()` call in `ppu.js` was made conditional on rendering being enabled. This was the final change that stabilized the entire suite of NROM games, from *Super Mario Bros.* to *Donkey Kong*, without regressions.

## 6. Mapper 1 (MMC1) Implementation Journey

The implementation of Mapper 1 (MMC1) required addressing several hardware-specific behaviors to achieve high compatibility with titles like *The Legend of Zelda*, *Metroid*, and the *Dragon Warrior* series.

### 1. Mirroring Logic
- **Issue:** Initial implementation mapped MMC1 mirroring modes (0-3) incorrectly to internal PPU mirroring constants.
- **Fix:** Corrected mapping to:
  - Mode 0: Single Screen A (Lower Bank)
  - Mode 1: Single Screen B (Upper Bank)
  - Mode 2: Vertical
  - Mode 3: Horizontal

### 2. PRG Banking & ROM Size
- **Issue:** PRG Mode 3 (Fix last bank at $C000) logic hardcoded a 256KB ROM assumption. This caused out-of-bounds memory access for 128KB games like *The Legend of Zelda*, leading to crashes.
- **Fix:** Updated logic to calculate the fixed bank index dynamically based on the actual `prgBankCount` derived from the ROM size.

### 3. PPU Timing & Rendering
- **Issue:** *Dragon Warrior* displayed a horizontal offset of a few pixels.
- **Root Cause:** The PPU `step()` function was updating shift registers and fetching tiles *before* rendering the pixel for the current cycle, effectively shifting the image.
- **Fix:** Reordered the pipeline to call `renderPixel()` at the start of the cycle, before state updates, aligning with real hardware pipeline behavior.

### 4. Save State Robustness
- **Issue:** Loading states caused transient graphical glitches or incorrect mirroring until the next mapper write.
- **Fix:**
  - Added `updateMirroring()` to `Mapper001.fromJSON` to restore mirroring state immediately.
  - Expanded PPU state serialization to include internal rendering state (shift registers, secondary OAM, latches).

### 5. Soft Reset Stability
- **Issue:** Soft resetting the console caused games to hang or crash.
- **Fix:**
  - Reset `lastWriteCycle` to a safe negative value to prevent the serial write protection logic from blocking initialization writes.
  - Ensured `wramDisable` is reset to `false`.
  - Forced a call to `updateBankOffsets()` and `updateMirroring()` in `reset()` to re-apply the preserved register state to the PPU.

### 6. 512KB SUROM Support (Dragon Warrior III & IV)
- **Issue:** Large 512KB games (SUROM/SXROM boards) failed to boot or displayed a grey screen.
- **Technical Detail:** On these boards, the MMC1 uses CHR Bank bit 4 (A16) to drive the PRG Bank bit 4 (A18), effectively selecting between two 256KB PRG blocks.
- **Fix:**
  - Implemented logic to use CHR bank bits for PRG banking on ROMs > 256KB.
  - Corrected PRG Mode 3 behavior for 512KB ROMs: The "fixed" bank at $C000 must be the last bank of the *currently selected 256KB block*, not the last bank of the entire ROM.

## 7. Mapper 2 (UNROM) Implementation

The implementation of Mapper 2 (UNROM) enables support for many Konami and Capcom classics.

- **Banking Logic:** Implemented the standard UNROM scheme with a switchable 16KB lower bank ($8000) and a fixed 16KB upper bank ($C000).
- **CHR-RAM:** Configured to use 8KB of CHR-RAM, as UNROM boards typically lack CHR-ROM.

## 8. Mapper 3 (CNROM) Implementation

The implementation of Mapper 3 (CNROM) supports games like *Cybernoid* and *Solomon's Key*.

- **Banking Logic:** Fixed PRG-ROM (usually 32KB), switchable 8KB CHR-ROM.
- **Bus Conflicts:** Implemented hardware-accurate bus conflicts. On CNROM boards, writing to the mapper (located in ROM address space) causes a conflict between the CPU data bus and the ROM output. The resulting value is the logical AND of the written value and the ROM byte at that address.

## 9. Mapper 4 (MMC3) Implementation

- **Banking Logic:** Implemented the full MMC3 banking scheme, including switchable PRG modes (swapping fixed/switchable banks) and CHR modes (swapping 1KB and 2KB banks).
- **IRQ System:** Replaced the simple scanline-based IRQ with a hardware-accurate A12-based counter. The mapper declares `enableVramAddressHook() { return true; }`, and the PPU calls `notifyVramAddressChange(addr, context)` on every bus address change. The mapper filters A12 rising edges to clock the IRQ counter. This allows for the precise mid-scanline IRQs required by many advanced MMC3 games.

#### MMC3 IRQ Timing Refinement (Alien 3 & Astyanax)

Achieving compatibility with both *Alien 3* and *Astyanax* required a precise implementation of the MMC3 IRQ mechanism:

- **The Issue:** *Alien 3* hung on a black screen because the IRQ counter wasn't decrementing on scanlines with no sprites. *Astyanax* had shaking graphics due to IRQ jitter.
- **The Fix:**
  1.  **Dummy Sprite Fetches:** Updated `ppu.js` to always perform 8 sprite pattern fetches per scanline, even if fewer sprites exist. Unused slots fetch tile `$FF`. This ensures the PPU address bus toggles A12 consistently on every scanline, driving the IRQ counter.
  2.  **A12 Filtering:** Restored the A12 rising edge filter to ignore toggles shorter than 12 cycles. This filters out noise while the dummy fetches provide the legitimate clock signals.
  3.  **Mapper Write Synchronization:** The CPU's per-cycle `_startCycle()` pipeline ensures PPU and mapper are always in sync at every bus access, so IRQ reloads and bank switches happen at the correct cycle relative to the PPU.

#### `ppuRead` Robustness
- **Issue:** Mapper 4 games like *Super Mario Bros. 3* showed minor color corruption.
- **Root Cause:** The `ppuRead` method in `Mapper004` could return `undefined` if a calculated CHR address was out of bounds (e.g., for ROMs with non-standard CHR sizes). This `undefined` value would propagate through the PPU's rendering pipeline, causing graphical artifacts.
- **Resolution:** A fallback to `0` was added (`... || 0`), ensuring that any out-of-bounds CHR read returns a predictable value (approximating open bus behavior) instead of `undefined`. This aligns the mapper's robustness with the base mapper class and resolves the color issues.

## 10. Mapper 7 (AxROM) Implementation

The implementation of Mapper 7 (AxROM) enables support for *Battletoads* and *Wizards & Warriors*.

- **Banking Logic:** Uses 32KB PRG-ROM banks.
- **Mirroring:** Implements switchable single-screen mirroring. The game can select whether to use the lower or upper nametable for the entire screen.
- **Bus Conflicts:** Disabled by default to improve compatibility with imperfect ROM dumps.
- **Bank Wrapping:** Implemented modulo wrapping for bank indices to prevent crashes in games like *Super Off Road* that write out-of-bounds bank numbers.
- **Banking Mask:** Corrected PRG bank selection to use a 3-bit mask (`& 0x07`) to match hardware.
- **Game-Specific Fixes:** Enabled bus conflicts specifically for *Golgo 13: The Mafat Conspiracy*.

## 11. Gauntlet (Mapper 206) Compatibility

*Gauntlet* (Tengen/Licensed) uses Mapper 206 (DxROM/Namco 108), a subset of MMC3. It presents challenges due to incorrect iNES headers (often claiming Mapper 4) and specific mirroring requirements (Horizontal hardwired, but headers often claim Vertical). Two approaches were considered:

### Strategy A: Explicit Mapper Implementation (Considered)
A dedicated `Mapper206` class extending `Mapper004` would override `cpuWrite` to ignore MMC3-specific registers (Mirroring, IRQ) that don't exist on DxROM. This was considered but not implemented.

### Strategy B: Compatibility Database (Active)
The active approach uses `compatibility.js` to detect Gauntlet via CRC32 and force **4-Screen Mirroring**. Since DxROM is a subset of MMC3, `Mapper004` logic handles the banking correctly. The 4-Screen mirroring override prevents the game (or incorrect header) from misconfiguring the nametables, resolving the "walking through walls" glitch without needing a separate mapper class.

## 12. Debugging & Snapshot Tooling

Verification tools were added to make regression testing and accuracy comparisons repeatable.

- **F9 Snapshot:** `debug/debug.js` outputs PPU state, mapper registers, CHR samples, and MMC5 audio registers (when Mapper 005 is active) for Mesen-style comparison.
- **Live Toggle Logs:** F3/F4/F10 enable bus, MMC5, and VRAM logging for timing-sensitive troubleshooting.

## 14. StarTropics (MMC6) Implementation

*StarTropics* uses the MMC6 mapper, which is a variant of MMC3 (Mapper 4) with unique PRG-RAM protection.

- **The Issue:** The game writes to `$A001` to configure MMC6-specific RAM settings (individual 512-byte block protection). Standard MMC3 interprets this as globally disabling WRAM, causing save failures.
- **The Fix:** Implemented a dedicated `Mapper006` class that extends `Mapper004`. It overrides `cpuWrite` to intercept `$A001` and implements the correct MMC6 RAM protection logic (1KB internal RAM mirrored at `$7000-$7FFF`). `mapper-factory.js` detects *StarTropics* (and *Zoda's Revenge*) via CRC32 hashes in `MMC6_COMPAT_CRC32` and instantiates `Mapper006` when the ROM header claims Mapper 4 with legacy submapper 0. NES 2.0 headers with explicit submapper 1 also route to `Mapper006` directly.

## 15. Mapper 9 (MMC2) Implementation

The implementation of Mapper 9 (MMC2) enables support for *Mike Tyson's Punch-Out!!*.

- **PRG Banking:** Implemented 8KB PRG banking with the upper three banks fixed on reset.
- **CHR Latching:** Implemented the unique MMC2 CHR banking mechanism. The mapper monitors PPU pattern table fetches and switches CHR banks when specific tile addresses (`$0FD8`, `$0FE8`, `$1FD8`, `$1FE8`) are accessed. This allows for large, animated sprites without CPU intervention.
- **Accuracy:** Corrected the latch trigger to use the proper address range (`$0FD8-$0FDF`, etc.) rather than a single address, matching hardware behavior where the PPU fetches 8 bytes for a tile. This fixed graphical artifacts in *Mike Tyson's Punch-Out!!*.

## 16. Mapper 5 (MMC5) Implementation

The implementation of Mapper 5 (MMC5) required significant architectural upgrades to support its advanced features.

- **PPU Contract:** The PPU-to-Mapper contract was extended.
  - `ppuRead` now accepts a `context` ('bg' or 'sprite') to support MMC5's split CHR banking.
  - A new `readNametable` hook was added for ExRAM support.
  - A new `onEndScanline` hook was added to drive the scanline-compare IRQ.
- **Implementation:** `Mapper005` now implements PRG/CHR banking modes, ExRAM modes, fill mode, split-screen control, scanline IRQ + multiplier, and timer logic.
- **Audio:** MMC5 audio is implemented as the `Mmc5Audio` class embedded in `mapper005.js`. Register state is tracked and the module is registered with the APU expansion path, but `getSample()` currently returns 0 (audio output is a stub).

## 17. Future Roadmap

- **Accuracy:** Refine controller double-read timing, and consider OAM decay + DMC DMA conflicts.
- **Audio:** Complete MMC5 pulse + PCM audio synthesis (currently a stub returning 0).
- **Note:** Unofficial opcodes are now implemented (SLO, RLA, SRE, RRA, SAX, LAX, DCP, ISB, AAC, ASR, ARR, ATX, AXS, SHY, SHX, SHAA, SHAZ, TAS, ANE, LAS, HLT).

## 18. Zapper (Light Gun) Implementation

Support for the NES Zapper peripheral was added to enable games like *Duck Hunt* and *Hogan's Alley*.

- **Input Handling:** Mouse coordinates are mapped to NES screen coordinates (256x240) in `nes-init.js`, accounting for CSS scaling and letterboxing. Mouse events drive `nes.zapperMove(x, y)`, `nes.zapperFireDown()`, and `nes.zapperFireUp()`.
- **Controller Port:** The Zapper is read via Controller 2 on port `$4017`. The CPU's `_readIORegister()` dispatches `$4017` reads to `controllers[2]`, which returns trigger and light-sense bits. The CPU's per-cycle timing model ensures PPU state is always in sync when the read occurs.

## 19. Mapper Library Expansion

Several mappers were added or fixed to support specific titles:

- **Mapper 25 (VRC2 and VRC4):** Added support for *Gradius II*
- **Mapper 34 (BNROM / NINA-001):** Implemented support for *Deadly Towers* and *Impossible Mission II*. The mapper heuristically detects NINA-001 boards by the presence of CHR-ROM.
- **Mapper 66 (GxROM):** Added for *Super Mario Bros. / Duck Hunt*.
- **Mapper 79 (NINA-03/06):** Added for *Metal Fighter*.
- **Mapper 69 (Sunsoft FME-7 / 5B):** Added PRG/CHR banking, CPU-cycle IRQ counter, and full Sunsoft 5B expansion audio (3-channel tone generator with envelope, actively synthesized and mixed into APU output via the expansion audio bus).
- **Mapper Fixes:**
  - **Mapper 0 (NROM):** Fixed mirroring initialization to resolve scrolling artifacts in *Super Mario Bros.*.
  - **Mapper 7 (AxROM) & 11 (Color Dreams):** Added missing `cpuRead` implementations to prevent crashes.

## 20. Audio Accuracy Refinements

- **Noise Channel LFSR Fix:** A critical bug was identified where the noise channel's output (`randomBit`) was not updating after every shift of the Linear Feedback Shift Register. Fixing this restored missing percussion in *Super Mario Bros. 3* and explosion sound effects in *Contra*.
- **Expansion Audio Mixing:** Mapper audio sources (currently Sunsoft 5B) are mixed into the APU output through the expansion audio bus. MMC5 audio registers are tracked but output is currently a stub.
- **Audio Output Buffering:** Audio is batched into 4096-sample chunks and queued into an 8192-sample AudioWorklet ring buffer. The main loop tracks queue depth via `audioCtx.currentTime` to keep roughly 80ms of audio buffered, with a prefill on boot and small top-ups per frame to avoid underruns during UI stalls. The APU sample rate is synced to the AudioContext rate to prevent drift.

## 21. Advanced Hardware Accuracy & Edge Cases

Recent updates have focused on "deep" hardware quirks and edge cases required for high-accuracy tests and specific game behaviors.

### CPU
- **Dummy Reads:** Implemented hardware-accurate "dummy reads" for indexed addressing modes (`ABS,X`, `ABS,Y`, `(IND),Y`) when crossing page boundaries. The CPU now performs a read at the partially calculated address before the final read, triggering any associated hardware side-effects (e.g., mapper banking).
- **Zero Page Wrapping:** Corrected `IND,X` and `IND,Y` addressing modes to correctly wrap around the Zero Page boundary (`$FF` -> `$00`) when fetching pointers, rather than reading into the Stack page.
- **Open Bus Latch:** CPU `dataBus` is updated on reads/writes, and controller reads return open-bus bits ($40) for bits 5-7.

### PPU
- **Palette Mirroring:** Corrected the mirroring logic for palette RAM. Only the first entry of each sprite sub-palette (`$3F10`, `$3F14`, `$3F18`, `$3F1C`) mirrors the background transparency color (`$3F00`, `$3F04`, `$3F08`, `$3F0C`). This fixes background color issues in games relying on specific transparency behavior.
- **OAMADDR Corruption:** Implemented the hardware bug where writing to `OAMDATA` (`$2004`) during rendering fails to write data and instead corrupts the `OAMADDR` register (glitchy increment).
- **OAM Overflow Bug:** Implemented the "sprite overflow bug." When more than 8 sprites are on a scanline, the PPU's sprite evaluation logic malfunctions, incorrectly incrementing a byte offset and reading garbage data (often interpreting Y-coordinates as tile indices or attributes) for subsequent overflow checks.
- **NMI Suppression:** Implemented the race condition where reading `PPUSTATUS` (`$2002`) at the exact start of VBlank clears the VBlank flag and suppresses the NMI signal. Added a 3-cycle delay to the NMI trigger to accurately model this window.
- **Grayscale Mode:** Added support for the grayscale bit in `PPUMASK` (`$2001`), used by games like *Street Fighter 2010* for visual effects.
- **Open Bus:** PPU write-only register reads return the `ioBus` latch with per-bit decay tracking (`openBusDecayStamp`) to emulate open bus behavior. Bits decay to 0 after ~3 frames without refresh.

### APU
- **Pulse Sweep Muting:** Refined the sweep unit logic to continuously check the target period against the `$7FF` limit, muting the channel if exceeded regardless of whether the sweep is enabled. This fixes "missing notes" in games like *Super Spike V'Ball*.
- **Triangle Channel Mixing:** Corrected the mixing weight and interpolation logic for the Triangle channel to match hardware volume levels relative to Pulse and Noise.
- **Open Bus + DMC DMA:** Only `$4015` is readable; other APU reads return undefined to let CPU open bus through. DMC DMA uses `cpuRead()` to update the CPU data bus.

### Mappers
- **MMC5 Split-Screen:** Fixed the vertical split scrolling logic to correctly use the PPU's calculated VRAM address for ExRAM fetches, resolving graphical corruption in *Castlevania III*.
- **MMC5 Extended Attributes:** Corrected the tile range check for Extended Attribute mode to include the prefetch cycle tiles.

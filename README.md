## ai-NES - Modernized JavaScript NES Emulator

![JavaScript](https://img.shields.io/badge/JavaScript-vanilla-F7DF1E)
![License](https://img.shields.io/badge/license-MIT-blue)

A modernized Nintendo Entertainment System (NES) emulator written in JavaScript. This project focuses on **accuracy, maintainability, and clean architecture**, with particular emphasis on correct mapper behavior and long-term extensibility.

## Features

* ✅ **Pure JavaScript** - Runs in any modern browser, no plugins required
* ✅ **ES6 Modules** - Clean, maintainable codebase with proper imports/exports
* ✅ **Modern Audio** - AudioWorklet-based sound system
* ✅ **Expansion Audio Bus** - Expansion sources are mixed into APU output (Sunsoft 5B synthesis active; MMC5 register path wired)
* ✅ **Mapper-Agnostic Core** - CPU/PPU interact through mapper hook surfaces and capability flags, not per-mapper branching in CPU/PPU logic
* ✅ **Accurate Mapper Emulation** - Implemented set includes MMC1/MMC2/MMC3/MMC4/MMC5, VRC2/4 variants, FME-7, and more
* ✅ **CHR Latch Accuracy** - Hardware‑accurate MMC2/MMC4 latch triggering using real pattern fetch addresses (fine‑Y + both bitplanes)
* ✅ **Stable IRQ Timing** - MMC3 IRQs driven by true A12 rising‑edge detection
* ✅ **Multiple ROM Loading Options** - Load ROM button, drag & drop, or click overlay
* ✅ **Save States (Strict v3)** - In-memory quick save/load plus persistent slot saves
* ✅ **Gamepad Support** - Native browser Gamepad API integration
* ✅ **Debug Snapshots** - F9 dumps mapper/PPU state at configurable scanline

## Quick Start

1. Clone or download this repository
2. Serve the files with any HTTP server:

   ```bash
   # No install needed. Just dropt the files into a Web-enabled directory
   # then point at
   
   http://localhost/ai-nes/nes.htm
   ```
3. Open `http://localhost/ai-nes/nes.htm` (or the URL printed by your server)
4. Click to start or drag a `.nes` ROM file onto the emulator

## Controls

| Action       | Keyboard           | XBox Gamepad    | PS5 Gamepad |
| ------------ | ------------------ | --------------- | ----------- |
| D-Pad        | Arrow Keys         | D‑Pad           | D-Pad       |
| Button A     | A or Q             | A               | X           |
| Button B     | S or O             | B               | Circle      |
| Start        | Enter              | Start           | Options     |
| Select       | Tab                | Back            | Create      |
| Fast Forward | F (hold)           | —               | —           |

Gamepad support is automatic via the Gamepad API.

## Project Structure

```
├── nes.htm                     # Main HTML interface
├── nes.css                     # Stylesheet for retro CRT UI
├── debug/
│   ├── debug.js                # Debug snapshot module (F9)
│   └── ...
└── src/
    ├── index.js                # Module exports entry point
    ├── nes.js                  # Emulator orchestrator
    ├── nes-init.js             # Frontend: canvas, audio, input, UI
    ├── nes-save-states.js      # Save state system
    ├── cpu.js                  # 6502 CPU emulation
    ├── ppu.js                  # Picture Processing Unit (renderer)
    ├── apu.js                  # Audio Processing Unit (APU)
    ├── rom.js                  # iNES ROM parser
    ├── controller.js           # Input handling
    ├── compatibility.js        # ROM compatibility database
    ├── palette-table.js        # NES color palettes
    ├── utils.js                # Shared utilities
    └── mappers/
        ├── mapper-base.js      # Base class (capability interface)
        ├── mapper000.js        # NROM
        ├── mapper001.js        # MMC1
        ├── mapper002.js        # UNROM
        ├── mapper003.js        # CNROM
        ├── mapper004.js        # MMC3
        ├── mapper005.js        # MMC5
        ├── mapper006.js        # MMC6 (Mapper 4, submapper 1)
        ├── mapper007.js        # AxROM
        ├── mapper009.js        # MMC2
        ├── mapper010.js        # MMC4
        ├── mapper011.js        # Color Dreams
        ├── mapper021.js        # VRC2 / VRC4
        ├── mapper025.js        # VRC2 / VRC4
        ├── mapper034.js        # BNROM / NINA-001
        ├── mapper047.js        # NES-QJ
        ├── mapper066.js        # GxROM
        ├── mapper069.js        # Sunsoft FME-7 / 5B
        ├── mapper079.js        # NINA-03 / NINA-06
        ├── ...
        └── mapper-factory.js   # Mapper instantiation factory
```

## Supported Mappers

| Mapper | Status | Notes |
| ------ | :----: | ----- |
| NROM (0) | ✅ | Baseline discrete mapper |
| MMC1 (1) | ✅ | Shift-register control + PRG/CHR banking |
| UxROM (2) | ✅ | PRG banking |
| CNROM (3) | ✅ | CHR banking |
| MMC3 (4) | ✅ | A12-driven IRQs |
| MMC6 (4, submapper 1) | ✅ | MMC3-derived with MMC6 WRAM behavior |
| MMC5 (5) | ✅ | ExRAM + split-screen + extended banking |
| AxROM (7) | ✅ | PRG banking + one-screen mirroring |
| MMC2 (9) | ✅ | CHR latch timing (e.g. Punch-Out!!) |
| MMC4 (10) | ✅ | MMC2-style dual latch behavior |
| Color Dreams (11, 144) | ✅ | PRG/CHR banking |
| VRC2 / VRC4 (21) | ✅ | Variant address-line handling |
| VRC2 / VRC4 (25) | ✅ | Variant address-line handling + IRQ |
| Mapper 34 (BNROM + NINA-001/002) | ✅ | NES 2.0 submapper-aware merged implementation |
| NES-QJ (47) | ✅ | MMC3-derived extension |
| GxROM (66) | ✅ | PRG/CHR banking |
| Sunsoft FME-7 / 5B (69) | ✅ | PRG/CHR banking + IRQ + expansion audio |
| NINA-03 / NINA-06 (79) | ✅ | PRG/CHR banking |

Notes:
- Mapper 206 (`DxROM`) is identified by `ROM` metadata, but is **not** currently implemented in the mapper factory.
- MMC6 is implemented via mapper 4 + submapper 1 (not standalone mapper ID 6 in factory dispatch).

## Design Philosophy

This emulator keeps CPU and PPU behavior mapper-agnostic. Mapper-specific behavior is isolated in mapper modules.

Core rules:

* Each mapper is a modular hardware-like component in its own file.
* Timing-sensitive paths use explicit capability flags (`hasVramAddressHook`, `hasScanlineIrq`, etc.).
* CPU/PPU call the standardized mapper hook surface (`ppuRead`, `ppuWrite`, `notifyVramAddressChange`, `processCpuClock`, etc.) without mapper-ID branching.

This approach reduces cross-mapper regressions and makes incremental mapper additions straightforward.

For deep technical details, see [docs/TECHNICAL.md](docs/TECHNICAL.md).

## Development Notes

### Audio System

The emulator uses an **AudioWorklet-based** audio system:

- Runs on a dedicated audio thread for glitch-free playback
- Audio samples are batched and sent to the worklet to minimize postMessage overhead
- Expansion audio sources are mixed into the APU output path

### Save States

- **F5** - Quick save (in-memory)
- **F8** - Quick load (in-memory)
- **Shift + 1..9** - Save to slot 0..8
- **1..9** - Load from slot 0..8
- Persistent save files are strict **version 3** only (older versions are intentionally rejected)

### Debugging

The debug module (`debug/debug.js`) provides Mesen-comparable state dumps:

- **F9** - Request snapshot at scanline 241 (VBlank start)
- Outputs PPU registers, nametables, palette, OAM, scroll state
- MMC5 games include full mapper state + audio registers
- Console access: `nesDebug.outputAll()` or `nesDebug.targetScanline = 100`

See [docs/DEBUG_INTEGRATION.md](docs/DEBUG_INTEGRATION.md) for full documentation.

## Credits

This emulator is inspired by other JavaScript NES emulators, and is coded to behave like console reference emulators. The CPU, PPU, APU, and mappers are modular and designed to behave like NES hardware components.

Contributed by **ZeroGlitchX** and an assortment of AI friends.

AI Coding Assistance:
- **[Claude Code](https://claude.com/)**
- **[ChatGPT/Codex](https://chatgpt.com/)**
- **[Gemini Pro 3](https://gemini.google.com/)**

### Additional Credits

Thanks to the creators of various reference emulators. Extremely valuable for the mapper conversions from C++ to JavaScript. Most notably:

#### Primary Reference Emulators

- **[Mesen](https://github.com/SourMesen/Mesen2)**
- **[Higan](https://github.com/higan-emu/higan)**
- **[JSNES](https://github.com/bfirsh/jsnes)**
- **[WebNES](https://github.com/peteward44/WebNES)**

And a special thanks to **[AccuracyCoin](https://github.com/100thCoin/AccuracyCoin/tree/main)**, which assisted greatly with game compatibility through accuracy testing and accuracy implementation.

## Compatibility Notes

If you want to make improvements, start with [docs/TECHNICAL.md](docs/TECHNICAL.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## License

This project is licensed under the MIT license.

## Legal

This emulator does not include any copyrighted ROM files. You must provide your own legally obtained ROM dumps to use with this emulator.

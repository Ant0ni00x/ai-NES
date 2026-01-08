ai-NES - Modernized JavaScript NES Emulator

A modernized Nintendo Entertainment System (NES) emulator written in JavaScript. This project focuses on **accuracy, maintainability, and clean architecture**, with particular emphasis on correct mapper behavior and long-term extensibility.

## Features

* ✅ **Pure JavaScript** — Runs in any modern browser, no plugins required
* ✅ **ES6 Modules** — Clean, maintainable codebase with proper imports/exports
* ✅ **Modern Audio** — AudioWorklet-based sound with ScriptProcessor fallback
* ✅ **Capability‑Driven Mappers** — The PPU interacts with mappers strictly through declared behavioral capabilities (no mapper IDs, no method‑presence heuristics)
* ✅ **Accurate Mapper Emulation** — Correct MMC1, MMC2, MMC3, MMC4, and MMC5 behavior
* ✅ **CHR Latch Accuracy** — Hardware‑accurate MMC2/MMC4 latch triggering using real pattern fetch addresses (fine‑Y + both bitplanes)
* ✅ **Stable IRQ Timing** — MMC3 IRQs driven by true A12 rising‑edge detection
* ✅ **Drag & Drop ROM Loading** — Load `.nes` files directly into the emulator
* ✅ **Gamepad Support** — Native browser Gamepad API integration

## Quick Start

1. Clone or download this repository
2. Serve the files with any HTTP server:

   ```bash
   # Python 3
   python -m http.server 8000
   
   # Node.js
   npx serve
   ```
3. Open `http://localhost:8000/nes.htm` in your browser
4. Click to start or drag a `.nes` ROM file onto the emulator

## Controls

| Keyboard Key | Xbox Controller    | PS5 Controller  |
| ------------ | ------------------ | --------------- |
| Arrow Keys   | D‑Pad              | D‑Pad           |
| Space        | X Button           | Square Button   |
| A            | A Button           | X Button        |
| S            | B Button           | Circle Button   |
| D            | Y Button           | Triangle Button |
| Enter        | Start              | Options Button  |
| Tab          | Select             | Create Button   |

Gamepad support is automatic.

## Project Structure

```
├── nes.htm                     # Main HTML interface
├── nes.css                     # Stylesheet for modernized UI
└── src/
    ├── nes.js                  # Emulator orchestrator
    ├── cpu.js                  # 6502 CPU emulation
    ├── ppu.js                  # Picture Processing Unit (renderer)
    ├── apu.js                  # Audio Processing Unit (APU)
    ├── rom.js                  # iNES ROM parser
    ├── nes-init.js             # Frontend: canvas, audio, input handling
    ├── nes-audio-worklet.js    # AudioWorklet processor
    ├── nes-save-states.js      # Save state system
    ├── compatibility.js        # Compatibility database
    ├── controller.js           # Input handling
    ├── palette-table.js        # Default palette tables
    ├── utils.js                # Shared utilities
    ├── index.js                # Entry point
    └── mappers/
        ├── mapper-base.js      # The base class (interface)
        ├── Mapper000.js        # NROM
        ├── Mapper001.js        # MMC1
        ├── Mapper002.js        # UNROM
        ├── Mapper003.js        # CNROM
        ├── Mapper004.js        # MMC3
        ├── Mapper005.js        # MMC5
        ├── Mapper006.js        # FFE
        ├── Mapper007.js        # AxROM
        ├── Mapper009.js        # MMC2
        ├── Mapper011.js        # Color Dreams
        ├── Mapper025.js        # VRC2 and VRC4
        ├── Mapper034.js        # BNROM / NINA-001
        ├── Mapper047.js        # NES-QJ
        ├── Mapper066.js        # GxROM
        ├── Mapper079.js        # NINA-03 / NINA-06
        ├── Mapper206.js        # DxROM - Extension of MMC3
        ├── ...
        └── mapper-factory.js   # The "Factory" that groups them
```

## Supported Mappers

| Mapper            | Status      | Notes                                        |
| ----------------- | :---------: | -------------------------------------------- |
| NROM (0)          | ✅          | Baseline mapper                              |
| MMC1 (1)          | ✅          | Correct shift‑register behavior              |
| UxROM (2)         | ✅          | PRG banking                                  |
| CNROM (3)         | ✅          | CHR banking                                  |
| MMC3 (4)          | ✅          | A12‑driven IRQs                              |
| MMC5 (5)          | ✅          | ExRAM + split screen                         |
| MMC6 (6)          | ✅          | Extension of MMC3                             |
| AxROM (7)         | ✅          | 1KB VRAM page switching for nametables       |
| MMC2 (9)          | ✅          | Accurate CHR latch timing (Punch‑Out!!!)     |
| MMC4 (10)         | ✅          | Dual latch variant                           |
| Color Dreams (11) | ✅          | 32KB PRG bank switching                      |
| VRC2 / VRC4 (25)  | ✅          | 8-bit CHR registers (up to 256KB CHR)        |
| NINA-001 (34)     | ✅          | 2x 4KB CHR bank switching                    |
| NES-QJ (47)       | ✅          | Each block has 128k PRG and 128k CHR         |
| GxROM (66)        | ✅          | CHR-ROM: 8KB switchable banks                |
| NINA-03 / NINA-06 (79) | ✅     | CHR-ROM: 8KB switchable banks                |
| DxROM (206)       | ✅          | Extends MMC3 \| No Scanline IRQ              |

## Design Philosophy

This emulator intentionally avoids hard‑coding mapper IDs inside the PPU or CPU. Instead:

* Each mapper is modular - in its own file as if it were a hardware component, which then **declares behavioral capabilities** (e.g., CHR latch, A12 IRQ, nametable override, etc.)
* The PPU calls mapper hooks **only when the corresponding capability flag is set**
* If a capability is declared, the mapper guarantees the required method exists

This approach prevents cross‑mapper regressions and makes new mappers significantly easier to add while expanding the library of games that can run.

For deep technical details, see **TECHNICAL.md**.

## Development Notes

### Audio System

The emulator uses a two-tier audio system:

1. **AudioWorklet** (preferred) — Runs on a dedicated audio thread for glitch-free playback
2. **ScriptProcessor** (fallback) — For browsers without AudioWorklet support

Audio samples are batched and sent to the worklet to minimize postMessage overhead.

## Credits

This emulator is inspired by other JavaScript NES emulators, but coded to behave like console reference emulators. The CPU, PPU and APU are built from the ground up to behave like NES hardware.

Contributed by **ZeroGlitch** and an assortment of AI friends.

AI Coding Assistance:
- [Gemini Pro 3](https://gemini.google.com/)
- [Claude Code](https://claude.com/)
- [ChatGPT/Codex](https://chatgpt.com/)
- [Copilot](https://copilot.microsoft.com/)

### Additional Credits

Thanks to the creators of various reference emulators. Extremely valuable for the mapper conversions from C++ to JavaScript. Most notably:

- **[Mesen](https://github.com/SourMesen/Mesen2)**
- **[Higan](https://github.com/higan-emu/higan)**

And a special thanks to **[AccuracyCoin](https://github.com/100thCoin/AccuracyCoin/tree/main)**, which assisted greatly with compatibility through accuracy testing and accuracy implementation.

## Compatibility Notes

If you want to make any improvements, please take a look at the **TECHNICAL.md** document and give it a whirl! Currently, there is no native or intentional support for homebrew. This focuses on commercial releases.

There are about 14 incompatible games that I know of:

| Mapper           |               Game               | Notes                                         |
| ---------------- | :------------------------------: | --------------------------------------------- |
| Mapper 7 (AxROM) |          Super Off-Road          | Freezes on game load                          |
| Mapper 4 (MMC3)  |       Adventures of Lolo 2       | Freezes after pressing start title screen     |
| Mapper 4 (MMC3)  |      Bram Stoker's Dracula       | Game doesn't start                            |
| Mapper 4 (MMC3)  |          Burai Fighter           |                                               |
| Mapper 4 (MMC3)  |             G.I. Joe             | Freezes shortly after entering game play area |
| Mapper 4 (MMC3)  |  Golgo 13: The Mafat Conspiracy  | Graphical artifacts / Glitchy                 |
| Mapper 4 (MMC3)  |            Home Alone            | Game doesn't start                            |
| Mapper 4 (MMC3)  |     Disney's The Jungle Book     |                                               |
| Mapper 4 (MMC3)  |           Kick Master            |                                               |
| Mapper 4 (MMC3)  |        Krusty's Fun House        |                                               |
| Mapper 4 (MMC3)  |       Legacy of the Wizard       |                                               |
| Mapper 4 (MMC3)  | Mickey's Adventure in Numberland |                                               |
| Mapper 4 (MMC3)  |  Mickey's Safari in Letterland   |                                               |
| Mapper 4 (MMC3)  |   Star Trek: 25th Anniversary    |                                               |

## License

This project is licensed under the GPL v3 license.

## Legal

This emulator does not include any copyrighted ROM files. You must provide your own legally obtained ROM dumps to use with this emulator.

## ai-NES - Modernized JavaScript NES Emulator

A modernized Nintendo Entertainment System (NES) emulator written in JavaScript. This project focuses on **accuracy, maintainability, and clean architecture**, with particular emphasis on correct mapper behavior and long-term extensibility.

## Features

* ✅ **Pure JavaScript** - Runs in any modern browser, no plugins required
* ✅ **ES6 Modules** - Clean, maintainable codebase with proper imports/exports
* ✅ **Modern Audio** - AudioWorklet-based sound system
* ✅ **Expansion Audio Mixing** - MMC5 pulse + PCM audio mixed into APU output
* ✅ **Capability‑Driven Mappers** - The PPU interacts with mappers strictly through declared behavioral capabilities (no mapper IDs, no method‑presence heuristics)
* ✅ **Accurate Mapper Emulation** - Correct MMC1, MMC2, MMC3, MMC4, MMC5, and Sunsoft FME-7 (Mapper 069) behavior
* ✅ **CHR Latch Accuracy** - Hardware‑accurate MMC2/MMC4 latch triggering using real pattern fetch addresses (fine‑Y + both bitplanes)
* ✅ **Stable IRQ Timing** - MMC3 IRQs driven by true A12 rising‑edge detection
* ✅ **Multiple ROM Loading Options** - Load ROM button, drag & drop, or click overlay
* ✅ **Save States** - Quick save/load with multiple slots (F5/F8)
* ✅ **Gamepad Support** - Native browser Gamepad API integration
* ✅ **Debug Snapshots** - F9 dumps mapper/PPU state at configurable scanline

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
        ├── mapper005-audio.js  # MMC5 expansion audio
        ├── mapper006.js        # FFE
        ├── mapper007.js        # AxROM
        ├── mapper009.js        # MMC2
        ├── mapper011.js        # Color Dreams
        ├── mapper025.js        # VRC2 / VRC4
        ├── mapper034.js        # BNROM / NINA-001
        ├── mapper047.js        # NES-QJ
        ├── mapper066.js        # GxROM
        ├── mapper069.js        # Sunsoft FME-7 / 5B
        ├── mapper079.js        # NINA-03 / NINA-06
        ├── mapper206.js        # DxROM
        ├── ...
        └── mapper-factory.js   # Mapper instantiation factory
```

## Supported Mappers

| Mapper                 | Status      | Notes                                        |
| ---------------------- | :---------: | -------------------------------------------- |
| NROM (0)               | ✅          | Baseline mapper                              |
| MMC1 (1)               | ✅          | Correct shift‑register behavior              |
| UxROM (2)              | ✅          | PRG banking                                  |
| CNROM (3)              | ✅          | CHR banking                                  |
| MMC3 (4)               | ✅          | A12‑driven IRQs                              |
| MMC5 (5)               | ✅          | ExRAM + split screen + MMC5 audio            |
| MMC6 (6)               | ✅          | Extension of MMC3                            |
| AxROM (7)              | ✅          | 1KB VRAM page switching for nametables       |
| MMC2 (9)               | ✅          | Accurate CHR latch timing (Punch‑Out!!!)     |
| MMC4 (10)              | ✅          | Dual latch variant                           |
| Color Dreams (11)      | ✅          | 32KB PRG bank switching                      |
| VRC2 / VRC4 (25)       | ✅          | 8-bit CHR registers (up to 256KB CHR)        |
| NINA-001 (34)          | ✅          | 2x 4KB CHR bank switching                    |
| NES-QJ (47)            | ✅          | Each block has 128k PRG and 128k CHR         |
| GxROM (66)             | ✅          | CHR-ROM: 8KB switchable banks                |
| Sunsoft FME-7 (69)     | ✅          | PRG/CHR banking + IRQ; 5B audio regs tracked |
| NINA-03 / NINA-06 (79) | ✅          | CHR-ROM: 8KB switchable banks                |
| DxROM (206)            | ✅          | Extends MMC3 \| No Scanline IRQ              |

## Design Philosophy

This emulator intentionally avoids hard‑coding mapper IDs inside the PPU or CPU. Instead:

* Each mapper is modular - in its own file as if it were a hardware component, which then **declares behavioral capabilities** (e.g., CHR latch, A12 IRQ, nametable override, etc.)
* The PPU calls mapper hooks **only when the corresponding capability flag is set**
* If a capability is declared, the mapper guarantees the required method exists

This approach prevents cross‑mapper regressions and makes new mappers significantly easier to add while expanding the library of games that can run.

For deep technical details, see **[TECHNICAL.md](https://github.com/ZeroGlitchX/ai-NES/blob/main/docs/TECHNICAL.md)**.

## Development Notes

### Audio System

The emulator uses an **AudioWorklet-based** audio system:

- Runs on a dedicated audio thread for glitch-free playback
- Audio samples are batched and sent to the worklet to minimize postMessage overhead
- Expansion audio sources (such as MMC5) are mixed into the APU output path

### Save States

- **F5** — Quick save to current slot
- **F8** — Quick load from current slot
- Multiple save slots available via UI dropdown

### Debugging

The debug module (`debug/debug.js`) provides Mesen-comparable state dumps:

- **F9** — Request snapshot at scanline 241 (VBlank start)
- Outputs PPU registers, nametables, palette, OAM, scroll state
- MMC5 games include full mapper state + audio registers
- Console access: `nesDebug.outputAll()` or `nesDebug.targetScanline = 100`

See `docs/DEBUG INTEGRATION.md` for full documentation.

## Credits

This emulator is inspired by other JavaScript NES emulators, but coded to behave like console reference emulators. The CPU, PPU and APU are built from the ground up to behave like NES hardware.

Contributed by **ZeroGlitchX** and an assortment of AI friends.

AI Coding Assistance:
- **[Gemini Pro 3](https://gemini.google.com/)**
- **[Claude Code](https://claude.com/)**
- **[ChatGPT/Codex](https://chatgpt.com/)**
- **[Copilot](https://copilot.microsoft.com/)**

### Additional Credits

Thanks to the creators of various reference emulators. Extremely valuable for the mapper conversions from C++ to JavaScript. Most notably:

#### Primary Reference Emulators

- **[Mesen](https://github.com/SourMesen/Mesen2)**
- **[Higan](https://github.com/higan-emu/higan)**
- **[WebNES](https://github.com/peteward44/WebNES)**
- **[JSNES](https://github.com/bfirsh/jsnes)**

And a special thanks to **[AccuracyCoin](https://github.com/100thCoin/AccuracyCoin/tree/main)**, which assisted greatly with game compatibility through accuracy testing and accuracy implementation.

## Compatibility Notes

If you want to make any improvements, please take a look at the **[TECHNICAL.md](https://github.com/ZeroGlitchX/ai-NES/blob/main/docs/TECHNICAL.md)** document and give it a whirl! Currently, there is no native or intentional support for homebrew. This release focuses on commercial releases.

There are about 15 games with compatibility issues that I know of:

| No   | Mapper           |               Game               | Notes                                         |
| :--: | ---------------- | :------------------------------: | --------------------------------------------- |
| 1    | Mapper 7 (AxROM) |          Super Off-Road          | Freezes on game load                          |
| 2    | Mapper 4 (MMC3)  |       Adventures of Lolo 2       | Freezes after pressing start title screen     |
| 3    | Mapper 4 (MMC3)  |      Bram Stoker's Dracula       | Game doesn't start                            |
| 4    | Mapper 4 (MMC3)  |          Burai Fighter           |                                               |
| 5    | Mapper 4 (MMC3)  |             G.I. Joe             | Freezes shortly after entering game play area |
| 6    | Mapper 4 (MMC3)  |  Golgo 13: The Mafat Conspiracy  | Graphical artifacts / Glitchy                 |
| 7    | Mapper 4 (MMC3)  |            Home Alone            | Game doesn't start                            | 
| 8    | Mapper 4 (MMC3)  |     Disney's The Jungle Book     |                                               |
| 9    | Mapper 4 (MMC3)  |           Kick Master            |                                               |
| 10   | Mapper 4 (MMC3)  |        Krusty's Fun House        |                                               |
| 11   | Mapper 4 (MMC3)  |       Legacy of the Wizard       |                                               |
| 12   | Mapper 4 (MMC3)  | Mickey's Adventure in Numberland |                                               |
| 13   | Mapper 4 (MMC3)  |  Mickey's Safari in Letterland   |                                               |
| 14   | Mapper 4 (MMC3)  |   Star Trek: 25th Anniversary    | Graphical artifacts / Glitchy                 |
| 15   | Mapper 1 (MMC1)  |           Air Fortress           | Game doesn't start                            |

## License

This project is licensed under the GPL v3 license.

## Legal

This emulator does not include any copyrighted ROM files. You must provide your own legally obtained ROM dumps to use with this emulator.

## Support

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/zeroglitchx)

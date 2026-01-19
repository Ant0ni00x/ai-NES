# AI-NES Debug Module Integration Guide

## Overview

The debug module provides Mesen-comparable output of emulator state, triggered by F9. It uses a **non-invasive architecture** - reading PPU/CPU/mapper state without modifying core emulator code.

## Current Integration (nes-init.js)

The debug module is integrated in `src/nes-init.js`:

```javascript
import { NESDebug } from '../debug/debug.js';

// After NES instance creation:
const nesDebug = new NESDebug(nes);
nesDebug.bindKey(document, 'F9');
window.nesDebug = nesDebug;

// PPU step wrapper for scanline-triggered snapshots
const originalPpuStep = nes.ppu.step.bind(nes.ppu);
nes.ppu.step = function() {
  const result = originalPpuStep();
  if (this.cycle === 0) {
    nesDebug.checkTrigger();
  }
  return result;
};
```

### How It Works

1. **F9 key** requests a debug snapshot
2. The PPU step wrapper checks at cycle 0 of each scanline
3. When `targetScanline` (default: 241/VBlank) is reached, `outputAll()` fires
4. Full PPU/mapper state is logged to the browser console

## Components Accessed (Read-Only)

| Component | Properties Read |
|-----------|-----------------|
| `nes.ppu` | `scanline`, `cycle`, `vramMem`, `ctrl`, `mask`, `oamAddr`, `oam`, `v`, `t`, `w`, `x`, `palette`, `mirroring`, `mirrorAddress()`, `readVRAM()` |
| `nes.cpu` | `mem[0x2002]` (PPU status) |
| `nes.mmap` | MMC5 mapper properties (with fallback alternatives) |

## Output Sections

Press **F9** to output:

1. **CHR ROM/RAM** - Pattern table samples ($0000-$1FFF)
2. **PPU Registers** - $2000-$2007, $4014 with decoded flags
3. **Nametables** - All 4 nametables + attribute tables
4. **Palette** - Background and sprite palettes
5. **Scroll Info** - v/t/x/w registers
6. **OAM** - First 8 sprites with decoded attributes
7. **MMC5 State** - Full mapper state (if MMC5 game)

## Console Commands

After initialization, use these in browser console:

```javascript
// Full debug output (immediate, ignores scanline)
nesDebug.outputAll();

// Individual sections
nesDebug.outputPPURegisters();
nesDebug.outputNametables();
nesDebug.outputPalette();
nesDebug.outputScrollInfo();
nesDebug.outputOAM();
nesDebug.outputMMC5State();
nesDebug.outputCHR();

// Change target scanline (0-261)
nesDebug.targetScanline = 100;

// Check current scanline
nesDebug.currentScanline;
```

## Sample Output

```
============================================================
NES DEBUG OUTPUT - 2024-12-17T15:30:00.000Z
============================================================
Current Scanline: 241

--- PPU Registers ---
PPUCTRL    $2000 = $88
  Nametable Base:     0 ($2000)
  VRAM Increment:     0 (+1)
  Sprite Pattern:     0 ($0000)
  BG Pattern:         1 ($1000)
  Sprite Size:        8x8
  NMI Enable:         1
PPUMASK    $2001 = $1E
  Grayscale:          0
  Show BG Left 8:     1
  Show Sprite Left 8: 1
  Show BG:            1
  Show Sprites:       1
  Emphasis:           R=0 G=0 B=0

--- Scroll State ---
Fine X:         0
VRAM Address:   $2000
Latch Address:  $2000
Write Toggle:   0

--- OAM (Sprite Memory) ---
First 8 sprites (32 bytes):
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
...

--- MMC5 State ---
$5100 PRG Mode              = 3 ($03)
  Mode: 8KB×4
$5101 CHR Mode              = 3 ($03)
  Mode: 1KB×8
$5104 Extended RAM Mode     = 1 ($01)
  1: Extended Attribute
$5105 Nametable Mapping     = $44
  NT0: CIRAM A  NT1: CIRAM B  NT2: CIRAM A  NT3: CIRAM B
============================================================
```

## Comparing with Mesen

1. Load the same ROM in both emulators
2. Press F9 in AI-NES (waits for scanline 241 by default)
3. Compare with Mesen's Debug views

| AI-NES Debug | Mesen Location |
|--------------|----------------|
| PPUCTRL/MASK | Debug → PPU Status |
| Nametables | Debug → Nametable Viewer |
| Palette | Debug → Palette Viewer |
| Scroll (v/t/x/w) | Debug → PPU Status |
| OAM | Debug → Sprite Viewer |
| MMC5 State | Debug → Memory Viewer ($5100-$5206) |

## Architecture Notes

### Non-Invasive Design

The debug module only **reads** emulator state - it never modifies PPU, CPU, or mapper internals. The only "modification" is the PPU step wrapper, which:
- Preserves original behavior (calls original step, returns its result)
- Adds a lightweight check at cycle 0 of each scanline
- Can be removed without affecting emulation

### Alternative: Manual Triggering Only

If you want zero PPU modification, skip the step wrapper:

```javascript
const nesDebug = new NESDebug(nes);
nesDebug.bindKey(document, 'F9');
window.nesDebug = nesDebug;
// No step wrapper - F9 triggers immediate output at current state
```

Then modify `bindKey` or call `outputAll()` directly instead of using scanline-triggered snapshots.

## Customization

### Change trigger key:

```javascript
nesDebug.bindKey(document, 'F10');
```

### Multiple keys for different outputs:

```javascript
document.addEventListener('keydown', (e) => {
    switch(e.key) {
        case 'F9': nesDebug.outputAll(); break;
        case 'F10': nesDebug.outputPPURegisters(); break;
        case 'F11': nesDebug.outputMMC5State(); break;
    }
});
```

### Change snapshot scanline:

```javascript
// Capture at scanline 100 instead of 241
nesDebug.targetScanline = 100;
```

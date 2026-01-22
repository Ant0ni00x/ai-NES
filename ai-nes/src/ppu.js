import { toJSON, fromJSON } from "./utils.js";

// ============================================================================
// PPU (WebNES-style core)
// Module 1: Registers, VRAM, scrolling, NMI, OAM, palette, mirroring
// No rendering logic yet.
// ============================================================================

export class PPU {
  constructor(nes) {
    this.nes = nes;

    // Status flag bit positions
    this.STATUS_SPRITE_OVERFLOW = 5;
    this.STATUS_SPRITE0HIT = 6;
    this.STATUS_VBLANK = 7;

    // -----------------------------
    // VRAM (2 KB internal)
    // -----------------------------
    this.vramMem = new Uint8Array(0x8000); // Unified VRAM (Pattern Tables + Nametables)

    // -----------------------------
    // OAM (Sprite RAM)
    // -----------------------------
    this.oam = new Uint8Array(256);
    this.oamAddr = 0;

    // -----------------------------
    // Palette RAM (32 bytes)
    // -----------------------------
    this.palette = new Uint8Array(32);

    // -----------------------------
    // PPU Registers
    // -----------------------------
    this.ctrl = 0;   // $2000
    this.mask = 0;   // $2001
    // this.status = 0; // $2002
    this.oamData = 0; // $2004
    this.scrollReg = 0; // $2005
    this.addrReg = 0;   // $2006
    this.dataReg = 0;   // $2007

    // -----------------------------
    // Loopy registers (scrolling)
    // -----------------------------
    this.v = 0;   // Current VRAM address (15 bits)
    this.t = 0;   // Temporary VRAM address (15 bits)
    this.x = 0;   // Fine X scroll (3 bits)
    this.w = 0;   // Write toggle
    this.ioBus = 0; // Simulated PPU I/O bus (latch)

    // -----------------------------
    // Frame / scanline state
    // -----------------------------
    this.scanline = 0;
    this.cycle = 0;
    this.frame = 0;

    // -----------------------------
    // NMI
    // -----------------------------
    this.nmiOccurred = false;
    this.nmiOutput = false;
    this.nmiPrevious = false;
    this.nmiDelay = 0;

    // -----------------------------
    // Buffered VRAM reads
    // -----------------------------
    this.bufferedRead = 0;

    // -----------------------------
    // Mirroring mode (set by mapper)
    // 0 = horizontal, 1 = vertical, 2 = single-screen 0, 3 = single-screen 1
    // -----------------------------
    this.mirroring = 0;

    // -----------------------------
    // Framebuffer (32-bit RGB) 256x240
    // -----------------------------
    this.framebuffer = new Uint32Array(256 * 240);

    // UI expects to draw from here:
    this.outputBuffer = this.framebuffer;

    // -----------------------------
    // Internal flags
    // -----------------------------
    this.oddFrame = false;
    this.frameComplete = false;

    // -----------------------------
    // Sprite evaluation state
    // -----------------------------
    this.secondaryOAM = new Uint8Array(32); // up to 8 sprites * 4 bytes
    this.spriteCount = 0;
    this.spritePatternsLow = new Uint8Array(8);
    this.spritePatternsHigh = new Uint8Array(8);
    this.spriteX = new Uint8Array(8);
    this.spriteAttributes = new Uint8Array(8);
    this.spriteIndices = new Uint8Array(8); // original OAM indices (for sprite 0 hit)

    // -----------------------------
    // Background shift registers (16-bit) - hold 2 tiles worth of pattern data
    // -----------------------------
    this.bgShiftLow = 0;   // 16-bit shift register for pattern low bits
    this.bgShiftHigh = 0;  // 16-bit shift register for pattern high bits

    // Background attribute shift registers (16-bit, but only use low 8 bits per tile)
    this.bgAttrShiftLow = 0;   // 16-bit shift register for attribute low bit
    this.bgAttrShiftHigh = 0;  // 16-bit shift register for attribute high bit

    // Tile data latches (fetched during 8-cycle tile fetch, loaded into shift regs on cycle 0)
    this.bgTileIndex = 0;      // Nametable byte (which tile)
    this.bgAttrByte = 0;       // Attribute byte (which palette)
    this.bgTileLow = 0;        // Pattern table low byte
    this.bgTileHigh = 0;       // Pattern table high byte;
    this.ppuA12Prev = 0;       // Previous state of PPU address bus A12
    this.lastA12HighScanline = -1;
    this.lastA12HighCycle = -1;

    this.powerOn();
  }

  // =========================================================================
  // Reset PPU
  // =========================================================================
  powerOn() {
    // On power-on, VRAM/OAM/Palette are undefined. For emulation, we use
    // deterministic states that are common for compatibility.
    this.vramMem.fill(0);
    this.palette.fill(0);
    this.oam.fill(0xFF); // Hide all sprites
    this.inWarmup = true;
    this.reset(); 
  }

  reset() {
    this.ctrl = 0;
    this.mask = 0;
    this.status = 0x00; // VBlank flag is clear on power-on/reset
    this.nmiOccurred = false; // Sync internal flag with status register
    this.oamAddr = 0;

    this.v = 0;
    this.t = 0;
    this.x = 0;
    this.w = 0;
    this.ioBus = 0;

    this.ppuA12Prev = 0;
    this.lastA12HighScanline = -1;
    this.lastA12HighCycle = -1;
    this.scanline = 0;
    this.cycle = 0;
    this.frame = 0;
    this.oddFrame = false; // Default to starting on an even frame.

    this.nmiOutput = false;
    this.nmiPrevious = false;
    this.nmiDelay = 0;

    this.bufferedRead = 0;

    this.spriteCount = 0;
    //this.vramMem.fill(0);
  }

  // =========================================================================
  // Mirroring (mapper sets this)
  // =========================================================================
  setMirroring(mode) {
    this.mirroring = mode;
  }

  // =========================================================================
  // CPU reads from PPU registers
  // =========================================================================
  readRegister(addr) {
    let result = this.ioBus;

    switch (addr & 7) {
      case 2: // $2002 - status register
        // Status drives bits 7-5; bits 4-0 come from the I/O bus (open bus)
        result = (this.status & 0xE0) | (this.ioBus & 0x1F);

        // Race condition: Reading $2002 at the exact start of VBlank (Scanline 241, Cycle 1)
        // returns the VBlank flag as CLEAR, but still clears the internal flag (suppressing NMI).
        if (this.scanline === 241 && this.cycle === 1) {
             result &= 0x7F; // Clear bit 7 (VBlank) in result
        }

        this.setStatusFlag(this.STATUS_VBLANK, false);
        this.nmiOccurred = false;
        this.nmiChange();
        this.w = 0;
        break;

      case 4: // $2004
        result = this.oam[this.oamAddr];
        break;

      case 7: { // $2007
        const vramAddr = this.v & 0x3FFF;
        if (vramAddr >= 0x3F00) {
          // Palette reads are immediate, but the buffer is filled with the underlying nametable data.
          result = this.readPalette(vramAddr);
          // Nametable data is mirrored under the palette, so we read from VRAM for the buffer.
          this.bufferedRead = this.vramMem[this.mirrorAddress(vramAddr)];
        } else {
          // All other reads are buffered. The value returned is from the previous read.
          result = this.bufferedRead;
          // The buffer is then filled with the value at the current address for the *next* read.
          this.bufferedRead = this.readVRAM(vramAddr);
        }
        // VRAM address is incremented after the read.
        this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
        break;
      }
    }
    this.ioBus = result;
    return result;
  }

  // =========================================================================
  // CPU writes to PPU registers
  // =========================================================================
  writeRegister(addr, value) {
    const reg = addr & 7;
    this.ioBus = value; // Update I/O bus latch

    /* PPU warm-up: During warmup (~29,658 CPU cycles), the PPU is warming up and ignores writes to some registers.
       Real NES behavior: Writes to $2000, $2001, $2005, $2006 are ignored. */
    if (this.inWarmup && (reg === 0 || reg === 1 || reg === 5 || reg === 6)) {
      return; // Silently ignore writes to PPUCTRL, PPUMASK, PPUSCROLL, PPUADDR during warmup
    }

    switch (reg) {
      case 0: // $2000
        this.ctrl = value;
        this.t = (this.t & 0xF3FF) | ((value & 0x03) << 10);
        this.nmiOutput = (value >> 7) & 1;
        this.nmiChange();
        if (this.nes.mmap && typeof this.nes.mmap.onPpuRegisterWrite === 'function') {
          this.nes.mmap.onPpuRegisterWrite(0x2000, value);
        }
        break;

      case 1: // $2001 - PPUMASK
        this.mask = value;
        // Update palette emphasis if supported by PaletteTable
        if (this.nes.palTable && typeof this.nes.palTable.setEmphasis === 'function') {
            this.nes.palTable.setEmphasis((value >> 5) & 7);
        }
        if (this.nes.mmap && typeof this.nes.mmap.onPpuRegisterWrite === 'function') {
          this.nes.mmap.onPpuRegisterWrite(0x2001, value);
        }
        break;

      case 2: // $2002 - status register
        // Writes to $2002 are ignored
        break;

      case 3: // $2003
        this.oamAddr = value;
        break;

      case 4: // $2004
        const renderingEnabled = (this.mask & 0x18) !== 0;
        const onScreenScanline = this.scanline >= 0 && this.scanline < 240;

        if (renderingEnabled && onScreenScanline) {
            // OAMADDR bug: During rendering, writes to OAMDATA are ignored,
            // but OAMADDR is incremented "glitchily" (by 4).
            this.oamAddr = (this.oamAddr + 4) & 0xFF;
        } else {
            // Normal behavior outside of rendering
            if ((this.oamAddr & 3) === 2) {
              value &= 0xE3; // Clear bits 2-4 of attribute byte
            }
            this.oam[this.oamAddr++] = value;
            this.oamAddr &= 0xFF;
        }
        break;

      case 5: // $2005 (scroll)
        if (this.w === 0) {
          this.x = value & 7;
          this.t = (this.t & 0xFFE0) | (value >> 3);
          this.w = 1;
        } else {
          // Combine Fine Y and Coarse Y writes into a single atomic operation
          const fineY = (value & 0x07) << 12;
          const coarseY = (value & 0xF8) << 2;
          this.t = (this.t & 0x8C1F) | fineY | coarseY;
          this.w = 0;
        }
        break;

      case 6: // $2006 (VRAM address)
        if (this.w === 0) {
          this.t = (this.t & 0x00FF) | ((value & 0x3F) << 8);
          this.w = 1;
        } else {
          this.t = (this.t & 0xFF00) | value;
          this.v = this.t;
          this.w = 0;
        }
        if (this.nes.mmap && typeof this.nes.mmap.onPpuRegisterWrite === 'function') {
          this.nes.mmap.onPpuRegisterWrite(0x2006, value);
        }
        break;

      case 7: // $2007 (VRAM data)
        this.writeVRAM(this.v, value);
        this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
        break;
    }
  }

  // =========================================================================
  // VRAM read/write with mirroring
  // =========================================================================
  readVRAM(addr) {
    addr &= 0x3FFF;

    // Mapper interception for CHR (Pattern Tables)
    if (addr < 0x2000 && this.nes.mmap && typeof this.nes.mmap.ppuRead === 'function') {
      const val = this.nes.mmap.ppuRead(addr);
      if (val !== null && val !== undefined) return val;
    }

    if (addr < 0x3F00) {
      // Nametables ($2000-$3EFF) may be overridden by mapper (e.g., MMC5 ExRAM/Fill)
      if (addr >= 0x2000 && this.nes.mmap?.hasNametableOverride && typeof this.nes.mmap.readNametable === 'function') {
        const ntVal = this.nes.mmap.readNametable(addr, 'cpu');
        if (ntVal !== null && ntVal !== undefined) return ntVal;
      }

      // Pattern Tables ($0000-$1FFF) are pre-loaded into vramMem by Mapper
      // Nametables ($2000-$3EFF) are also in vramMem (or mapped by override above)
      return this.vramMem[this.mirrorAddress(addr)];
    }
    // Palettes are handled separately
    return this.readPalette(addr);
  }

  writeVRAM(addr, value) {
    addr &= 0x3FFF;

    if (addr < 0x3F00) {
      // Mapper interception for CHR (Pattern Tables) - e.g. CHR-RAM
      if (addr < 0x2000 && this.nes.mmap && typeof this.nes.mmap.ppuWrite === 'function') {
        if (this.nes.mmap.ppuWrite(addr, value)) return;
      } else if (addr >= 0x2000 && this.nes.mmap?.hasNametableOverride && typeof this.nes.mmap.setNametableByte === 'function') {
        // Nametable writes via mapper (ExRAM/fill)
        this.nes.mmap.setNametableByte(addr, value);
        return;
      }

      const mirroredAddr = this.mirrorAddress(addr);
      this.vramMem[mirroredAddr] = value;
      return;
    }

    // Palette writes ($3F00-$3FFF)
    this.writePalette(addr, value);
  }

  // =========================================================================
  // Nametable mirroring
  // =========================================================================
  mirrorAddress(addr) {
    // Pattern tables ($0000-$1FFF) are not mirrored by this function usually,
    // but we pass them through for unified access.
    if (addr < 0x2000) return addr;

    const a = addr & 0x0FFF;
    const table = a >> 10;
    const offset = a & 0x03FF;

    switch (this.mirroring) {
      case 0: // horizontal
        // Tables 0/1 map to VRAM $2000, Tables 2/3 map to VRAM $2400
        return 0x2000 + ((table < 2) ? offset : offset + 0x400);

      case 1: // vertical
        // Tables 0/2 map to VRAM $2000, Tables 1/3 map to VRAM $2400
        return 0x2000 + ((table % 2 === 0) ? offset : offset + 0x400);

      case 2: // single-screen 0
        return 0x2000 + offset;

      case 3: // single-screen 1
        return 0x2000 + offset + 0x400;

      case 4: // four-screen
        // No mirroring, use address directly within the 4KB nametable space
        return 0x2000 + a;
    }
    // Fallback (shouldn't happen): keep in 2KB nametable space
    return 0x2000 + (a & 0x07FF);
  }

  // =========================================================================
  // Low-level PPU fetch helpers | Fetch nametable byte at current v address
  // =========================================================================
  fetchNametableByte() {
    const addr = 0x2000 | (this.v & 0x0FFF);
    this.checkA12(addr);
    if (this.nes.mmap?.hasNametableOverride) {
        const val = this.nes.mmap.readNametable(addr, 'tile');
        if (val !== null && val !== undefined) return val;
    }
    return this.vramMem[this.mirrorAddress(addr)];
  }

  // Fetch attribute byte for current v address
  fetchAttributeByte() {
    const v = this.v;

    // Coarse X/Y
    const coarseX = v & 0x1F;
    const coarseY = (v >> 5) & 0x1F;

    // Nametable select (bit 10/11)
    const nt = (v >> 10) & 0x03;
    const ntBase = 0x2000 + (nt * 0x400);

    // Attribute table base: +0x3C0 inside nametable
    const attrAddr =
      ntBase +
      0x3C0 +
      ((coarseY >> 2) * 8) +
      (coarseX >> 2);

    this.checkA12(attrAddr);

    // MMC5 ExRAM support: Use coordinate-based lookup (Mesen-style)
    if (this.nes.mmap?.hasPerTileAttributes && typeof this.nes.mmap.getExtendedAttributeByte === 'function') {
        const val = this.nes.mmap.getExtendedAttributeByte(coarseX, coarseY);
        if (val !== null && val !== undefined) return val;
    }

    if (this.nes.mmap && typeof this.nes.mmap.ppuRead === 'function') {
      const val = this.nes.mmap.ppuRead(attrAddr, 'attribute');
      if (val !== null && val !== undefined) {
        // Mapper may return replicated palette bits (e.g., MMC5 uses 0x55/0xAA).
        const shift = ((coarseY & 0x02) ? 4 : 0) | ((coarseX & 0x02) ? 2 : 0);
        return (val >> shift) & 0x03;
      }
    }

    if (this.nes.mmap?.hasNametableOverride) {
        const val = this.nes.mmap.readNametable(attrAddr, 'attribute');
        if (val !== null && val !== undefined) return val; // Mapper can override attribute fetch
    }

    const attrByte = this.vramMem[this.mirrorAddress(attrAddr)];

    // Select 2 bits based on quadrant (bit ops instead of ternary)
    const shift = ((coarseY << 1) & 0x04) | (coarseX & 0x02);

    return (attrByte >> shift) & 0x03;
  }

  // Fetch background pattern low byte
  fetchBgPatternLow(tileIndex, fineY) {
    const patternBase = (this.ctrl & 0x10) ? 0x1000 : 0x0000;
    const addr = patternBase + (tileIndex << 4) + fineY;
    this.checkA12(addr);
    if (this.nes.mmap && typeof this.nes.mmap.ppuRead === 'function') {
      const val = this.nes.mmap.ppuRead(addr, 'bg');
      if (val !== null && val !== undefined) return val;
    }
    return this.vramMem[addr];
  }

  // Fetch background pattern high byte
  fetchBgPatternHigh(tileIndex, fineY) {
    const patternBase = (this.ctrl & 0x10) ? 0x1000 : 0x0000;
    const addr = patternBase + (tileIndex << 4) + fineY + 8;
    this.checkA12(addr);
    if (this.nes.mmap && typeof this.nes.mmap.ppuRead === 'function') {
      const val = this.nes.mmap.ppuRead(addr, 'bg');
      if (val !== null && val !== undefined) return val;
    }
    return this.vramMem[addr];
  }

  // Fetch sprite pattern low byte
  fetchSpritePatternLow(tileIndex, fineY, is8x16, topTileIndex) {
    if (!is8x16) {
      const patternBase = (this.ctrl & 0x08) ? 0x1000 : 0x0000;
      const addr = patternBase + (tileIndex << 4) + fineY;
      this.checkA12(addr);
      if (this.nes.mmap && this.nes.mmap.ppuRead) {
        const val = this.nes.mmap.ppuRead(addr, 'sprite');
        if (val !== null && val !== undefined) return val;
      }
      return this.vramMem[addr];
    }

    // 8x16 sprites: pattern table is from tile bit0, tile index from bits7..1
    const bank = (topTileIndex & 1) ? 0x1000 : 0x0000;
    const addr = bank + (tileIndex << 4) + fineY;
    if (this.nes.mmap && typeof this.nes.mmap.ppuRead === 'function') {
      this.checkA12(addr);
      const val = this.nes.mmap.ppuRead(addr, 'sprite');
      if (val !== null && val !== undefined) return val;
    }
    return this.vramMem[addr];
  }

  // Fetch sprite pattern high byte
  fetchSpritePatternHigh(tileIndex, fineY, is8x16, topTileIndex) {
    if (!is8x16) {
      const patternBase = (this.ctrl & 0x08) ? 0x1000 : 0x0000;
      const addr = patternBase + (tileIndex << 4) + fineY + 8;
      this.checkA12(addr);
      if (this.nes.mmap && this.nes.mmap.ppuRead) {
        const val = this.nes.mmap.ppuRead(addr, 'sprite');
        if (val !== null && val !== undefined) return val;
      }
      return this.vramMem[addr];
    }

    const bank = (topTileIndex & 1) ? 0x1000 : 0x0000;
    const addr = bank + (tileIndex << 4) + fineY + 8;
    if (this.nes.mmap && typeof this.nes.mmap.ppuRead === 'function') {
      this.checkA12(addr);
      const val = this.nes.mmap.ppuRead(addr, 'sprite');
      if (val !== null && val !== undefined) return val;
    }
    return this.vramMem[addr];
  }

  // Decode a single 2-bit pixel from pattern bytes
  decodePixel(patternLow, patternHigh, bitIndex) {
    const bit = 7 - bitIndex;
    const lo = (patternLow >> bit) & 1;
    const hi = (patternHigh >> bit) & 1;
    return lo | (hi << 1);
  }

  // =========================================================================
  // Background pixel fetch (logical, no framebuffer write yet)
  // =========================================================================
  //
  // Returns: 
  //   { colorIndex: 0-3, paletteIndex: 0-3, finalPaletteEntry: 0-31 }
  // Or null if BG is disabled.
  getBackgroundPixel() {
    if ((this.mask & 0x08) === 0) {
      // Background disabled
      return null;
    }

    // Extract pixel from shift registers using fine X scroll
    // Shift registers are 16-bit, bit 15 is the current pixel
    // The live fine X scroll value (this.x) selects which of the 8 pixels in the high byte to use.
    const bitPos = 15 - this.x;

    // Extract 2-bit color index from pattern shift registers
    const lo = (this.bgShiftLow >> bitPos) & 1;
    const hi = (this.bgShiftHigh >> bitPos) & 1;
    const colorIndex = lo | (hi << 1);

    // Extract 2-bit palette index from attribute shift registers
    // Use same bit position as pattern (attributes replicated across 8 pixels)
    const attrLo = (this.bgAttrShiftLow >> bitPos) & 1;
    const attrHi = (this.bgAttrShiftHigh >> bitPos) & 1;
    const paletteIndex = attrLo | (attrHi << 1);

    const finalPaletteEntry = (paletteIndex << 2) | colorIndex; // 0-31

    return {
      colorIndex,
      paletteIndex,
      finalPaletteEntry
    };
  }

  // =========================================================================
  // Get sprite pixel at current (scanline, x)
  // Returns:
  //   { colorIndex, paletteIndex, priority, isSprite0 } or null
  // =========================================================================
  getSpritePixel(x, y) {
    if ((this.mask & 0x10) === 0) {
      // Sprites disabled
      return null;
    }

    const spriteHeight = (this.ctrl & 0x20) ? 16 : 8;

    for (let i = 0; i < this.spriteCount; i++) {
      const patternLow = this.spritePatternsLow[i];
      const patternHigh = this.spritePatternsHigh[i];
      const spriteX = this.spriteX[i];
      const attributes = this.spriteAttributes[i];

      const flipHorizontal = (attributes & 0x40) !== 0;
      const paletteIndex = attributes & 0x03;
      const priority = (attributes & 0x20) !== 0; // true = behind BG

      const xOffset = x - spriteX;
      if (xOffset < 0 || xOffset >= 8) continue;

      // Choose bit index (flip horizontal means read bits in reverse order)
      const bitIndex = flipHorizontal ? (7 - xOffset) : xOffset;
      const colorIndex = this.decodePixel(patternLow, patternHigh, bitIndex);

      if (colorIndex === 0) continue; // transparent

      const isSprite0 = (this.spriteIndices[i] === 0);

      return {
        colorIndex,      // 1-3
        paletteIndex,    // 0-3
        priority,        // bool: true = behind BG
        isSprite0
      };
    }

    return null;
  }

  // =========================================================================
  // Background pixel rendering (one pixel at current scanline/cycle)
  // =========================================================================
  renderBackgroundPixel() {
    const x = this.cycle - 1;
    const y = this.scanline;
    const idx = (y << 8) + x;

    // If background disabled, just draw backdrop color
    if ((this.mask & 0x08) === 0) {
      const backdropIndex = this.readPalette(0) & 0x3F;
      const rgb = this.nes.palTable
        ? this.nes.palTable.getEntry(backdropIndex)
        : 0;
      this.framebuffer[idx] = rgb;
      return;
    }

    const bg = this.getBackgroundPixel();
    if (!bg) {
      const backdropIndex = this.readPalette(0) & 0x3F;
      const rgb = this.nes.palTable
        ? this.nes.palTable.getEntry(backdropIndex)
        : 0;
      this.framebuffer[idx] = rgb;
      return;
    }

    const colorIndex = bg.colorIndex;
    const finalPaletteEntry = bg.finalPaletteEntry;

    if (colorIndex === 0) {
      // Transparent: use backdrop
      const backdropIndex = this.readPalette(0) & 0x3F;
      const rgb = this.nes.palTable
        ? this.nes.palTable.getEntry(backdropIndex)
        : 0;
      this.framebuffer[idx] = rgb;
    } else {
      const paletteAddr = 0x3F00 | finalPaletteEntry;
      const palValue = this.readPalette(paletteAddr) & 0x3F;
      const rgb = this.nes.palTable
        ? this.nes.palTable.getEntry(palValue)
        : 0;
      this.framebuffer[idx] = rgb;
    }
  }

  setStatusFlag(flag, value) {
    const n = 1 << flag;
    if (value) {
      this.status |= n;
    } else {
      this.status &= ~n;
    }
  }

  // Helper to read status (for consistency)
  getStatus() {
    return this.status;
  }

// =========================================================================
// Final pixel renderer: mixes BG + sprites, sets sprite 0 hit
// =========================================================================
renderPixel() {
  const x = this.cycle - 1;
  const y = this.scanline;
  const idx = (y << 8) + x;

  if (x < 0 || x >= 256) return;   // safety

  const renderingEnabled = (this.mask & 0x08) || (this.mask & 0x10);

  if (!renderingEnabled) {
    // Very important: show backdrop color even when rendering disabled
    let backdrop = this.readPalette(0x3F00) & 0x3F;
    if (this.mask & 0x01) {
      backdrop &= 0x30;
    }
      this.framebuffer[(y << 8) + x] = this.nes.palTable ? this.nes.palTable.getEntry(backdrop) : 0;
    return;
  }

  // --- Background pixel ---
  let bg = null;
  let bgColorIndex = 0;
  let bgPaletteEntry = 0;
  const bgEnabled = (this.mask & 0x08) !== 0;
  const showBgLeft8 = (this.mask & 0x02) !== 0; // PPUMASK bit 1

  if (bgEnabled && (x >= 8 || showBgLeft8)) {
    bg = this.getBackgroundPixel();
    if (bg) {
      bgColorIndex = bg.colorIndex;
      bgPaletteEntry = bg.finalPaletteEntry;
    }
  }

  // --- Sprite pixel ---
  const spriteEnabled = (this.mask & 0x10) !== 0;
  const showSpritesLeft8 = (this.mask & 0x04) !== 0; // PPUMASK bit 2
  const sprite = (spriteEnabled && (x >= 8 || showSpritesLeft8)) ? this.getSpritePixel(x, y) : null;

  // Compute final color
  let finalRgb = 0;
  const backdropIndex = this.readPalette(0) & 0x3F;
  const getRgb = (palIndex) => {
    let v = palIndex & 0x3F;
    if (this.mask & 0x01) {
      v &= 0x30;
    }
    return this.nes.palTable
      ? this.nes.palTable.getEntry(v)
      : 0;
  };

  if (!bgEnabled && !spriteEnabled) {
    // Neither enabled: just backdrop
    finalRgb = getRgb(backdropIndex);
  } else {
    let useSprite = false;
    let spriteColorIndex = 0;
    let spritePaletteEntry = 0;

    if (sprite && spriteEnabled) {
      spriteColorIndex = sprite.colorIndex;
      spritePaletteEntry = (sprite.paletteIndex << 2) | sprite.colorIndex; // 0-15

      if (bgColorIndex === 0) {
        // BG transparent, sprite wins
        useSprite = true;
      } else {
        // Both non-transparent: check priority
        useSprite = !sprite.priority; // false = in front of BG
      }

      // Sprite 0 hit detection
      if (sprite.isSprite0 && bgColorIndex !== 0 && bgEnabled && x < 255) {
        const inClippedRegion = (x < 8) && (!showBgLeft8 || !showSpritesLeft8);
        if (!inClippedRegion && (this.status & 0x40) === 0) {
          this.setStatusFlag(this.STATUS_SPRITE0HIT, true);
        }
      }
    }

    if (useSprite) {
      const addr = 0x3F10 | spritePaletteEntry;
      const palVal = this.readPalette(addr) & 0x3F;
      finalRgb = getRgb(palVal);
    } else if (bgColorIndex !== 0) {
      const addr = 0x3F00 | bgPaletteEntry;
      const palVal = this.readPalette(addr) & 0x3F;
      finalRgb = getRgb(palVal);
    } else {
      finalRgb = getRgb(backdropIndex);
    }
  }

  this.framebuffer[idx] = finalRgb;
}

  // =========================================================================
  // Palette read/write
  // =========================================================================
  readPalette(addr) {
    addr &= 0x1F; // Palette RAM is 32 bytes, mirrored every 32 bytes.
    // Addresses $3F10/$3F14/$3F18/$3F1C are mirrors of $3F00/$3F04/$3F08/$3F0C.
    if (addr >= 0x10 && (addr & 3) === 0) {
      addr -= 0x10;
    }
    return this.palette[addr];
  }

  writePalette(addr, value) {
    addr &= 0x1F;
    if (addr >= 0x10 && (addr & 3) === 0) {
      addr -= 0x10;
    }
    this.palette[addr] = value;
  }

  // =========================================================================
  // NMI logic
  // =========================================================================
  nmiChange() {
    // Suppress NMI during warm-up to prevent premature interrupts
    const nmi = this.nmiOutput && this.nmiOccurred && !this.inWarmup;
    if (nmi && !this.nmiPrevious) {
      // Use a small delay (3 PPU ticks = 1 CPU cycle) to allow for NMI suppression
      // if $2002 is read on the same cycle VBlank is set.
      this.nmiDelay = 3;
    }
    this.nmiPrevious = nmi;
  }

  // =========================================================================
  // OAM DMA
  // =========================================================================
  doDMA(value) {
    const base = value << 8;

    for (let i = 0; i < 256; i++) {
      let val = this.nes.cpu.cpuRead(base + i);
      if ((this.oamAddr & 3) === 2) {
        val &= 0xE3; // Clear bits 2-4 of attribute byte
      }
      this.oam[this.oamAddr] = val;
      this.oamAddr = (this.oamAddr + 1) & 0xFF;
    }

    // OAM DMA timing:
    // The CPU is halted for 513 or 514 cycles.
    // +1 cycle if the write occurs on an odd CPU cycle.
    // Assuming standard STA $4014 (4 cycles), write is on odd cycle if start is even.
    const isEvenCycle = (this.nes.cpu.cycleCount & 1) === 0;
    this.nes.cpu.cyclesToHalt += isEvenCycle ? 514 : 513;
  }

  // =========================================================================
  // Scroll counter updates during rendering (loopy logic)
  // =========================================================================
  updateScrollCounters() {
    const renderingEnabled =
      (this.mask & 0x08) !== 0 || (this.mask & 0x10) !== 0;

    if (!renderingEnabled) return;

    const preRenderScanline = 261;

    // Increment horizontal position every 8 cycles during rendering
    if ((this.cycle >= 1 && this.cycle <= 256) || (this.cycle >= 321 && this.cycle <= 336)) {
      if ((this.cycle & 7) === 0) {
        this.incrementCoarseX();
      }
    }

    // At cycle 256, increment vertical position
    if (this.cycle === 256) {
      this.incrementY();
    }

    // At cycle 257, copy horizontal bits from t to v
    if (this.cycle === 257) {
      this.copyHorizontalBits();
    }
  }

  // Increment coarse X and handle horizontal nametable switch
  incrementCoarseX() {
    if ((this.v & 0x001F) === 31) {
      this.v &= ~0x001F;
      this.v ^= 0x0400; // switch horizontal nametable
    } else {
      this.v++;
    }
  }

  // Increment fine Y and coarse Y with vertical nametable switch
  incrementY() {
    if ((this.v & 0x7000) !== 0x7000) {
      this.v += 0x1000;
    } else {
      this.v &= ~0x7000;
      let y = (this.v & 0x03E0) >> 5;
      if (y === 29) {
        y = 0;
        this.v ^= 0x0800; // switch vertical nametable
      } else if (y === 31) {
        y = 0;
      } else {
        y++;
      }
      this.v = (this.v & ~0x03E0) | (y << 5);
    }
  }

  // Copy horizontal scroll bits from t to v
  copyHorizontalBits() {
    this.v = (this.v & ~0x041F) | (this.t & 0x041F);
  }

  // Copy vertical scroll bits from t to v
  copyVerticalBits() {
    this.v = (this.v & ~0x7BE0) | (this.t & 0x7BE0);
  }

  // =========================================================================
  // Frame start/end
  // =========================================================================
  startFrame() {
    // Clear framebuffer to black (or backdrop)
    this.framebuffer.fill(0);
    this.frameComplete = false;
  }

  endFrame() {
    if (this.nes.ui && typeof this.nes.ui.writeFrame === "function") {
      this.nes.ui.writeFrame(this.framebuffer);
    }
    if (this.nes && typeof this.nes.onPpuFrameComplete === "function") {
      this.nes.onPpuFrameComplete();
    }
  }

  // =========================================================================
  // PPU main step (one PPU cycle)
  // Call this 3 times per CPU cycle.
  // =========================================================================
  step() {
    // Rendering is enabled if either BG or sprites are visible
    const renderingEnabled = (this.mask & 0x08) || (this.mask & 0x10);

    // Notify mapper at start of each scanline (cycle 0) for snooping-based mappers (e.g., MMC5)
    if (this.cycle === 0 && this.nes.mmap && this.nes.mmap.onStartScanline) {
      this.nes.mmap.onStartScanline(this.scanline, renderingEnabled);
    }
    
    // Ensure CHR mode is set to Background (false) at the start of the line
    if (this.cycle === 0 && this.nes.mmap?.hasSeparateChrBanks) {
        this.nes.mmap.setChrMode(false);
    }

    // Render pixel for the current cycle, before updating state for the next cycle.
    // This must run even if rendering is disabled (to show backdrop color).
    if (this.scanline < 240 && this.cycle >= 1 && this.cycle <= 256) {
      this.renderPixel();
    }

    // VBlank:             241-260
    // Pre-render:         261
    const preRenderScanline = 261;

    // During the pre-render scanline, the PPU constantly copies the vertical scroll bits from t to v.
    // This only happens if rendering is enabled.
    if (renderingEnabled && this.scanline === preRenderScanline && this.cycle >= 280 && this.cycle <= 304) {
      this.copyVerticalBits();
    }

    // VBlank START – at scanline 241, cycle 1
    if (this.scanline === 241 && this.cycle === 1) {
      this.nmiOccurred = true;
      this.setStatusFlag(this.STATUS_VBLANK, true);
      this.nmiChange();
    }

    // Pre-render scanline (261): Clear VBlank and sprite flags at cycle 1
    if (this.scanline === 261 && this.cycle === 1) {
      this.setStatusFlag(this.STATUS_VBLANK, false);
      this.setStatusFlag(this.STATUS_SPRITE0HIT, false);
      this.setStatusFlag(this.STATUS_SPRITE_OVERFLOW, false);
      this.nmiOccurred = false;
      this.nmiChange();

      // Clear PPU warm-up flag at start of pre-render scanline (approx cycle 29658 equivalent)
      if (this.inWarmup) {
        this.inWarmup = false;
      }
    }

    // Sprite evaluation happens during cycles 257-320 of scanline N for rendering on scanline N+1
    // Evaluate sprites for the NEXT scanline during sprite tile fetch window
    if (this.cycle === 257 && ((this.mask & 0x10) !== 0)) {
      // Evaluate sprites for next scanline
      // During scanline 261 (pre-render), evaluate for scanline 0
      // During scanline 0-238, evaluate for scanline 1-239
      // During scanline 239, evaluation happens but scanline 240 is not rendered
      if (this.scanline === 261 || (this.scanline >= 0 && this.scanline < 240)) {
        // Switch to Sprite CHR banks for pattern fetching
        if (this.nes.mmap?.hasSeparateChrBanks) {
            this.nes.mmap.setChrMode(true);
        }
        this.evaluateSprites();
        // Switch back to Background CHR banks for the next scanline's pre-fetches
        if (this.nes.mmap?.hasSeparateChrBanks) {
            this.nes.mmap.setChrMode(false);
        }
      } else {
        this.spriteCount = 0;
      }
    }

    // MMC5 scanline IRQ detection at cycle 4 (attribute table fetch)
    // This must happen BEFORE the game's IRQ handler can change nametable settings
    if (this.cycle === 4 && renderingEnabled && (this.scanline < 240 || this.scanline === 261)) {
      if (this.nes.mmap && this.nes.mmap.onEndScanline) {
        this.nes.mmap.onEndScanline(this.scanline);
      }
    }

    // Background tile fetching and rendering for visible scanlines + pre-render
    if (renderingEnabled && (this.scanline < 240 || this.scanline === 261)) {
      // Tile fetching happens during cycles 1-256 and 321-336

      // Shift registers for the current pixel, before it is rendered.
      if ((this.cycle >= 1 && this.cycle <= 256) || (this.cycle >= 321 && this.cycle <= 336)) {
        // Shift registers left every cycle during rendering (keep 16-bit)
        this.bgShiftLow = (this.bgShiftLow << 1) & 0xFFFF;
        this.bgShiftHigh = (this.bgShiftHigh << 1) & 0xFFFF;
        this.bgAttrShiftLow = (this.bgAttrShiftLow << 1) & 0xFFFF;
        this.bgAttrShiftHigh = (this.bgAttrShiftHigh << 1) & 0xFFFF;
      }

      if ((this.cycle >= 1 && this.cycle <= 256) || (this.cycle >= 321 && this.cycle <= 336)) {

        // 8-cycle tile fetch pattern
        const fetchCycle = this.cycle & 7;

        switch (fetchCycle) {
          case 1:
            // Fetch nametable byte (which tile)
            this.bgTileIndex = this.fetchNametableByte();
            break;

          case 3:
            // Fetch attribute byte (which palette)
            this.bgAttrByte = this.fetchAttributeByte();
            break;

          case 5: {
            // Fetch pattern table low byte
            const fineY = (this.v >> 12) & 0x07;
            this.bgTileLow = this.fetchBgPatternLow(this.bgTileIndex, fineY);
            break;
          }

          case 7: {
            // Fetch pattern table high byte
            const fineY = (this.v >> 12) & 0x07;
            this.bgTileHigh = this.fetchBgPatternHigh(this.bgTileIndex, fineY);
            break;
          }

          case 0:
            // Load shift registers with fetched tile data
            // Keep high byte, load new data into low byte
            this.bgShiftLow = (this.bgShiftLow & 0xFF00) | this.bgTileLow;
            this.bgShiftHigh = (this.bgShiftHigh & 0xFF00) | this.bgTileHigh;

            // Load attribute bits into shift registers
            // bgAttrByte is already the 2-bit palette index (0-3) from fetchAttributeByte()
            const paletteBits = this.bgAttrByte;

            // Replicate palette bits across 8 pixels (bit ops instead of ternary)
            // -(x & 1) produces 0xFFFFFFFF (-1) if bit is set, 0 otherwise
            const newAttrLow = (this.bgAttrShiftLow & 0xFF00) | (-(paletteBits & 1) & 0xFF);
            const newAttrHigh = (this.bgAttrShiftHigh & 0xFF00) | (-((paletteBits >> 1) & 1) & 0xFF);

            this.bgAttrShiftLow = newAttrLow;
            this.bgAttrShiftHigh = newAttrHigh;
            break;
        }
      }

      // Dummy fetches for MMC5 scanline detection (snooping)
      // Cycles 337 and 339 fetch nametable bytes (unused by PPU, but seen by mapper)
      if (this.cycle === 337 || this.cycle === 339) {
        this.fetchNametableByte();
      }
    }

    // Horizontal/vertical VRAM address updates during rendering
    if (renderingEnabled && (this.scanline < 240 || this.scanline === 261)) {
      this.updateScrollCounters();
    }

    // Advance to next cycle
    this.cycle++;

    // Determine scanline length (handles odd frame skip)
    let cyclesThisScanline = 341;
    if (this.oddFrame && this.scanline === 261 && renderingEnabled) {
      cyclesThisScanline = 340;
    }

    // Standard NTSC scanline = 341 PPU cycles (dots 0 through 340)
    if (this.cycle >= cyclesThisScanline) {
      this.cycle = 0;

      // Move to next scanline
      // Note: MMC5 onEndScanline is called at cycle 4, not here
      this.scanline++;

      // Full NTSC frame = scanlines 0 through 261 inclusive (262 total lines)
      if (this.scanline > 261) {
        this.scanline = 0;
        this.frame++;

        this.oddFrame = !this.oddFrame;
        this.frameComplete = true;
      }
    }

    // NMI delay
    if (this.nmiDelay > 0) {
      this.nmiDelay--;
      if (this.nmiDelay === 0 && this.nmiOutput && this.nmiOccurred) {
        this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NMI);
      }
    }

    // On end-of-frame, push framebuffer to UI
    if (this.frameComplete) {
      this.endFrame();
    }
  }

  // =========================================================================
  // A12 Clocking for MMC3 IRQ
  // =========================================================================
  checkA12(addr) {
    // This is called on every pattern table fetch.
    // If the mapper has a scanline IRQ, we check for a rising edge on A12.
    if (this.nes.mmap && this.nes.mmap.hasScanlineIrq) {
        const a12 = (addr >> 12) & 1;
        const currentScanline = this.scanline;
        const currentCycle = this.cycle;

        if (a12 === 1) {
            // Rising edge detection with filter
            if (this.ppuA12Prev === 0) {
                // Calculate cycles since A12 was last high
                let cyclesSinceHigh = 0;
                if (currentScanline === this.lastA12HighScanline) {
                    cyclesSinceHigh = currentCycle - this.lastA12HighCycle;
                } else {
                    // Scanline changed, assume large delay (safe to clock)
                    cyclesSinceHigh = 1000; 
                }

                // Filter: A12 must be low for a short time to register a clock.
                // Real hardware requires ~15 PPU cycles. We use 12 to be safe and filter out noise.
                if (cyclesSinceHigh > 12) {
                    this.nes.mmap.clockScanline();
                }
            }
            
            // Update last high timestamp
            this.lastA12HighScanline = currentScanline;
            this.lastA12HighCycle = currentCycle;
        }
        this.ppuA12Prev = a12;
    }
  }

  // =========================================================================
  // Sprite evaluation: build secondary OAM for current scanline
  // =========================================================================
  evaluateSprites() {
    // Sprite evaluation for NEXT scanline
    // Called during scanline N at cycle 257, evaluates for rendering on scanline N+1
    let nextScanline = this.scanline + 1;
    if (nextScanline > 261) nextScanline = 0;
    const spriteHeight = (this.ctrl & 0x20) ? 16 : 8;

    // Clear secondary OAM
    this.secondaryOAM.fill(0xFF);

    let count = 0;
    let n = 0;
    let m = 0; // Byte offset for the OAM overflow bug

    while (n < 64) {
      // Read the byte that is treated as Y-coordinate.
      // Normally OAM[n*4 + 0].
      // Due to the hardware bug, if count >= 8, m might be 1, 2, or 3.
      const val = this.oam[(n << 2) + m];

      // Check if sprite is in range for the next scanline
      // Sprite Y is the top line. It appears on Y+1.
      const diff = nextScanline - val - 1;
      const inRange = (diff >= 0 && diff < spriteHeight);

      if (count < 8) {
        if (inRange) {
          // Found a visible sprite, copy to secondary OAM
          const dest = count << 2;
          const src = n << 2;
          this.secondaryOAM[dest] = this.oam[src];
          this.secondaryOAM[dest + 1] = this.oam[src + 1];
          this.secondaryOAM[dest + 2] = this.oam[src + 2];
          this.secondaryOAM[dest + 3] = this.oam[src + 3];
          this.spriteIndices[count] = n;
          count++;
        }
        n++;
      } else {
        // We have found 8 sprites. Now checking for overflow.
        if (inRange) {
          if ((this.status & 0x20) === 0) {
            this.setStatusFlag(this.STATUS_SPRITE_OVERFLOW, true);
          }
          n++;
          m = 0; // Reset m if we found a sprite (even if we don't copy it)
        } else {
          n++;
          m = (m + 1) & 3; // The hardware bug: m increments
        }
      }
    }

    this.spriteCount = count;

    // Pre-fetch pattern bytes for all selected sprites
    this.fetchSpritePatterns();
  }

  // =========================================================================
  // Fetch sprite pattern data for sprites in secondary OAM
  // =========================================================================
  fetchSpritePatterns() {
    // Fetch patterns for NEXT scanline (same as evaluation)
    let nextScanline = this.scanline + 1;
    if (nextScanline > 261) nextScanline = 0;
    const spriteHeight = (this.ctrl & 0x20) ? 16 : 8;

    // Real PPU always performs 8 sprite fetches (16 memory accesses).
    // If fewer than 8 sprites, it fetches dummy data (usually $FF tile index).
    // This is critical for MMC3 IRQ clocking (e.g. Alien 3).
    for (let i = 0; i < 8; i++) {
      let tileIndex, attributes, spriteX, row;
      let validSprite = (i < this.spriteCount);

      if (validSprite) {
        const base = i << 2;
        const spriteY = this.secondaryOAM[base];
        tileIndex = this.secondaryOAM[base + 1];
        attributes = this.secondaryOAM[base + 2];
        spriteX = this.secondaryOAM[base + 3];

        const flipVertical = (attributes & 0x80) !== 0;
        row = nextScanline - (spriteY + 1);
        if (flipVertical) {
          row = spriteHeight - 1 - row;
        }
      } else {
        // Dummy fetch for unused slots (fetches tile $FF)
        tileIndex = 0xFF;
        attributes = 0;
        spriteX = 0;
        row = 0;
      }

      const is8x16 = spriteHeight === 16;
      let fineY = row & 7;
      let actualTileIndex = tileIndex;

      if (is8x16) {
        const topTileIndex = (tileIndex & 0xFE);
        if (row >= 8) {
          actualTileIndex = topTileIndex + 1;
        } else {
          actualTileIndex = topTileIndex;
        }
      }

      // Perform fetches (triggers A12 checks)
      const patternLow = this.fetchSpritePatternLow(actualTileIndex, fineY, is8x16, tileIndex);
      const patternHigh = this.fetchSpritePatternHigh(actualTileIndex, fineY, is8x16, tileIndex);

      if (validSprite) {
        this.spritePatternsLow[i] = patternLow;
        this.spritePatternsHigh[i] = patternHigh;
        this.spriteX[i] = spriteX;
        this.spriteAttributes[i] = attributes;
      }
    }
  }

  // =========================================================================
  // Save State
  // =========================================================================
  static JSON_PROPERTIES = [
    'vramMem', 'palette', 'oam', 'oamAddr', 'ctrl', 'mask', 'status',
    'v', 't', 'x', 'w', 'ioBus', 'scanline', 'cycle', 'frame', 'oddFrame', 
    'ppuA12Prev', 'lastA12HighScanline', 'lastA12HighCycle',
    'nmiOccurred', 'nmiOutput', 'nmiPrevious', 'nmiDelay', 'bufferedRead', 'mirroring',
    // Internal rendering state
    'secondaryOAM', 'spriteCount', 'spritePatternsLow', 'spritePatternsHigh',
    'spriteX', 'spriteAttributes', 'spriteIndices',
    'bgShiftLow', 'bgShiftHigh', 'bgAttrShiftLow', 'bgAttrShiftHigh',
    'bgTileIndex', 'bgAttrByte', 'bgTileLow', 'bgTileHigh'
  ];

  toJSON() {
    const state = {};
    for (const prop of PPU.JSON_PROPERTIES) {
      const value = this[prop];
      state[prop] = (value instanceof Uint8Array) ? Array.from(value) : value;
    }
    return state;
  }

  fromJSON(s) {
    for (const prop of PPU.JSON_PROPERTIES) {
      if (s[prop] !== undefined) {
        this[prop] = (this[prop] instanceof Uint8Array) ? new Uint8Array(s[prop]) : s[prop];
      }
    }
  }
}
// ============================================================================
// NES PPU (2C02-style)
// Mesen-aligned baseline with mapper-agnostic PPU core + required hook points
// ============================================================================

export class PPU {
  static STATUS_SPRITE_OVERFLOW = 0x20;
  static STATUS_SPRITE0_HIT = 0x40;
  static STATUS_VBLANK = 0x80;

  constructor(nes) {
    this.nes = nes;

    // Internal memory
    this.vramMem = new Uint8Array(0x1000); // CIRAM (+4-screen space when needed)
    this.palette = new Uint8Array(0x20);
    this.oam = new Uint8Array(0x100);
    this.secondaryOAM = new Uint8Array(0x20);

    // Video output
    this.framebuffer = new Uint32Array(256 * 240);
    this.outputBuffer = this.framebuffer;

    // PPU registers ($2000-$2007)
    this.ctrl = 0;
    this.mask = 0;
    this.status = 0;
    this.oamAddr = 0;

    // Loopy registers
    this.v = 0;
    this.t = 0;
    this.x = 0;
    this.w = 0;

    // Open bus and buffered reads
    this.ioBus = 0;
    this.openBusDecayStamp = new Uint32Array(8);
    this.memoryReadBuffer = 0;

    // Timing
    this.scanline = -1;
    this.cycle = 340;
    this.frame = 1;
    this.oddFrame = true;
    this.ppuClock = 0;
    this.frameComplete = false;

    // Region timing
    this.region = "ntsc";
    this.nmiScanline = 241;
    this.vblankEnd = 260;
    this.preRenderScanline = 261;
    this.palSpriteEvalScanline = 265;
    this.oddFrameCycleSkip = true;
    this._ppuStepsPerCpuNumerator = 3;
    this._ppuStepsPerCpuDenominator = 1;
    this._ppuStepAccumulator = 0;

    // NMI / VBlank state
    this.nmiOccurred = false;
    this.nmiOutput = false;
    this.nmiPrevious = false;
    this.nmiDelay = 0;
    this.preventVblFlag = false;

    // Warmup gate (matches Mesen's first-frame restricted PPU access behavior)
    this.allowFullPpuAccess = false;
    this.inWarmup = true;

    // Rendering state update pipeline
    this.renderingEnabled = false;
    this.prevRenderingEnabled = false;
    this.needStateUpdate = false;

    // Delayed effects
    this.updateVramAddrDelay = 0;
    this.updateVramAddr = 0;
    this.needVideoRamIncrement = false;
    this.ignoreVramRead = 0;

    // Bus address tracking
    this.ppuBusAddress = 0;

    // Fallback A12 edge tracker (for mappers that don't use notifyVramAddressChange)
    this.ppuA12Prev = 0;
    this.lastA12HighScanline = -1;
    this.lastA12HighCycle = -1;

    // Background pipeline
    this.lowBitShift = 0;
    this.highBitShift = 0;
    this.currentTilePalette = 0;
    this.previousTilePalette = 0;
    this.tile = {
      tileAddr: 0,
      lowByte: 0,
      highByte: 0,
      paletteOffset: 0,
    };

    // Sprite pipeline
    this.spriteTiles = new Array(64);
    for (let i = 0; i < 64; i++) {
      this.spriteTiles[i] = {
        spriteX: 0,
        lowByte: 0,
        highByte: 0,
        paletteOffset: 0,
        horizontalMirror: false,
        backgroundPriority: false,
      };
    }

    this.hasSprite = new Uint8Array(257);
    this.spriteCount = 0;
    this.spriteIndex = 0;
    this.sprite0Visible = false;

    // Sprite evaluation internals
    this.oamCopyBuffer = 0;
    this.secondaryOamAddr = 0;
    this.spriteInRange = false;
    this.sprite0Added = false;
    this.spriteAddrH = 0;
    this.spriteAddrL = 0;
    this.oamCopyDone = false;
    this.overflowBugCounter = 0;
    this.firstVisibleSpriteAddr = 0;
    this.lastVisibleSpriteAddr = 0;

    // Draw mask / emphasis
    this.paletteRamMask = 0x3F;
    this.intensifyColorBits = 0;
    this.minimumDrawBgCycle = 300;
    this.minimumDrawSpriteCycle = 300;
    this.minimumDrawSpriteStandardCycle = 300;

    // Nametable mirroring
    this.mirroringType = 0;
    this.mirroring = 0;

    this._mapperContext = {
      ppuClock: 0,
      scanline: 0,
      cycle: 0,
      renderingEnabled: false,
      v: 0,
      t: 0,
      x: 0,
      control: 0,
      mask: 0,
      controlByte: 0,
      maskByte: 0,
      region: "ntsc",
      coarseX: 0,
      coarseY: 0,
      ppuBusAddress: 0,
      ciramReadPage: (page, offset) => this._ciramReadPage(page, offset),
      ciramWritePage: (page, offset, value) => this._ciramWritePage(page, offset, value),
      mirrorAddress: (address) => this.mirrorAddress(address),
    };

    this.powerOn();
  }

  powerOn() {
    this.vramMem.fill(0x00);
    this.oam.fill(0xFF);
    this.secondaryOAM.fill(0xFF);
    this.framebuffer.fill(0x000000);

    // Mesen's deterministic non-random palette boot values
    const paletteBoot = [
      0x09, 0x01, 0x00, 0x01, 0x00, 0x02, 0x02, 0x0D,
      0x08, 0x10, 0x08, 0x24, 0x00, 0x00, 0x04, 0x2C,
      0x09, 0x01, 0x34, 0x03, 0x00, 0x04, 0x00, 0x14,
      0x08, 0x3A, 0x00, 0x02, 0x00, 0x20, 0x2C, 0x08,
    ];
    for (let i = 0; i < 0x20; i++) {
      this.palette[i] = paletteBoot[i];
    }

    // Power-on clears current VRAM address but reset logic keeps internal pipeline defaults.
    this.v = 0;
    this.reset();
  }

  reset() {
    this.ctrl = 0;
    this.mask = 0;
    this.status = 0;
    this.oamAddr = 0;

    this.t = 0;
    this.x = 0;
    this.w = 0;

    this.ioBus = 0;
    this.memoryReadBuffer = 0;
    this.openBusDecayStamp.fill(0);

    this.scanline = -1;
    this.cycle = 340;
    this.frame = 1;
    this.oddFrame = true;
    this.ppuClock = 0;
    this.frameComplete = false;

    this.nmiOccurred = false;
    this.nmiOutput = false;
    this.nmiPrevious = false;
    this.nmiDelay = 0;
    this.preventVblFlag = false;

    this.allowFullPpuAccess = false;
    this.inWarmup = true;

    this.renderingEnabled = false;
    this.prevRenderingEnabled = false;
    this.needStateUpdate = false;

    this.updateVramAddrDelay = 0;
    this.updateVramAddr = 0;
    this.needVideoRamIncrement = false;
    this.ignoreVramRead = 0;

    this.ppuBusAddress = 0;
    this.ppuA12Prev = 0;
    this.lastA12HighScanline = -1;
    this.lastA12HighCycle = -1;

    this.lowBitShift = 0;
    this.highBitShift = 0;
    this.currentTilePalette = 0;
    this.previousTilePalette = 0;
    this.tile.tileAddr = 0;
    this.tile.lowByte = 0;
    this.tile.highByte = 0;
    this.tile.paletteOffset = 0;

    this.hasSprite.fill(0);
    this.spriteCount = 0;
    this.spriteIndex = 0;
    this.sprite0Visible = false;

    this.oamCopyBuffer = 0;
    this.secondaryOamAddr = 0;
    this.spriteInRange = false;
    this.sprite0Added = false;
    this.spriteAddrH = 0;
    this.spriteAddrL = 0;
    this.oamCopyDone = false;
    this.overflowBugCounter = 0;
    this.firstVisibleSpriteAddr = 0;
    this.lastVisibleSpriteAddr = 0;

    for (let i = 0; i < 64; i++) {
      const spr = this.spriteTiles[i];
      spr.spriteX = 0;
      spr.lowByte = 0;
      spr.highByte = 0;
      spr.paletteOffset = 0;
      spr.horizontalMirror = false;
      spr.backgroundPriority = false;
    }

    this.paletteRamMask = 0x3F;
    this.intensifyColorBits = 0;
    this.updateMinimumDrawCycles();
    this.updateGrayscaleAndIntensifyBits();
    this.updatePaletteEmphasis();

    this._ppuStepAccumulator = 0;
  }

  setRegion(region) {
    const normalized = String(region || "ntsc").toLowerCase();

    if (normalized === "pal") {
      this.region = "pal";
      this.nmiScanline = 241;
      this.vblankEnd = 310;
      this.oddFrameCycleSkip = false;
      // PAL ratio is ~3.2 PPU clocks per CPU clock.
      this._ppuStepsPerCpuNumerator = 16;
      this._ppuStepsPerCpuDenominator = 5;
    } else if (normalized === "dendy") {
      this.region = "dendy";
      this.nmiScanline = 291;
      this.vblankEnd = 310;
      this.oddFrameCycleSkip = false;
      this._ppuStepsPerCpuNumerator = 3;
      this._ppuStepsPerCpuDenominator = 1;
    } else {
      this.region = "ntsc";
      this.nmiScanline = 241;
      this.vblankEnd = 260;
      this.oddFrameCycleSkip = true;
      this._ppuStepsPerCpuNumerator = 3;
      this._ppuStepsPerCpuDenominator = 1;
    }

    this.preRenderScanline = this.vblankEnd + 1;
    this.palSpriteEvalScanline = this.nmiScanline + 24;
    this._ppuStepAccumulator = 0;

    // Red/green emphasis meaning depends on region.
    this.updateGrayscaleAndIntensifyBits();
    this.updatePaletteEmphasis();
  }

  clockCpuCycle() {
    this._ppuStepAccumulator += this._ppuStepsPerCpuNumerator;
    while (this._ppuStepAccumulator >= this._ppuStepsPerCpuDenominator) {
      this.step();
      this._ppuStepAccumulator -= this._ppuStepsPerCpuDenominator;
    }
  }

  startFrame() {
    this.frameComplete = false;
  }

  isRenderingEnabled() {
    return this.renderingEnabled;
  }

  setMirroring(type) {
    this.mirroringType = type & 0xFF;
    this.mirroring = this.mirroringType;
  }

  getMirroring() {
    return this.mirroringType;
  }

  mirrorAddress(addr) {
    const a = addr & 0x0FFF;

    switch (this.mirroringType) {
      case 0: // Horizontal
        return (a & 0x03FF) | ((a & 0x0800) >> 1);
      case 1: // Vertical
        return a & 0x07FF;
      case 2: // Single-screen A
        return a & 0x03FF;
      case 3: // Single-screen B
        return (a & 0x03FF) | 0x0400;
      case 4: // Four-screen
        return a;
      default:
        return a & 0x07FF;
    }
  }

  _ciramReadPage(page, offset) {
    const base = (page & 0x01) << 10;
    return this.vramMem[base | (offset & 0x03FF)] & 0xFF;
  }

  _ciramWritePage(page, offset, value) {
    const base = (page & 0x01) << 10;
    this.vramMem[base | (offset & 0x03FF)] = value & 0xFF;
  }

  updateMinimumDrawCycles() {
    const bgEnabled = this._maskBgEnabled();
    const spriteEnabled = this._maskSpritesEnabled();

    this.minimumDrawBgCycle = bgEnabled ? (this._maskBgLeftColumn() ? 0 : 8) : 300;
    this.minimumDrawSpriteCycle = spriteEnabled ? (this._maskSpriteLeftColumn() ? 0 : 8) : 300;
    this.minimumDrawSpriteStandardCycle = this.minimumDrawSpriteCycle;
  }

  updateGrayscaleAndIntensifyBits() {
    this.paletteRamMask = this._maskGrayscale() ? 0x30 : 0x3F;

    let red = (this.mask & 0x20) !== 0;
    let green = (this.mask & 0x40) !== 0;
    const blue = (this.mask & 0x80) !== 0;

    if (this.region === "pal" || this.region === "dendy") {
      const tmp = red;
      red = green;
      green = tmp;
    }

    this.intensifyColorBits = (red ? 0x40 : 0) | (green ? 0x80 : 0) | (blue ? 0x100 : 0);
  }

  updatePaletteEmphasis() {
    const palTable = this.nes && this.nes.palTable;
    if (!palTable || typeof palTable.setEmphasis !== "function") {
      return;
    }

    let red = (this.mask & 0x20) !== 0;
    let green = (this.mask & 0x40) !== 0;
    const blue = (this.mask & 0x80) !== 0;

    if (this.region === "pal" || this.region === "dendy") {
      const tmp = red;
      red = green;
      green = tmp;
    }

    const emph = (red ? 1 : 0) | (green ? 2 : 0) | (blue ? 4 : 0);
    palTable.setEmphasis(emph);
  }

  getMapperContext() {
    const ctx = this._mapperContext;
    ctx.ppuClock = this.ppuClock;
    ctx.scanline = this.scanline;
    ctx.cycle = this.cycle;
    ctx.renderingEnabled = this.isRenderingEnabled();
    ctx.v = this.v;
    ctx.t = this.t;
    ctx.x = this.x;
    ctx.control = this.ctrl;
    ctx.mask = this.mask;
    ctx.controlByte = this.ctrl;
    ctx.maskByte = this.mask;
    ctx.region = this.region;
    ctx.coarseX = this.v & 0x1F;
    ctx.coarseY = (this.v >> 5) & 0x1F;
    ctx.ppuBusAddress = this.ppuBusAddress;
    return ctx;
  }

  setOpenBus(mask, value) {
    mask &= 0xFF;
    value &= 0xFF;

    if (mask === 0xFF) {
      this.ioBus = value;
      for (let i = 0; i < 8; i++) {
        this.openBusDecayStamp[i] = this.frame;
      }
      return;
    }

    let openBus = this.ioBus << 8;
    for (let i = 0; i < 8; i++) {
      openBus >>= 1;

      if (mask & 0x01) {
        if (value & 0x01) {
          openBus |= 0x80;
        } else {
          openBus &= 0xFF7F;
        }
        this.openBusDecayStamp[i] = this.frame;
      } else if (this.frame - this.openBusDecayStamp[i] > 3) {
        openBus &= 0xFF7F;
      }

      value >>= 1;
      mask >>= 1;
    }

    this.ioBus = openBus & 0xFF;
  }

  applyOpenBus(mask, value) {
    this.setOpenBus((~mask) & 0xFF, value & 0xFF);
    return ((value & 0xFF) | (this.ioBus & (mask & 0xFF))) & 0xFF;
  }

  readPaletteRam(addr) {
    let index = addr & 0x1F;
    if (index === 0x10 || index === 0x14 || index === 0x18 || index === 0x1C) {
      index &= ~0x10;
    }
    return this.palette[index] & 0xFF;
  }

  writePaletteRam(addr, value) {
    let index = addr & 0x1F;
    value &= 0x3F;

    if (index === 0x00 || index === 0x10) {
      this.palette[0x00] = value;
      this.palette[0x10] = value;
    } else if (index === 0x04 || index === 0x14) {
      this.palette[0x04] = value;
      this.palette[0x14] = value;
    } else if (index === 0x08 || index === 0x18) {
      this.palette[0x08] = value;
      this.palette[0x18] = value;
    } else if (index === 0x0C || index === 0x1C) {
      this.palette[0x0C] = value;
      this.palette[0x1C] = value;
    } else {
      this.palette[index] = value;
    }
  }

  _checkA12Fallback(addr) {
    const mapper = this.nes.mmap;
    if (!mapper || mapper.hasVramAddressHook) {
      this.ppuA12Prev = (addr >> 12) & 0x01;
      return;
    }

    if (!mapper.hasScanlineIrq || typeof mapper.scanlineCounter !== "function") {
      this.ppuA12Prev = (addr >> 12) & 0x01;
      return;
    }

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

  setBusAddress(addr) {
    const busAddr = addr & 0x3FFF;

    this._checkA12Fallback(busAddr);

    this.ppuBusAddress = busAddr;

    const mapper = this.nes.mmap;
    if (mapper && mapper.hasVramAddressHook && typeof mapper.notifyVramAddressChange === "function") {
      mapper.notifyVramAddressChange(busAddr, this.getMapperContext());
    }
  }

  readVram(addr, context = "cpu") {
    const vramAddr = addr & 0x3FFF;
    this.setBusAddress(vramAddr);

    const mapper = this.nes.mmap;

    if (vramAddr < 0x2000) {
      if (mapper && typeof mapper.ppuRead === "function") {
        const value = mapper.ppuRead(vramAddr, context, this.getMapperContext());
        if (value !== null && value !== undefined) {
          return value & 0xFF;
        }
      }
      return 0;
    }

    if (vramAddr < 0x3F00) {
      if (mapper && typeof mapper.readNametable === "function") {
        const value = mapper.readNametable(vramAddr, context, this.getMapperContext());
        if (value !== null && value !== undefined) {
          return value & 0xFF;
        }
      }
      return this.vramMem[this.mirrorAddress(vramAddr)] & 0xFF;
    }

    return this.readPaletteRam(vramAddr);
  }

  writeVram(addr, value, context = "cpu") {
    const vramAddr = addr & 0x3FFF;
    const writeValue = value & 0xFF;
    this.setBusAddress(vramAddr);

    const mapper = this.nes.mmap;

    if (vramAddr < 0x2000) {
      if (mapper && typeof mapper.ppuWrite === "function") {
        mapper.ppuWrite(vramAddr, writeValue, context, this.getMapperContext());
      }
      return;
    }

    if (vramAddr < 0x3F00) {
      if (mapper && typeof mapper.setNametableByte === "function") {
        const handled = mapper.setNametableByte(vramAddr, writeValue, this.getMapperContext());
        if (handled) {
          return;
        }
      }

      this.vramMem[this.mirrorAddress(vramAddr)] = writeValue;
      return;
    }

    this.writePaletteRam(vramAddr, writeValue);
  }

  // Compatibility aliases
  readVRAM(addr, context = "cpu") {
    return this.readVram(addr, context);
  }

  writeVRAM(addr, value, context = "cpu") {
    this.writeVram(addr, value, context);
  }

  _ctrlVerticalWrite() {
    return (this.ctrl & 0x04) !== 0;
  }

  _ctrlSpritePatternAddr() {
    return (this.ctrl & 0x08) ? 0x1000 : 0x0000;
  }

  _ctrlBackgroundPatternAddr() {
    return (this.ctrl & 0x10) ? 0x1000 : 0x0000;
  }

  _ctrlLargeSprites() {
    return (this.ctrl & 0x20) !== 0;
  }

  _maskGrayscale() {
    return (this.mask & 0x01) !== 0;
  }

  _maskBgLeftColumn() {
    return (this.mask & 0x02) !== 0;
  }

  _maskSpriteLeftColumn() {
    return (this.mask & 0x04) !== 0;
  }

  _maskBgEnabled() {
    return (this.mask & 0x08) !== 0;
  }

  _maskSpritesEnabled() {
    return (this.mask & 0x10) !== 0;
  }

  processTmpAddrScrollGlitch(normalAddr, value, mask) {
    this.t = normalAddr & 0x7FFF;

    if (this.cycle === 257 && this.scanline < 240 && this.isRenderingEnabled()) {
      this.v = (this.v & ~mask) | (value & mask);
    }
  }

  setControlRegister(value) {
    const nameTable = value & 0x03;

    const normalAddr = (this.t & ~0x0C00) | (nameTable << 10);
    this.processTmpAddrScrollGlitch(normalAddr, (this.ioBus << 10) & 0x0C00, 0x0400);

    this.ctrl = value & 0xFF;
    this.nmiOutput = (this.ctrl & 0x80) !== 0;

    if (!this.nmiOutput) {
      if (this.nes.cpu && typeof this.nes.cpu.clearNmiFlag === "function") {
        this.nes.cpu.clearNmiFlag();
      }
    } else if (this.nmiOccurred) {
      if (this.nes.cpu && typeof this.nes.cpu.setNmiFlag === "function") {
        this.nes.cpu.setNmiFlag();
      }
    }

    this.nmiChange();
  }

  setMaskRegister(value) {
    this.mask = value & 0xFF;

    if (this.renderingEnabled !== ((this.mask & 0x18) !== 0)) {
      this.needStateUpdate = true;
    }

    this.updateMinimumDrawCycles();
    this.updateGrayscaleAndIntensifyBits();
    this.updatePaletteEmphasis();
  }

  updateStatusFlag() {
    this.status &= ~PPU.STATUS_VBLANK;
    this.nmiOccurred = false;

    if (this.nes.cpu && typeof this.nes.cpu.clearNmiFlag === "function") {
      this.nes.cpu.clearNmiFlag();
    }

    this.nmiChange();

    if (this.scanline === this.nmiScanline && this.cycle === 0) {
      this.preventVblFlag = true;
    }
  }

  readRegister(reg) {
    const id = reg & 0x07;
    let openBusMask = 0xFF;
    let returnValue = 0;

    switch (id) {
      case 2: // PPUSTATUS
        this.w = 0;
        returnValue = this.status & 0xE0;
        this.updateStatusFlag();
        openBusMask = 0x1F;
        break;

      case 4: // OAMDATA
        if (this.scanline <= 239 && this.isRenderingEnabled()) {
          if (this.cycle >= 257 && this.cycle <= 320) {
            const step = (((this.cycle - 257) % 8) > 3) ? 3 : ((this.cycle - 257) % 8);
            this.secondaryOamAddr = (((this.cycle - 257) / 8) | 0) * 4 + step;
            this.oamCopyBuffer = this.secondaryOAM[this.secondaryOamAddr] & 0xFF;
          }
          returnValue = this.oamCopyBuffer & 0xFF;
        } else {
          returnValue = this.oam[this.oamAddr] & 0xFF;
        }
        openBusMask = 0x00;
        break;

      case 7: // PPUDATA
        if (!this.allowFullPpuAccess) {
          openBusMask = 0x00;
          returnValue = 0;
        } else if (this.ignoreVramRead > 0) {
          openBusMask = 0xFF;
        } else {
          const addr = this.ppuBusAddress & 0x3FFF;

          returnValue = this.memoryReadBuffer & 0xFF;
          this.memoryReadBuffer = this.readVram(addr, "cpu") & 0xFF;

          if (addr >= 0x3F00) {
            returnValue = (this.readPaletteRam(addr) & this.paletteRamMask) | (this.ioBus & 0xC0);
            openBusMask = 0xC0;
          } else {
            openBusMask = 0x00;
          }

          this.ignoreVramRead = 6;
          this.needStateUpdate = true;
          this.needVideoRamIncrement = true;
        }
        break;

      default:
        break;
    }

    return this.applyOpenBus(openBusMask, returnValue);
  }

  writeRegister(reg, value) {
    const id = reg & 0x07;
    const writeValue = value & 0xFF;

    this.setOpenBus(0xFF, writeValue);

    if (!this.allowFullPpuAccess && (id === 0 || id === 1 || id === 5 || id === 6)) {
      return;
    }

    const mapper = this.nes.mmap;
    if (mapper && typeof mapper.onPpuRegisterWrite === "function") {
      mapper.onPpuRegisterWrite(0x2000 + id, writeValue, this.getMapperContext());
    }

    switch (id) {
      case 0: // PPUCTRL
        this.setControlRegister(writeValue);
        break;

      case 1: // PPUMASK
        this.setMaskRegister(writeValue);
        break;

      case 3: // OAMADDR
        this.oamAddr = writeValue;
        break;

      case 4: // OAMDATA
        if ((this.scanline >= 240 && (this.region !== "pal" || this.scanline < this.palSpriteEvalScanline)) || !this.isRenderingEnabled()) {
          let oamValue = writeValue;
          if ((this.oamAddr & 0x03) === 0x02) {
            // Attribute byte has 3 unimplemented bits.
            oamValue &= 0xE3;
          }
          this.oam[this.oamAddr] = oamValue;
          this.oamAddr = (this.oamAddr + 1) & 0xFF;
        } else {
          // Rendering-time OAM write glitch: increment high 6 bits only.
          this.oamAddr = (this.oamAddr + 4) & 0xFF;
        }
        break;

      case 5: // PPUSCROLL
        if (this.w) {
          this.t = (this.t & ~0x73E0) | ((writeValue & 0xF8) << 2) | ((writeValue & 0x07) << 12);
        } else {
          this.x = writeValue & 0x07;
          const newAddr = (this.t & ~0x001F) | (writeValue >> 3);
          this.processTmpAddrScrollGlitch(newAddr, (this.ioBus >> 3) & 0x1F, 0x001F);
        }
        this.w ^= 1;
        break;

      case 6: // PPUADDR
        if (this.w) {
          this.t = (this.t & ~0x00FF) | writeValue;

          // Mesen: second write to $2006 takes effect after 3 PPU cycles.
          this.needStateUpdate = true;
          this.updateVramAddrDelay = 3;
          this.updateVramAddr = this.t & 0x7FFF;
        } else {
          const newAddr = (this.t & ~0xFF00) | ((writeValue & 0x3F) << 8);
          this.processTmpAddrScrollGlitch(newAddr, (this.ioBus << 8) & 0x0C00, 0x0C00);
        }
        this.w ^= 1;
        break;

      case 7: // PPUDATA
        if ((this.ppuBusAddress & 0x3FFF) >= 0x3F00) {
          this.writePaletteRam(this.ppuBusAddress, writeValue);
        } else {
          if (this.scanline >= 240 || !this.isRenderingEnabled()) {
            this.writeVram(this.ppuBusAddress & 0x3FFF, writeValue, "cpu");
          } else {
            // Rendering-time VRAM write corruption.
            this.writeVram(this.ppuBusAddress & 0x3FFF, this.ppuBusAddress & 0xFF, "cpu");
          }
        }

        this.needStateUpdate = true;
        this.needVideoRamIncrement = true;
        break;

      default:
        break;
    }
  }

  doDMA(page) {
    const base = (page & 0xFF) << 8;
    let oamAddr = this.oamAddr;

    for (let i = 0; i < 256; i++) {
      let value = this.nes.cpu.cpuRead((base + i) & 0xFFFF) & 0xFF;
      if ((oamAddr & 0x03) === 0x02) {
        value &= 0xE3;
      }
      this.oam[oamAddr] = value;
      oamAddr = (oamAddr + 1) & 0xFF;
    }

    const haltCycles = 513 + (this.nes.cpu.cycleCount & 0x01);
    if (typeof this.nes.cpu.haltCycles === "function") {
      this.nes.cpu.haltCycles(haltCycles);
    }
  }

  nmiChange() {
    const nmi = this.nmiOutput && this.nmiOccurred && this.allowFullPpuAccess;

    if (nmi && !this.nmiPrevious) {
      this.nmiDelay = 3;
    }

    this.nmiPrevious = nmi;

    if (!nmi && this.nes.cpu && typeof this.nes.cpu.clearNmiFlag === "function") {
      this.nes.cpu.clearNmiFlag();
    }
  }

  beginVBlank() {
    this.status |= PPU.STATUS_VBLANK;
    this.nmiOccurred = true;
    this.nmiChange();
  }

  triggerNmi() {
    if (this.nes.cpu && typeof this.nes.cpu.setNmiFlag === "function") {
      this.nes.cpu.setNmiFlag();
    } else if (this.nes.cpu && typeof this.nes.cpu.requestIrq === "function") {
      this.nes.cpu.requestIrq(1);
    }
  }

  updateVideoRamAddr() {
    if (this.scanline >= 240 || !this.isRenderingEnabled()) {
      this.v = (this.v + (this._ctrlVerticalWrite() ? 32 : 1)) & 0x7FFF;
      this.setBusAddress(this.v & 0x3FFF);
    } else {
      this.incHorizontalScrolling();
      this.incVerticalScrolling();
    }
  }

  incVerticalScrolling() {
    let addr = this.v;

    if ((addr & 0x7000) !== 0x7000) {
      addr += 0x1000;
    } else {
      addr &= ~0x7000;
      let y = (addr & 0x03E0) >> 5;
      if (y === 29) {
        y = 0;
        addr ^= 0x0800;
      } else if (y === 31) {
        y = 0;
      } else {
        y++;
      }
      addr = (addr & ~0x03E0) | (y << 5);
    }

    this.v = addr & 0x7FFF;
  }

  incHorizontalScrolling() {
    let addr = this.v;

    if ((addr & 0x001F) === 31) {
      addr = (addr & ~0x001F) ^ 0x0400;
    } else {
      addr++;
    }

    this.v = addr & 0x7FFF;
  }

  getNameTableAddr() {
    return 0x2000 | (this.v & 0x0FFF);
  }

  getAttributeAddr() {
    return 0x23C0 | (this.v & 0x0C00) | ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07);
  }

  loadTileInfo() {
    if (!this.isRenderingEnabled()) {
      return;
    }

    switch (this.cycle & 0x07) {
      case 1: {
        this.previousTilePalette = this.currentTilePalette;
        this.currentTilePalette = this.tile.paletteOffset;

        this.lowBitShift = (this.lowBitShift & 0xFF00) | this.tile.lowByte;
        this.highBitShift = (this.highBitShift & 0xFF00) | this.tile.highByte;

        const tileIndex = this.readVram(this.getNameTableAddr(), "tile");
        this.tile.tileAddr = (tileIndex << 4) | (this.v >> 12) | this._ctrlBackgroundPatternAddr();
        break;
      }

      case 3: {
        const shift = ((this.v >> 4) & 0x04) | (this.v & 0x02);
        const attrByte = this.readVram(this.getAttributeAddr(), "attribute");
        this.tile.paletteOffset = ((attrByte >> shift) & 0x03) << 2;
        break;
      }

      case 5:
        this.tile.lowByte = this.readVram(this.tile.tileAddr, "bg");
        break;

      case 7:
        this.tile.highByte = this.readVram(this.tile.tileAddr + 8, "bg");
        break;

      default:
        break;
    }
  }

  loadSprite(spriteY, tileIndex, attributes, spriteX, extraSprite) {
    const backgroundPriority = (attributes & 0x20) !== 0;
    const horizontalMirror = (attributes & 0x40) !== 0;
    const verticalMirror = (attributes & 0x80) !== 0;

    let lineOffset;
    if (verticalMirror) {
      lineOffset = (this._ctrlLargeSprites() ? 15 : 7) - (this.scanline - spriteY);
    } else {
      lineOffset = this.scanline - spriteY;
    }

    let tileAddr;
    if (this._ctrlLargeSprites()) {
      tileAddr = (((tileIndex & 0x01) ? 0x1000 : 0x0000) | ((tileIndex & ~0x01) << 4)) + (lineOffset >= 8 ? lineOffset + 8 : lineOffset);
    } else {
      tileAddr = ((tileIndex << 4) | this._ctrlSpritePatternAddr()) + lineOffset;
    }

    let fetchLastSprite = true;

    if ((this.spriteIndex < this.spriteCount || extraSprite) && spriteY < 240) {
      const info = this.spriteTiles[this.spriteIndex];
      info.backgroundPriority = backgroundPriority;
      info.horizontalMirror = horizontalMirror;
      info.paletteOffset = ((attributes & 0x03) << 2) | 0x10;

      fetchLastSprite = false;
      info.lowByte = this.readVram(tileAddr, "sprite");
      info.highByte = this.readVram(tileAddr + 8, "sprite");
      info.spriteX = spriteX;

      if (this.scanline >= 0) {
        for (let i = 0; i < 8 && spriteX + i + 1 < 257; i++) {
          this.hasSprite[spriteX + i + 1] = 1;
        }
      }
    }

    if (fetchLastSprite) {
      lineOffset = 0;
      tileIndex = 0xFF;

      if (this._ctrlLargeSprites()) {
        tileAddr = (((tileIndex & 0x01) ? 0x1000 : 0x0000) | ((tileIndex & ~0x01) << 4)) + lineOffset;
      } else {
        tileAddr = ((tileIndex << 4) | this._ctrlSpritePatternAddr()) + lineOffset;
      }

      // Dummy fetches are required for correct mapper bus timing.
      this.readVram(tileAddr, "sprite");
      this.readVram(tileAddr + 8, "sprite");
    }

    this.spriteIndex++;
  }

  loadSpriteTileInfo() {
    const base = this.spriteIndex * 4;
    this.loadSprite(
      this.secondaryOAM[base],
      this.secondaryOAM[base + 1],
      this.secondaryOAM[base + 2],
      this.secondaryOAM[base + 3],
      false
    );
  }

  loadExtraSprites() {
    // Deliberately disabled: sprite limit stays hardware-accurate (8 sprites/scanline).
  }

  shiftTileRegisters() {
    this.lowBitShift = (this.lowBitShift << 1) & 0xFFFF;
    this.highBitShift = (this.highBitShift << 1) & 0xFFFF;
  }

  getPixelColor() {
    const offset = this.x;
    let backgroundColor = 0;
    let spriteBgColor = 0;

    if (this.cycle > this.minimumDrawBgCycle) {
      spriteBgColor = (((this.lowBitShift << offset) & 0x8000) >> 15) | (((this.highBitShift << offset) & 0x8000) >> 14);
      if (this._maskBgEnabled()) {
        backgroundColor = spriteBgColor;
      }
    }

    if (this.hasSprite[this.cycle] && this.cycle > this.minimumDrawSpriteCycle) {
      for (let i = 0; i < this.spriteCount; i++) {
        const sprite = this.spriteTiles[i];
        const shift = this.cycle - sprite.spriteX - 1;
        if (shift >= 0 && shift < 8) {
          let spriteColor;
          if (sprite.horizontalMirror) {
            spriteColor = ((sprite.lowByte >> shift) & 0x01) | (((sprite.highByte >> shift) & 0x01) << 1);
          } else {
            spriteColor = ((sprite.lowByte << shift) & 0x80) >> 7 | ((sprite.highByte << shift) & 0x80) >> 6;
          }

          if (spriteColor !== 0) {
            if (
              i === 0 &&
              spriteBgColor !== 0 &&
              this.sprite0Visible &&
              this.cycle !== 256 &&
              this._maskBgEnabled() &&
              (this.status & PPU.STATUS_SPRITE0_HIT) === 0 &&
              this.cycle > this.minimumDrawSpriteStandardCycle
            ) {
              this.status |= PPU.STATUS_SPRITE0_HIT;
            }

            if (this._maskSpritesEnabled() && (backgroundColor === 0 || !sprite.backgroundPriority)) {
              return sprite.paletteOffset + spriteColor;
            }
            break;
          }
        }
      }
    }

    return ((offset + ((this.cycle - 1) & 0x07) < 8) ? this.previousTilePalette : this.currentTilePalette) + backgroundColor;
  }

  drawPixel() {
    const x = this.cycle - 1;
    const y = this.scanline;

    if (x < 0 || x >= 256 || y < 0 || y >= 240) {
      return;
    }

    let nesColor;

    if (this.isRenderingEnabled() || ((this.v & 0x3F00) !== 0x3F00)) {
      const color = this.getPixelColor();
      nesColor = this.readPaletteRam((color & 0x03) ? color : 0) & this.paletteRamMask;
    } else {
      nesColor = this.readPaletteRam(this.v) & this.paletteRamMask;
    }

    const rgb = this.nes.palTable ? this.nes.palTable.getEntry(nesColor & 0x3F) : (nesColor & 0x3F);
    this.framebuffer[(y << 8) + x] = rgb;
  }

  processSpriteEvaluationStart() {
    this.sprite0Added = false;
    this.spriteInRange = false;
    this.secondaryOamAddr = 0;

    this.overflowBugCounter = 0;
    this.oamCopyDone = false;

    this.spriteAddrH = (this.oamAddr >> 2) & 0x3F;
    this.spriteAddrL = this.oamAddr & 0x03;

    this.firstVisibleSpriteAddr = this.spriteAddrH * 4;
    this.lastVisibleSpriteAddr = this.firstVisibleSpriteAddr;
  }

  processSpriteEvaluationEnd() {
    this.sprite0Visible = this.sprite0Added;
    this.spriteCount = (this.secondaryOamAddr + 3) >> 2;
    if (this.spriteCount > 8) {
      this.spriteCount = 8;
    }
  }

  processSpriteEvaluation() {
    if (!this.isRenderingEnabled() && !(this.region === "pal" && this.scanline >= this.palSpriteEvalScanline)) {
      return;
    }

    if (this.cycle < 65) {
      this.oamCopyBuffer = 0xFF;
      this.secondaryOAM[(this.cycle - 1) >> 1] = 0xFF;
      return;
    }

    if (this.cycle & 0x01) {
      if (this.cycle === 65) {
        this.processSpriteEvaluationStart();
      }

      this.oamCopyBuffer = this.oam[(this.spriteAddrL & 0x03) | (this.spriteAddrH << 2)] & 0xFF;
      return;
    }

    if (this.cycle === 256) {
      this.processSpriteEvaluationEnd();
    }

    if (this.oamCopyDone) {
      this.spriteAddrH = (this.spriteAddrH + 1) & 0x3F;
      if (this.secondaryOamAddr >= 0x20) {
        this.oamCopyBuffer = this.secondaryOAM[this.secondaryOamAddr & 0x1F] & 0xFF;
      }
    } else {
      if (!this.spriteInRange && this.scanline >= this.oamCopyBuffer && this.scanline < this.oamCopyBuffer + (this._ctrlLargeSprites() ? 16 : 8)) {
        this.spriteInRange = true;
      }

      if (this.secondaryOamAddr < 0x20) {
        this.secondaryOAM[this.secondaryOamAddr] = this.oamCopyBuffer & 0xFF;

        if (this.spriteInRange) {
          if (this.cycle === 66) {
            this.sprite0Added = true;
          }

          this.spriteAddrL++;
          this.secondaryOamAddr++;

          if (this.spriteAddrL >= 4) {
            this.spriteAddrH = (this.spriteAddrH + 1) & 0x3F;
            this.spriteAddrL = 0;

            if (this.spriteAddrH === 0) {
              this.oamCopyDone = true;
            }
          }

          if ((this.secondaryOamAddr & 0x03) === 0) {
            this.spriteInRange = false;
            this.lastVisibleSpriteAddr = (this.spriteAddrH - 1) * 4;

            if (this.spriteAddrL !== 0) {
              const inRange = this.scanline >= this.oamCopyBuffer && this.scanline < this.oamCopyBuffer + (this._ctrlLargeSprites() ? 16 : 8);
              if (!inRange) {
                this.spriteAddrL = 0;
              }
            }
          }
        } else {
          this.spriteAddrH = (this.spriteAddrH + 1) & 0x3F;
          this.spriteAddrL = 0;
          if (this.spriteAddrH === 0) {
            this.oamCopyDone = true;
          }
        }
      } else {
        this.oamCopyBuffer = this.secondaryOAM[this.secondaryOamAddr & 0x1F] & 0xFF;

        if (this.oamCopyDone) {
          this.spriteAddrH = (this.spriteAddrH + 1) & 0x3F;
          this.spriteAddrL = 0;
        } else if (this.spriteInRange) {
          this.status |= PPU.STATUS_SPRITE_OVERFLOW;
          this.spriteAddrL++;
          if (this.spriteAddrL === 4) {
            this.spriteAddrH = (this.spriteAddrH + 1) & 0x3F;
            this.spriteAddrL = 0;
          }

          if (this.overflowBugCounter === 0) {
            this.overflowBugCounter = 3;
          } else {
            this.overflowBugCounter--;
            if (this.overflowBugCounter === 0) {
              this.oamCopyDone = true;
              this.spriteAddrL = 0;
            }
          }
        } else {
          this.spriteAddrH = (this.spriteAddrH + 1) & 0x3F;
          this.spriteAddrL = (this.spriteAddrL + 1) & 0x03;

          if (this.spriteAddrH === 0) {
            this.oamCopyDone = true;
          }
        }
      }
    }

    this.oamAddr = (this.spriteAddrL & 0x03) | (this.spriteAddrH << 2);
  }

  processScanline() {
    if (this.cycle <= 256) {
      this.loadTileInfo();

      if (this.prevRenderingEnabled && (this.cycle & 0x07) === 0) {
        this.incHorizontalScrolling();
        if (this.cycle === 256) {
          this.incVerticalScrolling();
        }
      }

      if (this.scanline >= 0) {
        this.drawPixel();
        this.shiftTileRegisters();
        this.processSpriteEvaluation();
      } else if (this.cycle < 9) {
        // Pre-render scanline
        if (this.cycle === 1) {
          this.status &= ~(PPU.STATUS_VBLANK | PPU.STATUS_SPRITE0_HIT | PPU.STATUS_SPRITE_OVERFLOW);
          this.nmiOccurred = false;
          this.nmiChange();
          if (this.nes.cpu && typeof this.nes.cpu.clearNmiFlag === "function") {
            this.nes.cpu.clearNmiFlag();
          }
        }

        if (this.oamAddr >= 0x08 && this.isRenderingEnabled()) {
          this.oam[this.cycle - 1] = this.oam[(this.oamAddr & 0xF8) + this.cycle - 1];
        }
      }
    } else if (this.cycle >= 257 && this.cycle <= 320) {
      if (this.cycle === 257) {
        this.spriteIndex = 0;
        this.hasSprite.fill(0);

        if (this.prevRenderingEnabled) {
          this.v = (this.v & ~0x041F) | (this.t & 0x041F);
        }
      }

      if (this.isRenderingEnabled()) {
        this.oamAddr = 0;

        switch ((this.cycle - 257) % 8) {
          case 0:
            this.readVram(this.getNameTableAddr(), "sprite");
            break;
          case 2:
            this.readVram(this.getAttributeAddr(), "sprite");
            break;
          case 4:
            this.loadSpriteTileInfo();
            break;
          default:
            break;
        }

        if (this.scanline === -1 && this.cycle >= 280 && this.cycle <= 304) {
          this.v = (this.v & ~0x7BE0) | (this.t & 0x7BE0);
        }

        if (this.cycle === 320) {
          this.loadExtraSprites();
        }
      }
    } else if (this.cycle >= 321 && this.cycle <= 336) {
      this.loadTileInfo();

      if (this.cycle === 321) {
        if (this.isRenderingEnabled()) {
          this.oamCopyBuffer = this.secondaryOAM[0] & 0xFF;
        }
      } else if (this.prevRenderingEnabled && (this.cycle === 328 || this.cycle === 336)) {
        this.lowBitShift = (this.lowBitShift << 8) & 0xFFFF;
        this.highBitShift = (this.highBitShift << 8) & 0xFFFF;
        this.incHorizontalScrolling();
      }
    } else if (this.cycle === 337 || this.cycle === 339) {
      if (this.isRenderingEnabled()) {
        this.tile.tileAddr = this.readVram(this.getNameTableAddr(), "tile");

        if (
          this.scanline === -1 &&
          this.cycle === 339 &&
          (this.frame & 0x01) &&
          this.region === "ntsc"
        ) {
          // NTSC odd-frame skip.
          this.cycle = 340;
        }
      }
    }

    // Mapper hook for scanline counters that latch on cycle 4.
    if (this.cycle === 4 && this.isRenderingEnabled() && (this.scanline < 240 || this.scanline === -1)) {
      const mapper = this.nes.mmap;
      if (mapper && typeof mapper.onEndScanline === "function") {
        mapper.onEndScanline(this.scanline, this.getMapperContext());
      }
    }
  }

  processScanlineFirstCycle() {
    this.cycle = 0;

    if (++this.scanline > this.vblankEnd) {
      this.scanline = -1;
      this.spriteCount = 0;
      this.updateMinimumDrawCycles();
    }

    if (this.scanline < 240) {
      if (this.scanline === -1) {
        this.status &= ~(PPU.STATUS_SPRITE_OVERFLOW | PPU.STATUS_SPRITE0_HIT);
        this.allowFullPpuAccess = true;
        this.inWarmup = false;
      } else if (this.prevRenderingEnabled) {
        if (
          this.scanline > 0 ||
          !((this.frame & 0x01) && this.region === "ntsc")
        ) {
          this.setBusAddress(((this.tile.tileAddr << 4) | (this.v >> 12) | this._ctrlBackgroundPatternAddr()) & 0x3FFF);
        }
      }
    } else if (this.scanline === 240) {
      this.setBusAddress(this.v & 0x3FFF);
      this.sendFrame();
      this.frame++;
      this.oddFrame = (this.frame & 0x01) !== 0;
    }
  }

  sendFrame() {
    if (this.nes && this.nes.ui && typeof this.nes.ui.writeFrame === "function") {
      this.nes.ui.writeFrame(this.framebuffer);
    }
    this.frameComplete = true;
  }

  updateState() {
    this.needStateUpdate = false;

    if (this.prevRenderingEnabled !== this.renderingEnabled) {
      this.prevRenderingEnabled = this.renderingEnabled;

      if (this.scanline < 240) {
        if (!this.prevRenderingEnabled) {
          this.setBusAddress(this.v & 0x3FFF);

          if (this.cycle >= 65 && this.cycle <= 256) {
            this.oamAddr = (this.oamAddr + 1) & 0xFF;
            this.spriteAddrH = (this.oamAddr >> 2) & 0x3F;
            this.spriteAddrL = this.oamAddr & 0x03;
          }
        }
      }
    }

    if (this.renderingEnabled !== ((this.mask & 0x18) !== 0)) {
      this.renderingEnabled = ((this.mask & 0x18) !== 0);
      this.needStateUpdate = true;
    }

    if (this.updateVramAddrDelay > 0) {
      this.updateVramAddrDelay--;

      if (this.updateVramAddrDelay === 0) {
        this.v = this.updateVramAddr & 0x7FFF;
        this.t = this.v;

        if (this.scanline >= 240 || !this.isRenderingEnabled()) {
          this.setBusAddress(this.v & 0x3FFF);
        }
      } else {
        this.needStateUpdate = true;
      }
    }

    if (this.ignoreVramRead > 0) {
      this.ignoreVramRead--;
      if (this.ignoreVramRead > 0) {
        this.needStateUpdate = true;
      }
    }

    if (this.needVideoRamIncrement) {
      this.needVideoRamIncrement = false;
      this.updateVideoRamAddr();
    }
  }

  step() {
    this.ppuClock++;

    const mapper = this.nes.mmap;
    if (this.cycle === 0 && mapper && typeof mapper.onStartScanline === "function") {
      mapper.onStartScanline(this.scanline, this.isRenderingEnabled(), this.getMapperContext());
    }

    if (this.cycle < 340) {
      this.cycle++;

      if (this.scanline < 240) {
        this.processScanline();
      } else if (this.cycle === 1 && this.scanline === this.nmiScanline) {
        if (!this.preventVblFlag) {
          this.beginVBlank();
        }
        this.preventVblFlag = false;
      } else if (this.region === "pal" && this.scanline >= this.palSpriteEvalScanline) {
        if (this.cycle <= 256) {
          this.processSpriteEvaluation();
        } else if (this.cycle >= 257 && this.cycle < 320) {
          this.oamAddr = 0;
        }
      }
    } else {
      this.processScanlineFirstCycle();
    }

    if (this.nmiDelay > 0) {
      this.nmiDelay--;
      if (this.nmiDelay === 0 && this.nmiOutput && this.nmiOccurred && this.allowFullPpuAccess) {
        this.triggerNmi();
      }
    }

    if (this.needStateUpdate) {
      this.updateState();
    }
  }

  toJSON() {
    return {
      stateVersion: 3,

      vramMem: Array.from(this.vramMem),
      palette: Array.from(this.palette),
      oam: Array.from(this.oam),
      secondaryOAM: Array.from(this.secondaryOAM),

      ctrl: this.ctrl,
      mask: this.mask,
      status: this.status,
      oamAddr: this.oamAddr,

      v: this.v,
      t: this.t,
      x: this.x,
      w: this.w,

      ioBus: this.ioBus,
      memoryReadBuffer: this.memoryReadBuffer,

      scanline: this.scanline,
      cycle: this.cycle,
      frame: this.frame,
      oddFrame: this.oddFrame,
      ppuClock: this.ppuClock,
      frameComplete: this.frameComplete,

      region: this.region,
      nmiScanline: this.nmiScanline,
      vblankEnd: this.vblankEnd,
      preRenderScanline: this.preRenderScanline,
      palSpriteEvalScanline: this.palSpriteEvalScanline,
      oddFrameCycleSkip: this.oddFrameCycleSkip,

      nmiOccurred: this.nmiOccurred,
      nmiOutput: this.nmiOutput,
      nmiPrevious: this.nmiPrevious,
      nmiDelay: this.nmiDelay,
      preventVblFlag: this.preventVblFlag,

      allowFullPpuAccess: this.allowFullPpuAccess,
      inWarmup: this.inWarmup,

      renderingEnabled: this.renderingEnabled,
      prevRenderingEnabled: this.prevRenderingEnabled,
      needStateUpdate: this.needStateUpdate,

      updateVramAddrDelay: this.updateVramAddrDelay,
      updateVramAddr: this.updateVramAddr,
      needVideoRamIncrement: this.needVideoRamIncrement,
      ignoreVramRead: this.ignoreVramRead,

      ppuBusAddress: this.ppuBusAddress,
      ppuA12Prev: this.ppuA12Prev,
      lastA12HighScanline: this.lastA12HighScanline,
      lastA12HighCycle: this.lastA12HighCycle,

      lowBitShift: this.lowBitShift,
      highBitShift: this.highBitShift,
      currentTilePalette: this.currentTilePalette,
      previousTilePalette: this.previousTilePalette,
      tile: {
        tileAddr: this.tile.tileAddr,
        lowByte: this.tile.lowByte,
        highByte: this.tile.highByte,
        paletteOffset: this.tile.paletteOffset,
      },

      hasSprite: Array.from(this.hasSprite),
      spriteCount: this.spriteCount,
      spriteIndex: this.spriteIndex,
      sprite0Visible: this.sprite0Visible,

      oamCopyBuffer: this.oamCopyBuffer,
      secondaryOamAddr: this.secondaryOamAddr,
      spriteInRange: this.spriteInRange,
      sprite0Added: this.sprite0Added,
      spriteAddrH: this.spriteAddrH,
      spriteAddrL: this.spriteAddrL,
      oamCopyDone: this.oamCopyDone,
      overflowBugCounter: this.overflowBugCounter,
      firstVisibleSpriteAddr: this.firstVisibleSpriteAddr,
      lastVisibleSpriteAddr: this.lastVisibleSpriteAddr,

      spriteTiles: this.spriteTiles.map((s) => ({
        spriteX: s.spriteX,
        lowByte: s.lowByte,
        highByte: s.highByte,
        paletteOffset: s.paletteOffset,
        horizontalMirror: !!s.horizontalMirror,
        backgroundPriority: !!s.backgroundPriority,
      })),

      paletteRamMask: this.paletteRamMask,
      intensifyColorBits: this.intensifyColorBits,
      minimumDrawBgCycle: this.minimumDrawBgCycle,
      minimumDrawSpriteCycle: this.minimumDrawSpriteCycle,
      minimumDrawSpriteStandardCycle: this.minimumDrawSpriteStandardCycle,

      mirroringType: this.mirroringType,
      mirroring: this.mirroring,

      ppuStepAccumulator: this._ppuStepAccumulator,
      ppuStepsPerCpuNumerator: this._ppuStepsPerCpuNumerator,
      ppuStepsPerCpuDenominator: this._ppuStepsPerCpuDenominator,
    };
  }

  fromJSON(s) {
    if (!s || s.stateVersion !== 3) {
      throw new Error(`PPU save state version not supported (got v${s?.stateVersion}, expected v3)`);
    }

    this.vramMem = new Uint8Array(s.vramMem || this.vramMem);
    this.palette = new Uint8Array(s.palette || this.palette);
    this.oam = new Uint8Array(s.oam || this.oam);
    this.secondaryOAM = new Uint8Array(s.secondaryOAM || this.secondaryOAM);

    this.ctrl = (s.ctrl ?? this.ctrl) & 0xFF;
    this.mask = (s.mask ?? this.mask) & 0xFF;
    this.status = (s.status ?? this.status) & 0xFF;
    this.oamAddr = (s.oamAddr ?? this.oamAddr) & 0xFF;

    this.v = (s.v ?? this.v) & 0x7FFF;
    this.t = (s.t ?? this.t) & 0x7FFF;
    this.x = (s.x ?? this.x) & 0x07;
    this.w = s.w ? 1 : 0;

    this.ioBus = (s.ioBus ?? this.ioBus) & 0xFF;
    this.memoryReadBuffer = (s.memoryReadBuffer ?? this.memoryReadBuffer) & 0xFF;

    this.scanline = s.scanline ?? this.scanline;
    this.cycle = s.cycle ?? this.cycle;
    this.frame = s.frame ?? this.frame;
    this.oddFrame = s.oddFrame ?? ((this.frame & 0x01) !== 0);
    this.ppuClock = s.ppuClock ?? this.ppuClock;
    this.frameComplete = !!s.frameComplete;

    this.setRegion(s.region ?? this.region);
    this.nmiScanline = s.nmiScanline ?? this.nmiScanline;
    this.vblankEnd = s.vblankEnd ?? this.vblankEnd;
    this.preRenderScanline = s.preRenderScanline ?? (this.vblankEnd + 1);
    this.palSpriteEvalScanline = s.palSpriteEvalScanline ?? (this.nmiScanline + 24);
    this.oddFrameCycleSkip = s.oddFrameCycleSkip ?? this.oddFrameCycleSkip;

    this.nmiOccurred = !!(s.nmiOccurred ?? this.nmiOccurred);
    this.nmiOutput = !!(s.nmiOutput ?? ((this.ctrl & 0x80) !== 0));
    this.nmiPrevious = !!(s.nmiPrevious ?? this.nmiPrevious);
    this.nmiDelay = s.nmiDelay ?? this.nmiDelay;
    this.preventVblFlag = !!(s.preventVblFlag ?? this.preventVblFlag);

    this.allowFullPpuAccess = !!(s.allowFullPpuAccess ?? this.allowFullPpuAccess);
    this.inWarmup = !!(s.inWarmup ?? this.inWarmup);

    this.renderingEnabled = !!(s.renderingEnabled ?? ((this.mask & 0x18) !== 0));
    this.prevRenderingEnabled = !!(s.prevRenderingEnabled ?? this.renderingEnabled);
    this.needStateUpdate = !!(s.needStateUpdate ?? false);

    this.updateVramAddrDelay = s.updateVramAddrDelay ?? 0;
    this.updateVramAddr = s.updateVramAddr ?? this.v;
    this.needVideoRamIncrement = !!(s.needVideoRamIncrement ?? false);
    this.ignoreVramRead = s.ignoreVramRead ?? 0;

    this.ppuBusAddress = (s.ppuBusAddress ?? this.ppuBusAddress) & 0x3FFF;
    this.ppuA12Prev = s.ppuA12Prev ?? this.ppuA12Prev;
    this.lastA12HighScanline = s.lastA12HighScanline ?? this.lastA12HighScanline;
    this.lastA12HighCycle = s.lastA12HighCycle ?? this.lastA12HighCycle;

    this.lowBitShift = s.lowBitShift ?? this.lowBitShift;
    this.highBitShift = s.highBitShift ?? this.highBitShift;
    this.currentTilePalette = s.currentTilePalette ?? this.currentTilePalette;
    this.previousTilePalette = s.previousTilePalette ?? this.previousTilePalette;

    if (s.tile) {
      this.tile.tileAddr = s.tile.tileAddr ?? this.tile.tileAddr;
      this.tile.lowByte = s.tile.lowByte ?? this.tile.lowByte;
      this.tile.highByte = s.tile.highByte ?? this.tile.highByte;
      this.tile.paletteOffset = s.tile.paletteOffset ?? this.tile.paletteOffset;
    }

    this.hasSprite = new Uint8Array(s.hasSprite || this.hasSprite);
    this.spriteCount = s.spriteCount ?? this.spriteCount;
    this.spriteIndex = s.spriteIndex ?? this.spriteIndex;
    this.sprite0Visible = !!(s.sprite0Visible ?? this.sprite0Visible);

    this.oamCopyBuffer = s.oamCopyBuffer ?? this.oamCopyBuffer;
    this.secondaryOamAddr = s.secondaryOamAddr ?? this.secondaryOamAddr;
    this.spriteInRange = !!(s.spriteInRange ?? this.spriteInRange);
    this.sprite0Added = !!(s.sprite0Added ?? this.sprite0Added);
    this.spriteAddrH = s.spriteAddrH ?? this.spriteAddrH;
    this.spriteAddrL = s.spriteAddrL ?? this.spriteAddrL;
    this.oamCopyDone = !!(s.oamCopyDone ?? this.oamCopyDone);
    this.overflowBugCounter = s.overflowBugCounter ?? this.overflowBugCounter;
    this.firstVisibleSpriteAddr = s.firstVisibleSpriteAddr ?? this.firstVisibleSpriteAddr;
    this.lastVisibleSpriteAddr = s.lastVisibleSpriteAddr ?? this.lastVisibleSpriteAddr;

    if (s.spriteTiles && Array.isArray(s.spriteTiles)) {
      const count = Math.min(64, s.spriteTiles.length);
      for (let i = 0; i < count; i++) {
        const src = s.spriteTiles[i] || {};
        const dst = this.spriteTiles[i];
        dst.spriteX = src.spriteX ?? dst.spriteX;
        dst.lowByte = src.lowByte ?? dst.lowByte;
        dst.highByte = src.highByte ?? dst.highByte;
        dst.paletteOffset = src.paletteOffset ?? dst.paletteOffset;
        dst.horizontalMirror = !!(src.horizontalMirror ?? dst.horizontalMirror);
        dst.backgroundPriority = !!(src.backgroundPriority ?? dst.backgroundPriority);
      }
    }

    this.paletteRamMask = s.paletteRamMask ?? this.paletteRamMask;
    this.intensifyColorBits = s.intensifyColorBits ?? this.intensifyColorBits;
    this.minimumDrawBgCycle = s.minimumDrawBgCycle ?? this.minimumDrawBgCycle;
    this.minimumDrawSpriteCycle = s.minimumDrawSpriteCycle ?? this.minimumDrawSpriteCycle;
    this.minimumDrawSpriteStandardCycle = s.minimumDrawSpriteStandardCycle ?? this.minimumDrawSpriteStandardCycle;

    this.setMirroring(s.mirroringType ?? this.mirroringType);

    this._ppuStepAccumulator = s.ppuStepAccumulator ?? 0;
    this._ppuStepsPerCpuNumerator = s.ppuStepsPerCpuNumerator ?? this._ppuStepsPerCpuNumerator;
    this._ppuStepsPerCpuDenominator = s.ppuStepsPerCpuDenominator ?? this._ppuStepsPerCpuDenominator;

    this.updateMinimumDrawCycles();
    this.updateGrayscaleAndIntensifyBits();
    this.updatePaletteEmphasis();

    this.setBusAddress(this.ppuBusAddress);
  }
}

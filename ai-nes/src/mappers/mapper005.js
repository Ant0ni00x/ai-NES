// Mapper 005: MMC5 (HVC-ExROM)
//
// Features:
//   - PRG banking modes (8/16/32KB)
//   - CHR banking modes (1/2/4/8KB) with separate BG/Sprite banks
//   - 1KB ExRAM for nametable and attribute data / fill mode
//   - Split screen control
//   - Scanline IRQ + multiplier
//   - PCM audio playback
//   - PRG-RAM up to 64KB with write protection
//
// Notes:
//   - MMC5 audio is mixed via an external expansion audio module.
//   - Split timing is approximated using PPU scanline/cycle.
//
// References:
//   - https://wiki.nesdev.com/w/index.php/MMC5

import Mapper from './mapper-base.js';
import { Mmc5Audio } from './mapper005-audio.js';

export default class Mapper005 extends Mapper {
  constructor(cartridge) {
    super(cartridge);
    this.nes = cartridge.nes;
    this.mmc5Audio = new Mmc5Audio(this.nes);

    this.hasNametableOverride = true;
    this.hasPerTileAttributes = true;

    // MMC5 PRG RAM can be up to 64KB (8 x 8KB banks).
    this.prgRamBankCount = 8;
    this.prgRam = new Uint8Array(0x2000 * this.prgRamBankCount);
    this.fillRam(this.prgRam);

    // ExRAM (1KB)
    this.exram = new Uint8Array(0x400);

    if (!this.chrData || this.chrData.length === 0) {
      this.useVRAM(8);
    }

    this.reset();
  }

  reset() {
    super.reset();

    if (this.mmc5Audio) {
      this.mmc5Audio.reset();
      if (this.nes && this.nes.papu && this.nes.papu.setExpansionAudioSource) {
        this.nes.papu.setExpansionAudioSource('mmc5', this.mmc5Audio);
      }
    }

    this.programMode = 3;
    this.characterMode = 0;

    this.ramWriteProtect = [0, 0];
    this.exramMode = 0;
    this.nametableMode = [0, 0, 0, 0];
    this.fillmodeTile = 0;
    this.fillmodeColor = 0;

    this.ramSelect = 0;
    this.ramBank = 0;
    this.programBank = [0x00, 0x00, 0x00, 0xFF];

    this.characterSpriteBank = new Uint16Array(8);
    this.characterBackgroundBank = new Uint16Array(4);
    this.characterBankHi = 0;
    this.characterActive = 0;
    this.sprite8x16 = 0;

    this.vsplitEnable = 0;
    this.vsplitSide = 0;
    this.vsplitTile = 0;
    this.vsplitScroll = 0;
    this.vsplitBank = 0;

    this.irqCoincidence = 0;
    this.irqEnable = 0;
    this.irqLine = 0;
    this.inFrame = 0;
    this.vcounter = 0;

    this.multiplicand = 0;
    this.multiplier = 0;

    this.timerCounter = 0;
    this.timerLine = 0;

    this.pcmMode = 0;
    this.pcmIrqEnable = 0;
    this.pcmIrqLine = 0;
    this.pcmDac = 0;

    this.lastBgExram = 0;
    this.lastBgExramValid = false;
    this.lastBgVsplitActive = false;
    this.lastBgVsplitFineY = 0;

    this.exram.fill(0xFF);

    if (this.nes && this.nes.rom && this.nes.rom.batteryRam && this.nes.rom.batteryRam.length) {
      const len = Math.min(this.nes.rom.batteryRam.length, this.prgRam.length);
      this.prgRam.set(this.nes.rom.batteryRam.subarray(0, len));
    }
  }

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------
  isRenderingEnabled() {
    return !!(this.nes && this.nes.ppu && (this.nes.ppu.mask & 0x18));
  }

  updateCpuIrq() {
    if (!this.nes || !this.nes.cpu) return;
    const active = (this.irqEnable && this.irqLine) || (this.pcmIrqEnable && this.pcmIrqLine) || this.timerLine;
    if (active) {
      this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL);
    } else {
      this.nes.cpu.clearIrq(this.nes.cpu.IRQ_NORMAL);
    }
  }

  blank() {
    this.inFrame = 0;
  }

  resolvePrgBank(address) {
    if ((address & 0xE000) === 0x6000) {
      const bank = (this.ramSelect << 2) | this.ramBank;
      return { bank, offset: address & 0x1FFF, isRam: true };
    }

    let bank = 0;
    let offset = 0;

    if (this.programMode === 0) {
      const base = this.programBank[3] & ~3;
      offset = address & 0x7FFF;
      bank = base + (offset >> 13);
      offset &= 0x1FFF;
    } else if (this.programMode === 1) {
      const base = (address & 0xC000) === 0x8000
        ? (this.programBank[1] & ~1)
        : (this.programBank[3] & ~1);
      offset = address & 0x3FFF;
      bank = base + (offset >> 13);
      offset &= 0x1FFF;
    } else if (this.programMode === 2) {
      if ((address & 0xE000) === 0x8000 || (address & 0xE000) === 0xA000) {
        const base = this.programBank[1] & ~1;
        bank = base + ((address >> 13) & 1);
      } else if ((address & 0xE000) === 0xC000) {
        bank = this.programBank[2];
      } else {
        bank = this.programBank[3];
      }
      offset = address & 0x1FFF;
    } else {
      bank = this.programBank[(address >> 13) & 3];
      offset = address & 0x1FFF;
    }

    return { bank, offset, isRam: false };
  }

  readPrg(address) {
    const { bank, offset, isRam } = this.resolvePrgBank(address);
    if (isRam) {
      const index = bank % this.prgRamBankCount;
      return this.prgRam[(index * 0x2000) + offset];
    }

    const rom = (bank & 0x80) !== 0;
    const bankIndex = bank & 0x7F;
    if (rom) {
      if (!this.prgData || this.prgBankCount === 0) return 0;
      const index = bankIndex % this.prgBankCount;
      return this.prgData[(index * 0x2000) + offset];
    }

    const index = bankIndex % this.prgRamBankCount;
    return this.prgRam[(index * 0x2000) + offset];
  }

  writePrg(address, value) {
    const { bank, offset, isRam } = this.resolvePrgBank(address);
    if (isRam) {
      if (this.ramWriteProtect[0] === 2 && this.ramWriteProtect[1] === 1) {
        const index = bank % this.prgRamBankCount;
        this.prgRam[(index * 0x2000) + offset] = value;
      }
      return;
    }

    const rom = (bank & 0x80) !== 0;
    if (!rom && this.ramWriteProtect[0] === 2 && this.ramWriteProtect[1] === 1) {
      const bankIndex = bank & 0x7F;
      const index = bankIndex % this.prgRamBankCount;
      this.prgRam[(index * 0x2000) + offset] = value;
    }
  }

  getSpriteChrAddress(address) {
    if (this.characterMode === 0) {
      const bank = this.characterSpriteBank[7];
      return (bank << 13) | (address & 0x1FFF);
    }
    if (this.characterMode === 1) {
      const bank = this.characterSpriteBank[((address >> 12) * 4) + 3];
      return (bank << 12) | (address & 0x0FFF);
    }
    if (this.characterMode === 2) {
      const bank = this.characterSpriteBank[((address >> 11) * 2) + 1];
      return (bank << 11) | (address & 0x07FF);
    }
    const bank = this.characterSpriteBank[address >> 10];
    return (bank << 10) | (address & 0x03FF);
  }

  getBackgroundChrAddress(address) {
    const masked = address & 0x0FFF;
    if (this.characterMode === 0) {
      const bank = this.characterBackgroundBank[3];
      return (bank << 13) | masked;
    }
    if (this.characterMode === 1) {
      const bank = this.characterBackgroundBank[3];
      return (bank << 12) | masked;
    }
    if (this.characterMode === 2) {
      const bank = this.characterBackgroundBank[((masked >> 11) * 2) + 1];
      return (bank << 11) | (masked & 0x07FF);
    }
    const bank = this.characterBackgroundBank[masked >> 10];
    return (bank << 10) | (masked & 0x03FF);
  }

  readChrData(chrAddress) {
    if (!this.chrData || this.chrData.length === 0) return 0;
    const addr = chrAddress % this.chrData.length;
    return this.chrData[addr] || 0;
  }

  // ----------------------------------------------------------
  // CPU reads/writes
  // ----------------------------------------------------------
  cpuRead(address) {
    if ((address & 0xFC00) === 0x5800) {
      return undefined;
    }

    if ((address & 0xFC00) === 0x5C00) {
      if (this.exramMode >= 2) return this.exram[address & 0x03FF];
      return undefined;
    }

    if (address >= 0x6000) {
      const data = this.readPrg(address);
      if (this.pcmMode === 1 && (address & 0xC000) === 0x8000) {
        this.pcmDac = data;
        if (this.mmc5Audio) {
          this.mmc5Audio.setPcmOutput(data);
        }
      }
      return data;
    }

    switch (address) {
      case 0x5010: {
        let data = 0;
        if (this.pcmMode) data |= 0x01;
        if (this.pcmIrqLine && this.pcmIrqEnable) data |= 0x80;
        this.pcmIrqLine = 0;
        this.updateCpuIrq();
        return data;
      }
      case 0x5015: {
        return this.mmc5Audio ? this.mmc5Audio.readStatus() : 0;
      }
      case 0x5204: {
        let data = 0;
        if (this.inFrame) data |= 0x40;
        if (this.irqLine) data |= 0x80;
        this.irqLine = 0;
        this.updateCpuIrq();
        return data;
      }
      case 0x5205:
        return (this.multiplier * this.multiplicand) & 0xFF;
      case 0x5206:
        return ((this.multiplier * this.multiplicand) >> 8) & 0xFF;
      default:
        return undefined;
    }
  }

  cpuWrite(address, value) {
    if ((address & 0xFC00) === 0x5800) {
      return;
    }

    if ((address & 0xFC00) === 0x5C00) {
      if (this.exramMode === 0 || this.exramMode === 1) {
        this.exram[address & 0x03FF] = this.inFrame ? value : 0x00;
      } else if (this.exramMode === 2) {
        this.exram[address & 0x03FF] = value;
      }
      return;
    }

    if (address >= 0x6000) {
      this.writePrg(address, value);
      return;
    }

    switch (address) {
      case 0x5000:
      case 0x5001:
      case 0x5002:
      case 0x5003:
      case 0x5004:
      case 0x5005:
      case 0x5006:
      case 0x5007:
        if (this.mmc5Audio) {
          this.mmc5Audio.writeRegister(address, value);
        }
        return;

      case 0x5010:
        this.pcmMode = value & 0x01;
        this.pcmIrqEnable = (value & 0x80) !== 0;
        if (this.mmc5Audio) {
          this.mmc5Audio.writeRegister(address, value);
        }
        this.updateCpuIrq();
        return;

      case 0x5011:
        if (this.pcmMode === 0) {
          if (value === 0x00) this.pcmIrqLine = 1;
          if (value !== 0x00) this.pcmDac = value;
          this.updateCpuIrq();
        }
        if (this.mmc5Audio) {
          this.mmc5Audio.writeRegister(address, value);
        }
        return;

      case 0x5015:
        if (this.mmc5Audio) {
          this.mmc5Audio.writeRegister(address, value);
        }
        return;

      case 0x5100:
        this.programMode = value & 0x03;
        return;

      case 0x5101:
        this.characterMode = value & 0x03;
        return;

      case 0x5102:
        this.ramWriteProtect[0] = value & 0x03;
        return;

      case 0x5103:
        this.ramWriteProtect[1] = value & 0x03;
        return;

      case 0x5104:
        this.exramMode = value & 0x03;
        return;

      case 0x5105:
        this.nametableMode[0] = value & 0x03;
        this.nametableMode[1] = (value >> 2) & 0x03;
        this.nametableMode[2] = (value >> 4) & 0x03;
        this.nametableMode[3] = (value >> 6) & 0x03;
        return;

      case 0x5106:
        this.fillmodeTile = value;
        return;

      case 0x5107: {
        const pal = value & 0x03;
        this.fillmodeColor = pal | (pal << 2) | (pal << 4) | (pal << 6);
        return;
      }

      case 0x5113:
        this.ramBank = value & 0x03;
        this.ramSelect = (value >> 2) & 0x01;
        return;

      case 0x5114:
        this.programBank[0] = value;
        return;

      case 0x5115:
        this.programBank[1] = value;
        return;

      case 0x5116:
        this.programBank[2] = value;
        return;

      case 0x5117:
        this.programBank[3] = value | 0x80;
        return;

      case 0x5120:
      case 0x5121:
      case 0x5122:
      case 0x5123:
      case 0x5124:
      case 0x5125:
      case 0x5126:
      case 0x5127:
        this.characterSpriteBank[address - 0x5120] = (this.characterBankHi << 8) | value;
        this.characterActive = 0;
        return;

      case 0x5128:
      case 0x5129:
      case 0x512A:
      case 0x512B:
        this.characterBackgroundBank[address - 0x5128] = (this.characterBankHi << 8) | value;
        this.characterActive = 1;
        return;

      case 0x5130:
        this.characterBankHi = value & 0x03;
        return;

      case 0x5200:
        this.vsplitTile = value & 0x1F;
        this.vsplitSide = (value >> 6) & 0x01;
        this.vsplitEnable = (value >> 7) & 0x01;
        return;

      case 0x5201:
        this.vsplitScroll = value;
        return;

      case 0x5202:
        this.vsplitBank = value;
        return;

      case 0x5203:
        this.irqCoincidence = value;
        return;

      case 0x5204:
        this.irqEnable = (value & 0x80) !== 0;
        this.updateCpuIrq();
        return;

      case 0x5205:
        this.multiplicand = value;
        return;

      case 0x5206:
        this.multiplier = value;
        return;

      case 0x5209:
        this.timerCounter = (this.timerCounter & 0xFF00) | value;
        this.timerLine = 0;
        this.updateCpuIrq();
        return;

      case 0x520A:
        this.timerCounter = (this.timerCounter & 0x00FF) | (value << 8);
        this.timerLine = 0;
        this.updateCpuIrq();
        return;
    }
  }

  // ----------------------------------------------------------
  // PPU hooks
  // ----------------------------------------------------------
  onPpuRegisterWrite(addr, value) {
    if (addr === 0x2000) {
      this.sprite8x16 = (value >> 5) & 0x01;
    } else if (addr === 0x2001) {
      if ((value & 0x18) === 0) this.blank();
    }
  }

  onEndScanline(scanline) {
    if (!this.isRenderingEnabled()) {
      this.inFrame = 0;
      return;
    }

    if (scanline === 0) {
      this.inFrame = 1;
      this.irqLine = 0;
      this.vcounter = 0;
      this.updateCpuIrq();
    }

    if (scanline < 240 && this.inFrame) {
      if (this.vcounter === this.irqCoincidence) {
        this.irqLine = 1;
        this.updateCpuIrq();
      }
      this.vcounter++;
    } else {
      this.inFrame = 0;
    }
  }

  cpuClock(cpuCycles) {
    if (this.timerCounter > 0) {
      if (cpuCycles >= this.timerCounter) {
        this.timerCounter = 0;
        this.timerLine = 1;
        this.updateCpuIrq();
      } else {
        this.timerCounter -= cpuCycles;
      }
    }
  }

  // ----------------------------------------------------------
  // Nametable handling
  // ----------------------------------------------------------
  readNametable(address, context) {
    const table = (address >> 10) & 0x03;
    const offset = address & 0x03FF;
    const mode = this.nametableMode[table];

    if (context === 'attribute') {
      if (mode === 3) {
        return this.fillmodeColor & 0x03;
      }

      const ppu = this.nes && this.nes.ppu ? this.nes.ppu : null;
      const v = ppu ? ppu.v : 0;
      const coarseX = v & 0x1F;
      const coarseY = (v >> 5) & 0x1F;
      const shift = ((coarseY & 0x02) ? 4 : 0) | ((coarseX & 0x02) ? 2 : 0);

      let attrByte = 0;
      if (mode === 0) {
        attrByte = this.nes.ppu.vramMem[0x2000 + offset];
      } else if (mode === 1) {
        attrByte = this.nes.ppu.vramMem[0x2400 + offset];
      } else if (mode === 2) {
        attrByte = this.exram[offset];
      }

      return (attrByte >> shift) & 0x03;
    }

    if (context === 'tile') {
      this.lastBgVsplitActive = false;
      if (this.exramMode === 1) {
        this.lastBgExram = this.exram[offset];
        this.lastBgExramValid = true;
      } else {
        this.lastBgExramValid = false;
      }

      if (this.vsplitEnable && this.exramMode < 2 && this.isRenderingEnabled()) {
        const tileX = offset & 0x1F;
        const active = this.vsplitSide ? tileX >= this.vsplitTile : tileX < this.vsplitTile;
        if (active) {
          const scanline = this.nes && this.nes.ppu ? this.nes.ppu.scanline : 0;
          const v = (scanline + this.vsplitScroll) % 240;
          const tileY = (v >> 3) & 0x1F;
          const index = (tileY * 32 + tileX) & 0x03FF;
          this.lastBgVsplitActive = true;
          this.lastBgVsplitFineY = v & 7;
          this.lastBgExram = this.exram[index];
          this.lastBgExramValid = true;
          return this.exram[index];
        }
      }
    }

    switch (mode) {
      case 0:
        return this.nes.ppu.vramMem[0x2000 + offset];
      case 1:
        return this.nes.ppu.vramMem[0x2400 + offset];
      case 2:
        return this.exramMode < 2 ? this.exram[offset] : 0x00;
      case 3:
        return context === 'attribute' ? this.fillmodeColor : this.fillmodeTile;
      default:
        return 0;
    }
  }

  setNametableByte(address, value) {
    const table = (address >> 10) & 0x03;
    const offset = address & 0x03FF;
    const mode = this.nametableMode[table];

    switch (mode) {
      case 0:
        this.nes.ppu.vramMem[0x2000 + offset] = value;
        return;
      case 1:
        this.nes.ppu.vramMem[0x2400 + offset] = value;
        return;
      case 2:
        this.exram[offset] = value;
        return;
      case 3:
        return;
    }
  }

  getExtendedAttributeByte(coarseX, coarseY) {
    if (this.lastBgVsplitActive && this.lastBgExramValid) {
      const attr = (this.lastBgExram >> 6) & 0x03;
      return attr | (attr << 2) | (attr << 4) | (attr << 6);
    }
    if (this.exramMode !== 1) return null;
    const index = ((coarseY & 0x1F) * 32 + (coarseX & 0x1F)) & 0x03FF;
    const attr = (this.exram[index] >> 6) & 0x03;
    return attr | (attr << 2) | (attr << 4) | (attr << 6);
  }

  ppuRead(address, context) {
    if (address >= 0x2000) return null;

    const mode = context || (this.characterActive ? 'bg' : 'sprite');
    if (mode === 'sprite') {
      const chrAddress = this.getSpriteChrAddress(address);
      return this.readChrData(chrAddress);
    }

    if (mode === 'bg') {
      if (this.lastBgVsplitActive) {
        const chrAddress = (this.vsplitBank << 12) | ((address & 0x0FF8) | this.lastBgVsplitFineY);
        return this.readChrData(chrAddress);
      }

      if (this.exramMode === 1 && this.lastBgExramValid) {
        const exbank = (this.characterBankHi << 6) | (this.lastBgExram & 0x3F);
        const chrAddress = (exbank << 12) | (address & 0x0FFF);
        return this.readChrData(chrAddress);
      }

      const chrAddress = this.getBackgroundChrAddress(address);
      return this.readChrData(chrAddress);
    }

    return null;
  }

  ppuWrite(address, value) {
    if (!this.usingChrRam || address >= 0x2000) return false;
    const chrAddress = this.getBackgroundChrAddress(address);
    if (!this.chrData || this.chrData.length === 0) return false;
    this.chrData[chrAddress % this.chrData.length] = value;
    return true;
  }

  // ----------------------------------------------------------
  // Save state
  // ----------------------------------------------------------
  toJSON() {
    return {
      prgRam: Array.from(this.prgRam),
      exram: Array.from(this.exram),
      programMode: this.programMode,
      characterMode: this.characterMode,
      ramWriteProtect: Array.from(this.ramWriteProtect),
      exramMode: this.exramMode,
      nametableMode: Array.from(this.nametableMode),
      fillmodeTile: this.fillmodeTile,
      fillmodeColor: this.fillmodeColor,
      ramSelect: this.ramSelect,
      ramBank: this.ramBank,
      programBank: Array.from(this.programBank),
      characterSpriteBank: Array.from(this.characterSpriteBank),
      characterBackgroundBank: Array.from(this.characterBackgroundBank),
      characterBankHi: this.characterBankHi,
      vsplitEnable: this.vsplitEnable,
      vsplitSide: this.vsplitSide,
      vsplitTile: this.vsplitTile,
      vsplitScroll: this.vsplitScroll,
      vsplitBank: this.vsplitBank,
      irqCoincidence: this.irqCoincidence,
      irqEnable: this.irqEnable,
      irqLine: this.irqLine,
      inFrame: this.inFrame,
      vcounter: this.vcounter,
      multiplicand: this.multiplicand,
      multiplier: this.multiplier,
      timerCounter: this.timerCounter,
      timerLine: this.timerLine,
      pcmMode: this.pcmMode,
      pcmIrqEnable: this.pcmIrqEnable,
      pcmIrqLine: this.pcmIrqLine,
      pcmDac: this.pcmDac,
      mmc5Audio: this.mmc5Audio ? this.mmc5Audio.toJSON() : null,
      characterActive: this.characterActive,
      sprite8x16: this.sprite8x16
    };
  }

  fromJSON(state) {
    if (!state) return;
    if (state.prgRam) this.prgRam = new Uint8Array(state.prgRam);
    if (state.exram) this.exram = new Uint8Array(state.exram);
    this.programMode = state.programMode || 0;
    this.characterMode = state.characterMode || 0;
    this.ramWriteProtect = state.ramWriteProtect || [0, 0];
    this.exramMode = state.exramMode || 0;
    this.nametableMode = state.nametableMode || [0, 0, 0, 0];
    this.fillmodeTile = state.fillmodeTile || 0;
    this.fillmodeColor = state.fillmodeColor || 0;
    this.ramSelect = state.ramSelect || 0;
    this.ramBank = state.ramBank || 0;
    this.programBank = state.programBank || [0, 0, 0, 0xFF];
    this.characterSpriteBank = new Uint16Array(state.characterSpriteBank || 8);
    this.characterBackgroundBank = new Uint16Array(state.characterBackgroundBank || 4);
    this.characterBankHi = state.characterBankHi || 0;
    this.vsplitEnable = state.vsplitEnable || 0;
    this.vsplitSide = state.vsplitSide || 0;
    this.vsplitTile = state.vsplitTile || 0;
    this.vsplitScroll = state.vsplitScroll || 0;
    this.vsplitBank = state.vsplitBank || 0;
    this.irqCoincidence = state.irqCoincidence || 0;
    this.irqEnable = state.irqEnable || 0;
    this.irqLine = state.irqLine || 0;
    this.inFrame = state.inFrame || 0;
    this.vcounter = state.vcounter || 0;
    this.multiplicand = state.multiplicand || 0;
    this.multiplier = state.multiplier || 0;
    this.timerCounter = state.timerCounter || 0;
    this.timerLine = state.timerLine || 0;
    this.pcmMode = state.pcmMode || 0;
    this.pcmIrqEnable = state.pcmIrqEnable || 0;
    this.pcmIrqLine = state.pcmIrqLine || 0;
    this.pcmDac = state.pcmDac || 0;
    if (this.mmc5Audio) {
      if (state.mmc5Audio) {
        this.mmc5Audio.fromJSON(state.mmc5Audio);
      } else {
        const pcmCtrl = (this.pcmMode ? 0x01 : 0x00) | (this.pcmIrqEnable ? 0x80 : 0x00);
        this.mmc5Audio.writeRegister(0x5010, pcmCtrl);
        this.mmc5Audio.setPcmOutput(this.pcmDac);
      }
    }
    this.characterActive = state.characterActive || 0;
    this.sprite8x16 = state.sprite8x16 || 0;
  }
}
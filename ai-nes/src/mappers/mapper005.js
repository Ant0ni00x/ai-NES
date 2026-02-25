import BaseMapper from "./mapper-base.js";

class Mmc5Audio {
  constructor() {
    this._registers = new Uint8Array(0x20);
  }

  reset() {
    this._registers.fill(0);
  }

  writeRegister(addr, value) {
    const address = addr & 0xFFFF;
    if (
      (address >= 0x5000 && address <= 0x5007) ||
      address === 0x5010 ||
      address === 0x5011 ||
      address === 0x5015
    ) {
      this._registers[address - 0x5000] = value & 0xFF;
    }
  }

  readRegister(addr) {
    const address = addr & 0xFFFF;
    if (address === 0x5010 || address === 0x5015) {
      return this._registers[address - 0x5000] & 0xFF;
    }
    return 0;
  }

  clock(_cycles = 1) {}

  getSample() {
    return 0;
  }

  toJSON() {
    return {
      registers: Array.from(this._registers),
    };
  }

  fromJSON(state) {
    this.reset();
    if (!state) {
      return;
    }
    if (state.registers) {
      this._registers = new Uint8Array(state.registers);
    }
    if (!(this._registers instanceof Uint8Array) || this._registers.length !== 0x20) {
      this._registers = new Uint8Array(0x20);
    }
  }
}

// Mapper 005 (MMC5)
// Mesen reference baseline from mesen-mmc5.h and mesen-mmc5-memoryhandler.h.
export default class Mapper005 extends BaseMapper {
  getPrgPageSize() {
    return 0x2000;
  }

  getChrPageSize() {
    return 0x0400;
  }

  getMapperRamSize() {
    return 0x0400; // ExRAM ($5C00-$5FFF)
  }

  registerStartAddress() {
    return 0x5000;
  }

  registerEndAddress() {
    return 0x5206;
  }

  getSaveRamPageSize() {
    return 0x2000;
  }

  getWorkRamPageSize() {
    return 0x2000;
  }

  forceSaveRamSize() {
    return true;
  }

  forceWorkRamSize() {
    return true;
  }

  allowRegisterRead() {
    return true;
  }

  enableCpuClockHook() {
    return true;
  }

  enableCustomVramRead() {
    return true;
  }

  getSaveRamSize() {
    const cart = this.cartridge || {};
    if (cart.isNES2) {
      return Math.max(0, cart.prgNvRamSizeBytes | 0);
    }
    return this.hasBattery() ? 0x10000 : 0;
  }

  getWorkRamSize() {
    const cart = this.cartridge || {};
    if (cart.isNES2) {
      return Math.max(0, cart.prgRamSizeBytes | 0);
    }
    return this.hasBattery() ? 0 : 0x10000;
  }

  _ensureState() {
    if (!(this._audio instanceof Mmc5Audio)) {
      this._audio = new Mmc5Audio();
    }

    if (!(this._ppuRegs instanceof Uint8Array) || this._ppuRegs.length !== 8) {
      this._ppuRegs = new Uint8Array(8);
    }

    if (!(this._prgBanks instanceof Uint8Array) || this._prgBanks.length !== 5) {
      this._prgBanks = new Uint8Array(5);
    }

    if (!(this._chrBanks instanceof Uint16Array) || this._chrBanks.length !== 12) {
      this._chrBanks = new Uint16Array(12);
    }

    if (!(this._fillNametable instanceof Uint8Array) || this._fillNametable.length !== BaseMapper.NametableSize) {
      this._fillNametable = new Uint8Array(BaseMapper.NametableSize);
    }

    if (!(this._emptyNametable instanceof Uint8Array) || this._emptyNametable.length !== BaseMapper.NametableSize) {
      this._emptyNametable = new Uint8Array(BaseMapper.NametableSize);
    }

    if (typeof this._prgRamProtect1 !== "number") this._prgRamProtect1 = 0;
    if (typeof this._prgRamProtect2 !== "number") this._prgRamProtect2 = 0;

    if (typeof this._fillModeTile !== "number") this._fillModeTile = 0;
    if (typeof this._fillModeColor !== "number") this._fillModeColor = 0;

    if (typeof this._verticalSplitEnabled !== "boolean") this._verticalSplitEnabled = false;
    if (typeof this._verticalSplitRightSide !== "boolean") this._verticalSplitRightSide = false;
    if (typeof this._verticalSplitDelimiterTile !== "number") this._verticalSplitDelimiterTile = 0;
    if (typeof this._verticalSplitScroll !== "number") this._verticalSplitScroll = 0;
    if (typeof this._verticalSplitBank !== "number") this._verticalSplitBank = 0;

    if (typeof this._splitInSplitRegion !== "boolean") this._splitInSplitRegion = false;
    if (typeof this._splitTile !== "number") this._splitTile = 0;
    if (typeof this._splitTileNumber !== "number") this._splitTileNumber = 0;

    if (typeof this._multiplierValue1 !== "number") this._multiplierValue1 = 0;
    if (typeof this._multiplierValue2 !== "number") this._multiplierValue2 = 0;

    if (typeof this._nametableMapping !== "number") this._nametableMapping = 0;
    if (typeof this._extendedRamMode !== "number") this._extendedRamMode = 0;

    if (typeof this._exAttributeLastNametableFetch !== "number") this._exAttributeLastNametableFetch = 0;
    if (typeof this._exAttrLastFetchCounter !== "number") this._exAttrLastFetchCounter = 0;
    if (typeof this._exAttrSelectedChrBank !== "number") this._exAttrSelectedChrBank = 0;

    if (typeof this._prgMode !== "number") this._prgMode = 0;
    if (typeof this._chrMode !== "number") this._chrMode = 0;
    if (typeof this._chrUpperBits !== "number") this._chrUpperBits = 0;
    if (typeof this._lastChrReg !== "number") this._lastChrReg = 0;
    if (typeof this._prevChrA !== "boolean") this._prevChrA = false;

    if (typeof this._irqCounterTarget !== "number") this._irqCounterTarget = 0;
    if (typeof this._irqEnabled !== "boolean") this._irqEnabled = false;
    if (typeof this._scanlineCounter !== "number") this._scanlineCounter = 0;
    if (typeof this._irqPending !== "boolean") this._irqPending = false;

    if (typeof this._needInFrame !== "boolean") this._needInFrame = false;
    if (typeof this._ppuInFrame !== "boolean") this._ppuInFrame = false;
    if (typeof this._ppuIdleCounter !== "number") this._ppuIdleCounter = 0;
    if (typeof this._lastPpuReadAddr !== "number") this._lastPpuReadAddr = 0;
    if (typeof this._ntReadCounter !== "number") this._ntReadCounter = 0;
  }

  _ensureAudioSource() {
    this._ensureState();
    if (this.nes && this.nes.papu && typeof this.nes.papu.setExpansionAudioSource === "function") {
      this.nes.papu.setExpansionAudioSource("mmc5", this._audio);
    }
  }

  _getExternalIrqId() {
    if (this.nes && this.nes.cpu && typeof this.nes.cpu.IRQ_EXTERNAL === "number") {
      return this.nes.cpu.IRQ_EXTERNAL;
    }
    return 8;
  }

  _clearExternalIrq() {
    if (this.nes && this.nes.cpu && typeof this.nes.cpu.clearIrq === "function") {
      this.nes.cpu.clearIrq(this._getExternalIrqId());
    }
  }

  _triggerExternalIrq() {
    if (this.nes && this.nes.cpu && typeof this.nes.cpu.requestIrq === "function") {
      this.nes.cpu.requestIrq(this._getExternalIrqId());
    }
  }

  _getPpuReg(addr) {
    return this._ppuRegs[addr & 0x07] & 0xFF;
  }

  _switchPrgBank(reg, value) {
    this._prgBanks[(reg - 0x5113) & 0xFF] = value & 0xFF;
    this._updatePrgBanks();
  }

  _getCpuBankInfo(reg) {
    let bankNumber = this._prgBanks[(reg - 0x5113) & 0xFF] & 0xFF;
    let memoryType = this.PrgMemoryType.PrgRom;
    let accessType = this.MemoryAccessType.Read;

    if ((((bankNumber & 0x80) === 0x00) && reg !== 0x5117) || reg === 0x5113) {
      accessType = this.MemoryAccessType.Read;
      if (this._prgRamProtect1 === 0x02 && this._prgRamProtect2 === 0x01) {
        accessType |= this.MemoryAccessType.Write;
      }

      if ((this.cartridge && this.cartridge.isNES2) && (this._workRamSize >= 0x10000 || this._saveRamSize >= 0x10000)) {
        bankNumber &= 0x0F;
        memoryType = this.hasBattery() ? this.PrgMemoryType.SaveRam : this.PrgMemoryType.WorkRam;
      } else {
        bankNumber &= 0x07;

        if (this.cartridge && this.cartridge.isNES2) {
          memoryType = this.PrgMemoryType.WorkRam;
          if (this.hasBattery() && (bankNumber <= 3 || this._saveRamSize > 0x2000)) {
            memoryType = this.PrgMemoryType.SaveRam;
          }

          if ((this._saveRamSize + this._workRamSize) !== 0x4000 && bankNumber >= 4) {
            accessType = this.MemoryAccessType.NoAccess;
          }
        } else {
          memoryType = this.hasBattery() ? this.PrgMemoryType.SaveRam : this.PrgMemoryType.WorkRam;
        }
      }
    } else {
      accessType = this.MemoryAccessType.Read;
      bankNumber &= 0x7F;
    }

    return { bankNumber, memoryType, accessType };
  }

  _mapCpuRange(start, end, bank, memoryType, accessType) {
    if ((accessType | 0) === (this.MemoryAccessType.NoAccess | 0)) {
      this.RemoveCpuMemoryMapping(start, end);
      return;
    }
    this.SetCpuMemoryMapping(start, end, bank, memoryType, accessType);
  }

  _updatePrgBanks() {
    let info = this._getCpuBankInfo(0x5113);
    this._mapCpuRange(0x6000, 0x7FFF, info.bankNumber, info.memoryType, info.accessType);

    if (this._prgMode === 0) {
      info = this._getCpuBankInfo(0x5117);
      this._mapCpuRange(0x8000, 0xFFFF, info.bankNumber & 0x7C, info.memoryType, info.accessType);
      return;
    }

    if (this._prgMode === 1) {
      info = this._getCpuBankInfo(0x5115);
      this._mapCpuRange(0x8000, 0xBFFF, info.bankNumber & 0xFE, info.memoryType, info.accessType);

      info = this._getCpuBankInfo(0x5117);
      this._mapCpuRange(0xC000, 0xFFFF, info.bankNumber & 0x7E, info.memoryType, info.accessType);
      return;
    }

    if (this._prgMode === 2) {
      info = this._getCpuBankInfo(0x5115);
      this._mapCpuRange(0x8000, 0xBFFF, info.bankNumber & 0xFE, info.memoryType, info.accessType);

      info = this._getCpuBankInfo(0x5116);
      this._mapCpuRange(0xC000, 0xDFFF, info.bankNumber, info.memoryType, info.accessType);

      info = this._getCpuBankInfo(0x5117);
      this._mapCpuRange(0xE000, 0xFFFF, info.bankNumber & 0x7F, info.memoryType, info.accessType);
      return;
    }

    info = this._getCpuBankInfo(0x5114);
    this._mapCpuRange(0x8000, 0x9FFF, info.bankNumber, info.memoryType, info.accessType);

    info = this._getCpuBankInfo(0x5115);
    this._mapCpuRange(0xA000, 0xBFFF, info.bankNumber, info.memoryType, info.accessType);

    info = this._getCpuBankInfo(0x5116);
    this._mapCpuRange(0xC000, 0xDFFF, info.bankNumber, info.memoryType, info.accessType);

    info = this._getCpuBankInfo(0x5117);
    this._mapCpuRange(0xE000, 0xFFFF, info.bankNumber & 0x7F, info.memoryType, info.accessType);
  }

  _switchChrBank(reg, value) {
    const index = (reg - 0x5120) & 0xFF;
    const newValue = (value & 0xFF) | ((this._chrUpperBits & 0x03) << 8);

    if (newValue !== this._chrBanks[index] || this._lastChrReg !== reg) {
      this._chrBanks[index] = newValue & 0xFFFF;
      this._lastChrReg = reg & 0xFFFF;
      this._updateChrBanks(true);
    }
  }

  _updateChrBanks(forceUpdate = false) {
    const largeSprites = (this._getPpuReg(0x2000) & 0x20) !== 0;
    if (!largeSprites) {
      this._lastChrReg = 0;
    }

    const chrA = !largeSprites ||
      (this._splitTileNumber >= 32 && this._splitTileNumber < 40) ||
      (!this._ppuInFrame && this._lastChrReg <= 0x5127);

    if (!forceUpdate && chrA === this._prevChrA) {
      return;
    }
    this._prevChrA = chrA;

    const b = this._chrBanks;

    if (this._chrMode === 0) {
      this.SelectChrPage8x(0, (b[chrA ? 0x07 : 0x0B] << 3) & 0xFFFF);
    } else if (this._chrMode === 1) {
      this.SelectChrPage4x(0, (b[chrA ? 0x03 : 0x0B] << 2) & 0xFFFF);
      this.SelectChrPage4x(1, (b[chrA ? 0x07 : 0x0B] << 2) & 0xFFFF);
    } else if (this._chrMode === 2) {
      this.SelectChrPage2x(0, (b[chrA ? 0x01 : 0x09] << 1) & 0xFFFF);
      this.SelectChrPage2x(1, (b[chrA ? 0x03 : 0x0B] << 1) & 0xFFFF);
      this.SelectChrPage2x(2, (b[chrA ? 0x05 : 0x09] << 1) & 0xFFFF);
      this.SelectChrPage2x(3, (b[chrA ? 0x07 : 0x0B] << 1) & 0xFFFF);
    } else {
      this.SelectChrPage(0, b[chrA ? 0x00 : 0x08]);
      this.SelectChrPage(1, b[chrA ? 0x01 : 0x09]);
      this.SelectChrPage(2, b[chrA ? 0x02 : 0x0A]);
      this.SelectChrPage(3, b[chrA ? 0x03 : 0x0B]);
      this.SelectChrPage(4, b[chrA ? 0x04 : 0x08]);
      this.SelectChrPage(5, b[chrA ? 0x05 : 0x09]);
      this.SelectChrPage(6, b[chrA ? 0x06 : 0x0A]);
      this.SelectChrPage(7, b[chrA ? 0x07 : 0x0B]);
    }
  }

  _setNametableMapping(value) {
    this._nametableMapping = value & 0xFF;
  }

  _setExtendedRamMode(mode) {
    this._extendedRamMode = mode & 0x03;

    let accessType;
    if (this._extendedRamMode <= 1) {
      accessType = this.MemoryAccessType.Write;
    } else if (this._extendedRamMode === 2) {
      accessType = this.MemoryAccessType.ReadWrite;
    } else {
      accessType = this.MemoryAccessType.Read;
    }

    this.SetCpuMemoryMapping(0x5C00, 0x5FFF, 0, this.PrgMemoryType.MapperRam, accessType);
    this._setNametableMapping(this._nametableMapping);
  }

  _setFillModeTile(tile) {
    this._fillModeTile = tile & 0xFF;
    this._fillNametable.fill(this._fillModeTile, 0, 32 * 30);
  }

  _setFillModeColor(color) {
    this._fillModeColor = color & 0x03;
    const attributeByte = this._fillModeColor |
      (this._fillModeColor << 2) |
      (this._fillModeColor << 4) |
      (this._fillModeColor << 6);
    this._fillNametable.fill(attributeByte & 0xFF, 32 * 30, 32 * 30 + 64);
  }

  _normalizeNtAddress(addr) {
    return 0x2000 + (((addr & 0x3FFF) - 0x2000) & 0x0FFF);
  }

  _getNtSource(addr) {
    const normalized = this._normalizeNtAddress(addr);
    const table = ((normalized - 0x2000) >> 10) & 0x03;
    const offset = normalized & 0x03FF;
    const source = (this._nametableMapping >> (table * 2)) & 0x03;
    return { source, offset };
  }

  _readCiram(page, offset, mapperContext = null) {
    if (mapperContext && typeof mapperContext.ciramReadPage === "function") {
      return mapperContext.ciramReadPage(page & 0x01, offset & 0x03FF) & 0xFF;
    }

    const ppu = this.nes && this.nes.ppu;
    if (ppu && ppu.vramMem) {
      return ppu.vramMem[((page & 0x01) << 10) | (offset & 0x03FF)] & 0xFF;
    }

    return 0;
  }

  _writeCiram(page, offset, value, mapperContext = null) {
    const writeValue = value & 0xFF;
    if (mapperContext && typeof mapperContext.ciramWritePage === "function") {
      mapperContext.ciramWritePage(page & 0x01, offset & 0x03FF, writeValue);
      return;
    }

    const ppu = this.nes && this.nes.ppu;
    if (ppu && ppu.vramMem) {
      ppu.vramMem[((page & 0x01) << 10) | (offset & 0x03FF)] = writeValue;
    }
  }

  _readMappedNametable(addr, mapperContext = null) {
    const { source, offset } = this._getNtSource(addr);

    if (source <= 1) {
      return this._readCiram(source, offset, mapperContext);
    }

    if (source === 2) {
      if (this._extendedRamMode <= 1) {
        return this._mapperRam[offset & 0x03FF] & 0xFF;
      }
      return this._emptyNametable[offset & 0x03FF] & 0xFF;
    }

    return this._fillNametable[offset & 0x03FF] & 0xFF;
  }

  _writeMappedNametable(addr, value, mapperContext = null) {
    const { source, offset } = this._getNtSource(addr);
    const writeValue = value & 0xFF;

    if (source <= 1) {
      this._writeCiram(source, offset, writeValue, mapperContext);
      return true;
    }

    if (source === 2) {
      if (this._extendedRamMode <= 1) {
        this._mapperRam[offset & 0x03FF] = writeValue;
      }
      return true;
    }

    return true;
  }

  _readFromChr(pos) {
    const useRom = this._chrRomSize > 0 || this._chrRamSize === 0;
    const source = useRom ? this._chrRom : this._chrRam;
    const size = useRom ? this._chrRomSize : this._chrRamSize;

    if (!source || size <= 0) {
      return 0;
    }

    let index = pos | 0;
    if (index < 0 || index >= size) {
      index = ((index % size) + size) % size;
    }
    return source[index] & 0xFF;
  }

  _detectScanlineStart(addr) {
    const address = addr & 0x3FFF;

    if (this._ntReadCounter >= 2) {
      if (!this._ppuInFrame && !this._needInFrame) {
        this._needInFrame = true;
        this._scanlineCounter = 0;
      } else {
        this._scanlineCounter = (this._scanlineCounter + 1) & 0xFF;
        if (this._irqCounterTarget === this._scanlineCounter) {
          this._irqPending = true;
          if (this._irqEnabled) {
            this._triggerExternalIrq();
          }
        }
      }
    } else if (address >= 0x2000 && address <= 0x2FFF) {
      if (this._lastPpuReadAddr === address) {
        this._ntReadCounter = (this._ntReadCounter + 1) & 0xFF;
        if (this._ntReadCounter >= 2) {
          this._splitTileNumber = 0;
        }
      }
    }

    if (this._lastPpuReadAddr !== address) {
      this._ntReadCounter = 0;
    }
  }

  _mapperReadVram(addr, context = "ppu", mapperContext = null) {
    const address = addr & 0x3FFF;
    const isNtFetch = address >= 0x2000 && address <= 0x2FFF && (address & 0x03FF) < 0x03C0;

    if (isNtFetch) {
      this._splitTileNumber = (this._splitTileNumber + 1) | 0;

      if (this._ppuInFrame) {
        this._updateChrBanks(false);
      } else if (this._needInFrame) {
        this._needInFrame = false;
        this._ppuInFrame = true;
        this._updateChrBanks(false);
      }
    }

    this._detectScanlineStart(address);

    this._ppuIdleCounter = 3;
    this._lastPpuReadAddr = address;

    if (this._extendedRamMode <= 1 && this._ppuInFrame) {
      if (this._verticalSplitEnabled) {
        const scanline = this._splitTileNumber >= 41 ? this._scanlineCounter + 1 : this._scanlineCounter;
        const verticalSplitScroll = (scanline + this._verticalSplitScroll) % 240;
        const column = (this._splitTileNumber + 2) % 42;

        if (address >= 0x2000) {
          if (isNtFetch) {
            if (column === 0) {
              this._splitInSplitRegion = !this._verticalSplitRightSide;
            }

            if (column === this._verticalSplitDelimiterTile && this._splitTileNumber < 42) {
              this._splitInSplitRegion = !this._splitInSplitRegion;
            } else if (column > 32) {
              this._splitInSplitRegion = false;
            }

            if (this._splitInSplitRegion) {
              this._splitTile = (((verticalSplitScroll & 0xF8) << 2) | column) & 0x03FF;
              return this._mapperRam[this._splitTile] & 0xFF;
            }
          } else if (this._splitInSplitRegion) {
            const shift = ((this._splitTile >> 4) & 0x04) | (this._splitTile & 0x02);
            const atAddr = (0x3C0 | ((this._splitTile & 0x380) >> 4) | ((this._splitTile & 0x1F) >> 2)) & 0x03FF;
            const palette = (this._mapperRam[atAddr] >> shift) & 0x03;
            return (palette * 0x55) & 0xFF;
          }
        } else if (this._splitInSplitRegion) {
          const chrAddr = (this._verticalSplitBank << 12) + (((address & ~0x07) | (verticalSplitScroll & 0x07)) & 0x0FFF);
          return this._readFromChr(chrAddr);
        }
      }

      if (this._extendedRamMode === 1 && (this._splitTileNumber < 32 || this._splitTileNumber >= 40)) {
        if (isNtFetch) {
          this._exAttributeLastNametableFetch = address & 0x03FF;
          this._exAttrLastFetchCounter = 3;
        } else if (this._exAttrLastFetchCounter > 0) {
          this._exAttrLastFetchCounter--;
          switch (this._exAttrLastFetchCounter) {
            case 2: {
              const value = this._mapperRam[this._exAttributeLastNametableFetch & 0x03FF] & 0xFF;
              this._exAttrSelectedChrBank = ((value & 0x3F) | ((this._chrUpperBits & 0x03) << 6)) & 0xFF;
              const palette = (value >> 6) & 0x03;
              return (palette * 0x55) & 0xFF;
            }

            case 1:
            case 0:
              return this._readFromChr((this._exAttrSelectedChrBank << 12) + (address & 0x0FFF));
          }
        }
      }
    }

    if (address < 0x2000) {
      return super.internalReadVram(address);
    }

    if (address < 0x3F00) {
      return this._readMappedNametable(address, mapperContext);
    }

    return address & 0xFF;
  }

  _resetPowerOnState() {
    this._ensureState();
    this._ensureAudioSource();

    this._audio.reset();
    this._ppuRegs.fill(0);
    this._prgBanks.fill(0);
    this._chrBanks.fill(0);
    this._emptyNametable.fill(0);
    this._fillNametable.fill(0);

    this._prgRamProtect1 = 0;
    this._prgRamProtect2 = 0;

    this._verticalSplitEnabled = false;
    this._verticalSplitRightSide = false;
    this._verticalSplitDelimiterTile = 0;
    this._verticalSplitScroll = 0;
    this._verticalSplitBank = 0;

    this._splitInSplitRegion = false;
    this._splitTile = 0;
    this._splitTileNumber = 0;

    this._multiplierValue1 = 0;
    this._multiplierValue2 = 0;

    this._nametableMapping = 0;
    this._extendedRamMode = 0;

    this._exAttributeLastNametableFetch = 0;
    this._exAttrLastFetchCounter = 0;
    this._exAttrSelectedChrBank = 0;

    this._prgMode = 0;
    this._chrMode = 0;
    this._chrUpperBits = 0;
    this._lastChrReg = 0;
    this._prevChrA = false;

    this._irqCounterTarget = 0;
    this._irqEnabled = false;
    this._scanlineCounter = 0;
    this._irqPending = false;

    this._needInFrame = false;
    this._ppuInFrame = false;
    this._ppuIdleCounter = 0;
    this._lastPpuReadAddr = 0;
    this._ntReadCounter = 0;

    this.AddRegisterRange(0xFFFA, 0xFFFB, this.MemoryOperation.Read);

    this._setExtendedRamMode(0);
    this._setFillModeTile(0);
    this._setFillModeColor(0);

    // Mesen power-on defaults expected by MMC5 software.
    this.writeRegister(0x5100, 0x03);
    this.writeRegister(0x5117, 0xFF);
    this._updateChrBanks(true);
    this._clearExternalIrq();
  }

  initMapper() {
    this._resetPowerOnState();
  }

  reset(softReset = false) {
    super.reset(softReset);
    this._resetPowerOnState();
  }

  onPpuRegisterWrite(addr, value, _context = null) {
    const address = addr & 0xFFFF;
    if (address >= 0x2000 && address <= 0x2007) {
      this._ppuRegs[address & 0x07] = value & 0xFF;
      if (address === 0x2000) {
        this._updateChrBanks(true);
      }
    }
  }

  processCpuClock() {
    if (this._audio) {
      this._audio.clock(1);
    }

    if (this._ppuIdleCounter > 0) {
      this._ppuIdleCounter--;
      if (this._ppuIdleCounter === 0) {
        this._ppuInFrame = false;
        this._updateChrBanks(true);
      }
    }
  }

  writeRam(addr, value) {
    const address = addr & 0xFFFF;
    let writeValue = value & 0xFF;
    if (address >= 0x5C00 && address <= 0x5FFF && this._extendedRamMode <= 1 && !this._ppuInFrame) {
      writeValue = 0;
    }
    super.writeRam(address, writeValue);
  }

  writeRegister(addr, value) {
    const address = addr & 0xFFFF;
    const writeValue = value & 0xFF;

    if (address >= 0x5113 && address <= 0x5117) {
      this._switchPrgBank(address, writeValue);
      return;
    }

    if (address >= 0x5120 && address <= 0x512B) {
      this._switchChrBank(address, writeValue);
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
      case 0x5010:
      case 0x5011:
      case 0x5015:
        this._audio.writeRegister(address, writeValue);
        break;

      case 0x5100:
        this._prgMode = writeValue & 0x03;
        this._updatePrgBanks();
        break;

      case 0x5101:
        this._chrMode = writeValue & 0x03;
        this._updateChrBanks(true);
        break;

      case 0x5102:
        this._prgRamProtect1 = writeValue & 0x03;
        this._updatePrgBanks();
        break;

      case 0x5103:
        this._prgRamProtect2 = writeValue & 0x03;
        this._updatePrgBanks();
        break;

      case 0x5104:
        this._setExtendedRamMode(writeValue & 0x03);
        break;

      case 0x5105:
        this._setNametableMapping(writeValue);
        break;

      case 0x5106:
        this._setFillModeTile(writeValue);
        break;

      case 0x5107:
        this._setFillModeColor(writeValue & 0x03);
        break;

      case 0x5130:
        this._chrUpperBits = writeValue & 0x03;
        break;

      case 0x5200:
        this._verticalSplitEnabled = (writeValue & 0x80) === 0x80;
        this._verticalSplitRightSide = (writeValue & 0x40) === 0x40;
        this._verticalSplitDelimiterTile = writeValue & 0x1F;
        break;

      case 0x5201:
        this._verticalSplitScroll = writeValue;
        break;

      case 0x5202:
        this._verticalSplitBank = writeValue;
        break;

      case 0x5203:
        this._irqCounterTarget = writeValue;
        break;

      case 0x5204:
        this._irqEnabled = (writeValue & 0x80) === 0x80;
        if (!this._irqEnabled) {
          this._clearExternalIrq();
        } else if (this._irqPending) {
          this._triggerExternalIrq();
        }
        break;

      case 0x5205:
        this._multiplierValue1 = writeValue;
        break;

      case 0x5206:
        this._multiplierValue2 = writeValue;
        break;
    }
  }

  readRegister(addr) {
    const address = addr & 0xFFFF;

    switch (address) {
      case 0x5010:
      case 0x5015:
        return this._audio.readRegister(address);

      case 0x5204: {
        const value = (this._ppuInFrame ? 0x40 : 0x00) | (this._irqPending ? 0x80 : 0x00);
        this._irqPending = false;
        this._clearExternalIrq();
        return value & 0xFF;
      }

      case 0x5205:
        return (this._multiplierValue1 * this._multiplierValue2) & 0xFF;

      case 0x5206:
        return ((this._multiplierValue1 * this._multiplierValue2) >> 8) & 0xFF;

      case 0xFFFA:
      case 0xFFFB:
        this._ppuInFrame = false;
        this._updateChrBanks(true);
        this._lastPpuReadAddr = 0;
        this._scanlineCounter = 0;
        this._irqPending = false;
        this._clearExternalIrq();
        return this.debugReadRam(address) & 0xFF;
    }

    return this._openBus(address) & 0xFF;
  }

  ppuRead(addr, context = "ppu", mapperContext = null) {
    return this._mapperReadVram(addr & 0x3FFF, context, mapperContext) & 0xFF;
  }

  mapperReadVram(addr, context = "ppu") {
    return this._mapperReadVram(addr & 0x3FFF, context, null) & 0xFF;
  }

  readNametable(addr, context = "ppu", mapperContext = null) {
    return this._mapperReadVram(addr & 0x3FFF, context, mapperContext) & 0xFF;
  }

  setNametableByte(addr, value, mapperContext = null) {
    return this._writeMappedNametable(addr & 0x3FFF, value & 0xFF, mapperContext);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mapper005: {
        ppuRegs: Array.from(this._ppuRegs),
        prgBanks: Array.from(this._prgBanks),
        chrBanks: Array.from(this._chrBanks),
        fillNametable: Array.from(this._fillNametable),

        prgRamProtect1: this._prgRamProtect1 | 0,
        prgRamProtect2: this._prgRamProtect2 | 0,
        fillModeTile: this._fillModeTile | 0,
        fillModeColor: this._fillModeColor | 0,

        verticalSplitEnabled: !!this._verticalSplitEnabled,
        verticalSplitRightSide: !!this._verticalSplitRightSide,
        verticalSplitDelimiterTile: this._verticalSplitDelimiterTile | 0,
        verticalSplitScroll: this._verticalSplitScroll | 0,
        verticalSplitBank: this._verticalSplitBank | 0,

        splitInSplitRegion: !!this._splitInSplitRegion,
        splitTile: this._splitTile | 0,
        splitTileNumber: this._splitTileNumber | 0,

        multiplierValue1: this._multiplierValue1 | 0,
        multiplierValue2: this._multiplierValue2 | 0,

        nametableMapping: this._nametableMapping | 0,
        extendedRamMode: this._extendedRamMode | 0,

        exAttributeLastNametableFetch: this._exAttributeLastNametableFetch | 0,
        exAttrLastFetchCounter: this._exAttrLastFetchCounter | 0,
        exAttrSelectedChrBank: this._exAttrSelectedChrBank | 0,

        prgMode: this._prgMode | 0,
        chrMode: this._chrMode | 0,
        chrUpperBits: this._chrUpperBits | 0,
        lastChrReg: this._lastChrReg | 0,
        prevChrA: !!this._prevChrA,

        irqCounterTarget: this._irqCounterTarget | 0,
        irqEnabled: !!this._irqEnabled,
        scanlineCounter: this._scanlineCounter | 0,
        irqPending: !!this._irqPending,

        needInFrame: !!this._needInFrame,
        ppuInFrame: !!this._ppuInFrame,
        ppuIdleCounter: this._ppuIdleCounter | 0,
        lastPpuReadAddr: this._lastPpuReadAddr | 0,
        ntReadCounter: this._ntReadCounter | 0,

        audio: this._audio ? this._audio.toJSON() : null,
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);
    this._ensureState();
    this._ensureAudioSource();

    const s = (state && state.mapper005) || null;
    if (!s) {
      this._resetPowerOnState();
      return;
    }

    if (s.ppuRegs) this._ppuRegs = new Uint8Array(s.ppuRegs);
    if (s.prgBanks) this._prgBanks = new Uint8Array(s.prgBanks);
    if (s.chrBanks) this._chrBanks = new Uint16Array(s.chrBanks);

    if (!(this._ppuRegs instanceof Uint8Array) || this._ppuRegs.length !== 8) this._ppuRegs = new Uint8Array(8);
    if (!(this._prgBanks instanceof Uint8Array) || this._prgBanks.length !== 5) this._prgBanks = new Uint8Array(5);
    if (!(this._chrBanks instanceof Uint16Array) || this._chrBanks.length !== 12) this._chrBanks = new Uint16Array(12);

    this._prgRamProtect1 = (s.prgRamProtect1 ?? 0) & 0x03;
    this._prgRamProtect2 = (s.prgRamProtect2 ?? 0) & 0x03;
    this._fillModeTile = (s.fillModeTile ?? 0) & 0xFF;
    this._fillModeColor = (s.fillModeColor ?? 0) & 0x03;

    this._verticalSplitEnabled = !!s.verticalSplitEnabled;
    this._verticalSplitRightSide = !!s.verticalSplitRightSide;
    this._verticalSplitDelimiterTile = (s.verticalSplitDelimiterTile ?? 0) & 0x1F;
    this._verticalSplitScroll = (s.verticalSplitScroll ?? 0) & 0xFF;
    this._verticalSplitBank = (s.verticalSplitBank ?? 0) & 0xFF;

    this._splitInSplitRegion = !!s.splitInSplitRegion;
    this._splitTile = (s.splitTile ?? 0) & 0xFFFF;
    this._splitTileNumber = (s.splitTileNumber ?? 0) | 0;

    this._multiplierValue1 = (s.multiplierValue1 ?? 0) & 0xFF;
    this._multiplierValue2 = (s.multiplierValue2 ?? 0) & 0xFF;

    this._nametableMapping = (s.nametableMapping ?? 0) & 0xFF;
    this._extendedRamMode = (s.extendedRamMode ?? 0) & 0x03;

    this._exAttributeLastNametableFetch = (s.exAttributeLastNametableFetch ?? 0) & 0x03FF;
    this._exAttrLastFetchCounter = (s.exAttrLastFetchCounter ?? 0) | 0;
    this._exAttrSelectedChrBank = (s.exAttrSelectedChrBank ?? 0) & 0xFF;

    this._prgMode = (s.prgMode ?? 0) & 0x03;
    this._chrMode = (s.chrMode ?? 0) & 0x03;
    this._chrUpperBits = (s.chrUpperBits ?? 0) & 0x03;
    this._lastChrReg = (s.lastChrReg ?? 0) & 0xFFFF;
    this._prevChrA = !!s.prevChrA;

    this._irqCounterTarget = (s.irqCounterTarget ?? 0) & 0xFF;
    this._irqEnabled = !!s.irqEnabled;
    this._scanlineCounter = (s.scanlineCounter ?? 0) & 0xFF;
    this._irqPending = !!s.irqPending;

    this._needInFrame = !!s.needInFrame;
    this._ppuInFrame = !!s.ppuInFrame;
    this._ppuIdleCounter = (s.ppuIdleCounter ?? 0) & 0xFF;
    this._lastPpuReadAddr = (s.lastPpuReadAddr ?? 0) & 0x3FFF;
    this._ntReadCounter = (s.ntReadCounter ?? 0) & 0xFF;

    this._emptyNametable.fill(0);
    this._setFillModeTile(this._fillModeTile);
    this._setFillModeColor(this._fillModeColor);
    if (s.fillNametable) {
      const data = new Uint8Array(s.fillNametable);
      if (data.length === BaseMapper.NametableSize) {
        this._fillNametable = data;
      }
    }

    this._setExtendedRamMode(this._extendedRamMode);
    this._updatePrgBanks();
    this._updateChrBanks(true);

    if (this._audio) {
      this._audio.fromJSON(s.audio || null);
    }

    if (this._irqEnabled && this._irqPending) {
      this._triggerExternalIrq();
    } else {
      this._clearExternalIrq();
    }
  }
}
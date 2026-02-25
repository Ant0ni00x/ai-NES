import BaseMapper, { PrgMemoryType } from "./mapper-base.js";

// Mapper 001 (MMC1)
// Mesen-aligned baseline: serial shift register writes + control/CHR/PRG registers.
export default class Mapper001 extends BaseMapper {
  constructor(cartridge) {
    super(cartridge);

    this._writeBuffer = 0;
    this._shiftCount = 0;

    this._wramDisable = false;
    this._chrMode = false;
    this._prgMode = false;
    this._slotSelect = false;

    this._chrReg0 = 0;
    this._chrReg1 = 0;
    this._prgReg = 0;

    this._lastWriteCycle = Number.NEGATIVE_INFINITY;
    this._writeCycleFallback = 0;

    this._forceWramOn = false;
    this._lastChrReg = 0xA000;

    // Base constructor calls initMapper() before derived fields are initialized.
    // Re-apply power-on state now that MMC1 fields are guaranteed initialized.
    this._initMapperPowerOnState();
  }

  getPrgPageSize() {
    return 0x4000;
  }

  getChrPageSize() {
    return 0x1000;
  }

  _resetBuffer() {
    this._shiftCount = 0;
    this._writeBuffer = 0;
  }

  _getCurrentCpuCycle() {
    if (this.nes && this.nes.cpu && typeof this.nes.cpu.cycleCount === "number") {
      return this.nes.cpu.cycleCount;
    }
    this._writeCycleFallback++;
    return this._writeCycleFallback;
  }

  _isSubmapper5() {
    return !!(this.cartridge && ((this.cartridge.submapper | 0) === 5));
  }

  _processRegisterWrite(addr, val) {
    const address = addr & 0xE000;
    const value = val & 0x1F;

    switch (address) {
      case 0x8000:
        switch (value & 0x03) {
          case 0:
            this.SetMirroringType(this.MIRROR_SINGLE_A);
            break;
          case 1:
            this.SetMirroringType(this.MIRROR_SINGLE_B);
            break;
          case 2:
            this.SetMirroringType(this.MIRROR_VERTICAL);
            break;
          case 3:
            this.SetMirroringType(this.MIRROR_HORIZONTAL);
            break;
        }

        this._slotSelect = (value & 0x04) !== 0;
        this._prgMode = (value & 0x08) !== 0;
        this._chrMode = (value & 0x10) !== 0;
        break;

      case 0xA000:
        this._lastChrReg = 0xA000;
        this._chrReg0 = value;
        break;

      case 0xC000:
        this._lastChrReg = 0xC000;
        this._chrReg1 = value;
        break;

      case 0xE000:
        this._prgReg = value & 0x0F;
        this._wramDisable = (value & 0x10) !== 0;
        break;
    }
  }

  _processBitWrite(addr, value) {
    const writeValue = value & 0xFF;

    if ((writeValue & 0x80) !== 0) {
      // Reset serial unit and force control bits 2/3 set.
      this._resetBuffer();
      this._prgMode = true;
      this._slotSelect = true;
      this._updateState();
      return;
    }

    this._writeBuffer >>= 1;
    this._writeBuffer |= (writeValue << 4) & 0x10;
    this._shiftCount++;

    if (this._shiftCount === 5) {
      this._processRegisterWrite(addr, this._writeBuffer);
      this._updateState();
      this._resetBuffer();
    }
  }

  _updateWramMapping(extraReg) {
    const totalWram = (this._saveRamSize + this._workRamSize) | 0;
    const access = (this._wramDisable && !this._forceWramOn) ? this.MemoryAccessType.NoAccess : this.MemoryAccessType.ReadWrite;
    const defaultMemType = this.hasBattery() ? PrgMemoryType.SaveRam : PrgMemoryType.WorkRam;

    if (totalWram > 0x4000) {
      // SXROM: up to 32KB WRAM/SRAM
      this.SetCpuMemoryMapping(0x6000, 0x7FFF, (extraReg >> 2) & 0x03, defaultMemType, access);
      return;
    }

    if (totalWram > 0x2000) {
      if (this._saveRamSize === 0x2000 && this._workRamSize === 0x2000) {
        // SOROM: one 8KB bank save + one 8KB bank work RAM.
        const bankType = ((extraReg >> 3) & 0x01) ? PrgMemoryType.WorkRam : PrgMemoryType.SaveRam;
        this.SetCpuMemoryMapping(0x6000, 0x7FFF, 0, bankType, access);
      } else {
        this.SetCpuMemoryMapping(0x6000, 0x7FFF, (extraReg >> 2) & 0x01, defaultMemType, access);
      }
      return;
    }

    if (totalWram === 0) {
      this.RemoveCpuMemoryMapping(0x6000, 0x7FFF);
      return;
    }

    this.SetCpuMemoryMapping(0x6000, 0x7FFF, 0, defaultMemType, access);
  }

  _updateState() {
    const extraReg = (this._lastChrReg === 0xC000 && this._chrMode) ? this._chrReg1 : this._chrReg0;
    let prgBankSelect = 0;

    if (this._prgSize === 0x80000) {
      // SUROM/SXROM 512KB PRG extension bit.
      prgBankSelect = extraReg & 0x10;
    }

    this._updateWramMapping(extraReg);

    if (this._isSubmapper5()) {
      // SEROM/SHROM/SH1ROM: fixed 32KB PRG.
      this.SelectPrgPage2x(0, 0);
    } else if (this._prgMode) {
      if (this._slotSelect) {
        this.SelectPrgPage(0, this._prgReg | prgBankSelect);
        this.SelectPrgPage(1, 0x0F | prgBankSelect);
      } else {
        this.SelectPrgPage(0, 0x00 | prgBankSelect);
        this.SelectPrgPage(1, this._prgReg | prgBankSelect);
      }
    } else {
      this.SelectPrgPage2x(0, (this._prgReg & 0x0E) | prgBankSelect);
    }

    if (this._chrMode) {
      this.SelectChrPage(0, this._chrReg0);
      this.SelectChrPage(1, this._chrReg1);
    } else {
      const base = this._chrReg0 & 0x1E;
      this.SelectChrPage(0, base);
      this.SelectChrPage(1, base + 1);
    }
  }

  _initMapperPowerOnState() {
    // Mesen initializes with control bits 2/3 set and mapper-specific register defaults.
    this._processRegisterWrite(0x8000, 0x0C);
    this._processRegisterWrite(0xA000, 0x00);
    this._processRegisterWrite(0xC000, 0x00);
    this._processRegisterWrite(0xE000, 0x00);

    // Database board metadata is not available in this codebase.
    this._forceWramOn = false;
    this._lastChrReg = 0xA000;
    this._lastWriteCycle = Number.NEGATIVE_INFINITY;
    this._writeCycleFallback = 0;

    this._resetBuffer();
    this._updateState();
  }

  initMapper() {
    this._initMapperPowerOnState();
  }

  reset(softReset = false) {
    super.reset(softReset);
    this._initMapperPowerOnState();
  }

  writeRegister(addr, value) {
    const writeValue = value & 0xFF;
    const currentCycle = this._getCurrentCpuCycle();

    // Ignore writes too close together (dummy+real write behavior),
    // except reset writes (bit7 set), which always apply.
    if ((writeValue & 0x80) || (currentCycle - this._lastWriteCycle >= 2)) {
      this._processBitWrite(addr & 0xFFFF, writeValue);
    }

    this._lastWriteCycle = currentCycle;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mmc1: {
        writeBuffer: this._writeBuffer,
        shiftCount: this._shiftCount,
        wramDisable: this._wramDisable,
        chrMode: this._chrMode,
        prgMode: this._prgMode,
        slotSelect: this._slotSelect,
        chrReg0: this._chrReg0,
        chrReg1: this._chrReg1,
        prgReg: this._prgReg,
        lastWriteCycle: this._lastWriteCycle,
        writeCycleFallback: this._writeCycleFallback,
        forceWramOn: this._forceWramOn,
        lastChrReg: this._lastChrReg,
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);
    const m = state && state.mmc1;
    if (!m) {
      this._updateState();
      return;
    }

    this._writeBuffer = m.writeBuffer ?? this._writeBuffer;
    this._shiftCount = m.shiftCount ?? this._shiftCount;
    this._wramDisable = !!(m.wramDisable ?? this._wramDisable);
    this._chrMode = !!(m.chrMode ?? this._chrMode);
    this._prgMode = !!(m.prgMode ?? this._prgMode);
    this._slotSelect = !!(m.slotSelect ?? this._slotSelect);
    this._chrReg0 = (m.chrReg0 ?? this._chrReg0) & 0x1F;
    this._chrReg1 = (m.chrReg1 ?? this._chrReg1) & 0x1F;
    this._prgReg = (m.prgReg ?? this._prgReg) & 0x0F;
    this._lastWriteCycle = m.lastWriteCycle ?? this._lastWriteCycle;
    this._writeCycleFallback = m.writeCycleFallback ?? this._writeCycleFallback;
    this._forceWramOn = !!(m.forceWramOn ?? this._forceWramOn);
    this._lastChrReg = (m.lastChrReg ?? this._lastChrReg) & 0xFFFF;

    this._updateState();
  }
}

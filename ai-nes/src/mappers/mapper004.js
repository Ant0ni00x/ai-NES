import BaseMapper, { PrgMemoryType } from "./mapper-base.js";

// Mapper 004 (MMC3/MMC6 baseline)
// Mesen-aligned behavior from mesen-mmc3.h.
export default class Mapper004 extends BaseMapper {
  constructor(cartridge) {
    super(cartridge);
    this._ensureStateFields();
  }

  getPrgPageSize() {
    return 0x2000;
  }

  getChrPageSize() {
    return 0x0400;
  }

  getSaveRamPageSize() {
    return this._isMmc6() ? 0x200 : 0x2000;
  }

  getSaveRamSize() {
    return this._isMmc6() ? 0x400 : 0x2000;
  }

  enableVramAddressHook() {
    return true;
  }

  _isMmc6() {
    return !!(this.cartridge && (this.cartridge.mapperType | 0) === 4 && (this.cartridge.submapper | 0) === 1);
  }

  _isMapper4Submapper0() {
    return !!(this.cartridge && (this.cartridge.mapperType | 0) === 4 && (this.cartridge.submapper | 0) === 0);
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

  _triggerIrq() {
    if (this.nes && this.nes.cpu && typeof this.nes.cpu.requestIrq === "function") {
      this.nes.cpu.requestIrq(this._getExternalIrqId());
    }
  }

  _getPowerOnByte(defaultValue = 0) {
    // This codebase does not currently expose RandomizeMapperPowerOnState.
    return defaultValue & 0xFF;
  }

  _ensureStateFields() {
    if (!this._state) {
      this._state = {
        reg8000: 0,
        regA000: 0,
        regA001: 0,
      };
    }

    if (!(this._registers instanceof Uint8Array) || this._registers.length !== 8) {
      this._registers = new Uint8Array(8);
    }

    if (typeof this._currentRegister !== "number") this._currentRegister = 0;
    if (typeof this._wramEnabled !== "boolean") this._wramEnabled = false;
    if (typeof this._wramWriteProtected !== "boolean") this._wramWriteProtected = false;
    if (typeof this._a12LowClock !== "number") this._a12LowClock = 0;
    if (typeof this._clockFallback !== "number") this._clockFallback = 0;
    if (typeof this._forceMmc3RevAIrqs !== "boolean") this._forceMmc3RevAIrqs = false;
    if (typeof this._irqReloadValue !== "number") this._irqReloadValue = 0;
    if (typeof this._irqCounter !== "number") this._irqCounter = 0;
    if (typeof this._irqReload !== "boolean") this._irqReload = false;
    if (typeof this._irqEnabled !== "boolean") this._irqEnabled = false;
    if (typeof this._prgMode !== "number") this._prgMode = 0;
    if (typeof this._chrMode !== "number") this._chrMode = 0;
    if (typeof this._a001Written !== "boolean") this._a001Written = false;
  }

  _resetMmc3() {
    this._state.reg8000 = this._getPowerOnByte();
    this._state.regA000 = this._getPowerOnByte();
    this._state.regA001 = this._getPowerOnByte();

    this._chrMode = this._getPowerOnByte() & 0x01;
    this._prgMode = this._getPowerOnByte() & 0x01;
    this._currentRegister = this._getPowerOnByte();

    // Mesen defaults when power-on randomization is disabled.
    this._registers[0] = this._getPowerOnByte(0);
    this._registers[1] = this._getPowerOnByte(2);
    this._registers[2] = this._getPowerOnByte(4);
    this._registers[3] = this._getPowerOnByte(5);
    this._registers[4] = this._getPowerOnByte(6);
    this._registers[5] = this._getPowerOnByte(7);
    this._registers[6] = this._getPowerOnByte(0);
    this._registers[7] = this._getPowerOnByte(1);

    this._irqCounter = this._getPowerOnByte();
    this._irqReloadValue = this._getPowerOnByte();
    this._irqReload = (this._getPowerOnByte() & 0x01) !== 0;
    this._irqEnabled = (this._getPowerOnByte() & 0x01) !== 0;

    this._wramEnabled = (this._getPowerOnByte() & 0x01) !== 0;
    this._wramWriteProtected = (this._getPowerOnByte() & 0x01) !== 0;
  }

  _updateMirroring() {
    if (this.GetMirroringType() === this.MIRROR_FOUR_SCREEN) {
      return;
    }
    this.SetMirroringType((this._state.regA000 & 0x01) ? this.MIRROR_HORIZONTAL : this.MIRROR_VERTICAL);
  }

  _updateChrMapping() {
    if (this._chrMode === 0) {
      this.SelectChrPage(0, this._registers[0] & 0xFE);
      this.SelectChrPage(1, this._registers[0] | 0x01);
      this.SelectChrPage(2, this._registers[1] & 0xFE);
      this.SelectChrPage(3, this._registers[1] | 0x01);
      this.SelectChrPage(4, this._registers[2]);
      this.SelectChrPage(5, this._registers[3]);
      this.SelectChrPage(6, this._registers[4]);
      this.SelectChrPage(7, this._registers[5]);
    } else {
      this.SelectChrPage(0, this._registers[2]);
      this.SelectChrPage(1, this._registers[3]);
      this.SelectChrPage(2, this._registers[4]);
      this.SelectChrPage(3, this._registers[5]);
      this.SelectChrPage(4, this._registers[0] & 0xFE);
      this.SelectChrPage(5, this._registers[0] | 0x01);
      this.SelectChrPage(6, this._registers[1] & 0xFE);
      this.SelectChrPage(7, this._registers[1] | 0x01);
    }
  }

  _updatePrgMapping() {
    if (this._prgMode === 0) {
      this.SelectPrgPage(0, this._registers[6]);
      this.SelectPrgPage(1, this._registers[7]);
      this.SelectPrgPage(2, -2);
      this.SelectPrgPage(3, -1);
    } else {
      this.SelectPrgPage(0, -2);
      this.SelectPrgPage(1, this._registers[7]);
      this.SelectPrgPage(2, this._registers[6]);
      this.SelectPrgPage(3, -1);
    }
  }

  _canWriteToWorkRam() {
    return this._wramEnabled && !this._wramWriteProtected;
  }

  _updateState() {
    this._currentRegister = this._state.reg8000 & 0x07;
    this._chrMode = (this._state.reg8000 & 0x80) >> 7;
    this._prgMode = (this._state.reg8000 & 0x40) >> 6;

    if (this._isMmc6()) {
      const wramEnabled = (this._state.reg8000 & 0x20) === 0x20;

      let firstBankAccess =
        ((this._state.regA001 & 0x10) ? this.MemoryAccessType.Write : 0) |
        ((this._state.regA001 & 0x20) ? this.MemoryAccessType.Read : 0);
      let lastBankAccess =
        ((this._state.regA001 & 0x40) ? this.MemoryAccessType.Write : 0) |
        ((this._state.regA001 & 0x80) ? this.MemoryAccessType.Read : 0);

      if (!wramEnabled) {
        firstBankAccess = this.MemoryAccessType.NoAccess;
        lastBankAccess = this.MemoryAccessType.NoAccess;
      }

      for (let i = 0; i < 4; i++) {
        this.SetCpuMemoryMapping(0x7000 + i * 0x400, 0x71FF + i * 0x400, 0, PrgMemoryType.SaveRam, firstBankAccess);
        this.SetCpuMemoryMapping(0x7200 + i * 0x400, 0x73FF + i * 0x400, 1, PrgMemoryType.SaveRam, lastBankAccess);
      }
    } else {
      this._wramEnabled = (this._state.regA001 & 0x80) === 0x80;
      this._wramWriteProtected = (this._state.regA001 & 0x40) === 0x40;

      if (this._isMapper4Submapper0()) {
        let access;
        if (!this._a001Written) {
          // Compatibility: keep WRAM available until the game explicitly
          // programs $A001 at least once.
          access = this.MemoryAccessType.ReadWrite;
        } else if (this._wramEnabled) {
          access = this._canWriteToWorkRam() ? this.MemoryAccessType.ReadWrite : this.MemoryAccessType.Read;
        } else {
          access = this.MemoryAccessType.NoAccess;
        }

        if ((this.hasBattery() && this._saveRamSize > 0) || (!this.hasBattery() && this._workRamSize > 0)) {
          this.SetCpuMemoryMapping(0x6000, 0x7FFF, 0, this.hasBattery() ? PrgMemoryType.SaveRam : PrgMemoryType.WorkRam, access);
        } else {
          this.RemoveCpuMemoryMapping(0x6000, 0x7FFF);
        }
      }
    }

    this._updatePrgMapping();
    this._updateChrMapping();
  }

  _getMasterClock(context = null) {
    if (context && typeof context.ppuClock === "number") {
      return context.ppuClock;
    }
    if (this.nes && this.nes.ppu && typeof this.nes.ppu.ppuClock === "number") {
      return this.nes.ppu.ppuClock;
    }
    this._clockFallback++;
    return this._clockFallback;
  }

  _isA12RisingEdge(addr, context = null) {
    if (context && context.renderingEnabled === false) {
      this._a12LowClock = 0;
      return false;
    }

    const address = addr & 0x3FFF;
    const clock = this._getMasterClock(context);

    if (clock < this._a12LowClock) {
      this._a12LowClock = 0;
    }

    if ((address & 0x1000) !== 0) {
      // Mesen checks >=3 master clocks. Here master clock uses PPU clocks,
      // so we use an equivalent low window before counting a new edge.
      const rising = this._a12LowClock > 0 && (clock - this._a12LowClock) >= 8;
      this._a12LowClock = 0;
      return rising;
    }

    if (this._a12LowClock === 0) {
      this._a12LowClock = clock;
    }
    return false;
  }

  _detectForceRevA() {
    // Mesen uses database chip metadata ("MMC3A"). Not currently exposed here.
    return !!(this.cartridge && this.cartridge.mmc3RevA === true);
  }

  _initMapperState() {
    this._ensureStateFields();
    this._forceMmc3RevAIrqs = this._detectForceRevA();
    this._a12LowClock = 0;
    this._clockFallback = 0;
    this._a001Written = false;
    this._resetMmc3();

    this.SetCpuMemoryMapping(0x6000, 0x7FFF, 0, this.hasBattery() ? PrgMemoryType.SaveRam : PrgMemoryType.WorkRam);
    this._updateState();
    this._updateMirroring();
    this._clearExternalIrq();
  }

  initMapper() {
    this._ensureStateFields();
    this._initMapperState();
  }

  reset(softReset = false) {
    super.reset(softReset);
    this._initMapperState();
  }

  writeRegister(addr, value) {
    const address = addr & 0xE001;
    const writeValue = value & 0xFF;

    switch (address) {
      case 0x8000:
        this._state.reg8000 = writeValue;
        this._updateState();
        break;

      case 0x8001: {
        let bankValue = writeValue;
        if (this._currentRegister <= 1) {
          // Writes to registers 0 and 1 always ignore bit 0.
          bankValue &= ~0x01;
        }
        this._registers[this._currentRegister & 0x07] = bankValue;
        this._updateState();
        break;
      }

      case 0xA000:
        this._state.regA000 = writeValue;
        this._updateMirroring();
        break;

      case 0xA001:
        this._a001Written = true;
        this._state.regA001 = writeValue;
        this._updateState();
        break;

      case 0xC000:
        this._irqReloadValue = writeValue;
        break;

      case 0xC001:
        this._irqCounter = 0;
        this._irqReload = true;
        break;

      case 0xE000:
        this._irqEnabled = false;
        this._clearExternalIrq();
        break;

      case 0xE001:
        this._irqEnabled = true;
        break;
    }
  }

  notifyVramAddressChange(addr, context = null) {
    if (!this._isA12RisingEdge(addr, context)) {
      return;
    }

    const previousCounter = this._irqCounter;

    if (this._irqCounter === 0 || this._irqReload) {
      this._irqCounter = this._irqReloadValue;
    } else {
      this._irqCounter = (this._irqCounter - 1) & 0xFF;
    }

    if (this._forceMmc3RevAIrqs) {
      // MMC3A IRQ behavior.
      if ((previousCounter > 0 || this._irqReload) && this._irqCounter === 0 && this._irqEnabled) {
        this._triggerIrq();
      }
    } else if (this._irqCounter === 0 && this._irqEnabled) {
      this._triggerIrq();
    }

    this._irqReload = false;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mmc3: {
        currentRegister: this._currentRegister,
        wramEnabled: this._wramEnabled,
        wramWriteProtected: this._wramWriteProtected,
        a001Written: this._a001Written,
        a12LowClock: this._a12LowClock,
        clockFallback: this._clockFallback,
        forceMmc3RevAIrqs: this._forceMmc3RevAIrqs,

        stateReg8000: this._state.reg8000,
        stateRegA000: this._state.regA000,
        stateRegA001: this._state.regA001,

        irqReloadValue: this._irqReloadValue,
        irqCounter: this._irqCounter,
        irqReload: this._irqReload,
        irqEnabled: this._irqEnabled,
        prgMode: this._prgMode,
        chrMode: this._chrMode,
        registers: Array.from(this._registers),
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);

    const s = state && state.mmc3;
    if (!s) {
      this._updateState();
      this._updateMirroring();
      return;
    }

    this._currentRegister = s.currentRegister ?? this._currentRegister;
    this._wramEnabled = !!(s.wramEnabled ?? this._wramEnabled);
    this._wramWriteProtected = !!(s.wramWriteProtected ?? this._wramWriteProtected);
    this._a001Written = !!(s.a001Written ?? this._a001Written);
    this._a12LowClock = s.a12LowClock ?? this._a12LowClock;
    this._clockFallback = s.clockFallback ?? this._clockFallback;
    this._forceMmc3RevAIrqs = !!(s.forceMmc3RevAIrqs ?? this._forceMmc3RevAIrqs);

    this._state.reg8000 = (s.stateReg8000 ?? this._state.reg8000) & 0xFF;
    this._state.regA000 = (s.stateRegA000 ?? this._state.regA000) & 0xFF;
    this._state.regA001 = (s.stateRegA001 ?? this._state.regA001) & 0xFF;

    this._irqReloadValue = (s.irqReloadValue ?? this._irqReloadValue) & 0xFF;
    this._irqCounter = (s.irqCounter ?? this._irqCounter) & 0xFF;
    this._irqReload = !!(s.irqReload ?? this._irqReload);
    this._irqEnabled = !!(s.irqEnabled ?? this._irqEnabled);
    this._prgMode = (s.prgMode ?? this._prgMode) & 0x01;
    this._chrMode = (s.chrMode ?? this._chrMode) & 0x01;

    if (Array.isArray(s.registers) && s.registers.length >= 8) {
      this._registers = new Uint8Array(s.registers.slice(0, 8).map((v) => v & 0xFF));
    }

    this._updateState();
    this._updateMirroring();
  }
}

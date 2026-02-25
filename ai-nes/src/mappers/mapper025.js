import BaseMapper from "./mapper-base.js";

const VARIANT_VRC2C = 0;
const VARIANT_VRC4B = 1;
const VARIANT_VRC4D = 2;

// Mapper 025 (Konami VRC2c / VRC4b / VRC4d)
// Mesen reference baseline from mesen-vrc2_4.h, narrowed to mapper 25 variants.
export default class Mapper025 extends BaseMapper {
  getPrgPageSize() {
    return 0x2000;
  }

  getChrPageSize() {
    return 0x0400;
  }

  allowRegisterRead() {
    return true;
  }

  enableCpuClockHook() {
    return true;
  }

  _getPowerOnByte(defaultValue = 0) {
    // This codebase does not currently expose RandomizeMapperPowerOnState.
    return defaultValue & 0xFF;
  }

  _isVrc4Variant() {
    return this._variant === VARIANT_VRC4B || this._variant === VARIANT_VRC4D;
  }

  _detectVariant() {
    const mapperId = (this.cartridge && (this.cartridge.mapperType | 0)) || 0;
    const submapper = (this.cartridge && (this.cartridge.submapper | 0)) || 0;

    // Mapper 25 conflicts in Mesen: VRC2c, VRC4b, VRC4d
    switch (submapper) {
      case 2:
        this._variant = VARIANT_VRC4D;
        break;
      case 3:
        this._variant = VARIANT_VRC2C;
        break;
      case 1:
      case 0:
      default:
        this._variant = VARIANT_VRC4B;
        break;
    }

    this._useHeuristics = mapperId === 25 && submapper === 0;
  }

  _updateState() {
    for (let i = 0; i < 8; i++) {
      const page = (this._loChrRegs[i] | (this._hiChrRegs[i] << 4)) & 0x1FF;
      this.SelectChrPage(i, page);
    }

    if (this._prgMode === 0) {
      this.SelectPrgPage(0, this._prgReg0);
      this.SelectPrgPage(1, this._prgReg1);
      this.SelectPrgPage(2, -2);
      this.SelectPrgPage(3, -1);
    } else {
      this.SelectPrgPage(0, -2);
      this.SelectPrgPage(1, this._prgReg1);
      this.SelectPrgPage(2, this._prgReg0);
      this.SelectPrgPage(3, -1);
    }
  }

  _translateAddress(addr) {
    const address = addr & 0xFFFF;
    let a0 = 0;
    let a1 = 0;

    if (this._useHeuristics) {
      // Mapper 25 heuristic mode: OR VRC4b and VRC4d line mappings.
      a0 = (address >> 1) & 0x01;
      a1 = address & 0x01;

      a0 |= (address >> 3) & 0x01;
      a1 |= (address >> 2) & 0x01;
    } else if (this._variant === VARIANT_VRC4D) {
      a0 = (address >> 3) & 0x01;
      a1 = (address >> 2) & 0x01;
    } else {
      // VRC2c / VRC4b
      a0 = (address >> 1) & 0x01;
      a1 = address & 0x01;
    }

    return ((address & 0xFF00) | (a1 << 1) | a0) & 0xFFFF;
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

  _irqSetReloadValueNibble(value, highNibble) {
    if (highNibble) {
      this._irqReloadValue = ((this._irqReloadValue & 0x0F) | ((value & 0x0F) << 4)) & 0xFF;
    } else {
      this._irqReloadValue = ((this._irqReloadValue & 0xF0) | (value & 0x0F)) & 0xFF;
    }
  }

  _irqSetControlValue(value) {
    this._irqEnabledAfterAck = (value & 0x01) !== 0;
    this._irqEnabled = (value & 0x02) !== 0;
    this._irqCycleMode = (value & 0x04) !== 0;
    this._clearExternalIrq();

    if (this._irqEnabled) {
      this._irqCounter = this._irqReloadValue & 0xFF;
      this._irqPrescaler = 341;
    }
  }

  _irqAcknowledge() {
    this._clearExternalIrq();
    this._irqEnabled = this._irqEnabledAfterAck;
  }

  _irqClockCounter() {
    if (this._irqCounter === 0xFF) {
      this._irqCounter = this._irqReloadValue & 0xFF;
      this._triggerIrq();
    } else {
      this._irqCounter = (this._irqCounter + 1) & 0xFF;
    }
  }

  _irqProcessCpuClock() {
    if (!this._irqEnabled) {
      return;
    }

    if (this._irqCycleMode) {
      this._irqClockCounter();
      return;
    }

    this._irqPrescaler -= 3;
    while (this._irqPrescaler <= 0) {
      this._irqPrescaler += 341;
      this._irqClockCounter();
    }
  }

  _initVrcState() {
    this._detectVariant();

    this._prgMode = this._isVrc4Variant() ? (this._getPowerOnByte() & 0x01) : 0;
    this._prgReg0 = this._getPowerOnByte() & 0x1F;
    this._prgReg1 = this._getPowerOnByte() & 0x1F;
    this._latch = 0;

    this._loChrRegs = new Uint8Array(8);
    this._hiChrRegs = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      this._loChrRegs[i] = this._getPowerOnByte() & 0x0F;
      this._hiChrRegs[i] = this._getPowerOnByte() & 0x1F;
    }

    this._irqReloadValue = 0;
    this._irqCounter = 0;
    this._irqPrescaler = 341;
    this._irqEnabled = false;
    this._irqEnabledAfterAck = false;
    this._irqCycleMode = false;

    this._updateState();
    this._clearExternalIrq();

    // Mesen removes all read-register ranges and only exposes the VRC2
    // microwire interface at $6000-$7FFF when no PRG RAM is present.
    this.RemoveRegisterRange(0x0000, 0xFFFF, this.MemoryOperation.Read);
    if (!this._useHeuristics && this._variant === VARIANT_VRC2C && this._workRamSize === 0 && this._saveRamSize === 0) {
      this.AddRegisterRange(0x6000, 0x7FFF, this.MemoryOperation.Any);
    }
  }

  initMapper() {
    this._initVrcState();
  }

  reset(softReset = false) {
    super.reset(softReset);
    this._initVrcState();
  }

  processCpuClock() {
    if (this._useHeuristics || this._isVrc4Variant()) {
      this._irqProcessCpuClock();
    }
  }

  readRegister(addr) {
    return (this._latch & 0x01) | (this._openBus(addr) & 0xFE);
  }

  writeRegister(addr, value) {
    const address = addr & 0xFFFF;
    const writeValue = value & 0xFF;

    if (address < 0x8000) {
      // Microwire interface ($6000-$6FFF) for VRC2 variants.
      this._latch = writeValue & 0x01;
      return;
    }

    const translated = this._translateAddress(address) & 0xF00F;
    const isVrc2 = this._variant === VARIANT_VRC2C;
    const isVrc4 = this._isVrc4Variant();

    if (translated >= 0x8000 && translated <= 0x8006) {
      this._prgReg0 = writeValue & 0x1F;
    } else if (
      (isVrc2 && translated >= 0x9000 && translated <= 0x9003) ||
      (isVrc4 && translated >= 0x9000 && translated <= 0x9001)
    ) {
      let mask = 0x03;
      if (!this._useHeuristics && isVrc2) {
        // Known VRC2 boards use only bit 0 for mirroring select.
        mask = 0x01;
      }

      switch (writeValue & mask) {
        case 0:
          this.SetMirroringType(this.MIRROR_VERTICAL);
          break;
        case 1:
          this.SetMirroringType(this.MIRROR_HORIZONTAL);
          break;
        case 2:
          this.SetMirroringType(this.MIRROR_SINGLE_A);
          break;
        case 3:
          this.SetMirroringType(this.MIRROR_SINGLE_B);
          break;
      }
    } else if (isVrc4 && translated >= 0x9002 && translated <= 0x9003) {
      this._prgMode = (writeValue >> 1) & 0x01;
    } else if (translated >= 0xA000 && translated <= 0xA006) {
      this._prgReg1 = writeValue & 0x1F;
    } else if (translated >= 0xB000 && translated <= 0xE006) {
      const regNumber = ((((translated >> 12) & 0x07) - 3) << 1) + ((translated >> 1) & 0x01);
      const lowBits = (translated & 0x01) === 0;

      if (lowBits) {
        this._loChrRegs[regNumber] = writeValue & 0x0F;
      } else {
        this._hiChrRegs[regNumber] = writeValue & 0x1F;
      }
    } else if (translated === 0xF000) {
      this._irqSetReloadValueNibble(writeValue, false);
    } else if (translated === 0xF001) {
      this._irqSetReloadValueNibble(writeValue, true);
    } else if (translated === 0xF002) {
      this._irqSetControlValue(writeValue);
    } else if (translated === 0xF003) {
      this._irqAcknowledge();
    }

    this._updateState();
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mapper025: {
        variant: this._variant | 0,
        useHeuristics: !!this._useHeuristics,
        prgReg0: this._prgReg0 | 0,
        prgReg1: this._prgReg1 | 0,
        prgMode: this._prgMode | 0,
        latch: this._latch | 0,
        loChrRegs: Array.from(this._loChrRegs || []),
        hiChrRegs: Array.from(this._hiChrRegs || []),
        irqReloadValue: this._irqReloadValue | 0,
        irqCounter: this._irqCounter | 0,
        irqPrescaler: this._irqPrescaler | 0,
        irqEnabled: !!this._irqEnabled,
        irqEnabledAfterAck: !!this._irqEnabledAfterAck,
        irqCycleMode: !!this._irqCycleMode,
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);

    const s = state && state.mapper025;
    if (!s) {
      this._initVrcState();
      return;
    }

    this._variant = (s.variant ?? this._variant ?? VARIANT_VRC4B) | 0;
    this._useHeuristics = !!(s.useHeuristics ?? this._useHeuristics);
    this._prgReg0 = (s.prgReg0 ?? this._prgReg0 ?? 0) & 0x1F;
    this._prgReg1 = (s.prgReg1 ?? this._prgReg1 ?? 0) & 0x1F;
    this._prgMode = (s.prgMode ?? this._prgMode ?? 0) & 0x01;
    this._latch = (s.latch ?? this._latch ?? 0) & 0x01;

    const lo = Array.isArray(s.loChrRegs) ? s.loChrRegs : [];
    const hi = Array.isArray(s.hiChrRegs) ? s.hiChrRegs : [];
    this._loChrRegs = new Uint8Array(8);
    this._hiChrRegs = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      this._loChrRegs[i] = (lo[i] ?? 0) & 0x0F;
      this._hiChrRegs[i] = (hi[i] ?? 0) & 0x1F;
    }

    this._irqReloadValue = (s.irqReloadValue ?? this._irqReloadValue ?? 0) & 0xFF;
    this._irqCounter = (s.irqCounter ?? this._irqCounter ?? 0) & 0xFF;
    this._irqPrescaler = (s.irqPrescaler ?? this._irqPrescaler ?? 341) | 0;
    this._irqEnabled = !!(s.irqEnabled ?? this._irqEnabled);
    this._irqEnabledAfterAck = !!(s.irqEnabledAfterAck ?? this._irqEnabledAfterAck);
    this._irqCycleMode = !!(s.irqCycleMode ?? this._irqCycleMode);

    this.RemoveRegisterRange(0x0000, 0xFFFF, this.MemoryOperation.Read);
    if (!this._useHeuristics && this._variant === VARIANT_VRC2C && this._workRamSize === 0 && this._saveRamSize === 0) {
      this.AddRegisterRange(0x6000, 0x7FFF, this.MemoryOperation.Any);
    }

    this._updateState();
    if (!this._irqEnabled) {
      this._clearExternalIrq();
    }
  }
}

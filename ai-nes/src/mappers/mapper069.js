import BaseMapper from "./mapper-base.js";

const SUNSOFT5B_VOLUME_TABLE = Object.freeze([
  0.0,
  0.0015,
  0.0025,
  0.0035,
  0.0050,
  0.0070,
  0.0100,
  0.0140,
  0.0200,
  0.0280,
  0.0390,
  0.0550,
  0.0780,
  0.1100,
  0.1550,
  0.2200,
]);

class Sunsoft5BAudio {
  constructor() {
    this._registers = new Uint8Array(16);
    this._tonePeriod = new Uint16Array(3);
    this._toneCounter = new Uint16Array(3);
    this._toneOutput = new Uint8Array(3);
    this.reset();
  }

  reset() {
    this._selectedRegister = 0;
    this._registers.fill(0);
    this._tonePeriod.fill(1);
    this._toneCounter.fill(1);
    this._toneOutput.fill(0);

    this._noisePeriod = 1;
    this._noiseCounter = 1;
    this._noiseShift = 0x1ffff;
    this._noiseOutput = 1;

    this._envPeriod = 1;
    this._envCounter = 1;
    this._envStep = 15;
    this._envContinue = 0;
    this._envAttack = 0;
    this._envAlternate = 0;
    this._envHold = 0;
    this._envHolding = false;

    this._clockDivider = 0;
  }

  _updateTonePeriod(channel) {
    const ch = channel | 0;
    const lo = this._registers[ch * 2] & 0xff;
    const hi = this._registers[ch * 2 + 1] & 0x0f;
    let period = ((hi << 8) | lo) & 0x0fff;
    if (period === 0) {
      period = 1;
    }

    this._tonePeriod[ch] = period;
    if (this._toneCounter[ch] === 0 || this._toneCounter[ch] > period) {
      this._toneCounter[ch] = period;
    }
  }

  _updateNoisePeriod() {
    let period = this._registers[6] & 0x1f;
    if (period === 0) {
      period = 1;
    }

    this._noisePeriod = period;
    if (this._noiseCounter === 0 || this._noiseCounter > period) {
      this._noiseCounter = period;
    }
  }

  _updateEnvelopePeriod() {
    let period = ((this._registers[12] << 8) | this._registers[11]) & 0xffff;
    if (period === 0) {
      period = 1;
    }

    this._envPeriod = period;
    if (this._envCounter === 0 || this._envCounter > period) {
      this._envCounter = period;
    }
  }

  _restartEnvelope(shape) {
    const value = shape & 0x0f;
    this._envContinue = (value >> 3) & 0x01;
    this._envAttack = (value >> 2) & 0x01;
    this._envAlternate = (value >> 1) & 0x01;
    this._envHold = value & 0x01;
    this._envStep = 15;
    this._envHolding = false;
    this._envCounter = this._envPeriod;
  }

  writeRegister(addr, value) {
    const address = addr & 0xe000;
    const writeValue = value & 0xff;

    if (address === 0xc000) {
      this._selectedRegister = writeValue & 0x0f;
      return;
    }

    if (address !== 0xe000) {
      return;
    }

    const reg = this._selectedRegister & 0x0f;
    this._registers[reg] = writeValue;

    switch (reg) {
      case 0:
      case 1:
        this._updateTonePeriod(0);
        break;
      case 2:
      case 3:
        this._updateTonePeriod(1);
        break;
      case 4:
      case 5:
        this._updateTonePeriod(2);
        break;
      case 6:
        this._updateNoisePeriod();
        break;
      case 11:
      case 12:
        this._updateEnvelopePeriod();
        break;
      case 13:
        this._restartEnvelope(writeValue);
        break;
    }
  }

  _clockTone(channel) {
    const ch = channel | 0;
    let counter = (this._toneCounter[ch] | 0) - 1;
    if (counter <= 0) {
      counter = this._tonePeriod[ch] | 0;
      this._toneOutput[ch] ^= 0x01;
    }
    this._toneCounter[ch] = counter & 0xffff;
  }

  _clockNoise() {
    let counter = (this._noiseCounter | 0) - 1;
    if (counter <= 0) {
      counter = this._noisePeriod | 0;

      // 17-bit LFSR approximation used by AY/YM-family noise.
      const feedback = ((this._noiseShift ^ (this._noiseShift >> 3)) & 0x01) !== 0 ? 1 : 0;
      this._noiseShift = ((this._noiseShift >> 1) | (feedback << 16)) & 0x1ffff;
      this._noiseOutput = this._noiseShift & 0x01;
    }
    this._noiseCounter = counter & 0xffff;
  }

  _clockEnvelope() {
    if (this._envHolding) {
      return;
    }

    let counter = (this._envCounter | 0) - 1;
    if (counter > 0) {
      this._envCounter = counter & 0xffff;
      return;
    }

    counter = this._envPeriod | 0;
    this._envStep--;

    if (this._envStep < 0) {
      if (this._envContinue === 0) {
        this._envStep = 0;
        this._envHolding = true;
      } else if (this._envHold) {
        if (this._envAlternate) {
          this._envAttack ^= 0x01;
        }
        this._envStep = 0;
        this._envHolding = true;
      } else {
        if (this._envAlternate) {
          this._envAttack ^= 0x01;
        }
        this._envStep = 15;
      }
    }

    this._envCounter = counter & 0xffff;
  }

  clock(cycles = 1) {
    const count = Math.max(0, cycles | 0);
    for (let i = 0; i < count; i++) {
      // FME-7 clocks the PSG from a divided CPU clock.
      this._clockDivider ^= 0x01;
      if (this._clockDivider !== 0) {
        continue;
      }

      this._clockTone(0);
      this._clockTone(1);
      this._clockTone(2);
      this._clockNoise();
      this._clockEnvelope();
    }
  }

  _getEnvelopeVolume() {
    const level = this._envAttack ? this._envStep : (15 - this._envStep);
    return SUNSOFT5B_VOLUME_TABLE[level & 0x0f];
  }

  _getChannelSample(channel) {
    const ch = channel | 0;
    const mixer = this._registers[7] & 0x3f;

    const toneDisabled = ((mixer >> ch) & 0x01) !== 0;
    const noiseDisabled = ((mixer >> (ch + 3)) & 0x01) !== 0;

    const tonePass = toneDisabled || (this._toneOutput[ch] !== 0);
    const noisePass = noiseDisabled || (this._noiseOutput !== 0);
    if (!tonePass || !noisePass) {
      return 0;
    }

    const volReg = this._registers[8 + ch] & 0x1f;
    if ((volReg & 0x10) !== 0) {
      return this._getEnvelopeVolume();
    }
    return SUNSOFT5B_VOLUME_TABLE[volReg & 0x0f];
  }

  getSample() {
    return this._getChannelSample(0) + this._getChannelSample(1) + this._getChannelSample(2);
  }

  toJSON() {
    return {
      selectedRegister: this._selectedRegister | 0,
      registers: Array.from(this._registers),
      tonePeriod: Array.from(this._tonePeriod),
      toneCounter: Array.from(this._toneCounter),
      toneOutput: Array.from(this._toneOutput),
      noisePeriod: this._noisePeriod | 0,
      noiseCounter: this._noiseCounter | 0,
      noiseShift: this._noiseShift | 0,
      noiseOutput: this._noiseOutput | 0,
      envPeriod: this._envPeriod | 0,
      envCounter: this._envCounter | 0,
      envStep: this._envStep | 0,
      envContinue: this._envContinue | 0,
      envAttack: this._envAttack | 0,
      envAlternate: this._envAlternate | 0,
      envHold: this._envHold | 0,
      envHolding: !!this._envHolding,
      clockDivider: this._clockDivider | 0,
    };
  }

  fromJSON(state) {
    if (!state) {
      return;
    }

    this._selectedRegister = (state.selectedRegister ?? 0) & 0x0f;

    if (state.registers) {
      this._registers = new Uint8Array(state.registers);
    } else {
      this._registers.fill(0);
    }

    if (state.tonePeriod) this._tonePeriod = new Uint16Array(state.tonePeriod);
    if (state.toneCounter) this._toneCounter = new Uint16Array(state.toneCounter);
    if (state.toneOutput) this._toneOutput = new Uint8Array(state.toneOutput);

    this._noisePeriod = (state.noisePeriod ?? this._noisePeriod ?? 1) & 0xffff;
    this._noiseCounter = (state.noiseCounter ?? this._noiseCounter ?? 1) & 0xffff;
    this._noiseShift = (state.noiseShift ?? this._noiseShift ?? 0x1ffff) & 0x1ffff;
    this._noiseOutput = (state.noiseOutput ?? this._noiseOutput ?? 1) & 0x01;

    this._envPeriod = (state.envPeriod ?? this._envPeriod ?? 1) & 0xffff;
    this._envCounter = (state.envCounter ?? this._envCounter ?? 1) & 0xffff;
    this._envStep = (state.envStep ?? this._envStep ?? 15) & 0xff;
    this._envContinue = (state.envContinue ?? this._envContinue ?? 0) & 0x01;
    this._envAttack = (state.envAttack ?? this._envAttack ?? 0) & 0x01;
    this._envAlternate = (state.envAlternate ?? this._envAlternate ?? 0) & 0x01;
    this._envHold = (state.envHold ?? this._envHold ?? 0) & 0x01;
    this._envHolding = !!(state.envHolding ?? this._envHolding ?? false);
    this._clockDivider = (state.clockDivider ?? this._clockDivider ?? 0) & 0x01;

    for (let i = 0; i < 3; i++) {
      if (!this._tonePeriod[i]) this._tonePeriod[i] = 1;
      if (!this._toneCounter[i]) this._toneCounter[i] = 1;
    }
    if (!this._noisePeriod) this._noisePeriod = 1;
    if (!this._noiseCounter) this._noiseCounter = 1;
    if (!this._envPeriod) this._envPeriod = 1;
    if (!this._envCounter) this._envCounter = 1;
  }
}

// Mapper 069 (Sunsoft FME-7 / Sunsoft 5B)
// Mesen reference behavior from mesen-sunsoft-fme7.h.
export default class Mapper069 extends BaseMapper {
  getPrgPageSize() {
    return 0x2000;
  }

  getChrPageSize() {
    return 0x0400;
  }

  getWorkRamSize() {
    return 0x8000;
  }

  getWorkRamPageSize() {
    return 0x2000;
  }

  getSaveRamSize() {
    return 0x8000;
  }

  getSaveRamPageSize() {
    return 0x2000;
  }

  enableCpuClockHook() {
    return true;
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

  _ensureAudioSource() {
    if (!this._audio) {
      this._audio = new Sunsoft5BAudio();
    }

    if (this.nes && this.nes.papu && typeof this.nes.papu.setExpansionAudioSource === "function") {
      this.nes.papu.setExpansionAudioSource("sunsoft5b", this._audio);
    }
  }

  _updateWorkRam() {
    if ((this._workRamValue & 0x40) !== 0) {
      const accessType = (this._workRamValue & 0x80) !== 0
        ? this.MemoryAccessType.ReadWrite
        : this.MemoryAccessType.NoAccess;
      const memoryType = this.hasBattery() ? this.PrgMemoryType.SaveRam : this.PrgMemoryType.WorkRam;
      this.SetCpuMemoryMapping(0x6000, 0x7fff, this._workRamValue & 0x3f, memoryType, accessType);
    } else {
      this.SetCpuMemoryMapping(0x6000, 0x7fff, this._workRamValue & 0x3f, this.PrgMemoryType.PrgRom);
    }
  }

  _resetState() {
    this._ensureAudioSource();
    this._audio.reset();

    this._command = 0;
    this._workRamValue = 0;
    this._irqEnabled = false;
    this._irqCounterEnabled = false;
    this._irqCounter = 0;

    this.SelectPrgPage(3, -1);
    this._updateWorkRam();
    this._clearExternalIrq();
  }

  initMapper() {
    this._resetState();
  }

  reset(softReset = false) {
    super.reset(softReset);
    this._resetState();
  }

  processCpuClock() {
    if (this._irqCounterEnabled) {
      this._irqCounter = (this._irqCounter - 1) & 0xffff;
      if (this._irqCounter === 0xffff && this._irqEnabled) {
        this._triggerIrq();
      }
    }

    if (this._audio) {
      this._audio.clock(1);
    }
  }

  _writeCommandData(value) {
    const writeValue = value & 0xff;

    switch (this._command & 0x0f) {
      case 0:
      case 1:
      case 2:
      case 3:
      case 4:
      case 5:
      case 6:
      case 7:
        this.SelectChrPage(this._command & 0x07, writeValue);
        break;
      case 8:
        this._workRamValue = writeValue;
        this._updateWorkRam();
        break;
      case 9:
      case 0x0a:
      case 0x0b:
        this.SelectPrgPage((this._command & 0x0f) - 9, writeValue & 0x3f);
        break;
      case 0x0c:
        switch (writeValue & 0x03) {
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
        break;
      case 0x0d:
        this._irqEnabled = (writeValue & 0x01) === 0x01;
        this._irqCounterEnabled = (writeValue & 0x80) === 0x80;
        this._clearExternalIrq();
        break;
      case 0x0e:
        this._irqCounter = ((this._irqCounter & 0xff00) | writeValue) & 0xffff;
        break;
      case 0x0f:
        this._irqCounter = ((this._irqCounter & 0x00ff) | (writeValue << 8)) & 0xffff;
        break;
    }
  }

  writeRegister(addr, value) {
    const address = addr & 0xe000;
    const writeValue = value & 0xff;

    switch (address) {
      case 0x8000:
        this._command = writeValue & 0x0f;
        break;
      case 0xa000:
        this._writeCommandData(writeValue);
        break;
      case 0xc000:
      case 0xe000:
        if (this._audio) {
          this._audio.writeRegister(address, writeValue);
        }
        break;
    }
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mapper069: {
        command: this._command | 0,
        workRamValue: this._workRamValue | 0,
        irqEnabled: !!this._irqEnabled,
        irqCounterEnabled: !!this._irqCounterEnabled,
        irqCounter: this._irqCounter | 0,
        audio: this._audio ? this._audio.toJSON() : null,
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);
    this._ensureAudioSource();

    const s = (state && state.mapper069) || null;
    if (!s) {
      this._resetState();
      return;
    }

    this._command = (s.command ?? 0) & 0x0f;
    this._workRamValue = (s.workRamValue ?? 0) & 0xff;
    this._irqEnabled = !!s.irqEnabled;
    this._irqCounterEnabled = !!s.irqCounterEnabled;
    this._irqCounter = (s.irqCounter ?? 0) & 0xffff;

    if (this._audio) {
      this._audio.fromJSON(s.audio || null);
    }

    this.SelectPrgPage(3, -1);
    this._updateWorkRam();
  }
}

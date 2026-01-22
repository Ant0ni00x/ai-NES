import { toJSON, fromJSON } from "../utils.js";

const CPU_FREQ_NTSC = 1789772.5;
const MMC5_FRAME_HZ = 240;
const MMC5_FRAME_PERIOD = CPU_FREQ_NTSC / MMC5_FRAME_HZ;

// Length counter lookup (same as APU)
const LENGTH_LOOKUP = [
  0x0a, 0xfe,
  0x14, 0x02,
  0x28, 0x04,
  0x50, 0x06,
  0xa0, 0x08,
  0x3c, 0x0a,
  0x0e, 0x0c,
  0x1a, 0x0e,
  0x0c, 0x10,
  0x18, 0x12,
  0x30, 0x14,
  0x60, 0x16,
  0xc0, 0x18,
  0x48, 0x1a,
  0x10, 0x1c,
  0x20, 0x1e,
];

// Duty sequences (same as APU)
const DUTY_LOOKUP = [
  0, 1, 0, 0, 0, 0, 0, 0,
  0, 1, 1, 0, 0, 0, 0, 0,
  0, 1, 1, 1, 1, 0, 0, 0,
  1, 0, 0, 1, 1, 1, 1, 1,
];

class Mmc5Square {
  constructor() {
    this.isEnabled = false;
    this.lengthCounterHalt = false;
    this.envDecayDisable = false;
    this.envDecayLoopEnable = false;
    this.envReset = false;

    this.envDecayRate = 0;
    this.envDecayCounter = 0;
    this.envVolume = 0;
    this.masterVolume = 0;
    this.dutyMode = 0;
    this.lengthCounter = 0;
    this.lengthReloadValue = 0;
    this.timerCounter = 0;
    this.timerPeriod = 0;
    this.dutyPos = 0;
    this.output = 0;

    this.JSON_PROPERTIES = [
      "isEnabled",
      "lengthCounterHalt",
      "envDecayDisable",
      "envDecayLoopEnable",
      "envReset",
      "envDecayRate",
      "envDecayCounter",
      "envVolume",
      "masterVolume",
      "dutyMode",
      "lengthCounter",
      "lengthReloadValue",
      "timerCounter",
      "timerPeriod",
      "dutyPos",
      "output",
    ];
  }

  reset() {
    this.isEnabled = false;
    this.lengthCounterHalt = false;
    this.envDecayDisable = false;
    this.envDecayLoopEnable = false;
    this.envReset = false;

    this.envDecayRate = 0;
    this.envDecayCounter = 0;
    this.envVolume = 0;
    this.masterVolume = 0;
    this.dutyMode = 0;
    this.lengthCounter = 0;
    this.lengthReloadValue = 0;
    this.timerCounter = 0;
    this.timerPeriod = 0;
    this.dutyPos = 0;
    this.output = 0;
  }

  clockTimer(nCycles) {
    this.timerCounter -= nCycles;
    while (this.timerCounter <= 0) {
      // Timer period is (period + 1) * 2 CPU cycles (APU rate).
      this.timerCounter += (this.timerPeriod + 1) << 1;
      this.dutyPos = (this.dutyPos + 1) & 7;
      this.updateOutput();
    }
  }

  clockEnvelope() {
    if (this.envReset) {
      this.envReset = false;
      this.envDecayCounter = this.envDecayRate + 1;
      this.envVolume = 0x0f;
    } else if (--this.envDecayCounter <= 0) {
      this.envDecayCounter = this.envDecayRate + 1;
      if (this.envVolume > 0) {
        this.envVolume--;
      } else {
        this.envVolume = this.envDecayLoopEnable ? 0x0f : 0;
      }
    }

    this.masterVolume = this.envDecayDisable ? this.envDecayRate : this.envVolume;
    this.updateOutput();
  }

  clockLengthCounter() {
    if (!this.lengthCounterHalt && this.lengthCounter > 0) {
      this.lengthCounter--;
      if (this.lengthCounter === 0) {
        this.updateOutput();
      }
    }
  }

  updateOutput() {
    if (this.isEnabled && this.lengthCounter > 0) {
      this.output = this.masterVolume * DUTY_LOOKUP[(this.dutyMode << 3) + this.dutyPos];
    } else {
      this.output = 0;
    }
  }

  writeReg(addr, value) {
    switch (addr) {
      case 0x5000:
      case 0x5004:
        this.envDecayDisable = (value & 0x10) !== 0;
        this.envDecayRate = value & 0x0f;
        this.lengthCounterHalt = (value & 0x20) !== 0;
        this.envDecayLoopEnable = this.lengthCounterHalt;
        this.dutyMode = (value >> 6) & 0x03;
        this.masterVolume = this.envDecayDisable ? this.envDecayRate : this.envVolume;
        this.updateOutput();
        return;

      case 0x5001:
      case 0x5005:
        // Sweep is not implemented on MMC5 pulse channels.
        return;

      case 0x5002:
      case 0x5006:
        this.timerPeriod = (this.timerPeriod & 0x700) | value;
        return;

      case 0x5003:
      case 0x5007:
        this.timerPeriod = (this.timerPeriod & 0x0ff) | ((value & 0x07) << 8);
        this.lengthReloadValue = LENGTH_LOOKUP[value >> 3];
        if (this.isEnabled) {
          this.lengthCounter = this.lengthReloadValue;
        }
        this.envReset = true;
        this.updateOutput();
        return;
    }
  }

  setEnabled(value) {
    this.isEnabled = value;
    if (!value) {
      this.lengthCounter = 0;
    }
    this.updateOutput();
  }

  getLengthStatus() {
    return this.lengthCounter === 0 || !this.isEnabled ? 0 : 1;
  }

  getOutput() {
    return this.output;
  }

  toJSON() {
    return toJSON(this);
  }

  fromJSON(state) {
    fromJSON(this, state);
  }
}

export class Mmc5Audio {
  constructor(nes) {
    this.nes = nes;
    this.papu = nes ? nes.papu : null;

    this.square1 = new Mmc5Square();
    this.square2 = new Mmc5Square();

    this.frameCounter = 0;
    this.pcmReadMode = false;
    this.pcmIrqEnabled = false;
    this.pcmOutput = 0;
    this.outputScale = null;

    this.JSON_PROPERTIES = [
      "frameCounter",
      "pcmReadMode",
      "pcmIrqEnabled",
      "pcmOutput",
    ];

    this.reset();
  }

  reset() {
    this.square1.reset();
    this.square2.reset();

    this.frameCounter = 0;
    this.pcmReadMode = false;
    this.pcmIrqEnabled = false;
    this.pcmOutput = 0;

    this.updateOutputScale();
  }

  updateOutputScale() {
    const pulseMax = this.papu && this.papu.square_table
      ? this.papu.square_table[30 << 4]
      : 13258;
    // Scale raw MMC5 output (0..285) to roughly match APU pulse output range.
    this.outputScale = pulseMax / 285;
  }

  clock(cpuCycles) {
    this.square1.clockTimer(cpuCycles);
    this.square2.clockTimer(cpuCycles);

    this.frameCounter += cpuCycles;
    while (this.frameCounter >= MMC5_FRAME_PERIOD) {
      this.frameCounter -= MMC5_FRAME_PERIOD;
      this.square1.clockLengthCounter();
      this.square1.clockEnvelope();
      this.square2.clockLengthCounter();
      this.square2.clockEnvelope();
    }
  }

  readStatus() {
    let status = 0;
    status |= this.square1.getLengthStatus() ? 0x01 : 0x00;
    status |= this.square2.getLengthStatus() ? 0x02 : 0x00;
    return status;
  }

  writeRegister(addr, value) {
    switch (addr) {
      case 0x5000:
      case 0x5001:
      case 0x5002:
      case 0x5003:
        this.square1.writeReg(addr, value);
        return;

      case 0x5004:
      case 0x5005:
      case 0x5006:
      case 0x5007:
        this.square2.writeReg(addr, value);
        return;

      case 0x5010:
        this.pcmReadMode = (value & 0x01) !== 0;
        this.pcmIrqEnabled = (value & 0x80) !== 0;
        return;

      case 0x5011:
        if (!this.pcmReadMode) {
          if (value !== 0) {
            this.pcmOutput = value & 0xff;
          }
        }
        return;

      case 0x5015:
        this.square1.setEnabled((value & 0x01) !== 0);
        this.square2.setEnabled((value & 0x02) !== 0);
        return;
    }
  }

  setPcmOutput(value) {
    this.pcmOutput = value & 0xff;
  }

  getSample() {
    if (this.outputScale === null) {
      this.updateOutputScale();
    }
    const raw = this.square1.getOutput() + this.square2.getOutput() + this.pcmOutput;
    return -raw * this.outputScale;
  }

  toJSON() {
    const state = toJSON(this);
    state.square1 = this.square1.toJSON();
    state.square2 = this.square2.toJSON();
    return state;
  }

  fromJSON(state) {
    if (!state) return;
    fromJSON(this, state);
    if (state.square1) this.square1.fromJSON(state.square1);
    if (state.square2) this.square2.fromJSON(state.square2);
  }
}
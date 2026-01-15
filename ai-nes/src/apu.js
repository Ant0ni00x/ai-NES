import { toJSON, fromJSON } from "./utils.js";

const CPU_FREQ_NTSC = 1789772.5;

const DUTY_TABLE = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [0, 0, 0, 0, 0, 0, 1, 1],
  [0, 0, 0, 0, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 0, 0],
];

const TRI_SEQUENCE = [
  15, 14, 13, 12, 11, 10, 9, 8,
  7, 6, 5, 4, 3, 2, 1, 0,
  0, 1, 2, 3, 4, 5, 6, 7,
  8, 9, 10, 11, 12, 13, 14, 15,
];

const LENGTH_TABLE = [
  0x0a, 0xfe, 0x14, 0x02, 0x28, 0x04, 0x50, 0x06,
  0xa0, 0x08, 0x3c, 0x0a, 0x0e, 0x0c, 0x1a, 0x0e,
  0x0c, 0x10, 0x18, 0x12, 0x30, 0x14, 0x60, 0x16,
  0xc0, 0x18, 0x48, 0x1a, 0x10, 0x1c, 0x20, 0x1e,
];

const NOISE_PERIOD_NTSC = [
  4, 8, 16, 32, 64, 96, 128, 160,
  202, 254, 380, 508, 762, 1016, 2034, 4068,
];

const DMC_PERIOD_NTSC = [
  428, 380, 340, 320, 286, 254, 226, 214,
  190, 160, 142, 128, 106, 84, 72, 54,
];

const FRAME_COUNTER_STEPS_NTSC = {
  4: [
    { cycles: 7457, quarter: true, half: false, irq: false },
    { cycles: 14913, quarter: true, half: true, irq: false },
    { cycles: 22371, quarter: true, half: false, irq: false },
    { cycles: 29829, quarter: true, half: true, irq: true },
  ],
  5: [
    { cycles: 7457, quarter: true, half: false, irq: false },
    { cycles: 14913, quarter: true, half: true, irq: false },
    { cycles: 22371, quarter: true, half: false, irq: false },
    { cycles: 29829, quarter: false, half: false, irq: false },
    { cycles: 37281, quarter: true, half: true, irq: false },
  ],
};

class ApuLengthCounter {
  constructor(channelName) {
    this.channelName = channelName;
    this.JSON_PROPERTIES = [
      "enabled",
      "halt",
      "counter",
      "reloadValue",
      "previousValue",
      "newHaltValue",
    ];
    this.reset(false);
  }

  reset(softReset) {
    if (softReset) {
      this.enabled = false;
      if (this.channelName !== "triangle") {
        this.halt = false;
        this.counter = 0;
        this.newHaltValue = false;
        this.reloadValue = 0;
        this.previousValue = 0;
      }
      return;
    }

    this.enabled = false;
    this.halt = false;
    this.counter = 0;
    this.newHaltValue = false;
    this.reloadValue = 0;
    this.previousValue = 0;
  }

  initialize(haltFlag) {
    this.newHaltValue = !!haltFlag;
  }

  load(index) {
    if (!this.enabled) return;
    this.reloadValue = LENGTH_TABLE[index & 0x1f];
    this.previousValue = this.counter;
  }

  reload() {
    if (this.reloadValue) {
      if (this.counter === this.previousValue) {
        this.counter = this.reloadValue;
      }
      this.reloadValue = 0;
    }
    this.halt = this.newHaltValue;
  }

  tick() {
    if (this.counter > 0 && !this.halt) {
      this.counter--;
    }
  }

  setEnabled(enabled) {
    if (!enabled) {
      this.counter = 0;
    }
    this.enabled = !!enabled;
  }

  getStatus() {
    return this.counter > 0;
  }

  toJSON() {
    return toJSON(this);
  }

  fromJSON(state) {
    if (!state) return;
    fromJSON(this, state);
  }
}

class ApuEnvelope {
  constructor(channelName) {
    this.lengthCounter = new ApuLengthCounter(channelName);
    this.JSON_PROPERTIES = [
      "constantVolume",
      "volume",
      "startFlag",
      "divider",
      "decayCounter",
    ];
    this.reset(false);
  }

  reset(softReset) {
    this.lengthCounter.reset(softReset);
    this.constantVolume = false;
    this.volume = 0;
    this.startFlag = false;
    this.divider = 0;
    this.decayCounter = 0;
  }

  initialize(value) {
    this.lengthCounter.initialize((value & 0x20) !== 0);
    this.constantVolume = (value & 0x10) !== 0;
    this.volume = value & 0x0f;
  }

  resetEnvelope() {
    this.startFlag = true;
  }

  clock() {
    if (!this.startFlag) {
      this.divider--;
      if (this.divider < 0) {
        this.divider = this.volume;
        if (this.decayCounter > 0) {
          this.decayCounter--;
        } else if (this.lengthCounter.halt) {
          this.decayCounter = 15;
        }
      }
    } else {
      this.startFlag = false;
      this.decayCounter = 15;
      this.divider = this.volume;
    }
  }

  getVolume() {
    if (!this.lengthCounter.getStatus()) return 0;
    return this.constantVolume ? this.volume : this.decayCounter;
  }

  toJSON() {
    const state = toJSON(this);
    state.lengthCounter = this.lengthCounter.toJSON();
    return state;
  }

  fromJSON(state) {
    if (!state) return;
    fromJSON(this, state);
    if (state.lengthCounter) {
      this.lengthCounter.fromJSON(state.lengthCounter);
    }
  }
}

class SquareChannel {
  constructor(channelName, isChannel1) {
    this.channelName = channelName;
    this.isChannel1 = isChannel1;
    this.envelope = new ApuEnvelope(channelName);
    this.JSON_PROPERTIES = [
      "duty",
      "dutyPos",
      "period",
      "timer",
      "sweepEnabled",
      "sweepPeriod",
      "sweepNegate",
      "sweepShift",
      "sweepReload",
      "sweepDivider",
      "sweepTarget",
      "output",
    ];
    this.reset(false);
  }

  reset(softReset) {
    this.envelope.reset(softReset);
    this.duty = 0;
    this.dutyPos = 0;
    this.period = 0;
    this.timer = 0;
    this.sweepEnabled = false;
    this.sweepPeriod = 0;
    this.sweepNegate = false;
    this.sweepShift = 0;
    this.sweepReload = false;
    this.sweepDivider = 0;
    this.sweepTarget = 0;
    this.output = 0;
    this.updateSweepTarget();
  }

  setEnabled(enabled) {
    this.envelope.lengthCounter.setEnabled(enabled);
    this.updateOutput();
  }

  setPeriod(newPeriod) {
    this.period = newPeriod & 0x7ff;
    this.updateSweepTarget();
  }

  updateSweepTarget() {
    const shiftResult = this.sweepShift > 0 ? (this.period >> this.sweepShift) : 0;
    if (this.sweepNegate) {
      this.sweepTarget = this.period - shiftResult - (this.isChannel1 ? 1 : 0);
    } else {
      this.sweepTarget = this.period + shiftResult;
    }
  }

  isMuted() {
    return this.period < 8 || (!this.sweepNegate && this.sweepTarget > 0x7ff);
  }

  updateOutput() {
    if (this.isMuted()) {
      this.output = 0;
    } else {
      this.output = DUTY_TABLE[this.duty][this.dutyPos] * this.envelope.getVolume();
    }
  }

  clockTimer() {
    if (this.timer === 0) {
      this.timer = (this.period * 2) + 1;
      this.dutyPos = (this.dutyPos - 1) & 0x07;
      this.updateOutput();
    } else {
      this.timer--;
    }
  }

  clockEnvelope() {
    this.envelope.clock();
    this.updateOutput();
  }

  clockLengthCounter() {
    this.envelope.lengthCounter.tick();
    this.updateOutput();
  }

  clockSweep() {
    if (this.sweepDivider > 0) {
      this.sweepDivider--;
    }
    if (this.sweepDivider === 0) {
      if (this.sweepShift > 0 && this.sweepEnabled && this.period >= 8 && this.sweepTarget <= 0x7ff) {
        this.setPeriod(this.sweepTarget);
      }
      this.sweepDivider = this.sweepPeriod;
    }

    if (this.sweepReload) {
      this.sweepDivider = this.sweepPeriod;
      this.sweepReload = false;
    }
    this.updateOutput();
  }

  writeControl(value) {
    this.envelope.initialize(value);
    this.duty = (value >> 6) & 0x03;
    this.updateOutput();
  }

  writeSweep(value) {
    this.sweepEnabled = (value & 0x80) !== 0;
    this.sweepNegate = (value & 0x08) !== 0;
    this.sweepPeriod = ((value >> 4) & 0x07) + 1;
    this.sweepShift = value & 0x07;
    this.sweepReload = true;
    this.updateSweepTarget();
  }

  writeTimerLow(value) {
    this.setPeriod((this.period & 0x700) | (value & 0xff));
  }

  writeTimerHigh(value) {
    this.envelope.lengthCounter.load((value >> 3) & 0x1f);
    this.setPeriod((this.period & 0xff) | ((value & 0x07) << 8));
    this.dutyPos = 0;
    this.envelope.resetEnvelope();
  }

  reloadLengthCounter() {
    this.envelope.lengthCounter.reload();
  }

  toJSON() {
    const state = toJSON(this);
    state.envelope = this.envelope.toJSON();
    return state;
  }

  fromJSON(state) {
    if (!state) return;
    fromJSON(this, state);
    if (state.envelope) {
      this.envelope.fromJSON(state.envelope);
    }
    this.setPeriod(this.period);
    this.updateOutput();
  }
}

class TriangleChannel {
  constructor() {
    this.lengthCounter = new ApuLengthCounter("triangle");
    this.JSON_PROPERTIES = [
      "period",
      "timer",
      "sequencePos",
      "linearCounter",
      "linearCounterReload",
      "linearReloadFlag",
      "linearControlFlag",
    ];
    this.reset(false);
  }

  reset(softReset) {
    this.lengthCounter.reset(softReset);
    this.period = 0;
    this.timer = 0;
    this.sequencePos = 0;
    this.linearCounter = 0;
    this.linearCounterReload = 0;
    this.linearReloadFlag = false;
    this.linearControlFlag = false;
  }

  setEnabled(enabled) {
    this.lengthCounter.setEnabled(enabled);
  }

  clockTimer() {
    if (this.timer === 0) {
      this.timer = this.period;
      if (this.lengthCounter.getStatus() && this.linearCounter > 0) {
        this.sequencePos = (this.sequencePos + 1) & 0x1f;
      }
    } else {
      this.timer--;
    }
  }

  clockLinearCounter() {
    if (this.linearReloadFlag) {
      this.linearCounter = this.linearCounterReload;
    } else if (this.linearCounter > 0) {
      this.linearCounter--;
    }

    if (!this.linearControlFlag) {
      this.linearReloadFlag = false;
    }
  }

  clockLengthCounter() {
    this.lengthCounter.tick();
  }

  reloadLengthCounter() {
    this.lengthCounter.reload();
  }

  writeControl(value) {
    this.linearControlFlag = (value & 0x80) !== 0;
    this.linearCounterReload = value & 0x7f;
    this.lengthCounter.initialize(this.linearControlFlag);
  }

  writeTimerLow(value) {
    this.period = (this.period & 0x700) | (value & 0xff);
  }

  writeTimerHigh(value) {
    this.lengthCounter.load((value >> 3) & 0x1f);
    this.period = (this.period & 0xff) | ((value & 0x07) << 8);
    this.linearReloadFlag = true;
  }

  getOutput() {
    if (!this.lengthCounter.getStatus() || this.linearCounter === 0) return 0;
    return TRI_SEQUENCE[this.sequencePos];
  }

  toJSON() {
    const state = toJSON(this);
    state.lengthCounter = this.lengthCounter.toJSON();
    return state;
  }

  fromJSON(state) {
    if (!state) return;
    fromJSON(this, state);
    if (state.lengthCounter) {
      this.lengthCounter.fromJSON(state.lengthCounter);
    }
  }
}

class NoiseChannel {
  constructor() {
    this.envelope = new ApuEnvelope("noise");
    this.JSON_PROPERTIES = [
      "period",
      "timer",
      "shiftRegister",
      "modeFlag",
      "output",
    ];
    this.reset(false);
  }

  reset(softReset) {
    this.envelope.reset(softReset);
    this.period = NOISE_PERIOD_NTSC[0] - 1;
    this.timer = 0;
    this.shiftRegister = 1;
    this.modeFlag = false;
    this.output = 0;
  }

  setEnabled(enabled) {
    this.envelope.lengthCounter.setEnabled(enabled);
    this.updateOutput();
  }

  updateOutput() {
    if ((this.shiftRegister & 1) === 1) {
      this.output = 0;
    } else {
      this.output = this.envelope.getVolume();
    }
  }

  clockTimer() {
    if (this.timer === 0) {
      this.timer = this.period;
      const bit0 = this.shiftRegister & 1;
      const tap = (this.shiftRegister >> (this.modeFlag ? 6 : 1)) & 1;
      const feedback = bit0 ^ tap;
      this.shiftRegister >>= 1;
      this.shiftRegister |= (feedback << 14);
      this.updateOutput();
    } else {
      this.timer--;
    }
  }

  clockEnvelope() {
    this.envelope.clock();
    this.updateOutput();
  }

  clockLengthCounter() {
    this.envelope.lengthCounter.tick();
    this.updateOutput();
  }

  reloadLengthCounter() {
    this.envelope.lengthCounter.reload();
  }

  writeControl(value) {
    this.envelope.initialize(value);
    this.updateOutput();
  }

  writePeriod(value) {
    this.period = NOISE_PERIOD_NTSC[value & 0x0f] - 1;
    this.modeFlag = (value & 0x80) !== 0;
  }

  writeLength(value) {
    this.envelope.lengthCounter.load((value >> 3) & 0x1f);
    this.envelope.resetEnvelope();
  }

  toJSON() {
    const state = toJSON(this);
    state.envelope = this.envelope.toJSON();
    return state;
  }

  fromJSON(state) {
    if (!state) return;
    fromJSON(this, state);
    if (state.envelope) {
      this.envelope.fromJSON(state.envelope);
    }
    this.updateOutput();
  }
}

class DmcChannel {
  constructor(apu) {
    this.apu = apu;
    this.nes = apu.nes;
    this.JSON_PROPERTIES = [
      "irqEnabled",
      "loopFlag",
      "rateIndex",
      "outputLevel",
      "sampleAddress",
      "sampleLength",
      "currentAddress",
      "bytesRemaining",
      "sampleBuffer",
      "bufferEmpty",
      "shiftRegister",
      "bitsRemaining",
      "silence",
      "timer",
      "enabled",
    ];
    this.reset(false);
  }

  reset(softReset) {
    if (!softReset) {
      this.sampleAddress = 0xc000;
      this.sampleLength = 1;
    }

    this.irqEnabled = false;
    this.loopFlag = false;
    this.rateIndex = 0;
    this.outputLevel = 0;
    this.currentAddress = 0;
    this.bytesRemaining = 0;
    this.sampleBuffer = 0;
    this.bufferEmpty = true;
    this.shiftRegister = 0;
    this.bitsRemaining = 8;
    this.silence = true;
    this.timer = 0;
    this.enabled = false;
    this.setRate(this.rateIndex);
    this.timer = this.timerPeriod;
  }

  setRate(rateIndex) {
    this.rateIndex = rateIndex & 0x0f;
    this.timerPeriod = DMC_PERIOD_NTSC[this.rateIndex] - 1;
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) {
      this.bytesRemaining = 0;
      return;
    }

    if (this.bytesRemaining === 0) {
      this.currentAddress = this.sampleAddress;
      this.bytesRemaining = this.sampleLength;
    }
    if (this.bufferEmpty && this.bytesRemaining > 0) {
      this.fetchSample();
    }
  }

  clockTimer() {
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      if (!this.silence) {
        if (this.shiftRegister & 1) {
          if (this.outputLevel <= 125) this.outputLevel += 2;
        } else {
          if (this.outputLevel >= 2) this.outputLevel -= 2;
        }
      }

      this.shiftRegister >>= 1;
      this.bitsRemaining--;
      if (this.bitsRemaining === 0) {
        this.bitsRemaining = 8;
        if (this.bufferEmpty) {
          this.silence = true;
        } else {
          this.silence = false;
          this.shiftRegister = this.sampleBuffer;
          this.bufferEmpty = true;
        }
      }

      if (this.bufferEmpty && this.bytesRemaining > 0) {
        this.fetchSample();
      }
    } else {
      this.timer--;
    }
  }

  fetchSample() {
    if (!this.nes || !this.nes.cpu) return;
    this.nes.cpu.haltCycles(4);
    const value = this.nes.cpu.cpuRead(this.currentAddress);
    this.sampleBuffer = value & 0xff;
    this.bufferEmpty = false;

    this.currentAddress = (this.currentAddress + 1) & 0xffff;
    if (this.currentAddress === 0) {
      this.currentAddress = 0x8000;
    }

    this.bytesRemaining--;
    if (this.bytesRemaining === 0) {
      if (this.loopFlag) {
        this.currentAddress = this.sampleAddress;
        this.bytesRemaining = this.sampleLength;
      } else if (this.irqEnabled) {
        this.apu.setDmcIrq(true);
      }
    }
  }

  writeControl(value) {
    this.irqEnabled = (value & 0x80) !== 0;
    this.loopFlag = (value & 0x40) !== 0;
    this.setRate(value & 0x0f);
    if (!this.irqEnabled) {
      this.apu.setDmcIrq(false);
    }
  }

  writeDirectLoad(value) {
    this.outputLevel = value & 0x7f;
  }

  writeSampleAddress(value) {
    this.sampleAddress = 0xc000 | ((value & 0xff) << 6);
  }

  writeSampleLength(value) {
    this.sampleLength = ((value & 0xff) << 4) | 0x01;
  }

  getOutput() {
    return this.outputLevel;
  }

  getStatus() {
    return this.bytesRemaining > 0;
  }

  toJSON() {
    return toJSON(this);
  }

  fromJSON(state) {
    if (!state) return;
    fromJSON(this, state);
    this.setRate(this.rateIndex);
  }
}

export class PAPU {
  constructor(nes) {
    this.nes = nes;
    this.square1 = new SquareChannel("square1", true);
    this.square2 = new SquareChannel("square2", false);
    this.triangle = new TriangleChannel();
    this.noise = new NoiseChannel();
    this.dmc = new DmcChannel(this);

    this.expansionSources = new Map();
    this.expansionList = [];

    this.square_table = this.buildSquareTable();
    this.tnd_table = this.buildTndTable();

    this.panning = {
      square1: { l: 0.5, r: 0.5 },
      square2: { l: 0.5, r: 0.5 },
      triangle: { l: 0.5, r: 0.5 },
      noise: { l: 0.5, r: 0.5 },
      dmc: { l: 0.5, r: 0.5 },
      expansion: { l: 0.5, r: 0.5 },
    };

    this.channelMute = {
      square1: false,
      square2: false,
      triangle: false,
      noise: false,
      dmc: false,
      expansion: false,
    };
    this.channelSolo = {
      square1: false,
      square2: false,
      triangle: false,
      noise: false,
      dmc: false,
      expansion: false,
    };
    this.soloActive = false;

    this.sampleRate = nes?.opts?.sampleRate || 44100;
    this.cpuFreq = CPU_FREQ_NTSC;
    this.sampleCycles = this.cpuFreq / this.sampleRate;
    this.sampleCounter = 0;

    this.dcLeft = 0;
    this.dcRight = 0;
    this.dcAlpha = 0.001;
    this.updateDcFilter();

    this.frameCounterMode = 0;
    this.frameCounterStep = 0;
    this.frameCounterCycle = 0;
    this.frameIrqInhibit = false;
    this.frameIrq = false;
    this.dmcIrq = false;
    this.frameCounterDelay = 0;
    this.frameCounterPending = null;

    this.reset();
  }

  buildSquareTable() {
    const table = new Float32Array(31 * 16);
    for (let i = 0; i < table.length; i++) {
      const n = i / 16;
      table[i] = n === 0 ? 0 : 95.52 / (8128.0 / n + 100);
    }
    return table;
  }

  buildTndTable() {
    const max = 203 * 16;
    const table = new Float32Array(max);
    for (let i = 0; i < table.length; i++) {
      const n = i / 16;
      table[i] = n === 0 ? 0 : 163.67 / (24329.0 / n + 100);
    }
    return table;
  }

  updateDcFilter() {
    const cutoff = 10;
    this.dcAlpha = 1 - Math.exp(-2 * Math.PI * cutoff / this.sampleRate);
  }

  reset() {
    this.square1.reset(false);
    this.square2.reset(false);
    this.triangle.reset(false);
    this.noise.reset(false);
    this.dmc.reset(false);

    this.frameCounterMode = 0;
    this.frameCounterStep = 0;
    this.frameCounterCycle = 0;
    this.frameIrqInhibit = false;
    this.frameIrq = false;
    this.dmcIrq = false;
    this.frameCounterDelay = 0;
    this.frameCounterPending = null;

    this.sampleCounter = 0;
    this.dcLeft = 0;
    this.dcRight = 0;
  }

  setSampleRate(rate, resetCounter = true) {
    this.sampleRate = rate || 44100;
    this.sampleCycles = this.cpuFreq / this.sampleRate;
    this.updateDcFilter();
    if (resetCounter) {
      this.sampleCounter = 0;
    }
  }

  setExpansionAudioSource(name, source) {
    if (!name || !source) return;
    this.expansionSources.set(name, source);
    this.expansionList = Array.from(this.expansionSources.values());
  }

  clearExpansionAudioSources() {
    this.expansionSources.clear();
    this.expansionList = [];
  }

  isChannelActive(name) {
    if (this.soloActive) {
      return !!this.channelSolo[name];
    }
    return !this.channelMute[name];
  }

  setChannelMute(name, muted = true) {
    if (!(name in this.channelMute)) return;
    this.channelMute[name] = !!muted;
  }

  setChannelSolo(name, enabled = true) {
    if (!(name in this.channelSolo)) return;
    this.channelSolo[name] = !!enabled;
    this.soloActive = Object.values(this.channelSolo).some(Boolean);
  }

  clearChannelSolo() {
    for (const key of Object.keys(this.channelSolo)) {
      this.channelSolo[key] = false;
    }
    this.soloActive = false;
  }

  resetChannelMix() {
    for (const key of Object.keys(this.channelMute)) {
      this.channelMute[key] = false;
    }
    this.clearChannelSolo();
  }

  setFrameIrq(value) {
    this.frameIrq = !!value;
    if (this.frameIrq && this.nes?.cpu) {
      this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL);
    }
  }

  setDmcIrq(value) {
    this.dmcIrq = !!value;
    if (this.dmcIrq && this.nes?.cpu) {
      this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL);
    }
  }

  clearFrameIrq() {
    if (!this.frameIrq) return;
    this.frameIrq = false;
    if (!this.dmcIrq && this.nes?.cpu) {
      this.nes.cpu.clearIrq(this.nes.cpu.IRQ_NORMAL);
    }
  }

  clearDmcIrq() {
    if (!this.dmcIrq) return;
    this.dmcIrq = false;
    if (!this.frameIrq && this.nes?.cpu) {
      this.nes.cpu.clearIrq(this.nes.cpu.IRQ_NORMAL);
    }
  }

  readReg(addr) {
    if (addr !== 0x4015) return undefined;

    let status = 0;
    status |= this.square1.envelope.lengthCounter.getStatus() ? 0x01 : 0x00;
    status |= this.square2.envelope.lengthCounter.getStatus() ? 0x02 : 0x00;
    status |= this.triangle.lengthCounter.getStatus() ? 0x04 : 0x00;
    status |= this.noise.envelope.lengthCounter.getStatus() ? 0x08 : 0x00;
    status |= this.dmc.getStatus() ? 0x10 : 0x00;
    status |= this.frameIrq ? 0x40 : 0x00;
    status |= this.dmcIrq ? 0x80 : 0x00;

    this.clearFrameIrq();
    return status & 0xff;
  }

  writeReg(addr, value) {
    const val = value & 0xff;
    switch (addr) {
      case 0x4000:
        this.square1.writeControl(val);
        return;
      case 0x4001:
        this.square1.writeSweep(val);
        return;
      case 0x4002:
        this.square1.writeTimerLow(val);
        return;
      case 0x4003:
        this.square1.writeTimerHigh(val);
        return;
      case 0x4004:
        this.square2.writeControl(val);
        return;
      case 0x4005:
        this.square2.writeSweep(val);
        return;
      case 0x4006:
        this.square2.writeTimerLow(val);
        return;
      case 0x4007:
        this.square2.writeTimerHigh(val);
        return;
      case 0x4008:
        this.triangle.writeControl(val);
        return;
      case 0x400a:
        this.triangle.writeTimerLow(val);
        return;
      case 0x400b:
        this.triangle.writeTimerHigh(val);
        return;
      case 0x400c:
        this.noise.writeControl(val);
        return;
      case 0x400e:
        this.noise.writePeriod(val);
        return;
      case 0x400f:
        this.noise.writeLength(val);
        return;
      case 0x4010:
        this.dmc.writeControl(val);
        return;
      case 0x4011:
        this.dmc.writeDirectLoad(val);
        return;
      case 0x4012:
        this.dmc.writeSampleAddress(val);
        return;
      case 0x4013:
        this.dmc.writeSampleLength(val);
        return;
      case 0x4015:
        this.square1.setEnabled((val & 0x01) !== 0);
        this.square2.setEnabled((val & 0x02) !== 0);
        this.triangle.setEnabled((val & 0x04) !== 0);
        this.noise.setEnabled((val & 0x08) !== 0);
        this.dmc.setEnabled((val & 0x10) !== 0);
        this.clearDmcIrq();
        return;
      case 0x4017:
        this.frameCounterPending = val;
        this.frameCounterDelay = (this.nes?.cpu?.cycleCount & 1) ? 4 : 3;
        this.frameIrqInhibit = (val & 0x40) !== 0;
        if (this.frameIrqInhibit) {
          this.clearFrameIrq();
        }
        return;
      default:
        return;
    }
  }

  applyFrameCounter(value) {
    this.frameCounterMode = (value & 0x80) ? 1 : 0;
    this.frameCounterStep = 0;
    this.frameCounterCycle = 0;
    if (this.frameCounterMode === 1) {
      this.clockQuarterFrame();
      this.clockHalfFrame();
      this.reloadLengthCounters();
    }
  }

  clockQuarterFrame() {
    this.square1.clockEnvelope();
    this.square2.clockEnvelope();
    this.triangle.clockLinearCounter();
    this.noise.clockEnvelope();
  }

  clockHalfFrame() {
    this.square1.clockLengthCounter();
    this.square2.clockLengthCounter();
    this.triangle.clockLengthCounter();
    this.noise.clockLengthCounter();
    this.square1.clockSweep();
    this.square2.clockSweep();
  }

  reloadLengthCounters() {
    this.square1.reloadLengthCounter();
    this.square2.reloadLengthCounter();
    this.triangle.reloadLengthCounter();
    this.noise.reloadLengthCounter();
  }

  stepFrameCounter() {
    if (this.frameCounterDelay > 0) {
      this.frameCounterDelay--;
      if (this.frameCounterDelay === 0 && this.frameCounterPending !== null) {
        this.applyFrameCounter(this.frameCounterPending);
        this.frameCounterPending = null;
      }
    }

    this.frameCounterCycle++;
    const mode = this.frameCounterMode ? 5 : 4;
    const steps = FRAME_COUNTER_STEPS_NTSC[mode];
    const step = steps[this.frameCounterStep];
    if (!step) return;

    if (this.frameCounterCycle === step.cycles) {
      if (step.quarter) this.clockQuarterFrame();
      if (step.half) this.clockHalfFrame();
      if (step.quarter || step.half) this.reloadLengthCounters();
      if (step.irq && !this.frameIrqInhibit) {
        this.setFrameIrq(true);
      }
      this.frameCounterStep++;
      if (this.frameCounterStep >= steps.length) {
        this.frameCounterStep = 0;
        this.frameCounterCycle = 0;
      }
    }
  }

  clockFrameCounter(cpuCycles) {
    if (!cpuCycles) return;

    for (let i = 0; i < cpuCycles; i++) {
      this.stepFrameCounter();
      this.square1.clockTimer();
      this.square2.clockTimer();
      this.triangle.clockTimer();
      this.noise.clockTimer();
      this.dmc.clockTimer();

      if (this.expansionList.length) {
        for (const source of this.expansionList) {
          if (source && typeof source.clock === "function") {
            source.clock(1);
          }
        }
      }

      this.sampleCounter += 1;
      if (this.sampleCounter >= this.sampleCycles) {
        this.sampleCounter -= this.sampleCycles;
        this.sample();
      }
    }
  }

  sample() {
    const sq1 = this.isChannelActive("square1") ? this.square1.output : 0;
    const sq2 = this.isChannelActive("square2") ? this.square2.output : 0;
    const tri = this.isChannelActive("triangle") ? this.triangle.getOutput() : 0;
    const noi = this.isChannelActive("noise") ? this.noise.output : 0;
    const dmc = this.isChannelActive("dmc") ? this.dmc.getOutput() : 0;

    const pulseL = (sq1 * this.panning.square1.l) + (sq2 * this.panning.square2.l);
    const pulseR = (sq1 * this.panning.square1.r) + (sq2 * this.panning.square2.r);

    const tndL = (tri * 3 * this.panning.triangle.l) +
      (noi * 2 * this.panning.noise.l) +
      (dmc * this.panning.dmc.l);
    const tndR = (tri * 3 * this.panning.triangle.r) +
      (noi * 2 * this.panning.noise.r) +
      (dmc * this.panning.dmc.r);

    const pulseIndexL = Math.min(this.square_table.length - 1, Math.round(pulseL * 16));
    const pulseIndexR = Math.min(this.square_table.length - 1, Math.round(pulseR * 16));
    const tndIndexL = Math.min(this.tnd_table.length - 1, Math.round(tndL * 16));
    const tndIndexR = Math.min(this.tnd_table.length - 1, Math.round(tndR * 16));

    let sampleL = this.square_table[pulseIndexL] + this.tnd_table[tndIndexL];
    let sampleR = this.square_table[pulseIndexR] + this.tnd_table[tndIndexR];

    if (this.expansionList.length && this.isChannelActive("expansion")) {
      let exp = 0;
      for (const source of this.expansionList) {
        if (source && typeof source.getSample === "function") {
          exp += source.getSample();
        }
      }
      sampleL += exp * this.panning.expansion.l;
      sampleR += exp * this.panning.expansion.r;
    }

    this.dcLeft += (sampleL - this.dcLeft) * this.dcAlpha;
    this.dcRight += (sampleR - this.dcRight) * this.dcAlpha;
    sampleL -= this.dcLeft;
    sampleR -= this.dcRight;

    if (sampleL > 1) sampleL = 1;
    if (sampleL < -1) sampleL = -1;
    if (sampleR > 1) sampleR = 1;
    if (sampleR < -1) sampleR = -1;

    const onSample = this.nes?.opts?.onAudioSample;
    if (typeof onSample === "function") {
      onSample(sampleL, sampleR);
    }
  }

  toJSON() {
    return {
      square1: this.square1.toJSON(),
      square2: this.square2.toJSON(),
      triangle: this.triangle.toJSON(),
      noise: this.noise.toJSON(),
      dmc: this.dmc.toJSON(),
      frameCounterMode: this.frameCounterMode,
      frameCounterStep: this.frameCounterStep,
      frameCounterCycle: this.frameCounterCycle,
      frameIrqInhibit: this.frameIrqInhibit,
      frameIrq: this.frameIrq,
      dmcIrq: this.dmcIrq,
      frameCounterDelay: this.frameCounterDelay,
      frameCounterPending: this.frameCounterPending,
      sampleCounter: this.sampleCounter,
      dcLeft: this.dcLeft,
      dcRight: this.dcRight,
    };
  }

  fromJSON(state) {
    if (!state) return;
    if (state.square1) this.square1.fromJSON(state.square1);
    if (state.square2) this.square2.fromJSON(state.square2);
    if (state.triangle) this.triangle.fromJSON(state.triangle);
    if (state.noise) this.noise.fromJSON(state.noise);
    if (state.dmc) this.dmc.fromJSON(state.dmc);
    this.frameCounterMode = state.frameCounterMode || 0;
    this.frameCounterStep = state.frameCounterStep || 0;
    this.frameCounterCycle = state.frameCounterCycle || 0;
    this.frameIrqInhibit = !!state.frameIrqInhibit;
    this.frameIrq = !!state.frameIrq;
    this.dmcIrq = !!state.dmcIrq;
    this.frameCounterDelay = state.frameCounterDelay || 0;
    this.frameCounterPending = state.frameCounterPending ?? null;
    this.sampleCounter = state.sampleCounter || 0;
    this.dcLeft = state.dcLeft || 0;
    this.dcRight = state.dcRight || 0;
  }
}

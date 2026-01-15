import { CPU } from "./cpu.js";
import { Controller, ROM } from "./index.js";
import { PPU } from "./ppu.js";
import { PAPU } from "./apu.js";
import { PaletteTable } from "./palette-table.js";

export class NES {
  constructor(opts) {
    this.opts = {
      onFrame: function () {},
      onAudioSample: null,
      onStatusUpdate: function () {},
      onBatteryRamWrite: function () {},

      preferredFrameRate: 60,

      emulateSound: true,
      sampleRate: 48000, // Sound sample rate in hz

      // RAM initialization pattern (real NES hardware has undefined/random RAM at power-on)
      // Options: 'all_zero' (Mesen default), 'all_ff', 'random' (Actual hardware-like)
      ramInitPattern: 'random',
    };

    if (typeof opts !== "undefined") {
      for (const key in this.opts) {
        if (typeof opts[key] !== "undefined") {
          this.opts[key] = opts[key];
        }
      }
    }

    this.frameTime = 1000 / this.opts.preferredFrameRate;

    this.ui = {
      writeFrame: this.opts.onFrame,
      updateStatus: this.opts.onStatusUpdate,
    };
    this.cpu = new CPU(this);
    this.ppu = new PPU(this);
    this.palTable = new PaletteTable();
    this.palTable.loadNTSCPalette(); // Load the default palette
    this.papu = new PAPU(this);
    this.mmap = null; // set in loadROM()
    this.rom = null;  // set in loadROM()
    this.controllers = {
      1: new Controller(),
      2: new Controller(),
    };
    this.zapper = { x: 0, y: 0, fired: false };

    this.ui.updateStatus("Ready to load a ROM.");

    this.frame = this.frame.bind(this);
    this.buttonDown = this.buttonDown.bind(this);
    this.buttonUp = this.buttonUp.bind(this);
    this.zapperMove = this.zapperMove.bind(this);
    this.zapperFireDown = this.zapperFireDown.bind(this);
    this.zapperFireUp = this.zapperFireUp.bind(this);

    this.fpsFrameCount = 0;
    this.romData = null;
    this.break = false;
    this.ppuCyclesToSkip = 0;
    this.cpuCyclesToSkip = 0;
    this.ppuCaughtUp = 0;
    this.lastFpsTime = null;
  }

  // Set break to true to stop frame loop.
  stop() {
    this.break = true;
  }

  // Resets the system (Soft Reset)
  reset() {
    if (this.mmap !== null) {
      this.mmap.reset();
    }

    this.cpu.reset();
    // On a real NES, the PPU is NOT reset when the Reset button is pressed.
    // However, for compatibility, we reset the PPU to avoid glitches in games
    // that don't robustly re-initialize it.
    this.ppu.reset(); 
    this.papu.reset();

    this.lastFpsTime = null;
    this.fpsFrameCount = 0;

    this.ppuCyclesToSkip = 0;
    this.cpuCyclesToSkip = 0;
    this.ppuCaughtUp = 0;
    this.break = false;
  }

  // Hard Reset / Power Cycle
  powerOn() {
    if (this.mmap !== null) {
      this.mmap.reset();
    }

    this.cpu.powerOn();
    this.ppu.powerOn();
    this.papu.reset();

    this.lastFpsTime = null;
    this.fpsFrameCount = 0;

    this.ppuCyclesToSkip = 0;
    this.cpuCyclesToSkip = 0;
    this.ppuCaughtUp = 0;
    this.break = false;
  }

  catchUp() {
    const target = this.cpu.cycleOffset || 0;
    if (target > this.ppuCaughtUp) {
      const cycles = target - this.ppuCaughtUp;
      // Interleave PPU steps and Mapper clocks for accuracy (MMC5)
      for (let i = 0; i < cycles; i++) {
        this.ppu.step();
        this.ppu.step();
        this.ppu.step();
        if (this.mmap && this.mmap.cpuClock) this.mmap.cpuClock(1);
      }
      this.ppuCaughtUp = target;
      this.ppuCyclesToSkip += cycles * 3;
      this.cpuCyclesToSkip += cycles;
    }
  }

  frame() {
    const emulateSound = this.opts.emulateSound;
    const cpu = this.cpu;
    const ppu = this.ppu;
    const papu = this.papu;

    ppu.startFrame();

    while (!ppu.frameComplete && !this.break) {
      let cpuCycles = 0;

      this.ppuCaughtUp = 0;
      cpuCycles = cpu.step();

      // Clock APU
      if (emulateSound) {
        papu.clockFrameCounter(cpuCycles);
      }

      // For each CPU cycle, PPU runs 3 cycles
      let ppuCycles = cpuCycles * 3;
      
      while (this.ppuCyclesToSkip > 0 && ppuCycles > 0) {
        this.ppuCyclesToSkip--;
        ppuCycles--;
      }

      for (let i = 0; i < ppuCycles; i++) {
        ppu.step();
      }

      // Clock mapper for cycle-based events (MMC5 PPU state tracking)
      if (this.mmap && this.mmap.cpuClock) {
        if (this.cpuCyclesToSkip > 0) {
          this.cpuCyclesToSkip -= cpuCycles;
        } else {
          this.mmap.cpuClock(cpuCycles);
        }
      }
    }

    this.fpsFrameCount++;
  }

  buttonDown(controller, button) {
    this.controllers[controller].buttonDown(button);
  }

  buttonUp(controller, button) {
    this.controllers[controller].buttonUp(button);
  }

  zapperMove(x, y) {
    this.zapper.x = x;
    this.zapper.y = y;
  }

  zapperFireDown() {
    this.zapper.fired = true;
  }

  zapperFireUp() {
    this.zapper.fired = false;
  }

  getFPS() {
    const now = +new Date();
    let fps = null;
    if (this.lastFpsTime) {
      fps = this.fpsFrameCount / ((now - this.lastFpsTime) / 1000);
    }
    this.fpsFrameCount = 0;
    this.lastFpsTime = now;
    return fps;
  }

  reloadROM() {
    if (this.romData !== null) {
      this.loadROM(this.romData);
    }
  }

  // Loads a ROM file into the CPU and PPU.
  // The ROM file is validated first.
  loadROM(data) {

    // Step 1: Create ROM and parse header/data
    this.rom = new ROM(this);
    this.rom.load(data);

    if (this.papu && this.papu.clearExpansionAudioSources) {
      this.papu.clearExpansionAudioSources();
    }

    // Step 2: Reset CPU/PPU/APU (but NOT mapper - it doesn't exist yet)
    //this.cpu.reset();
    //this.ppu.reset();
    //this.papu.reset();

    // Step 3: Create mapper
    try {
      this.mmap = this.rom.createMapper();
    } catch (e) {
      throw e;
    }

    this.powerOn();

    // Step 4: Load CHR and Initialize Mapper. The mapper's reset() method (called by powerOn) is responsible for setting the initial mirroring.
    this.mmap.loadROM();

    // Step 6: Store for potential reload
    this.romData = data;

    // Reset state
    this.lastFpsTime = null;
    this.fpsFrameCount = 0;
    this.break = false;

    this.ui.updateStatus("ROM loaded. Ready to play.");
  }

  setFramerate(rate) {
    this.opts.preferredFrameRate = rate;
    this.frameTime = 1000 / rate;
    this.papu.setSampleRate(this.opts.sampleRate, false);
  }

  toJSON() {
    return {
      cpu: this.cpu.toJSON(),
      mmap: this.mmap.toJSON(),
      ppu: this.ppu.toJSON(),
      papu: this.papu.toJSON(),
    };
  }

  fromJSON(s) {
    this.cpu.fromJSON(s.cpu);
    this.mmap.fromJSON(s.mmap);
    this.ppu.fromJSON(s.ppu);
    this.papu.fromJSON(s.papu);
  }
}

import { CPU } from "./cpu.js";
import { Controller, ROM } from "./index.js";
import { PPU } from "./ppu.js";
import { PAPU } from "./apu.js";
import { PaletteTable } from "./palette-table.js";

export class NES {
  constructor(opts) {
    this._hasExplicitPreferredFrameRate = !!(opts && typeof opts.preferredFrameRate !== "undefined");

    this.opts = {
      onFrame: function () {},
      onAudioSample: null,
      onStatusUpdate: function () {},
      onBatteryRamWrite: function () {},

      preferredFrameRate: 60,

      emulateSound: true,
      sampleRate: 48000, // Sound sample rate in hz
      // Region selection: "auto" | "ntsc" | "pal" | "dendy"
      region: "auto",

      // RAM initialization pattern (real NES hardware has undefined/random RAM at power-on)
      // Options: 'hardware' (Famicom 00/FF pattern), 'all_zero', 'all_ff', 'random'
      ramInitPattern: 'hardware',
    };

    if (typeof opts !== "undefined") {
      for (const key in this.opts) {
        if (typeof opts[key] !== "undefined") {
          this.opts[key] = opts[key];
        }
      }
    }

    // Normalize init pattern to avoid silent fallbacks from casing/typos.
    const pattern = String(this.opts.ramInitPattern || "hardware").toLowerCase();
    if (pattern === "all_zero" || pattern === "all_ff" || pattern === "random" || pattern === "hardware") {
      this.opts.ramInitPattern = pattern;
    } else {
      this.opts.ramInitPattern = "hardware";
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
    this.lastFpsTime = null;
  }

  getRecommendedFrameRate(region) {
    const normalized = String(region || "ntsc").toLowerCase();
    return (normalized === "pal" || normalized === "dendy") ? 50 : 60;
  }

  applyRegionSettings(region) {
    const resolvedRegion = String(region || "ntsc").toLowerCase();

    if (this.ppu && typeof this.ppu.setRegion === "function") {
      this.ppu.setRegion(resolvedRegion);
    }

    if (!this._hasExplicitPreferredFrameRate) {
      const targetRate = this.getRecommendedFrameRate(resolvedRegion);
      if (this.opts.preferredFrameRate !== targetRate) {
        this.setFramerate(targetRate);
      }
    }
  }

  resolveRegion() {
    const override = (this.opts.region || "auto").toLowerCase();
    if (override === "ntsc" || override === "pal" || override === "dendy") {
      return override;
    }
    if (this.rom && typeof this.rom.getRegionHint === "function") {
      return this.rom.getRegionHint();
    }
    return "ntsc";
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
    this.break = false;
  }

  // Hard Reset / Power Cycle
  powerOn() {
    if (this.mmap !== null) {
      this.mmap.reset();
    }

    // PPU must be powered on BEFORE CPU, because cpu.powerOn() runs 8 startup
    // cycles that clock the PPU. If PPU is reset after, those cycles are lost.
    this.ppu.powerOn();
    this.papu.reset();

    // Reset palette table emphasis to default (no tint)
    if (this.palTable) {
      this.palTable.setEmphasis(0);
    }

    this.cpu.powerOn();

    this.lastFpsTime = null;
    this.fpsFrameCount = 0;
    this.break = false;
  }

  catchUp() {
    // The CPU now internally clocks the PPU and mapper per cycle
    // in its _startCycle() method — no external catch-up needed.
  }

  frame() {
    const emulateSound = this.opts.emulateSound;
    const cpu = this.cpu;
    const ppu = this.ppu;
    const papu = this.papu;

    ppu.startFrame();

    while (!ppu.frameComplete && !this.break) {
      // CPU.step() internally clocks PPU (region-timed) and mapper
      // via _startCycle(), so no external PPU/mapper clocking is needed.
      const cpuCycles = cpu.step();

      // Clock APU
      if (emulateSound) {
        papu.clockFrameCounter(cpuCycles);
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

  // Loads a ROM file into the CPU and PPU. The ROM file is validated first.
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

    // Resolve and apply region before power/reset so timing starts consistent.
    this.applyRegionSettings(this.resolveRegion());

    this.powerOn();

    // Step 4: Load CHR and Initialize Mapper. The mapper's reset() method (called by powerOn) is responsible for setting the initial mirroring.
    this.mmap.loadROM();

    // Step 6: Store for potential reload
    this.romData = data;

    // Reset state
    this.lastFpsTime = null;
    this.fpsFrameCount = 0;
    this.break = false;

    // Boot verification diagnostic — log critical info once at load time
    this._logBootVerification();

    this.ui.updateStatus("ROM loaded. Ready to play.");
  }

  _logBootVerification() {
    const rom = this.rom;
    const mmap = this.mmap;
    const cpu = this.cpu;
    const ppu = this.ppu;

    console.log(`\n=== BOOT VERIFICATION ===`);
    console.log(`ROM: PRG=${rom.romCount}x16KB CHR=${rom.vromCount}x4KB Mapper=${rom.mapperType} (${rom.getMapperName()})`);
    const mirType = rom.getMirroringType();
    const mirLabels = ['Horizontal mirroring (vertical arrangement)', 'Vertical mirroring (horizontal arrangement)', 'Single-screen A', 'Single-screen B', 'Four-screen'];
    console.log(`Mirroring: ${mirLabels[mirType] || '?'} (type=${mirType}, iNES bit0=${rom.mirroring})`);
    if (rom.isNES2) {
      console.log(`NES 2.0: sub=${rom.submapper} prgRam=${rom.prgRamSizeBytes} prgNvRam=${rom.prgNvRamSizeBytes} chrRam=${rom.chrRamSizeBytes} chrNvRam=${rom.chrNvRamSizeBytes}`);
    }

    // Reset vector
    const rvLo = mmap.cpuRead(0xFFFC);
    const rvHi = mmap.cpuRead(0xFFFD);
    const resetVector = (rvHi << 8) | rvLo;
    console.log(`Reset vector: $${resetVector.toString(16).padStart(4, '0')} (CPU.PC=$${cpu.PC.toString(16).padStart(4, '0')})`);

    // First 8 bytes at reset vector (game code)
    const codeBytes = [];
    for (let i = 0; i < 8; i++) {
      const b = mmap.cpuRead((resetVector + i) & 0xFFFF);
      codeBytes.push(b !== undefined ? b.toString(16).padStart(2, '0') : '??');
    }
    console.log(`Code at reset: ${codeBytes.join(' ')}`);

    // CHR data accessibility through mapper
    if (mmap.chrData && mmap.chrData.length > 0) {
      const chrBytes = [];
      for (let i = 0; i < 16; i++) {
        const val = mmap.ppuRead(i, 'bg', null);
        chrBytes.push(val !== null && val !== undefined ? val.toString(16).padStart(2, '0') : 'null');
      }
      const chrNonZero = mmap.chrData.reduce((a, b) => a + (b !== 0 ? 1 : 0), 0);
      console.log(`CHR[0..15] via ppuRead: ${chrBytes.join(' ')}`);
      console.log(`CHR total: ${chrNonZero}/${mmap.chrData.length} non-zero bytes`);
    } else {
      console.log(`CHR: using CHR-RAM (${mmap.usingChrRam ? 'allocated' : 'NOT allocated'})`);
    }

    // PPU state after powerOn
    console.log(`PPU: scanline=${ppu.scanline} cycle=${ppu.cycle} rendering=${ppu.isRenderingEnabled()} mirroring=${ppu.mirroringType}`);

    // CPU RAM sample at addresses games commonly check
    const ramAddrs = [0x00, 0x01, 0x08, 0x10, 0x33, 0x50, 0x80, 0xFF];
    const ramVals = ramAddrs.map(a => `$${a.toString(16).padStart(2, '0')}=${cpu.ram[a].toString(16).padStart(2, '0')}`).join(' ');
    console.log(`RAM: ${ramVals}`);
    console.log(`=========================\n`);
  }

  setFramerate(rate) {
    this.opts.preferredFrameRate = rate;
    this.frameTime = 1000 / rate;
    this.papu.setSampleRate(this.opts.sampleRate, false);
  }

  toJSON() {
    return {
      stateVersion: 3,
      cpu: this.cpu.toJSON(),
      mmap: this.mmap.toJSON(),
      ppu: this.ppu.toJSON(),
      papu: this.papu.toJSON(),
    };
  }

  fromJSON(s) {
    if (!s || s.stateVersion !== 3) {
      throw new Error(`NES save state version not supported (got v${s?.stateVersion}, expected v3)`);
    }

    this.cpu.fromJSON(s.cpu);
    this.mmap.fromJSON(s.mmap);
    this.ppu.fromJSON(s.ppu);
    this.papu.fromJSON(s.papu);

    // Keep frontend pacing in sync with restored PPU region unless user forced a custom rate.
    if (!this._hasExplicitPreferredFrameRate) {
      this.setFramerate(this.getRecommendedFrameRate(this.ppu?.region || "ntsc"));
    }
  }
}

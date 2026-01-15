import { toJSON, fromJSON } from "./utils.js";

// Pre-compute opcode data once at module load
const OPDATA = buildOpData();

export class CPU {
  static IRQ_NORMAL = 0;
  static IRQ_NMI = 1;
  static IRQ_RESET = 2;

  get IRQ_NORMAL() { return CPU.IRQ_NORMAL; }
  get IRQ_NMI() { return CPU.IRQ_NMI; }
  get IRQ_RESET() { return CPU.IRQ_RESET; }

  static JSON_PROPERTIES = [
    "mem", "cyclesToHalt", "irqRequested", "irqType", "REG_ACC", "REG_X",
    "REG_Y", "REG_SP", "REG_PC", "REG_PC_NEW", "REG_STATUS", "F_CARRY",
    "F_DECIMAL", "F_INTERRUPT", "F_INTERRUPT_NEW", "F_OVERFLOW", "F_SIGN",
    "F_ZERO", "F_NOTUSED", "F_NOTUSED_NEW", "F_BRK", "F_BRK_NEW", "cycleCount",
    "dataBus"
  ];

  constructor(nes) {
    this.nes = nes;
    this.cycleCount = 0;  // Total CPU cycles executed (for mapper timing)
    this.mem = new Uint8Array(0x10000);
    this.powerOn();
  }

  powerOn() {
    // On power-on, RAM is undefined. For emulation, we can use a pattern.
    const ramPattern = this.nes.opts.ramInitPattern || 'all_zero';

    switch (ramPattern) {
      case 'all_zero':
        this.mem.fill(0x00, 0, 0x2000);
        break;
      case 'all_ff':
        this.mem.fill(0xFF, 0, 0x2000);
        break;
      case 'random':
        for (let i = 0; i < 0x2000; i++) {
          this.mem[i] = Math.floor(Math.random() * 256);
        }
        break;
    }
    this.reset();
  }

  reset() {
    this.cycleCount = 0;

    // CPU data bus for open bus behavior
    this.dataBus = 0;

    // Track if controllers were read this instruction (for double-read fix)
    this.controller1Read = false;
    this.controller2Read = false;

    this.REG_ACC = 0;
    this.REG_X = 0;
    this.REG_Y = 0;
    this.REG_SP = 0xFD;
    this.REG_PC = 0x8000 - 1;
    this.REG_PC_NEW = 0x8000 - 1;
    this.REG_STATUS = 0x24;

    this.setStatus(0x24);
    this.F_BRK_NEW = this.F_BRK;
    this.F_INTERRUPT_NEW = this.F_INTERRUPT;

    this.cyclesToHalt = 0;
    this.cycleOffset = 0;

    this.irqRequested = true;
    this.irqType = CPU.IRQ_RESET;
    
    this.instructionCount = 0;
  }

  // =================================================================
  // MEMORY MAPPING
  // =================================================================
  cpuRead(addr) {
    let value;

    if (addr < 0x2000) {
      value = this.mem[addr & 0x7FF];
    } else if (addr < 0x4000) {
      const reg = addr & 0x0007;
      this.nes.catchUp();
      value = this.nes.ppu.readRegister(reg);
    } else if (addr < 0x4020) {
      if (addr === 0x4016) {
        value = this.nes.controllers[1].read();
        this.controller1Read = true; // Mark that controller 1 was read this instruction
      } else if (addr === 0x4017) {
        this.nes.catchUp(); // Synchronize PPU for accurate beam detection
        // Controller 2 (D0-D4) + Zapper (D3, D4)
        let ret = this.nes.controllers[2].read();
        this.controller2Read = true; // Mark that controller 2 was read this instruction

        // Zapper Handling
        const zapper = this.nes.zapper;
        let lightDetected = false;

        // Check if beam is at zapper position (with tolerance)
        // Real Zapper has a lens with a radius of ~5-10 pixels
        const ppu = this.nes.ppu;
        const radius = 8;

        // Check if the beam (scanline) is within vertical range of the sensor
        if (ppu.scanline < 240 && Math.abs(ppu.scanline - zapper.y) <= radius) {
            // PPU cycle is incremented at the end of step().
            // renderPixel() uses (cycle - 1) to determine X.
            // So if cycle is C, the last pixel rendered was at C - 2.
            const currentX = ppu.cycle - 2;

            // Check if the beam (dot) is within horizontal range of the sensor
            if (currentX >= 0 && currentX < 256 && Math.abs(currentX - zapper.x) <= radius) {
                // Check brightness of the pixel CURRENTLY being drawn by the beam
                const pixel = ppu.framebuffer[ppu.scanline * 256 + currentX];
                const r = (pixel >> 16) & 0xFF;
                const g = (pixel >> 8) & 0xFF;
                const b = pixel & 0xFF;
                if ((r + g + b) > 500) lightDetected = true; // Brightness threshold
            }
        }

        if (!lightDetected) ret |= 0x08; // Bit 3: 0=Detected, 1=Not Detected
        if (!zapper.fired) ret |= 0x10;  // Bit 4: 0=Pulled, 1=Released

        value = ret;
      } else if (this.nes.papu) {
        value = this.nes.papu.readReg(addr);
        // APU returns undefined for unimplemented registers - use open bus
        if (value === undefined) {
          value = this.dataBus;
        }
      } else {
        // Open bus: return last value on data bus
        value = this.dataBus;
      }
    } else {
      value = this.nes.mmap.cpuRead(addr);
      if (value === undefined) {
        value = this.dataBus;
      }
    }

    // Update data bus latch with the value read
    this.dataBus = value;
    return value;
  }

  cpuRead16bit(addr) {
    // MMC5 needs to know when the NMI vector is read to reset its frame state
    if (addr === 0xFFFA && this.nes.mmap && this.nes.mmap.onNmiVectorRead) {
        this.nes.mmap.onNmiVectorRead();
    }
    return this.cpuRead(addr) | (this.cpuRead(addr + 1) << 8);
  }

  cpuWrite(addr, val) {
    // Update data bus latch on all writes
    this.dataBus = val;

    if (addr === 0x4014 && this.nes && typeof this.nes.recordPpuTraceAccess === 'function') {
      this.nes.recordPpuTraceAccess('WRITE', addr, val, this.REG_PC);
    }

    // RAM $0000-$1FFF (mirrored every $800)
    if (addr < 0x2000) {
      this.mem[addr & 0x7FF] = val;
      return;
    }

    // PPU registers $2000-$3FFF (mirrored every 8 bytes)
    if (addr < 0x4000) {
      const reg = addr & 0x0007;
      this.nes.catchUp();
      this.nes.ppu.writeRegister(reg, val);
      return;
    }

    // APU and I/O $4000-$401F
    if (addr < 0x4020) {
      if (addr === 0x4014) {
        this.nes.catchUp();
        this.nes.ppu.doDMA(val);
        return;
      }
      if (addr === 0x4016) {
        // Pass the value to strobe() so controllers can track strobe state
        this.nes.controllers[1].strobe(val);
        this.nes.controllers[2].strobe(val);
        return;
      }
      if (this.nes.papu) this.nes.papu.writeReg(addr, val);
      return;
    }

    this.nes.catchUp();
    this.nes.mmap.cpuWrite(addr, val);
  }

  // =================================================================
  // CORE EMULATION
  // =================================================================
  step() {
    if (this.cyclesToHalt > 0) {
      this.cyclesToHalt--;
      this.cycleCount++;
      return 1;
    }

    return this.emulate();
  }

  emulate() {
    let temp, add, val;

    if (this.irqRequested) {
      temp = this.F_CARRY | ((this.F_ZERO === 0 ? 1 : 0) << 1) |
        (this.F_INTERRUPT << 2) | (this.F_DECIMAL << 3) |
        (0 << 4) | (this.F_NOTUSED << 5) |
        (this.F_OVERFLOW << 6) | (this.F_SIGN << 7);

      this.REG_PC_NEW = this.REG_PC;
      this.F_INTERRUPT_NEW = this.F_INTERRUPT;

      switch (this.irqType) {
        case 0:
          if (this.F_INTERRUPT !== 0) break;
          this.doIrq(temp);
          break;
        case 1:
          this.doNonMaskableInterrupt(temp);
          break;
        case 2:
          this.doResetInterrupt();
          break;
      }
      this.REG_PC = this.REG_PC_NEW;
      this.F_INTERRUPT = this.F_INTERRUPT_NEW;
      this.F_BRK = this.F_BRK_NEW;

      // Only clear the request flag for edge-triggered (NMI) or one-shot (Reset) interrupts.
      // Level-triggered IRQs (type 0) must remain set until explicitly cleared by the device.
      if (this.irqType !== 0) {
        this.irqRequested = false;
      }
    }

    const mmap = this.nes.mmap;
    if (!mmap) return 32;

    // REG_PC here is treated as the current instruction address
    const opaddr = (this.REG_PC + 1) & 0xffff;
    const opcode = this.cpuRead(opaddr);
    const opinf = OPDATA[opcode];
    if (mmap) {
      if (typeof mmap.recordCpuInstruction === 'function') {
        mmap.recordCpuInstruction(opaddr, opcode);
      }
      if (typeof mmap.recordCpuInstructionHit === 'function') {
        mmap.recordCpuInstructionHit(opaddr, opcode);
      }
    }

    const opSize = (opinf >> 16) & 0xff;

    let cycleCount = opinf >> 24;
    const addrMode = (opinf >> 8) & 0xff;
    this.cycleOffset = cycleCount - 1; // Default offset, adjusted below for page crosses
    this.REG_PC = (this.REG_PC + opSize) & 0xffff;

    let addr = 0;
    let pageCrossCycles = 0;
    switch (addrMode) {
      case 0: addr = this.cpuRead(opaddr + 1); break;                  // ZP
      case 1: { // REL
        const rel = this.cpuRead(opaddr + 1);
        const base = (this.REG_PC + 1) & 0xFFFF; // Base is the address of the instruction AFTER the branch
        addr = base + (rel < 0x80 ? rel : rel - 256);
        break;
      }
      case 2: break;
      case 3: addr = this.cpuRead16bit(opaddr + 1); break;             // ABS
      case 4: addr = this.REG_ACC; break;                              // ACC
      case 5: addr = this.REG_PC; break;                               // IMP (not used)
      case 6: addr = (this.cpuRead(opaddr + 1) + this.REG_X) & 0xff; break; // ZPX
      case 7: addr = (this.cpuRead(opaddr + 1) + this.REG_Y) & 0xff; break; // ZPY
      case 8: // ABSX
        addr = this.cpuRead16bit(opaddr + 1);
        if ((addr & 0xff00) !== ((addr + this.REG_X) & 0xff00)) {
          pageCrossCycles = 1;
          this.cpuRead((addr & 0xff00) | ((addr + this.REG_X) & 0xff));
        }
        addr += this.REG_X;
        break;
      case 9: // ABSY
        addr = this.cpuRead16bit(opaddr + 1);
        if ((addr & 0xff00) !== ((addr + this.REG_Y) & 0xff00)) {
          pageCrossCycles = 1;
          this.cpuRead((addr & 0xff00) | ((addr + this.REG_Y) & 0xff));
        }
        addr += this.REG_Y;
        break;
      case 10: { // PRE-indexed indirect (d,x)
        const ptr = (this.cpuRead(opaddr + 1) + this.REG_X) & 0xff;
        const lo = this.cpuRead(ptr);
        const hi = this.cpuRead((ptr + 1) & 0xff); // Wrap ZP
        addr = lo | (hi << 8);
        break;
      }
      case 11: { // POST-indexed indirect (d),y
        const ptr = this.cpuRead(opaddr + 1);
        const lo = this.cpuRead(ptr);
        const hi = this.cpuRead((ptr + 1) & 0xff); // Wrap ZP
        addr = lo | (hi << 8);
        if ((addr & 0xff00) !== ((addr + this.REG_Y) & 0xff00)) {
          pageCrossCycles = 1;
          this.cpuRead((addr & 0xff00) | ((addr + this.REG_Y) & 0xff));
        }
        addr += this.REG_Y;
        break;
      }
      case 12: 
        addr = this.cpuRead16bit(opaddr + 1);
        const lo = addr;
        const hi = (addr & 0xff00) | ((addr + 1) & 0xff);
        addr = this.cpuRead(lo) | (this.cpuRead(hi) << 8);
        break;
    }
    addr &= 0xffff;

    // Adjust cycle offset for read instructions that cross a page boundary.
    // This ensures the PPU is synchronized to the correct cycle before the read occurs,
    // as the read is delayed by one cycle when a page is crossed.
    const instructionType = opinf & 0xff;
    const readInstructionsWithPenalty = [0, 1, 17, 23, 29, 30, 31, 34, 43, 60]; // ADC, AND, CMP, EOR, LDA, LDX, LDY, ORA, SBC, LAX
    if (pageCrossCycles !== 0 && readInstructionsWithPenalty.includes(instructionType)) {
        this.cycleOffset++;
    }

    let branchCycles = 0;

    switch (instructionType) {
      case 0: val = this.cpuRead(addr); temp = this.REG_ACC + val + this.F_CARRY; this.F_OVERFLOW = ((this.REG_ACC ^ val) & 0x80) === 0 && ((this.REG_ACC ^ temp) & 0x80) !== 0 ? 1 : 0; this.F_CARRY = temp > 255 ? 1 : 0; this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp & 0xff; this.REG_ACC = temp & 0xff; break;
      case 1: this.REG_ACC &= this.cpuRead(addr); this.F_SIGN = (this.REG_ACC >> 7) & 1; this.F_ZERO = this.REG_ACC; break;
      case 2: if (addrMode === 4) { this.F_CARRY = (this.REG_ACC >> 7) & 1; this.REG_ACC = (this.REG_ACC << 1) & 0xff; this.F_SIGN = (this.REG_ACC >> 7) & 1; this.F_ZERO = this.REG_ACC; } else { temp = this.cpuRead(addr); this.cpuWrite(addr, temp); this.F_CARRY = (temp >> 7) & 1; temp = (temp << 1) & 0xff; this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp; this.cpuWrite(addr, temp); } break;
      case 3: if (this.F_CARRY === 0) { branchCycles = ((this.REG_PC + 1) & 0xff00) !== (addr & 0xff00) ? 2 : 1; this.REG_PC = addr - 1; } break;
      case 4: if (this.F_CARRY === 1) { branchCycles = ((this.REG_PC + 1) & 0xff00) !== (addr & 0xff00) ? 2 : 1; this.REG_PC = addr - 1; } break;
      case 5: if (this.F_ZERO === 0) { branchCycles = ((this.REG_PC + 1) & 0xff00) !== (addr & 0xff00) ? 2 : 1; this.REG_PC = addr - 1; } break;
      // BIT
      case 6: temp = this.cpuRead(addr); this.F_SIGN = (temp >> 7) & 1; this.F_OVERFLOW = (temp >> 6) & 1; this.F_ZERO = temp & this.REG_ACC; break;
      case 7: if (this.F_SIGN === 1) { branchCycles = ((this.REG_PC + 1) & 0xff00) !== (addr & 0xff00) ? 2 : 1; this.REG_PC = addr - 1; } break;
      case 8: if (this.F_ZERO !== 0) { branchCycles = ((this.REG_PC + 1) & 0xff00) !== (addr & 0xff00) ? 2 : 1; this.REG_PC = addr - 1; } break;
      case 9: if (this.F_SIGN === 0) { branchCycles = ((this.REG_PC + 1) & 0xff00) !== (addr & 0xff00) ? 2 : 1; this.REG_PC = addr - 1; } break;
      case 10:
        this.REG_PC += 2; // Eats a byte like the real thing
        this.push((this.REG_PC >> 8) & 0xff);
        this.push(this.REG_PC & 0xff);
        this.F_BRK = 1;
        this.push(this.getStatus());
        this.F_INTERRUPT = 1;
        this.REG_PC = this.cpuRead16bit(0xfffe) - 1;
        break;
      case 11: if (this.F_OVERFLOW === 0) { branchCycles = ((this.REG_PC + 1) & 0xff00) !== (addr & 0xff00) ? 2 : 1; this.REG_PC = addr - 1; } break;
      case 12: if (this.F_OVERFLOW === 1) { branchCycles = ((this.REG_PC + 1) & 0xff00) !== (addr & 0xff00) ? 2 : 1; this.REG_PC = addr - 1; } break;
      case 13: this.F_CARRY = 0; break;
      case 14: this.F_DECIMAL = 0; break;
      case 15: this.F_INTERRUPT = 0; break;
      case 16: this.F_OVERFLOW = 0; break;
      case 17: temp = this.REG_ACC - this.cpuRead(addr); this.F_CARRY = temp >= 0 ? 1 : 0; this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp & 0xff; break;
      case 18: temp = this.REG_X - this.cpuRead(addr); this.F_CARRY = temp >= 0 ? 1 : 0; this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp & 0xff; break;
      case 19: temp = this.REG_Y - this.cpuRead(addr); this.F_CARRY = temp >= 0 ? 1 : 0; this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp & 0xff; break;
      case 20: val = this.cpuRead(addr); this.cpuWrite(addr, val); temp = (val - 1) & 0xff; this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp; this.cpuWrite(addr, temp); break;
      case 21: this.REG_X = (this.REG_X - 1) & 0xff; this.F_SIGN = (this.REG_X >> 7) & 1; this.F_ZERO = this.REG_X; break;
      case 22: this.REG_Y = (this.REG_Y - 1) & 0xff; this.F_SIGN = (this.REG_Y >> 7) & 1; this.F_ZERO = this.REG_Y; break;
      case 23: this.REG_ACC = (this.cpuRead(addr) ^ this.REG_ACC) & 0xff; this.F_SIGN = (this.REG_ACC >> 7) & 1; this.F_ZERO = this.REG_ACC; break;
      case 24: val = this.cpuRead(addr); this.cpuWrite(addr, val); temp = (val + 1) & 0xff; this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp; this.cpuWrite(addr, temp); break;
      case 25: this.REG_X = (this.REG_X + 1) & 0xff; this.F_SIGN = (this.REG_X >> 7) & 1; this.F_ZERO = this.REG_X; break;
      case 26: this.REG_Y = (this.REG_Y + 1) & 0xff; this.F_SIGN = (this.REG_Y >> 7) & 1; this.F_ZERO = this.REG_Y; break;
      case 27: this.REG_PC = addr - 1; break;
      case 28:
        const pcToPush = this.REG_PC; // JSR pushes the address of the last byte of the instruction
        this.push((pcToPush >> 8) & 0xff);
        this.push(pcToPush & 0xff);
        this.REG_PC = addr - 1;
        break;
      case 29: this.REG_ACC = this.cpuRead(addr); this.F_SIGN = (this.REG_ACC >> 7) & 1; this.F_ZERO = this.REG_ACC; break;
      case 30: this.REG_X = this.cpuRead(addr); this.F_SIGN = (this.REG_X >> 7) & 1; this.F_ZERO = this.REG_X; break;
      case 31: this.REG_Y = this.cpuRead(addr); this.F_SIGN = (this.REG_Y >> 7) & 1; this.F_ZERO = this.REG_Y; break;
      case 32: if (addrMode === 4) { this.F_CARRY = this.REG_ACC & 1; this.REG_ACC >>= 1; temp = this.REG_ACC; } else { temp = this.cpuRead(addr); this.cpuWrite(addr, temp); this.F_CARRY = temp & 1; temp >>= 1; this.cpuWrite(addr, temp); } this.F_SIGN = 0; this.F_ZERO = temp; break;
      case 33: break;
      case 34: this.REG_ACC = (this.cpuRead(addr) | this.REG_ACC) & 0xff; this.F_SIGN = (this.REG_ACC >> 7) & 1; this.F_ZERO = this.REG_ACC; break;
      case 35: this.push(this.REG_ACC); break;
      case 36: this.push(this.getStatus() | 0x10); break; // PHP pushes with B flag (bit 4) set
      case 37: this.REG_ACC = this.pull(); this.F_SIGN = (this.REG_ACC >> 7) & 1; this.F_ZERO = this.REG_ACC; break;
      case 38: this.setStatus(this.pull()); break;
      case 39: if (addrMode === 4) { temp = this.REG_ACC; add = this.F_CARRY; this.F_CARRY = (temp >> 7) & 1; temp = ((temp << 1) & 0xff) + add; this.REG_ACC = temp; } else { temp = this.cpuRead(addr); this.cpuWrite(addr, temp); add = this.F_CARRY; this.F_CARRY = (temp >> 7) & 1; temp = ((temp << 1) & 0xff) + add; this.cpuWrite(addr, temp); } this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp; break;
      case 40: if (addrMode === 4) { add = this.F_CARRY << 7; this.F_CARRY = this.REG_ACC & 1; temp = (this.REG_ACC >> 1) + add; this.REG_ACC = temp; } else { temp = this.cpuRead(addr); this.cpuWrite(addr, temp); add = this.F_CARRY << 7; this.F_CARRY = temp & 1; temp = (temp >> 1) + add; this.cpuWrite(addr, temp); } this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp; break;
      case 41: {
        const spBefore = this.REG_SP;
        this.setStatus(this.pull());
        this.REG_PC = this.pull();
        this.REG_PC += this.pull() << 8;
        this.inNMI = false; // Clear NMI flag
        this.REG_PC--;
        break;
      }
      case 42: // RTS
        this.REG_PC = this.pull() | (this.pull() << 8);
        break;
      case 43: val = this.cpuRead(addr); temp = this.REG_ACC - val - (1 - this.F_CARRY); this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp & 0xff; this.F_OVERFLOW = ((this.REG_ACC ^ temp) & 0x80) !== 0 && ((this.REG_ACC ^ val) & 0x80) !== 0 ? 1 : 0; this.F_CARRY = temp < 0 ? 0 : 1; this.REG_ACC = temp & 0xff; break;
      case 44: this.F_CARRY = 1; break;
      case 45: this.F_DECIMAL = 1; break;
      case 46: this.F_INTERRUPT = 1; break;
      case 47: this.cpuWrite(addr, this.REG_ACC); break;
      case 48: this.cpuWrite(addr, this.REG_X); break;
      case 49: this.cpuWrite(addr, this.REG_Y); break;
      case 50: this.REG_X = this.REG_ACC; this.F_SIGN = (this.REG_ACC >> 7) & 1; this.F_ZERO = this.REG_ACC; break;
      case 51: this.REG_Y = this.REG_ACC; this.F_SIGN = (this.REG_ACC >> 7) & 1; this.F_ZERO = this.REG_ACC; break;
      case 52: this.REG_X = this.REG_SP & 0xff; this.F_SIGN = (this.REG_SP >> 7) & 1; this.F_ZERO = this.REG_X; break;
      case 53: this.REG_ACC = this.REG_X; this.F_SIGN = (this.REG_X >> 7) & 1; this.F_ZERO = this.REG_X; break;
      case 54: this.REG_SP = this.REG_X & 0xff; break;
      case 55: this.REG_ACC = this.REG_Y; this.F_SIGN = (this.REG_Y >> 7) & 1; this.F_ZERO = this.REG_Y; break;
      
      // Illegal opcodes
      case 56: temp = this.REG_ACC & this.cpuRead(addr); this.F_CARRY = temp & 1; this.REG_ACC = this.F_ZERO = temp >> 1; this.F_SIGN = 0; break;
      case 57: this.REG_ACC = this.F_ZERO = this.REG_ACC & this.cpuRead(addr); this.F_CARRY = this.F_SIGN = (this.REG_ACC >> 7) & 1; break;
      case 58: temp = this.REG_ACC & this.cpuRead(addr); this.REG_ACC = this.F_ZERO = (temp >> 1) + (this.F_CARRY << 7); this.F_SIGN = this.F_CARRY; this.F_CARRY = (temp >> 7) & 1; this.F_OVERFLOW = ((temp >> 7) ^ (temp >> 6)) & 1; break; // Unofficial AXS, not RMW
      case 59: val = this.cpuRead(addr); temp = (this.REG_X & this.REG_ACC) - val; this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp & 0xff; this.F_OVERFLOW = ((this.REG_X ^ temp) & 0x80) !== 0 && ((this.REG_X ^ val) & 0x80) !== 0 ? 1 : 0; this.F_CARRY = temp < 0 ? 0 : 1; this.REG_X = temp & 0xff; break;
      case 60: this.REG_ACC = this.REG_X = this.F_ZERO = this.cpuRead(addr); this.F_SIGN = (this.REG_ACC >> 7) & 1; break;
      case 61: this.cpuWrite(addr, this.REG_ACC & this.REG_X); break;
      case 62: val = this.cpuRead(addr); this.cpuWrite(addr, val); temp = (val - 1) & 0xff; this.cpuWrite(addr, temp); temp = this.REG_ACC - temp; this.F_CARRY = temp >= 0 ? 1 : 0; this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp & 0xff; break; // DCP
      case 63: val = this.cpuRead(addr); this.cpuWrite(addr, val); temp = (val + 1) & 0xff; this.cpuWrite(addr, temp); val = temp; temp = this.REG_ACC - val - (1 - this.F_CARRY); this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp & 0xff; this.F_OVERFLOW = ((this.REG_ACC ^ temp) & 0x80) !== 0 && ((this.REG_ACC ^ val) & 0x80) !== 0 ? 1 : 0; this.F_CARRY = temp < 0 ? 0 : 1; this.REG_ACC = temp & 0xff; break; // ISC
      case 64: val = this.cpuRead(addr); this.cpuWrite(addr, val); add = this.F_CARRY; this.F_CARRY = (val >> 7) & 1; temp = ((val << 1) & 0xff) + add; this.cpuWrite(addr, temp); this.REG_ACC &= temp; this.F_SIGN = (this.REG_ACC >> 7) & 1; this.F_ZERO = this.REG_ACC; break; // RLA
      case 65: val = this.cpuRead(addr); this.cpuWrite(addr, val); add = this.F_CARRY << 7; this.F_CARRY = val & 1; temp = (val >> 1) + add; this.cpuWrite(addr, temp); val = temp; temp = this.REG_ACC + val + this.F_CARRY; this.F_OVERFLOW = ((this.REG_ACC ^ val) & 0x80) === 0 && ((this.REG_ACC ^ temp) & 0x80) !== 0 ? 1 : 0; this.F_CARRY = temp > 255 ? 1 : 0; this.F_SIGN = (temp >> 7) & 1; this.F_ZERO = temp & 0xff; this.REG_ACC = temp & 0xff; break; // RRA
      case 66: val = this.cpuRead(addr); this.cpuWrite(addr, val); this.F_CARRY = (val >> 7) & 1; temp = (val << 1) & 0xff; this.cpuWrite(addr, temp); this.REG_ACC |= temp; this.F_SIGN = (this.REG_ACC >> 7) & 1; this.F_ZERO = this.REG_ACC; break; // SLO
      case 67: val = this.cpuRead(addr); this.cpuWrite(addr, val); this.F_CARRY = val & 1; temp = val >> 1; this.cpuWrite(addr, temp); this.REG_ACC ^= temp; this.F_SIGN = (this.REG_ACC >> 7) & 1; this.F_ZERO = this.REG_ACC; break; // SRE
      case 69: this.cpuRead(addr); break;
      case 68: break;
      default: break;
    }

    // Add page-crossing penalty cycles for specific read instructions
    // Apply page cross penalty for read instructions. The check for addrMode 11 was incorrect.
    if (readInstructionsWithPenalty.includes(instructionType)) {
        cycleCount += pageCrossCycles;
    }

    // Add branch penalty cycles
    cycleCount += branchCycles;

    // Track total cycles for mapper timing
    this.cycleCount += cycleCount;

    // Clock controllers after instruction completes
    // This allows double-reads within the same instruction to get the same value
    this.stepControllers();

    this.instructionCount++;
    return cycleCount;
  }

  stepControllers() {
    // Only clock controllers that were actually read during this instruction
    // This prevents advancing the shift register on every instruction
    if (this.controller1Read) {
      this.nes.controllers[1].clock();
      this.controller1Read = false;
    }
    if (this.controller2Read) {
      this.nes.controllers[2].clock();
      this.controller2Read = false;
    }
  }

  requestIrq(type) {
    if (this.irqRequested && type === CPU.IRQ_NORMAL) return;
    this.irqRequested = true;
    this.irqType = type;
  }

  clearIrq(type) {
    if (this.irqRequested && this.irqType === type) {
      this.irqRequested = false;
    }
  }

  push(value) {
    this.cpuWrite(0x100 | this.REG_SP, value);
    this.REG_SP = (this.REG_SP - 1) & 0xff;
  }

  pull() {
    this.REG_SP = (this.REG_SP + 1) & 0xff;
    return this.cpuRead(0x100 | this.REG_SP);
  }

  haltCycles(cycles) { this.cyclesToHalt += cycles; }

  doNonMaskableInterrupt(status) {
    const nmiVector = this.cpuRead16bit(0xfffa);
    const pcToPush = (this.REG_PC_NEW + 1) & 0xFFFF; // Push the actual PC, not PC-1
    this.push((pcToPush >> 8) & 0xff);
    this.push(pcToPush & 0xff);
    this.push(status);
    this.REG_PC_NEW = nmiVector - 1;
    this.inNMI = true; // Track that we're in NMI handler
    this.F_INTERRUPT_NEW = 1; // NMI disables IRQs
    this.nmiStartInstruction = this.instructionCount;
  }

  doResetInterrupt() {
    const lo = this.cpuRead(0xFFFC);
    const hi = this.cpuRead(0xFFFD);
    const vec = lo | (hi << 8);

    this.REG_PC_NEW = vec - 1;
  }

  doIrq(status) {
    const pcToPush = (this.REG_PC_NEW + 1) & 0xFFFF; // Push the actual PC, not PC-1
    this.push((pcToPush >> 8) & 0xff);
    this.push(pcToPush & 0xff);
    this.push(status);
    this.F_INTERRUPT_NEW = 1;
    this.F_BRK_NEW = 0;
    this.REG_PC_NEW = this.cpuRead16bit(0xfffe) - 1;
  }

  getStatus() {
    // F_ZERO stores the result value (0-255), zero flag is SET when F_ZERO === 0
    const zeroFlag = (this.F_ZERO === 0) ? 1 : 0;
    return this.F_CARRY | (zeroFlag << 1) | (this.F_INTERRUPT << 2) | (this.F_DECIMAL << 3) | (this.F_BRK << 4) | (this.F_NOTUSED << 5) | (this.F_OVERFLOW << 6) | (this.F_SIGN << 7);
  }

  setStatus(st) {
    this.F_CARRY = st & 1;
    // Zero flag bit is 1 when result was zero, so F_ZERO should be 0 when bit is set
    this.F_ZERO = ((st >> 1) & 1) ? 0 : 1;
    this.F_INTERRUPT = (st >> 2) & 1;
    this.F_DECIMAL = (st >> 3) & 1;
    this.F_BRK = (st >> 4) & 1;
    this.F_NOTUSED = 1;
    this.F_OVERFLOW = (st >> 6) & 1;
    this.F_SIGN = (st >> 7) & 1;
  }

  toJSON() {
    const state = {};
    for (let i = 0; i < CPU.JSON_PROPERTIES.length; i++) state[CPU.JSON_PROPERTIES[i]] = this[CPU.JSON_PROPERTIES[i]];
    state.mem = Array.from(this.mem);
    return state;
  }

  fromJSON(s) {
    for (let i = 0; i < CPU.JSON_PROPERTIES.length; i++) this[CPU.JSON_PROPERTIES[i]] = s[CPU.JSON_PROPERTIES[i]];
    this.mem = new Uint8Array(s.mem);
  }
}

function buildOpData() {
  const opdata = new Uint32Array(256);
  const [ZP, REL, IMP, ABS, ACC, IMM, ZPX, ZPY, ABSX, ABSY, PRE, POST, IND] = 
    [0,1,2,3,4,5,6,7,8,9,10,11,12];

  const setOp = (op, inst, addr, size, cycles) => {
    opdata[op] = (inst & 0xff) | ((addr & 0xff) << 8) | ((size & 0xff) << 16) | ((cycles & 0xff) << 24);
  };
  opdata.fill(0xff);

  // ADC (0)
  setOp(0x69, 0, IMM, 2, 2); setOp(0x65, 0, ZP, 2, 3); setOp(0x75, 0, ZPX, 2, 4); setOp(0x6d, 0, ABS, 3, 4);
  setOp(0x7d, 0, ABSX, 3, 4); setOp(0x79, 0, ABSY, 3, 4); setOp(0x61, 0, PRE, 2, 6); setOp(0x71, 0, POST, 2, 5);
  // AND (1)
  setOp(0x29, 1, IMM, 2, 2); setOp(0x25, 1, ZP, 2, 3); setOp(0x35, 1, ZPX, 2, 4); setOp(0x2d, 1, ABS, 3, 4);
  setOp(0x3d, 1, ABSX, 3, 4); setOp(0x39, 1, ABSY, 3, 4); setOp(0x21, 1, PRE, 2, 6); setOp(0x31, 1, POST, 2, 5);
  // ASL (2)
  setOp(0x0a, 2, ACC, 1, 2); setOp(0x06, 2, ZP, 2, 5); setOp(0x16, 2, ZPX, 2, 6); setOp(0x0e, 2, ABS, 3, 6); setOp(0x1e, 2, ABSX, 3, 7);
  // BCC(3)/BCS(4)/BEQ(5)/BIT(6)/BMI(7)/BNE(8)/BPL(9)/BRK(10)
  setOp(0x90, 3, REL, 2, 2); setOp(0xb0, 4, REL, 2, 2); setOp(0xf0, 5, REL, 2, 2); 
  setOp(0x24, 6, ZP, 2, 3); setOp(0x2c, 6, ABS, 3, 4);
  setOp(0x30, 7, REL, 2, 2); setOp(0xd0, 8, REL, 2, 2); setOp(0x10, 9, REL, 2, 2); 
  setOp(0x00, 10, IMP, 1, 7);
  // BVC(11)/BVS(12)/CLC(13)/CLD(14)/CLI(15)/CLV(16)
  setOp(0x50, 11, REL, 2, 2); setOp(0x70, 12, REL, 2, 2);
  setOp(0x18, 13, IMP, 1, 2); setOp(0xd8, 14, IMP, 1, 2); setOp(0x58, 15, IMP, 1, 2); setOp(0xb8, 16, IMP, 1, 2);
  // CMP (17)
  setOp(0xc9, 17, IMM, 2, 2); setOp(0xc5, 17, ZP, 2, 3); setOp(0xd5, 17, ZPX, 2, 4); setOp(0xcd, 17, ABS, 3, 4);
  setOp(0xdd, 17, ABSX, 3, 4); setOp(0xd9, 17, ABSY, 3, 4); setOp(0xc1, 17, PRE, 2, 6); setOp(0xd1, 17, POST, 2, 5);
  // CPX (18) / CPY (19)
  setOp(0xe0, 18, IMM, 2, 2); setOp(0xe4, 18, ZP, 2, 3); setOp(0xec, 18, ABS, 3, 4);
  setOp(0xc0, 19, IMM, 2, 2); setOp(0xc4, 19, ZP, 2, 3); setOp(0xcc, 19, ABS, 3, 4);
  // DEC (20)
  setOp(0xc6, 20, ZP, 2, 5); setOp(0xd6, 20, ZPX, 2, 6); setOp(0xce, 20, ABS, 3, 6); setOp(0xde, 20, ABSX, 3, 7);
  // DEX(21) / DEY(22)
  setOp(0xca, 21, IMP, 1, 2); setOp(0x88, 22, IMP, 1, 2); 
  // EOR (23)
  setOp(0x49, 23, IMM, 2, 2); setOp(0x45, 23, ZP, 2, 3); setOp(0x55, 23, ZPX, 2, 4); setOp(0x4d, 23, ABS, 3, 4);
  setOp(0x5d, 23, ABSX, 3, 4); setOp(0x59, 23, ABSY, 3, 4); setOp(0x41, 23, PRE, 2, 6); setOp(0x51, 23, POST, 2, 5);
  // INC (24)
  setOp(0xe6, 24, ZP, 2, 5); setOp(0xf6, 24, ZPX, 2, 6); setOp(0xee, 24, ABS, 3, 6); setOp(0xfe, 24, ABSX, 3, 7);
  // INX(25) / INY(26)
  setOp(0xe8, 25, IMP, 1, 2); setOp(0xc8, 26, IMP, 1, 2); 
  // JMP (27)
  setOp(0x4c, 27, ABS, 3, 3); setOp(0x6c, 27, IND, 3, 5); 
  // JSR (28)
  setOp(0x20, 28, ABS, 3, 6);
  // LDA (29)
  setOp(0xa9, 29, IMM, 2, 2); setOp(0xa5, 29, ZP, 2, 3); setOp(0xb5, 29, ZPX, 2, 4); setOp(0xad, 29, ABS, 3, 4);
  setOp(0xbd, 29, ABSX, 3, 4); setOp(0xb9, 29, ABSY, 3, 4); setOp(0xa1, 29, PRE, 2, 6); setOp(0xb1, 29, POST, 2, 5);
  // LDX (30)
  setOp(0xa2, 30, IMM, 2, 2); setOp(0xa6, 30, ZP, 2, 3); setOp(0xb6, 30, ZPY, 2, 4); setOp(0xae, 30, ABS, 3, 4); setOp(0xbe, 30, ABSY, 3, 4);
  // LDY (31)
  setOp(0xa0, 31, IMM, 2, 2); setOp(0xa4, 31, ZP, 2, 3); setOp(0xb4, 31, ZPX, 2, 4); setOp(0xac, 31, ABS, 3, 4); setOp(0xbc, 31, ABSX, 3, 4);
  // LSR (32)
  setOp(0x4a, 32, ACC, 1, 2); setOp(0x46, 32, ZP, 2, 5); setOp(0x56, 32, ZPX, 2, 6); setOp(0x4e, 32, ABS, 3, 6); setOp(0x5e, 32, ABSX, 3, 7);
  // NOP (33)
  [0x1a,0x3a,0x5a,0x7a,0xda,0xea,0xfa].forEach(op => setOp(op, 33, IMP, 1, 2));
  // ORA (34)
  setOp(0x09, 34, IMM, 2, 2); setOp(0x05, 34, ZP, 2, 3); setOp(0x15, 34, ZPX, 2, 4); setOp(0x0d, 34, ABS, 3, 4);
  setOp(0x1d, 34, ABSX, 3, 4); setOp(0x19, 34, ABSY, 3, 4); setOp(0x01, 34, PRE, 2, 6); setOp(0x11, 34, POST, 2, 5);
  // PHA(35)/PHP(36)/PLA(37)/PLP(38)
  setOp(0x48, 35, IMP, 1, 3); setOp(0x08, 36, IMP, 1, 3); setOp(0x68, 37, IMP, 1, 4); setOp(0x28, 38, IMP, 1, 4);
  // ROL (39)
  setOp(0x2a, 39, ACC, 1, 2); setOp(0x26, 39, ZP, 2, 5); setOp(0x36, 39, ZPX, 2, 6); setOp(0x2e, 39, ABS, 3, 6); setOp(0x3e, 39, ABSX, 3, 7);
  // ROR (40)
  setOp(0x6a, 40, ACC, 1, 2); setOp(0x66, 40, ZP, 2, 5); setOp(0x76, 40, ZPX, 2, 6); setOp(0x6e, 40, ABS, 3, 6); setOp(0x7e, 40, ABSX, 3, 7);
  // RTI(41)/RTS(42)
  setOp(0x40, 41, IMP, 1, 6); setOp(0x60, 42, IMP, 1, 6);
  // SBC (43)
  setOp(0xe9, 43, IMM, 2, 2); setOp(0xe5, 43, ZP, 2, 3); setOp(0xf5, 43, ZPX, 2, 4); setOp(0xed, 43, ABS, 3, 4);
  setOp(0xfd, 43, ABSX, 3, 4); setOp(0xf9, 43, ABSY, 3, 4); setOp(0xe1, 43, PRE, 2, 6); setOp(0xf1, 43, POST, 2, 5);
  // SEC(44)/SED(45)/SEI(46)
  setOp(0x38, 44, IMP, 1, 2); setOp(0xf8, 45, IMP, 1, 2); setOp(0x78, 46, IMP, 1, 2);
  // STA (47)
  setOp(0x85, 47, ZP, 2, 3); setOp(0x95, 47, ZPX, 2, 4); setOp(0x8d, 47, ABS, 3, 4); setOp(0x9d, 47, ABSX, 3, 5);
  setOp(0x99, 47, ABSY, 3, 5); setOp(0x81, 47, PRE, 2, 6); setOp(0x91, 47, POST, 2, 6);
  // STX (48) / STY (49)
  setOp(0x86, 48, ZP, 2, 3); setOp(0x96, 48, ZPY, 2, 4); setOp(0x8e, 48, ABS, 3, 4);
  setOp(0x84, 49, ZP, 2, 3); setOp(0x94, 49, ZPX, 2, 4); setOp(0x8c, 49, ABS, 3, 4);
  // TAX(50)/TAY(51)/TSX(52)/TXA(53)/TXS(54)/TYA(55)
  setOp(0xaa, 50, IMP, 1, 2); setOp(0xa8, 51, IMP, 1, 2); setOp(0xba, 52, IMP, 1, 2);
  setOp(0x8a, 53, IMP, 1, 2); setOp(0x9a, 54, IMP, 1, 2); setOp(0x98, 55, IMP, 1, 2);
  
  // Illegal opcodes
  [0x4b, 0x0b, 0x2b, 0x6b, 0xcb].forEach(op => setOp(op, 56, IMM, 2, 2));
  setOp(0xa3, 57, PRE, 2, 6); setOp(0xa7, 57, ZP, 2, 3); setOp(0xaf, 57, ABS, 3, 4); setOp(0xb3, 57, POST, 2, 5); setOp(0xb7, 57, ZPY, 2, 4); setOp(0xbf, 57, ABSY, 3, 4);
  setOp(0x83, 58, PRE, 2, 6); setOp(0x87, 58, ZP, 2, 3); setOp(0x8f, 58, ABS, 3, 4); setOp(0x97, 58, ZPY, 2, 4);
  setOp(0xc3, 59, PRE, 2, 8); setOp(0xc7, 59, ZP, 2, 5); setOp(0xcf, 59, ABS, 3, 6); setOp(0xd3, 59, POST, 2, 8); setOp(0xd7, 59, ZPX, 2, 6); setOp(0xdb, 59, ABSY, 3, 7); setOp(0xdf, 59, ABSX, 3, 7);
  setOp(0xe3, 60, PRE, 2, 8); setOp(0xe7, 60, ZP, 2, 5); setOp(0xef, 60, ABS, 3, 6); setOp(0xf3, 60, POST, 2, 8); setOp(0xf7, 60, ZPX, 2, 6); setOp(0xfb, 60, ABSY, 3, 7); setOp(0xff, 60, ABSX, 3, 7);
  setOp(0x23, 61, PRE, 2, 8); setOp(0x27, 61, ZP, 2, 5); setOp(0x2f, 61, ABS, 3, 6); setOp(0x33, 61, POST, 2, 8); setOp(0x37, 61, ZPX, 2, 6); setOp(0x3b, 61, ABSY, 3, 7); setOp(0x3f, 61, ABSX, 3, 7);
  setOp(0x63, 62, PRE, 2, 8); setOp(0x67, 62, ZP, 2, 5); setOp(0x6f, 62, ABS, 3, 6); setOp(0x73, 62, POST, 2, 8); setOp(0x77, 62, ZPX, 2, 6); setOp(0x7b, 62, ABSY, 3, 7); setOp(0x7f, 62, ABSX, 3, 7);
  setOp(0x03, 63, PRE, 2, 8); setOp(0x07, 63, ZP, 2, 5); setOp(0x0f, 63, ABS, 3, 6); setOp(0x13, 63, POST, 2, 8); setOp(0x17, 63, ZPX, 2, 6); setOp(0x1b, 63, ABSY, 3, 7); setOp(0x1f, 63, ABSX, 3, 7);
  setOp(0x43, 64, PRE, 2, 8); setOp(0x47, 64, ZP, 2, 5); setOp(0x4f, 64, ABS, 3, 6); setOp(0x53, 64, POST, 2, 8); setOp(0x57, 64, ZPX, 2, 6); setOp(0x5b, 64, ABSY, 3, 7); setOp(0x5f, 64, ABSX, 3, 7);
  [0x80, 0x82, 0x89, 0xc2, 0xe2].forEach(op => setOp(op, 68, IMM, 2, 2));
  [0x0c, 0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc].forEach(op => setOp(op, 69, ABSX, 3, 4));
  [0x04, 0x44, 0x64].forEach(op => setOp(op, 69, ZP, 2, 3));
  [0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4].forEach(op => setOp(op, 69, ZPX, 2, 4));

  // Default any undefined/illegal opcode to NOP (size 1, 2 cycles) to keep PC in sync
  for (let op = 0; op < 256; op++) {
    if (opdata[op] === 0xff) {
      setOp(op, 33, IMP, 1, 2); // NOP implied
    }
  }
  return opdata;
}

// ============================================================================
// NES CPU (2A03 / 6502-derived)
// Mesen-aligned baseline with mapper-agnostic CPU core + required hook points
// ============================================================================

const FLAG_CARRY = 0x01;
const FLAG_ZERO = 0x02;
const FLAG_INTERRUPT = 0x04;
const FLAG_DECIMAL = 0x08;
const FLAG_BREAK = 0x10;
const FLAG_RESERVED = 0x20;
const FLAG_OVERFLOW = 0x40;
const FLAG_NEGATIVE = 0x80;

const RESET_VECTOR = 0xFFFC;
const NMI_VECTOR = 0xFFFA;
const IRQ_VECTOR = 0xFFFE;

const AM = {
  None: 0,
  Acc: 1,
  Imp: 2,
  Imm: 3,
  Rel: 4,
  Zero: 5,
  ZeroX: 6,
  ZeroY: 7,
  Ind: 8,
  IndX: 9,
  IndY: 10,
  IndYW: 11,
  Abs: 12,
  AbsX: 13,
  AbsXW: 14,
  AbsY: 15,
  AbsYW: 16,
  Other: 17,
};

export class CPU {
  constructor(nes) {
    this.nes = nes;

    // Public RAM view used by diagnostics.
    this.ram = new Uint8Array(0x800);

    // Debug compatibility mirror (legacy tools probe cpu.mem directly).
    this.mem = new Uint8Array(0x10000);

    // Registers
    this.A = 0;
    this.X = 0;
    this.Y = 0;
    this.SP = 0xFD;
    this.P = FLAG_INTERRUPT;
    this.PC = 0;

    // Bus/open-bus latch
    this.dataBus = 0;

    // Interrupt lines/state
    this.nmiFlag = false;
    this.irqFlag = 0;
    this.irqMask = 0xFF;

    this.prevRunIrq = false;
    this.runIrq = false;
    this.prevNmiFlag = false;
    this.prevNeedNmi = false;
    this.needNmi = false;

    // Cycle accounting
    this.cycleCount = 0;
    this.cycleOffset = 0;
    this.cyclesThisStep = 0;

    // Mesen-style clock divider metadata (kept for compatibility/debug)
    this.startClockCount = 6;
    this.endClockCount = 6;
    this.ppuOffset = 0;

    // Instruction decode state
    this.instAddrMode = AM.None;
    this.operand = 0;

    // DMA / halt state
    this.cyclesToHalt = 0;

    // Bus access mode marker (debug-friendly)
    this.cpuWrite = false;

    // IRQ constants exposed for APU/PPU integration.
    this.IRQ_NMI = 1;
    this.IRQ_NORMAL = 2;
    this.IRQ_DMC = 4;
    this.IRQ_EXTERNAL = 8;

    this.opTable = this._buildOpTable();
    this.addrModeTable = this._buildAddrModeTable();

    // Initialize deterministic RAM pattern once; reset/powerOn control CPU state.
    this._initRam();
  }

  // ===========================================================================
  // RESET / POWER
  // ===========================================================================

  _resolveRegion() {
    if (this.nes && this.nes.ppu && this.nes.ppu.region) {
      return String(this.nes.ppu.region).toLowerCase();
    }
    return "ntsc";
  }

  _setMasterClockDivider(region) {
    const normalized = String(region || "ntsc").toLowerCase();

    if (normalized === "pal") {
      this.startClockCount = 8;
      this.endClockCount = 8;
    } else if (normalized === "dendy") {
      this.startClockCount = 7;
      this.endClockCount = 8;
    } else {
      this.startClockCount = 6;
      this.endClockCount = 6;
    }
  }

  _initRam() {
    const pattern = this.nes && this.nes.opts ? this.nes.opts.ramInitPattern : "hardware";

    if (pattern === "all_ff") {
      this.ram.fill(0xFF);
      return;
    }

    if (pattern === "all_zero") {
      this.ram.fill(0x00);
      return;
    }

    if (pattern === "random") {
      for (let i = 0; i < this.ram.length; i++) {
        this.ram[i] = (Math.random() * 256) | 0;
      }
      return;
    }

    // Hardware-like repeating pattern.
    for (let i = 0; i < this.ram.length; i++) {
      this.ram[i] = ((i & 1) ^ ((i >> 3) & 1)) ? 0xFF : 0x00;
    }
  }

  _resetInternalState() {
    this.nmiFlag = false;
    this.irqFlag = 0;

    this.prevRunIrq = false;
    this.runIrq = false;
    this.prevNmiFlag = false;
    this.prevNeedNmi = false;
    this.needNmi = false;

    this.cyclesToHalt = 0;
    this.cpuWrite = false;

    this.instAddrMode = AM.None;
    this.operand = 0;
  }

  _setResetVector() {
    const lo = this._rawRead(RESET_VECTOR);
    const hi = this._rawRead((RESET_VECTOR + 1) & 0xFFFF);
    this.PC = (lo | (hi << 8)) & 0xFFFF;
  }

  _startupDelayCycles() {
    // Mesen: 8 startup cycles before normal instruction fetch.
    for (let i = 0; i < 8; i++) {
      this._startCycle(true);
      this._endCycle(true);
    }
  }

  powerOn() {
    this._initRam();
    this._resetInternalState();

    this.A = 0;
    this.X = 0;
    this.Y = 0;
    this.SP = 0xFD;
    this.P = FLAG_INTERRUPT;

    this.irqMask = 0xFF;

    this._setMasterClockDivider(this._resolveRegion());

    // Mesen starts cycle counter at -1 before startup cycles.
    this.cycleCount = -1;
    this.cycleOffset = 0;
    this.cyclesThisStep = 0;

    this._setResetVector();
    this._startupDelayCycles();
  }

  // Soft reset (NES reset button behavior)
  reset() {
    this._resetInternalState();

    // Soft reset keeps A/X/Y, sets I, and decrements SP by 3.
    this._setFlags(FLAG_INTERRUPT);
    this.SP = (this.SP - 3) & 0xFF;

    this._setMasterClockDivider(this._resolveRegion());

    this._setResetVector();
    this._startupDelayCycles();
  }

  // ===========================================================================
  // IRQ/NMI INTERFACE
  // ===========================================================================

  requestIrq(type) {
    const irqType = (type | 0) & 0xFF;
    if (irqType === this.IRQ_NMI || irqType === 1) {
      this.nmiFlag = true;
    } else {
      this.irqFlag = (this.irqFlag | irqType) & 0xFF;
    }
  }

  clearIrq(type) {
    const irqType = (type | 0) & 0xFF;
    if (irqType === this.IRQ_NMI || irqType === 1) {
      this.nmiFlag = false;
    } else {
      this.irqFlag = (this.irqFlag & (~irqType)) & 0xFF;
    }
  }

  setNmiFlag() {
    this.nmiFlag = true;
  }

  clearNmiFlag() {
    this.nmiFlag = false;
  }

  setIrqMask(mask) {
    this.irqMask = mask & 0xFF;
  }

  setIrqSource(source) {
    this.irqFlag = (this.irqFlag | (source & 0xFF)) & 0xFF;
  }

  clearIrqSource(source) {
    this.irqFlag = (this.irqFlag & (~source)) & 0xFF;
  }

  hasIrqSource(source) {
    return (this.irqFlag & (source & 0xFF)) !== 0;
  }

  // ===========================================================================
  // CYCLE PIPELINE
  // ===========================================================================

  _clockPpuFromCpuCycle() {
    const ppu = this.nes ? this.nes.ppu : null;
    if (!ppu) {
      return;
    }

    if (typeof ppu.clockCpuCycle === "function") {
      ppu.clockCpuCycle();
    } else if (typeof ppu.step === "function") {
      // Legacy fallback
      ppu.step();
      ppu.step();
      ppu.step();
    }
  }

  _clockMapperFromCpuCycle() {
    const mapper = this.nes ? this.nes.mmap : null;
    if (!mapper) {
      return;
    }

    if (typeof mapper.step === "function") {
      mapper.step(1);
    }

    if (typeof mapper.cpuClock === "function") {
      mapper.cpuClock(1);
    }
  }

  _startCycle(forRead = true) {
    this.cycleCount++;
    this.cycleOffset++;

    this._clockPpuFromCpuCycle();
    this._clockMapperFromCpuCycle();
  }

  _endCycle(forRead = true) {
    // NMI edge detector (sampled at end of each cycle)
    this.prevNeedNmi = this.needNmi;

    if (!this.prevNmiFlag && this.nmiFlag) {
      this.needNmi = true;
    }
    this.prevNmiFlag = this.nmiFlag;

    // IRQ level detection
    this.prevRunIrq = this.runIrq;
    this.runIrq = ((this.irqFlag & this.irqMask) !== 0) && !this._checkFlag(FLAG_INTERRUPT);
  }

  haltCycles(n) {
    this.cyclesToHalt += (n | 0);
  }

  _consumeHaltCycles() {
    while (this.cyclesToHalt > 0) {
      this.cyclesToHalt--;
      this._startCycle(true);
      this._endCycle(true);
    }
  }

  _processPendingDma(readAddress = 0, opType = 0) {
    // Mesen handles sprite/DMC DMA interleaving here.
    // In this emulator, DMA uses haltCycles() + direct transfers (PPU/APU side).
  }

  // ===========================================================================
  // BUS ACCESS
  // ===========================================================================

  _rawRead(addr) {
    return this._read(addr & 0xFFFF);
  }

  cpuRead(addr) {
    return this._read(addr & 0xFFFF);
  }

  cpuWrite(addr, value) {
    this._write(addr & 0xFFFF, value & 0xFF);
  }

  memoryRead(addr, opType = 0) {
    const effectiveAddr = addr & 0xFFFF;

    this._processPendingDma(effectiveAddr, opType);

    this._startCycle(true);
    const value = this._read(effectiveAddr);
    this._endCycle(true);

    return value & 0xFF;
  }

  memoryWrite(addr, value, opType = 0) {
    const effectiveAddr = addr & 0xFFFF;
    const writeValue = value & 0xFF;

    this.cpuWrite = true;
    this._startCycle(false);
    this._write(effectiveAddr, writeValue);
    this._endCycle(false);
    this.cpuWrite = false;
  }

  _read(addr) {
    const address = addr & 0xFFFF;
    let value;

    if (address < 0x2000) {
      value = this.ram[address & 0x07FF];
      this.dataBus = value & 0xFF;
      this.mem[address] = this.dataBus;
      return this.dataBus;
    }

    if (address < 0x4000) {
      value = this.nes && this.nes.ppu ? this.nes.ppu.readRegister(address & 0x07) : this.dataBus;
      this.dataBus = (value === undefined || value === null) ? this.dataBus : (value & 0xFF);
      this.mem[address] = this.dataBus;
      return this.dataBus;
    }

    if (address < 0x4018) {
      value = this._readIORegister(address);
      this.dataBus = (value === undefined || value === null) ? this.dataBus : (value & 0xFF);
      this.mem[address] = this.dataBus;
      return this.dataBus;
    }

    if (address < 0x6000) {
      if (this.nes && this.nes.mmap && typeof this.nes.mmap.cpuRead === "function") {
        value = this.nes.mmap.cpuRead(address);
        if (value !== undefined && value !== null) {
          this.dataBus = value & 0xFF;
          this.mem[address] = this.dataBus;
          return this.dataBus;
        }
      }
      this.mem[address] = this.dataBus;
      return this.dataBus;
    }

    if (this.nes && this.nes.mmap && typeof this.nes.mmap.cpuRead === "function") {
      value = this.nes.mmap.cpuRead(address);
      if (value !== undefined && value !== null) {
        this.dataBus = value & 0xFF;
        this.mem[address] = this.dataBus;
        return this.dataBus;
      }
    }

    this.mem[address] = this.dataBus;
    return this.dataBus;
  }

  _write(addr, value) {
    const address = addr & 0xFFFF;
    const writeValue = value & 0xFF;

    this.dataBus = writeValue;
    this.mem[address] = writeValue;

    if (address < 0x2000) {
      this.ram[address & 0x07FF] = writeValue;
      return;
    }

    if (address < 0x4000) {
      if (this.nes && this.nes.ppu) {
        this.nes.ppu.writeRegister(address & 0x07, writeValue);
      }
      return;
    }

    if (address < 0x4018) {
      this._writeIORegister(address, writeValue);
      return;
    }

    if (this.nes && this.nes.mmap && typeof this.nes.mmap.cpuWrite === "function") {
      this.nes.mmap.cpuWrite(address, writeValue);
    }
  }

  _readIORegister(addr) {
    const address = addr & 0xFFFF;

    switch (address) {
      case 0x4015:
        if (this.nes && this.nes.papu && typeof this.nes.papu.readReg === "function") {
          const value = this.nes.papu.readReg(address);
          if (value !== undefined && value !== null) {
            return value & 0xFF;
          }
        }
        return this.dataBus;

      case 0x4016: {
        if (this.nes && this.nes.controllers && this.nes.controllers[1]) {
          const value = this.nes.controllers[1].read() & 0xFF;
          this.nes.controllers[1].clock();
          return value;
        }
        return this.dataBus;
      }

      case 0x4017: {
        if (this.nes && this.nes.controllers && this.nes.controllers[2]) {
          const value = this.nes.controllers[2].read() & 0xFF;
          this.nes.controllers[2].clock();
          return value;
        }
        return this.dataBus;
      }

      default:
        return this.dataBus;
    }
  }

  _writeIORegister(addr, value) {
    const address = addr & 0xFFFF;
    const writeValue = value & 0xFF;

    switch (address) {
      case 0x4014:
        this._runSpriteDma(writeValue);
        return;

      case 0x4016:
        if (this.nes && this.nes.controllers) {
          this.nes.controllers[1].strobe(writeValue);
          this.nes.controllers[2].strobe(writeValue);
        }
        return;

      default:
        if (this.nes && this.nes.papu && typeof this.nes.papu.writeReg === "function") {
          this.nes.papu.writeReg(address, writeValue);
        }
        return;
    }
  }

  _runSpriteDma(page) {
    if (this.nes && this.nes.ppu && typeof this.nes.ppu.doDMA === "function") {
      this.nes.ppu.doDMA(page & 0xFF);
    }
  }

  // ===========================================================================
  // EXECUTION
  // ===========================================================================

  step() {
    const startCycles = this.cycleCount;
    this.cycleOffset = 0;

    this._consumeHaltCycles();
    this._exec();

    this.cyclesThisStep = this.cycleCount - startCycles;
    return this.cyclesThisStep;
  }

  _exec() {
    const opcode = this._getOpcode();
    this.instAddrMode = this.addrModeTable[opcode];
    this.operand = this._fetchOperand(this.instAddrMode);

    this.opTable[opcode].call(this);

    if (this.prevRunIrq || this.prevNeedNmi) {
      this._IRQ();
    }
  }

  _IRQ() {
    // PAL does a DMA poll at interrupt sequence start.
    if (this._resolveRegion() === "pal") {
      this._processPendingDma(this.PC, 0);
    }

    this._dummyRead();
    this._dummyRead();
    this._pushWord(this.PC);

    if (this.needNmi) {
      this.needNmi = false;
      this._push((this.P | FLAG_RESERVED) & 0xFF);
      this._setFlags(FLAG_INTERRUPT);
      this.PC = this._memoryReadWord(NMI_VECTOR) & 0xFFFF;
    } else {
      this._push((this.P | FLAG_RESERVED) & 0xFF);
      this._setFlags(FLAG_INTERRUPT);
      this.PC = this._memoryReadWord(IRQ_VECTOR) & 0xFFFF;
    }
  }

  // ===========================================================================
  // FETCH / DECODE HELPERS
  // ===========================================================================

  _getOpcode() {
    const opcode = this.memoryRead(this.PC) & 0xFF;
    this.PC = (this.PC + 1) & 0xFFFF;
    return opcode;
  }

  _dummyRead() {
    this.memoryRead(this.PC);
  }

  _readByte() {
    const value = this.memoryRead(this.PC) & 0xFF;
    this.PC = (this.PC + 1) & 0xFFFF;
    return value;
  }

  _readWord() {
    const lo = this._readByte();
    const hi = this._readByte();
    return ((hi << 8) | lo) & 0xFFFF;
  }

  _memoryReadWord(addr) {
    const lo = this.memoryRead(addr & 0xFFFF) & 0xFF;
    const hi = this.memoryRead((addr + 1) & 0xFFFF) & 0xFF;
    return ((hi << 8) | lo) & 0xFFFF;
  }

  _clearFlags(flags) {
    this.P = (this.P & (~flags)) & 0xFF;
  }

  _setFlags(flags) {
    this.P = (this.P | flags) & 0xFF;
  }

  _checkFlag(flag) {
    return (this.P & flag) === flag;
  }

  _setPS(value) {
    // Mesen clears B and R bits when restoring P from stack/state.
    this.P = (value & 0xCF) & 0xFF;
  }

  _setZeroNegativeFlags(value) {
    const v = value & 0xFF;
    if (v === 0) {
      this._setFlags(FLAG_ZERO);
    } else if ((v & 0x80) !== 0) {
      this._setFlags(FLAG_NEGATIVE);
    }
  }

  _setRegister(registerName, value) {
    const v = value & 0xFF;
    this._clearFlags(FLAG_ZERO | FLAG_NEGATIVE);
    this._setZeroNegativeFlags(v);
    this[registerName] = v;
  }

  _setA(value) {
    this._setRegister("A", value);
  }

  _setX(value) {
    this._setRegister("X", value);
  }

  _setY(value) {
    this._setRegister("Y", value);
  }

  _checkPageCrossedSigned(a, b) {
    return (((a + b) & 0xFF00) !== (a & 0xFF00));
  }

  _checkPageCrossedUnsigned(a, b) {
    return (((a + (b & 0xFF)) & 0xFF00) !== (a & 0xFF00));
  }

  _push(value) {
    this.memoryWrite((this.SP + 0x100) & 0x1FF, value & 0xFF);
    this.SP = (this.SP - 1) & 0xFF;
  }

  _pushWord(value) {
    const word = value & 0xFFFF;
    this._push((word >> 8) & 0xFF);
    this._push(word & 0xFF);
  }

  _pop() {
    this.SP = (this.SP + 1) & 0xFF;
    return this.memoryRead((0x100 + this.SP) & 0x1FF) & 0xFF;
  }

  _popWord() {
    const lo = this._pop();
    const hi = this._pop();
    return ((hi << 8) | lo) & 0xFFFF;
  }

  _getOperandValue() {
    if (this.instAddrMode >= AM.Zero) {
      return this.memoryRead(this.operand & 0xFFFF) & 0xFF;
    }
    return this.operand & 0xFF;
  }

  _getIndAddr() {
    return this._readWord();
  }

  _getImmediate() {
    return this._readByte();
  }

  _getZeroAddr() {
    return this._readByte() & 0xFF;
  }

  _getZeroXAddr() {
    const value = this._readByte() & 0xFF;
    this.memoryRead(value, 1);
    return (value + this.X) & 0xFF;
  }

  _getZeroYAddr() {
    const value = this._readByte() & 0xFF;
    this.memoryRead(value, 1);
    return (value + this.Y) & 0xFF;
  }

  _getAbsAddr() {
    return this._readWord();
  }

  _getAbsXAddr(dummyRead = true) {
    const baseAddr = this._readWord();
    const pageCrossed = this._checkPageCrossedUnsigned(baseAddr, this.X);

    if (pageCrossed || dummyRead) {
      this.memoryRead((baseAddr + this.X - (pageCrossed ? 0x100 : 0)) & 0xFFFF, 1);
    }

    return (baseAddr + this.X) & 0xFFFF;
  }

  _getAbsYAddr(dummyRead = true) {
    const baseAddr = this._readWord();
    const pageCrossed = this._checkPageCrossedUnsigned(baseAddr, this.Y);

    if (pageCrossed || dummyRead) {
      this.memoryRead((baseAddr + this.Y - (pageCrossed ? 0x100 : 0)) & 0xFFFF, 1);
    }

    return (baseAddr + this.Y) & 0xFFFF;
  }

  _getInd() {
    const addr = this.operand & 0xFFFF;

    if ((addr & 0xFF) === 0xFF) {
      const lo = this.memoryRead(addr & 0xFFFF) & 0xFF;
      const hi = this.memoryRead((addr - 0xFF) & 0xFFFF) & 0xFF;
      return ((hi << 8) | lo) & 0xFFFF;
    }

    return this._memoryReadWord(addr);
  }

  _getIndXAddr() {
    let zp = this._readByte() & 0xFF;
    this.memoryRead(zp, 1);

    zp = (zp + this.X) & 0xFF;

    if (zp === 0xFF) {
      const lo = this.memoryRead(0x00FF) & 0xFF;
      const hi = this.memoryRead(0x0000) & 0xFF;
      return ((hi << 8) | lo) & 0xFFFF;
    }

    return this._memoryReadWord(zp);
  }

  _getIndYAddr(dummyRead = true) {
    const zp = this._readByte() & 0xFF;

    let addr;
    if (zp === 0xFF) {
      const lo = this.memoryRead(0x00FF) & 0xFF;
      const hi = this.memoryRead(0x0000) & 0xFF;
      addr = ((hi << 8) | lo) & 0xFFFF;
    } else {
      addr = this._memoryReadWord(zp);
    }

    const pageCrossed = this._checkPageCrossedUnsigned(addr, this.Y);
    if (pageCrossed || dummyRead) {
      this.memoryRead((addr + this.Y - (pageCrossed ? 0x100 : 0)) & 0xFFFF, 1);
    }

    return (addr + this.Y) & 0xFFFF;
  }

  _fetchOperand(mode) {
    switch (mode) {
      case AM.Acc:
      case AM.Imp:
        this._dummyRead();
        return 0;

      case AM.Imm:
      case AM.Rel:
        return this._getImmediate();

      case AM.Zero:
        return this._getZeroAddr();

      case AM.ZeroX:
        return this._getZeroXAddr();

      case AM.ZeroY:
        return this._getZeroYAddr();

      case AM.Ind:
        return this._getIndAddr();

      case AM.IndX:
        return this._getIndXAddr();

      case AM.IndY:
        return this._getIndYAddr(false);

      case AM.IndYW:
        return this._getIndYAddr(true);

      case AM.Abs:
        return this._getAbsAddr();

      case AM.AbsX:
        return this._getAbsXAddr(false);

      case AM.AbsXW:
        return this._getAbsXAddr(true);

      case AM.AbsY:
        return this._getAbsYAddr(false);

      case AM.AbsYW:
        return this._getAbsYAddr(true);

      case AM.Other:
      case AM.None:
      default:
        return 0;
    }
  }

  // ===========================================================================
  // ALU / COMMON INSTRUCTION HELPERS
  // ===========================================================================

  AND() {
    this._setA(this.A & this._getOperandValue());
  }

  EOR() {
    this._setA(this.A ^ this._getOperandValue());
  }

  ORA() {
    this._setA(this.A | this._getOperandValue());
  }

  _ADD(value) {
    const operand = value & 0xFF;
    const result = this.A + operand + (this._checkFlag(FLAG_CARRY) ? 1 : 0);

    this._clearFlags(FLAG_CARRY | FLAG_NEGATIVE | FLAG_OVERFLOW | FLAG_ZERO);
    this._setZeroNegativeFlags(result & 0xFF);

    if ((~(this.A ^ operand) & (this.A ^ result) & 0x80) !== 0) {
      this._setFlags(FLAG_OVERFLOW);
    }

    if (result > 0xFF) {
      this._setFlags(FLAG_CARRY);
    }

    this._setA(result & 0xFF);
  }

  ADC() {
    this._ADD(this._getOperandValue());
  }

  SBC() {
    this._ADD((this._getOperandValue() ^ 0xFF) & 0xFF);
  }

  _CMP(reg, value) {
    const r = reg & 0xFF;
    const v = value & 0xFF;

    this._clearFlags(FLAG_CARRY | FLAG_NEGATIVE | FLAG_ZERO);

    const result = (r - v) & 0x1FF;

    if (r >= v) {
      this._setFlags(FLAG_CARRY);
    }

    if (r === v) {
      this._setFlags(FLAG_ZERO);
    }

    if ((result & 0x80) !== 0) {
      this._setFlags(FLAG_NEGATIVE);
    }
  }

  CPA() {
    this._CMP(this.A, this._getOperandValue());
  }

  CPX() {
    this._CMP(this.X, this._getOperandValue());
  }

  CPY() {
    this._CMP(this.Y, this._getOperandValue());
  }

  INC() {
    const addr = this.operand & 0xFFFF;
    this._clearFlags(FLAG_NEGATIVE | FLAG_ZERO);

    let value = this.memoryRead(addr) & 0xFF;
    this.memoryWrite(addr, value, 2);

    value = (value + 1) & 0xFF;
    this._setZeroNegativeFlags(value);
    this.memoryWrite(addr, value);
  }

  DEC() {
    const addr = this.operand & 0xFFFF;
    this._clearFlags(FLAG_NEGATIVE | FLAG_ZERO);

    let value = this.memoryRead(addr) & 0xFF;
    this.memoryWrite(addr, value, 2);

    value = (value - 1) & 0xFF;
    this._setZeroNegativeFlags(value);
    this.memoryWrite(addr, value);
  }

  _ASL(value) {
    const v = value & 0xFF;

    this._clearFlags(FLAG_CARRY | FLAG_NEGATIVE | FLAG_ZERO);
    if ((v & 0x80) !== 0) {
      this._setFlags(FLAG_CARRY);
    }

    const result = (v << 1) & 0xFF;
    this._setZeroNegativeFlags(result);
    return result;
  }

  _LSR(value) {
    const v = value & 0xFF;

    this._clearFlags(FLAG_CARRY | FLAG_NEGATIVE | FLAG_ZERO);
    if ((v & 0x01) !== 0) {
      this._setFlags(FLAG_CARRY);
    }

    const result = (v >> 1) & 0xFF;
    this._setZeroNegativeFlags(result);
    return result;
  }

  _ROL(value) {
    const v = value & 0xFF;
    const carry = this._checkFlag(FLAG_CARRY);

    this._clearFlags(FLAG_CARRY | FLAG_NEGATIVE | FLAG_ZERO);
    if ((v & 0x80) !== 0) {
      this._setFlags(FLAG_CARRY);
    }

    const result = ((v << 1) | (carry ? 1 : 0)) & 0xFF;
    this._setZeroNegativeFlags(result);
    return result;
  }

  _ROR(value) {
    const v = value & 0xFF;
    const carry = this._checkFlag(FLAG_CARRY);

    this._clearFlags(FLAG_CARRY | FLAG_NEGATIVE | FLAG_ZERO);
    if ((v & 0x01) !== 0) {
      this._setFlags(FLAG_CARRY);
    }

    const result = ((v >> 1) | (carry ? 0x80 : 0x00)) & 0xFF;
    this._setZeroNegativeFlags(result);
    return result;
  }

  _ASLAddr() {
    const addr = this.operand & 0xFFFF;
    const value = this.memoryRead(addr) & 0xFF;
    this.memoryWrite(addr, value, 2);
    this.memoryWrite(addr, this._ASL(value));
  }

  _LSRAddr() {
    const addr = this.operand & 0xFFFF;
    const value = this.memoryRead(addr) & 0xFF;
    this.memoryWrite(addr, value, 2);
    this.memoryWrite(addr, this._LSR(value));
  }

  _ROLAddr() {
    const addr = this.operand & 0xFFFF;
    const value = this.memoryRead(addr) & 0xFF;
    this.memoryWrite(addr, value, 2);
    this.memoryWrite(addr, this._ROL(value));
  }

  _RORAddr() {
    const addr = this.operand & 0xFFFF;
    const value = this.memoryRead(addr) & 0xFF;
    this.memoryWrite(addr, value, 2);
    this.memoryWrite(addr, this._ROR(value));
  }

  _JMP(addr) {
    this.PC = addr & 0xFFFF;
  }

  _branchRelative(shouldBranch) {
    const offset = (this.operand << 24) >> 24;

    if (shouldBranch) {
      // Mesen quirk: branch can delay pending IRQ by one instruction.
      if (this.runIrq && !this.prevRunIrq) {
        this.runIrq = false;
      }

      this._dummyRead();

      if (this._checkPageCrossedSigned(this.PC, offset)) {
        this._dummyRead();
      }

      this.PC = (this.PC + offset) & 0xFFFF;
    }
  }

  BIT() {
    const value = this._getOperandValue();

    this._clearFlags(FLAG_ZERO | FLAG_OVERFLOW | FLAG_NEGATIVE);
    if ((this.A & value) === 0) {
      this._setFlags(FLAG_ZERO);
    }
    if ((value & 0x40) !== 0) {
      this._setFlags(FLAG_OVERFLOW);
    }
    if ((value & 0x80) !== 0) {
      this._setFlags(FLAG_NEGATIVE);
    }
  }

  // ===========================================================================
  // OFFICIAL OPCODES
  // ===========================================================================

  LDA() { this._setA(this._getOperandValue()); }
  LDX() { this._setX(this._getOperandValue()); }
  LDY() { this._setY(this._getOperandValue()); }

  STA() { this.memoryWrite(this.operand & 0xFFFF, this.A); }
  STX() { this.memoryWrite(this.operand & 0xFFFF, this.X); }
  STY() { this.memoryWrite(this.operand & 0xFFFF, this.Y); }

  TAX() { this._setX(this.A); }
  TAY() { this._setY(this.A); }
  TSX() { this._setX(this.SP); }
  TXA() { this._setA(this.X); }
  TXS() { this.SP = this.X & 0xFF; }
  TYA() { this._setA(this.Y); }

  PHA() { this._push(this.A); }

  PHP() {
    this._push((this.P | FLAG_BREAK | FLAG_RESERVED) & 0xFF);
  }

  PLA() {
    this._dummyRead();
    this._setA(this._pop());
  }

  PLP() {
    this._dummyRead();
    this._setPS(this._pop());
  }

  INX() { this._setX((this.X + 1) & 0xFF); }
  INY() { this._setY((this.Y + 1) & 0xFF); }

  DEX() { this._setX((this.X - 1) & 0xFF); }
  DEY() { this._setY((this.Y - 1) & 0xFF); }

  ASL_Acc() { this._setA(this._ASL(this.A)); }
  ASL_Memory() { this._ASLAddr(); }

  LSR_Acc() { this._setA(this._LSR(this.A)); }
  LSR_Memory() { this._LSRAddr(); }

  ROL_Acc() { this._setA(this._ROL(this.A)); }
  ROL_Memory() { this._ROLAddr(); }

  ROR_Acc() { this._setA(this._ROR(this.A)); }
  ROR_Memory() { this._RORAddr(); }

  JMP_Abs() { this._JMP(this.operand & 0xFFFF); }
  JMP_Ind() { this._JMP(this._getInd()); }

  JSR() {
    const lo = this._readByte();
    this._dummyRead();
    this._pushWord(this.PC);
    const addr = ((this._readByte() << 8) | lo) & 0xFFFF;
    this._JMP(addr);
  }

  RTS() {
    this._dummyRead();
    const addr = this._popWord();
    this._dummyRead();
    this.PC = (addr + 1) & 0xFFFF;
  }

  BCC() { this._branchRelative(!this._checkFlag(FLAG_CARRY)); }
  BCS() { this._branchRelative(this._checkFlag(FLAG_CARRY)); }
  BEQ() { this._branchRelative(this._checkFlag(FLAG_ZERO)); }
  BMI() { this._branchRelative(this._checkFlag(FLAG_NEGATIVE)); }
  BNE() { this._branchRelative(!this._checkFlag(FLAG_ZERO)); }
  BPL() { this._branchRelative(!this._checkFlag(FLAG_NEGATIVE)); }
  BVC() { this._branchRelative(!this._checkFlag(FLAG_OVERFLOW)); }
  BVS() { this._branchRelative(this._checkFlag(FLAG_OVERFLOW)); }

  CLC() { this._clearFlags(FLAG_CARRY); }
  CLD() { this._clearFlags(FLAG_DECIMAL); }
  CLI() { this._clearFlags(FLAG_INTERRUPT); }
  CLV() { this._clearFlags(FLAG_OVERFLOW); }
  SEC() { this._setFlags(FLAG_CARRY); }
  SED() { this._setFlags(FLAG_DECIMAL); }
  SEI() { this._setFlags(FLAG_INTERRUPT); }

  BRK() {
    this._pushWord((this.PC + 1) & 0xFFFF);

    const flags = (this.P | FLAG_BREAK | FLAG_RESERVED) & 0xFF;

    if (this.needNmi) {
      this.needNmi = false;
      this._push(flags);
      this._setFlags(FLAG_INTERRUPT);
      this.PC = this._memoryReadWord(NMI_VECTOR) & 0xFFFF;
    } else {
      this._push(flags);
      this._setFlags(FLAG_INTERRUPT);
      this.PC = this._memoryReadWord(IRQ_VECTOR) & 0xFFFF;
    }

    // Ensure interrupt handler runs at least one instruction before next NMI.
    this.prevNeedNmi = false;
  }

  RTI() {
    this._dummyRead();
    this._setPS(this._pop());
    this.PC = this._popWord() & 0xFFFF;
  }

  NOP() {
    // Consume operand/read cycles for NOP variants.
    this._getOperandValue();
  }

  // ===========================================================================
  // UNOFFICIAL OPCODES (Mesen baseline)
  // ===========================================================================

  SLO() {
    const value = this._getOperandValue();
    this.memoryWrite(this.operand & 0xFFFF, value, 2);
    const shifted = this._ASL(value);
    this._setA(this.A | shifted);
    this.memoryWrite(this.operand & 0xFFFF, shifted);
  }

  SRE() {
    const value = this._getOperandValue();
    this.memoryWrite(this.operand & 0xFFFF, value, 2);
    const shifted = this._LSR(value);
    this._setA(this.A ^ shifted);
    this.memoryWrite(this.operand & 0xFFFF, shifted);
  }

  RLA() {
    const value = this._getOperandValue();
    this.memoryWrite(this.operand & 0xFFFF, value, 2);
    const shifted = this._ROL(value);
    this._setA(this.A & shifted);
    this.memoryWrite(this.operand & 0xFFFF, shifted);
  }

  RRA() {
    const value = this._getOperandValue();
    this.memoryWrite(this.operand & 0xFFFF, value, 2);
    const shifted = this._ROR(value);
    this._ADD(shifted);
    this.memoryWrite(this.operand & 0xFFFF, shifted);
  }

  SAX() {
    this.memoryWrite(this.operand & 0xFFFF, this.A & this.X);
  }

  LAX() {
    const value = this._getOperandValue();
    this._setX(value);
    this._setA(value);
  }

  DCP() {
    let value = this._getOperandValue();
    this.memoryWrite(this.operand & 0xFFFF, value, 2);
    value = (value - 1) & 0xFF;
    this._CMP(this.A, value);
    this.memoryWrite(this.operand & 0xFFFF, value);
  }

  ISB() {
    let value = this._getOperandValue();
    this.memoryWrite(this.operand & 0xFFFF, value, 2);
    value = (value + 1) & 0xFF;
    this._ADD(value ^ 0xFF);
    this.memoryWrite(this.operand & 0xFFFF, value);
  }

  AAC() {
    this._setA(this.A & this._getOperandValue());

    this._clearFlags(FLAG_CARRY);
    if (this._checkFlag(FLAG_NEGATIVE)) {
      this._setFlags(FLAG_CARRY);
    }
  }

  ASR() {
    this._clearFlags(FLAG_CARRY);
    this._setA(this.A & this._getOperandValue());
    if ((this.A & 0x01) !== 0) {
      this._setFlags(FLAG_CARRY);
    }
    this._setA((this.A >> 1) & 0xFF);
  }

  ARR() {
    this._setA((((this.A & this._getOperandValue()) >> 1) | (this._checkFlag(FLAG_CARRY) ? 0x80 : 0x00)) & 0xFF);
    this._clearFlags(FLAG_CARRY | FLAG_OVERFLOW);

    if ((this.A & 0x40) !== 0) {
      this._setFlags(FLAG_CARRY);
    }

    if (((this._checkFlag(FLAG_CARRY) ? 1 : 0) ^ ((this.A >> 5) & 0x01)) !== 0) {
      this._setFlags(FLAG_OVERFLOW);
    }
  }

  ATX() {
    const value = this._getOperandValue();
    this._setA(value);
    this._setX(this.A);
    this._setA(this.A);
  }

  AXS() {
    const opValue = this._getOperandValue();
    const value = ((this.A & this.X) - opValue) & 0xFF;

    this._clearFlags(FLAG_CARRY);
    if ((this.A & this.X) >= opValue) {
      this._setFlags(FLAG_CARRY);
    }

    this._setX(value);
  }

  _SyaSxaAxa(baseAddr, indexReg, valueReg) {
    const base = baseAddr & 0xFFFF;
    const index = indexReg & 0xFF;
    const value = valueReg & 0xFF;

    const pageCrossed = this._checkPageCrossedUnsigned(base, index);

    const startCycle = this.cycleCount;
    this.memoryRead((base + index - (pageCrossed ? 0x100 : 0)) & 0xFFFF, 1);
    const hadDma = (this.cycleCount - startCycle) > 1;

    const operand = (base + index) & 0xFFFF;

    let addrHigh = (operand >> 8) & 0xFF;
    const addrLow = operand & 0xFF;

    if (pageCrossed) {
      addrHigh &= value;
    }

    const writeValue = hadDma ? value : (value & (((base >> 8) + 1) & 0xFF));
    this.memoryWrite(((addrHigh << 8) | addrLow) & 0xFFFF, writeValue & 0xFF);
  }

  SHY() {
    this._SyaSxaAxa(this._readWord(), this.X, this.Y);
  }

  SHX() {
    this._SyaSxaAxa(this._readWord(), this.Y, this.X);
  }

  SHAA() {
    this._SyaSxaAxa(this._readWord(), this.Y, this.X & this.A);
  }

  SHAZ() {
    const zp = this._readByte() & 0xFF;

    let baseAddr;
    if (zp === 0xFF) {
      const lo = this.memoryRead(0x00FF) & 0xFF;
      const hi = this.memoryRead(0x0000) & 0xFF;
      baseAddr = ((hi << 8) | lo) & 0xFFFF;
    } else {
      baseAddr = this._memoryReadWord(zp);
    }

    this._SyaSxaAxa(baseAddr, this.Y, this.X & this.A);
  }

  TAS() {
    this.SHAA();
    this.SP = (this.X & this.A) & 0xFF;
  }

  HLT() {
    // Freeze by re-executing current opcode forever.
    this.PC = (this.PC - 1) & 0xFFFF;

    // Block interrupt entry while halted.
    this.prevRunIrq = false;
    this.prevNeedNmi = false;
  }

  ANE() {
    const imm = this._getOperandValue();
    this._setA(((this.A | 0xEE) & this.X & imm) & 0xFF);
  }

  LAS() {
    const value = this._getOperandValue();
    this._setA(value & this.SP);
    this._setX(this.A);
    this.SP = this.A & 0xFF;
  }

  // ===========================================================================
  // OPCODE TABLES
  // ===========================================================================

  _buildOpTable() {
    const rows = [
      ["BRK", "ORA", "HLT", "SLO", "NOP", "ORA", "ASL_Memory", "SLO", "PHP", "ORA", "ASL_Acc", "AAC", "NOP", "ORA", "ASL_Memory", "SLO"],
      ["BPL", "ORA", "HLT", "SLO", "NOP", "ORA", "ASL_Memory", "SLO", "CLC", "ORA", "NOP", "SLO", "NOP", "ORA", "ASL_Memory", "SLO"],
      ["JSR", "AND", "HLT", "RLA", "BIT", "AND", "ROL_Memory", "RLA", "PLP", "AND", "ROL_Acc", "AAC", "BIT", "AND", "ROL_Memory", "RLA"],
      ["BMI", "AND", "HLT", "RLA", "NOP", "AND", "ROL_Memory", "RLA", "SEC", "AND", "NOP", "RLA", "NOP", "AND", "ROL_Memory", "RLA"],
      ["RTI", "EOR", "HLT", "SRE", "NOP", "EOR", "LSR_Memory", "SRE", "PHA", "EOR", "LSR_Acc", "ASR", "JMP_Abs", "EOR", "LSR_Memory", "SRE"],
      ["BVC", "EOR", "HLT", "SRE", "NOP", "EOR", "LSR_Memory", "SRE", "CLI", "EOR", "NOP", "SRE", "NOP", "EOR", "LSR_Memory", "SRE"],
      ["RTS", "ADC", "HLT", "RRA", "NOP", "ADC", "ROR_Memory", "RRA", "PLA", "ADC", "ROR_Acc", "ARR", "JMP_Ind", "ADC", "ROR_Memory", "RRA"],
      ["BVS", "ADC", "HLT", "RRA", "NOP", "ADC", "ROR_Memory", "RRA", "SEI", "ADC", "NOP", "RRA", "NOP", "ADC", "ROR_Memory", "RRA"],
      ["NOP", "STA", "NOP", "SAX", "STY", "STA", "STX", "SAX", "DEY", "NOP", "TXA", "ANE", "STY", "STA", "STX", "SAX"],
      ["BCC", "STA", "HLT", "SHAZ", "STY", "STA", "STX", "SAX", "TYA", "STA", "TXS", "TAS", "SHY", "STA", "SHX", "SHAA"],
      ["LDY", "LDA", "LDX", "LAX", "LDY", "LDA", "LDX", "LAX", "TAY", "LDA", "TAX", "ATX", "LDY", "LDA", "LDX", "LAX"],
      ["BCS", "LDA", "HLT", "LAX", "LDY", "LDA", "LDX", "LAX", "CLV", "LDA", "TSX", "LAS", "LDY", "LDA", "LDX", "LAX"],
      ["CPY", "CPA", "NOP", "DCP", "CPY", "CPA", "DEC", "DCP", "INY", "CPA", "DEX", "AXS", "CPY", "CPA", "DEC", "DCP"],
      ["BNE", "CPA", "HLT", "DCP", "NOP", "CPA", "DEC", "DCP", "CLD", "CPA", "NOP", "DCP", "NOP", "CPA", "DEC", "DCP"],
      ["CPX", "SBC", "NOP", "ISB", "CPX", "SBC", "INC", "ISB", "INX", "SBC", "NOP", "SBC", "CPX", "SBC", "INC", "ISB"],
      ["BEQ", "SBC", "HLT", "ISB", "NOP", "SBC", "INC", "ISB", "SED", "SBC", "NOP", "ISB", "NOP", "SBC", "INC", "ISB"],
    ];

    return rows.flat().map((name) => this[name]);
  }

  _buildAddrModeTable() {
    const M = AM;
    const rows = [
      [M.Imp, M.IndX, M.None, M.IndX, M.Zero, M.Zero, M.Zero, M.Zero, M.Imp, M.Imm, M.Acc, M.Imm, M.Abs, M.Abs, M.Abs, M.Abs],
      [M.Rel, M.IndY, M.None, M.IndYW, M.ZeroX, M.ZeroX, M.ZeroX, M.ZeroX, M.Imp, M.AbsY, M.Imp, M.AbsYW, M.AbsX, M.AbsX, M.AbsXW, M.AbsXW],
      [M.Other, M.IndX, M.None, M.IndX, M.Zero, M.Zero, M.Zero, M.Zero, M.Imp, M.Imm, M.Acc, M.Imm, M.Abs, M.Abs, M.Abs, M.Abs],
      [M.Rel, M.IndY, M.None, M.IndYW, M.ZeroX, M.ZeroX, M.ZeroX, M.ZeroX, M.Imp, M.AbsY, M.Imp, M.AbsYW, M.AbsX, M.AbsX, M.AbsXW, M.AbsXW],
      [M.Imp, M.IndX, M.None, M.IndX, M.Zero, M.Zero, M.Zero, M.Zero, M.Imp, M.Imm, M.Acc, M.Imm, M.Abs, M.Abs, M.Abs, M.Abs],
      [M.Rel, M.IndY, M.None, M.IndYW, M.ZeroX, M.ZeroX, M.ZeroX, M.ZeroX, M.Imp, M.AbsY, M.Imp, M.AbsYW, M.AbsX, M.AbsX, M.AbsXW, M.AbsXW],
      [M.Imp, M.IndX, M.None, M.IndX, M.Zero, M.Zero, M.Zero, M.Zero, M.Imp, M.Imm, M.Acc, M.Imm, M.Ind, M.Abs, M.Abs, M.Abs],
      [M.Rel, M.IndY, M.None, M.IndYW, M.ZeroX, M.ZeroX, M.ZeroX, M.ZeroX, M.Imp, M.AbsY, M.Imp, M.AbsYW, M.AbsX, M.AbsX, M.AbsXW, M.AbsXW],
      [M.Imm, M.IndX, M.Imm, M.IndX, M.Zero, M.Zero, M.Zero, M.Zero, M.Imp, M.Imm, M.Imp, M.Imm, M.Abs, M.Abs, M.Abs, M.Abs],
      [M.Rel, M.IndYW, M.None, M.Other, M.ZeroX, M.ZeroX, M.ZeroY, M.ZeroY, M.Imp, M.AbsYW, M.Imp, M.Other, M.Other, M.AbsXW, M.Other, M.Other],
      [M.Imm, M.IndX, M.Imm, M.IndX, M.Zero, M.Zero, M.Zero, M.Zero, M.Imp, M.Imm, M.Imp, M.Imm, M.Abs, M.Abs, M.Abs, M.Abs],
      [M.Rel, M.IndY, M.None, M.IndY, M.ZeroX, M.ZeroX, M.ZeroY, M.ZeroY, M.Imp, M.AbsY, M.Imp, M.AbsY, M.AbsX, M.AbsX, M.AbsY, M.AbsY],
      [M.Imm, M.IndX, M.Imm, M.IndX, M.Zero, M.Zero, M.Zero, M.Zero, M.Imp, M.Imm, M.Imp, M.Imm, M.Abs, M.Abs, M.Abs, M.Abs],
      [M.Rel, M.IndY, M.None, M.IndYW, M.ZeroX, M.ZeroX, M.ZeroX, M.ZeroX, M.Imp, M.AbsY, M.Imp, M.AbsYW, M.AbsX, M.AbsX, M.AbsXW, M.AbsXW],
      [M.Imm, M.IndX, M.Imm, M.IndX, M.Zero, M.Zero, M.Zero, M.Zero, M.Imp, M.Imm, M.Imp, M.Imm, M.Abs, M.Abs, M.Abs, M.Abs],
      [M.Rel, M.IndY, M.None, M.IndYW, M.ZeroX, M.ZeroX, M.ZeroX, M.ZeroX, M.Imp, M.AbsY, M.Imp, M.AbsYW, M.AbsX, M.AbsX, M.AbsXW, M.AbsXW],
    ];

    return rows.flat();
  }

  // ===========================================================================
  // SAVE STATE
  // ===========================================================================

  toJSON() {
    return {
      stateVersion: 3,

      ram: Array.from(this.ram),
      mem: Array.from(this.mem),

      A: this.A,
      X: this.X,
      Y: this.Y,
      SP: this.SP,
      P: this.P,
      PC: this.PC,

      dataBus: this.dataBus,

      nmiFlag: this.nmiFlag,
      irqFlag: this.irqFlag,
      irqMask: this.irqMask,

      prevRunIrq: this.prevRunIrq,
      runIrq: this.runIrq,
      prevNmiFlag: this.prevNmiFlag,
      prevNeedNmi: this.prevNeedNmi,
      needNmi: this.needNmi,

      cycleCount: this.cycleCount,
      cycleOffset: this.cycleOffset,
      cyclesThisStep: this.cyclesThisStep,
      cyclesToHalt: this.cyclesToHalt,

      cpuWrite: this.cpuWrite,
      instAddrMode: this.instAddrMode,
      operand: this.operand,

      startClockCount: this.startClockCount,
      endClockCount: this.endClockCount,
      ppuOffset: this.ppuOffset,
    };
  }

  fromJSON(s) {
    if (!s || s.stateVersion !== 3) {
      throw new Error(`CPU save state version not supported (got v${s?.stateVersion}, expected v3)`);
    }

    this.ram = new Uint8Array(s.ram || this.ram);

    if (s.mem) {
      this.mem = new Uint8Array(s.mem);
    } else {
      this.mem = new Uint8Array(0x10000);
      for (let i = 0; i < 0x0800; i++) {
        this.mem[i] = this.ram[i];
      }
    }

    this.A = (s.A ?? this.A) & 0xFF;
    this.X = (s.X ?? this.X) & 0xFF;
    this.Y = (s.Y ?? this.Y) & 0xFF;
    this.SP = (s.SP ?? this.SP) & 0xFF;
    this.PC = (s.PC ?? this.PC) & 0xFFFF;
    this._setPS((s.P ?? this.P) & 0xFF);

    this.dataBus = (s.dataBus ?? this.dataBus) & 0xFF;

    this.nmiFlag = !!(s.nmiFlag ?? this.nmiFlag);
    this.irqFlag = (s.irqFlag ?? this.irqFlag) & 0xFF;
    this.irqMask = (s.irqMask ?? this.irqMask) & 0xFF;

    this.prevRunIrq = !!(s.prevRunIrq ?? this.prevRunIrq);
    this.runIrq = !!(s.runIrq ?? this.runIrq);
    this.prevNmiFlag = !!(s.prevNmiFlag ?? this.prevNmiFlag);
    this.prevNeedNmi = !!(s.prevNeedNmi ?? this.prevNeedNmi);
    this.needNmi = !!(s.needNmi ?? this.needNmi);

    this.cycleCount = s.cycleCount ?? this.cycleCount;
    this.cycleOffset = s.cycleOffset ?? 0;
    this.cyclesThisStep = s.cyclesThisStep ?? 0;
    this.cyclesToHalt = s.cyclesToHalt ?? 0;

    this.cpuWrite = !!(s.cpuWrite ?? false);
    this.instAddrMode = s.instAddrMode ?? AM.None;
    this.operand = s.operand ?? 0;

    this.startClockCount = s.startClockCount ?? this.startClockCount;
    this.endClockCount = s.endClockCount ?? this.endClockCount;
    this.ppuOffset = s.ppuOffset ?? this.ppuOffset;

    this._setMasterClockDivider(this._resolveRegion());
  }
}

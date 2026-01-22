// Mapper 025: VRC4b VRC4d
// Used by: Gradius II
//
// Features:
//   - 8-bit CHR bank registers (up to 256KB CHR)
//   - Fixed last/second-last PRG banks with swap mode
//   - Horizontal, vertical and 1-screen mirroring.
//   - IRQ device
//
// References:
//   - https://www.nesdev.org/wiki/VRC2_and_VRC4

import Mapper from './mapper-base.js';

export default class Mapper025 extends Mapper {
  constructor(cartridge) {
    super(cartridge);
    this.nes = cartridge.nes; // Ensure NES reference is available

    // VRC4 State
    this.prgRegs = [0, 0]; // Registers for $8000, $A000
    this.chrRegs = new Int32Array(8); // 8-bit CHR registers
    this.mirroringReg = 0; // $9000
    this.programMode = 0;  // $9002 (Bit 1)
    
    // IRQ State
    this.irqLatch = 0;
    this.irqCounter = 0;
    this.irqEnabled = false;
    this.irqEnabledAfterAck = false;
    this.irqMode = 0; // 0=Scanline, 1=Cycle
    this.prescaler = 0;

    // Variant Detection (VRC4b vs VRC4d)
    // VRC4b: A0, A1 (Normal)
    // VRC4d: A1, A0 (Swapped)
    this.variant = 'VRC4b';
    this.pinA0 = 1;
    this.pinA1 = 2;

    if (!this.chrData || this.chrData.length === 0) {
      this.useVRAM(8);
    }
    
    const crc = this.cartridge.getCRC32 ? this.cartridge.getCRC32().toString(16).toUpperCase() : '';
    
    // Known VRC4d Games (Gradius II, etc.)
    const vrc4dGames = [
      '13886346', // Gradius II (J)
      '5ADBF660', // Gradius II (J)
      'A2060609', // Racer Mini Yonku (J)
    ];

    if (vrc4dGames.includes(crc)) {
      this.variant = 'VRC4d';
      this.pinA0 = 2;
      this.pinA1 = 1;
      console.log('Mapper 25: Detected VRC4d variant');
    } else {
      console.log('Mapper 25: Defaulting to VRC4b variant');
    }
  }

  reset() {
    super.reset();
    // Default Banks
    this.prgRegs[0] = 0;
    this.prgRegs[1] = 0;
    this.programMode = 0;
    this.updatePrgBanks();
    
    // CHR defaults
    for (let i = 0; i < 8; i++) this.chrRegs[i] = 0;
    this.updateChrBanks();

    this.mirroringReg = 0;
    this.updateMirroring();
    
    this.irqEnabled = false;
    this.irqCounter = 0;
    this.prescaler = 0;

    if (this.nes && this.nes.rom && this.nes.rom.batteryRam && this.nes.rom.batteryRam.length) {
      const len = Math.min(this.nes.rom.batteryRam.length, this.prgRam.length);
      this.prgRam.set(this.nes.rom.batteryRam.subarray(0, len));
    }
  }

  /**
   * Helper to map CPU address to the VRC4 register address.
   */
  getRegisterAddress(address) {
    const a0 = (address & this.pinA0) ? 1 : 0;
    const a1 = (address & this.pinA1) ? 1 : 0;
    return (address & 0xF000) | (a0 << 0) | (a1 << 1);
  }

  cpuRead(address) {
    if (address >= 0x6000 && address < 0x8000) {
      return this.prgRam[address - 0x6000];
    }

    if (address >= 0x8000) {
      if (!this.prgData || this.prgBankCount === 0) return 0;
      const slot = (address >> 13) & 0x03;
      const offset = address & 0x1FFF;
      return this.prgData[this.prgPagesMap[slot] + offset];
    }
    return undefined;
  }

  cpuWrite(address, value) {
    if (address < 0x6000) {
      return;
    }

    if (address < 0x8000) {
      this.prgRam[address - 0x6000] = value;
      return;
    }

    const regAddress = this.getRegisterAddress(address);
    const regIndex = regAddress & 0x0003;

    switch (regAddress) {
      case 0x8000:
      case 0x8001:
      case 0x8002:
      case 0x8003:
        this.prgRegs[0] = value & 0x1F;
        this.updatePrgBanks();
        break;

      case 0x9000:
      case 0x9001:
        this.mirroringReg = value & 0x03;
        this.updateMirroring();
        break;

      case 0x9002:
      case 0x9003:
        this.programMode = (value & 0x02) ? 1 : 0;
        this.updatePrgBanks();
        break;

      case 0xA000:
      case 0xA001:
      case 0xA002:
      case 0xA003:
        this.prgRegs[1] = value & 0x1F;
        this.updatePrgBanks();
        break;

      case 0xB000:
      case 0xB001:
      case 0xB002:
      case 0xB003:
        this.writeChrReg(0, regIndex, value);
        break;

      case 0xC000:
      case 0xC001:
      case 0xC002:
      case 0xC003:
        this.writeChrReg(2, regIndex, value);
        break;

      case 0xD000:
      case 0xD001:
      case 0xD002:
      case 0xD003:
        this.writeChrReg(4, regIndex, value);
        break;

      case 0xE000:
      case 0xE001:
      case 0xE002:
      case 0xE003:
        this.writeChrReg(6, regIndex, value);
        break;

      case 0xF000:
        this.irqLatch = (this.irqLatch & 0xF0) | (value & 0x0F);
        break;
      case 0xF001:
        this.irqLatch = (this.irqLatch & 0x0F) | ((value & 0x0F) << 4);
        break;
      case 0xF002:
        this.irqEnabledAfterAck = (value & 0x01) !== 0;
        this.irqEnabled = (value & 0x02) !== 0;
        this.irqMode = (value & 0x04) !== 0 ? 1 : 0; // 1=Cycle, 0=Scanline
        if (this.irqEnabled) {
          this.irqCounter = this.irqLatch;
          this.prescaler = 341;
        }
        if (this.nes.cpu.clearIrq) this.nes.cpu.clearIrq(this.nes.cpu.IRQ_NORMAL);
        break;
      case 0xF003:
        this.irqEnabled = this.irqEnabledAfterAck;
        if (this.nes.cpu.clearIrq) this.nes.cpu.clearIrq(this.nes.cpu.IRQ_NORMAL);
        break;
    }
  }

  writeChrReg(baseChrIndex, regIndex, value) {
      // VRC4 Register Layout:
      // Bit 0 of regIndex selects High/Low nibble (0=Low, 1=High)
      // Bit 1 of regIndex selects Even/Odd bank (0=Even, 1=Odd)
      const isHigh = (regIndex & 0x01) !== 0;
      const chrSlot = baseChrIndex + ((regIndex >> 1) & 0x01);
      
      if (isHigh) {
          this.chrRegs[chrSlot] = (this.chrRegs[chrSlot] & 0x0F) | ((value & 0x0F) << 4);
      } else {
          this.chrRegs[chrSlot] = (this.chrRegs[chrSlot] & 0xF0) | (value & 0x0F);
      }
      this.updateChrBanks();
  }

  updatePrgBanks() {
      let b8, bA, bC, bE;
      const count = this.prgBankCount || 16;
      const lastBank = count - 1;
      const secondLast = count - 2;
      
      if (this.programMode === 0) {
          b8 = this.prgRegs[0];
          bC = secondLast;
      } else {
          b8 = secondLast;
          bC = this.prgRegs[0];
      }
      bA = this.prgRegs[1];
      bE = lastBank;
      
      this.switch8kPrgBank(b8, 0); // $8000
      this.switch8kPrgBank(bA, 1); // $A000
      this.switch8kPrgBank(bC, 2); // $C000
      this.switch8kPrgBank(bE, 3); // $E000
  }

  updateChrBanks() {
      for (let i = 0; i < 8; i++) {
          this.switch1kChrBank(this.chrRegs[i], i);
      }
  }

  updateMirroring() {
      if (!this.nes || !this.nes.ppu) return;
      switch (this.mirroringReg & 0x03) {
          case 0: this.nes.ppu.setMirroring(this.nes.rom.VERTICAL_MIRRORING); break;
          case 1: this.nes.ppu.setMirroring(this.nes.rom.HORIZONTAL_MIRRORING); break;
          case 2: this.nes.ppu.setMirroring(this.nes.rom.SINGLESCREEN_MIRRORING_A); break;
          case 3: this.nes.ppu.setMirroring(this.nes.rom.SINGLESCREEN_MIRRORING_B); break;
      }
  }

  cpuClock(cpuCycles) {
      if (!this.irqEnabled) return;

      if (this.irqMode === 0) {
          // Scanline mode: 341 PPU cycles, advance by CPU cycles * 3
          const ppuCycles = cpuCycles * 3;
          this.prescaler -= ppuCycles;
          while (this.prescaler <= 0) {
              this.prescaler += 341;
              if (this.irqCounter === 0xFF) {
                  this.irqCounter = this.irqLatch;
                  if (this.nes.cpu.requestIrq) this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL);
              } else {
                  this.irqCounter++;
              }
          }
          return;
      }

      // Cycle mode: advance per CPU cycle
      for (let i = 0; i < cpuCycles; i++) {
          if (this.irqCounter === 0xFF) {
              this.irqCounter = this.irqLatch;
              if (this.nes.cpu.requestIrq) this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL);
          } else {
              this.irqCounter++;
          }
      }
  }
}

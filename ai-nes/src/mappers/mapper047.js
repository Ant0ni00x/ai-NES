// Mapper 047: Extension of (MMC3)
// Used by: Super Spike V'Ball + Nintendo World Cup
//
// Features:
//   - PRG and CHR ROM into two 128KB blocks. 
//   - Register at $6000 select the active block.
//
// References:
//   - https://www.nesdev.org/wiki/INES_Mapper_047

import Mapper004 from './mapper004.js';

export default class Mapper047 extends Mapper004 {
  constructor(cartridge) {
    super(cartridge);
    this.block = 0;
  }

  reset() {
    super.reset();
    this.block = 0;
    this.updateBanks();
  }

  /**
   * Writes to $6000-$7FFF select the 128KB block.
   * Bit 0: Block Select (0 = First 128KB, 1 = Second 128KB)
   */
  cpuWrite(address, value) {
    if (address >= 0x6000 && address <= 0x7FFF) {
      this.block = value & 0x01;
      this.updateBanks();
      return;
    }
    super.cpuWrite(address, value);
  }

  updateBanks() {
    super.updateBanks();

    // Apply Mapper 47 masking (128KB blocks)
    // PRG: 128KB = 16 x 8KB banks -> Mask 0x0F
    const prgBlockOffset = this.block << 4;
    for (let i = 0; i < this.prgOffsets.length; i++) {
      let bank = this.prgOffsets[i] >>> 13;
      bank = (bank & 0x0F) | prgBlockOffset;
      this.prgOffsets[i] = bank << 13;
    }

    // CHR: 128KB = 128 x 1KB banks -> Mask 0x7F
    const chrBlockOffset = this.block << 7;
    for (let i = 0; i < this.chrOffsets.length; i++) {
      let bank = this.chrOffsets[i] >>> 10;
      bank = (bank & 0x7F) | chrBlockOffset;
      this.chrOffsets[i] = bank << 10;
    }
  }
}
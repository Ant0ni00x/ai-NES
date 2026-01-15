// Mapper 079: NINA-03 / NINA-06
// Used by: Caltron 6-in-1, Magic Dragon, Metal Fighter
//
// Features:
//   - 32KB PRG bank switching
//   - 8KB CHR bank switching
// References:
//   - https://wiki.nesdev.com/w/index.php/NINA-03
//   - https://wiki.nesdev.com/w/index.php/NINA-06

import Mapper from './mapper-base.js';

export default class Mapper079 extends Mapper {
    constructor(cartridge) {
        super(cartridge);
        this.prgBank = 0;
        this.chrBank = 0;
        this.reset();
    }

    reset() {
        this.prgBank = 0;
        this.chrBank = 0;
        this.updateBanks();

        if (this.nes && this.nes.rom) {
            this.nes.ppu.setMirroring(this.nes.rom.getMirroringType());
        }
    }

    cpuRead(address) {
        if (address >= 0x8000) {
            const slot = (address >> 13) & 0x03;
            const offset = address & 0x1FFF;
            return this.prgData[this.prgPagesMap[slot] + offset];
        }
        return undefined;
    }

    cpuWrite(address, data) {
        // Register is mapped at $4100-$5FFF
        // Note: The register is often documented as being at $7FFD, but it's mirrored.
        if (address >= 0x4100 && address <= 0x5FFF) {
            // Standard NINA-03/06 behavior:
            // 7  bit  0
            // ---- ----
            // ...C PPPP
            //    | ++++- Select 8 KB CHR ROM bank
            //    +------ Select 32 KB PRG ROM bank
            this.chrBank = data & 0x0F;
            this.prgBank = (data >> 4) & 0x01;
            this.updateBanks();
        }
    }

    updateBanks() {
        this.switch32kPrgBank(this.prgBank);
        this.switch8kChrBank(this.chrBank);
    }

    toJSON() {
        return { prgBank: this.prgBank, chrBank: this.chrBank };
    }

    fromJSON(state) {
        this.prgBank = state.prgBank;
        this.chrBank = state.chrBank;
        this.updateBanks();
    }
}

// Mapper 066: GxROM
// Used by: Super Mario Bros./Duck Hunt Multi-Cart
//
// Features:
//   - PRG-ROM: 32KB switchable banks
//   - CHR-ROM: 8KB switchable banks
//
// References:
//   - https://wiki.nesdev.com/w/index.php/GxROM

import Mapper from './mapper-base.js';

export default class Mapper066 extends Mapper {
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

        // Set mirroring from ROM header
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
        if (address >= 0x8000) {
            // Mapper 66 (GxROM)
            // 7  bit  0
            // ---- ----
            // ..PP ..CC
            //   ||   ||
            //   ||   ++- Select 8 KB CHR ROM bank
            //   ++------ Select 32 KB PRG ROM bank

            this.chrBank = data & 0x03;
            this.prgBank = (data >> 4) & 0x03;
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

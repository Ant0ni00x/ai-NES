// Mapper 011: Color Dreams
// Used by: Color Dreams Games
//
// Features:
//   - 32KB PRG bank switching
//   - 8KB CHR bank switching
// References:
//   - https://wiki.nesdev.com/w/index.php/Color_Dreams

import Mapper from './mapper-base.js';

export default class Mapper011 extends Mapper {
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
            // Color Dreams:
            // 7  bit  0
            // ---- ----
            // CCCC PPPP
            // |||| ||||
            // |||| ++++- Select 32 KB PRG ROM bank
            // ++++------ Select 8 KB CHR ROM bank

            this.prgBank = data & 0x0F;
            this.chrBank = (data >> 4) & 0x0F;
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

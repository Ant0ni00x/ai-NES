// Mapper 002: (UNROM)
// Used by: Blades of Steel, Castlevania, Contra, Jackal
//
// Features:
//   - 16KB PRG bank switching at $8000-$BFFF
//   - Fixed 16KB PRG bank at $C000-$FFFF (last bank)
//   - Uses CHR-RAM (8KB) instead of CHR-ROM
//
// References:
//   - https://wiki.nesdev.com/w/index.php/UNROM

import Mapper from './mapper-base.js';

export default class Mapper002 extends Mapper {
    constructor(cartridge) {
        super(cartridge);
        this.prgBank = 0;
        
        // UNROM uses CHR-RAM (8KB), but some dumps might have CHR-ROM
        if (this.chrData && this.chrData.length > 0) {
            this.usingChrRam = false;
        } else {
            this.useVRAM(8);
        }
        this.reset();
    }

    reset() {
        this.prgBank = 0;
        this.updateBanks();

        // Set mirroring from ROM header
        if (this.nes && this.nes.rom) {
            this.nes.ppu.setMirroring(this.nes.rom.getMirroringType());
        }
    }

    updateBanks() {
        // Bank 0 (Switchable) at $8000-$BFFF
        this.switch16kPrgBank(this.prgBank, true);

        // Last Bank (Fixed) at $C000-$FFFF
        const lastBank = this.get16kPrgBankCount() - 1;
        this.switch16kPrgBank(lastBank, false);
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
        // UNROM: Writes to $8000-$FFFF select the bank for $8000-$BFFF
        if (address >= 0x8000) {
            this.prgBank = data;
            this.updateBanks();
        }
    }

    toJSON() {
        return {
            prgBank: this.prgBank,
            chrRam: this.usingChrRam ? Array.from(this.chrRam) : null
        };
    }

    fromJSON(state) {
        this.prgBank = state.prgBank;
        if (state.chrRam) {
            this.chrRam = new Uint8Array(state.chrRam);
            this.chrData = this.chrRam;
            this.usingChrRam = true;
        }
        this.updateBanks();
    }
}

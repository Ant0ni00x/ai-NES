// Mapper 034: BNROM / NINA-001
// Used by: Deadly Towers, Impossible Mission II
//
// Features:
//   - 32KB PRG bank switching
//   - (NINA-001 only) 2x 4KB CHR bank switching
//
// References:
//   - https://wiki.nesdev.com/w/index.php/BNROM
//   - https://wiki.nesdev.com/w/index.php/NINA-001

import Mapper from './mapper-base.js';

export default class Mapper034 extends Mapper {
    constructor(cartridge) {
        super(cartridge);
        
        // Mapper 34 covers two distinct boards:
        // 1. BNROM (Deadly Towers): PRG banking only, CHR-RAM.
        // 2. NINA-001 (Impossible Mission II): PRG + CHR banking, CHR-ROM.
        // Heuristic: If CHR-ROM is present, it's NINA-001.
        this.isNina = (this.chrData && this.chrData.length > 0);
        
        this.prgBank = 0;
        this.chrBank0 = 0;
        this.chrBank1 = 0;
        
        if (!this.isNina) {
            this.useVRAM(8); // BNROM uses 8KB CHR-RAM
        }
        
        this.reset();
    }

    reset() {
        this.prgBank = 0;
        this.chrBank0 = 0;
        this.chrBank1 = 0;
        this.updateBanks();

        if (this.nes && this.nes.rom) {
            this.nes.ppu.setMirroring(this.nes.rom.getMirroringType());
        }
    }

    cpuRead(address) {
        if (address >= 0x8000) {
            // Standard 32KB PRG read
            const slot = (address >> 13) & 0x03;
            const offset = address & 0x1FFF;
            return this.prgData[this.prgPagesMap[slot] + offset];
        }
        return undefined;
    }

    cpuWrite(address, data) {
        if (this.isNina) {
            // NINA-001 Registers ($7FFD-$7FFF)
            if (address === 0x7FFD) {
                this.prgBank = data;
                this.updateBanks();
            } else if (address === 0x7FFE) {
                this.chrBank0 = data;
                this.updateBanks();
            } else if (address === 0x7FFF) {
                this.chrBank1 = data;
                this.updateBanks();
            }
        } else {
            // BNROM: Writes to $8000-$FFFF set PRG bank
            if (address >= 0x8000) {
                this.prgBank = data;
                this.updateBanks();
            }
        }
    }

    updateBanks() {
        // PRG Banking (32KB)
        this.switch32kPrgBank(this.prgBank);

        if (this.isNina) {
            // NINA-001: Two 4KB CHR banks
            this.switch4kChrBank(this.chrBank0, true);  // $0000-$0FFF
            this.switch4kChrBank(this.chrBank1, false); // $1000-$1FFF
        }
    }

    toJSON() {
        return {
            prgBank: this.prgBank,
            chrBank0: this.chrBank0,
            chrBank1: this.chrBank1,
            isNina: this.isNina
        };
    }

    fromJSON(state) {
        this.prgBank = state.prgBank;
        this.chrBank0 = state.chrBank0;
        this.chrBank1 = state.chrBank1;
        this.isNina = state.isNina;
        this.updateBanks();
    }
}

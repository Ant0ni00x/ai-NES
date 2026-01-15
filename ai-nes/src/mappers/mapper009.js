// Mapper 009: (MMC2)
// Used by: Mike Tyson's Punch-Out!!
//
// Features:
//   - PRG-ROM: 8KB switchable banks
//   - CHR-ROM: 4KB switchable banks with Latch mechanism
//   - Latch: Reading specific tiles ($FD/$FE) switches the CHR bank for that pattern table
// References:
//   - https://wiki.nesdev.com/w/index.php/MMC2

import Mapper from './mapper-base.js';

export default class Mapper009 extends Mapper {
    constructor(cartridge) {
        super(cartridge);
        
        this.prgBank0 = 0; // $8000-$9FFF
        this.prgBank1 = 0; // $A000-$BFFF
        this.prgBank2 = 0; // $C000-$DFFF
        this.prgBank3 = 0; // $E000-$FFFF (Fixed)

        this.chrBank0FD = 0; // PPU $0000-$0FFF when Latch 0 = $FD
        this.chrBank0FE = 0; // PPU $0000-$0FFF when Latch 0 = $FE
        this.chrBank1FD = 0; // PPU $1000-$1FFF when Latch 1 = $FD
        this.chrBank1FE = 0; // PPU $1000-$1FFF when Latch 1 = $FE

        this.latch0 = 0xFE; // Latch for Pattern Table 0
        this.latch1 = 0xFE; // Latch for Pattern Table 1

        this.reset();
    }

    reset() {
        // Initial state
        this.prgBank0 = 0;
        // The last 3 banks are fixed on reset
        this.prgBank1 = this.get8kPrgBankCount() - 3;
        this.prgBank2 = this.get8kPrgBankCount() - 2;
        this.prgBank3 = this.get8kPrgBankCount() - 1;

        this.chrBank0FD = 0;
        this.chrBank0FE = 0;
        this.chrBank1FD = 0;
        this.chrBank1FE = 0;
        
        this.latch0 = 0xFE;
        this.latch1 = 0xFE;
    }

    cpuRead(address) {
        if (address >= 0x8000) {
            let bank = 0;
            if (address < 0xA000) bank = this.prgBank0;
            else if (address < 0xC000) bank = this.prgBank1;
            else if (address < 0xE000) bank = this.prgBank2;
            else bank = this.prgBank3;

            const offset = (bank * 0x2000) + (address & 0x1FFF);
            return this.prgData[offset];
        }
        return undefined;
    }

    cpuWrite(address, data) {
        if (address >= 0xA000) {
            const reg = (address >> 12) & 0xF; // High nibble
            switch (reg) {
                case 0xA: this.prgBank0 = data & 0x0F; break;
                case 0xB: this.chrBank0FD = data & 0x1F; break;
                case 0xC: this.chrBank0FE = data & 0x1F; break;
                case 0xD: this.chrBank1FD = data & 0x1F; break;
                case 0xE: this.chrBank1FE = data & 0x1F; break;
            }
            
            // Mirroring: Bit 0 of $F000
            if ((address & 0xF000) === 0xF000) {
                if ((data & 1) === 0) this.nes.ppu.setMirroring(this.nes.rom.VERTICAL_MIRRORING);
                else this.nes.ppu.setMirroring(this.nes.rom.HORIZONTAL_MIRRORING);
            }
        }
    }

    ppuRead(address) {
        if (address < 0x2000) {
            // Check for Latch Triggers
            // Latch 0 triggers on $0FD0-$0FDF ($FD) and $0FE0-$0FEF ($FE)
            // Latch 1 triggers on $1FD0-$1FDF ($FD) and $1FE0-$1FEF ($FE)
            
            const page = (address >> 12) & 1; // 0 for $0xxx, 1 for $1xxx

            if (page === 0) {
                if (address >= 0x0FD8 && address <= 0x0FDF) this.latch0 = 0xFD;
                else if (address >= 0x0FE8 && address <= 0x0FEF) this.latch0 = 0xFE;
            } else {
                if (address >= 0x1FD8 && address <= 0x1FDF) this.latch1 = 0xFD;
                else if (address >= 0x1FE8 && address <= 0x1FEF) this.latch1 = 0xFE;
            }

            // Determine Bank
            let bank = 0;
            if (page === 0) {
                bank = (this.latch0 === 0xFD) ? this.chrBank0FD : this.chrBank0FE;
            } else {
                bank = (this.latch1 === 0xFD) ? this.chrBank1FD : this.chrBank1FE;
            }

            const offset = (bank * 0x1000) + (address & 0x0FFF);
            return this.chrData[offset];
        }
        return null;
    }

    toJSON() {
        return {
            prgBank0: this.prgBank0, prgBank1: this.prgBank1,
            prgBank2: this.prgBank2, prgBank3: this.prgBank3,
            chrBank0FD: this.chrBank0FD, chrBank0FE: this.chrBank0FE,
            chrBank1FD: this.chrBank1FD, chrBank1FE: this.chrBank1FE,
            latch0: this.latch0, latch1: this.latch1
        };
    }

    fromJSON(state) {
        this.prgBank0 = state.prgBank0; this.prgBank1 = state.prgBank1;
        this.prgBank2 = state.prgBank2; this.prgBank3 = state.prgBank3;
        this.chrBank0FD = state.chrBank0FD; this.chrBank0FE = state.chrBank0FE;
        this.chrBank1FD = state.chrBank1FD; this.chrBank1FE = state.chrBank1FE;
        this.latch0 = state.latch0; this.latch1 = state.latch1;
    }
}

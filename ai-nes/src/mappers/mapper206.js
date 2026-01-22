// Mapper 206: DxROM - Extension mapper chip based on MMC3 but with differences in IRQ and bank switching
// Used by: Gauntlet
//
// Features:
//   - MMC3-based bank switching
//   - No Scanline IRQ
//   - PRG Mode 0 and CHR Mode 0 fixed
//   - PRG-RAM disabled
//
// References:
//   - https://wiki.nesdev.com/w/index.php/DxROM

import Mapper004 from './mapper004.js';

export default class Mapper206 extends Mapper004 {
    constructor(cartridge) {
        super(cartridge);
        // DxROM (Namco 108) is a subset of MMC3
        // No Scanline IRQ
        this.hasScanlineIrq = false;
    }

    reset() {
        super.reset();
        // DxROM is hardwired to PRG Mode 0 and CHR Mode 0
        this.prgMode = 0;
        this.chrMode = 0;
        this.updateBanks();
        // Gauntlet has no WRAM. Disable it to ensure open bus behavior if read.
        this.prgRamEnabled = false;
        this.prgRamWriteProtect = true;
    }

    cpuWrite(address, data) {
        // DxROM only responds to $8000-$9FFF
        // It ignores Mirroring ($A000), IRQ ($C000/$E000), etc.
        
        if (address >= 0x8000 && address <= 0x9FFF) {
            const reg = address & 1;
            if (reg === 0) {
                // $8000: Bank Select
                // DxROM ignores bits 6-7 (Mode bits), effectively forcing Mode 0
                this.bankSelect = data & 0x07;
                this.prgMode = 0;
                this.chrMode = 0;
                this.updateBanks();
            } else {
                // $8001: Bank Data
                switch (this.bankSelect) {
                    case 0:
                        this.reg[0] = data & 0xFE;
                        break;
                    case 1:
                        this.reg[1] = data & 0xFE;
                        break;
                    case 2:
                        this.reg[2] = data;
                        break;
                    case 3:
                        this.reg[3] = data;
                        break;
                    case 4:
                        this.reg[4] = data;
                        break;
                    case 5:
                        this.reg[5] = data;
                        break;
                    case 6:
                        this.reg[6] = data & 0x3F;
                        break;
                    case 7:
                        this.reg[7] = data & 0x3F;
                        break;
                }
                this.updateBanks();
            }
        }
    }
}
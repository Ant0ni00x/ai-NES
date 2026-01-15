// Mapper 007: AxROM
// Used by: Battletoads, Cobra Triangle, Wizards and Warriors Games
//
// Features:
//   - 32KB PRG bank switching
//   - 1KB VRAM page switching for nametables (Single Screen Mirroring)
// References:
//   - https://wiki.nesdev.com/w/index.php/AxROM
 
import Mapper from './mapper-base.js';

export default class Mapper007 extends Mapper {
    constructor(cartridge) {
        super(cartridge);
        this.prgBank = 0;
        this.mirroring = 0;
        
        // AxROM uses CHR-RAM (8KB)
        this.useVRAM(8);
        
        this.reset();
    }

    reset() {
        this.prgBank = 0;
        this.mirroring = 0;
        this.updateState();
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
            // AxROM: 32KB Bank Select + Mirroring
            // 7  bit  0
            // ---- ----
            // ...M PPPP
            //    | ||||
            //    | ++++- Select 32KB PRG ROM bank
            //    +------ Select 1KB VRAM page for all 4 nametables (Single Screen Mirroring)
            
            this.prgBank = data & 0x0F;
            this.mirroring = (data >> 4) & 0x01;
            this.updateState();
        }
    }

    updateState() {
        // PRG Banking (32KB)
        this.switch32kPrgBank(this.prgBank);

        // Mirroring
        // 0 = Single Screen A (Lower) -> PPU Mode 2
        // 1 = Single Screen B (Upper) -> PPU Mode 3
        if (this.nes && this.nes.ppu) {
            this.nes.ppu.setMirroring(this.mirroring === 0 ? 2 : 3);
        }
    }
}

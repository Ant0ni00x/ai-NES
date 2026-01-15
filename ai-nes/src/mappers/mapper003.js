// Mapper 003: (CNROM)
// Used by: Chase H.Q., Mighty Bomb Jack, Super Spike V'Ball
//
// Features:
//   - 32KB PRG bank (fixed)
//   - 8KB CHR bank switching
// References:
//   - https://wiki.nesdev.com/w/index.php/CNROM

import Mapper from './mapper-base.js';

export default class Mapper003 extends Mapper {
    constructor(cartridge) {
        super(cartridge);
        this.chrBank = 0;

        // CNROM typically uses CHR-ROM, but if no CHR-ROM is present, use CHR-RAM
        if (!this.chrData || this.chrData.length === 0) {
            this.useVRAM(8); // Allocate 8KB of CHR-RAM
        }

        this.reset();
    }

    reset() {
        this.chrBank = 0;
        this.updateBanks();

        // Set mirroring from ROM header
        if (this.nes && this.nes.rom) {
            this.nes.ppu.setMirroring(this.nes.rom.getMirroringType());
        }
    }

    updateBanks() {
        // PRG Banking (Fixed)
        // CNROM usually has 32KB PRG. If 16KB, it's mirrored.
        if (this.get32kPrgBankCount() > 0) {
            this.switch32kPrgBank(0);
        } else {
            // 16KB ROM mirrored to both slots
            this.switch16kPrgBank(0, true);
            this.switch16kPrgBank(0, false);
        }

        // CHR Banking (Switchable 8KB)
        this.switch8kChrBank(this.chrBank);
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
        // CNROM: Writes to $8000-$FFFF set CHR bank
        if (address >= 0x8000) {
            // Bus Conflict: The value written is ANDed with the ROM value at the address
            const slot = (address >> 13) & 0x03;
            const offset = address & 0x1FFF;
            const romValue = this.prgData[this.prgPagesMap[slot] + offset];

            // CNROM boards only use the low 2 bits of the written value
            // to select the 8KB CHR bank.
            this.chrBank = (data & romValue) & 0x03;
            this.updateBanks();
        }
    }

    toJSON() {
        return {
            chrBank: this.chrBank,
            chrRam: this.usingChrRam ? Array.from(this.chrRam) : null
        };
    }

    fromJSON(state) {
        this.chrBank = state.chrBank;
        if (state.chrRam) {
            this.chrRam = new Uint8Array(state.chrRam);
            this.chrData = this.chrRam; // Update base class reference
            this.usingChrRam = true;
        }
        this.updateBanks();
    }
}

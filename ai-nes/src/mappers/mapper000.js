// Mapper 000: (NROM)
// Used by: Donkey Kong, Super Mario Bros, Excitebike, etc.
//
// Features:
//   - Fixed PRG and CHR banks (no bank switching)
//   - PRG-ROM: 16KB or 32KB
//   - PRG-RAM: 8KB optional
//   - CHR-ROM: 8KB or none (uses CHR-RAM if none)
// References:
//   - https://wiki.nesdev.com/w/index.php/NROM

import Mapper from './mapper-base.js';

export default class Mapper000 extends Mapper {
    constructor(cartridge) {
        super(cartridge);

        this.reset();
    }

    reset() {
        console.log(`[Mapper000] Reset called - PRG banks: ${this.prgBankCount}, CHR banks: ${this.chrBankCount}`);

        // PRG bank initialization
        if (this.get32kPrgBankCount() >= 1) {
            // 32KB ROM: Map entire bank 0 to all slots
            this.switch32kPrgBank(0);
            console.log(`[Mapper000] Mapped 32KB PRG bank 0`);
        } else if (this.get16kPrgBankCount() === 1) {
            // 16KB ROM: Mirror bank 0 to both low and high regions
            this.switch16kPrgBank(0, true);  // Map to $8000-$BFFF
            this.switch16kPrgBank(0, false); // Map to $C000-$FFFF (mirror)
            console.log(`[Mapper000] Mapped 16KB PRG bank 0 (mirrored)`);
        }

        // CHR bank initialization
        if (this.get1kChrBankCount() === 0) {
            // No CHR-ROM: Use CHR-RAM
            console.log(`[Mapper000] No CHR-ROM detected, using CHR-RAM`);
            this.useVRAM();
        } else {
            // CHR-ROM present: Map bank 0 to all slots
            console.log(`[Mapper000] CHR-ROM present (${this.chrBankCount} x 1KB banks), mapping bank 0`);
            console.log(`[Mapper000] chrData length: ${this.chrData ? this.chrData.length : 'null'}`);
            console.log(`[Mapper000] get8kChrBankCount: ${this.get8kChrBankCount()}`);
            this.switch8kChrBank(0);
            console.log(`[Mapper000] CHR page map after switch8kChrBank(0):`, Array.from(this.chrPagesMap));
        }

        // Set mirroring from ROM header
        if (this.nes && this.nes.rom) {
            this.nes.ppu.setMirroring(this.nes.rom.getMirroringType());
            console.log(`[Mapper000] Set mirroring to: ${this.nes.rom.getMirroringType()}`);
        }
    }

    cpuRead(address) {
        // PRG-RAM: $6000-$7FFF
        if (address >= 0x6000 && address < 0x8000) {
            return this.prgRam[address - 0x6000];
        }

        // PRG-ROM: $8000-$FFFF (use page map for bank switching)
        if (address >= 0x8000) {
            if (!this.prgData || this.prgBankCount === 0) return 0;

            // Determine which 8KB slot (0-3) this address falls into
            const slot = (address >> 13) & 0x03; // bits 13-14
            const offsetInSlot = address & 0x1FFF; // bits 0-12
            const bankOffset = this.prgPagesMap[slot];

            return this.prgData[bankOffset + offsetInSlot];
        }
        return undefined;
    }

    cpuWrite(address, data) {
        // PRG-RAM: $6000-$7FFF (writable)
        if (address >= 0x6000 && address < 0x8000) {
            this.prgRam[address - 0x6000] = data;
        }
        // Writes to $8000+ are ignored (ROM is read-only)
    }

    // Save state support
    toJSON() {
        const state = { prgRam: Array.from(this.prgRam) };
        return state;
    }

    fromJSON(state) {
        if (state.prgRam) {
            this.prgRam = new Uint8Array(state.prgRam);
        }
    }
}

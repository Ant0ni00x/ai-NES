// Mapper 006: (MMC6)
// Used by: StarTropics, StarTropics II
//
// Features:
//   - Extension of MMC3
//   - 1KB internal PRG-RAM at $7000-$73FF (mirrored at $7400-$7FFF)
//   - Unique WRAM protection via $A001 (bits 4-7 control read/write for each 512B half)
//
// References:
//   - https://wiki.nesdev.com/w/index.php/MMC6

import Mapper004 from './mapper004.js';

export default class Mapper006 extends Mapper004 {
    constructor(cartridge) {
        super(cartridge);
        // MMC6 has 1KB internal RAM, not 8KB external
        this.prgRam = new Uint8Array(1024);
        this.ramControl = 0xF0; // Power-on state: All RAM R/W enabled
    }

    reset() {
        super.reset();
        this.ramControl = 0xF0; // Power-on state: All RAM R/W enabled
    }

    loadROM() {
        // We override loadROM to handle MMC6-specific RAM loading safely.
        // Mapper004.loadROM attempts to load battery RAM into prgRam assuming 8KB size,
        // which can crash if prgRam is 1KB (MMC6) and the save file is larger.

        if (!this.nes.rom.valid) throw new Error("MMC6: Invalid ROM!");

        // Power-on state (copied from Mapper004)
        this.reg.fill(0);
        this.prgMode = 0;
        this.chrMode = 0;
        this.bankSelect = 0;
        this.irqEnabled = false;
        this.irqCounter = 0;
        this.irqLatch = 0;
        this.irqReload = false;
        this.prgRamEnabled = true;
        this.prgRamWriteProtect = false;

        // MMC6 RAM Loading
        if (this.nes.rom.batteryRam && this.nes.rom.batteryRam.length > 0) {
             const len = Math.min(this.nes.rom.batteryRam.length, this.prgRam.length);
             for(let i=0; i<len; i++) {
                 this.prgRam[i] = this.nes.rom.batteryRam[i];
             }
        } else {
             // Force 0x00 initialization for StarTropics if no save exists.
             // Random values can cause it to hang or glitch on boot (static noise).
             this.prgRam.fill(0);
        }

        this.updateBanks();
        this.reset(); // Calls Mapper006.reset -> super.reset

        this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);

        // Mirroring (copied from Mapper004)
        if (this.nes && this.nes.rom) {
            if (!this.nes.rom.fourScreen) {
                const mirroring = (this.nes.rom.getMirroringType() === this.nes.rom.VERTICAL_MIRRORING)
                    ? this.nes.rom.VERTICAL_MIRRORING
                    : this.nes.rom.HORIZONTAL_MIRRORING;
                this.nes.ppu.setMirroring(mirroring);
            }
        }
    }

    cpuRead(address) {
        // MMC6 RAM is at $7000-$7FFF (1KB mirrored)
        if (address >= 0x7000 && address < 0x8000) {
            const offset = address & 0x3FF; // 1KB mask
            const bank = (offset < 0x200) ? 0 : 1; // Lower or Upper 512 bytes
            
            // Read enable bits: Bit 6 for bank 0, Bit 7 for bank 1
            const enableBit = (bank === 0) ? 0x40 : 0x80;
            
            if (this.ramControl & enableBit) {
                return this.prgRam[offset];
            }
            return (address >> 8) & 0xFF; // Open bus behavior
        }
        
        // $6000-$6FFF is open bus on MMC6
        if (address >= 0x6000 && address < 0x7000) {
            return (address >> 8) & 0xFF;
        }

        return super.cpuRead(address);
    }

    cpuWrite(address, data) {
        // MMC6 RAM writes ($7000-$7FFF)
        if (address >= 0x7000 && address < 0x8000) {
            const offset = address & 0x3FF;
            const bank = (offset < 0x200) ? 0 : 1;
            
            // Write enable bits: Bit 4 for bank 0, Bit 5 for bank 1
            const enableBit = (bank === 0) ? 0x10 : 0x20;
            
            if (this.ramControl & enableBit) {
                this.prgRam[offset] = data;
            }
            return;
        }

        // $6000-$6FFF is open bus on MMC6, ignore writes.
        // Prevents fall-through to Mapper004 which would write to the 1KB PRG-RAM.
        if (address >= 0x6000 && address < 0x7000) {
            return;
        }
        
        // Intercept $A001 (MMC6 RAM Control)
        // We must NOT let Mapper004 handle this, as it interprets it as WRAM Disable
        if ((address & 0xE001) === 0xA001) {
            this.ramControl = data;
            return;
        }

        super.cpuWrite(address, data);
    }

    toJSON() {
        const s = super.toJSON();
        s.ramControl = this.ramControl;
        // No need to save prgRam again, superclass does it
        return s;
    }

    fromJSON(s) {
        super.fromJSON(s);
        // Default to 0xF0 if loading an older save state
        this.ramControl = (s.ramControl !== undefined) ? s.ramControl : 0xF0;
        // Ensure RAM is correct size if restored from generic state
        if (this.prgRam.length !== 1024) {
             const old = this.prgRam;
             this.prgRam = new Uint8Array(1024);
             for(let i=0; i<1024 && i<old.length; i++) this.prgRam[i] = old[i];
        }
    }
}
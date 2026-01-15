// Mapper 001: (MMC1)
// Used by: Legend of Zelda, Metroid, Dragon Warrior, Final Fantasy, etc.
//
// Features:
//   - PRG-ROM banking (16KB or 32KB modes)
//   - CHR-ROM/RAM banking (4KB or 8KB modes)
//   - PRG-RAM with optional battery backup
//   - Programmable mirroring
// References:
//   - https://wiki.nesdev.com/w/index.php/MMC1

import Mapper from './mapper-base.js';

export default class Mapper001 extends Mapper {
    constructor(cartridge) {
        super(cartridge);
        
        // PRG-ROM data (flat Uint8Array)
        this.prg = cartridge.prg;
    }

    reset() {
        // Soft Reset: MMC1 registers are NOT cleared.
        // Only the shift register is reset to a known state.
        this.shiftRegister = 0;
        this.shiftRegister = 0x10;
        this.writeCount = 0;
        this.lastWriteInstruction = -1; // Also reset write protection
        this.wramDisable = false; // Ensure WRAM is enabled on reset

        // Re-apply current state to PPU/internal offsets in case PPU was reset
        this.updateBankOffsets();
        this.updateMirroring();
    }

    loadROM() {
        if (!this.nes.rom.valid) throw new Error("MMC1: Invalid ROM!");

        // Initialize properties based on ROM data
        this.prg = this.nes.rom.prg;
        this.prgSize = this.prg ? this.prg.length : 0;
        this.prgBankCount = Math.floor(this.prgSize / 0x4000); // Number of 16KB banks

        // Validate PRG bank count is power of 2 for proper masking
        if (this.prgBankCount > 0 && (this.prgBankCount & (this.prgBankCount - 1)) !== 0) {
            console.warn(`[Mapper001] PRG bank count ${this.prgBankCount} is not power-of-2, masking may be inaccurate`);
        }

        // CHR-ROM/RAM data
        this.chr = this.nes.rom.chr;
        this.chrSize = this.chr ? this.chr.length : 0;
        
        // If no CHR-ROM, create CHR-RAM (8KB)
        if (this.chrSize === 0) {
            console.log("[Mapper001] No CHR-ROM detected, creating 8KB CHR-RAM");
            this.chrRam = new Uint8Array(0x2000);
            this.usingChrRam = true;
            this.chrData = this.chrRam; // Update base class reference
        } else {
            console.log(`[Mapper001] CHR-ROM detected: ${this.chrSize} bytes`);
            this.usingChrRam = false;
            this.chrData = this.chr;
        }

        // PRG-RAM at $6000-$7FFF (8KB)
        // Heuristic: Enable WRAM only if CHR-RAM is used OR battery is present.
        // SLROM boards (CHR-ROM) typically do not have WRAM.
        // Pugsley's Scavenger Hunt (SLROM) fails if WRAM is detected.
        const romBattery = this.nes.rom.batteryRam;
        const hasBattery = (romBattery === true) || (romBattery && romBattery.length > 0);
        this.hasPrgRam = this.usingChrRam || hasBattery;

        // Pugsley's Scavenger Hunt (SLROM) fails if WRAM is detected.
        // We check the CRC32 to explicitly disable WRAM for this game.
        if (this.nes.rom.getCRC32) {
            const crc = this.nes.rom.getCRC32().toString(16).toUpperCase();
            if (crc === '63E5653' || crc === '2696C69C') {
                console.log(`[Mapper001] Detected Pugsley's Scavenger Hunt (CRC: ${crc}). Disabling WRAM.`);
                this.hasPrgRam = false;
            }
        }
        
        this.prgRam = this.hasPrgRam ? new Uint8Array(0x2000) : null;
        // Initialize WRAM to 0x00. While some games prefer 0xFF for cold boot detection,
        // Dragon Warrior 3 appears to hang/glitch if initialized to 0xFF.
        if (this.prgRam) this.prgRam.fill(0x00);

        // Pre-calculated offsets for fast reads
        this.prgBank0Offset = 0;
        this.prgBank1Offset = 0;
        this.chrBank0Offset = 0;
        this.chrBank1Offset = 0;
        
        // Power-on / Hard Reset initialization
        this.shiftRegister = 0;
        this.shiftRegister = 0x10;
        this.writeCount = 0;
        this.lastWriteInstruction = -1;
        // MMC1 Registers
        this.controlRegister = 0x0C; // Power-on default: PRG mode 3

        // Initialize mirroring from ROM header to match hardware configuration
        // MMC1 Control: 2=Vertical, 3=Horizontal
        // ROM: 1=Vertical, 0=Horizontal
        if (this.nes.rom.getMirroringType() === 1) {
             this.controlRegister = (this.controlRegister & 0xFC) | 0x02;
             console.log("[Mapper001] Init: Set Vertical mirroring from header");
        } else {
             this.controlRegister = (this.controlRegister & 0xFC) | 0x03;
             console.log("[Mapper001] Init: Set Horizontal mirroring from header");
        }

        this.chrBank0 = 0;
        this.chrBank1 = 0;
        this.prgBank = 0;

        // WRAM disable flag (bit 4 of PRG bank register)
        this.wramDisable = false;
        
        this.updateBankOffsets();
        this.updateMirroring(); // Apply power-on mirroring
        
        this.loadBatteryRam();
        this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
    }

    loadBatteryRam() {
        // Load battery-backed RAM if provided by the ROM loader
        if (this.hasPrgRam && this.nes.rom.batteryRam && this.nes.rom.batteryRam.length && typeof this.nes.rom.batteryRam !== 'boolean') {
            // Copy to internal prgRam
            // Note: ROM.batteryRam might be a boolean flag or a byte array
            this.prgRam.set(this.nes.rom.batteryRam);
        }
    }

    cpuRead(address) {
        // PRG-RAM: $6000-$7FFF
        if (address >= 0x6000 && address < 0x8000) {
            // Return open bus (approx high byte) if WRAM is disabled/missing
            // Returning 0 can cause false positives for WRAM detection (e.g. Pugsley's Scavenger Hunt)
            if (!this.hasPrgRam || this.wramDisable) return (address >> 8) & 0xFF;
            return this.prgRam[address - 0x6000] || 0;
        }

        // PRG-ROM Bank 0: $8000-$BFFF
        if (address >= 0x8000 && address < 0xC000) {
            const offset = this.prgBank0Offset + (address & 0x3FFF);
            return this.prg[offset] || 0;
        }

        // PRG-ROM Bank 1: $C000-$FFFF
        if (address >= 0xC000) {
            const offset = this.prgBank1Offset + (address & 0x3FFF);
            return this.prg[offset] || 0;
        }

        return undefined;
    }

    // Alias for PAPU DMC channel (audio samples)
    load(address) {
        return this.cpuRead(address);
    }

    cpuWrite(address, data) {
        // PRG-RAM: $6000-$7FFF
        if (address >= 0x6000 && address < 0x8000) {
            // Only allow writes if WRAM is enabled
            if (this.hasPrgRam && !this.wramDisable) {
                this.prgRam[address - 0x6000] = data;
            }
            return;
        }

        // MMC1 register writes: $8000-$FFFF
        if (address >= 0x8000) {
            this.writeRegister(address, data);
        }
    }

    writeRegister(address, data) {
        // MMC1 timing: Ignore writes within 2 CPU cycles of previous write
        // This prevents hardware glitches from corrupting the shift register
        if (this.nes && this.nes.cpu) {
            // This check is critical. On real hardware, writes on consecutive
            // CPU cycles are ignored. The new cycle-accurate timing exposes this.
            // We use instructionCount to distinguish between RMW writes (same instruction, ignore)
            // and consecutive instructions (different instruction, accept).
            const currentInstruction = this.nes.cpu.instructionCount;
            if (currentInstruction === this.lastWriteInstruction) {
                return;
            }
            this.lastWriteInstruction = currentInstruction;
        }

        // Bit 7 set = reset shift register
        if (data & 0x80) {
            this.shiftRegister = 0;
            this.shiftRegister = 0x10;
            this.writeCount = 0;
            // Reset also sets PRG mode to 3 (fix last bank at $C000)
            this.controlRegister |= 0x0C;
            this.updateBankOffsets();
            this.updateMirroring();
            return;
        }

        // Shift in the low bit of data
        this.shiftRegister = ((this.shiftRegister >> 1) | ((data & 1) << 4)) & 0x1F;
        this.writeCount++;

        // After 5 writes, apply the register value
        if (this.writeCount === 5) {
            const registerIndex = (address >> 13) & 0x03; // Bits 13-14 select register
            this.applyRegister(registerIndex, this.shiftRegister);

            // Reset for next write sequence
            this.shiftRegister = 0;
            this.shiftRegister = 0x10;
            this.writeCount = 0;
        }
    }

    applyRegister(regIndex, value) {
        switch (regIndex) {
            case 0: // Control ($8000-$9FFF)
                this.controlRegister = value;
                this.updateMirroring();
                this.updateBankOffsets();
                break;

            case 1: // CHR Bank 0 ($A000-$BFFF)
                this.chrBank0 = value;
                this.updateBankOffsets();
                break;

            case 2: // CHR Bank 1 ($C000-$DFFF)
                this.chrBank1 = value;
                this.updateBankOffsets();
                break;

            case 3: // PRG Bank ($E000-$FFFF)
                this.prgBank = value & 0x0F;
                // Bit 4 controls WRAM disable
                this.wramDisable = (value & 0x10) !== 0;
                this.updateBankOffsets();
                break;
        }
    }

    updateMirroring() {
        if (!this.nes || !this.nes.ppu) return;
    
        const mirrorMode = this.controlRegister & 0x03;
        let newPpuMirroring = -1;
        let modeDesc = "";
    
        // MMC1 Mirroring Modes:
        // 0: one-screen, lower bank
        // 1: one-screen, upper bank
        // 2: vertical
        // 3: horizontal
        switch (mirrorMode) {
            case 0: newPpuMirroring = 2; modeDesc = "Single-screen 0 (Low Bank)"; break;
            case 1: newPpuMirroring = 3; modeDesc = "Single-screen 1 (High Bank)"; break;
            case 2: newPpuMirroring = 1; modeDesc = "Vertical"; break;
            case 3: newPpuMirroring = 0; modeDesc = "Horizontal"; break;
            default: newPpuMirroring = 0; modeDesc = "Unknown (Horizontal)"; break; // Safety fallback
        }  
        if (newPpuMirroring !== -1 && this.nes.ppu.mirroring !== newPpuMirroring) {
            console.log(`[Mapper001] Mirroring changed: ${modeDesc} (MMC1=${mirrorMode}, PPU=${newPpuMirroring})`);
            this.nes.ppu.setMirroring(newPpuMirroring);
        }
    }

    updateBankOffsets() {
        const prgMode = (this.controlRegister >> 2) & 0x03;
        const chrMode = (this.controlRegister >> 4) & 0x01;

        // PRG Banking
        const lastBank = this.prgBankCount - 1;
        const prgBankMask = this.prgBankCount > 0 ? this.prgBankCount - 1 : 0;

        // Support for 512KB PRG (SUROM/SXROM):
        // Bit 4 of CHR bank registers is used as bit 4 of PRG bank number.
        // This applies to ALL PRG modes for SUROM.
        let prgHighBit = 0;
        if (this.prgBankCount > 16) { // > 256KB (e.g. 512KB)
            if (chrMode === 0) { 
                // 8KB CHR mode: Use CHR Bank 0 (Reg 1) bit 4
                prgHighBit = (this.chrBank0 & 0x10) ? 16 : 0;
            } else { 
                // 4KB CHR mode: Use CHR Bank 1 (Reg 2) bit 4
                prgHighBit = (this.chrBank1 & 0x10) ? 16 : 0;
            }
        }

        switch (prgMode) {
            case 0:
            case 1:
                // 32KB mode: switch 32KB at $8000. Low bit of bank is ignored.
                const bank32 = (((this.prgBank & 0xE) | prgHighBit) >> 1);
                this.prgBank0Offset = bank32 * 0x8000;
                this.prgBank1Offset = this.prgBank0Offset + 0x4000;
                break;

            case 2:
                // Fix first bank at $8000, switch 16KB bank at $C000
                this.prgBank0Offset = prgHighBit * 0x4000;
                this.prgBank1Offset = (((this.prgBank & 0xF) | prgHighBit) & prgBankMask) * 0x4000;
                break;

            case 3:
                // Switch 16KB bank at $8000, fix last bank at $C000
                // For 512KB ROMs, the fixed bank is the last bank of the selected 256KB block.
                this.prgBank0Offset = (((this.prgBank & 0xF) | prgHighBit) & prgBankMask) * 0x4000;
                this.prgBank1Offset = ((0x0F | prgHighBit) & prgBankMask) * 0x4000;
                break;
        }

        // CHR Banking
        const chrBankCount = this.usingChrRam ? 2 : (this.chrSize / 0x1000); // 4KB banks (assume 8KB CHR-RAM)
        const chrBankMask = (chrBankCount > 0) ? chrBankCount - 1 : 0;

        if (chrMode === 0) {
            // 8KB mode: use chrBank0, ignoring low bit
            const bank8 = (this.chrBank0 & 0x1E) & chrBankMask;
            this.chrBank0Offset = bank8 * 0x1000;
            this.chrBank1Offset = ((bank8 + 1) & chrBankMask) * 0x1000;
            
            // Update standard page map for consistency/debug
            for (let i = 0; i < 4; i++) this.chrPagesMap[i] = this.chrBank0Offset + (i * 0x400);
            for (let i = 0; i < 4; i++) this.chrPagesMap[i+4] = this.chrBank1Offset + (i * 0x400);
        } else {
            // 4KB mode: independent banks
            this.chrBank0Offset = (this.chrBank0 & chrBankMask) * 0x1000;
            this.chrBank1Offset = (this.chrBank1 & chrBankMask) * 0x1000;
            
            // Update standard page map for consistency/debug
            for (let i = 0; i < 4; i++) this.chrPagesMap[i] = this.chrBank0Offset + (i * 0x400);
            for (let i = 0; i < 4; i++) this.chrPagesMap[i+4] = this.chrBank1Offset + (i * 0x400);
        }
    }

    ppuRead(address, context) {
        // Mapper only handles CHR-ROM/RAM from $0000-$1FFF.
        // For nametables ($2000+), return null to let PPU use internal VRAM.
        if (address >= 0x2000) {
            return null;
        }

        // Use standard property name 'usingChrRam'
        const bankSource = this.usingChrRam ? this.chrRam : this.chr;
        if (!bankSource) return 0;

        if (address < 0x1000) {
            return bankSource[this.chrBank0Offset + address] || 0;
        } else {
            return bankSource[this.chrBank1Offset + (address & 0x0FFF)] || 0;
        }
    }

    ppuWrite(address, data) {
        // Only CHR-RAM is writable
        if (this.usingChrRam && address < 0x2000) {
            if (address < 0x1000) {
                this.chrRam[this.chrBank0Offset + address] = data;
            } else {
                this.chrRam[this.chrBank1Offset + (address & 0x0FFF)] = data;
            }
            return true;
        }
        return false;
    }

    // Save state support
    toJSON() {
        return {
            shiftRegister: this.shiftRegister,
            writeCount: this.writeCount,
            lastWriteInstruction: this.lastWriteInstruction,
            controlRegister: this.controlRegister,
            chrBank0: this.chrBank0,
            chrBank1: this.chrBank1,
            prgBank: this.prgBank,
            wramDisable: this.wramDisable,
            prgRam: this.prgRam ? Array.from(this.prgRam) : null,
            hasPrgRam: this.hasPrgRam,
            chrRam: this.usingChrRam ? Array.from(this.chrRam) : null
        };
    }

    fromJSON(state) {
        this.shiftRegister = state.shiftRegister;
        this.writeCount = state.writeCount;
        this.lastWriteInstruction = state.lastWriteInstruction || -1;
        this.controlRegister = state.controlRegister;
        this.chrBank0 = state.chrBank0;
        this.chrBank1 = state.chrBank1;
        this.prgBank = state.prgBank;
        this.wramDisable = state.wramDisable || false;
        this.hasPrgRam = (state.hasPrgRam !== undefined) ? state.hasPrgRam : (!!state.prgRam);
        if (state.prgRam) {
            this.prgRam = new Uint8Array(state.prgRam);
        } else {
            this.prgRam = this.hasPrgRam ? new Uint8Array(0x2000) : null;
        }
        if (state.chrRam) {
            this.chrRam = new Uint8Array(state.chrRam);
        }
        this.updateBankOffsets();
        this.updateMirroring();
    }
}

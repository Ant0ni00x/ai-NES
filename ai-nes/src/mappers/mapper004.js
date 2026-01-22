// Mapper 004: (MMC3)
// Used by: Super Mario Bros. 3, Kirby's Adventure
//
// Features:
//   - Complex PRG/CHR bank switching
//   - Scanline-based IRQ counter
//   - PRG-RAM with write protection
//   - Switchable mirroring
//
// References:
//   - https://wiki.nesdev.com/w/index.php/MMC3

import Mapper from './mapper-base.js';

export default class Mapper004 extends Mapper {
    constructor(cartridge) {
        super(cartridge);
        this.hasScanlineIrq = true; // Inform PPU to call clockScanline() on A12 rising edge

        if (this.get1kChrBankCount() === 0) {
            this.useVRAM(8); // 8KB of CHR-RAM
        }
        
        // Initialize state containers
        this.reg = new Uint8Array(8);
        this.prgOffsets = new Uint32Array(4);
        this.chrOffsets = new Uint32Array(8);
        this.prgRam = new Uint8Array(0x2000);
        this.fillRam(this.prgRam); // Apply global RAM initialization pattern
    }

    reset() {
        // Soft Reset: MMC3 registers are NOT cleared.
        // IRQ counter is not affected by reset.
        // We only ensure the fixed bank is correct, just in case.
        this.prgOffsets[3] = (this.get8kPrgBankCount() - 1) << 13; // << 13 = * 0x2000
    }

    loadROM() {
        if (!this.nes.rom.valid) throw new Error("MMC3: Invalid ROM!");

        // Power-on state: Clear registers
        this.reg.fill(0);
        this.prgMode = 0;
        this.chrMode = 0;
        this.bankSelect = 0;
        this.irqEnabled = false;
        this.irqCounter = 0;
        this.irqLatch = 0;
        this.irqReload = false;
        this.prgRamEnabled = true; // Enabled by default on MMC3
        this.prgRamWriteProtect = false;

        // Load Battery RAM if available
        if (this.nes.rom.batteryRam) this.prgRam.set(this.nes.rom.batteryRam);

        // Apply initial banking
        this.updateBanks();
        
        // Apply subclass reset logic (e.g. Mapper 206 constraints)
        this.reset();

        this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);

        // Initialize mirroring from ROM header
        if (this.nes && this.nes.rom) {
            if (!this.nes.rom.fourScreen) {
                const mirroring = (this.nes.rom.getMirroringType() === this.nes.rom.VERTICAL_MIRRORING)
                    ? this.nes.rom.VERTICAL_MIRRORING
                    : this.nes.rom.HORIZONTAL_MIRRORING;
                this.nes.ppu.setMirroring(mirroring);
            }
        }
    }

    cpuWrite(address, data) {
        if (address >= 0x6000 && address < 0x8000) {
            if (this.prgRamEnabled && !this.prgRamWriteProtect) {
                this.prgRam[address - 0x6000] = data;
            }
            return;
        }

        if (address < 0x8000) return;

        const reg = address & 1;
        const base = address & 0xE000;

        switch (base) {
            case 0x8000: // Bank select/data
                if (reg === 0) {
                    // Bank Select ($8000, even)
                    this.prgMode = (data >> 6) & 1;
                    this.chrMode = (data >> 7) & 1;
                    this.bankSelect = data & 7;
                    this.updateBanks();
                } else {
                    // Bank Data ($8001, odd)
                    this.reg[this.bankSelect] = data;
                    this.updateBanks();
                }
                break;

            case 0xA000: // Mirroring and PRG RAM protect
                if (reg === 0) {
                    // Mirroring ($A000, even)
                    if (this.nes.rom.fourScreen) return;
                    const mirroring = (data & 1) ? this.nes.rom.HORIZONTAL_MIRRORING : this.nes.rom.VERTICAL_MIRRORING;
                    this.nes.ppu.setMirroring(mirroring);
                } else {
                    // PRG RAM Protect ($A001, odd)
                    this.prgRamEnabled = (data & 0x80) !== 0;
                    this.prgRamWriteProtect = (data & 0x40) !== 0;
                }
                break;

            case 0xC000: // IRQ Latch/Reload
                if (reg === 0) {
                    this.irqLatch = data;
                } else {
                    // Writing to $C001 just sets the reload flag. The counter is reloaded
                    // on the next clock from the PPU.
                    this.irqReload = true;
                }
                break;

            case 0xE000: // IRQ Disable/Enable
                if (reg === 0) {
                    this.irqEnabled = false;
                    if (this.nes.cpu.clearIrq) {
                        this.nes.cpu.clearIrq(this.nes.cpu.IRQ_NORMAL);
                    }
                } else {
                    this.irqEnabled = true;
                }
                break;
        }
    }

    cpuRead(address) {
        if (address >= 0x6000 && address < 0x8000) {
            if (!this.prgRamEnabled) return (address >> 8) & 0xFF; // Open bus
            return this.prgRam[address - 0x6000];
        }

        if (address >= 0x8000) {
            const slot = (address >> 13) & 0x03;
            const offset = address & 0x1FFF;
            return this.prgData[this.prgOffsets[slot] + offset];
        }
        return undefined;
    }

    ppuRead(address) {
        if (address < 0x2000) {
            const bankSource = this.usingChrRam ? this.chrRam : this.chrData;
            const slot = address >> 10;
            const offset = address & 0x03FF;
            // Fallback to 0 for out-of-bounds reads, preventing `undefined` from poisoning the render pipeline.
            return bankSource[this.chrOffsets[slot] + offset] || 0;
        }
        return null;
    }

    ppuWrite(address, data) {
        if (this.usingChrRam && address < 0x2000) {
            const slot = address >> 10;
            const offset = address & 0x03FF;
            this.chrRam[this.chrOffsets[slot] + offset] = data;
            return true;
        }
        return false;
    }

    updateBanks() {
        // CHR Banks (<< 10 = * 0x400 for 1KB banks)
        const chrMask = (this.get1kChrBankCount() > 0) ? this.get1kChrBankCount() - 1 : 0;
        if (this.chrMode === 0) {
            this.chrOffsets[0] = ((this.reg[0] & 0xFE) & chrMask) << 10;
            this.chrOffsets[1] = ((this.reg[0] | 0x01) & chrMask) << 10;
            this.chrOffsets[2] = ((this.reg[1] & 0xFE) & chrMask) << 10;
            this.chrOffsets[3] = ((this.reg[1] | 0x01) & chrMask) << 10;
            this.chrOffsets[4] = (this.reg[2] & chrMask) << 10;
            this.chrOffsets[5] = (this.reg[3] & chrMask) << 10;
            this.chrOffsets[6] = (this.reg[4] & chrMask) << 10;
            this.chrOffsets[7] = (this.reg[5] & chrMask) << 10;
        } else {
            this.chrOffsets[0] = (this.reg[2] & chrMask) << 10;
            this.chrOffsets[1] = (this.reg[3] & chrMask) << 10;
            this.chrOffsets[2] = (this.reg[4] & chrMask) << 10;
            this.chrOffsets[3] = (this.reg[5] & chrMask) << 10;
            this.chrOffsets[4] = ((this.reg[0] & 0xFE) & chrMask) << 10;
            this.chrOffsets[5] = ((this.reg[0] | 0x01) & chrMask) << 10;
            this.chrOffsets[6] = ((this.reg[1] & 0xFE) & chrMask) << 10;
            this.chrOffsets[7] = ((this.reg[1] | 0x01) & chrMask) << 10;
        }

        // PRG Banks (<< 13 = * 0x2000 for 8KB banks)
        const prgMask = (this.get8kPrgBankCount() > 0) ? this.get8kPrgBankCount() - 1 : 0;
        if (this.prgMode === 0) {
            this.prgOffsets[0] = (this.reg[6] & prgMask) << 13;
            this.prgOffsets[1] = (this.reg[7] & prgMask) << 13;
            this.prgOffsets[2] = (this.get8kPrgBankCount() - 2) << 13;
        } else {
            this.prgOffsets[0] = (this.get8kPrgBankCount() - 2) << 13;
            this.prgOffsets[1] = (this.reg[7] & prgMask) << 13;
            this.prgOffsets[2] = (this.reg[6] & prgMask) << 13;
        }

        // $E000 is always fixed to the last bank
        this.prgOffsets[3] = (this.get8kPrgBankCount() - 1) << 13;
    }

    clockScanline() {
        // This is clocked by the PPU on the rising edge of address line A12
        // during pattern table fetches.
        if (this.irqCounter === 0 || this.irqReload) { // Reload condition
            this.irqCounter = this.irqLatch;
            this.irqReload = false;
        } else {
            this.irqCounter--; // Decrement
            // "Old" MMC3 behavior (for SMB3): IRQ is only triggered when the counter decrements to 0.
            if (this.irqCounter === 0 && this.irqEnabled) {
                this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL);
            }
        }
    }

    toJSON() {
        return {
            reg: Array.from(this.reg), prgMode: this.prgMode, chrMode: this.chrMode,
            bankSelect: this.bankSelect, irqEnabled: this.irqEnabled, irqCounter: this.irqCounter,
            irqLatch: this.irqLatch, irqReload: this.irqReload, prgRamEnabled: this.prgRamEnabled,
            prgRamWriteProtect: this.prgRamWriteProtect, prgRam: Array.from(this.prgRam)
        };
    }

    fromJSON(state) {
        this.reg = new Uint8Array(state.reg);
        this.prgMode = state.prgMode; this.chrMode = state.chrMode;
        this.bankSelect = state.bankSelect; this.irqEnabled = state.irqEnabled;
        this.irqCounter = state.irqCounter; this.irqLatch = state.irqLatch;
        this.irqReload = state.irqReload; this.prgRamEnabled = state.prgRamEnabled;
        this.prgRamWriteProtect = state.prgRamWriteProtect;
        this.prgRam = new Uint8Array(state.prgRam);
        this.updateBanks();
    }
}

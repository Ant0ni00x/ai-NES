// Mapper 069: Sunsoft FME-7 / Sunsoft 5B
// Used by: Gimmick!, Hebereke
//
// Features:
//   - 8KB PRG bank switching ($8000-$DFFF) with fixed last bank
//   - 1KB CHR bank switching
//   - Banked RAM/ROM mapping at $6000-$7FFF
//   - 16-bit CPU cycle IRQ counter
// Notes:
//   - Sunsoft 5B audio is not emulated; register writes are tracked only.
// References:
//   - https://www.nesdev.org/wiki/Sunsoft_FME-7

import Mapper from './mapper-base.js';

export default class Mapper069 extends Mapper {
    constructor(cartridge) {
        super(cartridge);

        this.command = 0;
        this.workRamValue = 0;
        this.irqEnabled = false;
        this.irqCounterEnabled = false;
        this.irqCounter = 0;

        this.prgRegs = new Uint8Array(3);
        this.chrRegs = new Uint8Array(8);

        this.prgRam = new Uint8Array(0x8000);
        this.fillRam(this.prgRam);

        this.audioAddress = 0;
        this.audioRegs = new Uint8Array(0x10);

        if (!this.chrData || this.chrData.length === 0) {
            this.useVRAM(8);
        }

        this.reset();
    }

    reset() {
        this.command = 0;
        this.workRamValue = 0;
        this.irqEnabled = false;
        this.irqCounterEnabled = false;
        this.irqCounter = 0;

        this.prgRegs.fill(0);
        this.chrRegs.fill(0);
        this.audioAddress = 0;
        this.audioRegs.fill(0);

        if (this.nes && this.nes.cpu && this.nes.cpu.clearIrq) {
            this.nes.cpu.clearIrq(this.nes.cpu.IRQ_NORMAL);
        }

        if (this.nes && this.nes.rom && this.nes.rom.batteryRam && this.nes.rom.batteryRam.length) {
            const len = Math.min(this.nes.rom.batteryRam.length, this.prgRam.length);
            this.prgRam.set(this.nes.rom.batteryRam.subarray(0, len));
        }

        this.updatePrgBanks();
        this.updateChrBanks();
        this.updateWorkRam();

        if (this.nes && this.nes.rom) {
            this.nes.ppu.setMirroring(this.nes.rom.getMirroringType());
        }
    }

    getOpenBus(address) {
        return (address >> 8) & 0xFF;
    }

    updatePrgBanks() {
        if (!this.prgData || this.prgBankCount === 0) return;
        this.switch8kPrgBank(this.prgRegs[0] & 0x3F, 0);
        this.switch8kPrgBank(this.prgRegs[1] & 0x3F, 1);
        this.switch8kPrgBank(this.prgRegs[2] & 0x3F, 2);
        this.switch8kPrgBank(this.prgBankCount - 1, 3);
    }

    updateChrBanks() {
        for (let i = 0; i < 8; i++) {
            this.switch1kChrBank(this.chrRegs[i], i);
        }
    }

    updateWorkRam() {
        this.workRamBank = this.workRamValue & 0x3F;
        this.workRamUseRam = (this.workRamValue & 0x40) !== 0;
        this.workRamReadWrite = (this.workRamValue & 0x80) !== 0;
    }

    writeAudioRegister(address, value) {
        if ((address & 0xE000) === 0xC000) {
            this.audioAddress = value & 0x0F;
        } else {
            this.audioRegs[this.audioAddress] = value;
        }
    }

    cpuRead(address) {
        if (address >= 0x6000 && address < 0x8000) {
            const offset = address & 0x1FFF;
            if (this.workRamUseRam) {
                if (!this.workRamReadWrite) return this.getOpenBus(address);
                const bankCount = this.prgRam.length / 0x2000;
                const bank = bankCount ? (this.workRamBank % bankCount) : 0;
                return this.prgRam[(bank * 0x2000) + offset] || 0;
            }

            if (!this.prgData || this.prgBankCount === 0) return 0;
            const bank = this.workRamBank % this.prgBankCount;
            return this.prgData[(bank * 0x2000) + offset] || 0;
        }

        if (address >= 0x8000) {
            if (!this.prgData || this.prgBankCount === 0) return 0;
            const slot = (address >> 13) & 0x03;
            const offset = address & 0x1FFF;
            return this.prgData[this.prgPagesMap[slot] + offset] || 0;
        }
        return undefined;
    }

    cpuWrite(address, value) {
        if (address >= 0x6000 && address < 0x8000) {
            if (this.workRamUseRam && this.workRamReadWrite) {
                const bankCount = this.prgRam.length / 0x2000;
                const bank = bankCount ? (this.workRamBank % bankCount) : 0;
                this.prgRam[(bank * 0x2000) + (address & 0x1FFF)] = value;
            }
            return;
        }

        if (address < 0x8000) return;

        switch (address & 0xE000) {
            case 0x8000:
                this.command = value & 0x0F;
                break;

            case 0xA000:
                switch (this.command) {
                    case 0x0:
                    case 0x1:
                    case 0x2:
                    case 0x3:
                    case 0x4:
                    case 0x5:
                    case 0x6:
                    case 0x7:
                        this.chrRegs[this.command] = value;
                        this.updateChrBanks();
                        break;
                    case 0x8:
                        this.workRamValue = value;
                        this.updateWorkRam();
                        break;
                    case 0x9:
                    case 0xA:
                    case 0xB:
                        this.prgRegs[this.command - 0x9] = value & 0x3F;
                        this.updatePrgBanks();
                        break;
                    case 0xC:
                        if (this.nes && this.nes.ppu) {
                            switch (value & 0x03) {
                                case 0x0:
                                    this.nes.ppu.setMirroring(this.nes.rom.VERTICAL_MIRRORING);
                                    break;
                                case 0x1:
                                    this.nes.ppu.setMirroring(this.nes.rom.HORIZONTAL_MIRRORING);
                                    break;
                                case 0x2:
                                    this.nes.ppu.setMirroring(this.nes.rom.SINGLESCREEN_MIRRORING_A);
                                    break;
                                case 0x3:
                                    this.nes.ppu.setMirroring(this.nes.rom.SINGLESCREEN_MIRRORING_B);
                                    break;
                            }
                        }
                        break;
                    case 0xD:
                        this.irqEnabled = (value & 0x01) === 0x01;
                        this.irqCounterEnabled = (value & 0x80) === 0x80;
                        if (this.nes && this.nes.cpu && this.nes.cpu.clearIrq) {
                            this.nes.cpu.clearIrq(this.nes.cpu.IRQ_NORMAL);
                        }
                        break;
                    case 0xE:
                        this.irqCounter = (this.irqCounter & 0xFF00) | value;
                        break;
                    case 0xF:
                        this.irqCounter = (this.irqCounter & 0x00FF) | (value << 8);
                        break;
                }
                break;

            case 0xC000:
            case 0xE000:
                this.writeAudioRegister(address, value);
                break;
        }
    }

    cpuClock(cpuCycles) {
        if (!this.irqCounterEnabled) return;
        for (let i = 0; i < cpuCycles; i++) {
            this.irqCounter = (this.irqCounter - 1) & 0xFFFF;
            if (this.irqCounter === 0xFFFF && this.irqEnabled) {
                if (this.nes && this.nes.cpu && this.nes.cpu.requestIrq) {
                    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL);
                }
            }
        }
    }

    toJSON() {
        return {
            command: this.command,
            workRamValue: this.workRamValue,
            irqEnabled: this.irqEnabled,
            irqCounterEnabled: this.irqCounterEnabled,
            irqCounter: this.irqCounter,
            prgRegs: Array.from(this.prgRegs),
            chrRegs: Array.from(this.chrRegs),
            prgRam: Array.from(this.prgRam),
            audioAddress: this.audioAddress,
            audioRegs: Array.from(this.audioRegs),
            chrRam: this.usingChrRam ? Array.from(this.chrRam) : null
        };
    }

    fromJSON(state) {
        this.command = state.command || 0;
        this.workRamValue = state.workRamValue || 0;
        this.irqEnabled = !!state.irqEnabled;
        this.irqCounterEnabled = !!state.irqCounterEnabled;
        this.irqCounter = state.irqCounter || 0;

        this.prgRegs = new Uint8Array(state.prgRegs || [0, 0, 0]);
        this.chrRegs = new Uint8Array(state.chrRegs || new Array(8).fill(0));

        this.audioAddress = state.audioAddress || 0;
        this.audioRegs = new Uint8Array(state.audioRegs || new Array(0x10).fill(0));

        if (state.prgRam) {
            this.prgRam = new Uint8Array(state.prgRam);
        }

        if (state.chrRam) {
            this.chrRam = new Uint8Array(state.chrRam);
            this.chrData = this.chrRam;
            this.usingChrRam = true;
        }

        this.updatePrgBanks();
        this.updateChrBanks();
        this.updateWorkRam();
    }
}

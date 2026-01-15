// Base Mapper Class For Handling Different Mappers

import { copyArrayElements } from '../utils.js';

export default class Mapper {
    constructor(cartridge) {
        this.cartridge = cartridge;
        this.nes = cartridge.nes; // Reference to NES system

        // Reference ROM data using the correct property names
        // cartridge.prg = flat Uint8Array of PRG-ROM
        // cartridge.chr = flat Uint8Array of CHR-ROM
        this.prgData = cartridge.prg;   // Flat PRG data
        this.chrData = cartridge.chr;   // Flat CHR data

        // Bank counts (WebNES-style)
        // PRG banks are 8KB each, CHR banks are 1KB each
        this.prgBankCount = this.prgData ? (this.prgData.length / 0x2000) : 0; // 8KB banks
        this.chrBankCount = this.chrData ? (this.chrData.length / 0x400) : 0;  // 1KB banks

        // Bank mapping arrays (WebNES-style)
        // PRG: 4 slots of 8KB each ($8000-$9FFF, $A000-$BFFF, $C000-$DFFF, $E000-$FFFF)
        // CHR: 8 slots of 1KB each ($0000-$03FF, $0400-$07FF, ..., $1C00-$1FFF)
        this.prgPagesMap = new Uint32Array(4);  // 4 x 8KB = 32KB PRG address space
        this.chrPagesMap = new Uint32Array(8);  // 8 x 1KB = 8KB CHR address space

        // Initialize page maps to zero (will be set by specific mappers)
        this.prgPagesMap.fill(0);
        // Default CHR mapping (Identity) to support mappers that don't explicitly switch banks (like NROM)
        for (let i = 0; i < 8; i++) {
            this.chrPagesMap[i] = (this.chrBankCount > 0) ? (i % this.chrBankCount) * 0x400 : 0;
        }

        // PRG-RAM (most mappers have 8KB of SRAM at $6000-$7FFF)
        this.prgRam = new Uint8Array(0x2000); // 8KB
        this.fillRam(this.prgRam);

        // CHR-RAM (for cartridges without CHR-ROM)
        this.chrRam = null;
        this.usingChrRam = false;

        // Capability flags - mappers set these to enable PPU features
        this.hasChrLatch = false;     // MMC2/MMC4 style CHR latching
        this.hasScanlineIrq = false;  // MMC3-style A12-based scanline counter
        this.hasNametableOverride = false; // MMC5 ExRAM
        this.hasPpuA13ChrSwitch = false; // MMC5 BG/Sprite CHR modes
    }

    // ==========================================================
    // HELPER FUNCTIONS
    // ==========================================================
    fillRam(ram) {
        if (!ram) return;
        const pattern = this.nes.opts.ramInitPattern;
        if (pattern === 'all_ff') {
            ram.fill(0xFF);
        } else if (pattern === 'random') {
            for (let i = 0; i < ram.length; i++) {
                ram[i] = Math.floor(Math.random() * 256);
            }
        }
    }

    // ==========================================================
    // BANK SWITCHING INFRASTRUCTURE (WebNES-style)
    // ==========================================================
    // PRG bank count helpers
    get8kPrgBankCount() { return this.prgBankCount; }
    get16kPrgBankCount() { return this.prgBankCount >> 1; }
    get32kPrgBankCount() { return this.prgBankCount >> 2; }

    // CHR bank count helpers
    get1kChrBankCount() { return this.chrBankCount; }
    get2kChrBankCount() { return this.chrBankCount >> 1; }
    get4kChrBankCount() { return this.chrBankCount >> 2; }
    get8kChrBankCount() { return this.chrBankCount >> 3; }

    // PRG bank switching
    switch8kPrgBank(bankId, slot) {
        // Map an 8KB PRG bank to one of 4 slots
        // slot 0 = $8000-$9FFF, 1 = $A000-$BFFF, 2 = $C000-$DFFF, 3 = $E000-$FFFF
        const actualBank = bankId % this.prgBankCount;
        this.prgPagesMap[slot] = actualBank * 0x2000; // Store byte offset
    }

    switch16kPrgBank(bankId, lowSlot) {
        // Map a 16KB PRG bank to two consecutive 8KB slots
        // lowSlot true = $8000-$BFFF, false = $C000-$FFFF
        if (this.get16kPrgBankCount() > 0) {
            const actualBank = (bankId * 2) % this.prgBankCount;
            const slot = lowSlot ? 0 : 2;
            this.prgPagesMap[slot] = actualBank * 0x2000;
            this.prgPagesMap[slot + 1] = (actualBank + 1) * 0x2000;
        }
    }

    switch32kPrgBank(bankId) {
        // Map a 32KB PRG bank to all 4 slots
        if (this.get32kPrgBankCount() > 0) {
            const actualBank = (bankId * 4) % this.prgBankCount;
            for (let i = 0; i < 4; i++) {
                this.prgPagesMap[i] = (actualBank + i) * 0x2000;
            }
        }
    }

    // CHR bank switching
    switch1kChrBank(bankId, slot) {
        // Map a 1KB CHR bank to one of 8 slots
        const actualBank = bankId % this.chrBankCount;
        this.chrPagesMap[slot] = actualBank * 0x400; // Store byte offset
    }

    switch2kChrBank(bankId, slot) {
        // Map a 2KB CHR bank to two consecutive 1KB slots
        if (this.get2kChrBankCount() > 0) {
            const actualBank = (bankId * 2) % this.chrBankCount;
            this.chrPagesMap[slot] = actualBank * 0x400;
            this.chrPagesMap[slot + 1] = (actualBank + 1) * 0x400;
        }
    }

    switch4kChrBank(bankId, lowSlot) {
        // Map a 4KB CHR bank to four consecutive 1KB slots
        // lowSlot true = $0000-$0FFF, false = $1000-$1FFF
        if (this.get4kChrBankCount() > 0) {
            const actualBank = (bankId * 4) % this.chrBankCount;
            const slot = lowSlot ? 0 : 4;
            for (let i = 0; i < 4; i++) {
                this.chrPagesMap[slot + i] = (actualBank + i) * 0x400;
            }
        }
    }

    switch8kChrBank(bankId) {
        // Map an 8KB CHR bank to all 8 slots
        if (this.get8kChrBankCount() > 0) {
            const actualBank = (bankId * 8) % this.chrBankCount;
            for (let i = 0; i < 8; i++) {
                this.chrPagesMap[i] = (actualBank + i) * 0x400;
            }
        }
    }

    // CHR-RAM support
    useVRAM(numBanks = 8) {
        // Allocate CHR-RAM instead of using CHR-ROM
        this.usingChrRam = true;
        this.chrData = new Uint8Array(0x400 * numBanks); // numBanks x 1KB
        this.chrRam = this.chrData; // Alias for compatibility
        this.chrBankCount = numBanks;
        this.fillRam(this.chrRam);

        // Initialize CHR page map
        for (let i = 0; i < Math.min(8, numBanks); i++) {
            this.chrPagesMap[i] = i * 0x400;
        }
    }

    // ==========================================================
    // INITIALIZATION & RESET
    // ==========================================================

    reset() {
        // Default behavior: do nothing
        // Override in specific mappers that have internal state
    }

    loadROM() {
        // With the new PPU design, CHR is read directly via mapper.ppuRead().
        // No need to pre-load tiles into the PPU.
        console.log(`Mapper ${this.constructor.name} loaded (no CHR preloading).`);
    }

    loadCHR(romBankIndex, ppuBankIndex) {
    }

    // ==========================================================
    // CORE INTERFACE (Override these in specific mappers)
    // ==========================================================

    // Called when CPU reads from mapper address space ($4020-$FFFF typically)
    cpuRead(address) {
        return undefined; // Open bus (CPU will return data bus)
    }

    // Called when CPU writes to mapper address space
    cpuWrite(address, data) {
        // Default: do nothing (ROM is read-only)
    }

    // Called when PPU reads from nametable space ($2000-$3EFF)
    readNametable(address, context) {
        return null;
    }

    // Called when PPU reads from pattern table space ($0000-$1FFF)
    ppuRead(address, context) { // context is 'bg' or 'sprite'
        // Default implementation using WebNES-style page maps
        if (address >= 0x2000) {
            return null;
        }

        if (this.chrData) {
            const page = (address >> 10) & 7;
            const offset = address & 0x3FF;
            const bankOffset = this.chrPagesMap[page];
            return this.chrData[bankOffset + offset] || 0;
        }
        return null;
    }

    // Called when PPU writes to pattern table space (only valid for CHR-RAM boards)
    ppuWrite(address, data) {
        if (this.usingChrRam && this.chrData) {
            const page = (address >> 10) & 7;
            const offset = address & 0x3FF;
            const bankOffset = this.chrPagesMap[page];
            this.chrData[bankOffset + offset] = data;
            return true;
        }
        return false;
    }

    // ==========================================================
    // OPTIONAL HOOKS (Override if mapper needs them)
    // ==========================================================

    // Called every CPU cycle - used by mappers with cycle-counting IRQs
    step() {
    }
    
    // Called every CPU cycle - used by MMC5 for PPU state tracking
    cpuClock() {
    }

    // Called when CPU reads the NMI vector - used by MMC5
    onNmiVectorRead() {
    }

    // Called at end of each PPU scanline - used by MMC3, MMC5, etc.
    scanlineCounter() {
    }

    onEndScanline(scanline) {
        // Default: do nothing. Used by MMC5.
    }

    // ==========================================================
    // SAVE STATE SUPPORT
    // ==========================================================

    toJSON() { 
        return {}; 
    }
    
    fromJSON(state) { 
    }
}

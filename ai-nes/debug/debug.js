/**
 * NES Debug Output Module
 * 
 * Outputs emulator state in Mesen-comparable format
 * Triggered by F9 key (configurable)
 * 
 * Usage:
 *   import { NESDebug } from './debug.js';
 *   const debug = new NESDebug(nes);
 *   debug.bindKey(document, 'F9');
 *   // Or manually: debug.outputAll();
 */

const SNAPSHOT_SCANLINE = 241; // Scanline to trigger debug output

export class NESDebug {
    constructor(nes) {
        this.nes = nes;
        this.currentScanline = 0;
        this.targetScanline = SNAPSHOT_SCANLINE;
    }

    // Bind debug output to a key
    bindKey(target, key = 'F9') {
        this.debugRequested = false;

        target.addEventListener('keydown', (e) => {
            if (e.key === key) {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

                e.preventDefault();
                console.log(`[NESDebug] Requesting snapshot at scanline ${this.targetScanline}...`);
                this.debugRequested = true;
            }
        });
        // console.log(`[NESDebug] Debug module loaded. Press ${key} to output debug data at scanline ${this.targetScanline}.`);
    }
    
    // Check if debug should trigger (call this every scanline)
    checkTrigger() {
        this.currentScanline = this.nes.ppu.scanline;

        if (this.debugRequested && this.nes.ppu.scanline === this.targetScanline) {
            this.debugRequested = false;
            this.outputAll();
        }
    }

    // Output all debug data
    outputAll() {
        console.log('\n' + '='.repeat(60));
        console.log('NES DEBUG OUTPUT - ' + new Date().toISOString());
        console.log('='.repeat(60));

        console.log(`Current Scanline: ${this.nes.ppu.scanline}`);
        this.outputCHR();
        this.outputPPURegisters();
        this.outputNametables();
        this.outputPalette();
        this.outputScrollInfo();
        this.outputOAM();
        this.outputMMC5State();

        console.log('='.repeat(60) + '\n');
    }

    // =========================================================================
    // CHR ROM/RAM - $0000-$1FFF
    // =========================================================================
    outputCHR() {
        const ppu = this.nes.ppu;
        console.log('\n--- CHR ROM/RAM ($0000-$1FFF) ---');
        
        // Output first 64 bytes of each pattern table as sample using mapper reads
        const readChr = (addr) => (this.nes.ppu.vramMem ? this.nes.ppu.vramMem[addr & 0x1FFF] : 0);
        const block = (base) => {
            const bytes = [];
            for (let i = 0; i < 64; i++) {
                bytes.push(readChr(base + i));
            }
            return this.formatBytes(bytes);
        };
        console.log('Pattern Table 0 ($0000-$0FFF) - First 64 bytes:');
        console.log(block(0x0000));
        
        console.log('Pattern Table 1 ($1000-$1FFF) - First 64 bytes:');
        console.log(block(0x1000));
    }

    // =========================================================================
    // PPU Registers
    // =========================================================================
    outputPPURegisters() {
        const ppu = this.nes.ppu;
        const cpu = this.nes.cpu;
        
        console.log('\n--- PPU Registers ---');
        
        // $2000 - PPUCTRL
        const ppuCtrl = ppu.ctrl || 0;
        console.log(`PPUCTRL    $2000 = $${this.hex(ppuCtrl)}`);
        console.log(`  Nametable Base:     ${(ppuCtrl & 0x03)} (${['$2000', '$2400', '$2800', '$2C00'][ppuCtrl & 0x03]})`);
        const addrInc = (ppuCtrl & 0x04) ? 32 : 1;
        console.log(`  VRAM Increment:     ${(ppuCtrl & 0x04) ? 1 : 0} (+${addrInc})`);
        console.log(`  Sprite Pattern:     ${(ppuCtrl & 0x08) ? 1 : 0} ($${(ppuCtrl & 0x08) ? '1000' : '0000'})`);
        console.log(`  BG Pattern:         ${(ppuCtrl & 0x10) ? 1 : 0} ($${(ppuCtrl & 0x10) ? '1000' : '0000'})`);
        console.log(`  Sprite Size:        ${(ppuCtrl & 0x20) ? '8x16' : '8x8'}`);
        console.log(`  NMI Enable:         ${(ppuCtrl & 0x80) ? 1 : 0}`);

        // $2001 - PPUMASK
        const ppuMask = ppu.mask || 0;
        console.log(`PPUMASK    $2001 = $${this.hex(ppuMask)}`);
        console.log(`  Grayscale:          ${(ppuMask & 0x01) ? 1 : 0}`);
        console.log(`  Show BG Left 8:     ${(ppuMask & 0x02) ? 1 : 0}`);
        console.log(`  Show Sprite Left 8: ${(ppuMask & 0x04) ? 1 : 0}`);
        console.log(`  Show BG:            ${(ppuMask & 0x08) ? 1 : 0}`);
        console.log(`  Show Sprites:       ${(ppuMask & 0x10) ? 1 : 0}`);
        console.log(`  Emphasis:           R=${(ppuMask & 0x20) ? 1 : 0} G=${(ppuMask & 0x40) ? 1 : 0} B=${(ppuMask & 0x80) ? 1 : 0}`);

        // $2002 - PPUSTATUS
        const status = cpu.mem[0x2002];
        console.log(`PPUSTATUS  $2002 = $${this.hex(status)}`);
        console.log(`  Sprite Overflow:    ${(status >> 5) & 1}`);
        console.log(`  Sprite 0 Hit:       ${(status >> 6) & 1}`);
        console.log(`  VBlank:             ${(status >> 7) & 1}`);

        // $2003 - OAMADDR
        console.log(`OAMADDR    $2003 = $${this.hex(ppu.oamAddr || 0)}`);

        // $2004 - OAMDATA (current byte at OAMADDR)
        const oamData = ppu.oam ? ppu.oam[ppu.oamAddr || 0] : 0;
        console.log(`OAMDATA    $2004 = $${this.hex(oamData)} (at OAMADDR)`);

        // $2005 - PPUSCROLL
        console.log(`PPUSCROLL  $2005`);
        // Our PPU tracks v/t/x/w; fine X = x, coarse from t when latched. We expose current fine X only.
        console.log(`  Fine X:             ${ppu.x || 0}`);
        console.log(`  v:                  $${this.hex16(ppu.v || 0)} t:$${this.hex16(ppu.t || 0)} w:${ppu.w || 0}`);

        // $2006 - PPUADDR
        const vramAddr = ppu.v || 0;
        console.log(`PPUADDR    $2006 = $${this.hex16(vramAddr)}`);

        // $2007 - PPUDATA
        const vramVal = this.nes.ppu.readVRAM ? this.nes.ppu.readVRAM(vramAddr) : 0;
        console.log(`PPUDATA    $2007 (VRAM at $${this.hex16(vramAddr)}) = $${this.hex(vramVal)}`);

        // $4014 - OAMDMA
        console.log(`OAMDMA     $4014 (Sprite DMA page)`);

        console.log(`\n------------------------------------------`);
        console.log(`Current Scanline: ${this.nes.ppu.scanline}`);
        console.log(`------------------------------------------`);
    }

    // =========================================================================
    // Nametables and Attribute Tables - $2000-$2FFF
    // =========================================================================
    outputNametables() {
        const ppu = this.nes.ppu;
        const mmap = this.nes.mmap;
        
        console.log('\n--- Nametables & Attributes ($2000-$2FFF) ---');
        
        // Mirroring mode
        const mirrorModes = ['Horizontal', 'Vertical', 'Four-Screen', 'Single-Screen', 'Single-Screen 2'];
        console.log(`Mirroring Mode: ${ppu.mirroring !== undefined ? mirrorModes[ppu.mirroring] || 'Unknown' : 'Unknown'}`);
        
        // Output each nametable
        for (let nt = 0; nt < 4; nt++) {
            const baseAddr = 0x2000 + (nt * 0x400);
            console.log(`\nNametable ${nt} ($${this.hex16(baseAddr)}-$${this.hex16(baseAddr + 0x3BF)}):`);
            
            // Get nametable data (first 2 rows as sample)
            let ntData = [];
            for (let i = 0; i < 64; i++) {
                const addr = baseAddr + i;
                let value;
                if (mmap && mmap.hasNametableOverride && mmap.readNametable) {
                    value = mmap.readNametable(addr);
                } else if (ppu.vramMem && typeof ppu.mirrorAddress === 'function') {
                    value = ppu.vramMem[ppu.mirrorAddress(addr)] || 0;
                } else {
                    value = 0;
                }
                ntData.push(value);
            }
            console.log('  First 2 rows (64 tiles):');
            console.log('  ' + ntData.slice(0, 32).map(v => this.hex(v)).join(' '));
            console.log('  ' + ntData.slice(32, 64).map(v => this.hex(v)).join(' '));
            
            // Attribute table
            const attrAddr = baseAddr + 0x3C0;
            console.log(`  Attribute Table ($${this.hex16(attrAddr)}-$${this.hex16(attrAddr + 0x3F)}):`);
            let attrData = [];
            for (let i = 0; i < 64; i++) {
                const addr = attrAddr + i;
                let value;
                if (mmap && mmap.hasNametableOverride && mmap.readNametable) {
                    value = mmap.readNametable(addr);
                } else if (ppu.vramMem && typeof ppu.mirrorAddress === 'function') {
                    value = ppu.vramMem[ppu.mirrorAddress(addr)] || 0;
                } else {
                    value = 0;
                }
                attrData.push(value);
            }
            console.log('  ' + attrData.slice(0, 32).map(v => this.hex(v)).join(' '));
            console.log('  ' + attrData.slice(32, 64).map(v => this.hex(v)).join(' '));
        }
        
        // Mirror region $3000-$3EFF
        console.log('\nMirror Region ($3000-$3EFF): Mirrors $2000-$2EFF');
    }

    // =========================================================================
    // Palette - $3F00-$3F1F
    // =========================================================================
    outputPalette() {
        const ppu = this.nes.ppu;
        
        console.log('\n--- Palette ($3F00-$3F1F) ---');
        
        // Helper to read palette (supports both PPU architectures)
        const readPal = (idx) => (ppu.palette ? ppu.palette[idx] : 0);

        // Background palette
        console.log('Background Palette:');
        for (let p = 0; p < 4; p++) {
            const base = p * 4;
            const colors = [];
            for (let c = 0; c < 4; c++) {
                colors.push(this.hex(readPal(base + c)));
            }
            console.log(`  Palette ${p}: $${colors.join(' $')}`);
        }
        
        // Sprite palette
        console.log('Sprite Palette:');
        for (let p = 0; p < 4; p++) {
            const base = 16 + p * 4;
            const colors = [];
            for (let c = 0; c < 4; c++) {
                colors.push(this.hex(readPal(base + c)));
            }
            console.log(`  Palette ${p}: $${colors.join(' $')}`);
        }
    }

    // =========================================================================
    // Scroll Info
    // =========================================================================
    outputScrollInfo() {
        const ppu = this.nes.ppu;

        console.log('\n--- Scroll State ---');
        console.log(`Fine X:         ${ppu.x || 0}`);
        console.log(`VRAM Address:   $${this.hex16(ppu.v || 0)}`);
        console.log(`Latch Address:  $${this.hex16(ppu.t || 0)}`);
        console.log(`Write Toggle:   ${ppu.w || 0}`);
    }

    // =========================================================================
    // OAM (Sprite Memory)
    // =========================================================================
    outputOAM() {
        const ppu = this.nes.ppu;

        console.log('\n--- OAM (Sprite Memory) ---');
        console.log('First 8 sprites (32 bytes):');

        if (ppu.oam) {
            const bytes = [];
            for (let i = 0; i < 32; i++) {
                bytes.push(ppu.oam[i]);
            }
            console.log(this.formatBytes(bytes));

            // Decode first 2 sprites
            for (let s = 0; s < 2; s++) {
                const offset = s * 4;
                const y = ppu.oam[offset];
                const tile = ppu.oam[offset + 1];
                const attr = ppu.oam[offset + 2];
                const x = ppu.oam[offset + 3];

                console.log(`\nSprite ${s}:`);
                console.log(`  Y:        ${y} ($${this.hex(y)})`);
                console.log(`  Tile:     ${tile} ($${this.hex(tile)})`);
                console.log(`  Attr:     $${this.hex(attr)} (Pal:${attr & 3} Pri:${(attr >> 5) & 1} FlipH:${(attr >> 6) & 1} FlipV:${(attr >> 7) & 1})`);
                console.log(`  X:        ${x} ($${this.hex(x)})`);
            }
        } else {
            console.log('  (no OAM data)');
        }
    }

    // =========================================================================
    // MMC5 Specific State
    // =========================================================================
    outputMMC5State() {
        const mmap = this.nes.mmap;

        if (!mmap || mmap.constructor.name !== 'Mapper005') {
            console.log('\n--- MMC5 State ---');
            console.log('(Not an MMC5 game)');
            return;
        }

        console.log('\n--- MMC5 State ---');

        // PRG / CHR modes
        const prgMode = (mmap.prgMode ?? mmap.programMode ?? 0) & 0x03;
        const chrMode = (mmap.chrMode ?? mmap.characterMode ?? 0) & 0x03;
        console.log(`$5100 PRG Mode              = ${prgMode} ($${this.hex(prgMode)})`);
        console.log(`  Mode: ${['32KB', '16KB+16KB', '16KB+8KB+8KB', '8KB×4'][prgMode]}`);
        console.log(`$5101 CHR Mode              = ${chrMode} ($${this.hex(chrMode)})`);
        console.log(`  Mode: ${['8KB', '4KB×2', '2KB×4', '1KB×8'][chrMode]}`);

        // Work RAM protect
        const prgRamProtect1 = mmap.prgRamProtect1 ?? (Array.isArray(mmap.ramWriteProtect) ? mmap.ramWriteProtect[0] : 0);
        const prgRamProtect2 = mmap.prgRamProtect2 ?? (Array.isArray(mmap.ramWriteProtect) ? mmap.ramWriteProtect[1] : 0);
        console.log(`$5102 Work RAM Write Protect = ${prgRamProtect1} ($${this.hex(prgRamProtect1)})`);
        console.log(`$5103 Work RAM Write Protect = ${prgRamProtect2} ($${this.hex(prgRamProtect2)})`);
        const writeEnabled = mmap.isPrgRamWriteEnabled ? mmap.isPrgRamWriteEnabled() : (prgRamProtect1 === 0x02 && prgRamProtect2 === 0x01);
        console.log(`$5102/3 Work RAM Protected  = ${writeEnabled ? 'false' : 'true'}`);

        // ExRAM + fill
        const extendedRamMode = mmap.extendedRamMode ?? mmap.exramMode ?? 0;
        console.log(`$5104 Extended RAM Mode     = ${extendedRamMode} ($${this.hex(extendedRamMode)})`);
        const exRamModes = [
            '0: Extra Nametable (write-only)',
            '1: Extended Attribute',
            '2: Read/Write RAM',
            '3: Read-only RAM'
        ];
        console.log(`  ${exRamModes[extendedRamMode] || 'Unknown'}`);

        let nametableMapping = mmap.nametableMapping;
        if (nametableMapping === undefined && Array.isArray(mmap.nametableMode)) {
            nametableMapping =
                (mmap.nametableMode[0] & 0x03) |
                ((mmap.nametableMode[1] & 0x03) << 2) |
                ((mmap.nametableMode[2] & 0x03) << 4) |
                ((mmap.nametableMode[3] & 0x03) << 6);
        }
        nametableMapping = nametableMapping ?? 0;
        console.log(`$5105 Nametable Mapping     = $${this.hex(nametableMapping)}`);
        const ntSources = ['CIRAM A', 'CIRAM B', 'ExRAM', 'Fill'];
        console.log(`  NT0: ${ntSources[(nametableMapping >> 0) & 3]}  NT1: ${ntSources[(nametableMapping >> 2) & 3]}  NT2: ${ntSources[(nametableMapping >> 4) & 3]}  NT3: ${ntSources[(nametableMapping >> 6) & 3]}`);

        const fillModeTile = mmap.fillModeTile ?? mmap.fillmodeTile ?? 0;
        const fillModeColor = mmap.fillModeColor ?? mmap.fillmodeColor ?? 0;
        console.log(`$5106 Fill Mode Tile        = ${fillModeTile} ($${this.hex(fillModeTile)})`);
        console.log(`$5107 Fill Mode Color       = ${fillModeColor} ($${this.hex(fillModeColor)})`);

        // PRG banks
        let prgBanks = Array.isArray(mmap.prgBanks) ? mmap.prgBanks : null;
        if (!prgBanks && Array.isArray(mmap.programBank)) {
            const ramSelect = mmap.ramSelect ?? 0;
            const ramBank = mmap.ramBank ?? 0;
            const ramSlot = ((ramSelect & 0x01) << 2) | (ramBank & 0x03);
            prgBanks = [
                ramSlot,
                mmap.programBank[0] ?? 0,
                mmap.programBank[1] ?? 0,
                mmap.programBank[2] ?? 0,
                mmap.programBank[3] ?? 0,
            ];
        }
        prgBanks = prgBanks || [0, 0, 0, 0, 0];
        console.log(`PRG Banks ($5113-$5117):`);
        console.log(`  $5113 (RAM $6000): $${this.hex(prgBanks[0])}`);
        console.log(`  $5114 ($8000):     $${this.hex(prgBanks[1])} ${(prgBanks[1] & 0x80) ? 'ROM' : 'RAM'}`);
        console.log(`  $5115 ($A000):     $${this.hex(prgBanks[2])} ${(prgBanks[2] & 0x80) ? 'ROM' : 'RAM'}`);
        console.log(`  $5116 ($C000):     $${this.hex(prgBanks[3])} ${(prgBanks[3] & 0x80) ? 'ROM' : 'RAM'}`);
        console.log(`  $5117 ($E000):     $${this.hex(prgBanks[4])} ROM`);

        // CHR
        const chrUpperBits = mmap.chrUpperBits ?? mmap.characterBankHi ?? 0;
        console.log(`$5130 CHR Upper Bits        = ${chrUpperBits} ($${this.hex(chrUpperBits)})`);
        const chrBanksA = Array.isArray(mmap.chrBanks)
            ? mmap.chrBanks.slice(0, 8)
            : (Array.isArray(mmap.characterSpriteBank) ? mmap.characterSpriteBank : new Array(8).fill(0));
        const chrBanksB = Array.isArray(mmap.chrBanks)
            ? mmap.chrBanks.slice(8, 12)
            : (Array.isArray(mmap.characterBackgroundBank) ? mmap.characterBackgroundBank : new Array(4).fill(0));

        console.log(`CHR Banks Sprites ($5120-$5127):`);
        for (let i = 0; i < 8; i++) {
            const bank = chrBanksA[i] ?? 0;
            console.log(`  $512${i.toString(16).toUpperCase()}: $${this.hex16(bank)}`);
        }
        console.log(`CHR Banks BG ($5128-$512B):`);
        for (let i = 0; i < 4; i++) {
            const bank = chrBanksB[i] ?? 0;
            console.log(`  $512${(i + 8).toString(16).toUpperCase()}: $${this.hex16(bank)}`);
        }

        // Vertical split
        const vsplitEnable = mmap.verticalSplitEnabled ?? mmap.vsplitEnable ?? 0;
        const vsplitSide = mmap.verticalSplitRightSide ?? mmap.vsplitSide ?? 0;
        const vsplitTile = mmap.verticalSplitDelimiterTile ?? mmap.vsplitTile ?? 0;
        const vsplitScroll = mmap.verticalSplitScroll ?? mmap.vsplitScroll ?? 0;
        const vsplitBank = mmap.verticalSplitBank ?? mmap.vsplitBank ?? 0;
        console.log(`$5200 Vertical Split Ctrl   = $${this.hex((vsplitEnable ? 0x80 : 0) | (vsplitSide ? 0x40 : 0) | (vsplitTile & 0x1F))}`);
        console.log(`  Enabled: ${!!vsplitEnable}  Side: ${vsplitSide ? 'Right' : 'Left'}  Delimiter Tile: ${vsplitTile}`);
        console.log(`$5201 Vertical Split Scroll = ${vsplitScroll} ($${this.hex(vsplitScroll)})`);
        console.log(`$5202 Vertical Split Bank   = ${vsplitBank} ($${this.hex(vsplitBank)})`);

        // IRQ + multiplier
        const irqTarget = mmap.irqCounterTarget ?? mmap.irqCoincidence ?? 0;
        const irqEnabled = mmap.irqEnabled ?? mmap.irqEnable ?? 0;
        const multiplicand = mmap.multiplierValue1 ?? mmap.multiplicand ?? 0;
        const multiplier = mmap.multiplierValue2 ?? mmap.multiplier ?? 0;
        console.log(`$5203 IRQ Counter Target    = ${irqTarget} ($${this.hex(irqTarget)})`);
        console.log(`$5204 IRQ Enabled           = ${irqEnabled}`);
        const product = (multiplicand || 0) * (multiplier || 0);
        console.log(`$5205 Multiplicand          = ${multiplicand} ($${this.hex(multiplicand)})`);
        console.log(`$5206 Multiplier            = ${multiplier} ($${this.hex(multiplier)})`);
        console.log(`$5205/6 Product             = ${product} ($${this.hex16(product)})`);

        // MMC5 audio
        if (mmap.mmc5Audio) {
            const mmc5Audio = mmap.mmc5Audio;
            const sq1 = mmc5Audio.square1;
            const sq2 = mmc5Audio.square2;
            const cpuFreq = 1789772.5;
            const formatFreq = (period) => {
                const p = (period ?? 0) & 0x7ff;
                const freq = cpuFreq / (16 * (p + 1));
                return `${freq.toFixed(6)} Hz`;
            };
            const outputSquare = (label, sq, baseAddr) => {
                if (!sq) return;
                const reg0 = `$${this.hex16(baseAddr)}`;
                const reg2 = `$${this.hex16(baseAddr + 2)}`;
                const reg3 = `$${this.hex16(baseAddr + 3)}`;
                const envVolume = sq.envDecayRate ?? 0;
                const envCounter = sq.envVolume ?? 0;
                const envDivider = sq.envDecayCounter ?? 0;
                const lengthReload = sq.lengthReloadValue ?? 0;
                const period = sq.timerPeriod ?? 0;
                console.log(`${reg0} ${label}`);
                console.log(`  ${reg0}.0-3 Envelope Volume        = ${envVolume} ($${this.hex(envVolume)})`);
                console.log(`  ${reg0}.4 Envelope - Constant Volume = ${!!sq.envDecayDisable}`);
                console.log(`  ${reg0}.5 Length Counter - Halted = ${!!sq.lengthCounterHalt}`);
                console.log(`  ${reg0}.6-7 Duty                 = ${sq.dutyMode ?? 0}`);
                console.log(`  ${reg2}/${reg3}.0-2 Period     = ${period} ($${this.hex16(period)})`);
                console.log(`  ${reg3}.3-7 Length Counter - Reload Value = ${lengthReload} ($${this.hex16(lengthReload)})`);
                console.log(`  -- Enabled               = ${!!sq.isEnabled}`);
                console.log(`  -- Timer                 = ${sq.timerCounter ?? 0}`);
                console.log(`  -- Frequency             = ${formatFreq(period)}`);
                console.log(`  -- Duty Position         = ${sq.dutyPos ?? 0} ($${this.hex(sq.dutyPos ?? 0)})`);
                console.log(`  -- Length Counter - Counter = ${sq.lengthCounter ?? 0} ($${this.hex(sq.lengthCounter ?? 0)})`);
                console.log(`  -- Envelope - Counter    = ${envCounter} ($${this.hex(envCounter)})`);
                console.log(`  -- Envelope - Divider    = ${envDivider} ($${this.hex(envDivider)})`);
                console.log(`  -- Output                = ${sq.output ?? 0} ($${this.hex(sq.output ?? 0)})`);
            };

            console.log(`\n$5000-$5015 MMC5 Audio`);
            outputSquare("MMC5 Square 1", sq1, 0x5000);
            outputSquare("MMC5 Square 2", sq2, 0x5004);

            console.log(`$5010-$5011 PCM`);
            console.log(`  $5010.0 PCM Read Mode     = ${!!mmc5Audio.pcmReadMode}`);
            console.log(`  $5010.7 PCM IRQ Enabled   = ${!!mmc5Audio.pcmIrqEnabled}`);
            console.log(`  $5011 PCM Output          = ${mmc5Audio.pcmOutput ?? 0} ($${this.hex(mmc5Audio.pcmOutput ?? 0)})`);
        }

        // Internal state
        console.log(`\n--- Internal State ---`);
        const ppuInFrame = mmap.ppuInFrame ?? mmap.inFrame ?? 0;
        const scanlineCounter = mmap.scanlineCounter ?? mmap.vcounter ?? 0;
        const splitTileNumber = mmap.splitTileNumber ?? mmap.vsplitTile ?? 0;
        const irqPending = mmap.irqPending ?? mmap.irqLine ?? 0;
        console.log(`PPU In Frame:              ${ppuInFrame}`);
        console.log(`Need In Frame:             ${mmap.needInFrame ?? 'n/a'}`);
        console.log(`Scanline Counter:          ${scanlineCounter}`);
        console.log(`Split Tile Number:         ${splitTileNumber}`);
        console.log(`IRQ Pending:               ${irqPending}`);
        console.log(`Last CHR Reg:              $${this.hex16(mmap.lastChrReg || 0)} (Prev set A: ${mmap.prevChrA ?? 'n/a'})`);

        // ExRAM sample
        console.log(`\nExRAM ($5C00-$5FFF) - First 64 bytes:`);
        console.log(this.formatMemoryBlock(mmap.exRam ?? mmap.exram, 0, 64));
    }

    // =========================================================================
    // Utility Methods
    // =========================================================================
    
    hex(value) {
        return (value || 0).toString(16).toUpperCase().padStart(2, '0');
    }
    
    hex16(value) {
        return (value || 0).toString(16).toUpperCase().padStart(4, '0');
    }

    // Format an array of bytes into spaced hex rows
    formatBytes(bytes) {
        if (!bytes) return '  (no data)';
        const lines = [];
        for (let i = 0; i < bytes.length; i += 16) {
            lines.push(bytes.slice(i, i + 16).map(b => this.hex(b)).join(' '));
        }
        return lines.join('\n');
    }
    
    formatMemoryBlock(mem, start, length) {
        if (!mem) return '  (no data)';
        
        let result = [];
        for (let row = 0; row < length; row += 16) {
            let line = `  $${this.hex16(start + row)}: `;
            let bytes = [];
            for (let col = 0; col < 16 && (row + col) < length; col++) {
                bytes.push(this.hex(mem[start + row + col] || 0));
            }
            line += bytes.join(' ');
            result.push(line);
        }
        return result.join('\n');
    }
}

// Quick initialization helper
// Call this after your NES instance is created
export function initDebug(nes, key = 'F9') {
    const debug = new NESDebug(nes);
    debug.bindKey(document, key);

    // Hook into PPU step to check for trigger
    const originalStep = nes.ppu.step.bind(nes.ppu);
    nes.ppu.step = function() {
        const result = originalStep();
        if (this.cycle === 0) {
            debug.checkTrigger();
        }
        return result;
    };

    // Also expose globally for console access
    window.nesDebug = debug;
    // console.log('[NESDebug] Debug module loaded. Use nesDebug.outputAll() or press ' + key);

    return debug;
}

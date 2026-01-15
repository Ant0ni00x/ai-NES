// -------------------------------------------------------------------------------------------
// NES Compatibility Database. Handles game-specific fixes - hashes, mirroring overrides, etc.
// 0 = horizontal
// 1 = vertical
// 2 = single-screen 0
// 3 = single-screen 1
// 4 = four-screen
// -------------------------------------------------------------------------------------------
const FIXES = {
    'EC968C51': { name: 'Gauntlet (Licensed)', mirroring: 4 }, // Force 4-Screen
    'CD50A092': { name: 'Gauntlet (Unlicensed)', mirroring: 4 }, // Force 4-Screen
};

/**
 * Applies compatibility fixes based on ROM CRC32
 * @param {NES} nes - The NES instance
 * @param {Function} [logger] - Optional logging function (msg, type)
 */
export function applyCompatibilityFixes(nes, logger) {
    if (!nes || !nes.rom) return;

    const crc = nes.rom.getCRC32().toString(16).toUpperCase().padStart(8, '0');
    const fix = FIXES[crc];

    if (fix) {
        if (logger) logger(`🛠️ Applied fix for: ${fix.name}`, 'success');
        
        if (fix.mirroring !== undefined) {
            nes.ppu.setMirroring(fix.mirroring);
        }
    }
}
// Mapper Factory for AI-NES
// Creates the appropriate mapper instance based on ROM header
import Mapper000 from './mapper000.js';
import Mapper001 from './mapper001.js';
import Mapper002 from './mapper002.js';
import Mapper003 from './mapper003.js';
import Mapper004 from './mapper004.js';
import Mapper005 from './mapper005.js';
import Mapper006 from './mapper006.js';
import Mapper007 from './mapper007.js';
import Mapper009 from './mapper009.js';
import Mapper011 from './mapper011.js';
import Mapper025 from './mapper025.js';
import Mapper034 from './mapper034.js';
import Mapper047 from './mapper047.js';
import Mapper066 from './mapper066.js';
import Mapper069 from './mapper069.js';
import Mapper079 from './mapper079.js';
import Mapper206 from './mapper206.js';

// Registry of supported mappers (expand as new mappers are added)
const registry = {
  0: Mapper000,
  1: Mapper001,
  2: Mapper002,
  3: Mapper003,
  4: Mapper004,
  5: Mapper005,
  6: Mapper006,
  7: Mapper007,
  9: Mapper009,
  11: Mapper011,
  25: Mapper025,
  34: Mapper034,
  47: Mapper047,
  66: Mapper066,
  69: Mapper069,
  79: Mapper079,
  206: Mapper206
};

/**
 * Creates a mapper instance for the given ROM
 * @param {number} mapperId - Mapper number from ROM header
 * @param {ROM} cartridge - The ROM/cartridge object containing game data
 * @param {NES} nes - Reference to the NES system (optional, falls back to cartridge.nes)
 * @returns {Mapper} The appropriate mapper instance
 **/
export function createMapper(mapperId, cartridge, nes) {
  // Ensure NES reference is available on cartridge
  // This is critical for mappers that need to access PPU, CPU, etc.
  if (nes && !cartridge.nes) {
    cartridge.nes = nes;
  }

  // Validate we have the NES reference
  if (!cartridge.nes) {
    console.warn('createMapper: No NES reference available on cartridge');
  }

  // CRC Overrides for games with incorrect headers
  if (cartridge && cartridge.getCRC32) {
      const crc = cartridge.getCRC32().toString(16).toUpperCase();
      // Gauntlet (Tengen/Licensed) - Force Mapper 206
      if (crc === 'EC968C51' || crc === 'CD50A092') {
          console.log(`[MapperFactory] Detected Gauntlet (CRC: ${crc}). Forcing Mapper 206.`);
          mapperId = 206;
      }
      // StarTropics 1 & 2 (MMC6) - Force Mapper 6
      if (crc === '889129CB' || crc === 'D054FFB0') {
          console.log(`[MapperFactory] Detected StarTropics (CRC: ${crc}). Forcing Mapper 6 (MMC6).`);
          mapperId = 6;
      }
  }

  // Look up the mapper class
  const MapperClass = registry[mapperId];

  if (MapperClass) {
    // console.log(`Creating Mapper ${mapperId}`);
    return new MapperClass(cartridge);
  }

  // Fallback to Mapper000 for unsupported mappers
  console.warn(`Mapper ${mapperId} not implemented; falling back to Mapper000 (NROM)`);
  return new Mapper000(cartridge);
}

/**
 * Check if a mapper is supported
 * @param {number} mapperId - Mapper number to check
 * @returns {boolean} True if mapper is implemented
 */
export function isMapperSupported(mapperId) {
  return mapperId in registry;
}

/**
 * Get list of all supported mapper IDs
 * @returns {number[]} Array of supported mapper numbers
 */
export function getSupportedMappers() {
  return Object.keys(registry).map(Number);
}

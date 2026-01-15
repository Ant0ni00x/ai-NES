// Parses and manages NES ROM data, including iNES header parsing,
// PRG-ROM and CHR-ROM loading, and mapper creation.

import { createMapper } from "./mappers/mapper-factory.js";

export class ROM {
  constructor(nes) {
    this.nes = nes;

    this.mapperName = new Array(92).fill("Unknown Mapper");
    this.mapperName[0] = "NROM -Direct Access";
    this.mapperName[1] = "Nintendo MMC1";
    this.mapperName[2] = "UNROM";
    this.mapperName[3] = "CNROM";
    this.mapperName[4] = "Nintendo MMC3";
    this.mapperName[5] = "Nintendo MMC5";
    this.mapperName[6] = "FFE F4xxx";
    this.mapperName[7] = "AOROM";
    this.mapperName[8] = "FFE F3xxx";
    this.mapperName[9] = "Nintendo MMC2";
    this.mapperName[10] = "Nintendo MMC4";
    this.mapperName[11] = "Color Dreams Chip";
    this.mapperName[12] = "FFE F6xxx";
    this.mapperName[15] = "100-in-1 switch";
    this.mapperName[16] = "Bandai chip";
    this.mapperName[17] = "FFE F8xxx";
    this.mapperName[18] = "Jaleco SS8806 chip";
    this.mapperName[19] = "Namcot 106 chip";
    this.mapperName[20] = "Famicom Disk System";
    this.mapperName[21] = "Konami VRC4a";
    this.mapperName[22] = "Konami VRC2a";
    this.mapperName[23] = "Konami VRC2a";
    this.mapperName[24] = "Konami VRC6";
    this.mapperName[25] = "Konami VRC4b";
    this.mapperName[32] = "Irem G-101 chip";
    this.mapperName[33] = "Taito TC0190/TC0350";
    this.mapperName[34] = "32kB ROM switch";
    this.mapperName[47] = "NES-QJ Chip";
    this.mapperName[64] = "Tengen RAMBO-1 chip";
    this.mapperName[65] = "Irem H-3001 chip";
    this.mapperName[66] = "GxROM Chip";
    this.mapperName[67] = "SunSoft3 chip";
    this.mapperName[68] = "SunSoft4 chip";
    this.mapperName[69] = "SunSoft5 FME-7 Chip";
    this.mapperName[71] = "Camerica chip";
    this.mapperName[78] = "Irem 74HC161/32-based";
    this.mapperName[79] = "NINA-03/NINA-06 Chip";
    this.mapperName[91] = "Pirate HK-SF3 chip";
    this.mapperName[206] = "DxROM";

    // Mirroring types (match PPU expectations):
    this.HORIZONTAL_MIRRORING = 0;  // PPU mode 0
    this.VERTICAL_MIRRORING = 1;    // PPU mode 1
    this.SINGLESCREEN_MIRRORING_A = 2; // PPU mode 2
    this.SINGLESCREEN_MIRRORING_B = 3; // PPU mode 3
    this.FOURSCREEN_MIRRORING = 4;     // PPU mode 4

    this.header = null;
    this.rom = null;      // Legacy: array of 16KB bank arrays
    this.vrom = null;     // Legacy: array of 4KB bank arrays

    // NEW: Flat arrays for efficient mapper access
    this.prg = null;      // Flat Uint8Array of all PRG-ROM
    this.chr = null;      // Flat Uint8Array of all CHR-ROM

    this.romCount = null;
    this.vromCount = null;
    this.mirroring = null;
    this.batteryRam = null;
    this.trainer = null;
    this.fourScreen = null;
    this.mapperType = null;
    this.valid = false;
  }

  load(data) {
    // Modern path: Support Uint8Array directly (preferred)
    // Legacy path: Support string for backward compatibility
    const isUint8Array = data instanceof Uint8Array;

    // Validate iNES header magic bytes
    if (isUint8Array) {
      if (data.length < 16 || data[0] !== 0x4E || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1A) {
        throw new Error("Not a valid NES ROM (invalid header signature).");
      }
    } else {
      if (data.indexOf("NES\x1a") === -1) {
        throw new Error("Not a valid NES ROM.");
      }
    }

    this.header = new Array(16);
    for (let i = 0; i < 16; i++) {
      this.header[i] = isUint8Array ? data[i] : (data.charCodeAt(i) & 0xff);
    }
    this.romCount = this.header[4];
    this.vromCount = this.header[5] * 2; // Each CHR bank is 4KB, header gives 8KB units
    this.mirroring = (this.header[6] & 1) !== 0 ? 1 : 0;
    this.batteryRam = (this.header[6] & 2) !== 0;
    this.trainer = (this.header[6] & 4) !== 0;
    this.fourScreen = (this.header[6] & 8) !== 0;


    // Check for NES 2.0 header format
    const isNES2 = (this.header[7] & 0x0c) === 0x08;
    if (isNES2) {
      // iNES 2.0 format
      const mapperBase = (this.header[6] >> 4) | (this.header[7] & 0xf0);
      const mapperMSB = this.header[8] & 0x0f; // Upper 4 bits of mapper number
      this.mapperType = (mapperMSB << 8) | mapperBase;
    } else {
      // iNES 1.0 format
      this.mapperType = (this.header[6] >> 4) | (this.header[7] & 0xf0);

      // Heuristic for "PlayChoice-10" or other headers with garbage in bytes 8-15
      let isDirty = false;
      for (let i = 8; i < 16; i++) {
        if (this.header[i] !== 0) {
          isDirty = true;
          break;
        }
      }
      if (isDirty) {
        this.mapperType &= 0x0f; // Trust only the lower 4 bits of the mapper number.
      }
    }

    // Calculate offset (skip trainer if present)
    let offset = 16;
    if (this.trainer) {
      offset += 512;
    }

    // ========================================
    // PRG-ROM Loading
    // ========================================
    const prgSize = this.romCount * 16384;
    this.prg = new Uint8Array(prgSize);

    // Also maintain legacy array-of-banks format for compatibility
    this.rom = new Array(this.romCount);

    for (let i = 0; i < this.romCount; i++) {
      this.rom[i] = new Array(16384);
      for (let j = 0; j < 16384; j++) {
        const byteVal = (offset + j < data.length)
          ? (isUint8Array ? data[offset + j] : (data.charCodeAt(offset + j) & 0xff))
          : 0;
        this.rom[i][j] = byteVal;
        this.prg[i * 16384 + j] = byteVal; // Also store in flat array
      }
      offset += 16384;
    }

    // ========================================
    // CHR-ROM Loading
    // ========================================
    const chrSize = this.vromCount * 4096;
    this.chr = new Uint8Array(chrSize);

    this.vrom = new Array(this.vromCount);
    for (let i = 0; i < this.vromCount; i++) {
      this.vrom[i] = new Array(4096);
      for (let j = 0; j < 4096; j++) {
        const byteVal = (offset + j < data.length)
          ? (isUint8Array ? data[offset + j] : (data.charCodeAt(offset + j) & 0xff))
          : 0;
        this.vrom[i][j] = byteVal;
        this.chr[i * 4096 + j] = byteVal; // Also store in flat array
      }
      offset += 4096;
    }

    this.valid = true;
  }

  getMirroringType() {
    if (this.fourScreen) return this.FOURSCREEN_MIRRORING;

    // iNES format: bit 0 of header[6]
    // 0 = Horizontal Mirroring
    // 1 = Vertical Mirroring
    return this.mirroring === 0 ? this.HORIZONTAL_MIRRORING : this.VERTICAL_MIRRORING;
  }

  getMapperName() {
    if (this.mapperType >= 0 && this.mapperType < this.mapperName.length) {
      return this.mapperName[this.mapperType];
    }
    return "Unknown Mapper, " + this.mapperType;
  }

  // Returns the likely PCB class based on Mapper ID and ROM characteristics.
  getPcbClass() {
    switch (this.mapperType) {
      case 0: return (this.romCount === 1) ? "NROM-128" : "NROM-256";
      case 1: return "MMC1 (SxROM)";
      case 2: return "UNROM (UxROM)";
      case 3: return "CNROM";
      case 4: return "MMC3 (TxROM)";
      case 5: return "MMC5 (ExROM)";
      case 6: return "FFE F4xxx";
      case 7: return "AxROM";
      case 9: return "MMC2 (PxROM)";
      case 10: return "MMC4 (FxROM)";
      case 11: return "Color Dreams";
      case 25: return "VRC4";
      case 34: return "BNROM";
      case 47: return "NES-QJ";
      case 66: return "GxROM";
      case 69: return "FME-7 Chip";
      case 79: return "NINA-03/NINA-06";
      case 206: return "DxROM";
      default: return `Mapper ${this.mapperType}`;
    }
  }

  // Calculate CRC32 checksum of the ROM data (PRG + CHR)
  // Used for identifying specific game dumps to apply compatibility fixes. 
  getCRC32() {
    const crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
      }
      crcTable[i] = c;
    }

    let crc = -1;
    const data = [this.prg, this.chr];
    for (const buffer of data) {
      if (!buffer) continue;
      for (let i = 0; i < buffer.length; i++) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xFF];
      }
    }
    return (crc ^ -1) >>> 0;
  }

  mapperSupported() {
    return true;
  }

  createMapper() {
    // Pass 'this' as the cartridge (ROM contains all the data)
    // Also pass NES reference explicitly for safety
    return createMapper(this.mapperType, this, this.nes);
  }
}
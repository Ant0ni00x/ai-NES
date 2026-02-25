export class PaletteTable {
  constructor() {
    this.curTable = new Array(64);
    this.emphTable = new Array(8);
    this.currentEmph = -1;
  }

  reset() { this.setEmphasis(0); }

  loadNTSCPalette() {
    // Nestopia-style NTSC palette — widely used and well-tested
    this.curTable = [
        0x666666, 0x002A88, 0x1412A7, 0x3B00A4, 0x5C007E, 0x6E0040, 0x6C0600, 0x561D00,
        0x333500, 0x0B4800, 0x005200, 0x004F08, 0x00404D, 0x000000, 0x000000, 0x000000,
        0xADADAD, 0x155FD9, 0x4240FF, 0x7527FE, 0xA01ACC, 0xB71E7B, 0xB53120, 0x994E00,
        0x6B6D00, 0x388700, 0x0C9300, 0x008F32, 0x007C8D, 0x000000, 0x000000, 0x000000,
        0xFFFEFF, 0x64B0FF, 0x9290FF, 0xC676FF, 0xF36AFF, 0xFE6ECC, 0xFE8170, 0xEA9E22,
        0xBCBE00, 0x88D800, 0x5CE430, 0x45E082, 0x48CDDE, 0x4F4F4F, 0x000000, 0x000000,
        0xFFFEFF, 0xC0DFFF, 0xD3D2FF, 0xE8C8FF, 0xFBC2FF, 0xFEC4EA, 0xFECCC5, 0xF7D8A5,
        0xE4E594, 0xCFEF96, 0xBDF4AB, 0xB3F3CC, 0xB5EBF2, 0xB8B8B8, 0x000000, 0x000000
    ];
    this.makeTables();
    this.setEmphasis(0);
  }

  loadPALPalette() {
    this.curTable = [
        0x525252, 0xB40000, 0xA00000, 0xB1003D, 0x740069, 0x00005B, 0x00005F, 0x001840, 
        0x002F10, 0x084A08, 0x006700, 0x124200, 0x6D2800, 0x000000, 0x000000, 0x000000, 
        0xC4D5E7, 0xFF4000, 0xDC0E22, 0xFF476B, 0xD7009F, 0x680AD7, 0x0019BC, 0x0054B1, 
        0x006A5B, 0x008C03, 0x00AB00, 0x2C8800, 0xA47200, 0x000000, 0x000000, 0x000000, 
        0xF8F8F8, 0xFFAB3C, 0xFF7981, 0xFF5BC5, 0xFF48F2, 0xDF49FF, 0x476DFF, 0x00B4F7, 
        0x00E0FF, 0x00E375, 0x03F42B, 0x78B82E, 0xE5E218, 0x787878, 0x000000, 0x000000, 
        0xFFFFFF, 0xFFF2BE, 0xF8B8B8, 0xF8B8D8, 0xFFB6FF, 0xFFC3FF, 0xC7D1FF, 0x9ADAFF, 
        0x88EDF8, 0x83FFDD, 0xB8F8B8, 0xF5F8AC, 0xFFFFB0, 0xF8D8F8, 0x000000, 0x000000
    ];
    this.makeTables();
    this.setEmphasis(0);
  }

  makeTables() {
    let r, g, b, col, rFactor, gFactor, bFactor;

    for (let emph = 0; emph < 8; emph++) {
      rFactor = 1.0; gFactor = 1.0; bFactor = 1.0;
      // Bit 0 (Red Emphasis): Attenuate Green and Blue
      if ((emph & 1) !== 0) { gFactor = 0.75; bFactor = 0.75; }
      // Bit 1 (Green Emphasis): Attenuate Red and Blue
      if ((emph & 2) !== 0) { rFactor = 0.75; bFactor = 0.75; }
      // Bit 2 (Blue Emphasis): Attenuate Red and Green
      if ((emph & 4) !== 0) { rFactor = 0.75; gFactor = 0.75; }
      this.emphTable[emph] = new Array(64);
      for (let i = 0; i < 64; i++) {
        col = this.curTable[i];
        r = Math.min(255, Math.floor(this.getRed(col) * rFactor));
        g = Math.min(255, Math.floor(this.getGreen(col) * gFactor));
        b = Math.min(255, Math.floor(this.getBlue(col) * bFactor));
        this.emphTable[emph][i] = this.getRgb(r, g, b);
      }
    }
  }

  setEmphasis(emph) {
    if (emph !== this.currentEmph) {
      this.currentEmph = emph;
      for (let i = 0; i < 64; i++) this.curTable[i] = this.emphTable[emph][i];
    }
  }

  getEntry(yiq) { return this.curTable[yiq]; }
  getRed(rgb) { return (rgb >> 16) & 0xff; }
  getGreen(rgb) { return (rgb >> 8) & 0xff; }
  getBlue(rgb) { return rgb & 0xff; }
  getRgb(r, g, b) { return (r << 16) | (g << 8) | b; }
}
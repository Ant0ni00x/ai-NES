export class PaletteTable {
  constructor() {
    this.curTable = new Array(64);
    this.emphTable = new Array(8);
    this.currentEmph = -1;
  }

  reset() { this.setEmphasis(0); }

  loadNTSCPalette() {
    this.curTable = [
        0x545454, 0x001E74, 0x081090, 0x300088, 0x440064, 0x5C0030, 0x540400, 0x3C1800,
        0x202A00, 0x083A00, 0x004000, 0x003C00, 0x00323C, 0x000000, 0x000000, 0x000000,
        0x989698, 0x084CC4, 0x3032EC, 0x5C1EE4, 0x8814B0, 0xA01464, 0x982220, 0x783C00,
        0x545A00, 0x287200, 0x087C00, 0x007628, 0x006678, 0x000000, 0x000000, 0x000000,
        0xECEEEC, 0x4C9AEC, 0x787CEC, 0xB062EC, 0xE458EC, 0xEC58B4, 0xEC6A64, 0xD48820,
        0xA0AA00, 0x74C400, 0x4CD020, 0x38CC6C, 0x38B4CC, 0x3C3C3C, 0x000000, 0x000000,
        0xECEEEC, 0xA8CCEC, 0xBCBCEC, 0xD4B2EC, 0xECAEEC, 0xECAED4, 0xECB4B0, 0xE4C490,
        0xCCD278, 0xB6DE78, 0xA8E294, 0x98E2B4, 0xA0D6E4, 0xA0A2A0, 0x000000, 0x000000
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
    const BRIGHTNESS_BOOST = 1.3; // Increase brightness by 20% (adjust as needed)

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
        // Apply brightness boost while respecting emphasis
        r = Math.min(255, Math.floor(this.getRed(col) * rFactor * BRIGHTNESS_BOOST));
        g = Math.min(255, Math.floor(this.getGreen(col) * gFactor * BRIGHTNESS_BOOST));
        b = Math.min(255, Math.floor(this.getBlue(col) * bFactor * BRIGHTNESS_BOOST));
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
// Mapper 000: (NROM)
//
// Features:
//  - The simplest possible mapper, used in many early NES games. It has no bank switching
//  - or registers, and simply maps the PRG and CHR ROM directly into the CPU and PPU address spaces.
//  - Mirroring: Horizontal or Vertical as per ROM header
//
// References:
//  - https://wiki.nesdev.com/w/index.php/NROM

import BaseMapper, { ChrMemoryType, PrgMemoryType } from "./mapper-base.js";

export default class Mapper000 extends BaseMapper {
  getPrgPageSize() {
    return 0x4000; // 16KB pages
  }

  getChrPageSize() {
    return 0x2000; // 8KB pages
  }

  reset(softReset = false) {
    super.reset(softReset);

    // $8000-$BFFF: first PRG page, $C000-$FFFF: last PRG page
    // (for 16KB PRG, both map to the same page)
    this.SelectPrgPage(0, 0, PrgMemoryType.PrgRom);
    this.SelectPrgPage(1, -1, PrgMemoryType.PrgRom);

    // Fixed CHR mapping
    this.SelectChrPage(0, 0, ChrMemoryType.Default);

    // Header mirroring
    this.SetMirroringType(this._getRomMirroringType());
  }
}
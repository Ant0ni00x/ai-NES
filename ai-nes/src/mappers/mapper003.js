import BaseMapper from "./mapper-base.js";

// Mapper 003 (CNROM)
// Mesen reference behavior:
// - PRG: fixed 32KB at $8000-$FFFF
// - CHR: switchable 8KB bank selected by CPU writes in $8000-$FFFF
// - Bus conflicts enabled for NES 2.0 submapper 2
export default class Mapper003 extends BaseMapper {
  getPrgPageSize() {
    return 0x8000;
  }

  getChrPageSize() {
    return 0x2000;
  }

  hasBusConflicts() {
    return !!(this.cartridge && ((this.cartridge.submapper | 0) === 2));
  }

  _getPowerOnChrBank() {
    // Mesen uses GetPowerOnByte(); this codebase does not expose that setting yet.
    // Default to deterministic bank 0.
    return 0;
  }

  initMapper() {
    this.SelectPrgPage(0, 0);
    this.SelectChrPage(0, this._getPowerOnChrBank());
  }

  reset(softReset = false) {
    super.reset(softReset);
    this.initMapper();
  }

  writeRegister(_addr, value) {
    this.SelectChrPage(0, value & 0xFF);
  }
}

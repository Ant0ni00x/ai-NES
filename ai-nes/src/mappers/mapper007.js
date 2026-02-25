import BaseMapper from "./mapper-base.js";

// Mapper 007 (AxROM / AOROM)
// Mesen reference behavior from mesen-axrom.h:
// - PRG: switchable 32KB bank at $8000-$FFFF (low 4 bits)
// - CHR: fixed 8KB page 0
// - Mirroring: single-screen A/B by bit 4
// - Bus conflicts: enabled for NES 2.0 submapper 2
export default class Mapper007 extends BaseMapper {
  getPrgPageSize() {
    return 0x8000;
  }

  getChrPageSize() {
    return 0x2000;
  }

  hasBusConflicts() {
    return !!(this.cartridge && ((this.cartridge.submapper | 0) === 2));
  }

  _getPowerOnByte(defaultValue = 0) {
    // This codebase does not currently expose RandomizeMapperPowerOnState.
    return defaultValue & 0xFF;
  }

  _applyRegister(value) {
    const reg = value & 0xFF;
    this._axromReg = reg;

    this.SelectPrgPage(0, reg & 0x0F);
    this.SetMirroringType((reg & 0x10) ? this.MIRROR_SINGLE_B : this.MIRROR_SINGLE_A);
  }

  initMapper() {
    this.SelectChrPage(0, 0);
    this.writeRegister(0, this._getPowerOnByte());
  }

  reset(softReset = false) {
    super.reset(softReset);
    this.SelectChrPage(0, 0);
    this.writeRegister(0, this._getPowerOnByte());
  }

  writeRegister(_addr, value) {
    this._applyRegister(value);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mapper007: {
        reg: this._axromReg ?? 0,
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);
    this.SelectChrPage(0, 0);
    this._applyRegister((state && state.mapper007 && state.mapper007.reg) ?? 0);
  }
}

import BaseMapper from "./mapper-base.js";

// Mapper 079 (NINA-03 / NINA-06)
// Mesen reference behavior from mesen-nina03_06.h.
export default class Mapper079 extends BaseMapper {
  getPrgPageSize() {
    return 0x8000;
  }

  getChrPageSize() {
    return 0x2000;
  }

  registerStartAddress() {
    return 0x4100;
  }

  registerEndAddress() {
    return 0x5fff;
  }

  _isMulticartMode() {
    // Mesen uses the same core for mapper 79 (false) and 113 (true).
    // This mapper file is registered as 79, so this resolves to false in normal use.
    return !!(this.cartridge && (this.cartridge.mapperType | 0) === 113);
  }

  _applyRegister(value) {
    const reg = value & 0xff;
    this._reg = reg;

    if (this._isMulticartMode()) {
      // Mapper 113 mode (not used by mapper 79 registration, but kept
      // for parity with the Mesen Nina03_06 core behavior).
      this.SelectPrgPage(0, (reg >> 3) & 0x07);
      this.SelectChrPage(0, (reg & 0x07) | ((reg >> 3) & 0x08));
      this.SetMirroringType((reg & 0x80) === 0x80 ? this.MIRROR_VERTICAL : this.MIRROR_HORIZONTAL);
      return;
    }

    this.SelectPrgPage(0, (reg >> 3) & 0x01);
    this.SelectChrPage(0, reg & 0x07);
  }

  initMapper() {
    this.SelectPrgPage(0, 0);
    this.SelectChrPage(0, 0);
    this._reg = 0;
  }

  reset(softReset = false) {
    super.reset(softReset);
    this.initMapper();
  }

  writeRegister(addr, value) {
    const address = addr & 0xffff;
    if ((address & 0xe100) !== 0x4100) {
      return;
    }
    this._applyRegister(value);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mapper079: {
        reg: this._reg | 0,
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);
    const reg = (state && state.mapper079 && state.mapper079.reg) ?? 0;
    this._applyRegister(reg);
  }
}

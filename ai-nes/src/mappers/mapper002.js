import BaseMapper from "./mapper-base.js";

// Mapper 002 (UNROM/UOROM family baseline)
// Mesen reference (UNROM):
// - PRG: 16KB banks at $8000 (switchable), $C000 fixed to last bank
// - CHR: 8KB fixed (CHR-ROM page 0 or CHR-RAM page 0)
// - Bus conflicts only for NES 2.0 submapper 2
export default class Mapper002 extends BaseMapper {
  getPrgPageSize() {
    return 0x4000;
  }

  getChrPageSize() {
    return 0x2000;
  }

  hasBusConflicts() {
    return !!(this.cartridge && ((this.cartridge.submapper | 0) === 2));
  }

  _applyBankState() {
    this.SelectPrgPage(0, this._prgBank | 0);
    this.SelectPrgPage(1, -1);
    this.SelectChrPage(0, 0);
  }

  initMapper() {
    this._prgBank = 0;
    this._applyBankState();
  }

  reset(softReset = false) {
    super.reset(softReset);
    this._prgBank = 0;
    this._applyBankState();
  }

  writeRegister(_addr, value) {
    this._prgBank = value & 0xFF;
    this._applyBankState();
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mapper002: {
        prgBank: this._prgBank | 0,
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);
    this._prgBank = (state && state.mapper002 && state.mapper002.prgBank) ?? this._prgBank ?? 0;
    this._applyBankState();
  }
}

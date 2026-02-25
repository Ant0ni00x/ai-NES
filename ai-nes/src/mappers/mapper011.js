import BaseMapper from "./mapper-base.js";

// Mapper 011 (Color Dreams)
// Mesen reference behavior from mesen-colordreams.h:
// - PRG: 32KB switchable bank (low nibble)
// - CHR: 8KB switchable bank (high nibble)
// - Bus conflicts: enabled
// - Mapper 144 variant: ROM LSB always wins conflict
export default class Mapper011 extends BaseMapper {
  getPrgPageSize() {
    return 0x8000;
  }

  getChrPageSize() {
    return 0x2000;
  }

  hasBusConflicts() {
    return true;
  }

  _applyRegister(value) {
    const reg = value & 0xFF;
    this._reg = reg;

    this.SelectPrgPage(0, reg & 0x0F);
    this.SelectChrPage(0, (reg >> 4) & 0x0F);
  }

  initMapper() {
    this._applyRegister(0);
  }

  reset(softReset = false) {
    super.reset(softReset);
    this._applyRegister(0);
  }

  writeRegister(addr, value) {
    let writeValue = value & 0xFF;

    // Mesen mapper 144 quirk:
    // only ROM bit 0 always wins bus conflicts.
    if (this.cartridge && (this.cartridge.mapperType | 0) === 144) {
      writeValue |= this.readRam(addr & 0xFFFF) & 0x01;
    }

    this._applyRegister(writeValue);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mapper011: {
        reg: this._reg ?? 0,
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);
    this._applyRegister((state && state.mapper011 && state.mapper011.reg) ?? 0);
  }
}

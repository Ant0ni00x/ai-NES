import BaseMapper from "./mapper-base.js";

// Mapper 066 (GxROM)
// Mesen reference behavior from mesen-gxrom.h:
// - PRG: 32KB bank selected by value bits 4-5
// - CHR: 8KB bank selected by value bits 0-1
export default class Mapper066 extends BaseMapper {
  getPrgPageSize() {
    return 0x8000;
  }

  getChrPageSize() {
    return 0x2000;
  }

  _getPowerOnByte(defaultValue = 0) {
    // This codebase does not currently expose RandomizeMapperPowerOnState.
    return defaultValue & 0xFF;
  }

  _applyRegister(value) {
    const reg = value & 0xFF;
    this._reg = reg;

    this.SelectPrgPage(0, (reg >> 4) & 0x03);
    this.SelectChrPage(0, reg & 0x03);
  }

  initMapper() {
    const prgPowerOn = this._getPowerOnByte() & 0x03;
    const chrPowerOn = this._getPowerOnByte() & 0x03;
    this._applyRegister((prgPowerOn << 4) | chrPowerOn);
  }

  reset(softReset = false) {
    super.reset(softReset);
    this.initMapper();
  }

  writeRegister(_addr, value) {
    this._applyRegister(value);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mapper066: {
        reg: this._reg | 0,
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);
    this._applyRegister((state && state.mapper066 && state.mapper066.reg) ?? 0);
  }
}

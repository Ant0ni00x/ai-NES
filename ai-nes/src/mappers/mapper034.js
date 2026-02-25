import BaseMapper from "./mapper-base.js";

// Mapper 034 (BNROM / NINA-001, merged)
// Mesen references:
// - BNROM: mesen-bnrom.h
// - NINA-001: mesen-nina001.h
export default class Mapper034 extends BaseMapper {
  getPrgPageSize() {
    return 0x8000;
  }

  getChrPageSize() {
    return this._isNinaBoard() ? 0x1000 : 0x2000;
  }

  hasBusConflicts() {
    return !this._isNinaBoard();
  }

  registerStartAddress() {
    return this._isNinaBoard() ? 0x7FFD : 0x8000;
  }

  registerEndAddress() {
    return this._isNinaBoard() ? 0x7FFF : 0xFFFF;
  }

  _getPowerOnByte(defaultValue = 0) {
    // This codebase does not currently expose RandomizeMapperPowerOnState.
    return defaultValue & 0xFF;
  }

  _isNinaBoard() {
    const mapperId = (this.cartridge && (this.cartridge.mapperType | 0)) || 0;
    const submapper = (this.cartridge && (this.cartridge.submapper | 0)) || 0;

    if (mapperId !== 34) {
      return false;
    }

    // NES 2.0 explicit split:
    // submapper 1 = NINA-001/002, submapper 2 = BNROM.
    if (submapper === 1) return true;
    if (submapper === 2) return false;

    // Legacy iNES mapper 34 fallback (Mesen behavior):
    // CHR-ROM present => NINA-001, otherwise BNROM.
    // Use constructor-safe sources first (chrData/cartridge.chr), because
    // BaseMapper caches bus conflicts + register ranges before _chrRomSize
    // is initialized.
    const chrLen =
      (this.chrData && (this.chrData.length | 0)) ||
      (this.cartridge && this.cartridge.chr && (this.cartridge.chr.length | 0)) ||
      (this._chrRomSize | 0);
    return chrLen > 0;
  }

  _applyBnromBank(value) {
    this._prgBank = value & 0xFF;
    // Mesen BNROM uses the full register value (no extra masking).
    this.SelectPrgPage(0, this._prgBank);
    this.SelectChrPage(0, 0);
  }

  _initNina() {
    this._prgBank = 0;
    this._chrBank0 = 0;
    this._chrBank1 = 1;
    this.SelectPrgPage(0, 0);
    this.SelectChrPage(0, this._chrBank0);
    this.SelectChrPage(1, this._chrBank1);
  }

  initMapper() {
    if (this._isNinaBoard()) {
      this._initNina();
    } else {
      this._applyBnromBank(this._getPowerOnByte());
    }
  }

  reset(softReset = false) {
    super.reset(softReset);
    this.initMapper();
  }

  writeRegister(addr, value) {
    const address = addr & 0xFFFF;
    const writeValue = value & 0xFF;

    if (this._isNinaBoard()) {
      switch (address) {
        case 0x7FFD:
          this._prgBank = writeValue & 0x01;
          this.SelectPrgPage(0, this._prgBank);
          break;
        case 0x7FFE:
          this._chrBank0 = writeValue & 0x0F;
          this.SelectChrPage(0, this._chrBank0);
          break;
        case 0x7FFF:
          this._chrBank1 = writeValue & 0x0F;
          this.SelectChrPage(1, this._chrBank1);
          break;
      }

      // Mesen NINA-001 writes through PRG RAM at these addresses.
      this.writePrgRam(address, writeValue);
      return;
    }

    this._applyBnromBank(writeValue);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mapper034: {
        mode: this._isNinaBoard() ? "nina" : "bnrom",
        prgBank: this._prgBank | 0,
        chrBank0: this._chrBank0 ?? 0,
        chrBank1: this._chrBank1 ?? 1,
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);

    const s = (state && state.mapper034) || null;
    if (!s) {
      this.initMapper();
      return;
    }

    if (this._isNinaBoard()) {
      this._prgBank = (s.prgBank ?? 0) & 0x01;
      this._chrBank0 = (s.chrBank0 ?? 0) & 0x0F;
      this._chrBank1 = (s.chrBank1 ?? 1) & 0x0F;
      this.SelectPrgPage(0, this._prgBank);
      this.SelectChrPage(0, this._chrBank0);
      this.SelectChrPage(1, this._chrBank1);
      return;
    }

    this._applyBnromBank((s.prgBank ?? 0) & 0xFF);
  }
}

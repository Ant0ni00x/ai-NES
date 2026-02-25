import Mapper004 from "./mapper004.js";

// Mapper 047 (MMC3_47 / NES-QJ)
// Mesen reference behavior from mesen-mmc3-47.h:
// - Extends MMC3
// - Register range is $6000-$FFFF
// - $6000-$7FFF selects 128k PRG/CHR block when WRAM writes are allowed
// - PRG/CHR page selection is masked and OR'ed with selected block
export default class Mapper047 extends Mapper004 {
  registerStartAddress() {
    return 0x6000;
  }

  registerEndAddress() {
    return 0xFFFF;
  }

  selectChrPage(slot, page, memoryType = this.ChrMemoryType.Default) {
    let mappedPage = page & 0x7F;
    if ((this._selectedBlock | 0) === 1) {
      mappedPage |= 0x80;
    }
    return super.selectChrPage(slot, mappedPage, memoryType);
  }

  selectPrgPage(slot, page, memoryType = this.PrgMemoryType.PrgRom) {
    let mappedPage = page & 0x0F;
    if ((this._selectedBlock | 0) === 1) {
      mappedPage |= 0x10;
    }
    return super.selectPrgPage(slot, mappedPage, memoryType);
  }

  initMapper() {
    super.initMapper();
    this._selectedBlock = 0;
    this._updateState();
  }

  reset(softReset = false) {
    super.reset(softReset);
    this._selectedBlock = 0;
    this._updateState();
  }

  writeRegister(addr, value) {
    const address = addr & 0xFFFF;
    const writeValue = value & 0xFF;

    if (address < 0x8000) {
      if (this._canWriteToWorkRam()) {
        this._selectedBlock = writeValue & 0x01;
        this._updateState();
      }
      return;
    }

    super.writeRegister(address, writeValue);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mapper047: {
        selectedBlock: this._selectedBlock | 0,
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);
    this._selectedBlock = (state && state.mapper047 && state.mapper047.selectedBlock) ?? 0;
    this._selectedBlock &= 0x01;
    this._updateState();
  }
}

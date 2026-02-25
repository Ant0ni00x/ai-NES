import Mapper009 from "./mapper009.js";

// Mapper 010 (MMC4)
// Mesen reference behavior from mesen-mmc4.h:
// - Inherits MMC2 register/latch model
// - PRG page size is 16KB ($8000 switchable, $C000 fixed to last)
// - Left latch uses ranges $0FD8-$0FDF and $0FE8-$0FEF
export default class Mapper010 extends Mapper009 {
  getPrgPageSize() {
    return 0x4000;
  }

  getChrPageSize() {
    return 0x1000;
  }

  enableVramAddressHook() {
    return true;
  }

  _initMmc2State() {
    this._leftLatch = 1;
    this._rightLatch = 1;
    this._prgPage = 0;
    this._leftChrPage = new Uint8Array(2);
    this._rightChrPage = new Uint8Array(2);
    this._leftChrPage[0] = this._getPowerOnByte() & 0x1F;
    this._leftChrPage[1] = this._getPowerOnByte() & 0x1F;
    this._rightChrPage[0] = this._getPowerOnByte() & 0x1F;
    this._rightChrPage[1] = this._getPowerOnByte() & 0x1F;
    this._needChrUpdate = false;

    // MMC4 keeps the upper 16KB fixed to the last bank.
    this.SelectPrgPage(1, -1);
  }

  notifyVramAddressChange(addr, _context = null) {
    const vramAddr = addr & 0x3FFF;

    if (this._needChrUpdate) {
      this._applyLatchedChrPages();
      this._needChrUpdate = false;
    }

    if (vramAddr >= 0x0FD8 && vramAddr <= 0x0FDF) {
      this._leftLatch = 0;
      this._needChrUpdate = true;
    } else if (vramAddr >= 0x0FE8 && vramAddr <= 0x0FEF) {
      this._leftLatch = 1;
      this._needChrUpdate = true;
    } else if (vramAddr >= 0x1FD8 && vramAddr <= 0x1FDF) {
      this._rightLatch = 0;
      this._needChrUpdate = true;
    } else if (vramAddr >= 0x1FE8 && vramAddr <= 0x1FEF) {
      this._rightLatch = 1;
      this._needChrUpdate = true;
    }
  }

  fromJSON(state) {
    super.fromJSON(state);

    // MMC4 differs from MMC2: upper 16KB is fixed to last page.
    // Re-assert MMC4 PRG layout after restoring shared MMC2 fields/state.
    this.SelectPrgPage(0, (this._prgPage ?? 0) & 0x0F);
    this.SelectPrgPage(1, -1);
  }
}

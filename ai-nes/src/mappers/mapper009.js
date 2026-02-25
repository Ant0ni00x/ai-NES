import BaseMapper from "./mapper-base.js";

// Mapper 009 (MMC2)
// Mesen reference behavior from mesen-mmc2.h:
// - PRG: 8KB bank at $8000 switchable, $A000/$C000/$E000 fixed to last 3 banks
// - CHR: two 4KB regions with latch-selected bank pairs
// - Mirroring: controlled by $F000 bit 0
// - Latches: clocked by PPU VRAM address hook
export default class Mapper009 extends BaseMapper {
  getPrgPageSize() {
    return 0x2000;
  }

  getChrPageSize() {
    return 0x1000;
  }

  enableVramAddressHook() {
    return true;
  }

  _getPowerOnByte(defaultValue = 0) {
    // This codebase does not currently expose RandomizeMapperPowerOnState.
    return defaultValue & 0xFF;
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

    // Mesen MMC2 init maps only the fixed upper 24KB at power-on.
    this.RemoveCpuMemoryMapping(0x8000, 0x9FFF);
    this.SelectPrgPage(1, -3);
    this.SelectPrgPage(2, -2);
    this.SelectPrgPage(3, -1);

    // Keep CHR unmapped until register writes/latch flow programs pages.
    if ((this._chrRomSize | 0) > 0) {
      this.RemovePpuMemoryMapping(0x0000, 0x1FFF);
    }
  }

  _applyLatchedChrPages() {
    this.SelectChrPage(0, this._leftChrPage[this._leftLatch & 0x01]);
    this.SelectChrPage(1, this._rightChrPage[this._rightLatch & 0x01]);
  }

  initMapper() {
    this._initMmc2State();
  }

  reset(softReset = false) {
    super.reset(softReset);
    this._initMmc2State();
  }

  writeRegister(addr, value) {
    const address = (addr >> 12) & 0x0F;
    const writeValue = value & 0xFF;

    switch (address) {
      case 0x0A:
        this._prgPage = writeValue & 0x0F;
        this.SelectPrgPage(0, this._prgPage);
        break;

      case 0x0B:
        this._leftChrPage[0] = writeValue & 0x1F;
        this.SelectChrPage(0, this._leftChrPage[this._leftLatch & 0x01]);
        break;

      case 0x0C:
        this._leftChrPage[1] = writeValue & 0x1F;
        this.SelectChrPage(0, this._leftChrPage[this._leftLatch & 0x01]);
        break;

      case 0x0D:
        this._rightChrPage[0] = writeValue & 0x1F;
        this.SelectChrPage(1, this._rightChrPage[this._rightLatch & 0x01]);
        break;

      case 0x0E:
        this._rightChrPage[1] = writeValue & 0x1F;
        this.SelectChrPage(1, this._rightChrPage[this._rightLatch & 0x01]);
        break;

      case 0x0F:
        this.SetMirroringType((writeValue & 0x01) ? this.MIRROR_HORIZONTAL : this.MIRROR_VERTICAL);
        break;
    }
  }

  notifyVramAddressChange(addr, _context = null) {
    const vramAddr = addr & 0x3FFF;

    if (this._needChrUpdate) {
      this._applyLatchedChrPages();
      this._needChrUpdate = false;
    }

    if (vramAddr === 0x0FD8) {
      this._leftLatch = 0;
      this._needChrUpdate = true;
    } else if (vramAddr === 0x0FE8) {
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

  toJSON() {
    return {
      ...super.toJSON(),
      mmc2: {
        prgPage: this._prgPage | 0,
        leftLatch: this._leftLatch | 0,
        rightLatch: this._rightLatch | 0,
        needChrUpdate: !!this._needChrUpdate,
        leftChrPage: [this._leftChrPage[0] | 0, this._leftChrPage[1] | 0],
        rightChrPage: [this._rightChrPage[0] | 0, this._rightChrPage[1] | 0],
      },
    };
  }

  fromJSON(state) {
    super.fromJSON(state);

    const s = state && state.mmc2;
    if (!s) {
      return;
    }

    this._prgPage = (s.prgPage ?? this._prgPage ?? 0) & 0x0F;
    this._leftLatch = (s.leftLatch ?? this._leftLatch ?? 1) & 0x01;
    this._rightLatch = (s.rightLatch ?? this._rightLatch ?? 1) & 0x01;
    this._needChrUpdate = !!(s.needChrUpdate ?? this._needChrUpdate);

    const left = Array.isArray(s.leftChrPage) ? s.leftChrPage : [];
    const right = Array.isArray(s.rightChrPage) ? s.rightChrPage : [];
    this._leftChrPage = new Uint8Array(2);
    this._rightChrPage = new Uint8Array(2);
    this._leftChrPage[0] = (left[0] ?? 0) & 0x1F;
    this._leftChrPage[1] = (left[1] ?? 0) & 0x1F;
    this._rightChrPage[0] = (right[0] ?? 0) & 0x1F;
    this._rightChrPage[1] = (right[1] ?? 0) & 0x1F;

    this.SelectPrgPage(1, -3);
    this.SelectPrgPage(2, -2);
    this.SelectPrgPage(3, -1);
    this.SelectPrgPage(0, this._prgPage);
    if (!this._needChrUpdate) {
      this._applyLatchedChrPages();
    }
  }
}

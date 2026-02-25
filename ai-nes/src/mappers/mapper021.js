import Mapper025 from "./mapper025.js";

// Mapper 021 (Konami VRC4a / VRC4c)
// Reuses VRC2/4 core from mapper025, with mapper-21 specific
// submapper variant selection and address-line translation.
export default class Mapper021 extends Mapper025 {
  _detectVariant() {
    const mapperId = (this.cartridge && (this.cartridge.mapperType | 0)) || 0;
    const submapper = (this.cartridge && (this.cartridge.submapper | 0)) || 0;

    // Mesen mapper 21:
    // submapper 0/1 => VRC4a, submapper 2 => VRC4c
    switch (submapper) {
      case 2:
        this._variant = 2; // VRC4c
        break;
      case 1:
      case 0:
      default:
        this._variant = 1; // VRC4a
        break;
    }

    this._useHeuristics = mapperId === 21 && submapper === 0;
  }

  _translateAddress(addr) {
    const address = addr & 0xFFFF;
    let a0 = 0;
    let a1 = 0;

    if (this._useHeuristics) {
      // Mapper 21 heuristic mode: OR VRC4a and VRC4c line mappings.
      a0 = (address >> 1) & 0x01;
      a1 = (address >> 2) & 0x01;
      a0 |= (address >> 6) & 0x01;
      a1 |= (address >> 7) & 0x01;
    } else if ((this._variant | 0) === 2) {
      // VRC4c
      a0 = (address >> 6) & 0x01;
      a1 = (address >> 7) & 0x01;
    } else {
      // VRC4a
      a0 = (address >> 1) & 0x01;
      a1 = (address >> 2) & 0x01;
    }

    return ((address & 0xFF00) | (a1 << 1) | a0) & 0xFFFF;
  }

  toJSON() {
    const state = super.toJSON();
    if (state && state.mapper025) {
      state.mapper021 = state.mapper025;
      delete state.mapper025;
    }
    return state;
  }

  fromJSON(state) {
    // Mapper 21 uses mapper021 as its canonical state key while reusing mapper025 internals.
    const mappedState = state ? { ...state, mapper025: state.mapper021 } : state;
    super.fromJSON(mappedState);
  }
}

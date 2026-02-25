import Mapper004 from "./mapper004.js";

// Mapper 006 (MMC6, HKROM board)
// MMC6 is a Mapper 4 variant with split 1KB battery-backed RAM protection.
// This class reuses MMC3/MMC6 core behavior from Mapper004 and forces MMC6 mode.
export default class Mapper006 extends Mapper004 {
  constructor(cartridge) {
    const cart = cartridge || {};

    // MMC6 boards are battery-backed in practice (StarTropics / Zoda's Revenge).
    // Force battery on for legacy/inaccurate headers so 1KB save RAM is allocated.
    cart.batteryRam = true;

    super(cart);
  }

  _isMmc6() {
    return true;
  }

  // Prefer mapper-defined MMC6 RAM size even when NES 2.0 header RAM fields are wrong.
  forceSaveRamSize() {
    return true;
  }
}

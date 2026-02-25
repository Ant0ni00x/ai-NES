// ============================================================================
// NES Base Mapper (Mesen-style baseline)
// Mapper as independent hardware: owns PRG/CHR address decoding + RAM + mirroring
// ============================================================================

const ACCESS_NONE = 0;
const ACCESS_READ = 1;
const ACCESS_WRITE = 2;
const ACCESS_READWRITE = ACCESS_READ | ACCESS_WRITE;

export const MemoryOperation = Object.freeze({
  Read: 1,
  Write: 2,
  Any: 3,
});

export const PrgMemoryType = Object.freeze({
  PrgRom: 0,
  SaveRam: 1,
  WorkRam: 2,
  MapperRam: 3,
});

export const ChrMemoryType = Object.freeze({
  Default: 0,
  ChrRom: 1,
  ChrRam: 2,
  NametableRam: 3,
  MapperRam: 4,
});

const SLOT_SIZE = 0x100;
const CPU_SLOT_COUNT = 0x100;
const PPU_SLOT_COUNT = 0x40; // $0000-$3FFF

function wrapPage(page, pageCount) {
  if (pageCount <= 0) {
    return 0;
  }
  return ((page % pageCount) + pageCount) % pageCount;
}

function normalizeOffset(offset, sourceSize) {
  if (sourceSize <= 0) {
    return 0;
  }
  let value = offset | 0;
  while (value < 0) {
    value += sourceSize;
  }
  while (value >= sourceSize) {
    value -= sourceSize;
  }
  return value;
}

export default class BaseMapper {
  static NametableSize = 0x400;

  constructor(cartridge) {
    this.cartridge = cartridge || {};
    this.nes = this.cartridge.nes || null;

    // Public compatibility surface.
    this.prgData = this._copyBytes(this.cartridge.prg);
    this.chrData = this._copyBytes(this.cartridge.chr);
    this.usingChrRam = false;

    this.hasChrLatch = false;
    this.hasScanlineIrq = false;
    this.hasNametableOverride = false;
    this.hasPpuA13ChrSwitch = false;
    this.hasVramAddressHook = false;

    this.MIRROR_HORIZONTAL = 0;
    this.MIRROR_VERTICAL = 1;
    this.MIRROR_SINGLE_A = 2;
    this.MIRROR_SINGLE_B = 3;
    this.MIRROR_FOUR_SCREEN = 4;

    // Expose enum-like constants for mapper implementations.
    this.MemoryOperation = MemoryOperation;
    this.PrgMemoryType = PrgMemoryType;
    this.ChrMemoryType = ChrMemoryType;
    this.MemoryAccessType = {
      NoAccess: ACCESS_NONE,
      Read: ACCESS_READ,
      Write: ACCESS_WRITE,
      ReadWrite: ACCESS_READWRITE,
    };

    this._mirroringType = this._getRomMirroringType();
    this._allowRegisterRead = !!this.allowRegisterRead();
    this._hasCpuClockHook = !!this.enableCpuClockHook();
    this._hasCustomReadVram = !!this.enableCustomVramRead();
    this.hasVramAddressHook = !!this.enableVramAddressHook();
    this._hasBusConflicts = !!this.hasBusConflicts();
    this._hasDefaultWorkRam = false;

    this._prgRom = this.prgData;
    this._chrRom = this.chrData;
    this._prgSize = this._prgRom.length;
    this._chrRomSize = this._chrRom.length;

    this._saveRamSize = this._resolveSaveRamSize();
    this._workRamSize = this._resolveWorkRamSize();
    this._mapperRamSize = Math.max(0, this.getMapperRamSize() | 0);

    this._saveRam = new Uint8Array(this._saveRamSize);
    this._workRam = new Uint8Array(this._workRamSize);
    this._mapperRam = new Uint8Array(this._mapperRamSize);
    this._chrRam = new Uint8Array(0);
    this._chrRamSize = 0;
    this._hasChrBattery = !!((this.cartridge && this.cartridge.chrNvRamSizeBytes > 0) || this.forceChrBattery());

    this._fillRam(this._saveRam);
    this._fillRam(this._workRam);
    this._fillRam(this._mapperRam);

    this._nametableCount = this.getNametableCount() | 0;
    if (this._nametableCount <= 0) {
      this._nametableCount = this.cartridge && this.cartridge.fourScreen ? 4 : 2;
    }
    this._ntRamSize = this._nametableCount * BaseMapper.NametableSize;
    this._nametableRam = new Uint8Array(this._ntRamSize);
    this._fillRam(this._nametableRam);

    this._isReadRegisterAddr = new Uint8Array(0x10000);
    this._isWriteRegisterAddr = new Uint8Array(0x10000);

    this._prgPageSource = new Array(CPU_SLOT_COUNT).fill(null);
    this._prgMemoryAccess = new Uint8Array(CPU_SLOT_COUNT).fill(ACCESS_NONE);
    this._prgMemoryOffset = new Int32Array(CPU_SLOT_COUNT);
    this._prgMemoryType = new Uint8Array(CPU_SLOT_COUNT).fill(PrgMemoryType.PrgRom);
    this._prgMemoryOffset.fill(-1);

    this._chrPageSource = new Array(PPU_SLOT_COUNT).fill(null);
    this._chrMemoryAccess = new Uint8Array(PPU_SLOT_COUNT).fill(ACCESS_NONE);
    this._chrMemoryOffset = new Int32Array(PPU_SLOT_COUNT);
    this._chrMemoryType = new Uint8Array(PPU_SLOT_COUNT).fill(ChrMemoryType.Default);
    this._chrMemoryOffset.fill(-1);

    this.addRegisterRange(this.registerStartAddress(), this.registerEndAddress(), MemoryOperation.Any);

    this._initializeChrMemory();
    this._loadTrainer();
    this.setupDefaultWorkRam();
    this.setMirroringType(this._getRomMirroringType());
    this.loadBattery();

    this.initMapper();
    this.initMapperFromRom(this.cartridge);
  }

  // ===========================================================================
  // Mapper hook surface (subclasses override)
  // ===========================================================================

  initMapper() {}
  initMapperFromRom(_romData) {}
  onAfterResetPowerOn() {}
  reset(_softReset = false) {
    this._prgPageSource.fill(null);
    this._prgMemoryAccess.fill(ACCESS_NONE);
    this._prgMemoryOffset.fill(-1);
    this._prgMemoryType.fill(PrgMemoryType.PrgRom);

    this._chrPageSource.fill(null);
    this._chrMemoryAccess.fill(ACCESS_NONE);
    this._chrMemoryOffset.fill(-1);
    this._chrMemoryType.fill(ChrMemoryType.Default);

    this._mapDefaultPrg();
    this._mapDefaultChr();
    this.setupDefaultWorkRam();
    this.setMirroringType(this._getRomMirroringType());
    this.onAfterResetPowerOn();
  }

  loadROM() {
    // Kept for compatibility with current NES bootstrap flow.
  }

  getPrgPageSize() { return 0x4000; }
  getChrPageSize() { return 0x2000; }
  getChrRamPageSize() { return this.getChrPageSize(); }
  getSaveRamSize() { return 0x2000; }
  getSaveRamPageSize() { return 0x2000; }
  getWorkRamSize() { return 0x2000; }
  getWorkRamPageSize() { return 0x2000; }
  getChrRamSize() { return 0; }
  getMapperRamSize() { return 0; }
  getDipSwitchCount() { return 0; }
  getNametableCount() { return 0; }
  forceChrBattery() { return false; }
  forceSaveRamSize() { return false; }
  forceWorkRamSize() { return false; }
  allowRegisterRead() { return false; }
  enableCpuClockHook() { return false; }
  enableCustomVramRead() { return false; }
  enableVramAddressHook() { return false; }
  hasBusConflicts() { return false; }
  registerStartAddress() { return 0x8000; }
  registerEndAddress() { return 0xFFFF; }

  writeRegister(_addr, _value) {}
  readRegister(_addr) { return 0; }
  notifyVramAddressChange(_addr, _context = null) {}
  onPpuRegisterWrite(_addr, _value, _context = null) {}
  onStartScanline(_scanline, _renderingEnabled, _context = null) {}
  onEndScanline(_scanline, _context = null) {}
  scanlineCounter(_context = null) {}

  processCpuClock() {}
  setRegion(_region) {}
  cpuClock(cycles = 1) {
    if (!this._hasCpuClockHook) {
      return;
    }
    const stepCount = Math.max(0, cycles | 0);
    for (let i = 0; i < stepCount; i++) {
      this.processCpuClock();
    }
  }

  // CPU currently calls both `step(1)` and `cpuClock(1)` as compatibility hooks.
  // Keep `step` as a no-op default to avoid double-clocking in base implementations.
  step(_cycles = 1) {}

  // ===========================================================================
  // Initialization helpers
  // ===========================================================================

  _copyBytes(value) {
    if (value instanceof Uint8Array) {
      return new Uint8Array(value);
    }
    return new Uint8Array(0);
  }

  _fillRam(buffer) {
    if (!buffer || buffer.length === 0) {
      return;
    }

    const pattern = String((this.nes && this.nes.opts && this.nes.opts.ramInitPattern) || "hardware").toLowerCase();
    if (pattern === "all_ff") {
      buffer.fill(0xFF);
      return;
    }
    if (pattern === "all_zero") {
      buffer.fill(0x00);
      return;
    }
    if (pattern === "random") {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] = (Math.random() * 256) | 0;
      }
      return;
    }

    // Hardware-like repeating 00/FF pattern.
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] = ((i & 1) ^ ((i >> 3) & 1)) ? 0xFF : 0x00;
    }
  }

  _hasBattery() {
    const battery = this.cartridge ? this.cartridge.batteryRam : false;
    return battery === true || (!!battery && battery.length > 0);
  }

  _resolveSaveRamSize() {
    const rom = this.cartridge || {};
    if (rom.prgNvRamSizeBytes >= 0) {
      if (this.forceSaveRamSize()) {
        return Math.max(0, this.getSaveRamSize() | 0);
      }
      return Math.max(0, rom.prgNvRamSizeBytes | 0);
    }
    return this._hasBattery() ? Math.max(0, this.getSaveRamSize() | 0) : 0;
  }

  _resolveWorkRamSize() {
    const rom = this.cartridge || {};
    if (rom.prgRamSizeBytes >= 0) {
      if (this.forceWorkRamSize()) {
        return Math.max(0, this.getWorkRamSize() | 0);
      }
      return Math.max(0, rom.prgRamSizeBytes | 0);
    }
    return this._hasBattery() ? 0 : Math.max(0, this.getWorkRamSize() | 0);
  }

  _initializeChrMemory() {
    const rom = this.cartridge || {};
    if (this._chrRomSize === 0) {
      this.initializeChrRam(rom.chrRamSizeBytes);
      this.usingChrRam = this._chrRamSize > 0;
      this.setPpuMemoryMapping(0x0000, 0x1FFF, 0, ChrMemoryType.ChrRam);
    } else {
      if (rom.chrRamSizeBytes >= 0) {
        this.initializeChrRam(rom.chrRamSizeBytes);
      } else if ((this.getChrRamSize() | 0) > 0) {
        this.initializeChrRam();
      }
      this.usingChrRam = false;
    }
  }

  _loadTrainer() {
    const trainerData = this.cartridge && this.cartridge.trainerData;
    if (!(trainerData instanceof Uint8Array) || trainerData.length < 512) {
      return;
    }
    if (this._workRamSize >= 0x2000) {
      this._workRam.set(trainerData.subarray(0, 512), 0x1000);
    } else if (this._saveRamSize >= 0x2000) {
      this._saveRam.set(trainerData.subarray(0, 512), 0x1000);
    }
  }

  _getRomMirroringType() {
    if (this.cartridge && typeof this.cartridge.getMirroringType === "function") {
      return this.cartridge.getMirroringType() & 0xFF;
    }
    if (this.cartridge && this.cartridge.fourScreen) {
      return this.MIRROR_FOUR_SCREEN;
    }
    return this.cartridge && this.cartridge.mirroring ? this.MIRROR_VERTICAL : this.MIRROR_HORIZONTAL;
  }

  _mapDefaultPrg() {
    const pageSize = this._internalGetPrgPageSize();
    if (pageSize <= 0 || this._prgSize <= 0) {
      return;
    }

    const slotCount = Math.max(1, (0x8000 / pageSize) | 0);
    for (let slot = 0; slot < slotCount; slot++) {
      this.selectPrgPage(slot, slot, PrgMemoryType.PrgRom);
    }
  }

  _mapDefaultChr() {
    if (this._chrRomSize === 0 && this._chrRamSize === 0) {
      return;
    }
    this.setPpuMemoryMapping(0x0000, 0x1FFF, 0, ChrMemoryType.Default);
  }

  // ===========================================================================
  // Page size / source resolution
  // ===========================================================================

  _internalGetPrgPageSize() {
    const page = Math.max(0, this.getPrgPageSize() | 0);
    if (this._prgSize <= 0) {
      return page;
    }
    return Math.min(page, this._prgSize);
  }

  _internalGetSaveRamPageSize() {
    const page = Math.max(0, this.getSaveRamPageSize() | 0);
    if (this._saveRamSize <= 0) {
      return page;
    }
    return Math.min(page, this._saveRamSize);
  }

  _internalGetWorkRamPageSize() {
    const page = Math.max(0, this.getWorkRamPageSize() | 0);
    if (this._workRamSize <= 0) {
      return page;
    }
    return Math.min(page, this._workRamSize);
  }

  _internalGetChrRomPageSize() {
    const page = Math.max(0, this.getChrPageSize() | 0);
    if (this._chrRomSize <= 0) {
      return page;
    }
    return Math.min(page, this._chrRomSize);
  }

  _internalGetChrRamPageSize() {
    const page = Math.max(0, this.getChrRamPageSize() | 0);
    if (this._chrRamSize <= 0) {
      return page;
    }
    return Math.min(page, this._chrRamSize);
  }

  _resolvePrgSource(type) {
    switch (type) {
      case PrgMemoryType.PrgRom: return { source: this._prgRom, size: this._prgSize };
      case PrgMemoryType.SaveRam: return { source: this._saveRam, size: this._saveRamSize };
      case PrgMemoryType.WorkRam: return { source: this._workRam, size: this._workRamSize };
      case PrgMemoryType.MapperRam: return { source: this._mapperRam, size: this._mapperRamSize };
      default: return { source: null, size: 0 };
    }
  }

  _resolveChrSource(type) {
    let resolvedType = type;
    if (resolvedType === ChrMemoryType.Default) {
      resolvedType = this._chrRomSize > 0 ? ChrMemoryType.ChrRom : ChrMemoryType.ChrRam;
    }
    switch (resolvedType) {
      case ChrMemoryType.ChrRom: return { type: resolvedType, source: this._chrRom, size: this._chrRomSize };
      case ChrMemoryType.ChrRam: return { type: resolvedType, source: this._chrRam, size: this._chrRamSize };
      case ChrMemoryType.NametableRam: return { type: resolvedType, source: this._nametableRam, size: this._ntRamSize };
      case ChrMemoryType.MapperRam: return { type: resolvedType, source: this._mapperRam, size: this._mapperRamSize };
      default: return { type: resolvedType, source: null, size: 0 };
    }
  }

  _validateAddressRange(startAddr, endAddr) {
    const start = startAddr & 0xFFFF;
    const end = endAddr & 0xFFFF;
    if ((start & 0xFF) !== 0 || (end & 0xFF) !== 0xFF) {
      return false;
    }
    return end > start;
  }

  // ===========================================================================
  // CPU memory mapping
  // ===========================================================================

  setCpuMemoryMapping(startAddr, endAddr, pageNumber, type = PrgMemoryType.PrgRom, accessType = -1) {
    const start = startAddr & 0xFFFF;
    const end = endAddr & 0xFFFF;
    if (!this._validateAddressRange(start, end) || start > 0xFF00) {
      return;
    }

    let pageSize = 0;
    let pageCount = 0;
    let defaultAccess = ACCESS_READ;

    switch (type) {
      case PrgMemoryType.PrgRom:
        pageSize = this._internalGetPrgPageSize();
        pageCount = pageSize > 0 ? ((this._prgSize / pageSize) | 0) : 0;
        break;
      case PrgMemoryType.SaveRam:
        pageSize = this._internalGetSaveRamPageSize();
        pageCount = pageSize > 0 ? ((this._saveRamSize / pageSize) | 0) : 0;
        defaultAccess = ACCESS_READWRITE;
        break;
      case PrgMemoryType.WorkRam:
        pageSize = this._internalGetWorkRamPageSize();
        pageCount = pageSize > 0 ? ((this._workRamSize / pageSize) | 0) : 0;
        defaultAccess = ACCESS_READWRITE;
        break;
      case PrgMemoryType.MapperRam: {
        pageSize = SLOT_SIZE;
        pageCount = this._mapperRamSize > 0 ? ((this._mapperRamSize / pageSize) | 0) : 0;
        defaultAccess = ACCESS_READWRITE;
        break;
      }
      default:
        return;
    }

    if (pageSize <= 0 || pageCount <= 0) {
      return;
    }

    let mappedAccess = accessType === -1 ? defaultAccess : (accessType & ACCESS_READWRITE);
    if (mappedAccess === ACCESS_NONE) {
      this.removeCpuMemoryMapping(start, end);
      return;
    }

    let page = wrapPage(pageNumber | 0, pageCount);
    const rangeSize = (end - start + 1) >>> 0;
    if (rangeSize > pageSize) {
      let addr = start;
      while (addr <= end - pageSize + 1) {
        this._setCpuMemoryMappingByOffset(addr, addr + pageSize - 1, type, page * pageSize, mappedAccess);
        addr += pageSize;
        page = wrapPage(page + 1, pageCount);
      }
    } else {
      this._setCpuMemoryMappingByOffset(start, end, type, page * pageSize, mappedAccess);
    }
  }

  _setCpuMemoryMappingByOffset(startAddr, endAddr, type, sourceOffset, accessType) {
    const start = startAddr & 0xFFFF;
    const end = endAddr & 0xFFFF;
    if (!this._validateAddressRange(start, end)) {
      return;
    }

    const { source, size } = this._resolvePrgSource(type);
    const firstSlot = start >> 8;
    const slotCount = ((end - start + 1) >> 8) | 0;
    let offset = sourceOffset | 0;

    for (let i = 0; i < slotCount; i++) {
      const slot = firstSlot + i;
      if (!source || size <= 0 || accessType === ACCESS_NONE) {
        this._prgPageSource[slot] = null;
        this._prgMemoryOffset[slot] = -1;
        this._prgMemoryType[slot] = PrgMemoryType.PrgRom;
        this._prgMemoryAccess[slot] = ACCESS_NONE;
        continue;
      }

      offset = normalizeOffset(offset, size);
      this._prgPageSource[slot] = source;
      this._prgMemoryOffset[slot] = offset;
      this._prgMemoryType[slot] = type;
      this._prgMemoryAccess[slot] = accessType & ACCESS_READWRITE;
      offset += SLOT_SIZE;
    }
  }

  removeCpuMemoryMapping(startAddr, endAddr) {
    const start = startAddr & 0xFFFF;
    const end = endAddr & 0xFFFF;
    if (!this._validateAddressRange(start, end)) {
      return;
    }
    const firstSlot = start >> 8;
    const slotCount = ((end - start + 1) >> 8) | 0;
    for (let i = 0; i < slotCount; i++) {
      const slot = firstSlot + i;
      this._prgPageSource[slot] = null;
      this._prgMemoryOffset[slot] = -1;
      this._prgMemoryType[slot] = PrgMemoryType.PrgRom;
      this._prgMemoryAccess[slot] = ACCESS_NONE;
    }
  }

  selectPrgPage4x(slot, page, memoryType = PrgMemoryType.PrgRom) {
    this.selectPrgPage2x(slot * 2, page, memoryType);
    this.selectPrgPage2x(slot * 2 + 1, page + 2, memoryType);
  }

  selectPrgPage2x(slot, page, memoryType = PrgMemoryType.PrgRom) {
    this.selectPrgPage(slot * 2, page, memoryType);
    this.selectPrgPage(slot * 2 + 1, page + 1, memoryType);
  }

  selectPrgPage(slot, page, memoryType = PrgMemoryType.PrgRom) {
    if (this._prgSize <= 0) {
      return;
    }

    const pageSize = this._internalGetPrgPageSize();
    if (pageSize <= 0) {
      return;
    }

    if (this._prgSize < 0x8000 && (this.getPrgPageSize() | 0) > this._prgSize) {
      const repeatCount = Math.max(1, (0x8000 / this._prgSize) | 0);
      for (let i = 0; i < repeatCount; i++) {
        const start = 0x8000 + i * this._prgSize;
        const end = start + this._prgSize - 1;
        this.setCpuMemoryMapping(start, end, 0, memoryType);
      }
      return;
    }

    const startAddr = 0x8000 + (slot | 0) * pageSize;
    const endAddr = startAddr + pageSize - 1;
    this.setCpuMemoryMapping(startAddr, endAddr, page, memoryType);
  }

  // ===========================================================================
  // PPU memory mapping
  // ===========================================================================

  setPpuMemoryMapping(startAddr, endAddr, pageNumber, type = ChrMemoryType.Default, accessType = -1) {
    const start = startAddr & 0x3FFF;
    const end = endAddr & 0x3FFF;
    if (!this._validateAddressRange(start, end) || start > 0x3F00 || end > 0x3FFF) {
      return;
    }

    let pageSize = 0;
    let pageCount = 0;
    let defaultAccess = ACCESS_READ;
    let resolvedType = type;

    if (resolvedType === ChrMemoryType.Default) {
      resolvedType = this._chrRomSize > 0 ? ChrMemoryType.ChrRom : ChrMemoryType.ChrRam;
    }

    switch (resolvedType) {
      case ChrMemoryType.ChrRom:
        pageSize = this._internalGetChrRomPageSize();
        pageCount = pageSize > 0 ? ((this._chrRomSize / pageSize) | 0) : 0;
        defaultAccess = ACCESS_READ;
        break;
      case ChrMemoryType.ChrRam:
        pageSize = this._internalGetChrRamPageSize();
        pageCount = pageSize > 0 ? ((this._chrRamSize / pageSize) | 0) : 0;
        defaultAccess = ACCESS_READWRITE;
        break;
      case ChrMemoryType.NametableRam:
        pageSize = BaseMapper.NametableSize;
        pageCount = this._nametableCount;
        defaultAccess = ACCESS_READWRITE;
        break;
      case ChrMemoryType.MapperRam:
        pageSize = SLOT_SIZE;
        pageCount = this._mapperRamSize > 0 ? ((this._mapperRamSize / pageSize) | 0) : 0;
        defaultAccess = ACCESS_READWRITE;
        break;
      default:
        return;
    }

    if (pageSize <= 0 || pageCount <= 0) {
      return;
    }

    const mappedAccess = accessType === -1 ? defaultAccess : (accessType & ACCESS_READWRITE);
    if (mappedAccess === ACCESS_NONE) {
      this.removePpuMemoryMapping(start, end);
      return;
    }

    let page = wrapPage(pageNumber | 0, pageCount);
    const rangeSize = (end - start + 1) >>> 0;
    if (rangeSize > pageSize) {
      let addr = start;
      while (addr <= end - pageSize + 1) {
        this._setPpuMemoryMappingByOffset(addr, addr + pageSize - 1, resolvedType, page * pageSize, mappedAccess);
        addr += pageSize;
        page = wrapPage(page + 1, pageCount);
      }
    } else {
      this._setPpuMemoryMappingByOffset(start, end, resolvedType, page * pageSize, mappedAccess);
    }
  }

  _setPpuMemoryMappingByOffset(startAddr, endAddr, type, sourceOffset, accessType) {
    const start = startAddr & 0x3FFF;
    const end = endAddr & 0x3FFF;
    if (!this._validateAddressRange(start, end)) {
      return;
    }

    const { type: resolvedType, source, size } = this._resolveChrSource(type);
    const firstSlot = start >> 8;
    const slotCount = ((end - start + 1) >> 8) | 0;
    let offset = sourceOffset | 0;

    for (let i = 0; i < slotCount; i++) {
      const slot = firstSlot + i;
      if (!source || size <= 0 || accessType === ACCESS_NONE || slot < 0 || slot >= PPU_SLOT_COUNT) {
        if (slot >= 0 && slot < PPU_SLOT_COUNT) {
          this._chrPageSource[slot] = null;
          this._chrMemoryOffset[slot] = -1;
          this._chrMemoryType[slot] = ChrMemoryType.Default;
          this._chrMemoryAccess[slot] = ACCESS_NONE;
        }
        continue;
      }

      offset = normalizeOffset(offset, size);
      this._chrPageSource[slot] = source;
      this._chrMemoryOffset[slot] = offset;
      this._chrMemoryType[slot] = resolvedType;
      this._chrMemoryAccess[slot] = accessType & ACCESS_READWRITE;
      offset += SLOT_SIZE;
    }
  }

  removePpuMemoryMapping(startAddr, endAddr) {
    const start = startAddr & 0x3FFF;
    const end = endAddr & 0x3FFF;
    if (!this._validateAddressRange(start, end)) {
      return;
    }

    const firstSlot = start >> 8;
    const slotCount = ((end - start + 1) >> 8) | 0;
    for (let i = 0; i < slotCount; i++) {
      const slot = firstSlot + i;
      if (slot < 0 || slot >= PPU_SLOT_COUNT) {
        continue;
      }
      this._chrPageSource[slot] = null;
      this._chrMemoryOffset[slot] = -1;
      this._chrMemoryType[slot] = ChrMemoryType.Default;
      this._chrMemoryAccess[slot] = ACCESS_NONE;
    }
  }

  selectChrPage8x(slot, page, memoryType = ChrMemoryType.Default) {
    this.selectChrPage4x(slot, page, memoryType);
    this.selectChrPage4x(slot * 2 + 1, page + 4, memoryType);
  }

  selectChrPage4x(slot, page, memoryType = ChrMemoryType.Default) {
    this.selectChrPage2x(slot * 2, page, memoryType);
    this.selectChrPage2x(slot * 2 + 1, page + 2, memoryType);
  }

  selectChrPage2x(slot, page, memoryType = ChrMemoryType.Default) {
    this.selectChrPage(slot * 2, page, memoryType);
    this.selectChrPage(slot * 2 + 1, page + 1, memoryType);
  }

  selectChrPage(slot, page, memoryType = ChrMemoryType.Default) {
    let pageSize;
    if (memoryType === ChrMemoryType.NametableRam) {
      pageSize = BaseMapper.NametableSize;
    } else {
      let resolved = memoryType;
      if (resolved === ChrMemoryType.Default) {
        resolved = this._chrRomSize > 0 ? ChrMemoryType.ChrRom : ChrMemoryType.ChrRam;
      }
      pageSize = resolved === ChrMemoryType.ChrRam ? this._internalGetChrRamPageSize() : this._internalGetChrRomPageSize();
    }

    if (pageSize <= 0) {
      return;
    }

    const startAddr = (slot | 0) * pageSize;
    const endAddr = startAddr + pageSize - 1;
    this.setPpuMemoryMapping(startAddr, endAddr, page, memoryType);
  }

  // ===========================================================================
  // Nametable / mirroring
  // ===========================================================================

  getNametable(nametableIndex) {
    const index = nametableIndex | 0;
    if (index < 0 || index >= this._nametableCount) {
      return this._nametableRam.subarray(0, BaseMapper.NametableSize);
    }
    const start = index * BaseMapper.NametableSize;
    return this._nametableRam.subarray(start, start + BaseMapper.NametableSize);
  }

  setNametable(index, nametableIndex) {
    const ntIndex = nametableIndex | 0;
    if (ntIndex < 0 || ntIndex >= this._nametableCount) {
      return;
    }

    const table = index | 0;
    if (table < 0 || table > 3) {
      return;
    }

    const base2000 = 0x2000 + table * 0x400;
    const base3000 = 0x3000 + table * 0x400;
    this.setPpuMemoryMapping(base2000, base2000 + 0x3FF, ntIndex, ChrMemoryType.NametableRam);
    this.setPpuMemoryMapping(base3000, base3000 + 0x3FF, ntIndex, ChrMemoryType.NametableRam);
  }

  setNametables(nt0, nt1, nt2, nt3) {
    this.setNametable(0, nt0);
    this.setNametable(1, nt1);
    this.setNametable(2, nt2);
    this.setNametable(3, nt3);
  }

  setMirroringType(type) {
    this._mirroringType = type & 0xFF;
    switch (this._mirroringType) {
      case this.MIRROR_VERTICAL:
        this.setNametables(0, 1, 0, 1);
        break;
      case this.MIRROR_HORIZONTAL:
        this.setNametables(0, 0, 1, 1);
        break;
      case this.MIRROR_FOUR_SCREEN:
        this.setNametables(0, 1, 2, 3);
        break;
      case this.MIRROR_SINGLE_A:
        this.setNametables(0, 0, 0, 0);
        break;
      case this.MIRROR_SINGLE_B:
        this.setNametables(1, 1, 1, 1);
        break;
      default:
        this.setNametables(0, 1, 0, 1);
        break;
    }

    if (this.nes && this.nes.ppu && typeof this.nes.ppu.setMirroring === "function") {
      this.nes.ppu.setMirroring(this._mirroringType);
    }
  }

  getMirroringType() {
    return this._mirroringType;
  }

  // ===========================================================================
  // Register map control
  // ===========================================================================

  addRegisterRange(startAddr, endAddr, operation = MemoryOperation.Any) {
    const start = startAddr & 0xFFFF;
    const end = endAddr & 0xFFFF;
    const op = operation | 0;

    for (let i = start; i <= end; i++) {
      if (op & MemoryOperation.Read) {
        this._isReadRegisterAddr[i] = 1;
      }
      if (op & MemoryOperation.Write) {
        this._isWriteRegisterAddr[i] = 1;
      }
    }
  }

  removeRegisterRange(startAddr, endAddr, operation = MemoryOperation.Any) {
    const start = startAddr & 0xFFFF;
    const end = endAddr & 0xFFFF;
    const op = operation | 0;

    for (let i = start; i <= end; i++) {
      if (op & MemoryOperation.Read) {
        this._isReadRegisterAddr[i] = 0;
      }
      if (op & MemoryOperation.Write) {
        this._isWriteRegisterAddr[i] = 0;
      }
    }
  }

  isWriteRegister(addr) {
    return this._isWriteRegisterAddr[addr & 0xFFFF] !== 0;
  }

  isReadRegister(addr) {
    return this._allowRegisterRead && this._isReadRegisterAddr[addr & 0xFFFF] !== 0;
  }

  // ===========================================================================
  // CPU bus interface
  // ===========================================================================

  _openBus(addr) {
    if (this.nes && this.nes.cpu && typeof this.nes.cpu.dataBus === "number") {
      return this.nes.cpu.dataBus & 0xFF;
    }
    return (addr >> 8) & 0xFF;
  }

  _readMappedPrg(addr) {
    const address = addr & 0xFFFF;
    const slot = address >> 8;
    if ((this._prgMemoryAccess[slot] & ACCESS_READ) === 0) {
      return null;
    }
    const source = this._prgPageSource[slot];
    if (!source || source.length === 0) {
      return null;
    }

    let offset = this._prgMemoryOffset[slot];
    if (offset < 0) {
      return null;
    }
    offset += address & 0xFF;
    if (offset >= source.length || offset < 0) {
      offset = normalizeOffset(offset, source.length);
    }
    return source[offset] & 0xFF;
  }

  _writeMappedPrg(addr, value) {
    const address = addr & 0xFFFF;
    const slot = address >> 8;
    if ((this._prgMemoryAccess[slot] & ACCESS_WRITE) === 0) {
      return;
    }
    const source = this._prgPageSource[slot];
    if (!source || source.length === 0) {
      return;
    }

    let offset = this._prgMemoryOffset[slot];
    if (offset < 0) {
      return;
    }
    offset += address & 0xFF;
    if (offset >= source.length || offset < 0) {
      offset = normalizeOffset(offset, source.length);
    }
    source[offset] = value & 0xFF;
  }

  cpuRead(addr) {
    return this.readRam(addr & 0xFFFF);
  }

  peekRam(addr) {
    return this.debugReadRam(addr & 0xFFFF);
  }

  readRam(addr) {
    const address = addr & 0xFFFF;

    if (this._allowRegisterRead && this._isReadRegisterAddr[address]) {
      return this.readRegister(address) & 0xFF;
    }

    const value = this._readMappedPrg(address);
    return value === null ? this._openBus(address) : value;
  }

  debugReadRam(addr) {
    const address = addr & 0xFFFF;
    const value = this._readMappedPrg(address);
    return value === null ? ((address >> 8) & 0xFF) : value;
  }

  cpuWrite(addr, value) {
    this.writeRam(addr & 0xFFFF, value & 0xFF);
  }

  writeRam(addr, value) {
    const address = addr & 0xFFFF;
    let writeValue = value & 0xFF;

    if (this._isWriteRegisterAddr[address]) {
      if (this._hasBusConflicts) {
        const prgValue = this._readMappedPrg(address);
        if (prgValue !== null) {
          writeValue &= prgValue;
        }
      }
      this.writeRegister(address, writeValue);
      return;
    }

    this.writePrgRam(address, writeValue);
  }

  debugWriteRam(addr, value) {
    const address = addr & 0xFFFF;
    if (this._isWriteRegisterAddr[address]) {
      return;
    }
    this._writeMappedPrg(address, value & 0xFF);
  }

  writePrgRam(addr, value) {
    this._writeMappedPrg(addr & 0xFFFF, value & 0xFF);
  }

  // ===========================================================================
  // PPU bus interface
  // ===========================================================================

  internalReadVram(addr) {
    const address = addr & 0x3FFF;
    const slot = address >> 8;
    if (slot < 0 || slot >= PPU_SLOT_COUNT || (this._chrMemoryAccess[slot] & ACCESS_READ) === 0) {
      return address & 0xFF;
    }

    const source = this._chrPageSource[slot];
    if (!source || source.length === 0) {
      return address & 0xFF;
    }

    let offset = this._chrMemoryOffset[slot];
    if (offset < 0) {
      return address & 0xFF;
    }
    offset += address & 0xFF;
    if (offset >= source.length || offset < 0) {
      offset = normalizeOffset(offset, source.length);
    }
    return source[offset] & 0xFF;
  }

  internalWriteVram(addr, value) {
    const address = addr & 0x3FFF;
    const slot = address >> 8;
    if (slot < 0 || slot >= PPU_SLOT_COUNT || (this._chrMemoryAccess[slot] & ACCESS_WRITE) === 0) {
      return;
    }

    const source = this._chrPageSource[slot];
    if (!source || source.length === 0) {
      return;
    }

    let offset = this._chrMemoryOffset[slot];
    if (offset < 0) {
      return;
    }
    offset += address & 0xFF;
    if (offset >= source.length || offset < 0) {
      offset = normalizeOffset(offset, source.length);
    }
    source[offset] = value & 0xFF;
  }

  mapperReadVram(addr, _operationType = "ppu") {
    return this.internalReadVram(addr);
  }

  mapperWriteVram(addr, value) {
    this.internalWriteVram(addr, value);
  }

  ppuRead(addr, context = "ppu", _mapperContext = null) {
    const address = addr & 0x3FFF;
    if (this._hasCustomReadVram) {
      return this.mapperReadVram(address, context) & 0xFF;
    }
    return this.internalReadVram(address) & 0xFF;
  }

  ppuWrite(addr, value, _context = "ppu", _mapperContext = null) {
    this.mapperWriteVram(addr & 0x3FFF, value & 0xFF);
  }

  readNametable(addr, _context = "ppu", _mapperContext = null) {
    return this.internalReadVram(addr & 0x3FFF) & 0xFF;
  }

  setNametableByte(addr, value, _mapperContext = null) {
    this.internalWriteVram(addr & 0x3FFF, value & 0xFF);
    return true;
  }

  // ===========================================================================
  // RAM and battery helpers
  // ===========================================================================

  initializeChrRam(chrRamSize = -1) {
    const defaultSize = (this.getChrRamSize() | 0) > 0 ? (this.getChrRamSize() | 0) : 0x2000;
    const size = chrRamSize >= 0 ? (chrRamSize | 0) : defaultSize;
    if (size <= 0) {
      this._chrRam = new Uint8Array(0);
      this._chrRamSize = 0;
      return;
    }

    this._chrRamSize = size;
    this._chrRam = new Uint8Array(size);
    this._fillRam(this._chrRam);
  }

  hasBattery() {
    return this._hasBattery();
  }

  hasDefaultWorkRam() {
    return !!this._hasDefaultWorkRam;
  }

  setupDefaultWorkRam() {
    if (this.hasBattery() && this._saveRamSize > 0) {
      this._hasDefaultWorkRam = true;
      this.setCpuMemoryMapping(0x6000, 0x7FFF, 0, PrgMemoryType.SaveRam);
    } else if (this._workRamSize > 0) {
      this._hasDefaultWorkRam = true;
      this.setCpuMemoryMapping(0x6000, 0x7FFF, 0, PrgMemoryType.WorkRam);
    } else {
      this._hasDefaultWorkRam = false;
      this.removeCpuMemoryMapping(0x6000, 0x7FFF);
    }
  }

  loadBattery() {
    // Battery persistence is emulator-environment specific.
  }

  saveBattery() {
    if (this.nes && this.nes.opts && typeof this.nes.opts.onBatteryRamWrite === "function" && this._saveRamSize > 0) {
      this.nes.opts.onBatteryRamWrite(this._saveRam);
    }
  }

  getPrgPageCount() {
    const pageSize = this._internalGetPrgPageSize();
    return pageSize > 0 ? ((this._prgSize / pageSize) | 0) : 0;
  }

  getChrRomPageCount() {
    const pageSize = this._internalGetChrRomPageSize();
    return pageSize > 0 ? ((this._chrRomSize / pageSize) | 0) : 0;
  }

  // ===========================================================================
  // Save state
  // ===========================================================================

  restorePrgChrState() {
    for (let i = 0; i < CPU_SLOT_COUNT; i++) {
      const start = i << 8;
      const end = start + 0xFF;
      if (this._prgMemoryAccess[i] !== ACCESS_NONE) {
        this._setCpuMemoryMappingByOffset(start, end, this._prgMemoryType[i], this._prgMemoryOffset[i], this._prgMemoryAccess[i]);
      } else {
        this.removeCpuMemoryMapping(start, end);
      }
    }

    for (let i = 0; i < PPU_SLOT_COUNT; i++) {
      const start = i << 8;
      const end = start + 0xFF;
      if (this._chrMemoryAccess[i] !== ACCESS_NONE) {
        this._setPpuMemoryMappingByOffset(start, end, this._chrMemoryType[i], this._chrMemoryOffset[i], this._chrMemoryAccess[i]);
      } else {
        this.removePpuMemoryMapping(start, end);
      }
    }
  }

  toJSON() {
    return {
      stateVersion: 3,

      prgRom: Array.from(this._prgRom),
      chrRom: Array.from(this._chrRom),

      saveRam: Array.from(this._saveRam),
      workRam: Array.from(this._workRam),
      mapperRam: Array.from(this._mapperRam),
      chrRam: Array.from(this._chrRam),
      nametableRam: Array.from(this._nametableRam),

      prgMemoryOffset: Array.from(this._prgMemoryOffset),
      prgMemoryType: Array.from(this._prgMemoryType),
      prgMemoryAccess: Array.from(this._prgMemoryAccess),

      chrMemoryOffset: Array.from(this._chrMemoryOffset),
      chrMemoryType: Array.from(this._chrMemoryType),
      chrMemoryAccess: Array.from(this._chrMemoryAccess),

      mirroringType: this._mirroringType,

      hasBusConflicts: this._hasBusConflicts,
      hasCpuClockHook: this._hasCpuClockHook,
      hasCustomReadVram: this._hasCustomReadVram,
      hasVramAddressHook: this.hasVramAddressHook,
      allowRegisterRead: this._allowRegisterRead,
      hasDefaultWorkRam: this._hasDefaultWorkRam,
      hasScanlineIrq: this.hasScanlineIrq,
      usingChrRam: this.usingChrRam,
    };
  }

  fromJSON(state) {
    if (!state || state.stateVersion !== 3) {
      throw new Error(`Mapper save state version not supported (got v${state?.stateVersion}, expected v3)`);
    }

    if (state.prgRom) {
      this._prgRom = new Uint8Array(state.prgRom);
      this.prgData = this._prgRom;
      this._prgSize = this._prgRom.length;
    }
    if (state.chrRom) {
      this._chrRom = new Uint8Array(state.chrRom);
      this.chrData = this._chrRom;
      this._chrRomSize = this._chrRom.length;
    }

    if (state.saveRam) this._saveRam = new Uint8Array(state.saveRam);
    if (state.workRam) this._workRam = new Uint8Array(state.workRam);
    if (state.mapperRam) this._mapperRam = new Uint8Array(state.mapperRam);
    if (state.chrRam) this._chrRam = new Uint8Array(state.chrRam);
    if (state.nametableRam) this._nametableRam = new Uint8Array(state.nametableRam);

    this._saveRamSize = this._saveRam.length;
    this._workRamSize = this._workRam.length;
    this._mapperRamSize = this._mapperRam.length;
    this._chrRamSize = this._chrRam.length;
    this._ntRamSize = this._nametableRam.length;
    this._nametableCount = Math.max(1, (this._ntRamSize / BaseMapper.NametableSize) | 0);

    if (state.prgMemoryOffset) this._prgMemoryOffset = new Int32Array(state.prgMemoryOffset);
    if (state.prgMemoryType) this._prgMemoryType = new Uint8Array(state.prgMemoryType);
    if (state.prgMemoryAccess) this._prgMemoryAccess = new Uint8Array(state.prgMemoryAccess);

    if (state.chrMemoryOffset) this._chrMemoryOffset = new Int32Array(state.chrMemoryOffset);
    if (state.chrMemoryType) this._chrMemoryType = new Uint8Array(state.chrMemoryType);
    if (state.chrMemoryAccess) this._chrMemoryAccess = new Uint8Array(state.chrMemoryAccess);

    this._hasBusConflicts = !!(state.hasBusConflicts ?? this._hasBusConflicts);
    this._hasCpuClockHook = !!(state.hasCpuClockHook ?? this._hasCpuClockHook);
    this._hasCustomReadVram = !!(state.hasCustomReadVram ?? this._hasCustomReadVram);
    this.hasVramAddressHook = !!(state.hasVramAddressHook ?? this.hasVramAddressHook);
    this._allowRegisterRead = !!(state.allowRegisterRead ?? this._allowRegisterRead);
    this._hasDefaultWorkRam = !!(state.hasDefaultWorkRam ?? this._hasDefaultWorkRam);
    this.hasScanlineIrq = !!(state.hasScanlineIrq ?? this.hasScanlineIrq);
    this.usingChrRam = !!(state.usingChrRam ?? this.usingChrRam);

    this._prgPageSource = new Array(CPU_SLOT_COUNT).fill(null);
    this._chrPageSource = new Array(PPU_SLOT_COUNT).fill(null);
    this.restorePrgChrState();

    this.setMirroringType((state.mirroringType ?? this._mirroringType) & 0xFF);
  }

  // ===========================================================================
  // Mesen-style method aliases (PascalCase)
  // ===========================================================================

  SetCpuMemoryMapping(startAddr, endAddr, pageNumber, type = PrgMemoryType.PrgRom, accessType = -1) {
    this.setCpuMemoryMapping(startAddr, endAddr, pageNumber, type, accessType);
  }

  RemoveCpuMemoryMapping(startAddr, endAddr) {
    this.removeCpuMemoryMapping(startAddr, endAddr);
  }

  SetPpuMemoryMapping(startAddr, endAddr, pageNumber, type = ChrMemoryType.Default, accessType = -1) {
    this.setPpuMemoryMapping(startAddr, endAddr, pageNumber, type, accessType);
  }

  RemovePpuMemoryMapping(startAddr, endAddr) {
    this.removePpuMemoryMapping(startAddr, endAddr);
  }

  SelectPrgPage4x(slot, page, type = PrgMemoryType.PrgRom) { this.selectPrgPage4x(slot, page, type); }
  SelectPrgPage2x(slot, page, type = PrgMemoryType.PrgRom) { this.selectPrgPage2x(slot, page, type); }
  SelectPrgPage(slot, page, type = PrgMemoryType.PrgRom) { this.selectPrgPage(slot, page, type); }

  SelectChrPage8x(slot, page, type = ChrMemoryType.Default) { this.selectChrPage8x(slot, page, type); }
  SelectChrPage4x(slot, page, type = ChrMemoryType.Default) { this.selectChrPage4x(slot, page, type); }
  SelectChrPage2x(slot, page, type = ChrMemoryType.Default) { this.selectChrPage2x(slot, page, type); }
  SelectChrPage(slot, page, type = ChrMemoryType.Default) { this.selectChrPage(slot, page, type); }

  AddRegisterRange(startAddr, endAddr, operation = MemoryOperation.Any) { this.addRegisterRange(startAddr, endAddr, operation); }
  RemoveRegisterRange(startAddr, endAddr, operation = MemoryOperation.Any) { this.removeRegisterRange(startAddr, endAddr, operation); }

  SetNametable(index, nametableIndex) { this.setNametable(index, nametableIndex); }
  SetNametables(nt0, nt1, nt2, nt3) { this.setNametables(nt0, nt1, nt2, nt3); }
  SetMirroringType(type) { this.setMirroringType(type); }
  GetMirroringType() { return this.getMirroringType(); }
}

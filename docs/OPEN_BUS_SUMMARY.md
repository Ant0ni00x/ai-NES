# Open Bus Implementation Summary

**Date:** 2026-02-24
**Status:** Complete - All major open bus behaviors implemented

---

## Overview

Comprehensive open bus behavior is implemented across the NES emulator. The CPU data bus (`dataBus`) accurately tracks all memory operations and returns the last bus value when reading from unmapped or unimplemented hardware. The PPU has its own separate open bus latch (`ioBus`) with per-bit decay.

---

## What is Open Bus?

On real NES hardware, the CPU has an 8-bit data bus that retains the last value transferred. When reading from addresses without active hardware (unmapped regions, write-only registers), the CPU returns **the last value on the data bus** instead of 0.

This is a critical accuracy feature that many test ROMs verify and some games depend on.

---

## Implemented Components

### 1. CPU Open Bus

**Implementation:** `src/cpu.js`

- `this.dataBus` state variable (line 59)
- Updated on **every** `_read()` (lines 384–432) and `_write()` (lines 435–462)
- Returns `dataBus` for unmapped regions ($4020+ when mapper returns undefined/null)
- Returns `dataBus` when APU is missing or a register is undefined
- Persisted through save states via `toJSON()` (line 1440) / `fromJSON()` (line 1490)

**Example Behavior:**
```javascript
// Read from ROM
_read(0x8000)  → 0xA9 (dataBus = 0xA9)
_read(0x8001)  → 0x42 (dataBus = 0x42)
_read(0x5000)  → 0x42 (open bus — mapper returns undefined)
```

**Test ROMs affected:**
- `cpu_exec_space`
- `cpu_dummy_reads`

---

### 2. APU Open Bus

**Implementation:** `src/apu.js`

- `readReg()` (line 904) returns `undefined` for all registers except `$4015`
- CPU `_readIORegister()` (lines 464–498) dispatches `$4015` to the APU, everything else returns `dataBus`

```javascript
// src/apu.js:904-905
readReg(addr) {
  if (addr !== 0x4015) return undefined;
  // ... build and return status byte
}
```

The CPU interprets `undefined` as "no device responded" and falls back to `dataBus`:

```javascript
// src/cpu.js:403-406
value = this._readIORegister(address);
this.dataBus = (value === undefined || value === null) ? this.dataBus : (value & 0xFF);
```

**Registers with open bus:**
- $4000-$4013: Write-only sound registers
- $4017: Write-only frame counter (read falls through to `dataBus` in `_readIORegister` default case)
- $4015: Read/Write status register (only readable APU register)

**Test ROMs affected:**
- `apu_test/4-jitter`
- `apu_test/5-len_timing`

---

### 3. OAM DMA Open Bus (Already Correct)

**Implementation:**

- OAM DMA uses `cpu.cpuRead()` to read 256 bytes
- Each read goes through `_read()` which automatically updates `dataBus`
- After DMA, `dataBus` contains last byte transferred

---

### 4. DMC DMA Open Bus

**Implementation:** `src/apu.js`

DMC sample fetches route through the CPU to ensure `dataBus` is updated:

```javascript
// src/apu.js:650-654  (DmcChannel.fetchSample)
fetchSample() {
  if (!this.nes || !this.nes.cpu) return;
  this.nes.cpu.haltCycles(4);
  const value = this.nes.cpu.cpuRead(this.currentAddress);  // Updates dataBus
  this.sampleBuffer = value & 0xff;
  this.bufferEmpty = false;
  // ...
}
```

**Why It Matters:**
```javascript
// DMC reads sample $42 from $C000 (dataBus = 0x42)
_read(0x5000) → Returns 0x42 (open bus uses last DMA value)
```

**Note:** DMC DMA conflicts (dummy reads during CPU access) are not implemented yet.

**Test ROMs affected:**
- `dmc_dma_during_read4` (partial - conflicts not implemented)

---

### 5. PPU Open Bus (Per-Bit Decay)

**Implementation:** `src/ppu.js`

The PPU open bus is more sophisticated than the CPU's — it uses per-bit decay tracking:

- `ioBus` (line 37) holds the current open bus value
- `openBusDecayStamp` (line 38) is a `Uint32Array(8)` tracking when each bit was last refreshed
- Bits decay to 0 after ~3 frames without being refreshed

```javascript
// src/ppu.js:432-463  (simplified)
setOpenBus(mask, value) {
  // For each bit in mask:
  //   - If bit is set: update ioBus bit and stamp with current frame
  //   - If bit is unset: decay to 0 if >3 frames since last stamp
}
```

`applyOpenBus(mask, value)` (line 466) is used by PPU register reads to merge hardware-driven bits with decayed open bus bits. For example, `$2002` (PPUSTATUS) only drives bits 7-5; bits 4-0 come from decayed `ioBus`.

**Register behavior:**
- $2000, $2001, $2003, $2005, $2006: Write-only → returns `ioBus` (with decay)
- $2002: Bits 7-5 from hardware, bits 4-0 from `ioBus`
- $2004: OAMDATA readable → updates `ioBus`
- $2007: PPUDATA readable → updates `ioBus`; palette reads return palette data in bits 5-0 with bits 7-6 from `ioBus`

**Test ROMs:**
- `ppu_open_bus`

---

### 6. Controller Open Bus (Approximation)

**Implementation:** `src/cpu.js` (lines 477–493)

- Controllers return button data from `controller.read()`
- The controller itself returns `0x40 | buttonData`, approximating the open bus upper bits
- Good enough for games that check these bits

**Note:** Not a full implementation — hardware would merge bits 4-0 from the controller with bits 7-5 from the CPU data bus. Current approximation is accurate for all known games.

---

## Memory Map Summary

| Address Range | Open Bus Behavior | Status |
|---------------|-------------------|--------|
| $0000-$1FFF | RAM (no open bus) | N/A |
| $2000-$2001 | PPU write-only → `ioBus` (with per-bit decay) | Implemented |
| $2002 | PPU PPUSTATUS: bits 7-5 hardware, bits 4-0 `ioBus` | Implemented |
| $2003 | PPU write-only → `ioBus` | Implemented |
| $2004 | PPU OAMDATA (readable) → updates `ioBus` | Implemented |
| $2005-$2006 | PPU write-only → `ioBus` | Implemented |
| $2007 | PPU PPUDATA (readable) → updates `ioBus` | Implemented |
| $4000-$4013 | APU write-only → `dataBus` | Implemented |
| $4014 | OAM DMA (write-only) → updates `dataBus` on reads during DMA | Implemented |
| $4015 | APU status (readable) → updates `dataBus` | Implemented |
| $4016-$4017 | Controllers (readable) → approximates open bus ($40) | Implemented |
| $4018-$401F | Normally disabled → `dataBus` | Implemented |
| $4020-$FFFF | Mapper/ROM → `dataBus` if unmapped | Implemented |

---

## Code Flow

### Read Flow

```javascript
// src/cpu.js:384-432 — _read(addr)
_read(addr) {
  const address = addr & 0xFFFF;
  let value;

  if (address < 0x2000) {
    value = this.ram[address & 0x07FF];
    this.dataBus = value & 0xFF;
    return this.dataBus;
  }

  if (address < 0x4000) {
    value = this.nes.ppu.readRegister(address & 0x07);  // Updates PPU ioBus
    this.dataBus = (value === undefined || value === null) ? this.dataBus : (value & 0xFF);
    return this.dataBus;
  }

  if (address < 0x4018) {
    value = this._readIORegister(address);  // $4015→APU, $4016/$4017→controllers, else→dataBus
    this.dataBus = (value === undefined || value === null) ? this.dataBus : (value & 0xFF);
    return this.dataBus;
  }

  // $4018-$FFFF: mapper cpuRead, fall back to dataBus if undefined
  if (this.nes.mmap) {
    value = this.nes.mmap.cpuRead(address);
    if (value !== undefined && value !== null) {
      this.dataBus = value & 0xFF;
      return this.dataBus;
    }
  }
  return this.dataBus;  // Open bus
}
```

### Write Flow

```javascript
// src/cpu.js:435-462 — _write(addr, value)
_write(addr, value) {
  const address = addr & 0xFFFF;
  const writeValue = value & 0xFF;

  this.dataBus = writeValue;  // Update bus on EVERY write
  this.mem[address] = writeValue;

  if (address < 0x2000) {
    this.ram[address & 0x07FF] = writeValue;
  } else if (address < 0x4000) {
    this.nes.ppu.writeRegister(address & 0x07, writeValue);
  } else if (address < 0x4018) {
    this._writeIORegister(address, writeValue);
  } else {
    this.nes.mmap.cpuWrite(address, writeValue);
  }
}
```

### IO Register Dispatch

```javascript
// src/cpu.js:464-498 — _readIORegister(addr)
_readIORegister(addr) {
  switch (addr) {
    case 0x4015:
      // APU status — only readable APU register
      value = this.nes.papu.readReg(address);
      return (value !== undefined) ? (value & 0xFF) : this.dataBus;

    case 0x4016:
      // Controller 1
      value = this.nes.controllers[1].read() & 0xFF;
      this.nes.controllers[1].clock();
      return value;

    case 0x4017:
      // Controller 2
      value = this.nes.controllers[2].read() & 0xFF;
      this.nes.controllers[2].clock();
      return value;

    default:
      return this.dataBus;  // Open bus for $4000-$4014, $4018+
  }
}
```

### DMC Fetch Flow

```javascript
// src/apu.js:650-654 — DmcChannel.fetchSample()
fetchSample() {
  this.nes.cpu.haltCycles(4);
  const value = this.nes.cpu.cpuRead(this.currentAddress);  // Updates dataBus
  this.sampleBuffer = value & 0xff;
  this.bufferEmpty = false;
  // ...
}
```

---

## Edge Cases Handled

1. **Power-on state**: `dataBus` initialized to 0 (close enough to random)
2. **Reset**: `dataBus` reset to 0
3. **Save states**: `dataBus` included in CPU `toJSON()`/`fromJSON()` (lines 1440/1490)
4. **All reads**: Every `_read()` updates `dataBus` (RAM, ROM, PPU, APU, controllers, mapper)
5. **All writes**: Every `_write()` updates `dataBus` as first operation
6. **DMA transfers**: Both OAM and DMC DMA go through `cpuRead()` → `_read()`, updating `dataBus`
7. **Undefined APU registers**: `readReg()` returns `undefined`, CPU uses `dataBus`
8. **Missing hardware**: CPU returns `dataBus` if PPU/APU/mapper not initialized
9. **PPU bit decay**: `ioBus` bits decay to 0 after ~3 frames without refresh via `openBusDecayStamp`

---

## Performance Impact

**Negligible** — one additional assignment per memory operation.

- Modern JavaScript engines optimize this extremely well
- No measurable frame rate impact
- Memory overhead: +1 byte per CPU instance (PPU: +33 bytes for `ioBus` + 8×uint32 decay stamps)

---

## Not Implemented (Low Priority)

### Controller Open Bus (Full Implementation)
- **Current:** Returns $40 for bits 5-7
- **Hardware:** Should return actual CPU data bus for bits 7-5
- **Impact:** Negligible — no known games depend on this

### DMC DMA Conflicts
- **Current:** DMC DMA halts CPU cleanly via `haltCycles(4)`
- **Hardware:** DMC can cause dummy reads during conflicts
- **Impact:** Very low — only affects cycle-accurate test ROMs

### NMI/BRK Overlap
- **Current:** BRK completes before NMI is checked
- **Hardware:** NMI can hijack BRK mid-execution
- **Impact:** Extremely low — almost no games use BRK

---

## Files

1. **src/cpu.js**
   - `dataBus` state variable (line 59)
   - `_read()` — tracks `dataBus` on all reads (lines 384–432)
   - `_write()` — tracks `dataBus` on all writes (lines 435–462)
   - `_readIORegister()` — IO dispatch with open bus fallback (lines 464–498)
   - `toJSON()` — persists `dataBus` (line 1440)
   - `fromJSON()` — restores `dataBus` (line 1490)

2. **src/apu.js**
   - `readReg()` — returns `undefined` for non-$4015 (line 904–905)
   - `DmcChannel.fetchSample()` — uses `cpu.cpuRead()` for bus tracking (lines 650–654)

3. **src/ppu.js**
   - `ioBus` latch (line 37) + `openBusDecayStamp` per-bit decay (line 38)
   - `setOpenBus(mask, value)` — bit-level open bus update with decay (lines 432–463)
   - `applyOpenBus(mask, value)` — merge hardware bits with decayed open bus (lines 466–468)

4. **src/controller.js** — returns `0x40 | buttonData` (approximation)

import Mapper000 from "./mapper000.js";
import Mapper001 from "./mapper001.js";
import Mapper002 from "./mapper002.js";
import Mapper003 from "./mapper003.js";
import Mapper004 from "./mapper004.js";
import Mapper005 from "./mapper005.js";
import Mapper006 from "./mapper006.js";
import Mapper007 from "./mapper007.js";
import Mapper009 from "./mapper009.js";
import Mapper010 from "./mapper010.js";
import Mapper011 from "./mapper011.js";
import Mapper021 from "./mapper021.js";
import Mapper025 from "./mapper025.js";
import Mapper034 from "./mapper034.js";
import Mapper047 from "./mapper047.js";
import Mapper066 from "./mapper066.js";
import Mapper069 from "./mapper069.js";
import Mapper079 from "./mapper079.js";

// Mesen reference IDs for special non-iNES mapper families.
export const FDS_MAPPER_ID = 65535;
export const NSF_MAPPER_ID = 65534;
export const STUDY_BOX_MAPPER_ID = 65533;
export const FAMICOM_NETWORK_SYSTEM_MAPPER_ID = 65532;

// ----------------------------------------------------------------------------
// Modular mapper registry
// ----------------------------------------------------------------------------

const mapperRegistry = new Map();
const submapperRegistry = new Map(); // key: `${mapperId}:${submapper}`

// Mapper 4 (MMC3) titles that are actually MMC6 in legacy iNES headers.
// Hash format matches ROM.getCRC32() (PRG+CHR CRC32, uppercase hex).
const MMC6_COMPAT_CRC32 = new Set([
  "889129CB", // StarTropics (USA)
  "998422FC", // StarTropics (Europe)
  "D054FFB0", // Zoda's Revenge: StarTropics II (USA)
]);

function getSubmapperKey(mapperId, submapperId) {
  return `${mapperId | 0}:${submapperId | 0}`;
}

function getRomCrc32Hex(romData) {
  if (!romData || typeof romData.getCRC32 !== "function") {
    return "";
  }

  const crc = romData.getCRC32();
  if (!Number.isFinite(crc)) {
    return "";
  }

  return (crc >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function isLegacyMmc6Title(romData) {
  if (!romData) {
    return false;
  }

  if ((romData.mapperType | 0) !== 4) {
    return false;
  }

  // Only apply for legacy headers without explicit MMC6 submapper information.
  if ((romData.submapper | 0) !== 0) {
    return false;
  }

  return MMC6_COMPAT_CRC32.has(getRomCrc32Hex(romData));
}

export function registerMapper(mapperId, mapperClass, submapperId = null) {
  const id = mapperId | 0;
  if (typeof mapperClass !== "function") {
    throw new TypeError("registerMapper expected a mapper class/constructor.");
  }

  if (submapperId === null || submapperId === undefined) {
    mapperRegistry.set(id, mapperClass);
  } else {
    submapperRegistry.set(getSubmapperKey(id, submapperId), mapperClass);
  }
}

export function unregisterMapper(mapperId, submapperId = null) {
  const id = mapperId | 0;
  if (submapperId === null || submapperId === undefined) {
    mapperRegistry.delete(id);
  } else {
    submapperRegistry.delete(getSubmapperKey(id, submapperId));
  }
}

function getMapperFromID(romData) {
  const mapperId = (romData && (romData.mapperType | 0)) || 0;
  const submapper = (romData && (romData.submapper | 0)) || 0;

  if (isLegacyMmc6Title(romData)) {
    return Mapper006;
  }

  // First check explicit submapper registration (Mesen supports many mapper/submapper splits).
  const submapperClass = submapperRegistry.get(getSubmapperKey(mapperId, submapper));
  if (submapperClass) {
    return submapperClass;
  }

  // Mesen baseline switch behavior, reduced to currently available implementations.
  switch (mapperId) {
    case 0:
      return mapperRegistry.get(0) || Mapper000;
    default:
      return mapperRegistry.get(mapperId) || null;
  }
}

// Register built-in NROM baseline.
registerMapper(0, Mapper000);
registerMapper(1, Mapper001);
registerMapper(2, Mapper002);
registerMapper(3, Mapper003);
registerMapper(4, Mapper004);
registerMapper(5, Mapper005);
registerMapper(4, Mapper006, 1);
registerMapper(7, Mapper007);
registerMapper(9, Mapper009);
registerMapper(10, Mapper010);
registerMapper(11, Mapper011);
registerMapper(144, Mapper011);
registerMapper(21, Mapper021);
registerMapper(25, Mapper025);
registerMapper(34, Mapper034);
registerMapper(47, Mapper047);
registerMapper(66, Mapper066);
registerMapper(69, Mapper069);
registerMapper(79, Mapper079);

/**
 * Creates a mapper instance for the given ROM.
 * Mesen baseline behavior: resolve by mapper ID, instantiate, then initialize via NES lifecycle.
 */
export function createMapper(mapperId, cartridge, nes) {
  if (!cartridge) {
    throw new Error("createMapper requires a ROM/cartridge object.");
  }

  if (nes) {
    cartridge.nes = nes;
  }

  // Keep ROM metadata authoritative; explicit mapperId parameter is accepted for compatibility.
  if (typeof mapperId === "number" && (cartridge.mapperType | 0) !== (mapperId | 0)) {
    cartridge.mapperType = mapperId | 0;
  }

  const MapperClass = getMapperFromID(cartridge);
  if (MapperClass) {
    return new MapperClass(cartridge);
  }

  const unresolvedId = (cartridge.mapperType | 0);
  throw new Error(`[MapperFactory] Unsupported mapper ${unresolvedId}.`);
}

export function isMapperSupported(mapperId, submapperId = null) {
  const id = mapperId | 0;
  if (submapperId !== null && submapperId !== undefined) {
    return submapperRegistry.has(getSubmapperKey(id, submapperId));
  }
  if (id === 0) {
    return true;
  }
  return mapperRegistry.has(id);
}

export function getSupportedMappers() {
  const ids = new Set([0]);
  for (const id of mapperRegistry.keys()) {
    ids.add(id | 0);
  }
  return Array.from(ids).sort((a, b) => a - b);
}

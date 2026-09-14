import { inflateRawSync } from "node:zlib";
import { mkdir, open, readFile, readdir, rm, lstat, stat } from "node:fs/promises";
import path from "node:path";
import { UrmaError } from "../core/errors.js";

export type ArchiveLimits = Readonly<{
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
}>;

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxArchiveBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxEntries: 100_000,
  maxEntryBytes: 512 * 1024 * 1024,
};

type ArchiveEntry = Readonly<{
  name: string;
  directory: boolean;
  data: Buffer;
}>;

function invalid(message: string, detail: Readonly<Record<string, unknown>> = {}): never {
  throw new UrmaError("ARCHIVE_INVALID", message, { detail });
}

function u32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function u16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function decodeName(bytes: Uint8Array, label: string): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (value.includes("\0")) invalid(`${label} contains a null byte`);
    return value;
  } catch (error) {
    if (error instanceof UrmaError) throw error;
    invalid(`${label} is not valid UTF-8`, { cause: String(error) });
  }
}

function safeName(raw: string, directory: boolean): string {
  if (!raw || raw.includes("\0") || raw.includes("\\") || /^\//u.test(raw) || /^\/\//u.test(raw)) {
    return invalid(`Archive entry has an absolute, UNC, or backslash path: ${JSON.stringify(raw)}`);
  }
  if (/^[A-Za-z]:/u.test(raw)) return invalid(`Archive entry has a drive path: ${JSON.stringify(raw)}`);
  const trimmed = directory ? raw.replace(/\/+$/u, "") : raw;
  if (!trimmed) return invalid("Archive contains an empty entry name");
  const parts = trimmed.split("/");
  for (const part of parts) {
    if (
      part === "" ||
      part === "." ||
      part === ".." ||
      part.includes(":") ||
      /[\u0000-\u001f\u007f]/u.test(part) ||
      /[ .]$/u.test(part) ||
      /^(?:CON|PRN|AUX|NUL|COM(?:[1-9]|[¹²³])|LPT(?:[1-9]|[¹²³]))(?:\..*)?$/iu.test(part)
    ) {
      return invalid(`Archive entry contains an unsafe path component: ${JSON.stringify(raw)}`);
    }
  }
  return trimmed;
}

function collisionKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en-US");
}

function validateEntryNames(entries: readonly ArchiveEntry[]): void {
  const seen = new Set<string>();
  const names = entries.map((entry) => entry.name);
  for (const name of names) {
    const key = collisionKey(name);
    if (seen.has(key)) invalid(`Archive contains a duplicate or case-colliding entry: ${JSON.stringify(name)}`);
    seen.add(key);
  }
  const files = new Set(names.filter((name, index) => !entries[index]?.directory));
  for (const entry of entries) {
    const parts = entry.name.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      if ([...files].some((file) => collisionKey(file) === collisionKey(parent))) {
        invalid(`Archive entry is nested below a file: ${JSON.stringify(entry.name)}`);
      }
    }
    if (!entry.directory && names.some((other) => other.startsWith(`${entry.name}/`))) {
      invalid(`Archive file is also a directory parent: ${JSON.stringify(entry.name)}`);
    }
  }
}

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (offset >= 0 && u32(buffer, offset) === 0x06054b50) return offset;
  }
  return invalid("ZIP archive has no end-of-central-directory record");
}

function parseZip(buffer: Buffer, limits: ArchiveLimits): ArchiveEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const entries = u16(buffer, eocd + 10);
  const centralBytes = u32(buffer, eocd + 12);
  const centralOffset = u32(buffer, eocd + 16);
  if (entries > limits.maxEntries) invalid("ZIP archive entry count exceeds the safety limit");
  if (entries === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) {
    invalid("ZIP64 archives are not supported by the bounded extractor");
  }
  if (centralOffset + centralBytes > buffer.length || centralOffset < 0) invalid("ZIP central directory is outside the archive");
  const result: ArchiveEntry[] = [];
  let offset = centralOffset;
  let expanded = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || u32(buffer, offset) !== 0x02014b50) invalid("ZIP central directory entry is malformed");
    const flags = u16(buffer, offset + 8);
    const method = u16(buffer, offset + 10);
    const crc = u32(buffer, offset + 16);
    const compressedSize = u32(buffer, offset + 20);
    const uncompressedSize = u32(buffer, offset + 24);
    const nameLength = u16(buffer, offset + 28);
    const extraLength = u16(buffer, offset + 30);
    const commentLength = u16(buffer, offset + 32);
    const externalAttributes = u32(buffer, offset + 38);
    const localOffset = u32(buffer, offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length || end > centralOffset + centralBytes) invalid("ZIP central directory entry exceeds its bounds");
    if ((flags & 1) !== 0) invalid("Encrypted ZIP entries are not supported");
    if (method !== 0 && method !== 8) invalid(`ZIP compression method ${String(method)} is not supported`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) invalid("ZIP64 entry fields are not supported");
    if (uncompressedSize > limits.maxEntryBytes || expanded + uncompressedSize > limits.maxExpandedBytes) invalid("ZIP expanded size exceeds the safety limit");
    const rawName = decodeName(buffer.subarray(offset + 46, offset + 46 + nameLength), "ZIP entry name");
    const directory = rawName.endsWith("/");
    const name = safeName(rawName, directory);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) invalid(`ZIP symlink entry is not allowed: ${JSON.stringify(name)}`);
    if (directory && uncompressedSize !== 0) invalid(`ZIP directory entry has data: ${JSON.stringify(name)}`);
    if (localOffset + 30 > buffer.length || u32(buffer, localOffset) !== 0x04034b50) invalid(`ZIP local entry is malformed: ${JSON.stringify(name)}`);
    const localFlags = u16(buffer, localOffset + 6);
    const localMethod = u16(buffer, localOffset + 8);
    const localNameLength = u16(buffer, localOffset + 26);
    const localExtraLength = u16(buffer, localOffset + 28);
    if ((localFlags & 1) !== 0 || localMethod !== method) invalid(`ZIP local metadata does not match central metadata: ${JSON.stringify(name)}`);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart < 0 || dataEnd > buffer.length) invalid(`ZIP entry data is outside the archive: ${JSON.stringify(name)}`);
    if (decodeName(buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength), "ZIP local entry name") !== rawName) invalid(`ZIP local and central names differ: ${JSON.stringify(name)}`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data: Buffer;
    try {
      data = method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: Math.max(uncompressedSize, 1) });
    } catch (error) {
      invalid(`ZIP entry could not be decompressed: ${JSON.stringify(name)}`, { cause: String(error) });
    }
    if (data.length !== uncompressedSize || crc32(data) !== crc) invalid(`ZIP entry failed size or CRC validation: ${JSON.stringify(name)}`);
    result.push({ name, directory, data });
    expanded += uncompressedSize;
    offset = end;
  }
  if (offset !== centralOffset + centralBytes) invalid("ZIP central directory has trailing or unparsed bytes");
  validateEntryNames(result);
  return result;
}

function tarField(buffer: Buffer, offset: number, length: number, label: string): string {
  const end = offset + length;
  const nul = buffer.indexOf(0, offset);
  const actualEnd = nul >= offset && nul < end ? nul : end;
  return decodeName(buffer.subarray(offset, actualEnd), label).replace(/[ \t]+$/u, "");
}

function tarOctal(buffer: Buffer, offset: number, length: number, label: string): number {
  const raw = tarField(buffer, offset, length, label).trim();
  if (!/^[0-7]+$/u.test(raw)) invalid(`${label} is not a valid tar octal number`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} is outside safe numeric bounds`);
  return value;
}

function parseTar(raw: Buffer, limits: ArchiveLimits): ArchiveEntry[] {
  const result: ArchiveEntry[] = [];
  let offset = 0;
  let expanded = 0;
  let ended = false;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    let storedChecksum: number;
    try {
      storedChecksum = tarOctal(header, 148, 8, "tar checksum");
    } catch (error) {
      throw error;
    }
    let calculated = 0;
    for (let index = 0; index < 512; index += 1) calculated += index >= 148 && index < 156 ? 0x20 : header[index] ?? 0;
    if (calculated !== storedChecksum) invalid("tar header checksum does not match");
    const namePart = tarField(header, 0, 100, "tar entry name");
    const prefix = tarField(header, 345, 155, "tar entry prefix");
    const rawName = prefix ? `${prefix}/${namePart}` : namePart;
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156] ?? 0);
    const directory = type === "5" || rawName.endsWith("/");
    if (type !== "0" && type !== "5") invalid(`tar entry type ${JSON.stringify(type)} is not a regular file or directory`);
    const name = safeName(rawName, directory);
    if (result.length >= limits.maxEntries) invalid("tar archive entry count exceeds the safety limit");
    const size = tarOctal(header, 124, 12, `tar size for ${name}`);
    if (size > limits.maxEntryBytes || expanded + size > limits.maxExpandedBytes) invalid("tar expanded size exceeds the safety limit");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > raw.length) invalid(`tar entry data is outside the archive: ${JSON.stringify(name)}`);
    if (directory && size !== 0) invalid(`tar directory entry has data: ${JSON.stringify(name)}`);
    result.push({ name, directory, data: Buffer.from(raw.subarray(dataStart, dataEnd)) });
    expanded += size;
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!ended) invalid("tar archive has no terminating zero blocks");
  for (let index = offset; index < raw.length; index += 1) {
    if (raw[index] !== 0) invalid("tar archive has non-zero data after its end marker");
  }
  if (result.length > limits.maxEntries) invalid("tar archive entry count exceeds the safety limit");
  validateEntryNames(result);
  return result;
}

let wasmReady: Promise<unknown> | null = null;
async function decompressXz(buffer: Buffer, limits: ArchiveLimits): Promise<Buffer> {
  const packageName: string = "lzma-wasm";
  const lzma = await import(packageName) as {
    initWasm: () => Promise<unknown>;
    decompress: (input: Uint8Array, options?: { memLimit?: number }) => Uint8Array;
  };
  wasmReady ??= lzma.initWasm();
  await wasmReady;
  try {
    const output = lzma.decompress(new Uint8Array(buffer), { memLimit: limits.maxExpandedBytes });
    if (output.byteLength > limits.maxExpandedBytes) invalid("XZ expanded size exceeds the safety limit");
    return Buffer.from(output);
  } catch (error) {
    if (error instanceof UrmaError) throw error;
    invalid("XZ archive could not be decompressed", { cause: String(error) });
  }
}

async function ensureEmptyDestination(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const info = await lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink()) invalid("Archive extraction destination must be a real directory");
  if ((await readdir(destination)).length !== 0) invalid("Archive extraction destination must be empty");
}

async function ensureParents(destination: string, parent: string): Promise<void> {
  const relative = path.relative(destination, parent);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) invalid("Archive extraction parent escapes its destination");
  let current = destination;
  for (const part of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) invalid(`Archive extraction passes through an unsafe parent: ${current}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function writeEntries(destination: string, entries: readonly ArchiveEntry[]): Promise<readonly string[]> {
  const inventory: string[] = [];
  for (const entry of entries) {
    const target = path.resolve(destination, ...entry.name.split("/"));
    const relative = path.relative(path.resolve(destination), target);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) invalid(`Archive entry escapes destination: ${entry.name}`);
    await ensureParents(destination, path.dirname(target));
    if (entry.directory) {
      await mkdir(target, { recursive: false, mode: 0o700 });
      inventory.push(entry.name);
      continue;
    }
    const handle = await open(target, "wx", 0o700);
    try {
      await handle.writeFile(entry.data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    inventory.push(entry.name);
  }
  return inventory;
}

export async function extractArchive(
  archivePath: string,
  format: "zip" | "tar.xz",
  destination: string,
  suppliedLimits: Partial<ArchiveLimits> = {},
): Promise<readonly string[]> {
  const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...suppliedLimits };
  let info;
  try {
    info = await lstat(archivePath);
  } catch (error) {
    throw new UrmaError("ARCHIVE_INVALID", `Could not inspect archive ${archivePath}`, { cause: error });
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxArchiveBytes) invalid(`Archive is missing, not a regular file, or exceeds ${String(limits.maxArchiveBytes)} bytes`);
  let buffer: Buffer;
  try {
    buffer = await readFile(archivePath);
  } catch (error) {
    throw new UrmaError("ARCHIVE_INVALID", `Could not read archive ${archivePath}`, { cause: error });
  }
  if (buffer.length > limits.maxArchiveBytes) invalid("Archive grew beyond its safety limit while being read");
  let entries: ArchiveEntry[];
  if (format === "zip") {
    entries = parseZip(buffer, limits);
  } else {
    entries = parseTar(await decompressXz(buffer, limits), limits);
  }
  // Do not remove a caller-owned non-empty directory when validation fails.
  // Once the destination has been proven empty, it is ours to clean up if a
  // later entry write fails.
  let cleanupAllowed = false;
  try {
    await ensureEmptyDestination(destination);
    cleanupAllowed = true;
    const inventory = await writeEntries(destination, entries);
    return inventory;
  } catch (error) {
    if (cleanupAllowed) await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof UrmaError) throw error;
    throw new UrmaError("ARCHIVE_INVALID", `Archive extraction failed for ${archivePath}`, { cause: error });
  }
}

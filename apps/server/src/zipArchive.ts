// FILE: zipArchive.ts
// Purpose: Streams a ZIP archive entry by entry, so neither a whole archive nor a whole entry is
//          held in memory (thread exports, workspace folder downloads).
// Layer: Server utility
// Exports: zipArchiveChunks, ZipArchiveEntry, ZIP_MAX_ENTRIES, ZIP_MAX_BYTES
//
// Each entry is deflated as it streams, with general-purpose bit 3 set: the CRC-32 and sizes
// follow the data in a data descriptor and are repeated in the central directory, which every
// unzip tool reads. Names are UTF-8. Times are zeroed (1980-01-01) to keep output deterministic.
import * as zlib from "node:zlib";

export interface ZipArchiveEntry {
  readonly name: string;
  readonly chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>;
}

// ponytail: no ZIP64, so offsets, sizes and the entry count must fit the classic 32/16-bit
// fields. Add ZIP64 records when a download needs more than this.
export const ZIP_MAX_ENTRIES = 0xffff;
export const ZIP_MAX_BYTES = 0xffffffff;

const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const FLAGS = UTF8_FLAG | DATA_DESCRIPTOR_FLAG;
const DEFLATE = 8;

const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value >>> 0, 0);
  return buffer;
};

const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
};

function tooLarge(): Error {
  return new Error("The archive is too large to download as one ZIP file.");
}

/** Deflates `chunks`, yielding compressed bytes as they appear; returns CRC-32 and sizes. */
async function* deflateChunks(
  chunks: ZipArchiveEntry["chunks"],
): AsyncGenerator<Buffer, { crc: number; compressedSize: number; uncompressedSize: number }> {
  const deflater = zlib.createDeflateRaw();
  let ready: Buffer[] = [];
  deflater.on("data", (chunk: Buffer) => ready.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    deflater.once("end", resolve);
    deflater.once("error", reject);
  });
  const take = () => {
    const out = ready;
    ready = [];
    return out;
  };
  let crc = 0;
  let compressedSize = 0;
  let uncompressedSize = 0;
  for await (const chunk of chunks) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    crc = zlib.crc32(buffer, crc) >>> 0;
    uncompressedSize += buffer.length;
    if (!deflater.write(buffer)) {
      await new Promise<void>((resolve) => deflater.once("drain", resolve));
    }
    for (const out of take()) {
      compressedSize += out.length;
      yield out;
    }
  }
  deflater.end();
  await finished;
  for (const out of take()) {
    compressedSize += out.length;
    yield out;
  }
  if (uncompressedSize > ZIP_MAX_BYTES || compressedSize > ZIP_MAX_BYTES) throw tooLarge();
  return { crc, compressedSize, uncompressedSize };
}

export async function* zipArchiveChunks(
  entries: Iterable<ZipArchiveEntry> | AsyncIterable<ZipArchiveEntry>,
): AsyncGenerator<Buffer> {
  const centralRecords: Buffer[] = [];
  let offset = 0;

  for await (const entry of entries) {
    if (centralRecords.length >= ZIP_MAX_ENTRIES) throw tooLarge();
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const localHeader = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed to extract
      u16(FLAGS),
      u16(DEFLATE),
      u16(0), // last mod time
      u16(0), // last mod date
      u32(0), // CRC-32: in the data descriptor
      u32(0), // compressed size: in the data descriptor
      u32(0), // uncompressed size: in the data descriptor
      u16(nameBuffer.length),
      u16(0), // extra field length
      nameBuffer,
    ]);
    const localHeaderOffset = offset;
    offset += localHeader.length;
    yield localHeader;

    const data = deflateChunks(entry.chunks);
    let next = await data.next();
    while (!next.done) {
      offset += next.value.length;
      yield next.value;
      next = await data.next();
    }
    const { crc, compressedSize, uncompressedSize } = next.value;

    const descriptor = Buffer.concat([
      u32(0x08074b50), // data descriptor signature
      u32(crc),
      u32(compressedSize),
      u32(uncompressedSize),
    ]);
    offset += descriptor.length;
    yield descriptor;
    if (offset > ZIP_MAX_BYTES) throw tooLarge();

    centralRecords.push(
      Buffer.concat([
        u32(0x02014b50), // central directory header signature
        u16(20), // version made by
        u16(20), // version needed to extract
        u16(FLAGS),
        u16(DEFLATE),
        u16(0), // last mod time
        u16(0), // last mod date
        u32(crc),
        u32(compressedSize),
        u32(uncompressedSize),
        u16(nameBuffer.length),
        u16(0), // extra field length
        u16(0), // file comment length
        u16(0), // disk number start
        u16(0), // internal file attributes
        u32(0), // external file attributes
        u32(localHeaderOffset),
        nameBuffer,
      ]),
    );
  }

  const centralDirectory = Buffer.concat(centralRecords);
  if (offset + centralDirectory.length > ZIP_MAX_BYTES) throw tooLarge();
  yield centralDirectory;
  yield Buffer.concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // number of this disk
    u16(0), // disk where central directory starts
    u16(centralRecords.length), // entries on this disk
    u16(centralRecords.length), // total entries
    u32(centralDirectory.length),
    u32(offset), // offset of central directory
    u16(0), // comment length
  ]);
}

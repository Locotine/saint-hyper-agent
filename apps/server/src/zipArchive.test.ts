import zlib from "node:zlib";

import { describe, expect, it } from "@effect/vitest";

import { zipArchiveChunks } from "./zipArchive.ts";

/** Reads entries through the central directory, as unzip tools do with data descriptors. */
function readZip(buffer: Buffer): Array<{ name: string; data: Buffer }> {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries: Array<{ name: string; data: Buffer }> = [];
  for (let index = 0; index < count; index += 1) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const local = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26);
    const data = zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize));
    expect(data.length).toBe(size);
    expect(zlib.crc32(data) >>> 0).toBe(crc);
    entries.push({ name, data });
    cursor += 46 + nameLength;
  }
  return entries;
}

async function collect(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

describe("zipArchiveChunks", () => {
  it("round-trips text, binary, empty and async-sourced entries", async () => {
    const binary = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256));
    async function* asyncChunks() {
      yield binary.subarray(0, 1000);
      yield binary.subarray(1000);
    }
    const archive = await collect(
      zipArchiveChunks([
        { name: "docs/báo cáo.txt", chunks: ["xin ", "chào"] },
        { name: "docs/blob.bin", chunks: asyncChunks() },
        { name: "docs/empty", chunks: [] },
      ]),
    );
    const entries = readZip(archive);
    expect(entries.map((entry) => entry.name)).toEqual([
      "docs/báo cáo.txt",
      "docs/blob.bin",
      "docs/empty",
    ]);
    expect(entries[0]!.data.toString("utf8")).toBe("xin chào");
    expect(entries[1]!.data.equals(binary)).toBe(true);
    expect(entries[2]!.data.length).toBe(0);
  });

  it("writes a valid empty archive", async () => {
    const archive = await collect(zipArchiveChunks([]));
    expect(archive.length).toBe(22);
    expect(readZip(archive)).toEqual([]);
  });
});

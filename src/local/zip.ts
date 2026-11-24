// Простой ZIP без сжатия (видео и так сжато). Архив собирается как Blob из частей: сами файлы
// в память не загружаются — браузер читает их с диска, когда архив сохраняется. Поддерживает ZIP64,
// поэтому архив может быть больше 4 ГБ.

const U32 = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Update(crc: number, data: Uint8Array): number {
  let c = crc ^ U32;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ U32) >>> 0;
}

/** Контрольная сумма файла; читается потоком, память не растёт. */
export async function crc32OfBlob(blob: Blob, onBytes?: (n: number) => void): Promise<number> {
  let crc = 0;
  if (typeof blob.stream === "function") {
    const reader = blob.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      crc = crc32Update(crc, value);
      onBytes?.(value.byteLength);
    }
    return crc;
  }
  const step = 8 * 1024 * 1024;
  for (let at = 0; at < blob.size; at += step) {
    const chunk = new Uint8Array(await blob.slice(at, at + step).arrayBuffer());
    crc = crc32Update(crc, chunk);
    onBytes?.(chunk.byteLength);
  }
  return crc;
}

class Bytes {
  private readonly view: DataView;
  private at = 0;
  readonly array: Uint8Array<ArrayBuffer>;
  constructor(size: number) {
    this.array = new Uint8Array(new ArrayBuffer(size));
    this.view = new DataView(this.array.buffer);
  }
  u16(v: number): this {
    this.view.setUint16(this.at, v, true);
    this.at += 2;
    return this;
  }
  u32(v: number): this {
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
    return this;
  }
  u64(v: number): this {
    this.view.setUint32(this.at, v % 0x100000000, true);
    this.view.setUint32(this.at + 4, Math.floor(v / 0x100000000), true);
    this.at += 8;
    return this;
  }
  bytes(data: Uint8Array): this {
    this.array.set(data, this.at);
    this.at += data.length;
    return this;
  }
}

function dosTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

interface Entry {
  name: Uint8Array;
  size: number;
  crc: number;
  offset: number;
  time: number;
  day: number;
}

export class ZipBuilder {
  private readonly parts: BlobPart[] = [];
  private readonly entries: Entry[] = [];
  private offset = 0;
  private readonly used = new Set<string>();

  /** Имя, которого ещё нет в архиве: при совпадении добавляется номер. */
  uniqueName(base: string, ext: string): string {
    let name = `${base}.${ext}`;
    for (let i = 2; this.used.has(name.toLowerCase()); i++) name = `${base} (${i}).${ext}`;
    this.used.add(name.toLowerCase());
    return name;
  }

  async add(path: string, data: Blob, modified: Date, onBytes?: (n: number) => void): Promise<void> {
    const name = new TextEncoder().encode(path);
    const crc = await crc32OfBlob(data, onBytes);
    const { time, day } = dosTime(modified);
    const big = data.size >= U32;
    const header = new Bytes(30 + name.length + (big ? 20 : 0))
      .u32(0x04034b50)
      .u16(big ? 45 : 20)
      .u16(0x0800) // имена в UTF-8
      .u16(0) // без сжатия
      .u16(time)
      .u16(day)
      .u32(crc)
      .u32(big ? U32 : data.size)
      .u32(big ? U32 : data.size)
      .u16(name.length)
      .u16(big ? 20 : 0)
      .bytes(name);
    if (big) header.u16(0x0001).u16(16).u64(data.size).u64(data.size);
    this.entries.push({ name, size: data.size, crc, offset: this.offset, time, day });
    this.parts.push(header.array, data);
    this.offset += header.array.length + data.size;
  }

  finish(): Blob {
    const cdStart = this.offset;
    let cdSize = 0;
    for (const e of this.entries) {
      const bigSize = e.size >= U32;
      const bigOffset = e.offset >= U32;
      const extraLen = bigSize || bigOffset ? 4 + (bigSize ? 16 : 0) + (bigOffset ? 8 : 0) : 0;
      const record = new Bytes(46 + e.name.length + extraLen)
        .u32(0x02014b50)
        .u16(45)
        .u16(extraLen ? 45 : 20)
        .u16(0x0800)
        .u16(0)
        .u16(e.time)
        .u16(e.day)
        .u32(e.crc)
        .u32(bigSize ? U32 : e.size)
        .u32(bigSize ? U32 : e.size)
        .u16(e.name.length)
        .u16(extraLen)
        .u16(0)
        .u16(0)
        .u16(0)
        .u32(0)
        .u32(bigOffset ? U32 : e.offset)
        .bytes(e.name);
      if (extraLen) {
        record.u16(0x0001).u16(extraLen - 4);
        if (bigSize) record.u64(e.size).u64(e.size);
        if (bigOffset) record.u64(e.offset);
      }
      this.parts.push(record.array);
      cdSize += record.array.length;
    }

    const count = this.entries.length;
    const zip64 = count >= 0xffff || cdStart >= U32 || cdSize >= U32;
    if (zip64) {
      const record = new Bytes(56)
        .u32(0x06064b50)
        .u64(44)
        .u16(45)
        .u16(45)
        .u32(0)
        .u32(0)
        .u64(count)
        .u64(count)
        .u64(cdSize)
        .u64(cdStart);
      const locator = new Bytes(20).u32(0x07064b50).u32(0).u64(cdStart + cdSize).u32(1);
      this.parts.push(record.array, locator.array);
    }
    const end = new Bytes(22)
      .u32(0x06054b50)
      .u16(0)
      .u16(0)
      .u16(Math.min(count, 0xffff))
      .u16(Math.min(count, 0xffff))
      .u32(Math.min(cdSize, U32))
      .u32(Math.min(cdStart, U32))
      .u16(0);
    this.parts.push(end.array);
    return new Blob(this.parts, { type: "application/zip" });
  }
}

export interface ZipFile {
  path: string;
  size: number;
  /** Содержимое файла — срез исходного архива, без чтения в память. */
  blob(): Promise<Blob>;
}

const u64 = (view: DataView, at: number): number => view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x100000000;

/** Читает оглавление ZIP без сжатия (такие создаёт экспорт Flash). */
export async function readZip(file: Blob): Promise<ZipFile[]> {
  const tailSize = Math.min(file.size, 66_000);
  const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not_zip");
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdStart = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === U32 || cdStart === U32) {
    const locatorAt = eocd - 20;
    if (locatorAt < 0 || tail.getUint32(locatorAt, true) !== 0x07064b50) throw new Error("bad_zip");
    const recordAt = u64(tail, locatorAt + 8);
    const record = new DataView(await file.slice(recordAt, recordAt + 56).arrayBuffer());
    if (record.getUint32(0, true) !== 0x06064b50) throw new Error("bad_zip");
    count = u64(record, 32);
    cdSize = u64(record, 40);
    cdStart = u64(record, 48);
  }

  const cd = new DataView(await file.slice(cdStart, cdStart + cdSize).arrayBuffer());
  const decoder = new TextDecoder();
  const out: ZipFile[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > cd.byteLength || cd.getUint32(at, true) !== 0x02014b50) throw new Error("bad_zip");
    const method = cd.getUint16(at + 10, true);
    let size = cd.getUint32(at + 24, true);
    const nameLen = cd.getUint16(at + 28, true);
    const extraLen = cd.getUint16(at + 30, true);
    const commentLen = cd.getUint16(at + 32, true);
    let offset = cd.getUint32(at + 42, true);
    const path = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + at + 46, nameLen));
    // ZIP64: настоящие размер и смещение лежат в дополнительном поле.
    let extraAt = at + 46 + nameLen;
    const extraEnd = extraAt + extraLen;
    while (extraAt + 4 <= extraEnd) {
      const id = cd.getUint16(extraAt, true);
      const len = cd.getUint16(extraAt + 2, true);
      if (id === 0x0001) {
        let p = extraAt + 4;
        if (size === U32) {
          size = u64(cd, p);
          p += 16;
        }
        if (offset === U32) offset = u64(cd, p);
      }
      extraAt += 4 + len;
    }
    at = extraEnd + commentLen;
    if (method !== 0) throw new Error("compressed_zip");
    const entryOffset = offset;
    const entrySize = size;
    out.push({
      path,
      size: entrySize,
      blob: async () => {
        const head = new DataView(await file.slice(entryOffset, entryOffset + 30).arrayBuffer());
        if (head.getUint32(0, true) !== 0x04034b50) throw new Error("bad_zip");
        const dataStart = entryOffset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
        return file.slice(dataStart, dataStart + entrySize);
      },
    });
  }
  return out;
}

// Запись готового фильма на диск по мере сборки. Кодировщик пишет файл не подряд (в конце он
// возвращается и дописывает заголовок), поэтому файл хранится страницами: свежие — в памяти,
// остальные — в IndexedDB. В памяти остаётся несколько страниц, какой бы длины ни был фильм.

import { store } from "../store";

const PAGE_SIZE = 4 * 1024 * 1024;
const MAX_PAGES_IN_MEMORY = 4;

export class PagedWriter {
  private readonly prefix: string;
  private readonly memory = new Map<number, Uint8Array<ArrayBuffer>>();
  private readonly onDisk = new Set<number>();
  /** Порядок обращения к страницам: первой выгружается та, к которой обращались давнее всего. */
  private recent: number[] = [];
  private size = 0;
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  constructor(sessionId: string) {
    this.prefix = `tmp/${sessionId}/`;
  }

  get bytes(): number {
    return this.size;
  }

  /** Поток для кодировщика: принимает куски с позицией в файле. */
  writable(): WritableStream<{ type: "write"; data: Uint8Array<ArrayBuffer>; position: number }> {
    return new WritableStream({
      write: (chunk) => this.write(chunk.data, chunk.position),
    });
  }

  write(data: Uint8Array, position: number): Promise<void> {
    // Записи выполняются строго по очереди: страницы не должны перемешаться.
    const run = this.queue.then(() => this.writeNow(data, position));
    this.queue = run.catch((err) => {
      this.failure ??= err;
    });
    return run;
  }

  private touch(index: number): void {
    const at = this.recent.indexOf(index);
    if (at >= 0) this.recent.splice(at, 1);
    this.recent.push(index);
  }

  private key(index: number): string {
    return `${this.prefix}${String(index).padStart(6, "0")}`;
  }

  private async page(index: number): Promise<Uint8Array<ArrayBuffer>> {
    let page = this.memory.get(index);
    if (!page) {
      page = new Uint8Array(new ArrayBuffer(PAGE_SIZE));
      if (this.onDisk.has(index)) {
        const blob = await store.getBlob(this.key(index));
        if (blob) page.set(new Uint8Array(await blob.arrayBuffer()));
      }
      this.memory.set(index, page);
      await this.evict(index);
    }
    this.touch(index);
    return page;
  }

  private async evict(keep: number): Promise<void> {
    while (this.memory.size > MAX_PAGES_IN_MEMORY) {
      const victim = this.recent.find((i) => i !== keep && this.memory.has(i));
      if (victim === undefined) return;
      await this.flush(victim);
    }
  }

  private async flush(index: number): Promise<void> {
    const page = this.memory.get(index);
    if (!page) return;
    await store.putBlob(this.key(index), new Blob([page]));
    this.onDisk.add(index);
    this.memory.delete(index);
    this.recent = this.recent.filter((i) => i !== index);
  }

  private async writeNow(data: Uint8Array, position: number): Promise<void> {
    if (this.failure) throw this.failure;
    let offset = 0;
    while (offset < data.length) {
      const at = position + offset;
      const index = Math.floor(at / PAGE_SIZE);
      const inPage = at - index * PAGE_SIZE;
      const take = Math.min(data.length - offset, PAGE_SIZE - inPage);
      const page = await this.page(index);
      page.set(data.subarray(offset, offset + take), inPage);
      offset += take;
    }
    this.size = Math.max(this.size, position + data.length);
  }

  /** Готовый файл одним Blob: страницы с диска читаются по мере надобности, а не целиком в память. */
  async finish(type: string): Promise<Blob> {
    await this.queue;
    if (this.failure) throw this.failure;
    for (const index of [...this.memory.keys()]) await this.flush(index);
    const pages = Math.ceil(this.size / PAGE_SIZE);
    const parts: Blob[] = [];
    for (let i = 0; i < pages; i++) {
      const blob = this.onDisk.has(i) ? await store.getBlob(this.key(i)) : undefined;
      const full = blob ?? new Blob([new Uint8Array(PAGE_SIZE)]);
      const length = Math.min(PAGE_SIZE, this.size - i * PAGE_SIZE);
      parts.push(length < full.size ? full.slice(0, length) : full);
    }
    return new Blob(parts, { type });
  }

  /** Удаляет временные страницы (после сохранения фильма или при отмене). */
  async discard(): Promise<void> {
    await this.queue.catch(() => {});
    this.memory.clear();
    this.recent = [];
    this.onDisk.clear();
    await store.deleteBlobs(this.prefix).catch(() => {});
  }
}

/** Убирает страницы, оставшиеся от сборок, прерванных закрытием приложения. */
export async function cleanupTempPages(): Promise<void> {
  await store.deleteBlobs("tmp/").catch(() => {});
}

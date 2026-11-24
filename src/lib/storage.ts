// Приватное хранилище файлов. Два драйвера с одним интерфейсом:
//   s3    — любое S3-совместимое хранилище (MinIO, AWS S3, R2, B2 …)
//   local — папка на диске (разработка и простые установки на одном сервере)
// Наружу бакет не публикуется: файлы отдаёт только приложение по подписанным ссылкам.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { env } from "./env";

export interface ObjectInfo {
  size: number;
  contentType?: string;
}

/** Диапазон байт, обе границы включительно. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface StoredPart {
  n: number;
  etag: string;
  size: number;
}

export interface StorageDriver {
  readonly name: "local" | "s3";
  init(): Promise<void>;
  putFile(key: string, filePath: string, contentType: string): Promise<number>;
  putBuffer(key: string, data: Buffer, contentType: string): Promise<void>;
  head(key: string): Promise<ObjectInfo | null>;
  getStream(key: string, range?: ByteRange): Promise<Readable>;
  downloadToFile(key: string, filePath: string): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  createMultipart(key: string, contentType: string): Promise<string>;
  uploadPart(key: string, uploadId: string, n: number, data: Buffer): Promise<string>;
  completeMultipart(key: string, uploadId: string, parts: StoredPart[]): Promise<number>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

const KEY_RE = /^u\/[0-9a-f-]{36}\/[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

/** Ключи создаёт только сервер, но путь из URL всё равно проверяем строго. */
export function isSafeKey(key: string): boolean {
  return KEY_RE.test(key) && !key.includes("..") && !key.includes("//") && key.length < 300;
}

export function userPrefix(userId: string): string {
  return `u/${userId}/`;
}

export const keys = {
  momentOriginal: (userId: string, momentId: string, ext: string) => `u/${userId}/moments/${momentId}/original.${ext}`,
  momentPlayback: (userId: string, momentId: string) => `u/${userId}/moments/${momentId}/playback.mp4`,
  momentPoster: (userId: string, momentId: string) => `u/${userId}/moments/${momentId}/poster.jpg`,
  momentPrefix: (userId: string, momentId: string) => `u/${userId}/moments/${momentId}/`,
  film: (userId: string, filmId: string, rev: number) => `u/${userId}/films/${filmId}/film-${rev}.mp4`,
  filmPoster: (userId: string, filmId: string, rev: number) => `u/${userId}/films/${filmId}/poster-${rev}.jpg`,
  filmPrefix: (userId: string, filmId: string) => `u/${userId}/films/${filmId}/`,
  projectCover: (userId: string, projectId: string, version: number) =>
    `u/${userId}/projects/${projectId}/cover-${version}.jpg`,
  projectPrefix: (userId: string, projectId: string) => `u/${userId}/projects/${projectId}/`,
};

// ── Локальный драйвер ────────────────────────────────────────

class LocalStorage implements StorageDriver {
  readonly name = "local" as const;
  constructor(private root: string) {}

  private file(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Недопустимый ключ хранилища");
    return full;
  }

  private partsDir(uploadId: string): string {
    if (!/^[0-9a-f]{32}$/.test(uploadId)) throw new Error("Недопустимый идентификатор загрузки");
    return path.join(this.root, ".multipart", uploadId);
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true });
  }

  async putFile(key: string, filePath: string): Promise<number> {
    const dest = this.file(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fsp.copyFile(filePath, tmp);
    await fsp.rename(tmp, dest);
    return (await fsp.stat(dest)).size;
  }

  async putBuffer(key: string, data: Buffer): Promise<void> {
    const dest = this.file(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, dest);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const st = await fsp.stat(this.file(key));
      return st.isFile() ? { size: st.size } : null;
    } catch {
      return null;
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    return fs.createReadStream(this.file(key), range ? { start: range.start, end: range.end } : undefined);
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    await fsp.copyFile(this.file(key), filePath);
  }

  async delete(key: string): Promise<void> {
    await fsp.rm(this.file(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    const dir = this.file(prefix.replace(/\/+$/, "") + "/x");
    await fsp.rm(path.dirname(dir), { recursive: true, force: true });
  }

  async createMultipart(): Promise<string> {
    const id = crypto.randomBytes(16).toString("hex");
    await fsp.mkdir(this.partsDir(id), { recursive: true });
    return id;
  }

  async uploadPart(_key: string, uploadId: string, n: number, data: Buffer): Promise<string> {
    const dir = this.partsDir(uploadId);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${n}.tmp`);
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, path.join(dir, String(n)));
    return crypto.createHash("md5").update(data).digest("hex");
  }

  async completeMultipart(key: string, uploadId: string, parts: StoredPart[]): Promise<number> {
    const dir = this.partsDir(uploadId);
    const dest = this.file(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const out = fs.createWriteStream(tmp);
    try {
      for (const part of [...parts].sort((a, b) => a.n - b.n)) {
        await pipeline(fs.createReadStream(path.join(dir, String(part.n))), out, { end: false });
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    await fsp.rename(tmp, dest);
    await fsp.rm(dir, { recursive: true, force: true });
    return (await fsp.stat(dest)).size;
  }

  async abortMultipart(_key: string, uploadId: string): Promise<void> {
    await fsp.rm(this.partsDir(uploadId), { recursive: true, force: true });
  }
}

// ── S3 ───────────────────────────────────────────────────────

const S3_PART = 16 * 1024 * 1024;

class S3Storage implements StorageDriver {
  readonly name = "s3" as const;
  private client: S3Client;
  private bucket: string;

  constructor() {
    const cfg = env.s3;
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: cfg.accessKey ? { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey } : undefined,
      // Многие S3-совместимые хранилища не понимают новые обязательные контрольные суммы SDK.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async init(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as Error).name === "NotFound" || (err as Error).name === "NoSuchBucket") {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } else {
        throw err;
      }
    }
  }

  async putFile(key: string, filePath: string, contentType: string): Promise<number> {
    const { size } = await fsp.stat(filePath);
    if (size <= S3_PART * 2) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: fs.createReadStream(filePath),
          ContentLength: size,
          ContentType: contentType,
        }),
      );
      return size;
    }
    // Большие файлы (готовые фильмы) — частями, чтобы не держать их в памяти.
    const uploadId = await this.createMultipart(key, contentType);
    const handle = await fsp.open(filePath, "r");
    try {
      const parts: StoredPart[] = [];
      let offset = 0;
      let n = 1;
      while (offset < size) {
        const len = Math.min(S3_PART, size - offset);
        const buf = Buffer.allocUnsafe(len);
        await handle.read(buf, 0, len, offset);
        const etag = await this.uploadPart(key, uploadId, n, buf);
        parts.push({ n, etag, size: len });
        offset += len;
        n++;
      }
      await this.completeMultipart(key, uploadId, parts);
    } catch (err) {
      await this.abortMultipart(key, uploadId).catch(() => {});
      throw err;
    } finally {
      await handle.close();
    }
    return size;
  }

  async putBuffer(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentLength: data.length, ContentType: contentType }),
    );
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as Error).name === "NotFound" || (err as Error).name === "NoSuchKey") return null;
      throw err;
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    );
    return res.Body as Readable;
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    const stream = await this.getStream(key);
    await pipeline(stream, fs.createWriteStream(filePath));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }),
      );
      const objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (objects.length > 0) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects, Quiet: true } }));
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!res.UploadId) throw new Error("Хранилище не вернуло идентификатор загрузки");
    return res.UploadId;
  }

  async uploadPart(key: string, uploadId: string, n: number, data: Buffer): Promise<string> {
    const res = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: n,
        Body: data,
        ContentLength: data.length,
      }),
    );
    if (!res.ETag) throw new Error("Хранилище не вернуло ETag части");
    return res.ETag;
  }

  async completeMultipart(key: string, uploadId: string, parts: StoredPart[]): Promise<number> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts].sort((a, b) => a.n - b.n).map((p) => ({ PartNumber: p.n, ETag: p.etag })),
        },
      }),
    );
    return parts.reduce((sum, p) => sum + p.size, 0);
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
  }
}

// ── Фабрика ──────────────────────────────────────────────────

const g = globalThis as unknown as { __flashStorage?: Promise<StorageDriver> };

export function storage(): Promise<StorageDriver> {
  if (!g.__flashStorage) {
    g.__flashStorage = (async () => {
      const driver: StorageDriver = env.storageDriver === "s3" ? new S3Storage() : new LocalStorage(env.storageLocalDir);
      await driver.init();
      return driver;
    })();
    // Неудачная инициализация не должна «залипнуть» навсегда.
    g.__flashStorage.catch(() => {
      g.__flashStorage = undefined;
    });
  }
  return g.__flashStorage;
}

export function contentTypeForKey(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "m4a":
      return "audio/mp4";
    default:
      return "application/octet-stream";
  }
}

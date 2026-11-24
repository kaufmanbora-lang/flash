// Чтение исходных видео для монтажа: кадры и звук прямо из файла момента, без перекодирования заранее.
// Файл читается кусками с диска — в память он целиком не попадает.

import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  Input,
  VideoSampleSink,
  type AudioSample,
  type InputAudioTrack,
  type InputVideoTrack,
  type VideoSample,
} from "mediabunny";
import { Resampler, SampleQueue, type AudioReader } from "./audio";
import { SAMPLE_RATE } from "./styles";

export interface ClipSource {
  input: Input;
  video: InputVideoTrack;
  audio: InputAudioTrack | null;
  /** Отметка времени первого кадра в файле (у записей с телефона она не всегда равна нулю). */
  origin: number;
  width: number;
  height: number;
  dispose(): void;
}

/**
 * Открывает видео момента. Возвращает null, если браузер не может декодировать его
 * (например, HEVC на устройстве без такого декодера) — такой момент в фильм не попадёт.
 */
export async function openClip(blob: Blob): Promise<ClipSource | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || !(await video.canDecode())) {
      input.dispose();
      return null;
    }
    let audio = await input.getPrimaryAudioTrack().catch(() => null);
    if (audio && !(await audio.canDecode().catch(() => false))) audio = null;
    const origin = await video.getFirstTimestamp();
    const [width, height] = await Promise.all([video.getDisplayWidth(), video.getDisplayHeight()]);
    return { input, video, audio, origin, width, height, dispose: () => input.dispose() };
  } catch {
    input.dispose();
    return null;
  }
}

/** Отдаёт кадр, который должен быть на экране в заданный момент отрезка. Читать нужно по возрастанию времени. */
export class FrameReader {
  private readonly iterator: AsyncGenerator<VideoSample, void, unknown>;
  private current: VideoSample | null = null;
  private upcoming: VideoSample | null = null;
  private ended = false;

  constructor(
    private readonly source: ClipSource,
    private readonly startSec: number,
    durationSec: number,
  ) {
    const from = source.origin + startSec;
    this.iterator = new VideoSampleSink(source.video).samples(from, from + durationSec + 0.5);
  }

  /** Кадр для времени t (секунды от начала отрезка). Если видео кончилось раньше, остаётся последний кадр. */
  async frameAt(t: number): Promise<VideoSample | null> {
    const target = this.source.origin + this.startSec + t + 1e-4;
    for (;;) {
      if (!this.upcoming && !this.ended) {
        const step = await this.iterator.next();
        if (step.done) this.ended = true;
        else this.upcoming = step.value;
      }
      if (this.upcoming && (!this.current || this.upcoming.timestamp <= target)) {
        this.current?.close();
        this.current = this.upcoming;
        this.upcoming = null;
        continue;
      }
      return this.current;
    }
  }

  close(): void {
    this.current?.close();
    this.upcoming?.close();
    this.current = null;
    this.upcoming = null;
    this.ended = true;
    void this.iterator.return().catch(() => {});
  }
}

/** Звук дорожки, приведённый к 48 кГц стерео; читается подряд от заданного места файла. */
export class TrackAudioReader implements AudioReader {
  private readonly iterator: AsyncGenerator<AudioSample, void, unknown>;
  private readonly queue = new SampleQueue();
  private resampler: Resampler | null = null;
  private ended = false;

  /**
   * @param baseTimestamp — отметка времени в файле, соответствующая началу отрезка
   * @param durationSec — длина отрезка
   */
  constructor(
    track: InputAudioTrack,
    private readonly baseTimestamp: number,
    durationSec: number,
    private readonly onClose?: () => void,
  ) {
    this.iterator = new AudioSampleSink(track).samples(baseTimestamp, baseTimestamp + durationSec + 0.25);
  }

  async read(outL: Float32Array, outR: Float32Array, count: number): Promise<void> {
    while (this.queue.buffered < count && !this.ended) await this.pump();
    const got = this.queue.pull(outL, outR, count);
    if (got < count) {
      outL.fill(0, got, count);
      outR.fill(0, got, count);
    }
  }

  private async pump(): Promise<void> {
    let step: IteratorResult<AudioSample, void>;
    try {
      step = await this.iterator.next();
    } catch {
      // Битый звук не должен срывать весь фильм: остаток отрезка будет тишиной.
      this.ended = true;
      return;
    }
    if (step.done) {
      this.ended = true;
      return;
    }
    const sample = step.value;
    try {
      const frames = sample.numberOfFrames;
      if (frames === 0) return;
      const left = new Float32Array(frames);
      sample.copyTo(left, { planeIndex: 0, format: "f32-planar" });
      let right = left;
      if (sample.numberOfChannels >= 2) {
        right = new Float32Array(frames);
        sample.copyTo(right, { planeIndex: 1, format: "f32-planar" });
      }
      this.resampler ??= new Resampler(sample.sampleRate);
      const [l, r] = this.resampler.process(left, right);
      this.queue.push(l, r, (sample.timestamp - this.baseTimestamp) * SAMPLE_RATE);
    } finally {
      sample.close();
    }
  }

  close(): void {
    this.ended = true;
    void this.iterator.return().catch(() => {});
    this.onClose?.();
  }
}

/** Открывает звуковой файл (композицию из музыкальной библиотеки) как источник для сведения. */
export async function openMusic(blob: Blob, durationSec: number): Promise<AudioReader | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) {
      input.dispose();
      return null;
    }
    const origin = await track.getFirstTimestamp();
    return new TrackAudioReader(track, Math.max(0, origin), durationSec, () => input.dispose());
  } catch {
    input.dispose();
    return null;
  }
}

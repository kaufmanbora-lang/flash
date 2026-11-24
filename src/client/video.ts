// Работа с видео в браузере: параметры файла, кадр для превью, выбор формата записи.

export interface VideoMeta {
  durationMs: number;
  width: number;
  height: number;
  poster: Blob | null;
}

function once(target: EventTarget, events: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      events.forEach((e) => target.removeEventListener(e, handler));
    };
    const handler = (event: Event) => {
      cleanup();
      resolve(event.type);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    events.forEach((e) => target.addEventListener(e, handler));
  });
}

/**
 * Читает длительность и размеры видео и снимает кадр для превью.
 * Не падает на «трудных» файлах: чего не удалось узнать, вернётся нулём, а сервер проверит сам.
 */
export async function readVideoMeta(blob: Blob, knownDurationMs = 0): Promise<VideoMeta> {
  const meta: VideoMeta = { durationMs: knownDurationMs, width: 0, height: 0, poster: null };
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    const first = await once(video, ["loadedmetadata", "error"], 8000);
    if (first === "error") return meta;
    meta.width = video.videoWidth;
    meta.height = video.videoHeight;

    let duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      // WebM из MediaRecorder без длительности: перемотка «в бесконечность» заставляет браузер её вычислить.
      try {
        video.currentTime = 1e101;
        await once(video, ["durationchange", "seeked", "error"], 4000);
        duration = video.duration;
      } catch {
        /* останется известная по таймеру длительность */
      }
    }
    if (Number.isFinite(duration) && duration > 0 && !knownDurationMs) meta.durationMs = Math.round(duration * 1000);

    try {
      const at = Math.min(0.6, Math.max(0.05, (Number.isFinite(duration) ? duration : 1) * 0.1));
      video.currentTime = at;
      await once(video, ["seeked", "error"], 5000);
      if (video.readyState < 2) await once(video, ["loadeddata", "canplay", "error"], 4000).catch(() => {});
      const maxSide = 720;
      const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        meta.poster = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
      }
    } catch {
      /* превью появится после обработки на сервере */
    }
    return meta;
  } catch {
    return meta;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Формат записи: MP4 (H.264 + AAC) там, где браузер его умеет (Safari на iPhone, новые Chrome),
 * иначе WebM. Сервер в любом случае сделает версию, которая играет везде.
 */
export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export type CameraFailure =
  | "insecure"
  | "unsupported"
  | "denied"
  | "notfound"
  | "busy"
  | "unknown";

export function classifyCameraError(err: unknown): CameraFailure {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "notfound";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "unknown";
}

/** Камера работает только на https (или localhost). */
export function cameraAvailability(): CameraFailure | null {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return "unsupported";
  return null;
}

export async function openCamera(facing: "user" | "environment"): Promise<MediaStream> {
  const audio: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };
  const attempts: MediaStreamConstraints[] = [
    {
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio,
    },
    { video: { facingMode: { ideal: facing } }, audio: true },
    { video: true, audio: true },
    // Микрофон недоступен — лучше записать без звука, чем не записать вовсе.
    { video: { facingMode: { ideal: facing } }, audio: false },
  ];
  let lastErr: unknown;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
      // Отказ в разрешении повторять бессмысленно.
      if (classifyCameraError(err) === "denied" && constraints.audio !== false) {
        const camOnly = await navigator.mediaDevices
          .getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false })
          .catch(() => null);
        if (camOnly) return camOnly;
        throw err;
      }
    }
  }
  throw lastErr;
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* уже остановлена */
    }
  });
}

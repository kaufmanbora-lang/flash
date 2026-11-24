// План фильма, звук и вспомогательные форматы (ZIP, календарь): чистая логика без браузера.

import { describe, expect, it } from "vitest";
import { buildReminderCalendar } from "@/local/calendar";
import { choosePlaylist, type MusicTrack } from "@/local/music";
import { Ducker, Envelope, Limiter, Mixer, Resampler, SampleQueue, layoutMusic, type AudioReader } from "@/local/render/audio";
import { chooseCanvas, lowerCanvas, planFilm, type PlanFilm, type PlanMoment } from "@/local/render/plan";
import { FPS, SAMPLE_RATE, STYLES, rotateStyle } from "@/local/render/styles";
import type { ProjectRec } from "@/local/store";
import { ZipBuilder, crc32Update, readZip } from "@/local/zip";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { noteMatches, normalizeSearchText, parseDateQuery } from "@/lib/search";

const m = (id: string, date: string, time: string, sec = 12, w = 720, h = 1280): PlanMoment => ({
  id,
  date,
  time,
  durationMs: sec * 1000,
  width: w,
  height: h,
  analysis: null,
});

const film = (over: Partial<PlanFilm> = {}): PlanFilm => ({
  kind: "day",
  variant: "full",
  title: "24 ноября 2026",
  subtitle: "Вторник",
  dateFrom: "2026-11-24",
  dateTo: "2026-11-24",
  orientation: "auto",
  resolution: "auto",
  ...over,
});

describe("план фильма", () => {
  it("фильм дня: вступление, клипы со временем, финал", () => {
    const moments = [m("a", "2026-11-24", "09:10"), m("b", "2026-11-24", "14:32", 20)];
    const plan = planFilm({ film: film(), moments, project: null, styleId: "minimal", size: { W: 720, H: 1280 }, userName: "Алекс", locale: "ru" });
    expect(plan.elements.map((e) => e.kind)).toEqual(["card", "clip", "clip", "card"]);
    const intro = plan.elements[0];
    expect(intro.kind === "card" && intro.lines.map((l) => l.text)).toEqual(["", "24 ноября 2026", "Вторник", "A little piece of my life."]);
    const clip = plan.elements[1];
    expect(clip.kind === "clip" && clip.label).toEqual({ primary: "09:10", stamp: "24.11.2026  09:10" });
    expect(clip.kind === "clip" && clip.frames).toBe(12 * FPS);
    // Внутри дня — короткое растворение, между титрами и клипами — переход «через цвет».
    expect(plan.transitions.map((t) => t.type)).toEqual(["fadewhite", "fade", "fadewhite"]);
    const sum = plan.elements.reduce((s, e) => s + e.frames, 0) - plan.transitions.reduce((s, t) => s + t.frames, 0);
    expect(plan.totalFrames).toBe(sum);
    expect(plan.starts[0]).toBe(0);
    expect(plan.starts[1]).toBe(108 - 27);
    expect(plan.chapters).toEqual([]);
    expect(plan.posterFrame).toBeGreaterThan(plan.starts[1]);
    expect(plan.posterFrame).toBeLessThan(plan.starts[2]);
  });

  it("несколько дней: подпись с датой у первого клипа дня и оглавление", () => {
    const moments = [m("a", "2026-11-20", "10:15"), m("b", "2026-11-20", "18:40"), m("c", "2026-11-21", "12:05")];
    const plan = planFilm({
      film: film({ kind: "custom", title: "20–21 ноября 2026", subtitle: "Период", dateFrom: "2026-11-20", dateTo: "2026-11-21" }),
      moments,
      project: null,
      styleId: "cinematic",
      size: { W: 1920, H: 1080 },
      userName: "",
      locale: "ru",
    });
    const labels = plan.elements.filter((e) => e.kind === "clip").map((e) => (e.kind === "clip" ? (e.label?.primary ?? null) : null));
    expect(labels).toEqual(["20 ноября", null, "21 ноября"]);
    expect(plan.chapters.map((c) => c.title)).toEqual(["20 ноября", "21 ноября"]);
    expect(plan.barHeight).toBeGreaterThan(100); // полосы «кино» у горизонтального фильма
    expect(plan.transitions.map((t) => t.type)).toEqual(["fadeblack", "fade", "fadeblack", "fadeblack"]);
  });

  it("проект: название, период, титры с именем; трейлер короче и резче", () => {
    const moments = Array.from({ length: 12 }, (_, i) => m(`m${i}`, `2026-11-${10 + i}`, "12:00", 15));
    const project = { title: "Моё лето", description: "", startDate: "2026-11-10", endDate: "2026-11-21" };
    const base = { moments, project, styleId: "memories" as const, size: { W: 720, H: 1280 }, userName: "Алекс", locale: "ru" };
    const full = planFilm({ ...base, film: film({ kind: "project", title: "Моё лето", dateFrom: "2026-11-10", dateTo: "2026-11-21" }) });
    const outro = full.elements[full.elements.length - 1];
    expect(outro.kind === "card" && outro.lines.map((l) => l.text)).toEqual([
      "Конец",
      "Моё лето",
      "10–21 ноября 2026",
      "12 моментов · 3 мин · 12 дней",
      "Спасибо, что сохранил эти моменты.",
      "Снято и прожито: Алекс",
    ]);
    const trailer = planFilm({ ...base, film: film({ kind: "project", variant: "trailer", title: "Моё лето" }) });
    expect(trailer.totalFrames / FPS).toBeLessThan(70);
    expect(trailer.totalFrames / FPS).toBeGreaterThan(25);
    expect(Math.max(...trailer.transitions.map((t) => t.frames))).toBeLessThanOrEqual(15);
    // У каждого элемента остаётся хотя бы шесть собственных кадров.
    trailer.elements.forEach((e, i) => {
      const head = i > 0 ? trailer.transitions[i - 1].frames : 0;
      const tail = i < trailer.transitions.length ? trailer.transitions[i].frames : 0;
      expect(e.frames - head - tail).toBeGreaterThanOrEqual(6);
    });
  });

  it("размер кадра: ориентация по большинству, качество не выше исходного", () => {
    const portrait = [m("a", "2026-11-24", "10:00", 20, 1080, 1920), m("b", "2026-11-24", "11:00", 10, 1920, 1080)];
    expect(chooseCanvas({ orientation: "auto", resolution: "auto" }, portrait)).toEqual({ W: 1080, H: 1920 });
    expect(chooseCanvas({ orientation: "landscape", resolution: "auto" }, portrait)).toEqual({ W: 1920, H: 1080 });
    expect(chooseCanvas({ orientation: "auto", resolution: "2160" }, portrait)).toEqual({ W: 1080, H: 1920 });
    expect(chooseCanvas({ orientation: "auto", resolution: "auto" }, [m("a", "2026-11-24", "10:00", 10, 480, 854)])).toEqual({ W: 720, H: 1280 });
    expect(lowerCanvas({ W: 1080, H: 1920 })).toEqual({ W: 720, H: 1280 });
    expect(lowerCanvas({ W: 1280, H: 720 })).toBeNull();
  });

  it("стиль «Авто» чередуется, музыка не повторяется", () => {
    expect(rotateStyle([])).toBe("memories");
    expect(rotateStyle(["memories", "minimal"])).toBe("cinematic");
    expect(rotateStyle(["vintage", "clean", "cinematic", "minimal", "memories"])).toBe("memories");
    expect(Object.keys(STYLES)).toHaveLength(5);

    const library: MusicTrack[] = ["relaxing-piano", "nostalgia"].flatMap((style) =>
      [1, 2, 3].map((n) => ({ id: `${style}-${n}`, style: style as MusicTrack["style"], title: `${style} ${n}`, file: `${style}-${n}.m4a`, durationSec: 100 })),
    );
    expect(choosePlaylist(library, [], "film-1", "none", 60)).toEqual([]);
    const short = choosePlaylist(library, [], "film-1", "nostalgia", 60);
    expect(short).toHaveLength(1);
    expect(short[0].style).toBe("nostalgia");
    const long = choosePlaylist(library, [], "film-1", "nostalgia", 250);
    expect(long).toHaveLength(3);
    expect(new Set(long.map((t) => t.id)).size).toBe(3);
    // «Авто» выбирает стиль, который не звучал, и трек, которого не было.
    const auto = choosePlaylist(library, [["nostalgia-1"], ["nostalgia-2"]], "film-2", "auto", 60);
    expect(auto[0].style).toBe("relaxing-piano");
    const fresh = choosePlaylist(library, [["nostalgia-1"], ["nostalgia-2"]], "film-2", "nostalgia", 60);
    expect(fresh[0].id).toBe("nostalgia-3");
  });
});

describe("звук", () => {
  it("огибающая и расстановка музыки", () => {
    const env = new Envelope([
      [0, 0],
      [100, 1],
      [200, 1],
      [300, 0],
    ]);
    expect([0, 50, 100, 150, 250, 300, 400].map((x) => +env.at(x).toFixed(2))).toEqual([0, 0.5, 1, 1, 0.5, 0, 0]);
    const laid = layoutMusic([{ durationSec: 10 }, { durationSec: 10 }, { durationSec: 10 }], 15 * SAMPLE_RATE, 4 * SAMPLE_RATE);
    expect(laid.map((x) => x.start / SAMPLE_RATE)).toEqual([0, 6, 12]);
  });

  it("пересчёт 44,1 → 48 кГц сохраняет длину и непрерывность синуса", () => {
    const rate = 44_100;
    const resampler = new Resampler(rate);
    const tone = (i: number) => Math.sin((2 * Math.PI * 440 * i) / rate);
    let produced = 0;
    let worst = 0;
    for (let chunk = 0; chunk < 40; chunk++) {
      const input = Float32Array.from({ length: 1024 }, (_, i) => tone(chunk * 1024 + i));
      const [out] = resampler.process(input, input);
      for (let i = 0; i < out.length; i++) {
        const expected = Math.sin((2 * Math.PI * 440 * (produced + i)) / SAMPLE_RATE);
        worst = Math.max(worst, Math.abs(out[i] - expected));
      }
      produced += out.length;
    }
    expect(Math.abs(produced - (40 * 1024 * SAMPLE_RATE) / rate)).toBeLessThan(2);
    expect(worst).toBeLessThan(0.02);
    const same = new Resampler(SAMPLE_RATE);
    const data = new Float32Array([1, 2, 3]);
    expect(same.process(data, data)[0]).toBe(data);
  });

  it("очередь сэмплов: пропуск заполняется тишиной, лишнее начало отрезается", () => {
    const q = new SampleQueue();
    const ones = (n: number) => new Float32Array(n).fill(1);
    q.push(ones(1000), ones(1000), -400); // начинается раньше отрезка, но в пределах допуска
    q.push(ones(1000), ones(1000), 3000); // пропуск в 2000 сэмплов
    const out = new Float32Array(4000);
    expect(q.pull(out, new Float32Array(4000), 4000)).toBe(4000);
    expect(out[0]).toBe(1);
    expect(out[999]).toBe(1);
    expect(out[1500]).toBe(0);
    expect(out[3500]).toBe(1);
    const late = new SampleQueue();
    late.push(ones(48_000), ones(48_000), -24_000); // полсекунды до начала отрезка отбрасывается
    expect(late.buffered).toBe(24_000);
  });

  it("музыка уступает речи и возвращается; пики ограничены", () => {
    const ducker = new Ducker();
    let gain = 1;
    for (let i = 0; i < SAMPLE_RATE; i++) {
      gain = ducker.next(0.4 * Math.sin((2 * Math.PI * 600 * i) / SAMPLE_RATE));
      if ((i & 7) === 0) ducker.update();
    }
    expect(gain).toBeLessThan(0.2);
    for (let i = 0; i < SAMPLE_RATE * 4; i++) {
      gain = ducker.next(0);
      if ((i & 7) === 0) ducker.update();
    }
    expect(gain).toBeGreaterThan(0.95);
    // Низкий гул вне полосы голоса музыку не приглушает.
    const hum = new Ducker();
    for (let i = 0; i < SAMPLE_RATE; i++) {
      gain = hum.next(0.1 * Math.sin((2 * Math.PI * 40 * i) / SAMPLE_RATE));
      if ((i & 7) === 0) hum.update();
    }
    expect(gain).toBeGreaterThan(0.95);

    const left = Float32Array.from({ length: 2000 }, (_, i) => (i % 500 === 0 ? 1.8 : 0.3));
    const right = left.slice();
    new Limiter().process(left, right);
    expect(Math.max(...left.map(Math.abs))).toBeLessThanOrEqual(0.95 + 1e-6);
  });

  it("сведение: клип на своём месте, плавные края, затухание в конце", async () => {
    const constant = (value: number): AudioReader => ({
      async read(l, r, n) {
        l.fill(value, 0, n);
        r.fill(value, 0, n);
      },
      close() {},
    });
    const sec = SAMPLE_RATE;
    const mixer = new Mixer({
      totalSamples: 10 * sec,
      clips: [{ start: 2 * sec, length: 4 * sec, fadeIn: sec / 2, fadeOut: sec / 2, open: async () => constant(0.2) }],
      music: [{ start: 0, length: 10 * sec, open: async () => constant(0.5) }],
      musicVolume: 0.5,
      crossfade: 4 * sec,
    });
    const left = new Float32Array(10 * sec);
    let at = 0;
    while (!mixer.done) {
      const block = await mixer.next(sec / 2);
      left.set(block.left, at);
      at += block.left.length;
    }
    expect(at).toBe(10 * sec);
    const musicGain = 1.2 * Math.pow(0.5, 1.5) * 0.5;
    expect(left[0]).toBe(0); // музыка входит плавно
    expect(left[1.8 * sec]).toBeCloseTo(musicGain, 2); // только музыка
    expect(left[2 * sec + 100]).toBeLessThan(musicGain + 0.02); // клип только начал входить
    expect(left[4 * sec]).toBeGreaterThan(0.2); // клип целиком + музыка
    expect(left[4 * sec]).toBeLessThan(0.2 + musicGain + 0.01);
    expect(left[10 * sec - 1]).toBeLessThan(0.01); // общий уход в тишину
    mixer.close();
  });
});

describe("архив и календарь", () => {
  it("ZIP: контрольная сумма и чтение обратно", async () => {
    expect(crc32Update(0, new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const zip = new ZipBuilder();
    expect(zip.uniqueName("moments/2026-11-24/10-00", "mp4")).toBe("moments/2026-11-24/10-00.mp4");
    expect(zip.uniqueName("moments/2026-11-24/10-00", "mp4")).toBe("moments/2026-11-24/10-00 (2).mp4");
    const first = new Blob([new Uint8Array(5000).fill(3)]);
    await zip.add("moments/2026-11-24/10-00.mp4", first, new Date(2026, 10, 24, 10, 0));
    await zip.add("фильмы/Моё лето — full.mp4", new Blob(["film"]), new Date());
    await zip.add("flash.json", new Blob(['{"app":"Flash"}']), new Date());
    const files = await readZip(zip.finish());
    expect(files.map((f) => [f.path, f.size])).toEqual([
      ["moments/2026-11-24/10-00.mp4", 5000],
      ["фильмы/Моё лето — full.mp4", 4],
      ["flash.json", 15],
    ]);
    expect(await (await files[2].blob()).text()).toBe('{"app":"Flash"}');
    expect(new Uint8Array(await (await files[0].blob()).arrayBuffer())[4999]).toBe(3);
    await expect(readZip(new Blob(["not a zip at all"]))).rejects.toThrow();
  });

  it("календарь напоминаний: события по расписанию, тексты про проект", () => {
    const settings = { ...DEFAULT_SETTINGS.notifications, mode: "fixed" as const, fixedTimes: ["10:00", "20:00", "23:30"] };
    const project: ProjectRec = {
      id: "p1",
      title: "30 дней",
      description: "",
      periodKind: "d30",
      startDate: "2026-11-24",
      endDate: "2026-12-23",
      status: "active",
      pauses: [],
      completedAt: null,
      coverKind: "auto",
      coverPreset: "mint",
      coverMomentId: null,
      coverBytes: 0,
      filmSettings: {},
      createdAt: "2026-11-24T08:00:00.000Z",
      updatedAt: "2026-11-24T08:00:00.000Z",
    };
    const cal = buildReminderCalendar(settings, "2026-11-24", [project], "ru", "https://example.org/flash/", new Date("2026-11-24T08:00:00Z"));
    // 23:30 попадает в тихие часы (22:30–08:00) и пропускается.
    expect(cal.events).toBe(90 * 2);
    expect(cal.until).toBe("2027-02-21");
    expect(cal.ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    // Длинные строки в файле перенесены по стандарту; для проверки текста склеиваем их обратно.
    const text = cal.ics.split(String.fromCharCode(13, 10) + " ").join("");
    expect(text).toContain("UID:flash-2026-11-24-0@flash.diary");
    expect(text).toContain("DTSTART:20261124T100000");
    expect(text).toContain("День 1 из 30");
    expect(text).toContain("Сегодня последний день твоего проекта!");
    expect(text).toContain("TRIGGER:PT0S");
    for (const line of cal.ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
});

describe("поиск", () => {
  it("разбор даты в запросе", () => {
    expect(parseDateQuery("23.11.2026")).toEqual({ from: "2026-11-23", to: "2026-11-23" });
    expect(parseDateQuery("2026-11")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(parseDateQuery("02.2028")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(parseDateQuery("2025")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(parseDateQuery("23 ноября")).toEqual({ month: 11, day: 23 });
    expect(parseDateQuery("Ноябрь")).toEqual({ month: 11, day: undefined });
    expect(parseDateQuery("23 ноября 2026")).toEqual({ from: "2026-11-23", to: "2026-11-23" });
    expect(parseDateQuery("31.02.2026")).toBeNull();
    expect(parseDateQuery("море")).toBeNull();
  });

  it("слова заметки находятся в разных формах и регистре", () => {
    const note = normalizeSearchText("Прогулка у МОРЯ с Ёжиком");
    expect(noteMatches(note, normalizeSearchText("море"))).toBe(true);
    expect(noteMatches(note, normalizeSearchText("ежик"))).toBe(true);
    expect(noteMatches(note, normalizeSearchText("прогулки море"))).toBe(true);
    expect(noteMatches(note, normalizeSearchText("горы"))).toBe(false);
    expect(noteMatches("", normalizeSearchText("море"))).toBe(false);
  });
});

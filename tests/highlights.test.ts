import { describe, expect, it } from "vitest";
import { VARIANT_TARGETS } from "@/lib/constants";
import { bestWindow, selectSegments, type ClipInput } from "@/lib/highlights";

function clip(id: string, durationSec: number, loudFrom = -1, loudTo = -1): ClipInput {
  const n = Math.ceil(durationSec);
  return {
    id,
    durationSec,
    analysis: {
      energy: Array.from({ length: n }, (_, i) => (i >= loudFrom && i < loudTo ? -14 : -58)),
      motion: Array.from({ length: n }, () => 0.02),
    },
  };
}

const sum = (list: { duration: number }[]) => list.reduce((s, x) => s + x.duration, 0);

describe("выбор фрагментов", () => {
  it("если материала меньше цели — берёт всё целиком", () => {
    const clips = [clip("a", 12), clip("b", 15)];
    const out = selectSegments(clips, { target: 48, minSeg: 2.4, maxSeg: 5 });
    expect(out).toEqual([
      { id: "a", start: 0, duration: 12 },
      { id: "b", start: 0, duration: 15 },
    ]);
  });

  it("укладывается в целевую длительность и не выходит за границы моментов", () => {
    const clips = Array.from({ length: 12 }, (_, i) => clip(`c${i}`, 20 + i));
    const cfg = { target: 60, minSeg: 3, maxSeg: 9 };
    const out = selectSegments(clips, cfg);
    expect(out).toHaveLength(12);
    expect(sum(out)).toBeGreaterThan(50);
    expect(sum(out)).toBeLessThan(70);
    for (const seg of out) {
      const source = clips.find((c) => c.id === seg.id)!;
      expect(seg.duration).toBeGreaterThanOrEqual(cfg.minSeg - 0.05);
      expect(seg.duration).toBeLessThanOrEqual(cfg.maxSeg + 0.05);
      expect(seg.start).toBeGreaterThanOrEqual(0);
      expect(seg.start + seg.duration).toBeLessThanOrEqual(source.durationSec + 0.05);
    }
  });

  it("при избытке моментов оставляет равномерную выборку в хронологическом порядке", () => {
    // 86 моментов, как в 30-дневном проекте: в трейлер попадает только часть.
    const clips = Array.from({ length: 86 }, (_, i) => clip(`m${String(i).padStart(2, "0")}`, 30));
    const cfg = VARIANT_TARGETS.trailer;
    const out = selectSegments(clips, cfg);
    expect(out.length).toBe(Math.floor(cfg.target / cfg.minSeg));
    const ids = out.map((s) => s.id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    // Есть и начало, и конец истории.
    expect(Number(ids[0].slice(1))).toBeLessThan(6);
    expect(Number(ids[ids.length - 1].slice(1))).toBeGreaterThan(79);
    expect(sum(out)).toBeGreaterThanOrEqual(30);
    expect(sum(out)).toBeLessThanOrEqual(60);
  });

  it("выбирает отрезок, где звучит речь", () => {
    const talk = clip("talk", 40, 22, 30);
    const { start } = bestWindow(talk, 6);
    expect(start).toBeGreaterThanOrEqual(21);
    expect(start).toBeLessThanOrEqual(25);
  });

  it("предпочитает моменты со звуком тихим моментам", () => {
    const clips = Array.from({ length: 40 }, (_, i) => (i % 4 === 2 ? clip(`c${String(i).padStart(2, "0")}`, 30, 5, 20) : clip(`c${String(i).padStart(2, "0")}`, 30)));
    const out = selectSegments(clips, { target: 30, minSeg: 3, maxSeg: 5 });
    expect(out).toHaveLength(10);
    // В каждой четвёрке есть один «громкий» момент — выбирается именно он.
    expect(out.every((s) => Number(s.id.slice(1)) % 4 === 2)).toBe(true);
  });

  it("работает без анализа видео", () => {
    const clips: ClipInput[] = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, durationSec: 25, analysis: null }));
    const out = selectSegments(clips, VARIANT_TARGETS.highlights);
    expect(out.length).toBeGreaterThan(0);
    for (const seg of out) expect(seg.start + seg.duration).toBeLessThanOrEqual(25.05);
  });

  it("пустой список не ломает алгоритм", () => {
    expect(selectSegments([], { target: 60, minSeg: 3, maxSeg: 9 })).toEqual([]);
  });
});

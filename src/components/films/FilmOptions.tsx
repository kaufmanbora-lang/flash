"use client";

import clsx from "clsx";
import { Check, Music2, Pause, Play, Shuffle, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import useSWR from "swr";
import { fetcher } from "@/client/api";
import { haptic } from "@/client/haptics";
import { useT } from "@/client/i18n";
import { Segmented } from "@/components/ui/Controls";
import {
  FILM_STYLE_NAMES,
  FILM_STYLES,
  MUSIC_STYLE_NAMES,
  MUSIC_STYLES,
  type FilmStyleId,
  type MusicStyleId,
  type Orientation,
  type Resolution,
} from "@/lib/constants";
import type { FilmOptions, MusicTrackDto } from "@/lib/types";

/** Миниатюры стилей: маленькая «заставка» в цветах каждого оформления. */
const STYLE_PREVIEW: Record<FilmStyleId | "auto", { bg: string; ink: string; accent: string; bars?: boolean; frame?: boolean }> = {
  auto: { bg: "conic-gradient(from 210deg, #f8faf5, #e2f2d0, #f6efe3, #dfe8d6, #f8faf5)", ink: "#20301e", accent: "#8bc65b" },
  minimal: { bg: "radial-gradient(120% 90% at 100% 0%, #d9efbb 0%, #f8faf5 60%)", ink: "#20301e", accent: "#8bc65b" },
  cinematic: { bg: "linear-gradient(160deg, #26331f 0%, #0d120c 70%)", ink: "#f6f3ea", accent: "#d9c9a0", bars: true },
  memories: { bg: "linear-gradient(160deg, #fbf3e4 0%, #edd9bd 100%)", ink: "#3a2e22", accent: "#c9a77a" },
  vintage: { bg: "radial-gradient(90% 80% at 50% 40%, #4a3927 0%, #241c14 100%)", ink: "#f2e3c6", accent: "#e0a85a", frame: true },
  clean: { bg: "radial-gradient(80% 70% at 100% 100%, #cfeaa9 0%, #ffffff 62%)", ink: "#1b2a19", accent: "#8bc65b" },
};

function StyleCard({ id, name, hint, selected, onSelect }: { id: FilmStyleId | "auto"; name: string; hint: string; selected: boolean; onSelect: () => void }) {
  const look = STYLE_PREVIEW[id];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => {
        haptic("light");
        onSelect();
      }}
      className="press w-[112px] shrink-0 snap-start text-left"
    >
      <span
        className={clsx(
          "relative block aspect-[4/5] overflow-hidden rounded-[20px] transition-shadow",
          selected ? "shadow-[0_0_0_3px_var(--color-leaf),0_12px_24px_-12px_rgb(62_116_32/0.5)]" : "shadow-[0_0_0_1px_rgb(32_48_30/0.1)]",
        )}
        style={{ background: look.bg }}
      >
        {look.bars && (
          <>
            <span className="absolute inset-x-0 top-0 h-[11%] bg-black" />
            <span className="absolute inset-x-0 bottom-0 h-[11%] bg-black" />
          </>
        )}
        {look.frame && <span className="absolute inset-[7%] rounded-[4px] border" style={{ borderColor: look.accent, opacity: 0.6 }} />}
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-2 text-center">
          <span className="h-[3px] w-5 rounded-full" style={{ background: look.accent }} />
          <span className="font-serif text-[19px] font-semibold leading-none" style={{ color: look.ink }}>
            {id === "auto" ? "Aa" : "23"}
          </span>
          <span className="h-[2px] w-9 rounded-full opacity-40" style={{ background: look.ink }} />
        </span>
        {selected && (
          <span className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-leaf text-white">
            <Check aria-hidden="true" size={14} strokeWidth={3} />
          </span>
        )}
      </span>
      <span className="mt-2 block px-0.5 text-[14px] font-semibold leading-tight">{name}</span>
      <span className="t-caption block px-0.5 text-[12px] leading-tight">{hint}</span>
    </button>
  );
}

/** Настройки оформления фильма: стиль монтажа, музыка с предпрослушиванием, громкость, кадр и качество. */
export function FilmOptionsFields({
  value,
  onChange,
  showFrame = true,
}: {
  value: FilmOptions;
  onChange: (patch: Partial<FilmOptions>) => void;
  showFrame?: boolean;
}) {
  const t = useT();
  const o = t.options;
  const { data } = useSWR<{ tracks: MusicTrackDto[] }>("/api/music", fetcher, { revalidateOnFocus: false });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const tracksOf = (style: MusicStyleId) => (data?.tracks ?? []).filter((tr) => tr.style === style);

  const togglePreview = (style: MusicStyleId) => {
    const tracks = tracksOf(style);
    if (tracks.length === 0) return;
    if (previewing === style) {
      audioRef.current?.pause();
      setPreviewing(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(tracks[Math.floor(Math.random() * tracks.length)].url);
    audio.volume = 0.8;
    audio.onended = () => setPreviewing(null);
    audio.onerror = () => setPreviewing(null);
    audioRef.current = audio;
    setPreviewing(style);
    void audio.play().catch(() => setPreviewing(null));
  };

  const musicRow = (
    key: FilmOptions["music"],
    title: string,
    hint: string,
    leading: ReactNode,
  ) => {
    const selected = value.music === key;
    return (
      <div key={key} className={clsx("flex items-center gap-1 rounded-[20px] pr-1.5 transition-colors", selected && "glass glass-tint")}>
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          onClick={() => {
            haptic("light");
            onChange({ music: key });
          }}
          className="press flex min-h-[58px] min-w-0 flex-1 items-center gap-3 rounded-[20px] px-3 text-left"
        >
          <span className={clsx("grid size-9 shrink-0 place-items-center rounded-full", selected ? "bg-white/70 text-leaf-deep" : "bg-lime-soft text-leaf-deep")}>
            {selected ? <Check aria-hidden="true" size={17} strokeWidth={2.6} /> : leading}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[15.5px] font-semibold leading-tight">{title}</span>
            <span className="t-caption block text-[12.5px] leading-snug">{hint}</span>
          </span>
        </button>
        {key !== "auto" && key !== "none" && tracksOf(key).length > 0 && (
          <button
            type="button"
            aria-label={previewing === key ? o.stopPreview : o.preview(title)}
            aria-pressed={previewing === key}
            onClick={() => togglePreview(key)}
            className="press grid size-11 shrink-0 place-items-center rounded-full bg-white/70 text-ink shadow-[inset_0_0_0_1px_rgb(32_48_30/0.08)]"
          >
            {previewing === key ? (
              <Pause aria-hidden="true" size={16} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play aria-hidden="true" size={16} fill="currentColor" strokeWidth={0} className="ml-0.5" />
            )}
          </button>
        )}
      </div>
    );
  };

  const noMusic = value.music === "none";
  const volumePct = Math.round(value.musicVolume * 100);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* min-w-0: у fieldset по умолчанию min-inline-size: min-content, и лента стилей растягивала бы весь блок. */}
      <fieldset className="min-w-0">
        <legend className="mb-2.5 text-[13.5px] font-semibold text-muted-strong">{o.style}</legend>
        <div role="radiogroup" aria-label={o.style} className="no-scrollbar -mx-5 flex snap-x gap-3 overflow-x-auto px-5 pb-1 pt-1">
          <StyleCard id="auto" name={o.styleAuto} hint={o.styleAutoHint} selected={value.style === "auto"} onSelect={() => onChange({ style: "auto" })} />
          {FILM_STYLES.map((id) => (
            <StyleCard key={id} id={id} name={FILM_STYLE_NAMES[id]} hint={o.styleHints[id]} selected={value.style === id} onSelect={() => onChange({ style: id })} />
          ))}
        </div>
      </fieldset>

      {/* min-w-0: у fieldset по умолчанию min-inline-size: min-content, и лента стилей растягивала бы весь блок. */}
      <fieldset className="min-w-0">
        <legend className="mb-2 text-[13.5px] font-semibold text-muted-strong">{o.music}</legend>
        <div role="radiogroup" aria-label={o.music} className="flex flex-col gap-0.5">
          {musicRow("auto", o.musicAuto, o.musicAutoHint, <Shuffle aria-hidden="true" size={17} />)}
          {musicRow("none", o.musicNone, o.musicNoneHint, <VolumeX aria-hidden="true" size={17} />)}
          {MUSIC_STYLES.map((id) =>
            musicRow(
              id,
              MUSIC_STYLE_NAMES[id],
              data ? (tracksOf(id).length > 0 ? o.tracks(tracksOf(id).length) : o.musicUnavailable) : "…",
              <Music2 aria-hidden="true" size={17} />,
            ),
          )}
        </div>
      </fieldset>

      <div className={clsx("transition-opacity", noMusic && "opacity-45")}>
        <div className="mb-1 flex items-baseline justify-between">
          <label htmlFor="music-volume" className="text-[13.5px] font-semibold text-muted-strong">
            {o.volume}
          </label>
          <span className="tabular text-[14px] font-semibold">{volumePct}%</span>
        </div>
        <input
          id="music-volume"
          type="range"
          min={0}
          max={100}
          step={5}
          disabled={noMusic}
          value={volumePct}
          onChange={(e) => onChange({ musicVolume: Number(e.target.value) / 100 })}
          className="slider"
          style={{ "--fill": `${volumePct}%` } as CSSProperties}
        />
        <p className="t-caption mt-1">{o.duckHint}</p>
      </div>

      {showFrame && (
        <>
          <div>
            <p className="mb-2 text-[13.5px] font-semibold text-muted-strong">{o.orientation}</p>
            <Segmented<Orientation>
              label={o.orientation}
              size="sm"
              value={value.orientation}
              onChange={(orientation) => onChange({ orientation })}
              options={[
                { value: "auto", label: o.orientationAuto },
                { value: "portrait", label: o.portrait },
                { value: "landscape", label: o.landscape },
              ]}
            />
          </div>
          <div>
            <p className="mb-2 text-[13.5px] font-semibold text-muted-strong">{o.quality}</p>
            <Segmented<Resolution>
              label={o.quality}
              size="sm"
              value={value.resolution}
              onChange={(resolution) => onChange({ resolution })}
              options={[
                { value: "auto", label: o.qualityAuto },
                { value: "720", label: "720p" },
                { value: "1080", label: "1080p" },
                { value: "1440", label: "2K" },
                { value: "2160", label: "4K" },
              ]}
            />
            <p className="t-caption mt-2">{o.qualityHint}</p>
          </div>
        </>
      )}
    </div>
  );
}

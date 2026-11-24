import type { MetadataRoute } from "next";
import { withBase } from "@/lib/base";

// Манифест — обычный статический файл в сборке.
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: withBase("/"),
    name: "Flash — дневник моментов",
    short_name: "Flash",
    description: "Приватный видеодневник: записывай маленькие моменты, а Flash соберёт из них фильм.",
    start_url: withBase("/"),
    scope: withBase("/"),
    display: "standalone",
    orientation: "portrait",
    background_color: "#F8FAF5",
    theme_color: "#F8FAF5",
    lang: "ru",
    dir: "ltr",
    categories: ["lifestyle", "photo", "productivity"],
    icons: [
      { src: withBase("/icons/icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: withBase("/icons/icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
      { src: withBase("/icons/icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Записать момент",
        short_name: "Запись",
        url: withBase("/record/"),
        icons: [{ src: withBase("/icons/icon-192.png"), sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Мои фильмы",
        short_name: "Фильмы",
        url: withBase("/films/"),
        icons: [{ src: withBase("/icons/icon-192.png"), sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Flash — дневник моментов",
    short_name: "Flash",
    description: "Приватный видеодневник: записывай маленькие моменты, а Flash соберёт из них фильм.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F8FAF5",
    theme_color: "#F8FAF5",
    lang: "ru",
    dir: "ltr",
    categories: ["lifestyle", "photo", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Записать момент",
        short_name: "Запись",
        url: "/record",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Мои фильмы",
        short_name: "Фильмы",
        url: "/films",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/onest";
import "@fontsource-variable/cormorant-garamond";
import "@fontsource-variable/cormorant-garamond/wght-italic.css";
import "./globals.css";
import { Providers } from "./providers";

/** Заставки для запуска с домашнего экрана iPhone (Android строит заставку сам из манифеста). */
const SPLASH: [number, number, number][] = [
  [440, 956, 3],
  [430, 932, 3],
  [402, 874, 3],
  [393, 852, 3],
  [428, 926, 3],
  [390, 844, 3],
  [375, 812, 3],
  [414, 896, 3],
  [414, 896, 2],
  [375, 667, 2],
];

export const metadata: Metadata = {
  title: { default: "Flash", template: "%s · Flash" },
  description: "Приватный видеодневник: записывай маленькие моменты, а Flash соберёт из них фильм.",
  applicationName: "Flash",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Flash",
    statusBarStyle: "default",
    startupImage: SPLASH.map(([w, h, r]) => ({
      url: `/splash/splash-${w * r}x${h * r}.png`,
      media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)`,
    })),
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  formatDetection: { telephone: false, date: false, address: false, email: false },
  // Дневник приватный: страницы не должны попадать в поиск.
  robots: { index: false, follow: false },
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F8FAF5",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      {/* Фон задан на <html>: у <body> его нет, чтобы не перекрывать фоновый слой с листвой. */}
      <body className="text-ink antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

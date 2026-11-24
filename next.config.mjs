// Flash собирается в набор статических файлов (папка out) и может лежать на любом статическом хостинге.
// На GitHub Pages сайт живёт в подпапке репозитория, поэтому путь задаётся переменной окружения:
//   NEXT_PUBLIC_BASE_PATH=/flash npm run build

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  basePath,
  // Каждая страница — папка с index.html: так адреса одинаково работают на любом статическом сервере.
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  // Значок Next.js в режиме разработки перекрывал бы плавающую навигацию.
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

// Запускается после next build. Готовит папку out к работе без сети и к публикации:
//   • precache.json — список всех файлов сборки, который Service Worker кладёт в кэш при установке;
//   • отпечаток сборки подставляется в sw.js — по нему браузер понимает, что вышло обновление;
//   • .nojekyll — чтобы GitHub Pages не пропускал папки с подчёркиванием (_next).

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const out = path.resolve(process.cwd(), "out");

async function walk(dir, base = "") {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = `${base}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walk(path.join(dir, entry.name), rel)));
    else files.push(rel);
  }
  return files;
}

// Музыка в предварительный кэш не входит: она большая и скачивается, когда нужна фильму.
// Заставки запуска нужны только системе в момент установки на экран «Домой».
const skip = (file) =>
  file === "/sw.js" ||
  file === "/precache.json" ||
  file === "/.nojekyll" ||
  file.startsWith("/splash/") ||
  (file.startsWith("/music/") && !file.endsWith(".json"));

const all = (await walk(out)).sort();
const files = all.filter((file) => !skip(file));
const hash = createHash("sha256");
let bytes = 0;
for (const file of files) {
  const data = await fs.readFile(path.join(out, file));
  hash.update(file).update(data);
  bytes += data.length;
}
const version = hash.digest("hex").slice(0, 16);

await fs.writeFile(path.join(out, "precache.json"), JSON.stringify({ version, files }));
const swPath = path.join(out, "sw.js");
const sw = await fs.readFile(swPath, "utf8");
if (!sw.includes("__BUILD_ID__")) throw new Error("В sw.js нет метки __BUILD_ID__");
await fs.writeFile(swPath, sw.replace("__BUILD_ID__", version));
await fs.writeFile(path.join(out, ".nojekyll"), "");

const music = all.filter((file) => file.startsWith("/music/") && file.endsWith(".m4a")).length;
console.log(
  `Сборка ${version}: ${files.length} файлов для работы без сети (${(bytes / 1024 / 1024).toFixed(1)} МБ), композиций: ${music}` +
    (music === 0 ? " — музыки нет, выполните npm run music перед сборкой" : ""),
);

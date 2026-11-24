// npm run music — создаёт музыкальную библиотеку (public/music), если её ещё нет.
// npm run music -- --force — пересоздаёт заново.
import { ensureMusicLibrary, generateMusicLibrary } from "@/music/generate";

const t0 = Date.now();
const force = process.argv.includes("--force");
const log = (m: string) => console.log(m);

(force ? generateMusicLibrary(log).then(() => true) : ensureMusicLibrary(log))
  .then((created) => {
    console.log(created ? `Готово за ${((Date.now() - t0) / 1000).toFixed(0)} с` : "Музыкальная библиотека уже на месте.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

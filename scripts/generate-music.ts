// npm run music — заново создаёт музыкальную библиотеку (assets/music).
import "@/lib/load-env";
import { generateMusicLibrary } from "@/music/generate";
import { killAllFfmpeg } from "@/worker/ffmpeg";

const t0 = Date.now();
generateMusicLibrary((m) => console.log(m))
  .then((tracks) => {
    console.log(`Готово: ${tracks.length} композиций за ${((Date.now() - t0) / 1000).toFixed(0)} с`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    killAllFfmpeg();
    process.exit(1);
  });

// npm run vapid — создаёт пару VAPID-ключей для Web Push.
// Вставьте вывод в .env. Если ключи не заданы, приложение создаст их само и сохранит в базе.
import * as webPushModule from "web-push";

type Api = { generateVAPIDKeys(): { publicKey: string; privateKey: string } };
const webpush = (webPushModule as unknown as { default?: Api }).default ?? (webPushModule as unknown as Api);

const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");

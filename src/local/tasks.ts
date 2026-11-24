// Фоновые дела, которым нужен браузер (canvas, декодер звука): анализ момента и обложка проекта.
// Сервисы данных только сообщают «пора», а саму работу подключает запуск приложения (boot.ts).
// В тестах подключения нет — сервисы остаются чистой логикой поверх хранилища.

export interface BackgroundTasks {
  /** Посчитать профиль громкости и движения момента (нужен для Highlights и трейлеров). */
  analyzeMoment(momentId: string): void;
  /** Пересобрать обложку проекта из кадров его моментов. */
  refreshCover(projectId: string): void;
}

const noop: BackgroundTasks = { analyzeMoment: () => {}, refreshCover: () => {} };

let current: BackgroundTasks = noop;

export function setBackgroundTasks(tasks: BackgroundTasks | null): void {
  current = tasks ?? noop;
}

export const background: BackgroundTasks = {
  analyzeMoment: (id) => current.analyzeMoment(id),
  refreshCover: (id) => current.refreshCover(id),
};

export function refreshCovers(projectIds: Iterable<string>): void {
  for (const id of new Set(projectIds)) background.refreshCover(id);
}

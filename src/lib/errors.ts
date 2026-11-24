/**
 * Ошибка с машинным кодом; интерфейс переводит код в понятный текст (словарь errors).
 * Числовой статус сохранён от серверной версии: 400 — неверный запрос, 404 — не найдено, 409 — конфликт.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = "",
    public data: Record<string, unknown> = {},
  ) {
    super(message || code);
    this.name = "ApiError";
  }
}

export const badRequest = (code: string, data?: Record<string, unknown>) => new ApiError(400, code, "", data);
export const notFound = (code = "not_found") => new ApiError(404, code);
export const conflict = (code: string, data?: Record<string, unknown>) => new ApiError(409, code, "", data);

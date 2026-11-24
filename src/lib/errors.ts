/** Ошибка с HTTP-статусом и машинным кодом; интерфейс переводит код в понятный текст. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

export const badRequest = (code: string, message?: string, extra?: Record<string, unknown>) =>
  new HttpError(400, code, message, extra);
export const unauthorized = () => new HttpError(401, "unauthorized");
export const forbidden = (code = "forbidden") => new HttpError(403, code);
export const notFound = (code = "not_found") => new HttpError(404, code);
export const conflict = (code: string, message?: string, extra?: Record<string, unknown>) =>
  new HttpError(409, code, message, extra);

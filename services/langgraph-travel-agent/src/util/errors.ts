/** Error carrying an HTTP status so the error middleware can map it directly. */
export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

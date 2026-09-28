export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** Structured, non-sensitive context returned to the client. */
    public details?: unknown,
  ) {
    super(message);
  }
}
export function ensure(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}

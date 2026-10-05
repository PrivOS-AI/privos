export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function usage(message: string): UsageError {
  return new UsageError(message);
}

export function isUsage(err: unknown): err is UsageError {
  return err instanceof UsageError;
}

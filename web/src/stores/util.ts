import { ApiError } from "../lib/api";

export function nowIso(): string {
  return new Date().toISOString();
}

/** Human-readable message for any thrown value, preferring protocol error codes. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.code ? `${e.code}: ${e.message}` : e.message;
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code !== e.message) return `${code}: ${e.message}`;
    return e.message;
  }
  return String(e);
}

export function errorCode(e: unknown): string | null {
  if (e instanceof ApiError) return e.code;
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

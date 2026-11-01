// Tiny structural validators used by the frame/message guards. No schema library needed.

export type JsonObject = Record<string, unknown>;

export function isRecord(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

export function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

/** Optional field: absent/undefined is fine, otherwise must satisfy `check`. */
export function opt<T>(v: unknown, check: (x: unknown) => x is T): v is T | undefined {
  return v === undefined || check(v);
}

export function isOneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return isString(v) && (values as readonly string[]).includes(v);
}

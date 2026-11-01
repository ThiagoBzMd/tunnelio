// Small formatting helpers (bytes, relative time, token stats). Locale-aware through Intl.

import type { ChatStats } from "../protocol/channel";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** n bytes → [number in words, unit] (decimal units, as Ollama shows them). */
function scaleBytes(n: number, locale: string): [string, string] {
  let v = n;
  let i = 0;
  while (v >= 1000 && i < BYTE_UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  return [v.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }), BYTE_UNITS[i] ?? "B"];
}

/**
 * Model quantities (parameters, download and disk sizes, video memory) are written the English way
 * in every language, "30.7B · 20.4 GB", as Ollama and its library write them.
 */
export const MODEL_LOCALE = "en-US";

export function formatBytes(n: number, locale = "en-US"): string {
  if (!Number.isFinite(n) || n < 0) return "–";
  const [v, unit] = scaleBytes(n, locale);
  return `${v} ${unit}`;
}

/** A download size, or a range of them ("6.6–9.5 GB", "800 MB–1.2 GB") when it depends on the computer. */
export function formatBytesRange(lo: number, hi: number, locale = "en-US"): string {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi <= lo) return formatBytes(lo, locale);
  const [a, unitA] = scaleBytes(lo, locale);
  const [b, unitB] = scaleBytes(hi, locale);
  if (a === b && unitA === unitB) return `${a} ${unitA}`;
  return unitA === unitB ? `${a}–${b} ${unitB}` : `${a} ${unitA}–${b} ${unitB}`;
}

const PARAM_SCALE: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/** Ollama's parameter count, tidied ("30.7B", "494.03M" → "494M", "9.0B" → "9B"); anything else as is. */
export function formatParams(raw: string | undefined): string {
  const m = /^(\d+(?:\.\d+)?)\s*([KMBT])$/i.exec((raw ?? "").trim());
  const scale = m ? PARAM_SCALE[(m[2] ?? "").toUpperCase()] : undefined;
  if (!m || !scale) return raw ?? "";
  return new Intl.NumberFormat(MODEL_LOCALE, { notation: "compact", maximumSignificantDigits: 3 }).format(Number(m[1]) * scale);
}

const REL_STEPS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 3600_000 },
  { unit: "month", ms: 30 * 24 * 3600_000 },
  { unit: "week", ms: 7 * 24 * 3600_000 },
  { unit: "day", ms: 24 * 3600_000 },
  { unit: "hour", ms: 3600_000 },
  { unit: "minute", ms: 60_000 },
];

/** "3 min ago", "yesterday", "in 2 hours" — or the raw string when it is not a date. */
export function relativeTime(iso: string | null | undefined, locale = "en-US", now: number = Date.now()): string {
  if (!iso) return "–";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diff = ts - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 45_000) return rtf.format(0, "second");
  for (const step of REL_STEPS) {
    if (abs >= step.ms || step.unit === "minute") return rtf.format(Math.round(diff / step.ms), step.unit);
  }
  return rtf.format(0, "second");
}

export function formatDateTime(iso: string | null | undefined, locale = "en-US"): string {
  if (!iso) return "–";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  return new Date(ts).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/** Nanoseconds → "1.2 s" / "340 ms". */
export function formatDurationNs(ns: number | undefined, locale = "en-US"): string {
  if (ns === undefined) return "–";
  const ms = ns / 1e6;
  if (ms < 1000) return `${ms.toLocaleString(locale, { maximumFractionDigits: 0 })} ms`;
  return `${(ms / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} s`;
}

export function tokensPerSecond(stats: ChatStats | undefined): number | null {
  if (!stats?.eval_count || !stats.eval_duration) return null;
  return stats.eval_count / (stats.eval_duration / 1e9);
}

/** Pairing code input: Crockford normalization (uppercase, I/L→1, O→0), 12 symbols, `XXXX-XXXX-XXXX`. */
export function formatPairingCode(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, "")
    .slice(0, 12);
  return cleaned.replace(/(.{4})(?=.)/g, "$1-");
}

export function isCompletePairingCode(formatted: string): boolean {
  return formatted.replace(/-/g, "").length === 12;
}

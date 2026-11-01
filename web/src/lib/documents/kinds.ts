// Which files the composer reads as documents (SPEC §7.7), and the input cap. DOM-free.

import type { DocumentKind } from "./format";

/** Input cap for one document file (the original never travels; only extracted text/pages). */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

const SHEET_EXT = ["xlsx", "xls", "ods", "csv"];
const TEXT_EXT = [
  "txt", "md", "markdown", "rst", "log", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "html", "htm", "css", "scss",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "pl", "lua", "r",
  "sh", "bash", "zsh", "ps1", "bat", "sql", "graphql", "proto", "dart", "scala", "clj", "ex", "exs", "erl", "hs", "vue", "svelte", "tex", "srt", "vtt",
];

/** `accept` for the attach input: images plus every document kind. */
export const DOCUMENT_ACCEPT = [
  ".pdf",
  ".docx",
  ...SHEET_EXT.map((e) => "." + e),
  ...TEXT_EXT.map((e) => "." + e),
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/*",
  "application/json",
].join(",");

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** `null` for files that are not documents (images are handled separately; anything else is refused). */
export function documentKindOf(file: { name: string; type: string }): DocumentKind | null {
  const ext = extension(file.name);
  const type = file.type.toLowerCase();
  if (ext === "pdf" || type === "application/pdf") return "pdf";
  if (ext === "docx" || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (SHEET_EXT.includes(ext)) return "sheet";
  if (type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || type === "application/vnd.ms-excel" || type === "application/vnd.oasis.opendocument.spreadsheet") {
    return "sheet";
  }
  if (TEXT_EXT.includes(ext)) return "text";
  if (type.startsWith("text/") || type === "application/json") return "text";
  return null;
}

export function isImageFile(file: { name: string; type: string }): boolean {
  return file.type.startsWith("image/");
}

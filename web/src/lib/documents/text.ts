// Plain text, Markdown, code, JSON: UTF-8 as is (BOM and CRLF normalised).

import { countWords } from "./format";
import { DocumentError, textOnly, type ExtractedDocument } from "./types";

export function extractText(bytes: Uint8Array, name: string): ExtractedDocument {
  let text = new TextDecoder("utf-8").decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // A NUL means binary content behind a text extension.
  if (text.includes("\u0000")) throw new DocumentError("E_UNREADABLE", "not a text file");
  text = text.replace(/\r\n?/g, "\n");
  if (!text.trim()) throw new DocumentError("E_EMPTY", "the file has no text");
  return textOnly(name, "text", text, { words: countWords(text) });
}

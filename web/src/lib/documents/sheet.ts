// Spreadsheets (.xlsx, .xls, .ods, .csv) through SheetJS: every sheet as CSV under its name.

import type * as XLSXNS from "xlsx";
import { DocumentError, textOnly, type ExtractedDocument } from "./types";

type XLSX = typeof XLSXNS;

export function extractSheet(bytes: Uint8Array, name: string, XLSX: XLSX): ExtractedDocument {
  let wb: XLSXNS.WorkBook;
  try {
    wb = XLSX.read(bytes, { type: "array", cellDates: true });
  } catch (e) {
    throw new DocumentError("E_UNREADABLE", e instanceof Error ? e.message : "unreadable spreadsheet");
  }
  const sections: string[] = [];
  let rows = 0;
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false, strip: true }).replace(/\n+$/, "");
    const lines = csv ? csv.split("\n").filter((l) => l.replace(/,/g, "").trim().length > 0) : [];
    rows += lines.length;
    sections.push(`## ${sheetName}\n${lines.join("\n")}`);
  }
  if (rows === 0) throw new DocumentError("E_EMPTY", "the spreadsheet is empty");
  return textOnly(name, "sheet", sections.join("\n\n"), { sheets: wb.SheetNames.length, rows });
}

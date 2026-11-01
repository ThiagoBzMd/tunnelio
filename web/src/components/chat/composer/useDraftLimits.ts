// What stops or warns before sending (SPEC §7.7): documents a model cannot see (a scanned PDF
// blocks, figures or some scanned pages only warn) and the model memory rule — the whole
// conversation plus this draft must fit the model (`lib/context`, the same estimate that sets
// `num_ctx` when the message is sent).

import { useMemo } from "react";
import { useT } from "@/i18n";
import { planContext, type ContextPlan } from "@/lib/context";
import { draftChars, draftIssues } from "@/lib/documents/compose";
import type { ExtractedDocument } from "@/lib/documents/types";

export interface DraftLimitsInput {
  text: string;
  /** Documents already read (drafts still being read do not count yet). */
  readyDocs: ExtractedDocument[];
  /** The selected model can see images: `null` while that is being checked. */
  vision: boolean | null;
  /** Characters of the conversation so far. */
  historyChars: number;
  /** `context_length` of the selected model, when known. */
  contextMax: number | null;
}

export interface DraftLimits {
  /** Message shown instead of sending; `null` when the draft may go. */
  blocked: string | null;
  warnings: string[];
  plan: ContextPlan;
}

export function useDraftLimits({ text, readyDocs, vision, historyChars, contextMax }: DraftLimitsInput): DraftLimits {
  const { t } = useT();
  const docsChars = useMemo(() => draftChars("", readyDocs), [readyDocs]);
  const issues = draftIssues(readyDocs, vision);
  const plan = planContext(historyChars + docsChars + (docsChars > 0 && text ? 2 : 0) + text.trim().length, contextMax);
  let blocked: string | null = null;
  if (issues.block) blocked = t("chat.docScannedBlock");
  else if (!plan.ok) blocked = readyDocs.length > 0 ? t("chat.tooLongDoc") : t("chat.tooLongChat");
  const warnings = issues.warnings.map((w) => (w === "figures_warn" ? t("chat.docFiguresWarn") : t("chat.docScannedWarn")));
  return { blocked, warnings, plan };
}

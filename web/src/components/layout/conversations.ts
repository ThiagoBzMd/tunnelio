// Sidebar data: conversations grouped by device (the tray keeps the history) and, inside each
// device, by date. Merged from the history lists and the in-memory chat store, with the loader
// that keeps them fresh. An offline device lists nothing: its conversations come back with it.

import { useEffect, useMemo, useRef } from "react";
import { chatStore } from "@/stores/chat";
import { historyStore } from "@/stores/history";
import { useChat, useDevices, useHistory } from "@/stores/react";

export interface ConvItem {
  id: string;
  title: string;
  updated_at: string;
  device_id: string;
}

export interface ConvGroup {
  key: string;
  /** Device name. */
  name: string;
  online: boolean;
  paired: boolean;
  loading: boolean;
  items: ConvItem[];
}

const byUpdatedDesc = (a: ConvItem, b: ConvItem) => b.updated_at.localeCompare(a.updated_at);

export function useConversationGroups(): ConvGroup[] {
  const conversations = useChat((s) => s.conversations);
  const privateByDevice = useHistory((s) => s.privateByDevice);
  const devices = useDevices((s) => s.devices);
  const order = useDevices((s) => s.order);

  return useMemo(() => {
    const groups: ConvGroup[] = [];
    const inMemory = Object.values(conversations).filter((c) => !c.incognito && c.messages.some((m) => m.role === "user"));
    for (const id of order) {
      const d = devices[id];
      if (!d) continue;
      const map = new Map<string, ConvItem>();
      if (d.online) {
        for (const c of privateByDevice[id]?.items ?? []) map.set(c.id, { id: c.id, title: c.title, updated_at: c.updated_at, device_id: id });
        for (const c of inMemory) {
          if (c.device_id === id) map.set(c.id, { id: c.id, title: c.title, updated_at: c.updated_at, device_id: id });
        }
      }
      const items = [...map.values()].sort(byUpdatedDesc);
      if (items.length > 0 || d.paired) {
        groups.push({ key: id, name: d.name, online: d.online, paired: d.paired, loading: privateByDevice[id]?.loading ?? false, items });
      }
    }
    return groups;
  }, [conversations, privateByDevice, devices, order]);
}

/** Loads the lists of paired online devices (again when a device comes back) and refreshes after each reply. */
export function useConversationLoader(): void {
  const devices = useDevices((s) => s.devices);
  const order = useDevices((s) => s.order);
  const streaming = useChat((s) => s.streaming);
  const requested = useRef(new Set<string>());
  const prevStreaming = useRef(streaming);

  useEffect(() => {
    for (const id of order) {
      const d = devices[id];
      if (!d?.paired) continue;
      if (!d.online) {
        requested.current.delete(id); // list again when it comes back
        continue;
      }
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      historyStore
        .getState()
        .listPrivate(id)
        .catch(() => requested.current.delete(id));
    }
  }, [devices, order]);

  useEffect(() => {
    const before = prevStreaming.current;
    prevStreaming.current = streaming;
    if (!before || streaming) return;
    const conv = chatStore.getState().conversations[before.conversation_id];
    if (!conv) return;
    historyStore
      .getState()
      .listPrivate(conv.device_id)
      .catch(() => undefined);
  }, [streaming]);
}

// ── date buckets and search (pure helpers, tested in tests/chat-ui.test.ts) ──────────────────

export type DateBucket = "today" | "yesterday" | "week" | "month" | "older";
export const DATE_BUCKETS: readonly DateBucket[] = ["today", "yesterday", "week", "month", "older"];

export interface ConvSection {
  bucket: DateBucket;
  items: ConvItem[];
}

const DAY = 24 * 3600_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Bucket by local calendar day: today, yesterday, the previous 7 days, the previous 30, older. */
export function dateBucket(iso: string, now: number = Date.now()): DateBucket {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "older";
  const today = startOfDay(now);
  if (ts >= today) return "today";
  if (ts >= today - DAY) return "yesterday";
  if (ts >= today - 6 * DAY) return "week";
  if (ts >= today - 29 * DAY) return "month";
  return "older";
}

/** Items (already newest first) split into the non-empty buckets, in order. */
export function sectionize(items: ConvItem[], now: number = Date.now()): ConvSection[] {
  const by = new Map<DateBucket, ConvItem[]>();
  for (const item of items) {
    const bucket = dateBucket(item.updated_at, now);
    const list = by.get(bucket);
    if (list) list.push(item);
    else by.set(bucket, [item]);
  }
  return DATE_BUCKETS.flatMap((bucket) => {
    const list = by.get(bucket);
    return list ? [{ bucket, items: list }] : [];
  });
}

export { matchesQuery } from "@/lib/text";

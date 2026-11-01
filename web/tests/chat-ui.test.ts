// Greeting and sidebar helpers: time of day, the name taken from the e-mail, date buckets by local
// calendar day and the accent-insensitive title search.

import { describe, expect, it } from "vitest";
import { dateBucket, matchesQuery, sectionize, type ConvItem } from "../src/components/layout/conversations";
import { displayName, timeOfDay } from "../src/lib/greeting";

describe("greeting", () => {
  it("picks the time of day by hour", () => {
    expect(timeOfDay(5)).toBe("morning");
    expect(timeOfDay(11)).toBe("morning");
    expect(timeOfDay(12)).toBe("afternoon");
    expect(timeOfDay(17)).toBe("afternoon");
    expect(timeOfDay(18)).toBe("evening");
    expect(timeOfDay(0)).toBe("evening");
    expect(timeOfDay(4)).toBe("evening");
  });

  it("takes the name from the e-mail, up to the @", () => {
    expect(displayName("ana.silva@example.com")).toBe("Ana.silva");
    expect(displayName("THIAGO@x.org")).toBe("THIAGO");
    expect(displayName("@x.org")).toBe("");
    expect(displayName("")).toBe("");
  });
});

describe("conversation date buckets", () => {
  // Tuesday 2026-10-13 15:00 local time.
  const now = new Date(2026, 9, 13, 15, 0).getTime();
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

  it("buckets by local calendar day", () => {
    expect(dateBucket(at(2026, 9, 13, 0), now)).toBe("today");
    expect(dateBucket(at(2026, 9, 13, 23), now)).toBe("today"); // later today (clock skew) still counts as today
    expect(dateBucket(at(2026, 9, 12, 23), now)).toBe("yesterday");
    expect(dateBucket(at(2026, 9, 12, 0), now)).toBe("yesterday");
    expect(dateBucket(at(2026, 9, 11), now)).toBe("week");
    expect(dateBucket(at(2026, 9, 7, 0), now)).toBe("week"); // 6 days ago: the 7th day counting today
    expect(dateBucket(at(2026, 9, 6, 23), now)).toBe("month");
    expect(dateBucket(at(2026, 8, 14, 0), now)).toBe("month"); // 29 days ago
    expect(dateBucket(at(2026, 8, 13, 23), now)).toBe("older");
    expect(dateBucket(at(2025, 0, 1), now)).toBe("older");
    expect(dateBucket("not a date", now)).toBe("older");
  });

  it("splits a newest-first list into the non-empty buckets, in order", () => {
    const item = (id: string, iso: string): ConvItem => ({ id, title: id, updated_at: iso, device_id: "d" });
    const items = [item("a", at(2026, 9, 13)), item("b", at(2026, 9, 13, 9)), item("c", at(2026, 9, 9)), item("d", at(2025, 5, 1))];
    expect(sectionize(items, now)).toEqual([
      { bucket: "today", items: [items[0], items[1]] },
      { bucket: "week", items: [items[2]] },
      { bucket: "older", items: [items[3]] },
    ]);
    expect(sectionize([], now)).toEqual([]);
  });
});

describe("conversation search", () => {
  it("ignores case and accents and matches every word", () => {
    expect(matchesQuery("Relatório de Cálculo Renal", "calculo relat")).toBe(true);
    expect(matchesQuery("Relatório de Cálculo Renal", "RENAL")).toBe(true);
    expect(matchesQuery("Relatório de Cálculo Renal", "renal hepático")).toBe(false);
    expect(matchesQuery("abc", "xyz")).toBe(false);
  });

  it("matches everything on an empty query", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("", "   ")).toBe(true);
    expect(matchesQuery("", "x")).toBe(false);
  });
});

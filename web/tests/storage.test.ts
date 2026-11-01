// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { openDB } from "idb";
import { DB_VERSION, createIndexedDbStorage, createMemoryStorage, type AppStorage } from "../src/lib/storage";
import { randomBytes } from "../src/crypto/bytes";

function suite(name: string, make: () => AppStorage) {
  describe(name, () => {
    it("stores pairings by device_id with independent byte copies", async () => {
      const s = make();
      const pk = randomBytes(32);
      const pid = randomBytes(16);
      await s.pairings.put({ device_id: "d1", pairing_id: pid, pk, name: "PC", created_at: "t" });
      pk.fill(0); // the caller's buffer must not alias the stored one
      const got = await s.pairings.get("d1");
      expect(got?.name).toBe("PC");
      expect(got?.pk.some((b) => b !== 0)).toBe(true);
      expect(got?.pairing_id).toEqual(pid);
      await s.pairings.put({ device_id: "d2", pairing_id: randomBytes(16), pk: randomBytes(32), name: "Laptop", created_at: "t" });
      expect((await s.pairings.list()).map((p) => p.device_id).sort()).toEqual(["d1", "d2"]);
      await s.pairings.delete("d1");
      expect(await s.pairings.get("d1")).toBeNull();
      await s.pairings.clear();
      expect(await s.pairings.list()).toEqual([]);
      await s.close();
    });
    it("remembers and forgets the session's pairings key", async () => {
      const s = make();
      expect(await s.session.getPairingsKey()).toBeNull();
      const k = randomBytes(32);
      await s.session.setPairingsKey(k);
      k.fill(0); // independent copy
      expect((await s.session.getPairingsKey())?.some((b) => b !== 0)).toBe(true);
      await s.session.clearPairingsKey();
      expect(await s.session.getPairingsKey()).toBeNull();
      await s.close();
    });
    it("keeps settings", async () => {
      const s = make();
      await s.settings.set("theme", "dark");
      await s.settings.set("obj", { a: 1 });
      expect(await s.settings.get("theme")).toBe("dark");
      expect(await s.settings.all()).toEqual({ theme: "dark", obj: { a: 1 } });
      await s.settings.delete("theme");
      expect(await s.settings.get("theme")).toBeUndefined();
      await s.close();
    });
  });
}

suite("memory storage", () => createMemoryStorage());
let n = 0;
suite("IndexedDB storage (fake-indexeddb)", () => createIndexedDbStorage(`tunnelio-test-${n++}`));

describe("IndexedDB schema upgrade", () => {
  it("drops the v1 \"vault\" store (and the key it held) when a rev. 1.2 database is opened", async () => {
    const name = "tunnelio-upgrade-test";
    const v1 = await openDB(name, 1, {
      upgrade(d) {
        d.createObjectStore("pairings", { keyPath: "device_id" });
        d.createObjectStore("vault");
        d.createObjectStore("settings");
      },
    });
    await v1.put("vault", randomBytes(32), "vault_key");
    await v1.put("pairings", { device_id: "d1", pairing_id: randomBytes(16), pk: randomBytes(32), name: "PC", created_at: "t" });
    v1.close();
    const s = createIndexedDbStorage(name);
    expect((await s.pairings.list()).map((p) => p.device_id)).toEqual(["d1"]); // pairings survive
    await s.close();
    const v2 = await openDB(name, DB_VERSION);
    expect([...v2.objectStoreNames].sort()).toEqual(["pairings", "session", "settings"]);
    v2.close();
  });
});

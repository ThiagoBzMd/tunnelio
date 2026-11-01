// @vitest-environment node
// The synced-pairings document (stores/pairing-sync.ts): wire shape, strict decoding, and the
// sealed form through crypto/sync.ts.

import { describe, expect, it } from "vitest";
import { b64urlEncode } from "../src/crypto/b64url";
import { randomBytes, utf8, utf8Decode } from "../src/crypto/bytes";
import { openPairings, sealPairings } from "../src/crypto/sync";
import { PAIRINGS_BLOB_VERSION, decodePairings, encodePairings } from "../src/stores/pairing-sync";

describe("synced pairings codec", () => {
  const rec = { device_id: "0192f6a0-5e7b-7c3d-9a4e-1b2c3d4e5f60", pairing_id: randomBytes(16), pk: randomBytes(32), name: "Office PC", created_at: "2026-10-09T00:00:00Z" };

  it("encodes the documented wire shape and decodes it back", () => {
    const doc = JSON.parse(utf8Decode(encodePairings([rec]))) as { version: number; pairings: Record<string, string>[] };
    expect(doc.version).toBe(PAIRINGS_BLOB_VERSION);
    expect(doc.pairings).toEqual([{ device_id: rec.device_id, pairing_id: b64urlEncode(rec.pairing_id), pk: b64urlEncode(rec.pk), name: "Office PC", created_at: rec.created_at }]);
    expect(decodePairings(encodePairings([rec]))).toEqual([rec]);
    expect(decodePairings(encodePairings([]))).toEqual([]);
  });

  it("skips malformed entries and tolerates a malformed document", () => {
    const bad = JSON.stringify({
      version: 1,
      pairings: [
        { device_id: "d", pairing_id: b64urlEncode(randomBytes(15)), pk: b64urlEncode(rec.pk), name: "", created_at: "t" }, // 15-byte pairing_id
        { device_id: "d", pairing_id: b64urlEncode(rec.pairing_id), pk: "not base64url!", name: "", created_at: "t" },
        { device_id: 7, pairing_id: b64urlEncode(rec.pairing_id), pk: b64urlEncode(rec.pk), name: "", created_at: "t" },
        { device_id: "ok", pairing_id: b64urlEncode(rec.pairing_id), pk: b64urlEncode(rec.pk), name: "PC", created_at: "t" },
      ],
    });
    expect(decodePairings(utf8(bad)).map((r) => r.device_id)).toEqual(["ok"]);
    expect(decodePairings(utf8("not json"))).toEqual([]);
    expect(decodePairings(utf8('{"version":1}'))).toEqual([]);
  });

  it("seals with AES-256-GCM under the pairings key and refuses other keys", async () => {
    const key = randomBytes(32);
    const stored = await sealPairings(key, encodePairings([rec]));
    expect(decodePairings(await openPairings(key, stored))).toEqual([rec]);
    await expect(openPairings(randomBytes(32), stored)).rejects.toMatchObject({ code: "E_AUTH" });
    await expect(openPairings(key, stored.slice(0, 20))).rejects.toMatchObject({ code: "E_INVALID" });
    // The PK never appears in the sealed form.
    expect(b64urlEncode(stored)).not.toContain(b64urlEncode(rec.pk));
  });
});

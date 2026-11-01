// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  base64DecodedLength,
  base64ToBytes,
  bytesToBase64,
  checkImage,
  imageDataUrl,
  isStandardBase64,
  sniffMime,
} from "../src/lib/images";
import { LIMITS } from "../src/protocol/constants";

/** Base64 whose decoded length is exactly `n` bytes (all zero bytes). */
function b64OfLength(n: number): string {
  const groups = Math.floor(n / 3);
  const rem = n % 3;
  return "A".repeat(groups * 4) + (rem === 1 ? "AA==" : rem === 2 ? "AAA=" : "");
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

describe("base64 helpers (standard alphabet, padded — what the tray decodes)", () => {
  it("round-trips bytes of every length mod 3 and matches Buffer", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 73 + 11) & 255);
      const b64 = bytesToBase64(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString("base64"));
      expect(isStandardBase64(b64)).toBe(n > 0);
      expect(base64DecodedLength(b64)).toBe(n);
      if (n > 0) expect(base64ToBytes(b64)).toEqual(bytes);
    }
  });
  it("computes the decoded length from the string alone", () => {
    expect(base64DecodedLength("")).toBe(0);
    expect(base64DecodedLength("QQ==")).toBe(1);
    expect(base64DecodedLength("QUI=")).toBe(2);
    expect(base64DecodedLength("QUJD")).toBe(3);
    expect(base64DecodedLength("QUJ")).toBe(0); // not padded → malformed
  });
  it("rejects base64url, data-URL prefixes and unpadded input", () => {
    expect(isStandardBase64("QUJD")).toBe(true);
    expect(isStandardBase64("QU-D")).toBe(false);
    expect(isStandardBase64("QU_D")).toBe(false);
    expect(isStandardBase64("data:image/png;base64,QUJD")).toBe(false);
    expect(isStandardBase64("QUJ")).toBe(false);
    expect(isStandardBase64("QUJD\n")).toBe(false);
    expect(() => base64ToBytes("QUJ")).toThrow(/malformed/);
  });
  it("decodes only a prefix when asked", () => {
    expect(base64ToBytes(bytesToBase64(PNG), 4)).toEqual(PNG.slice(0, 4));
  });
});

describe("sniffMime", () => {
  it("recognises the four formats the contract allows", () => {
    expect(sniffMime(bytesToBase64(PNG))).toBe("image/png");
    expect(sniffMime(bytesToBase64(JPEG))).toBe("image/jpeg");
    expect(sniffMime(bytesToBase64(GIF))).toBe("image/gif");
    expect(sniffMime(bytesToBase64(WEBP))).toBe("image/webp");
  });
  it("returns null for other bytes and malformed input", () => {
    expect(sniffMime(bytesToBase64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])))).toBeNull();
    expect(sniffMime("")).toBeNull();
    expect(sniffMime("not base64!")).toBeNull();
    // RIFF but not WEBP (e.g. WAV)
    const wav = new Uint8Array(WEBP);
    wav.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(sniffMime(bytesToBase64(wav))).toBeNull();
  });
  it("builds a data URL for <img> from the sniffed type", () => {
    const b64 = bytesToBase64(JPEG);
    expect(imageDataUrl(b64)).toBe(`data:image/jpeg;base64,${b64}`);
    expect(imageDataUrl("AAAA")).toBe("data:application/octet-stream;base64,AAAA");
  });
});

describe("checkImage (the pre-send guard)", () => {
  it("accepts a valid image up to 4 MiB and flags larger or malformed ones", () => {
    expect(checkImage(bytesToBase64(JPEG))).toBeNull();
    for (const n of [1, 2, 3, 4, 100, LIMITS.MAX_IMAGE_BYTES]) expect(base64DecodedLength(b64OfLength(n))).toBe(n);
    expect(checkImage(b64OfLength(LIMITS.MAX_IMAGE_BYTES))).toBeNull();
    expect(checkImage(b64OfLength(LIMITS.MAX_IMAGE_BYTES + 1))).toBe("E_TOO_LARGE");
    expect(checkImage("data:image/png;base64,QUJD")).toBe("E_DECODE");
    expect(checkImage("")).toBe("E_DECODE");
  });
});

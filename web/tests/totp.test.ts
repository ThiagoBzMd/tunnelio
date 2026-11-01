// @vitest-environment node
// The test-side TOTP (fake server + E2E) must agree with real authenticator apps: RFC 6238
// Appendix B vectors (SHA-1, 8 digits truncated here to the last 6 as apps show them) and RFC 4648
// base32.

import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, randomTotpSecret, totpCode, totpValid } from "./helpers/totp";

// RFC 6238 SHA-1 secret "12345678901234567890" in base32.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP helper", () => {
  it("round-trips base32 (RFC 4648)", () => {
    expect(base32Encode(new TextEncoder().encode("12345678901234567890"))).toBe(RFC_SECRET);
    expect(new TextDecoder().decode(base32Decode(RFC_SECRET))).toBe("12345678901234567890");
    expect(new TextDecoder().decode(base32Decode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq=="))).toBe("12345678901234567890");
    expect(() => base32Decode("1!")).toThrow(/base32/);
    const s = randomTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
  });

  it("matches the RFC 6238 SHA-1 vectors (last 6 digits of the 8-digit codes)", () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, eight] of vectors) expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(eight.slice(-6));
  });

  it("accepts the neighbouring 30 s steps and nothing else", () => {
    const now = 1111111111 * 1000;
    expect(totpValid(RFC_SECRET, totpCode(RFC_SECRET, now), now)).toBe(true);
    expect(totpValid(RFC_SECRET, totpCode(RFC_SECRET, now, -1), now)).toBe(true);
    expect(totpValid(RFC_SECRET, totpCode(RFC_SECRET, now, 1), now)).toBe(true);
    expect(totpValid(RFC_SECRET, totpCode(RFC_SECRET, now, 2), now)).toBe(false);
    expect(totpValid(RFC_SECRET, "000000", now)).toBe(totpCode(RFC_SECRET, now) === "000000");
  });
});

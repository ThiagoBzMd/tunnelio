// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, checkPassword } from "../src/lib/password";
import { MIN_STRENGTH, loadStrength, strengthHints, tooWeak } from "../src/lib/strength";

describe("password policy (client side; the server only sees a derived key)", () => {
  it("requires 12 characters after NFC normalization", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(checkPassword("short one")).toBe("short");
    expect(checkPassword("exactly12chr")).toBeNull();
    // "é" as e + combining acute is one character once normalized.
    expect(checkPassword("café au lait 1".normalize("NFD"))).toBe(checkPassword("café au lait 1"));
  });
  it("refuses the common list, ignoring case and spaces", () => {
    expect(checkPassword("password1234")).toBe("common");
    expect(checkPassword("PassWord 1234")).toBe("common");
    expect(checkPassword("qwertyuiopasdfghjkl")).toBe("common");
    expect(checkPassword("correct horse battery staple")).toBeNull();
  });

  it("strength: easy-to-guess passwords stay below the minimum, phrases pass; the e-mail counts against", async () => {
    const check = await loadStrength();
    expect(MIN_STRENGTH).toBe(3);
    for (const weak of ["aaaaaaaaaaaa", "123456789012", "senhasenha12", "qwertyuiop12"]) expect(check(weak, [])).toBeLessThan(MIN_STRENGTH);
    for (const strong of ["correct horse battery staple", "gato azul pula muro 7", "minha senha forte"]) expect(check(strong, [])).toBeGreaterThanOrEqual(MIN_STRENGTH);
    expect(check("thiagobezerra2026", strengthHints("thiago.bezerra@example.com"))).toBeLessThan(check("thiagobezerra2026", []));
    expect(strengthHints(" Ana.Maria@Example.com ")).toEqual(["ana.maria@example.com", "ana.maria", "ana", "maria"]);
    expect(await tooWeak("senhasenha12", [])).toBe(true);
    expect(await tooWeak("correct horse battery staple", [])).toBe(false);
  });
});

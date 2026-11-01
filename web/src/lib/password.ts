// Client-side password policy (rev. 1.2): the server only ever sees a derived key, so strength is
// enforced here — at least 12 characters and not one of the most common passwords.

export const MIN_PASSWORD_LENGTH = 12;

const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "password12345",
  "passwordpassword",
  "passw0rd",
  "p@ssw0rd",
  "123456",
  "12345678",
  "123456789",
  "1234567890",
  "12345678910",
  "123456789012",
  "1234567890123",
  "123456123456",
  "111111111111",
  "000000000000",
  "qwerty",
  "qwertyuiop",
  "qwertyuiop12",
  "qwertyuiopasdfghjkl",
  "qwerty123456",
  "asdfghjkl",
  "1q2w3e4r5t6y",
  "zaq12wsxcde3",
  "abc123456789",
  "iloveyou",
  "iloveyou1234",
  "letmein",
  "letmein12345",
  "welcome",
  "welcome12345",
  "welcome123",
  "admin",
  "administrator",
  "adminadmin123",
  "changeme",
  "changeme123",
  "trustno1",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "superman",
  "starwars",
  "dragon",
  "monkey",
  "master",
  "freedom",
  "whatever",
  "computer",
  "internet",
  "senha",
  "senha123",
  "senha123456",
  "mudar123",
  "123mudar",
  "brasil123456",
]);

export type PasswordProblem = "short" | "common";

/** `null` when the password is acceptable. */
export function checkPassword(password: string): PasswordProblem | null {
  const normalized = password.normalize("NFC");
  if (normalized.length < MIN_PASSWORD_LENGTH) return "short";
  if (COMMON_PASSWORDS.has(normalized.toLowerCase().replace(/\s+/g, ""))) return "common";
  return null;
}

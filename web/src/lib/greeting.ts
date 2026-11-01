// Greeting of the empty chat: the time of day plus the part of the e-mail before "@".

export type TimeOfDay = "morning" | "afternoon" | "evening";

/** 05:00–11:59 morning, 12:00–17:59 afternoon, otherwise evening. */
export function timeOfDay(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

/** "ana.silva@example.com" → "Ana.silva": the local part with its first letter upper-cased, "" when there is none. */
export function displayName(email: string): string {
  const local = (email.split("@")[0] ?? "").trim();
  if (!local) return "";
  return local.charAt(0).toLocaleUpperCase() + local.slice(1);
}

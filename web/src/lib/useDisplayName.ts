// The name the app calls the person by: "What should Tunnelio call you?" (synced preferences), or
// the part of the e-mail before "@" when it was never set.

import { useAuth, useSettings } from "@/stores/react";
import { displayName } from "./greeting";

export function useDisplayName(): string {
  const email = useAuth((s) => s.me?.email ?? "");
  const chosen = useSettings((s) => s.settings.display_name);
  return chosen?.trim() || displayName(email);
}

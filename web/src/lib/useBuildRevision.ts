// The public commit this app was built from, as the server publishes it next to the bundle
// (/version.json; never inside the bundle, so the bundle can be rebuilt from that commit and
// compared byte for byte — README, "Verifying what tunnelio.app runs"). `null` while loading or
// when there is none (the dev server answers with index.html).

import { useEffect, useState } from "react";

export function useBuildRevision(): string | null {
  const [revision, setRevision] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/version.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((doc: unknown) => {
        const rev = doc && typeof doc === "object" && typeof (doc as { revision?: unknown }).revision === "string" ? (doc as { revision: string }).revision : null;
        if (!cancelled && rev && /^[0-9a-f]{7,40}$/.test(rev)) setRevision(rev);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return revision;
}

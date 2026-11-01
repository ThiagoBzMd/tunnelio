// Where the public site lives, derived from where the app is served: the app at
// https://app.example.com → the site at https://example.com. A self-hosted app on any other host
// has no site, and the links that point there (about, policies, download) are hidden.

import type { Language } from "../stores/settings";

export function siteUrl(loc: Pick<Location, "protocol" | "hostname" | "port"> = window.location): string | null {
  if (!loc.hostname.startsWith("app.") || loc.hostname.length <= 4) return null;
  return `${loc.protocol}//${loc.hostname.slice(4)}${loc.port ? `:${loc.port}` : ""}`;
}

export type SitePage = "docs" | "about" | "usage-policy" | "privacy" | "terms";

/** The page in the reader's language (Portuguese pages live under /pt/). */
export function sitePageUrl(page: SitePage, lang: Language, base: string | null = siteUrl()): string | null {
  if (!base) return null;
  return `${base}${lang === "pt-BR" ? "/pt" : ""}/${page}.html`;
}

/**
 * Where the source code of this build is (the AGPL-3.0 asks to offer it to the people who use the
 * app): the public repository at the commit the build came from, when known. A modified version must
 * point here to its own source.
 */
export const SOURCE_REPOSITORY = "https://github.com/ThiagoBzMd/tunnelio";

export function sourceUrl(revision: string | null): string {
  return revision ? `${SOURCE_REPOSITORY}/tree/${revision}` : SOURCE_REPOSITORY;
}

/** The app's own licence, the GNU AGPL-3.0 (written by the web build next to it, from web/LICENSE). */
export const LICENSE_PATH = "/LICENSE.txt";

/** The licences of the third-party software in this build (written by the web build next to it). */
export const THIRD_PARTY_LICENSES_PATH = "/third-party-licenses.txt";

/** The download section of the site (installers for the computer app). */
export function downloadUrl(base: string | null = siteUrl()): string | null {
  return base ? `${base}/#download` : null;
}

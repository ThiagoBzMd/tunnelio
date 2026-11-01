// Derive the relay WebSocket URL from an explicit base URL or the page origin.

import { RELAY_CLIENT_PATH } from "../protocol/constants";

export function relayUrl(base?: string): string {
  if (base) {
    const u = new URL(base);
    if (u.protocol === "https:") u.protocol = "wss:";
    else if (u.protocol === "http:") u.protocol = "ws:";
    else if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error(`unsupported base URL scheme ${u.protocol}`);
    u.pathname = RELAY_CLIENT_PATH;
    u.search = "";
    u.hash = "";
    return u.toString();
  }
  const loc = (globalThis as { location?: { protocol: string; host: string } }).location;
  if (!loc) throw new Error("no base URL and no window.location");
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}${RELAY_CLIENT_PATH}`;
}

// React binding for the relay connection state (the RelayClient is an emitter, not a store).

import { useSyncExternalStore } from "react";
import { getRuntime, hasRuntime } from "@/stores/runtime";
import type { RelayState } from "@/relay/client";

function subscribe(cb: () => void): () => void {
  if (!hasRuntime()) return () => undefined;
  return getRuntime().relay.on("state", cb);
}

function snapshot(): RelayState {
  return hasRuntime() ? getRuntime().relay.state : "idle";
}

export function useRelayState(): RelayState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

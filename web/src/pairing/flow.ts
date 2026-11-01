// Browser side (A) of the pairing flow over relay `pair_*` frames (SPEC §4.2, §4.4).
//   code → claim/secret → pair_join → pair_joined → pake1 → pake2 (verify cB) → pake3 → pair_result

import { b64urlDecodeLen, b64urlEncode } from "../crypto/b64url";
import { zeroize } from "../crypto/bytes";
import { normalizePairingCode, pairingCodeToW, splitPairingCode } from "../crypto/code";
import { CrockfordError } from "../crypto/crockford";
import { pairingIdFromPK, pairingKeyFromKe } from "../crypto/pairing";
import { Spake2A, Spake2Error } from "../crypto/spake2";
import { PROTOCOL_VERSION, TIMEOUTS } from "../protocol/constants";
import { parsePake2, type Pake1, type Pake2, type Pake3 } from "../protocol/pake";
import type { PairResultFrame } from "../protocol/relay";
import { realTimers, type Timers } from "../protocol/timers";
import type { PairingRecord, PairingStore } from "../lib/storage";
import type { RelayClient } from "../relay/client";

export type PairingErrorCode =
  | "E_CODE_INVALID"
  | "E_PAIR_NOT_FOUND"
  | "E_PAIR_BUSY"
  | "E_PAIR_EXPIRED"
  | "E_PAIR_FAILED"
  | "E_RATE_LIMIT"
  | "E_TIMEOUT"
  | "E_BAD_MAC"
  | "E_INVALID"
  | "E_DISCONNECTED"
  | string;

export class PairingError extends Error {
  constructor(
    public readonly code: PairingErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PairingError";
  }
}

export type PairingStep = "joining" | "pake1" | "pake2" | "pake3" | "result";

export interface PairOptions {
  timers?: Timers;
  /** Timeout for each step (SPEC §4.2 rule 2: 60 s). */
  stepTimeoutMs?: number;
  /** When given, the record is persisted before resolving. */
  store?: PairingStore;
  onStep?: (step: PairingStep) => void;
  /** Deterministic scalar — tests only. */
  x?: bigint;
  now?: () => string;
}

/**
 * Run the full pairing as side A. Resolves with the pairing record (device_id, pairing_id, PK,
 * name) only after `pair_result{ok:true}` — and only after `cB` verified (SPEC §4.2 rule 3).
 */
export async function pairDevice(relay: RelayClient, code: string, opts: PairOptions = {}): Promise<PairingRecord> {
  const timers = opts.timers ?? realTimers;
  const stepTimeoutMs = opts.stepTimeoutMs ?? TIMEOUTS.PAIRING_STEP_MS;
  let normalized: string;
  try {
    normalized = normalizePairingCode(code);
  } catch (e) {
    throw new PairingError("E_CODE_INVALID", e instanceof CrockfordError ? e.message : "invalid pairing code");
  }
  const { claim } = splitPairingCode(normalized);
  const w = pairingCodeToW(normalized);

  await relay.whenReady(stepTimeoutMs).catch((e: unknown) => {
    throw new PairingError("E_DISCONNECTED", e instanceof Error ? e.message : "relay not ready");
  });

  const offs: (() => void)[] = [];
  const cleanup = () => {
    for (const off of offs) off();
    offs.length = 0;
  };

  // One rejection channel for everything that can abort the flow asynchronously.
  let abort!: (e: PairingError) => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = reject;
  });
  aborted.catch(() => undefined);
  offs.push(
    relay.on("error", (f) => {
      if (f.code.startsWith("E_PAIR") || f.code === "E_RATE_LIMIT" || f.code === "E_INVALID") {
        abort(new PairingError(f.code, f.message ?? f.code));
      }
    }),
    relay.on("disconnected", (d) => abort(new PairingError("E_DISCONNECTED", `relay disconnected (${d.code})`))),
    relay.on("pair_result", (f) => {
      if (f.claim === claim && !f.ok) abort(new PairingError(f.code ?? "E_PAIR_FAILED", "device reported failure"));
    }),
  );

  const step = <T>(what: PairingStep, start: (resolve: (v: T) => void) => () => void): Promise<T> => {
    opts.onStep?.(what);
    return new Promise<T>((resolve, reject) => {
      let off: (() => void) | null = null;
      let settled = false;
      const finish = () => {
        settled = true;
        timers.clearTimeout(timer);
        off?.();
      };
      const timer = timers.setTimeout(() => {
        if (settled) return;
        finish();
        reject(new PairingError("E_TIMEOUT", `timed out waiting for ${what}`));
      }, stepTimeoutMs);
      aborted.catch((e: PairingError) => {
        if (settled) return;
        finish();
        reject(e);
      });
      try {
        off = start((v) => {
          if (settled) return;
          finish();
          resolve(v);
        });
      } catch (e) {
        finish();
        reject(e instanceof PairingError ? e : new PairingError("E_DISCONNECTED", e instanceof Error ? e.message : String(e)));
        return;
      }
      // The answer may have arrived synchronously (in-memory relays); release the listener now.
      if (settled) off();
    });
  };

  if (!relay.isReady) {
    cleanup();
    throw new PairingError("E_DISCONNECTED", "relay is not connected");
  }

  try {
    const joined = await step<{ device_id?: string }>("joining", (resolve) => {
      const off = relay.on("pair_joined", (f) => {
        if (f.claim !== claim) return;
        resolve(f.device_id !== undefined ? { device_id: f.device_id } : {});
      });
      relay.pairJoin(claim);
      return off;
    });

    const a = new Spake2A(w, undefined, opts.x);
    const pA = a.start();
    const pake2 = await step<Pake2>("pake1", (resolve) => {
      const off = relay.on("pair_msg", (f) => {
        if (f.claim !== claim) return;
        const p = parsePake2(f.payload);
        if (p) resolve(p);
      });
      const msg: Pake1 = { t: "pake1", v: PROTOCOL_VERSION, pA: b64urlEncode(pA) };
      relay.pairMsg(claim, { ...msg });
      return off;
    });

    opts.onStep?.("pake2");
    if (pake2.v !== PROTOCOL_VERSION) throw new PairingError("E_INVALID", `unsupported pake2 v=${pake2.v}`);
    let pB: Uint8Array;
    let cB: Uint8Array;
    try {
      pB = b64urlDecodeLen(pake2.pB, 65);
      cB = b64urlDecodeLen(pake2.cB, 32);
    } catch {
      throw new PairingError("E_INVALID", "malformed pake2");
    }
    let Ke: Uint8Array;
    let cA: Uint8Array;
    try {
      ({ Ke, cA } = a.finish(pB, cB));
    } catch (e) {
      throw new PairingError("E_BAD_MAC", e instanceof Spake2Error ? e.message : "SPAKE2 failed");
    }
    const pk = pairingKeyFromKe(Ke);
    zeroize(Ke);
    const pairingId = pairingIdFromPK(pk);

    const result = await step<PairResultFrame>("pake3", (resolve) => {
      const off = relay.on("pair_result", (f) => {
        if (f.claim === claim && f.ok) resolve(f);
      });
      const msg: Pake3 = { t: "pake3", v: PROTOCOL_VERSION, cA: b64urlEncode(cA) };
      relay.pairMsg(claim, { ...msg });
      return off;
    });

    opts.onStep?.("result");
    const deviceId = result.device?.device_id ?? joined.device_id;
    if (!deviceId) {
      zeroize(pk);
      throw new PairingError("E_INVALID", "pair_result carries no device_id");
    }
    const record: PairingRecord = {
      device_id: deviceId,
      pairing_id: pairingId,
      pk,
      name: result.device?.name ?? "",
      created_at: (opts.now ?? (() => new Date().toISOString()))(),
    };
    if (opts.store) await opts.store.put(record);
    return record;
  } finally {
    cleanup();
  }
}

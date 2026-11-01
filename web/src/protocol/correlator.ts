// Request/response correlation by `id` with per-request timeouts and stream idle timeouts.

import type { Timers } from "./timers";
import { realTimers } from "./timers";

export class TimeoutError extends Error {
  constructor(
    public readonly id: string,
    public readonly kind: "timeout" | "idle",
  ) {
    super(kind === "idle" ? `stream ${id} idle timeout` : `request ${id} timed out`);
    this.name = "TimeoutError";
  }
}

export class CancelledError extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export interface StreamOptions<M> {
  idleMs: number;
  onEvent: (m: M) => void;
  isDone: (m: M) => boolean;
  /**
   * Called on idle timeout. When provided, the stream stays open (the UI marks it stalled and
   * offers abort, SPEC §7.6); when absent, the promise rejects with `TimeoutError("idle")`.
   */
  onIdle?: () => void;
}

interface Pending<M> {
  resolve: (m: M) => void;
  reject: (e: Error) => void;
  stream: StreamOptions<M> | null;
  timeoutMs: number;
  timer: unknown;
}

export interface Correlatable {
  id?: string;
  type: string;
}

export class Correlator<M extends Correlatable> {
  private pending = new Map<string, Pending<M>>();

  constructor(private readonly timers: Timers = realTimers) {}

  get size(): number {
    return this.pending.size;
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  /** One response expected; resolves with it (even if it is an `error` message). */
  request(id: string, timeoutMs: number): Promise<M> {
    return new Promise<M>((resolve, reject) => {
      if (this.pending.has(id)) {
        reject(new Error(`duplicate request id ${id}`));
        return;
      }
      const p: Pending<M> = { resolve, reject, stream: null, timeoutMs, timer: null };
      this.pending.set(id, p);
      this.arm(id, p);
    });
  }

  /** Many events then a terminal message (`isDone`). */
  stream(id: string, opts: StreamOptions<M>): Promise<M> {
    return new Promise<M>((resolve, reject) => {
      if (this.pending.has(id)) {
        reject(new Error(`duplicate request id ${id}`));
        return;
      }
      const p: Pending<M> = { resolve, reject, stream: opts, timeoutMs: opts.idleMs, timer: null };
      this.pending.set(id, p);
      this.arm(id, p);
    });
  }

  /** Route an inbound message; returns false when nothing is waiting for its id. */
  dispatch(m: M): boolean {
    if (m.id === undefined) return false;
    const p = this.pending.get(m.id);
    if (!p) return false;
    if (p.stream && !p.stream.isDone(m) && m.type !== "error") {
      this.arm(m.id, p);
      try {
        p.stream.onEvent(m);
      } catch (e) {
        this.finish(m.id, p);
        p.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return true;
    }
    this.finish(m.id, p);
    p.resolve(m);
    return true;
  }

  cancel(id: string, reason: Error = new CancelledError()): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.finish(id, p);
    p.reject(reason);
    return true;
  }

  rejectAll(reason: Error): void {
    for (const [id, p] of [...this.pending]) {
      this.finish(id, p);
      p.reject(reason);
    }
  }

  private arm(id: string, p: Pending<M>): void {
    if (p.timer !== null) this.timers.clearTimeout(p.timer);
    p.timer = this.timers.setTimeout(() => {
      if (p.stream?.onIdle) {
        // Keep waiting; re-arm so a long stall keeps notifying once per idle period.
        this.arm(id, p);
        p.stream.onIdle();
        return;
      }
      this.finish(id, p);
      p.reject(new TimeoutError(id, p.stream ? "idle" : "timeout"));
    }, p.timeoutMs);
  }

  private finish(id: string, p: Pending<M>): void {
    if (p.timer !== null) this.timers.clearTimeout(p.timer);
    p.timer = null;
    this.pending.delete(id);
  }
}

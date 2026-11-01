import type { Timers } from "../../src/protocol/timers";

interface Entry {
  id: number;
  at: number;
  fn: () => void;
}

/** Deterministic timers: `advance(ms)` fires due callbacks in order and lets promises settle. */
export class FakeTimers implements Timers {
  private t = 0;
  private seq = 0;
  private queue: Entry[] = [];

  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.queue.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((e) => e.id !== handle);
  }
  now(): number {
    return this.t;
  }
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Let the microtask/macrotask queue drain. WebCrypto (AES-GCM, HKDF) resolves on real ticks and
   * on a loaded machine (CI runners) needs more than a handful of them: too few rounds and a fired
   * timer races the envelope it was waiting for, which showed up as a 20 s hang on GitHub only.
   */
  async flush(rounds = 25): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setTimeout(r, 0));
  }

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await this.flush();
      const due = this.queue.filter((e) => e.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.queue = this.queue.filter((e) => e.id !== due.id);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
    await this.flush();
  }
}

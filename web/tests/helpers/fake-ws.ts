import type { WebSocketLike } from "../../src/relay/client";

/** In-memory WebSocket double: the test plays the server through `server*` methods. */
export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!ws) throw new Error("no FakeWebSocket created yet");
    return ws;
  }

  readyState = 0;
  protocol = "tunnelio.v1";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;

  constructor(
    public readonly url: string,
    public readonly protocols: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  serverSend(obj: unknown): void {
    this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) });
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  takeFrames(): Record<string, unknown>[] {
    const out = this.frames();
    this.sent = [];
    return out;
  }
  framesOf(type: string): Record<string, unknown>[] {
    return this.frames().filter((f) => f.type === type);
  }
}

type SocketEvent = "open" | "message" | "error" | "close";
type SocketListener = (event: { data?: unknown }) => void;

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<SocketEvent, Array<{
    listener: SocketListener;
    once: boolean;
  }>>();

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    sockets.push(this);
  }

  addEventListener(
    type: SocketEvent,
    listener: SocketListener,
    options?: { once?: boolean },
  ): void {
    const current = this.listeners.get(type) ?? [];
    current.push({ listener, once: options?.once === true });
    this.listeners.set(type, current);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  message(value: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  private emit(type: SocketEvent, event: { data?: unknown }): void {
    const current = this.listeners.get(type) ?? [];
    this.listeners.set(type, current.filter(({ once }) => !once));
    for (const { listener } of current) listener(event);
  }
}

export const sockets: FakeWebSocket[] = [];


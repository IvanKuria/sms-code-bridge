/**
 * The delivery path for browsers that have no push service.
 *
 * Chrome's Push API is FCM. Browsers built on ungoogled-chromium strip FCM out, so
 * `pushManager.subscribe()` can never succeed there and those users had no way to receive
 * a code at all. This gives them one: the extension holds a WebSocket open to a Durable
 * Object keyed by its pairing ID, and `POST /code` hands the payload to that object.
 *
 * A Durable Object rather than KV because of a property worth keeping: the code lives in
 * this object's memory for the instant between arriving and being written to the socket,
 * and is never persisted. Polling would have required storing every code until collected,
 * which is exactly the design `docs/DESIGN.md` §11 rejected.
 *
 * Hibernation is used deliberately (`acceptWebSocket` rather than `server.accept()`): a
 * connection idle for hours costs nothing while hibernated, and survives the object being
 * evicted. Without it a long-lived pairing would keep an object resident indefinitely.
 */
export class PairingSocket {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/connect") {
      if (request.headers.get("upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      if (!client || !server) return new Response("could not create socket pair", { status: 500 });

      // Hibernatable: the runtime holds the socket, not this instance.
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (pathname === "/deliver") {
      const payload = await request.text();
      const sockets = this.state.getWebSockets();

      let sent = 0;
      for (const ws of sockets) {
        try {
          ws.send(payload);
          sent++;
        } catch {
          // A socket the runtime has not yet reaped. Nothing to do but skip it.
        }
      }
      return Response.json({ sent });
    }

    if (pathname === "/status") {
      return Response.json({ connected: this.state.getWebSockets().length });
    }

    return new Response("not found", { status: 404 });
  }

  /**
   * The extension sends a periodic ping so the connection is not closed as idle by an
   * intermediary. Replying is enough; nothing is ever read from the browser otherwise —
   * this channel is strictly relay-to-browser.
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string" && message === "ping") ws.send("pong");
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    // Nothing to clean up: hibernation means the runtime owns the socket set. Defined
    // because the hibernation API requires the handler to exist.
    void ws;
    void code;
    void reason;
    void wasClean;
  }
}

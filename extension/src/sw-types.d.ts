/**
 * Minimal service-worker declarations.
 *
 * WXT's tsconfig ships the DOM lib, which omits the push/SW globals. Pulling in the
 * WebWorker lib instead would conflict with DOM across the rest of the extension, so we
 * declare only what the background entrypoint actually touches.
 */

interface PushMessageData {
  json(): unknown;
  text(): string;
  arrayBuffer(): ArrayBuffer;
}

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface PushEvent extends ExtendableEvent {
  readonly data: PushMessageData | null;
}

interface ServiceWorkerGlobalScope {
  readonly registration: {
    readonly pushManager: PushManager;
  };
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "pushsubscriptionchange", listener: (event: Event) => void): void;
}

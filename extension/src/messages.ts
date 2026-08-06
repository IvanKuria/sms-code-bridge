/** What the relay pushes to us. Mirrors the payload built in relay/src/index.ts. */
export interface CodePayload {
  code: string;
  domain: string | null;
  originBound: boolean;
  sentAt: number;
  ttl: number;
}

export type ToBackground =
  /** A frame now has an OTP-shaped field focused; it becomes the preferred fill target. */
  | { type: "otp-field-focused" }
  /** A frame has an OTP field on screen but unfocused; a weaker targeting signal. */
  | { type: "otp-field-present" }
  | { type: "get-status" }
  /** Revoke the current pairing ID and mint a new one. */
  | { type: "rotate-pairing" };

export type ToContent = { type: "code"; payload: CodePayload };

export interface Status {
  paired: boolean;
  pairingId: string | null;
  setupUrl: string | null;
  lastError: string | null;
  lastCodeAt: number | null;
}

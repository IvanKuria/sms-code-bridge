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
  | { type: "rotate-pairing" }
  /** Open the setup walkthrough in a tab. Fire-and-forget; there is no reply. */
  | { type: "open-onboarding" }
  /** The pill was rendered, or its Fill button was clicked. Diagnostics only. */
  | { type: "pill-shown" }
  | { type: "fill-result"; ok: boolean };

export type ToContent = { type: "code"; payload: CodePayload };

export interface Status {
  paired: boolean;
  pairingId: string | null;
  setupUrl: string | null;
  lastError: string | null;
  lastCodeAt: number | null;
  /** True when this browser has no push service at all (de-googled Chromium forks). */
  pushUnavailable: boolean;
  /**
   * The last rotation could not revoke the old pairing ID, so it may still be live on the
   * relay. Kept separate from `lastError` because a subsequent successful re-pair clears
   * that field, and this warning must outlive it.
   */
  revokeFailed: boolean;
}

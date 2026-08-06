/// <reference lib="dom" />

/**
 * OTP field detection and filling.
 *
 * Two jobs, deliberately kept separate:
 *
 *  - `findOtpField` decides *where* a code would go. It is biased towards returning
 *    nothing: filling a coupon box with a 2FA code is far worse than not filling at all.
 *  - `fillOtpField` writes the code and then **reads it back**. React installs its own
 *    value tracker on inputs and discards writes it did not originate, so a write that
 *    appears to succeed can vanish on the next render. The read-back is what lets the
 *    caller fall back to the manual suggestion pill instead of silently doing nothing.
 */

export interface OtpField {
  /** Element(s) to fill: one input, or an ordered group of single-character boxes. */
  elements: HTMLInputElement[];
  /** True when this is a split group of single-character boxes. */
  split: boolean;
  /** 0..1 — used to choose between competing candidates. */
  confidence: number;
}

/** Attribute text that suggests a field holds a one-time code. */
const OTP_HINT =
  /otp|one.?time|verification|verify|passcode|security.?code|auth.?code|\bcode\b|\bpin\b|2fa|mfa/i;

/**
 * Attribute text that vetoes a match. These overlap heavily with OTP_HINT
 * ("area code", "zip code", "promo code") and are the classic false positives — filling
 * a discount box with a login code is a visible, embarrassing failure.
 */
const OTP_VETO = /coupon|promo|discount|zip|postal|area.?code|country.?code/i;

/** Input types that could plausibly hold a code. Everything else is ignored outright. */
const FILLABLE_TYPES = new Set(["", "text", "tel", "number", "search", "password"]);

const MIN_GROUP = 4;
const MAX_GROUP = 8;

const C_AUTOCOMPLETE = 1;
const C_KEYWORD = 0.8;
const C_SPLIT = 0.6;
const C_WEAK = 0.3;

/** Finds the best OTP field, descending into open shadow roots. Null if none. */
export function findOtpField(root: Document | ShadowRoot): OtpField | null {
  const doc = ownerDocument(root);
  const layout = doc ? hasLayout(doc) : false;

  const inputs: HTMLInputElement[] = [];
  collectInputs(root, inputs);

  // Grouping is done over everything *visible*, not everything fillable: a six-box widget
  // with one box already typed into is still a six-box widget, and must be rejected as a
  // whole rather than silently degrading into a five-box group.
  const visible = inputs.filter((el) => isCandidateType(el) && isVisible(el, layout));
  const usable = visible.filter(isFillable);
  if (usable.length === 0) return null;

  const candidates: OtpField[] = [];
  const grouped = new Set<HTMLInputElement>();

  for (const group of splitGroups(visible)) {
    if (!group.every(isFillable)) continue;
    const confidence = groupConfidence(group);
    if (confidence === null) continue;
    for (const el of group) grouped.add(el);
    candidates.push({ elements: group, split: true, confidence });
  }

  for (const el of usable) {
    if (grouped.has(el)) continue;
    const confidence = singleConfidence(el);
    if (confidence === null || confidence === 0) continue;
    candidates.push({ elements: [el], split: false, confidence });
  }

  let best: OtpField | null = null;
  for (const candidate of candidates) {
    // Strictly greater: document order breaks ties, which keeps the first form on a
    // page winning over a duplicate further down.
    if (!best || candidate.confidence > best.confidence) best = candidate;
  }

  return best;
}

/** Fills the field. Returns true only if the value was verified present afterwards. */
export function fillOtpField(field: OtpField, code: string): boolean {
  if (!field || !Array.isArray(field.elements) || field.elements.length === 0) return false;
  if (typeof code !== "string" || code.length === 0) return false;

  const { elements, split } = field;

  if (split) {
    // Partial fills are worse than no fill: the user sees a half-typed code and cannot
    // tell whether the rest is coming.
    if (code.length !== elements.length) return false;
  } else if (elements.length !== 1) {
    return false;
  }

  // Never overwrite anything the user (or the site) already put there.
  if (elements.some((el) => el.value !== "")) return false;

  if (!split) {
    const el = elements[0];
    if (!el) return false;
    // A code longer than the field accepts would submit truncated. Refuse instead.
    if (el.maxLength > 0 && code.length > el.maxLength) return false;
    write(el, code);
    return el.value === code;
  }

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const char = code[i];
    if (!el || char === undefined) return false;
    // Write by index rather than trusting focus: many split-box widgets advance focus
    // themselves on input, so "the focused box" drifts out from under us.
    try {
      el.focus();
    } catch {
      /* focus is best-effort */
    }
    write(el, char);
  }

  return elements.every((el, i) => el.value === code[i]);
}

/* ------------------------------------------------------------------ writing */

function nativeValueSetter(): ((this: HTMLInputElement, v: string) => void) | null {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  return (desc?.set as ((this: HTMLInputElement, v: string) => void) | undefined) ?? null;
}

function write(el: HTMLInputElement, value: string): void {
  const setter = nativeValueSetter();
  if (setter) {
    // Bypasses any per-instance setter React installed to track the value.
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/* ---------------------------------------------------------------- traversal */

function ownerDocument(root: Document | ShadowRoot): Document | null {
  if (isDocument(root)) return root;
  return root.ownerDocument ?? null;
}

function isDocument(node: Document | ShadowRoot): node is Document {
  return node.nodeType === 9;
}

function collectInputs(root: Document | ShadowRoot | Element, out: HTMLInputElement[]): void {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (el.tagName === "INPUT") out.push(el as HTMLInputElement);
    // Closed roots are simply unreachable; that is expected and not worth working around.
    const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow) collectInputs(shadow, out);
  }
}

/* --------------------------------------------------------------- visibility */

/**
 * jsdom has no layout engine, so every rect is 0x0. Probing the root element tells us
 * whether rect-based size checks mean anything here; when they don't, we fall back to
 * style-only checks rather than declaring the whole page invisible.
 */
function hasLayout(doc: Document): boolean {
  const root = doc.documentElement;
  if (!root || typeof root.getBoundingClientRect !== "function") return false;
  const rect = root.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function isCandidateType(el: HTMLInputElement): boolean {
  return FILLABLE_TYPES.has((el.getAttribute("type") ?? "").toLowerCase());
}

function isFillable(el: HTMLInputElement): boolean {
  if (el.disabled || el.readOnly) return false;
  return el.value === "";
}

function isVisible(el: HTMLInputElement, layout: boolean): boolean {
  const view = el.ownerDocument?.defaultView;

  let node: Element | null = el;
  while (node) {
    if (node.hasAttribute("hidden")) return false;
    if (view && typeof view.getComputedStyle === "function") {
      const style = view.getComputedStyle(node);
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (isZero(style.width) && isZero(style.height)) return false;
    }
    node = parentOrHost(node);
  }

  if (layout && typeof el.getBoundingClientRect === "function") {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
  }

  return true;
}

function isZero(value: string | null | undefined): boolean {
  return value === "0px" || value === "0";
}

function parentOrHost(node: Element): Element | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode?.();
  if (root && (root as ShadowRoot).host) return (root as ShadowRoot).host;
  return null;
}

/* ------------------------------------------------------------------ scoring */

function attributeText(el: HTMLInputElement): string {
  return [
    el.getAttribute("name"),
    el.getAttribute("id"),
    el.getAttribute("aria-label"),
    el.getAttribute("placeholder"),
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
}

function hasOneTimeCode(el: HTMLInputElement): boolean {
  const value = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  return value.split(/\s+/).includes("one-time-code");
}

function isVetoed(el: HTMLInputElement): boolean {
  return OTP_VETO.test(attributeText(el));
}

/**
 * Confidence for one input on its own merits.
 * Returns `null` when the field is explicitly disqualified, `0` when it simply has no
 * OTP signal.
 */
function singleConfidence(el: HTMLInputElement): number | null {
  // The strongest possible signal: the site told us outright. Nothing overrides it.
  if (hasOneTimeCode(el)) return C_AUTOCOMPLETE;

  if (isVetoed(el)) return null;

  const type = (el.getAttribute("type") ?? "").toLowerCase();
  const text = attributeText(el);

  // Password fields are excluded from keyword matching: "password" boxes named
  // "verify_password" would otherwise look exactly like a verification code.
  if (type !== "password" && OTP_HINT.test(text)) return C_KEYWORD;

  const inputMode = (el.getAttribute("inputmode") ?? "").toLowerCase();
  const numeric = inputMode === "numeric" || type === "tel";
  const max = el.maxLength;
  if (numeric && max >= MIN_GROUP && max <= MAX_GROUP) return C_WEAK;

  return 0;
}

/** Confidence for a split-box group, or `null` when the group is disqualified. */
function groupConfidence(group: HTMLInputElement[]): number | null {
  let best = C_SPLIT;
  for (const el of group) {
    const single = singleConfidence(el);
    if (single === null) return null;
    if (single > best) best = single;
  }
  return best;
}

/* ------------------------------------------------------------------ grouping */

function isSingleChar(el: HTMLInputElement): boolean {
  if (el.maxLength === 1) return true;
  return el.getAttribute("size") === "1";
}

/**
 * Runs of adjacent single-character inputs. Two shapes are common in the wild:
 * bare siblings, and one-input-per-wrapper (`<div><input></div>` repeated), so both
 * count as "adjacent".
 */
function splitGroups(inputs: HTMLInputElement[]): HTMLInputElement[][] {
  const groups: HTMLInputElement[][] = [];
  let run: HTMLInputElement[] = [];

  const flush = (): void => {
    if (run.length >= MIN_GROUP && run.length <= MAX_GROUP) groups.push(run);
    run = [];
  };

  for (const el of inputs) {
    if (!isSingleChar(el)) {
      flush();
      continue;
    }
    const prev = run[run.length - 1];
    if (prev && !adjacent(prev, el)) flush();
    run.push(el);
  }
  flush();

  return groups;
}

function adjacent(a: HTMLInputElement, b: HTMLInputElement): boolean {
  const pa = a.parentElement;
  const pb = b.parentElement;
  if (!pa || !pb) return false;
  if (pa === pb) return true;
  // One wrapper element per box: the wrappers must themselves be siblings, and each
  // must hold exactly this one input.
  return (
    pa.parentElement !== null &&
    pa.parentElement === pb.parentElement &&
    pa.querySelectorAll("input").length === 1 &&
    pb.querySelectorAll("input").length === 1
  );
}

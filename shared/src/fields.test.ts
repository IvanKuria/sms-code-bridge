import { afterEach, describe, expect, it, vi } from "vitest";
import { fillOtpField, findOtpField, type OtpField } from "./fields.js";

/* ----------------------------------------------------------------- helpers */

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** Makes rect-based size checks meaningful, as they are in a real browser. */
function enableLayout(): void {
  vi.spyOn(document.documentElement, "getBoundingClientRect").mockReturnValue({
    width: 1024,
    height: 768,
    top: 0,
    left: 0,
    right: 1024,
    bottom: 768,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(HTMLInputElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 120,
    height: 32,
    top: 0,
    left: 0,
    right: 120,
    bottom: 32,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function zeroSize(el: Element): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/**
 * Simulates React's value tracker: an own property on the instance that swallows writes.
 * The native prototype setter still writes the internal slot, but every read comes back
 * through this getter — which is exactly how a silently-rejected fill looks.
 */
function rejectWrites(el: HTMLInputElement, reportAs = ""): void {
  Object.defineProperty(el, "value", {
    configurable: true,
    get: () => reportAs,
    set: () => {},
  });
}

function boxes(count: number, attrs = ""): string {
  return Array.from({ length: count }, () => `<input maxlength="1" ${attrs}>`).join("");
}

function inputs(field: OtpField | null): HTMLInputElement[] {
  return field?.elements ?? [];
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/* --------------------------------------------------------------- detection */

describe("findOtpField — autocomplete", () => {
  it("finds autocomplete=one-time-code with full confidence", () => {
    mount(`<input autocomplete="one-time-code">`);
    const field = findOtpField(document);
    expect(field?.confidence).toBe(1);
    expect(field?.split).toBe(false);
    expect(inputs(field)).toHaveLength(1);
  });

  it("matches one-time-code inside a token list", () => {
    mount(`<input autocomplete="off one-time-code">`);
    expect(findOtpField(document)?.confidence).toBe(1);
  });

  it("is case-insensitive about the autocomplete token", () => {
    mount(`<input autocomplete="One-Time-Code">`);
    expect(findOtpField(document)?.confidence).toBe(1);
  });

  it("does not match autocomplete=off alone", () => {
    mount(`<input autocomplete="off">`);
    expect(findOtpField(document)).toBeNull();
  });

  it("beats a keyword match elsewhere on the page", () => {
    mount(`<input name="verification_code"><input autocomplete="one-time-code" id="real">`);
    expect(inputs(findOtpField(document))[0]?.id).toBe("real");
  });
});

describe("findOtpField — attribute keywords", () => {
  const hits = [
    `<input name="otp">`,
    `<input name="one_time_password">`,
    `<input id="verificationCode">`,
    `<input id="verify-input">`,
    `<input aria-label="Passcode">`,
    `<input aria-label="Security code">`,
    `<input placeholder="Auth code">`,
    `<input placeholder="Enter code">`,
    `<input name="pin">`,
    `<input name="2fa_token">`,
    `<input name="mfa_input">`,
  ];

  for (const html of hits) {
    it(`matches ${html}`, () => {
      mount(html);
      const field = findOtpField(document);
      expect(field).not.toBeNull();
      expect(field?.confidence).toBe(0.8);
    });
  }

  it("ignores a plain unlabelled text input", () => {
    mount(`<input type="text" name="username" placeholder="Username">`);
    expect(findOtpField(document)).toBeNull();
  });

  it("does not match 'code' embedded in another word", () => {
    mount(`<input name="decoder">`);
    expect(findOtpField(document)).toBeNull();
  });

  it("does not treat a password field's keyword text as an OTP", () => {
    mount(`<input type="password" name="verify_password">`);
    expect(findOtpField(document)).toBeNull();
  });

  it("still honours one-time-code on a password-typed field", () => {
    mount(`<input type="password" autocomplete="one-time-code">`);
    expect(findOtpField(document)?.confidence).toBe(1);
  });
});

describe("findOtpField — false-positive guards", () => {
  const vetoed = [
    `<input name="coupon_code" placeholder="Coupon code">`,
    `<input name="promo_code" placeholder="Promo code">`,
    `<input name="discount_code">`,
    `<input name="zip" placeholder="ZIP code">`,
    `<input name="postal_code">`,
    `<input name="area_code" inputmode="numeric" maxlength="4">`,
    `<input name="areacode">`,
    `<input name="country-code" type="tel" maxlength="4">`,
  ];

  for (const html of vetoed) {
    it(`rejects ${html}`, () => {
      mount(html);
      expect(findOtpField(document)).toBeNull();
    });
  }

  it("picks the real OTP field over an adjacent coupon box", () => {
    mount(`
      <input name="promo_code" placeholder="Promo code">
      <input name="verification_code" id="otp">
    `);
    expect(inputs(findOtpField(document))[0]?.id).toBe("otp");
  });

  it("vetoes a split group whose boxes are labelled as a zip", () => {
    mount(`<div>${boxes(5, 'aria-label="zip digit"')}</div>`);
    expect(findOtpField(document)).toBeNull();
  });
});

describe("findOtpField — split boxes", () => {
  it("groups six adjacent single-character siblings", () => {
    mount(`<div>${boxes(6)}</div>`);
    const field = findOtpField(document);
    expect(field?.split).toBe(true);
    expect(inputs(field)).toHaveLength(6);
    expect(field?.confidence).toBe(0.6);
  });

  it("accepts the minimum group size of four", () => {
    mount(`<div>${boxes(4)}</div>`);
    expect(inputs(findOtpField(document))).toHaveLength(4);
  });

  it("accepts the maximum group size of eight", () => {
    mount(`<div>${boxes(8)}</div>`);
    expect(inputs(findOtpField(document))).toHaveLength(8);
  });

  it("rejects a run of three", () => {
    mount(`<div>${boxes(3)}</div>`);
    expect(findOtpField(document)).toBeNull();
  });

  it("rejects a run of nine", () => {
    mount(`<div>${boxes(9)}</div>`);
    expect(findOtpField(document)).toBeNull();
  });

  it("recognises size=1 boxes as well as maxlength=1", () => {
    mount(`<div>${Array.from({ length: 6 }, () => `<input size="1">`).join("")}</div>`);
    expect(inputs(findOtpField(document))).toHaveLength(6);
  });

  it("groups one-input-per-wrapper markup", () => {
    mount(
      `<div>${Array.from({ length: 6 }, () => `<span><input maxlength="1"></span>`).join("")}</div>`,
    );
    const field = findOtpField(document);
    expect(field?.split).toBe(true);
    expect(inputs(field)).toHaveLength(6);
  });

  it("does not merge two separate groups in different parents", () => {
    mount(`<div>${boxes(4)}</div><div>${boxes(4)}</div>`);
    const field = findOtpField(document);
    expect(inputs(field)).toHaveLength(4);
  });

  it("keeps the boxes in document order", () => {
    mount(
      `<div>${Array.from({ length: 6 }, (_, i) => `<input maxlength="1" id="b${i}">`).join("")}</div>`,
    );
    expect(inputs(findOtpField(document)).map((el) => el.id)).toEqual([
      "b0",
      "b1",
      "b2",
      "b3",
      "b4",
      "b5",
    ]);
  });

  it("skips a group where one box is already filled", () => {
    mount(`<div>${boxes(6)}</div>`);
    const first = document.querySelector("input");
    if (first) (first as HTMLInputElement).value = "9";
    expect(findOtpField(document)).toBeNull();
  });

  it("skips a group containing a disabled box rather than shrinking it", () => {
    mount(`<div>${boxes(5)}<input maxlength="1" disabled></div>`);
    expect(findOtpField(document)).toBeNull();
  });

  it("skips a group containing a readonly box", () => {
    mount(`<div><input maxlength="1" readonly>${boxes(5)}</div>`);
    expect(findOtpField(document)).toBeNull();
  });

  it("does not group boxes separated by an unrelated input", () => {
    mount(`<div>${boxes(3)}<input name="other">${boxes(3)}</div>`);
    expect(findOtpField(document)).toBeNull();
  });

  it("inherits full confidence when a box carries one-time-code", () => {
    mount(`<div><input maxlength="1" autocomplete="one-time-code">${boxes(5)}</div>`);
    const field = findOtpField(document);
    expect(field?.split).toBe(true);
    expect(field?.confidence).toBe(1);
  });

  it("outranks a weak numeric single input", () => {
    mount(`<input inputmode="numeric" maxlength="6" id="weak"><div>${boxes(6)}</div>`);
    const field = findOtpField(document);
    expect(field?.split).toBe(true);
  });
});

describe("findOtpField — weak numeric signal", () => {
  it("accepts inputmode=numeric with maxlength in range", () => {
    mount(`<input inputmode="numeric" maxlength="6">`);
    expect(findOtpField(document)?.confidence).toBe(0.3);
  });

  it("accepts type=tel with maxlength in range", () => {
    mount(`<input type="tel" maxlength="4">`);
    expect(findOtpField(document)?.confidence).toBe(0.3);
  });

  it("rejects numeric input with maxlength out of range", () => {
    mount(`<input inputmode="numeric" maxlength="16">`);
    expect(findOtpField(document)).toBeNull();
  });

  it("rejects numeric input with no maxlength at all", () => {
    mount(`<input inputmode="numeric">`);
    expect(findOtpField(document)).toBeNull();
  });

  it("loses to a keyword match", () => {
    mount(`<input type="tel" maxlength="6"><input name="otp" id="strong">`);
    expect(inputs(findOtpField(document))[0]?.id).toBe("strong");
  });
});

describe("findOtpField — skipping unusable inputs", () => {
  it("skips type=hidden", () => {
    mount(`<input type="hidden" name="otp">`);
    expect(findOtpField(document)).toBeNull();
  });

  it("skips disabled inputs", () => {
    mount(`<input name="otp" disabled>`);
    expect(findOtpField(document)).toBeNull();
  });

  it("skips readonly inputs", () => {
    mount(`<input name="otp" readonly>`);
    expect(findOtpField(document)).toBeNull();
  });

  it("skips inputs that already have a value", () => {
    mount(`<input name="otp">`);
    const el = document.querySelector("input") as HTMLInputElement;
    el.value = "123456";
    expect(findOtpField(document)).toBeNull();
  });

  it("skips display:none", () => {
    mount(`<input name="otp" style="display:none">`);
    expect(findOtpField(document)).toBeNull();
  });

  it("skips visibility:hidden", () => {
    mount(`<input name="otp" style="visibility:hidden">`);
    expect(findOtpField(document)).toBeNull();
  });

  it("skips an input inside a display:none ancestor", () => {
    mount(`<div style="display:none"><input name="otp"></div>`);
    expect(findOtpField(document)).toBeNull();
  });

  it("skips an input under the hidden attribute", () => {
    mount(`<div hidden><input name="otp"></div>`);
    expect(findOtpField(document)).toBeNull();
  });

  it("skips zero-sized inputs when layout is available", () => {
    mount(`<input name="otp">`);
    enableLayout();
    const el = document.querySelector("input") as HTMLInputElement;
    zeroSize(el);
    expect(findOtpField(document)).toBeNull();
  });

  it("keeps a laid-out input when layout is available", () => {
    mount(`<input name="otp">`);
    enableLayout();
    expect(findOtpField(document)).not.toBeNull();
  });

  it("skips non-text input types even when named like a code", () => {
    mount(`
      <input type="checkbox" name="otp">
      <input type="submit" name="verification code">
      <input type="date" name="security code">
    `);
    expect(findOtpField(document)).toBeNull();
  });

  it("picks the visible field when a hidden decoy comes first", () => {
    mount(`<input type="hidden" name="otp"><input name="otp" id="real">`);
    expect(inputs(findOtpField(document))[0]?.id).toBe("real");
  });

  it("returns null for an empty document", () => {
    mount("");
    expect(findOtpField(document)).toBeNull();
  });
});

describe("findOtpField — shadow DOM", () => {
  it("finds a field inside an open shadow root", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" }).innerHTML = `<input autocomplete="one-time-code">`;
    expect(findOtpField(document)?.confidence).toBe(1);
  });

  it("finds a field nested two shadow roots deep", () => {
    const outer = document.createElement("div");
    document.body.appendChild(outer);
    const outerRoot = outer.attachShadow({ mode: "open" });
    const inner = document.createElement("div");
    outerRoot.appendChild(inner);
    inner.attachShadow({ mode: "open" }).innerHTML = `<input name="otp">`;
    expect(findOtpField(document)).not.toBeNull();
  });

  it("cannot see into a closed shadow root", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.attachShadow({ mode: "closed" }).innerHTML = `<input autocomplete="one-time-code">`;
    expect(findOtpField(document)).toBeNull();
  });

  it("accepts a ShadowRoot as the search root", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<div>${boxes(6)}</div>`;
    const field = findOtpField(root);
    expect(field?.split).toBe(true);
    expect(inputs(field)).toHaveLength(6);
  });

  it("groups split boxes that live inside a shadow root", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" }).innerHTML = `<div>${boxes(6)}</div>`;
    expect(inputs(findOtpField(document))).toHaveLength(6);
  });

  it("respects display:none on the shadow host", () => {
    const host = document.createElement("div");
    host.style.display = "none";
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" }).innerHTML = `<input name="otp">`;
    expect(findOtpField(document)).toBeNull();
  });

  it("does not merge boxes across a shadow boundary", () => {
    const host = document.createElement("div");
    document.body.innerHTML = `<div>${boxes(2)}</div>`;
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" }).innerHTML = `<div>${boxes(2)}</div>`;
    expect(findOtpField(document)).toBeNull();
  });
});

/* ------------------------------------------------------------------ filling */

describe("fillOtpField — single input", () => {
  it("writes the code and reports success", () => {
    mount(`<input autocomplete="one-time-code">`);
    const field = findOtpField(document) as OtpField;
    expect(fillOtpField(field, "123456")).toBe(true);
    expect(field.elements[0]?.value).toBe("123456");
  });

  it("uses the native prototype setter, bypassing an instance setter", () => {
    mount(`<input autocomplete="one-time-code">`);
    const el = document.querySelector("input") as HTMLInputElement;
    const nativeGet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.get;
    expect(nativeGet).toBeTypeOf("function");

    // React-style instance property: reads pass through, writes are discarded. An
    // implementation doing `el.value = code` fails here; one using the prototype setter
    // does not.
    let discarded = 0;
    Object.defineProperty(el, "value", {
      configurable: true,
      get(this: HTMLInputElement) {
        return nativeGet?.call(this) as string;
      },
      set() {
        discarded++;
      },
    });

    const field: OtpField = { elements: [el], split: false, confidence: 1 };
    expect(fillOtpField(field, "424242")).toBe(true);
    expect(discarded).toBe(0);
  });

  it("dispatches bubbling input and change events, in that order", () => {
    mount(`<form><input autocomplete="one-time-code"></form>`);
    const field = findOtpField(document) as OtpField;
    const order: string[] = [];
    // Listening on the form proves the events bubble.
    const form = document.querySelector("form") as HTMLFormElement;
    form.addEventListener("input", (e) => order.push(`input:${e.bubbles}`));
    form.addEventListener("change", (e) => order.push(`change:${e.bubbles}`));
    fillOtpField(field, "123456");
    expect(order).toEqual(["input:true", "change:true"]);
  });

  it("returns false when the write is silently discarded", () => {
    mount(`<input autocomplete="one-time-code">`);
    const el = document.querySelector("input") as HTMLInputElement;
    const field: OtpField = { elements: [el], split: false, confidence: 1 };
    rejectWrites(el);
    expect(fillOtpField(field, "123456")).toBe(false);
  });

  it("returns false when the value is rewritten to something else", () => {
    mount(`<input autocomplete="one-time-code">`);
    const el = document.querySelector("input") as HTMLInputElement;
    const field: OtpField = { elements: [el], split: false, confidence: 1 };
    rejectWrites(el, "000000");
    expect(fillOtpField(field, "123456")).toBe(false);
  });

  it("refuses to overwrite a non-empty field", () => {
    mount(`<input autocomplete="one-time-code">`);
    const el = document.querySelector("input") as HTMLInputElement;
    el.value = "999999";
    const field: OtpField = { elements: [el], split: false, confidence: 1 };
    expect(fillOtpField(field, "123456")).toBe(false);
    expect(el.value).toBe("999999");
  });

  it("refuses a code longer than the field's maxlength", () => {
    mount(`<input autocomplete="one-time-code" maxlength="4">`);
    const field = findOtpField(document) as OtpField;
    expect(fillOtpField(field, "123456")).toBe(false);
    expect(field.elements[0]?.value).toBe("");
  });

  it("allows a code exactly at the maxlength", () => {
    mount(`<input autocomplete="one-time-code" maxlength="6">`);
    const field = findOtpField(document) as OtpField;
    expect(fillOtpField(field, "123456")).toBe(true);
  });

  it("returns false for an empty code", () => {
    mount(`<input autocomplete="one-time-code">`);
    const field = findOtpField(document) as OtpField;
    expect(fillOtpField(field, "")).toBe(false);
  });

  it("returns false for a field with no elements", () => {
    expect(fillOtpField({ elements: [], split: false, confidence: 1 }, "123456")).toBe(false);
  });

  it("returns false when a non-split field somehow holds several inputs", () => {
    mount(`<input><input>`);
    const els = Array.from(document.querySelectorAll("input"));
    expect(fillOtpField({ elements: els, split: false, confidence: 1 }, "12")).toBe(false);
    expect(els[0]?.value).toBe("");
  });
});

describe("fillOtpField — split boxes", () => {
  it("writes one character per box in order", () => {
    mount(`<div>${boxes(6)}</div>`);
    const field = findOtpField(document) as OtpField;
    expect(fillOtpField(field, "482910")).toBe(true);
    expect(field.elements.map((el) => el.value).join("")).toBe("482910");
  });

  it("dispatches input and change for every box", () => {
    mount(`<div>${boxes(6)}</div>`);
    const field = findOtpField(document) as OtpField;
    let inputEvents = 0;
    let changeEvents = 0;
    document.body.addEventListener("input", () => inputEvents++);
    document.body.addEventListener("change", () => changeEvents++);
    fillOtpField(field, "482910");
    expect(inputEvents).toBe(6);
    expect(changeEvents).toBe(6);
  });

  it("focuses each box before writing", () => {
    mount(`<div>${boxes(4)}</div>`);
    const field = findOtpField(document) as OtpField;
    const focused: number[] = [];
    field.elements.forEach((el, i) => {
      vi.spyOn(el, "focus").mockImplementation(() => focused.push(i));
    });
    fillOtpField(field, "1234");
    expect(focused).toEqual([0, 1, 2, 3]);
  });

  it("writes by index even when the widget steals focus", () => {
    mount(`<div>${boxes(6)}</div>`);
    const field = findOtpField(document) as OtpField;
    // Auto-advance behaviour: every input event yanks focus to the last box.
    const last = field.elements[5] as HTMLInputElement;
    document.body.addEventListener("input", () => last.focus());
    expect(fillOtpField(field, "135790")).toBe(true);
    expect(field.elements.map((el) => el.value).join("")).toBe("135790");
  });

  it("refuses when the code is shorter than the box count", () => {
    mount(`<div>${boxes(6)}</div>`);
    const field = findOtpField(document) as OtpField;
    expect(fillOtpField(field, "1234")).toBe(false);
    expect(field.elements.every((el) => el.value === "")).toBe(true);
  });

  it("refuses when the code is longer than the box count", () => {
    mount(`<div>${boxes(4)}</div>`);
    const field = findOtpField(document) as OtpField;
    expect(fillOtpField(field, "123456")).toBe(false);
    expect(field.elements.every((el) => el.value === "")).toBe(true);
  });

  it("returns false when one box rejects its write", () => {
    mount(`<div>${boxes(6)}</div>`);
    const field = findOtpField(document) as OtpField;
    // One box behaves like a React-controlled input that discards the write.
    rejectWrites(field.elements[3] as HTMLInputElement);
    expect(fillOtpField(field, "482910")).toBe(false);
    // The other boxes were still written — the caller falls back to the manual pill.
    expect(field.elements[0]?.value).toBe("4");
  });

  it("refuses when any box already holds a character", () => {
    mount(`<div>${boxes(6)}</div>`);
    const els = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
    const field: OtpField = { elements: els, split: true, confidence: 0.6 };
    els[2]!.value = "7";
    expect(fillOtpField(field, "482910")).toBe(false);
    expect(els[0]?.value).toBe("");
  });

  it("fills boxes inside a shadow root", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" }).innerHTML = `<div>${boxes(6)}</div>`;
    const field = findOtpField(document) as OtpField;
    expect(fillOtpField(field, "246813")).toBe(true);
    expect(field.elements.map((el) => el.value).join("")).toBe("246813");
  });

  it("handles alphanumeric codes one character at a time", () => {
    mount(`<div>${boxes(6)}</div>`);
    const field = findOtpField(document) as OtpField;
    expect(fillOtpField(field, "A1B2C3")).toBe(true);
    expect(field.elements.map((el) => el.value).join("")).toBe("A1B2C3");
  });
});

describe("end to end", () => {
  it("detects and fills a realistic six-box widget in a shadow root", () => {
    const host = document.createElement("otp-widget");
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" }).innerHTML = `
      <form>
        <label>Enter the code we texted you</label>
        <div class="boxes">
          ${Array.from(
            { length: 6 },
            (_, i) =>
              `<span class="box"><input inputmode="numeric" maxlength="1" aria-label="Digit ${i + 1}"></span>`,
          ).join("")}
        </div>
        <input type="hidden" name="csrf">
        <button type="submit">Verify</button>
      </form>
    `;
    const field = findOtpField(document);
    expect(field?.split).toBe(true);
    expect(inputs(field)).toHaveLength(6);
    expect(fillOtpField(field as OtpField, "907154")).toBe(true);
    expect(inputs(field)
      .map((el) => el.value)
      .join("")).toBe("907154");
  });

  it("detects and fills a realistic single-input form", () => {
    mount(`
      <form>
        <input type="text" name="username" placeholder="Username">
        <input type="password" name="password" placeholder="Password">
        <input type="text" name="promo" placeholder="Promo code">
        <input type="tel" name="verificationCode" autocomplete="one-time-code"
               inputmode="numeric" maxlength="6" placeholder="6-digit code">
      </form>
    `);
    const field = findOtpField(document);
    expect(field?.confidence).toBe(1);
    expect(inputs(field)[0]?.getAttribute("name")).toBe("verificationCode");
    expect(fillOtpField(field as OtpField, "334455")).toBe(true);
  });
});

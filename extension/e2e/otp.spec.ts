import { deliver, expect, pillHost, test } from "./harness";

const CODE = "483920";

test.describe("silent fill (origin-bound codes)", () => {
  test("fills silently when the sigil domain matches the origin", async ({ background, open }) => {
    const page = await open("example.com", "/autocomplete");
    const handled = await deliver(background, page, {
      code: CODE,
      domain: "example.com",
      originBound: true,
    });

    expect(handled).toBe(true);
    await expect(page.locator("#otp")).toHaveValue(CODE);
    // Nothing to click: a trusted code fills without asking.
    expect((await pillHost(page)).present).toBe(false);
  });

  test("fills on a subdomain of the bound domain", async ({ background, open }) => {
    const page = await open("login.example.com", "/autocomplete");
    await deliver(background, page, { code: CODE, domain: "example.com", originBound: true });
    await expect(page.locator("#otp")).toHaveValue(CODE);
  });

  test("refuses to fill when the sigil domain does not match", async ({ background, open }) => {
    // The phishing case: a code minted for example.com arriving on a lookalike host.
    const page = await open("example-secure.net", "/autocomplete");
    const handled = await deliver(background, page, {
      code: CODE,
      domain: "example.com",
      originBound: true,
    });

    expect(handled).toBe(true);
    await expect(page.locator("#otp")).toHaveValue("");
    expect((await pillHost(page)).present).toBe(true);
  });
});

test.describe("focus-based autofill", () => {
  // Almost no services send domain-bound codes, so requiring the sigil meant nothing was
  // ever filled silently. Focus is the signal that actually exists.
  test("fills silently when the caret is in the field, with no sigil", async ({
    background,
    open,
  }) => {
    const page = await open("example.com", "/autocomplete");
    await page.locator("#otp").focus();

    const handled = await deliver(background, page, { code: CODE });

    expect(handled).toBe(true);
    await expect(page.locator("#otp")).toHaveValue(CODE);
    expect((await pillHost(page)).present).toBe(false);
  });

  test("fills silently when focus is in a split-box group", async ({ background, open }) => {
    // Split boxes carry no telling attributes, so this only works because the check asks
    // whether the focused element is part of the detected field.
    const page = await open("example.com", "/split-siblings");
    await page.locator('.box[data-i="0"]').focus();

    await deliver(background, page, { code: CODE });

    for (let i = 0; i < 6; i++) {
      await expect(page.locator(`.box[data-i="${i}"]`)).toHaveValue(CODE[i]!);
    }
    expect((await pillHost(page)).present).toBe(false);
  });

  test("a domain mismatch is never filled silently, even when focused", async ({
    background,
    open,
  }) => {
    // Being focused on the field is exactly what a phishing victim would be doing.
    const page = await open("example-secure.net", "/autocomplete");
    await page.locator("#otp").focus();

    await deliver(background, page, {
      code: CODE,
      domain: "example.com",
      originBound: true,
    });

    await expect(page.locator("#otp")).toHaveValue("");
    expect((await pillHost(page)).present).toBe(true);
  });
});

test.describe("suggestion pill (unverified codes)", () => {
  test("offers rather than fills when there is no sigil", async ({ background, open }) => {
    const page = await open("example.com", "/autocomplete");
    const handled = await deliver(background, page, { code: CODE });

    expect(handled).toBe(true);
    await expect(page.locator("#otp")).toHaveValue("");
    expect((await pillHost(page)).present).toBe(true);
  });

  test("the pill's shadow root is closed to page scripts", async ({ background, open }) => {
    const page = await open("example.com", "/autocomplete");
    await deliver(background, page, { code: CODE });

    const host = await pillHost(page);
    expect(host.present).toBe(true);
    // If this ever flips to true, a malicious page can read the code out of our own UI
    // before the user clicks anything.
    expect(host.pierceable).toBe(false);
  });
});

test.describe("field detection", () => {
  test("finds a keyword-named field with no autocomplete attribute", async ({
    background,
    open,
  }) => {
    const page = await open("example.com", "/keyword");
    await deliver(background, page, { code: CODE, domain: "example.com", originBound: true });
    await expect(page.locator("#otp")).toHaveValue(CODE);
  });

  test("fills six sibling boxes, one character each", async ({ background, open }) => {
    const page = await open("example.com", "/split-siblings");
    await deliver(background, page, { code: CODE, domain: "example.com", originBound: true });

    for (let i = 0; i < 6; i++) {
      await expect(page.locator(`.box[data-i="${i}"]`)).toHaveValue(CODE[i]!);
    }
  });

  test("fills six wrapped boxes", async ({ background, open }) => {
    const page = await open("example.com", "/split-wrapped");
    await deliver(background, page, { code: CODE, domain: "example.com", originBound: true });

    for (let i = 0; i < 6; i++) {
      await expect(page.locator(`.box[data-i="${i}"]`)).toHaveValue(CODE[i]!);
    }
  });

  test("does not fill a coupon box", async ({ background, open }) => {
    const page = await open("example.com", "/coupon");
    const handled = await deliver(background, page, {
      code: CODE,
      domain: "example.com",
      originBound: true,
    });

    // No OTP field here at all, so the content script hands back to the notification path.
    expect(handled).toBe(false);
    await expect(page.locator("#coupon")).toHaveValue("");
  });

  test("does not overwrite a field the user already filled", async ({ background, open }) => {
    const page = await open("example.com", "/prefilled");
    await deliver(background, page, { code: CODE, domain: "example.com", originBound: true });
    await expect(page.locator("#otp")).toHaveValue("000000");
  });

  test("refuses a code longer than the field's maxlength", async ({ background, open }) => {
    // The native value setter bypasses maxlength, so filling here would silently submit
    // a truncated code.
    const page = await open("example.com", "/short");
    await deliver(background, page, { code: CODE, domain: "example.com", originBound: true });
    await expect(page.locator("#otp")).toHaveValue("");
  });
});

test.describe("regressions", () => {
  test("showing the pill does not retrigger our own MutationObserver", async ({
    background,
    open,
  }) => {
    // Appending the pill mutates the DOM. With a code still pending, the observer
    // rescans, shows the pill again, mutates again — an unbounded loop that hangs the
    // page with "Maximum call stack size exceeded".
    const page = await open("example.com", "/autocomplete");
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await deliver(background, page, { code: CODE });
    await page.waitForTimeout(500);

    expect(errors).toEqual([]);

    // Exactly one pill, not a pile of them.
    const hostCount = await page.evaluate(
      () =>
        Array.from(document.documentElement.children).filter(
          (el) => el.tagName === "DIV" && (el as HTMLElement).style.position === "fixed",
        ).length,
    );
    expect(hostCount).toBe(1);

    // The page is still responsive rather than wedged in a microtask loop.
    expect(await page.evaluate(() => 1 + 1)).toBe(2);
  });
});

test.describe("timing", () => {
  test("fills a field that appears after the code arrives", async ({ background, open }) => {
    const page = await open("example.com", "/late");

    // The field is injected 600ms in; the code lands first.
    const handled = await deliver(background, page, {
      code: CODE,
      domain: "example.com",
      originBound: true,
    });
    expect(handled).toBe(false); // nothing to fill yet

    // The MutationObserver picks it up when it appears.
    await expect(page.locator("#otp")).toHaveValue(CODE, { timeout: 5000 });
  });
});

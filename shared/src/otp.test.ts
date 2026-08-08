import { describe, expect, it } from "vitest";
import { extractOtp } from "./otp.js";

describe("origin-bound codes", () => {
  it("parses the sigil form from the last line", () => {
    expect(
      extractOtp("Your verification code is 123456\n\n@example.com #123456"),
    ).toEqual({ code: "123456", domain: "example.com", originBound: true });
  });

  it("trusts the sigil over a different number in the body", () => {
    // The body mentions 30 minutes; the sigil is authoritative.
    expect(
      extractOtp("Code 998877 expires in 30 minutes.\n@bank.co.uk #998877"),
    ).toEqual({ code: "998877", domain: "bank.co.uk", originBound: true });
  });

  it("ignores a sigil that is not on the last line", () => {
    const r = extractOtp("@example.com #111111\nYour code is 222222");
    expect(r?.originBound).toBe(false);
    expect(r?.code).toBe("222222");
  });

  it("handles a subdomain host", () => {
    expect(extractOtp("Hi\n@login.example.com #4821")).toEqual({
      code: "4821",
      domain: "login.example.com",
      originBound: true,
    });
  });
});

describe("keyword-anchored extraction", () => {
  const cases: Array<[string, string]> = [
    ["Your Amazon code is 123456", "123456"],
    ["G-628391 is your Google verification code.", "628391"],
    ["482910 is your Uber code.", "482910"],
    ["Your one-time passcode: 5813", "5813"],
    ["PIN: 9021. Do not share.", "9021"],
    ["Use OTP 74920 to log in", "74920"],
    ["Your verification code is 12345678", "12345678"],
    ["Chase: Your identification code is 84021.", "84021"],
  ];

  it.each(cases)("extracts from %j", (body, expected) => {
    expect(extractOtp(body)?.code).toBe(expected);
  });
});

describe("distractor numbers", () => {
  it("ignores a duration following the code", () => {
    expect(extractOtp("Your code is 445566, expires in 10 minutes")?.code).toBe(
      "445566",
    );
  });

  it("ignores a duration preceding the code", () => {
    expect(
      extractOtp("Valid for 15 minutes: your login code is 730192")?.code,
    ).toBe("730192");
  });

  it("ignores a currency amount", () => {
    expect(
      extractOtp("Approve $4500 transfer. Code 616263 to confirm.")?.code,
    ).toBe("616263");
  });

  it("ignores a year", () => {
    expect(extractOtp("Offer ends 2026. Your code is 909090")?.code).toBe(
      "909090",
    );
  });

  it("does not return a bare year with no code present", () => {
    expect(extractOtp("Your subscription renews in 2027.")).toBeNull();
  });

  it("does not treat a support phone number as a code", () => {
    expect(extractOtp("Questions? Call 555-1234 anytime.")).toBeNull();
  });
});

describe("split codes", () => {
  it("joins a space-separated code when a keyword anchors it", () => {
    expect(extractOtp("Your code is 123 456")?.code).toBe("123456");
  });

  it("joins a hyphen-separated code when a keyword anchors it", () => {
    expect(extractOtp("Verification code: 482-910")?.code).toBe("482910");
  });

  it("refuses to join a separated run with no keyword", () => {
    // "10 - 15" must not become 1015.
    expect(extractOtp("Delivery window is 10 - 15 today")).toBeNull();
  });

  it("refuses a phone-shaped 3-4 split even when a keyword precedes it", () => {
    // "code" vouches for the run, but NXX-XXXX is a local phone number, not a code.
    expect(extractOtp("Call support code 555-1234")).toBeNull();
    expect(extractOtp("Questions? Your reference code, call 800-1234")).toBeNull();
  });

  it("still joins even-group splits that a keyword vouches for", () => {
    expect(extractOtp("Your code is 1234 5678")?.code).toBe("12345678");
    expect(extractOtp("Your code is 482 910")?.code).toBe("482910");
  });

  it("handles a code at the end of a sentence", () => {
    // The most common OTP shape in existence; a trailing period must not defeat it.
    expect(extractOtp("Your verification code is 483921.")?.code).toBe("483921");
    expect(extractOtp("Your code is 483921. Expires in 10 minutes.")?.code).toBe("483921");
  });
});

describe("rejection", () => {
  it("returns null when there is no digit run at all", () => {
    expect(extractOtp("Hey, are we still on for dinner?")).toBeNull();
  });

  it("returns null for runs shorter than four digits", () => {
    expect(extractOtp("Your code is 12")).toBeNull();
  });

  it("returns null for runs longer than eight digits", () => {
    expect(extractOtp("Order 1234567890123 has shipped")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(extractOtp("")).toBeNull();
  });
});

describe("preferences", () => {
  it("prefers the keyword-anchored run over an unanchored one", () => {
    expect(extractOtp("Order 88991122 update. Your code is 4455")?.code).toBe(
      "4455",
    );
  });

  it("prefers a six-digit run when nothing else distinguishes them", () => {
    expect(extractOtp("Ref 4821 / 930177")?.code).toBe("930177");
  });
});

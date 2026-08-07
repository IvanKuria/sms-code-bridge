/**
 * OTP field shapes seen in the wild. These double as the E2E fixtures and as a record of
 * what Spike 3's survey turned up, so add a shape here whenever a real site breaks us.
 */

const page = (title: string, body: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body><form>${body}</form></body></html>`;

/** The ideal case: the site tells us outright. */
export const AUTOCOMPLETE = page(
  "autocomplete",
  `<input id="otp" autocomplete="one-time-code" inputmode="numeric">`,
);

/** No autocomplete attribute; we have to infer from the name. */
export const KEYWORD_ONLY = page(
  "keyword",
  `<input id="otp" name="verification_code" inputmode="numeric" maxlength="6">`,
);

/** Six single-character boxes, bare siblings. */
export const SPLIT_SIBLINGS = page(
  "split-siblings",
  `<div id="boxes">${Array.from(
    { length: 6 },
    (_, i) => `<input class="box" data-i="${i}" maxlength="1" inputmode="numeric">`,
  ).join("")}</div>`,
);

/** Six boxes, each in its own wrapper — at least as common as bare siblings. */
export const SPLIT_WRAPPED = page(
  "split-wrapped",
  `<div id="boxes">${Array.from(
    { length: 6 },
    (_, i) => `<span><input class="box" data-i="${i}" maxlength="1"></span>`,
  ).join("")}</div>`,
);

/** The classic false positive: a discount box that matches on "code". */
export const COUPON_ONLY = page(
  "coupon",
  `<input id="coupon" name="promo_code" placeholder="Discount code">`,
);

/** An OTP field that appears only after the code has already arrived. */
export const LATE_FIELD = page(
  "late",
  `<div id="slot"></div>
   <script>
     setTimeout(() => {
       document.getElementById('slot').innerHTML =
         '<input id="otp" autocomplete="one-time-code">';
     }, 600);
   </script>`,
);

/** The user got there first. We must not clobber what they typed. */
export const PREFILLED = page(
  "prefilled",
  `<input id="otp" autocomplete="one-time-code" value="000000">`,
);

/** Field length shorter than the code: filling would submit a truncated code. */
export const SHORT_MAXLENGTH = page(
  "short",
  `<input id="otp" autocomplete="one-time-code" maxlength="4">`,
);

export const FIXTURES: Record<string, string> = {
  "/autocomplete": AUTOCOMPLETE,
  "/keyword": KEYWORD_ONLY,
  "/split-siblings": SPLIT_SIBLINGS,
  "/split-wrapped": SPLIT_WRAPPED,
  "/coupon": COUPON_ONLY,
  "/late": LATE_FIELD,
  "/prefilled": PREFILLED,
  "/short": SHORT_MAXLENGTH,
};

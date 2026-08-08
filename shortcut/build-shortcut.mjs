#!/usr/bin/env node
/**
 * Builds the iPhone side of the OTP bridge as an importable Apple Shortcut.
 *
 * `shortcut/README.md` is the specification: four editor rows, three of which do work.
 * This script emits exactly those rows as a binary property list so the shortcut can be
 * handed to a user as a file/link instead of a twenty-step build-it-yourself document.
 *
 *   node shortcut/build-shortcut.mjs [relayUrl]
 *
 * Relay URL resolution order: argv[2] → $RELAY_URL → $WXT_RELAY_URL → extension/.env's
 * WXT_RELAY_URL. Nothing is hardcoded; the build fails loudly if none of those exist.
 *
 * ---------------------------------------------------------------------------------------
 * WHERE THE PLIST VOCABULARY CAME FROM
 *
 * A wrong-but-plausible plist signs fine and then does nothing on the phone, so every
 * identifier and parameter key below is cited. Three kinds of source, in descending order
 * of trust:
 *
 *   [apple]  Strings extracted from this machine's own WorkflowKit — either the bundled
 *            gallery workflows at
 *            /System/Library/PrivateFrameworks/WorkflowKit.framework/Resources/
 *              Gallery.bundle/Contents/Resources/*.wflow
 *            (real Apple-authored shortcuts; `plutil -convert xml1` reads them), or the
 *            WFActions.plist strings embedded in the dyld shared cache at
 *            /System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_arm64e.05
 *   [cherri] https://github.com/electrikmilk/cherri — a Shortcuts compiler whose
 *            actions_std.go / actions/*.cherri / shortcutgen.go encode the parameter keys
 *            and serialization wrappers.
 *   [docs]   https://zachary7829.github.io/blog/shortcuts/fileformat and
 *            https://github.com/sebj/iOS-Shortcuts-Reference — file-format overviews.
 * ---------------------------------------------------------------------------------------
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DIST = join(HERE, "dist");

/**
 * Shortcuts marks the position of an inline variable inside a string with U+FFFC OBJECT
 * REPLACEMENT CHARACTER, and describes what sits there in `attachmentsByRange`. One
 * codepoint of string, one entry keyed "{0, 1}".  [apple: DocumentReview.wflow]
 */
const OBJ = "￼";
const WHOLE_STRING_RANGE = "{0, 1}";

/** The Text action's UUID. Referenced by the import question and by the JSON body. */
const UUID_PAIRING_TEXT = "1A0F4E52-2C7B-4B8E-9E2A-6D5B0C1F7A31";
/** The Match Text action's UUID. Its output feeds the If and the `code` JSON field. */
const UUID_MATCHES = "2B1E5F63-3D8C-4C9F-8F3B-7E6C1D2A8B42";
/** The Get Contents of URL action's UUID. Nothing consumes it; present for completeness. */
const UUID_POST = "3C2A6074-4E9D-4DAF-9047-8F7D2E3B9C53";
/** The If action's closing row. Paired to the opening row by GroupingIdentifier. */
const UUID_ENDIF = "4D3B7185-5FAE-4EB0-A158-907E3F4CAD64";
/** Ties the `If` open/close rows together.  [apple: DocumentReview.wflow repeat.count] */
const GROUP_IF = "5E4C8296-60BF-4FC1-B269-A18F405BDE75";

/**
 * Verbatim from shortcut/README.md §3. Do not "tidy" this: the lookbehind is what keeps a
 * bare number in a non-OTP message from being sent, and the lookaheads are what keep
 * prices, durations and phone fragments out. Case sensitivity is switched off below, which
 * is why the keyword alternation is lowercase only.
 */
const OTP_REGEX =
  "(?<=\\b(?:code|otp|pin|passcode|password|verification|verify|token|auth|access)\\b[^\\d\\n]{0,25})(?<![$£€¥]\\s?)\\d{4,8}(?![\\d-])(?!\\.\\d)(?!\\s*(?:%|percent|minutes?|mins?|seconds?|secs?|hours?|hrs?|days?|weeks?|months?|years?)\\b)";

const IMPORT_QUESTION_TEXT = "Paste your pairing code";
const SHORTCUT_NAME = "OTP Bridge";

/* ------------------------------------------------------------------ serialization helpers */

/**
 * A plain literal string parameter.  [cherri: shortcutgen.go makeStringValue]
 * `WFTextTokenString` is the wrapper Shortcuts uses for any field that *could* contain
 * inline variables, even when this particular value does not.
 */
const textToken = (string) => ({
  Value: { string },
  WFSerializationType: "WFTextTokenString",
});

/**
 * A field whose entire content is one magic variable.
 *
 * The string is a single U+FFFC and the attachment describes it. `ActionOutput` +
 * `OutputUUID` is how one action names another action's result; `ExtensionInput` is the
 * global "Shortcut Input".  [apple: DocumentReview.wflow downloadurl/showresult;
 * docs: zachary7829 fileformat, attachmentsByRange]
 */
const variableToken = (attachment) => ({
  Value: { attachmentsByRange: { [WHOLE_STRING_RANGE]: attachment }, string: OBJ },
  WFSerializationType: "WFTextTokenString",
});

/** The message the automation handed us.  [cherri: variables.go, variableType "ExtensionInput"] */
const shortcutInputAttachment = { Aggrandizements: [], Type: "ExtensionInput" };

/** Another action's output, addressed by UUID.  [apple: DocumentReview.wflow] */
const actionOutputAttachment = (outputName, outputUUID) => ({
  OutputName: outputName,
  OutputUUID: outputUUID,
  Type: "ActionOutput",
});

/**
 * One row of a dictionary-shaped parameter.
 *
 * `WFItemType` 0 is Text.  [cherri: shortcut.go itemTypeText=0, itemTypeDict=1,
 * itemTypeArray=2, itemTypeNumber=3, itemTypeBool=4]
 *
 * README §5 is emphatic that both fields must be Text, not Number: a Number-typed field
 * turns `023941` into `23941` and hands the user a wrong code, which is worse than no code.
 * Type 0 on both entries below is that requirement, encoded.
 */
const jsonTextField = (key, value) => ({
  WFItemType: 0,
  WFKey: textToken(key),
  WFValue: value,
});

/**
 * The `WFDictionaryFieldValue` wrapper that `WFJSONValues` expects.
 * [cherri: shortcutgen.go makeDictionaryValue]
 */
const dictionaryValue = (items) => ({
  Value: { WFDictionaryFieldValueItems: items },
  WFSerializationType: "WFDictionaryFieldValue",
});

/* --------------------------------------------------------------------------- the actions */

function buildActions(relayUrl) {
  const codeEndpoint = new URL("/code", relayUrl).toString();

  return [
    /**
     * Row 1 — Text. Holds the pairing code and nothing else.
     *
     * README §2: rotation after a leak must be "open the shortcut, tap the first field,
     * paste" — which only stays true if this action is standalone and first. The pairing ID
     * is deliberately NOT inlined into the URL or concatenated with anything.
     *
     * `WFTextActionText` carries a bare string rather than a WFTextTokenString wrapper
     * because the import question overwrites this parameter with the user's typed answer,
     * and a scalar is the shape that path writes.
     *
     * `CustomOutputName` renames the magic variable so the JSON body in row 4 reads
     * `pairingId` instead of `Text` — README §2's "rename the variable" step.
     * [apple: is.workflow.actions.gettext / WFTextActionText, WFActions.plist strings]
     * [cherri: actions_std.go identifier "gettext", key "WFTextActionText"]
     * [cherri: shortcutgen.go params["CustomOutputName"]]
     */
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.gettext",
      WFWorkflowActionParameters: {
        CustomOutputName: "pairingId",
        UUID: UUID_PAIRING_TEXT,
        WFTextActionText: "",
      },
    },

    /**
     * Row 2 — Match Text. One ICU regex over Shortcut Input; output is the `Matches` list.
     *
     * README §3: no capture groups, deliberately — reading a group needs a separate
     * "Get Group from Matched Text" action and the action budget is three.
     *
     * `text` is the subject (lowercase, unlike its siblings — this action is intent-backed
     * and its subject key is not WF-prefixed). `WFMatchTextCaseSensitive` false matches
     * README §3's "Case-sensitive: off".
     * [apple: is.workflow.actions.text.match, WFMatchTextPattern, WFMatchTextCaseSensitive
     *  — WFActions.plist strings, WFMatchTextIntent]
     * [cherri: actions_std.go identifier "text.match", parameters subject→"text",
     *  text→"WFMatchTextPattern", caseSensitive→"WFMatchTextCaseSensitive"]
     */
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.text.match",
      WFWorkflowActionParameters: {
        UUID: UUID_MATCHES,
        WFMatchTextCaseSensitive: false,
        WFMatchTextPattern: OTP_REGEX,
        text: variableToken(shortcutInputAttachment),
      },
    },

    /**
     * Row 3 — If Matches has any value. The privacy gate.
     *
     * README §4: this single action is the entire privacy story. A message that trips the
     * automation keyword but yields no regex match makes NO network request at all, so the
     * relay never learns the message existed.
     *
     * `WFControlFlowMode` 0 opens a block, 2 closes it; the two rows are paired by
     * `GroupingIdentifier`. `WFCondition` 100 is "has any value".
     * [apple: is.workflow.actions.conditional; WFControlFlowMode 0/1/2 seen on
     *  choosefrommenu + repeat.count in DocumentReview.wflow]
     * [cherri: shortcut.go conditions{Any: 100}; shortcutgen.go makeConditionalAction
     *  writes GroupingIdentifier / WFControlFlowMode / WFCondition / WFInput]
     */
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.conditional",
      WFWorkflowActionParameters: {
        GroupingIdentifier: GROUP_IF,
        WFCondition: 100,
        WFControlFlowMode: 0,
        WFInput: {
          Type: "Variable",
          Variable: {
            Value: actionOutputAttachment("Matches", UUID_MATCHES),
            WFSerializationType: "WFTextTokenAttachment",
          },
        },
      },
    },

    /**
     * Row 4 — Get Contents of URL, inside the If. POST {pairingId, code} to <relay>/code.
     *
     * Contract per relay/src/index.ts `app.post("/code")`: `pairingId` is normalized and
     * must be six Crockford base32 groups; `code` must satisfy /^[A-Za-z0-9]{4,8}$/. No
     * headers are set — `WFHTTPBodyType: "JSON"` makes Shortcuts send Content-Type itself
     * (README §5). `domain` is not sent, so every code arrives originBound:false (README §7).
     *
     * Responses are ignored by design (README §5): a failed POST is a lost code, and error
     * handling belongs in the extension's 45-second hint, not in rows we cannot afford.
     * [apple: is.workflow.actions.downloadurl + WFURL — DocumentReview.wflow;
     *  WFHTTPMethod / WFHTTPBodyType / WFJSONValues and the body-type enum
     *  {"JSON","Form","File"} — WFDownloadURLAction strings in WFActions.plist]
     * [cherri: actions/web.cherri jsonRequest → WFURL, WFHTTPMethod, WFJSONValues,
     *  "WFHTTPBodyType": "JSON"]
     */
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.downloadurl",
      WFWorkflowActionParameters: {
        UUID: UUID_POST,
        WFHTTPBodyType: "JSON",
        WFHTTPMethod: "POST",
        WFJSONValues: dictionaryValue([
          jsonTextField(
            "pairingId",
            variableToken(actionOutputAttachment("pairingId", UUID_PAIRING_TEXT)),
          ),
          jsonTextField(
            "code",
            variableToken(actionOutputAttachment("Matches", UUID_MATCHES)),
          ),
        ]),
        WFURL: codeEndpoint,
      },
    },

    /**
     * The If's closing row. Nothing goes in an Otherwise branch — README §4: the shortcut
     * simply ends. (Editor rows the user sees: Text, Match Text, If, Get Contents of URL,
     * plus this End If marker, which Shortcuts draws as the block terminator.)
     */
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.conditional",
      WFWorkflowActionParameters: {
        GroupingIdentifier: GROUP_IF,
        UUID: UUID_ENDIF,
        WFControlFlowMode: 2,
      },
    },
  ];
}

/* ------------------------------------------------------------------------- the whole file */

function buildWorkflow(relayUrl) {
  return {
    WFWorkflowActions: buildActions(relayUrl),

    /**
     * Import questions. README §6: the pairing code is asked for at import time so the user
     * never opens the editor during setup, and only action 1 gets a question — the relay URL
     * is baked in on purpose.
     *
     * The question binds by POSITION (`ActionIndex` 0 = the Text action), not by UUID; there
     * is no ActionUUID key in this structure. `ParameterKey` must name a real parameter of
     * that action, hence `WFTextActionText`.
     * [apple: "ActionIndex" sits immediately beside
     *  -[WFWorkflowImportQuestion initWithAction:parameter:question:defaultState:] in the
     *  WorkflowKit strings]
     * [docs: sebj/iOS-Shortcuts-Reference — WFWorkflowImportQuestions entries carry
     *  ActionIndex, ParameterKey, Text; real-world files also carry Category "Parameter"
     *  and DefaultValue]
     */
    WFWorkflowImportQuestions: [
      {
        ActionIndex: 0,
        Category: "Parameter",
        DefaultValue: "",
        ParameterKey: "WFTextActionText",
        Text: IMPORT_QUESTION_TEXT,
      },
    ],

    /**
     * Blue, message-bubbles glyph. Colour 463140863 is the same value Apple's own
     * DocumentReview.wflow ships with.
     * [apple: WFWorkflowIcon / WFWorkflowIconGlyphNumber / WFWorkflowIconStartColor]
     * [cherri: shortcut.go colors["blue"]=463140863, glyphs.go messageBubbles=59403]
     */
    WFWorkflowIcon: {
      WFWorkflowIconGlyphNumber: 59403,
      WFWorkflowIconStartColor: 463140863,
    },

    /**
     * The Message automation hands the body in as Shortcut Input, so the shortcut has to
     * declare it accepts text-ish content. Copied from Apple's DocumentReview.wflow, which
     * lists the full permissive set.
     */
    WFWorkflowInputContentItemClasses: [
      "WFAppContentItem",
      "WFAppStoreAppContentItem",
      "WFArticleContentItem",
      "WFContactContentItem",
      "WFDateContentItem",
      "WFEmailAddressContentItem",
      "WFFolderContentItem",
      "WFGenericFileContentItem",
      "WFImageContentItem",
      "WFiTunesProductContentItem",
      "WFLocationContentItem",
      "WFDCMapsLinkContentItem",
      "WFAVAssetContentItem",
      "WFPDFContentItem",
      "WFPhoneNumberContentItem",
      "WFRichTextContentItem",
      "WFSafariWebPageContentItem",
      "WFStringContentItem",
      "WFURLContentItem",
    ],

    /** Row 2 reads Shortcut Input, so this is true. [apple: WFWorkflowHasShortcutInputVariables] */
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowHasOutputFallback: false,

    /**
     * Empty types = runs in the app and from automations only. README §1 wants "Show in
     * Share Sheet" off, which is exactly the absence of "ActionExtension" here.
     */
    WFWorkflowTypes: [],
    WFWorkflowOutputContentItemClasses: [],
    WFQuickActionSurfaces: [],

    WFWorkflowName: SHORTCUT_NAME,

    /**
     * Deliberately old minimums. Nothing in the four rows is new, and a low floor means the
     * import does not bounce off an older iPhone with "Shortcut Format Too New".
     * [apple: WFWorkflowClientVersion / WFWorkflowMinimumClientVersion /
     *  WFWorkflowMinimumClientVersionString — WFWorkflowFile.m key list]
     */
    WFWorkflowClientVersion: "1146.14",
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
  };
}

/* -------------------------------------------------------------------------------- driving */

function resolveRelayUrl() {
  const fromArg = process.argv[2];
  if (fromArg) return { url: fromArg, source: "command-line argument" };

  for (const name of ["RELAY_URL", "WXT_RELAY_URL"]) {
    if (process.env[name]) return { url: process.env[name], source: `$${name}` };
  }

  const envPath = join(REPO, "extension", ".env");
  try {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("WXT_RELAY_URL="));
    if (line) {
      const value = line.slice("WXT_RELAY_URL=".length).trim().replace(/^["']|["']$/g, "");
      if (value) return { url: value, source: "extension/.env (WXT_RELAY_URL)" };
    }
  } catch {
    /* no .env; fall through to the error below */
  }

  throw new Error(
    "No relay URL. Pass one as an argument, set $RELAY_URL, or put WXT_RELAY_URL in extension/.env.",
  );
}

/** plutil reads JSON and writes a binary plist, which saves hand-rolling a plist encoder. */
function writeBinaryPlist(object, outPath) {
  const scratch = `${outPath}.json`;
  writeFileSync(scratch, JSON.stringify(object));
  try {
    execFileSync("/usr/bin/plutil", ["-convert", "binary1", "-o", outPath, scratch]);
  } finally {
    rmSync(scratch, { force: true });
  }
}

function main() {
  const { url, source } = resolveRelayUrl();
  let relay;
  try {
    relay = new URL(url);
  } catch {
    throw new Error(`Relay URL from ${source} is not a URL: ${url}`);
  }
  if (relay.protocol !== "https:") {
    // A code in flight over http is a code anyone on the network can read.
    throw new Error(`Relay URL must be https (from ${source}): ${url}`);
  }

  mkdirSync(DIST, { recursive: true });
  const unsigned = join(DIST, "otp-bridge.unsigned.shortcut");
  const signed = join(DIST, "otp-bridge.shortcut");

  writeBinaryPlist(buildWorkflow(relay.toString()), unsigned);

  console.log(`Relay URL     ${relay.origin}  (from ${source})`);
  console.log(`POST endpoint ${new URL("/code", relay).toString()}`);
  console.log(`Unsigned      ${unsigned}`);
  console.log("");
  console.log("Next: sign it so it can be imported by anyone.");
  console.log("");
  console.log(
    `  shortcuts sign --mode anyone -i ${unsigned} -o ${signed}`,
  );
  console.log("");
  console.log("Then, to check it before shipping:");
  console.log(`  plutil -convert xml1 -o - ${signed} | less   # inspect the round-trip`);
  console.log(`  open -a Shortcuts ${signed}                  # import on this Mac`);
  console.log("");
  console.log("On import you should be asked: " + JSON.stringify(IMPORT_QUESTION_TEXT));
  console.log(
    "Then embed it in the relay and redeploy, so GET /shortcut serves it:",
    "  cd ../relay && node scripts/embed-shortcut.mjs ../shortcut/dist/otp-bridge.shortcut",
    "  npx wrangler deploy",
  );
  console.log("");
  console.log("The automation is still manual, once per phone — see shortcut/README.md §8.");
}

main();

#!/usr/bin/env node
/**
 * Build → sign → embed, in one step.
 *
 *   node shortcut/release.mjs [relayUrl]
 *   node shortcut/release.mjs --mode people-who-know-me   # personal testing only
 *
 * Then `cd relay && npx wrangler deploy`.
 *
 * Signing is the fragile part, and it fails by HANGING rather than erroring, so every
 * invocation here is wrapped in a timeout. See the diagnosis below.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DIST = join(HERE, "dist");
const UNSIGNED = join(DIST, "otp-bridge.unsigned.shortcut");
const SIGNED = join(DIST, "otp-bridge.shortcut");

/** Signing normally takes a second or two; anything beyond this is the wedge below. */
const SIGN_TIMEOUT_MS = 60_000;

const args = process.argv.slice(2);
const modeIndex = args.indexOf("--mode");
const mode = modeIndex === -1 ? "anyone" : args[modeIndex + 1];
const relayUrl = args.find((a) => a.startsWith("http"));

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
}

console.log("→ building the plist");
run("node", [join(HERE, "build-shortcut.mjs"), ...(relayUrl ? [relayUrl] : [])]);

if (!existsSync(UNSIGNED)) {
  console.error("build produced no unsigned file — aborting");
  process.exit(1);
}

console.log(`\n→ signing (--mode ${mode})`);
try {
  run("shortcuts", ["sign", "--mode", mode, "-i", UNSIGNED, "-o", SIGNED], {
    timeout: SIGN_TIMEOUT_MS,
  });
} catch (err) {
  if (err.code === "ETIMEDOUT" || err.signal === "SIGTERM") {
    console.error(`
✗ \`shortcuts sign\` hung for ${SIGN_TIMEOUT_MS / 1000}s.

  This is a wedged local service, not a problem with the plist — a minimal
  one-action shortcut hangs identically when it happens. It has been seen after
  killing Shortcuts.app or siriactionsd while a signing operation was in flight.

  Things that do NOT fix it: relaunching Shortcuts.app, killing siriactionsd
  (launchd respawns it in the same state), \`launchctl kickstart\` (blocked by SIP).

  What does: logging out and back in, or rebooting. Then re-run this script.

  To keep moving before that, sign for your own devices only:

      node shortcut/release.mjs --mode people-who-know-me

  That imports fine on devices signed into your own Apple ID, but NOT for anyone
  else — do not ship it. Public distribution needs --mode anyone.
`);
  } else {
    console.error(`\n✗ signing failed: ${err.message}`);
  }
  process.exit(1);
}

// A signed shortcut is an Apple Encrypted Archive. An unsigned plist starts with
// "bplist00" and iOS 15+ refuses to import it, so check rather than assume.
const head = execFileSync("head", ["-c", "4", SIGNED]).toString("binary");
if (head !== "AEA1") {
  console.error(`✗ signed output does not start with AEA1 (got ${JSON.stringify(head)})`);
  process.exit(1);
}
console.log(`  signed: ${statSync(SIGNED).size} bytes, AEA1 ✓`);

console.log("\n→ embedding into the relay");
run("node", [join(REPO, "relay/scripts/embed-shortcut.mjs"), SIGNED], {
  cwd: join(REPO, "relay"),
});

console.log(`
Done. To ship it:

    cd relay && npx wrangler deploy

Then confirm the deployed bytes really are the new ones:

    curl -s <relay>/sms-code-bridge.shortcut | wc -c
`);

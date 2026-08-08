import path from "node:path";
import { fileURLToPath } from "node:url";

import { test as base, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";

import { FIXTURES } from "./fixtures";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(here, "../.output/chrome-mv3");

export interface CodePayload {
  code: string;
  domain: string | null;
  originBound: boolean;
  sentAt: number;
  ttl: number;
}

export const test = base.extend<{
  context: BrowserContext;
  background: Worker;
  open: (host: string, fixture: string) => Promise<Page>;
}>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      // Extensions do not load in the headless shell; the new headless mode in the full
      // Chromium build does support them.
      channel: "chrome",
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
  },

  background: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    await use(worker);
  },

  /**
   * Serves a fixture at a real https origin. The origin matters: domain-bound codes are
   * judged against `location.hostname`, so this cannot be a file:// or data: URL.
   */
  open: async ({ context }, use) => {
    await use(async (host: string, fixture: string) => {
      const page = await context.newPage();
      await page.route(`https://${host}/**`, (route) => {
        const body = FIXTURES[new URL(route.request().url()).pathname];
        if (!body) return route.fulfill({ status: 404, body: "no fixture" });
        return route.fulfill({ status: 200, contentType: "text/html", body });
      });
      await page.goto(`https://${host}${fixture}`);
      return page;
    });
  },
});

export const expect = test.expect;

/**
 * Delivers a code the way the service worker does after a push, without needing a real
 * push round-trip. Returns whether the content script claimed to have handled it.
 */
export async function deliver(
  background: Worker,
  page: Page,
  payload: Partial<CodePayload> & { code: string },
): Promise<boolean> {
  const full: CodePayload = {
    domain: null,
    originBound: false,
    sentAt: Date.now(),
    ttl: 60,
    ...payload,
  };

  // Target by tab id, not URL. Without the "tabs" permission Chrome withholds tab.url,
  // and we deliberately do not request it — production targets by id too.
  await page.bringToFront();

  return background.evaluate(async (full) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("no active tab");
    const res = await chrome.tabs.sendMessage(tab.id, { type: "code", payload: full });
    return (res as { handled?: boolean } | undefined)?.handled === true;
  }, full);
}

/** The pill host is the last child we append to <html>. It has a closed shadow root. */
export async function pillHost(page: Page): Promise<{ present: boolean; pierceable: boolean }> {
  return page.evaluate(() => {
    const hosts = Array.from(document.documentElement.children).filter(
      (el): el is HTMLElement =>
        el.tagName === "DIV" &&
        (el as HTMLElement).style.position === "fixed" &&
        !el.id &&
        !el.className,
    );
    const host = hosts[hosts.length - 1];
    return {
      present: Boolean(host),
      // shadowRoot is null for closed roots — page scripts cannot read our UI.
      pierceable: Boolean(host && (host as HTMLElement & { shadowRoot?: unknown }).shadowRoot),
    };
  });
}

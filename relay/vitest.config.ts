import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Bindings are declared here rather than read from wrangler.toml so the tests do not
// depend on the production KV namespace id or on the rate-limiter bindings, which the
// test pool does not provide. The Worker treats a missing limiter as "not limited".
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        singleWorker: true,
        miniflare: {
          compatibilityDate: "2024-12-30",
          compatibilityFlags: ["nodejs_compat"],
          kvNamespaces: ["PAIRINGS"],
          bindings: {
            VAPID_SUBJECT: "mailto:test@example.com",
            // Test-only keypair. Not used anywhere real.
            VAPID_PUBLIC_KEY:
              "BPZYZpRsI-WugbcDSko5835kYU0w1UAWAUWF7yEzJ45AXAK_xIn7tbecDNZmNrTI1HND69gtFf9oSRIgTMQ8X6k",
            VAPID_PRIVATE_KEY: "VMp_3taEsmpQAhNio1yZ4PAEXr9Hld26KhyaiXJPfTY",
          },
        },
      },
    },
  },
});

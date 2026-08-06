import type { Env } from "../src/index.js";

declare module "cloudflare:test" {
  // Teaches `env` in tests about the bindings declared in vitest.config.ts.
  interface ProvidedEnv extends Env {}
}

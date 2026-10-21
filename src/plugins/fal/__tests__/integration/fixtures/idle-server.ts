// Run by bun, not vitest: idle-timeout.test.ts spawns it with a small
// BUN_CONFIG_HTTP_IDLE_TIMEOUT. A local server answers after DELAY_MS with no
// byte before it. A plain fetch is cut by Bun's idle timer; falFetch must not be.
import { falFetch } from "../../../client/http";

const DELAY_MS = 10_000;

const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch() {
    await Bun.sleep(DELAY_MS);
    return Response.json({ ok: true });
  }
});
const url = `http://127.0.0.1:${server.port}/`;

const [plain, fal] = await Promise.allSettled([
  fetch(url),
  falFetch({ url, method: "POST", json: {}, timeoutMs: 60_000 })
]);

/** The rejection's name or message, without a cast. */
function field(reason: unknown, key: "name" | "message"): string {
  return reason instanceof Error ? reason[key] : String(reason);
}

const outcome = {
  plain: plain.status === "fulfilled" ? plain.value.status : field(plain.reason, "name"),
  fal: fal.status === "fulfilled" ? fal.value.status : field(fal.reason, "message")
};
process.stdout.write(JSON.stringify(outcome));
await server.stop(true);

import { createServer } from "node:http";
import { chainUp, prepare, start } from "./stack";

/**
 * Starts the backend services for the end-to-end tests (Playwright webServer) against the TEST
 * database, then answers 200 on http://127.0.0.1:4919/ready until it is stopped.
 *   npx tsx test/stack-cli.ts
 */
async function main(): Promise<void> {
  if (!(await chainUp())) throw new Error("the local chain is not running (python chain/net.py start)");
  prepare();
  const stack = await start();
  const ready = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ready");
  }).listen(4919, "127.0.0.1");
  const stop = (): void => {
    ready.close();
    void stack.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

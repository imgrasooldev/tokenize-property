import { chainUp, prepare, startServices } from "./stack";

/**
 * Vitest global setup: the test database preparation (migrations, roles, KYC and signer secrets) runs
 * once, and the indexer, signing service and KYC service start once for every integration file
 * instead of once per file (the indexer catch-up alone took ~30 s each time). Each file still runs its
 * own outbox worker. Without the local chain nothing starts and the integration tests skip.
 */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (!(await chainUp())) return undefined;
  prepare();
  process.env.WEB_STACK_PREPARED = "1";
  const services = await startServices();
  process.env.WEB_STACK_SHARED = "1";
  return services.stop;
}

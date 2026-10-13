import type pg from "pg";

/**
 * Offboarding worker (Step 5h, migration 0011 I-3). When an investor loses their verification
 * (re-screening hit, revocation, expiry), their wallet must be frozen on chain before anything else
 * happens (finding F-01: never rely on claim revocation). The database decides WHAT to freeze
 * (kyc.enqueue_offboarding, one outbox command per subject, decision and status); this worker only
 * decides WHEN: at once on a kyc_alert notification, and on a timer as well, so a missed
 * notification or a crash never skips a freeze. The outbox and the signing service do the rest
 * (compliance.freeze policy: never a verified investor, daily limit).
 */
export class OffboardingWorker {
  private timer: NodeJS.Timeout | null = null;
  private listener: pg.PoolClient | null = null;
  private running: Promise<number> | null = null;
  private again = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: { freezeGuard: string; actor?: string; pollMs?: number; onError?: (e: unknown) => void },
  ) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(opts.freezeGuard)) throw new Error("freezeGuard must be an address");
  }

  /** One pass: enqueues every freeze that is due. Returns how many commands were new. */
  async runOnce(): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>("SELECT kyc.enqueue_offboarding($1, $2) AS n", [this.opts.freezeGuard, this.opts.actor ?? "kyc-offboarding"]);
    return rows[0]?.n ?? 0;
  }

  async start(): Promise<void> {
    this.listener = await this.pool.connect();
    this.listener.on("notification", () => {
      this.kick();
    });
    await this.listener.query("LISTEN kyc_alert");
    this.timer = setInterval(() => {
      this.kick();
    }, this.opts.pollMs ?? 60_000);
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.listener) {
      await this.listener.query("UNLISTEN kyc_alert").catch(() => undefined);
      this.listener.release();
      this.listener = null;
    }
    await this.running?.catch(() => 0);
  }

  /** Runs a pass now, or right after the one in progress (never two at once). */
  private kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.runOnce()
      .catch((e: unknown) => {
        this.opts.onError?.(e);
        return 0;
      })
      .finally(() => {
        this.running = null;
        if (this.again && this.timer) {
          this.again = false;
          this.kick();
        }
      });
  }
}

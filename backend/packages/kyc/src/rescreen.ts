import type pg from "pg";
import { KycError, type KycService } from "./service.ts";

/**
 * Re-screening worker (Step 6c, migration 0019 C-5). Compliance officers queue a re-screening in the
 * portal (compliance.request_rescreen); only the KYC service holds the key that unseals a name, so
 * it executes the queue: claim (SKIP LOCKED, stale claims return after 10 minutes), screen against
 * the current list through the same provider as onboarding (KycService.rescreen: record the check,
 * re-evaluate; a possible match opens a review case by itself), then record the outcome. Failures
 * are recorded with the error's name only, never a message that could carry personal data.
 */
export class RescreenWorker {
  private timer: NodeJS.Timeout | null = null;
  private listener: pg.PoolClient | null = null;
  private running: Promise<number> | null = null;
  private again = false;
  private readonly name: string;

  constructor(
    private readonly pool: pg.Pool,
    private readonly kyc: Pick<KycService, "rescreen">,
    private readonly opts: { worker?: string; batch?: number; pollMs?: number; onError?: (e: unknown) => void } = {},
  ) {
    this.name = (opts.worker ?? "kyc-rescreen").slice(0, 100);
  }

  /** One pass: executes up to `batch` queued re-screenings. Returns how many were finished. */
  async runOnce(): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; subject_id: string }>("SELECT * FROM compliance.claim_rescreens($1, $2)", [this.name, this.opts.batch ?? 10]);
    let done = 0;
    for (const r of rows) {
      try {
        const status = await this.kyc.rescreen(r.subject_id);
        // The database links the subject's latest sanctions screening to the request.
        await this.pool.query("SELECT compliance.complete_rescreen($1, $2, $3, NULL, NULL)", [r.id, this.name, status]);
      } catch (e) {
        const label = e instanceof KycError ? `KycError:${e.code}` : e instanceof Error ? e.name : "Error";
        await this.pool.query("SELECT compliance.complete_rescreen($1, $2, NULL, NULL, $3)", [r.id, this.name, label.replace(/[^A-Za-z0-9_ .:-]/g, "").slice(0, 80) || "Error"]);
        this.opts.onError?.(e);
      }
      done++;
    }
    return done;
  }

  async start(): Promise<void> {
    this.listener = await this.pool.connect();
    this.listener.on("notification", () => {
      this.kick();
    });
    await this.listener.query("LISTEN compliance_rescreen");
    this.timer = setInterval(() => {
      this.kick();
    }, this.opts.pollMs ?? 30_000);
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.listener) {
      await this.listener.query("UNLISTEN compliance_rescreen").catch(() => undefined);
      this.listener.release();
      this.listener = null;
    }
    await this.running?.catch(() => 0);
  }

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

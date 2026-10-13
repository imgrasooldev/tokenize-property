import type pg from "pg";
import { ContactError, type ContactSecrets } from "./crypto.ts";
import type { Channel, Locale } from "./events.ts";
import { ProviderRejected, ProviderUnavailable, type Provider } from "./providers.ts";
import { render, RenderError } from "./render.ts";

/**
 * Delivery worker (ADR 0013), built like the outbox worker (ADR 0004):
 *
 * - LISTEN notify (NOTIFY fires when a producer's transaction commits) plus polling as a fallback.
 * - Claim with a lease (FOR UPDATE SKIP LOCKED; rate limits applied in the claim).
 * - Record the attempt BEFORE calling the provider (notify.begin_attempt), and only with enough
 *   lease left to finish the provider call (send timeout + margin).
 * - After any failure the worker decides from what is provable, never from hope:
 *     ProviderRejected      -> dead letter (permanent);
 *     ProviderUnavailable   -> nothing was accepted: retry with backoff;
 *     anything else         -> outcome unknown: the delivery stays 'sending'; once its lease has
 *                              expired a worker asks the provider (lookup by idempotency key) and
 *                              records "sent" (accepted), retries (provably not accepted) or, if the
 *                              answer stays unknown past reviewAfterMs, dead-letters it.
 * So a delivery is accepted by the provider at most once, and never silently lost.
 */

export interface NotifyWorkerOptions {
  /** Unique per worker process, e.g. "notify-1@host". */
  workerId: string;
  providers: Partial<Record<Channel, Provider>>;
  secrets: ContactSecrets;
  batch?: number;
  /** Lease per claimed delivery. Must exceed the send timeout by at least 10 s. */
  leaseSeconds?: number;
  /** The worker aborts a provider call after this long (then: outcome unknown). */
  sendTimeoutMs?: number;
  /** A delivery whose outcome stays unknown this long after its attempt started is dead-lettered. */
  reviewAfterMs?: number;
  pollMs?: number;
  onError?: (context: string, err: unknown) => void;
}

interface DeliveryRow {
  id: string;
  uid: string;
  channel: Channel;
  status: "claimed" | "sending";
}

interface MaterialRow {
  kind: string;
  channel: Channel;
  locale: Locale;
  recipient_id: string;
  lookup_hash: Buffer;
  sealed: Buffer;
  key_version: number;
  subject: string | null;
  body: string;
  params: Record<string, unknown>;
}

export class NotifyWorker {
  private readonly batch: number;
  private readonly leaseSeconds: number;
  private readonly sendTimeoutMs: number;
  private readonly reviewAfterMs: number;
  private readonly pollMs: number;
  private listener: pg.PoolClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private again = false;
  private stopped = true;

  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: NotifyWorkerOptions,
  ) {
    if (!/^[\w.@:-]{1,100}$/.test(opts.workerId)) throw new Error("workerId must be 1-100 safe characters");
    this.batch = opts.batch ?? 20;
    this.leaseSeconds = opts.leaseSeconds ?? 60;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? 15_000;
    this.reviewAfterMs = opts.reviewAfterMs ?? 30 * 60_000;
    this.pollMs = opts.pollMs ?? 2_000;
    if (this.sendTimeoutMs + 10_000 > this.leaseSeconds * 1000) {
      throw new Error("leaseSeconds must exceed the send timeout by at least 10 s (a lease must outlive the provider call)");
    }
    for (const [channel, p] of Object.entries(opts.providers)) {
      if (p.channel !== channel) throw new Error(`provider ${p.name} sends ${p.channel}, not ${channel}`);
      if (!/^[a-z][a-z0-9_-]{1,31}$/.test(p.name)) throw new Error(`provider name ${p.name} is not allowed`);
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.listener = await this.pool.connect();
    this.listener.on("notification", () => {
      this.kick();
    });
    await this.listener.query("LISTEN notify");
    this.timer = setInterval(() => {
      this.kick();
    }, this.pollMs);
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.listener) {
      await this.listener.query("UNLISTEN notify").catch(() => undefined);
      this.listener.release();
      this.listener = null;
    }
    await this.running;
  }

  private kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.runOnce()
      .catch((e: unknown) => {
        this.opts.onError?.("runOnce", e);
        return 0;
      })
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** Claims one batch and processes it. Returns how many deliveries were handled. */
  async runOnce(): Promise<number> {
    const { rows } = await this.pool.query<DeliveryRow>("SELECT id, uid, channel, status FROM notify.claim($1, $2, $3)", [
      this.opts.workerId,
      this.batch,
      this.leaseSeconds,
    ]);
    await Promise.all(
      rows.map((d) =>
        (d.status === "sending" ? this.resolve(d) : this.deliver(d)).catch((e: unknown) => {
          this.opts.onError?.(`delivery ${d.id}`, e);
        }),
      ),
    );
    return rows.length;
  }

  private providerFor(channel: Channel): Provider | undefined {
    // eslint-disable-next-line security/detect-object-injection -- channel is checked with hasOwn
    return Object.hasOwn(this.opts.providers, channel) ? this.opts.providers[channel] : undefined;
  }

  private async deliver(d: DeliveryRow): Promise<void> {
    const { rows } = await this.pool.query<MaterialRow>(
      "SELECT kind, channel, locale, recipient_id, lookup_hash, sealed, key_version, subject, body, params FROM notify.delivery_material($1, $2)",
      [d.id, this.opts.workerId],
    );
    const m = rows[0];
    if (!m) return; // lease lost: someone else owns it now
    const provider = this.providerFor(m.channel);
    if (!provider) {
      await this.fail(d.id, "not_accepted", `no provider configured for ${m.channel}`);
      return;
    }

    let to: string;
    let message: ReturnType<typeof render>;
    try {
      if (m.channel === "push") throw new RenderError("push deliveries are not supported yet");
      to = this.opts.secrets.open({
        recipientId: m.recipient_id,
        channel: m.channel,
        lookupHash: m.lookup_hash,
        sealed: m.sealed,
        keyVersion: m.key_version,
      });
      message = render({ kind: m.kind, channel: m.channel, locale: m.locale, subject: m.subject, body: m.body, params: m.params });
    } catch (e) {
      if (e instanceof ContactError || e instanceof RenderError) {
        // Permanent: retrying cannot help, and a security notice must not wait silently.
        await this.fail(d.id, "rejected", `${e.name}: ${e.message}`);
        return;
      }
      throw e;
    }

    // N-5: record the attempt first; no record, no call.
    const minSeconds = Math.ceil(this.sendTimeoutMs / 1000) + 5;
    const { rows: begun } = await this.pool.query<{ attempt: string | null }>("SELECT notify.begin_attempt($1, $2, $3) AS attempt", [
      d.id,
      this.opts.workerId,
      minSeconds,
    ]);
    if (!begun[0]?.attempt) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`provider call timed out after ${String(this.sendTimeoutMs)} ms`));
      }, this.sendTimeoutMs);
    });
    let messageId: string;
    try {
      const result = await Promise.race([
        provider.send(
          {
            idempotencyKey: d.uid,
            channel: provider.channel,
            to,
            locale: m.locale,
            text: message.text,
            ...(message.subject === undefined ? {} : { subject: message.subject }),
            ...(message.html === undefined ? {} : { html: message.html }),
          },
          controller.signal,
        ),
        timeout,
      ]);
      messageId = result.messageId;
    } catch (e) {
      if (e instanceof ProviderRejected) await this.fail(d.id, "rejected", `${e.name}: ${e.message}`);
      else if (e instanceof ProviderUnavailable) await this.fail(d.id, "not_accepted", `${e.name}: ${e.message}`);
      // Anything else: the provider may have accepted. Leave it 'sending'; after the lease a worker
      // asks the provider (resolve). Never retry here.
      else this.opts.onError?.(`delivery ${d.id}: outcome unknown, resolved after the lease`, e);
      return;
    } finally {
      clearTimeout(timer);
    }
    await this.recordSent(d.id, provider.name, messageId, message.sha256);
  }

  /** A 'sending' delivery whose lease expired: ask the provider what happened. */
  private async resolve(d: DeliveryRow): Promise<void> {
    const provider = this.providerFor(d.channel);
    if (!provider) {
      this.opts.onError?.(`delivery ${d.id}`, new Error(`cannot resolve: no provider for ${d.channel}`));
      return;
    }
    const answer = await provider.lookup(d.uid).catch(() => ({ state: "unknown" }) as const);
    if (answer.state === "accepted") {
      await this.recordSent(d.id, provider.name, answer.messageId, null);
      return;
    }
    if (answer.state === "not_found") {
      await this.fail(d.id, "not_accepted", "provider has no record of the attempt; retrying");
      return;
    }
    const { rows } = await this.pool.query<{ started: Date | null }>("SELECT notify.open_attempt_started($1) AS started", [d.id]);
    const started = rows[0]?.started?.getTime() ?? 0;
    if (Date.now() - started > this.reviewAfterMs) {
      await this.fail(d.id, "unknown", `provider cannot say whether it accepted the message after ${String(Math.round((Date.now() - started) / 1000))} s`);
    }
    // Otherwise leave it; the lease expires and it is asked again.
  }

  private async recordSent(id: string, provider: string, messageId: string, sha256: Buffer | null): Promise<void> {
    await this.pool.query("SELECT notify.record_sent($1, $2, $3, $4, $5)", [id, this.opts.workerId, provider, messageId, sha256]);
  }

  private async fail(id: string, outcome: "not_accepted" | "rejected" | "unknown", error: string): Promise<void> {
    await this.pool.query("SELECT notify.record_failure($1, $2, $3, $4)", [id, this.opts.workerId, outcome, redact(error).slice(0, 500)]);
  }
}

/**
 * Removes anything that looks like a contact detail from an error text before it is stored or
 * logged: provider errors may echo the number or address they refused (rule N-1).
 */
export function redact(text: string): string {
  return text
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+/g, "[email]")
    .replace(/\+?[0-9][0-9 -]{5,}[0-9]/g, "[number]")
    .replace(/\s+/g, " ");
}

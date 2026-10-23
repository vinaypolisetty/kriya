/**
 * In-process jobs: provider calls in flight, keyed by ticket. The engine is
 * synchronous and deterministic; real providers are async. An adapter starts a
 * call here and hands the engine a ticket (D-53); `settle` waits for each call
 * and delivers its result, so the run carries on.
 */
import type { AgentTurnResult, CallMeta, Scheduler } from "@kriya/engine";

export type Job =
  | { kind: "outputs"; run: () => Promise<{ outputs: Record<string, unknown>[]; meta: CallMeta[] }> }
  | { kind: "turn"; run: () => Promise<AgentTurnResult> };

type Settled = { ticket: string; kind: Job["kind"] } & ({ ok: true; value: unknown } | { ok: false; error: unknown });

export class Jobs {
  private readonly running = new Map<string, Promise<Settled>>();

  /** Starts a call under `ticket`, unless one is already running (asking again is the same job). */
  start(ticket: string, job: Job): void {
    if (this.running.has(ticket)) return;
    const p: Promise<Settled> = job.run().then(
      (value) => ({ ticket, kind: job.kind, ok: true as const, value }),
      (error: unknown) => ({ ticket, kind: job.kind, ok: false as const, error }),
    );
    this.running.set(ticket, p);
  }

  get size(): number {
    return this.running.size;
  }

  /** The next call to finish. */
  async next(): Promise<Settled> {
    const done = await Promise.race(this.running.values());
    this.running.delete(done.ticket);
    return done;
  }
}

/**
 * Runs the scheduler until nothing is in flight: each finished call is
 * delivered (or fails its step with a plain reason), then the run carries on.
 * Returns when the run is waiting on a person, or done.
 */
export async function settle(s: Scheduler, jobs: Jobs, describe: (error: unknown) => string = String): Promise<void> {
  s.run();
  while (jobs.size > 0) {
    const r = await jobs.next();
    if (!r.ok) s.failJob(r.ticket, describe(r.error));
    else if (r.kind === "turn") s.deliverTurn(r.ticket, r.value as AgentTurnResult);
    else {
      const v = r.value as { outputs: Record<string, unknown>[]; meta: CallMeta[] };
      s.deliver(r.ticket, v.outputs, v.meta);
    }
    s.run();
  }
}

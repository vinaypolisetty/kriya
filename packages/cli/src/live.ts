/**
 * The runs `kriya web` is carrying on (D-86). Writes (an answer, a retry, a
 * branch, a new run) are recorded one at a time, but a run carrying on doesn't
 * hold the line: while one shot's clip is being made, a pick on another shot is
 * recorded at once and starts its own work.
 *
 * Two schedulers on one run would disagree, so a run has at most one while it
 * carries on, and every write to it goes to that one. When nothing is in
 * flight it is let go, and the next write opens the run afresh from its log.
 */
import { describeError, settle, type Jobs } from "@kriya/adapters";
import type { Scheduler } from "@kriya/engine";

type Opened = { s: Scheduler; jobs: Jobs };

export class LiveRuns {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly live = new Map<string, Opened & { done: Promise<void> }>();

  /**
   * `open` replays a run from its log without running anything; `failed` hears
   * why a run stopped carrying on (the run itself records its failures).
   */
  constructor(
    private readonly open: (run: string) => Promise<Opened>,
    private readonly failed: (run: string, error: unknown) => void,
  ) {}

  /**
   * Changes one run and returns once the change is recorded. With `carryOn`,
   * the run then goes on in the background: a run already carrying on picks up
   * whatever the change started; any other is opened, recovered and driven.
   */
  change<T>(run: string, edit: (s: Scheduler) => T, opts: { carryOn: boolean } = { carryOn: true }): Promise<T> {
    return this.inTurn(async () => {
      const now = this.live.get(run);
      const { s, jobs } = now ?? (await this.open(run));
      const out = edit(s);
      if (opts.carryOn) {
        // Already carrying on: its loop waits for the jobs this starts too.
        if (now) s.run();
        else {
          s.recover();
          this.carryOn(run, s, jobs);
        }
      }
      return out;
    });
  }

  /** A run made here (a new one): recorded in turn, then carried on in the background. */
  begin<T extends Opened & { id: string }>(make: () => T | Promise<T>): Promise<T> {
    return this.inTurn(async () => {
      const made = await make();
      this.carryOn(made.id, made.s, made.jobs);
      return made;
    });
  }

  /** Whether models or tools are still working on this run. */
  working(run: string): boolean {
    return this.live.has(run);
  }

  /** Waits until every write is recorded and no run has work in flight. */
  async idle(): Promise<void> {
    await this.queue;
    while (this.live.size > 0) await Promise.all([...this.live.values()].map((l) => l.done));
  }

  private inTurn<T>(step: () => Promise<T>): Promise<T> {
    const done = this.queue.then(step);
    this.queue = done.catch(() => undefined);
    return done;
  }

  private carryOn(run: string, s: Scheduler, jobs: Jobs): void {
    const entry = { s, jobs, done: Promise.resolve() };
    this.live.set(run, entry);
    entry.done = (async () => {
      try {
        // A write can start a job just as the last one is delivered: go round again for it.
        do await settle(s, jobs, describeError);
        while (jobs.size > 0);
      } catch (e) {
        this.failed(run, e);
      } finally {
        this.live.delete(run);
      }
    })();
  }
}

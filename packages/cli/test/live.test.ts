import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { Jobs } from "@kriya/adapters";
import { loadDir, Recorder, Scheduler, type Executors, type StepContext } from "@kriya/engine";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { LiveRuns } from "../src/live.js";

const { graphs } = loadDir(resolve(__dirname, "../../../examples"));
const part = graphs.find((g) => g.graph === "part_recipe")!;
const SERIES = { series: { style: "2D cartoon, flat colors", rules: "no real film songs", cast: ["Mitra", "Bheem"] } };
const LIBRARY = { assets: { facet: (entity: string, facet: string) => ({ version: "v1", value: `${entity}:${facet}` }) } };
const SHOTS = [
  { id: "P3-01", action: "Mitra pours chai", animate: false },
  { id: "P3-02", action: "The tanker arrives", animate: true },
];

/**
 * A run of the example part recipe whose clips are slow, like Wan on
 * Replicate: each one waits until the test says it's made. Every screen asks
 * a person. `opened` counts the schedulers made for it.
 */
function slowClips() {
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const clips = new Map<string, () => void>();
  const made = { opened: 0 };
  const scheduler = (rec: Recorder) => {
    const jobs = new Jobs();
    const exec: Executors = {
      produce(node, c: StepContext) {
        const item = (c.inputs.item as { id: string } | undefined)?.id;
        if (node.id === "shot_list") return [{ shots: SHOTS, lines: [{ id: "L1", speaker: "Mitra" }], hook: "Who will close the valve?" }];
        if (node.id === "draw") return [1, 2].map((i) => ({ image: `img:${item}:${i}` }));
        if (node.id === "speak") return [{ audio: `wav:${item}`, seconds: 4 }];
        if (node.id !== "animate") return [{ done: true }];
        const ticket = c.idempotencyKey!;
        jobs.start(ticket, { kind: "outputs", run: () => new Promise((ok) => clips.set(item!, () => ok({ outputs: [{ clip: `clip:${item}` }], meta: [] }))) });
        return { ticket };
      },
      check: (_n, _c, cands) => cands.map((c) => ({ version: c.version, pass: true, issues: [] })),
      decide: () => undefined,
    };
    return { s: new Scheduler(part, rec, exec, graphs, LIBRARY), jobs };
  };
  const { s } = scheduler(Recorder.start(log, "run1"));
  s.start("a".repeat(64), { story_pages: "pages 7–9", part_no: 3 }, SERIES);
  s.run();
  const failures: unknown[] = [];
  const live = new LiveRuns(
    async (run) => (made.opened++, scheduler(Recorder.resume(log, run))),
    (_run, e) => failures.push(e),
  );
  const state = () => Recorder.resume(log, "run1").state;
  return { live, clips, made, failures, state };
}

/** Settles every promise already resolved, so background work gets its turn. */
const tick = () => new Promise((ok) => setTimeout(ok, 0));

describe("the runs kriya web carries on (D-86)", () => {
  it("a pick goes through while another shot's clip is still being made", async () => {
    const { live, clips, state } = slowClips();
    await live.change("run1", (s) => s.answer("approve_shots", { action: "approve", by: "human" }));
    await live.change("run1", (s) => s.answer("per_shot[P3-02].pick", { action: "lock", selection: ["1.1"], by: "human" }));
    await tick();
    expect(clips.has("P3-02")).toBe(true);
    expect(live.working("run1")).toBe(true);

    // The clip isn't back yet; the other shot's pick is recorded anyway.
    const picked = live.change("run1", (s) => s.answer("per_shot[P3-01].pick", { action: "lock", selection: ["1.2"], by: "human" }));
    const first = await Promise.race([picked.then(() => "recorded"), tick().then(() => "still waiting")]);
    expect(first).toBe("recorded");
    expect(state().nodes["per_shot[P3-01].draw"]?.locked?.version).toBe("1.2");
    expect(state().nodes["per_shot[P3-02].animate"]?.status).toBe("waiting_external");

    clips.get("P3-02")!();
    await live.idle();
    // The clip came back and waits for you to approve it.
    expect(state().nodes["per_shot[P3-02].animate"]?.status).toBe("awaiting_human");
    expect(Object.values(state().nodes["per_shot[P3-02].animate"]!.versions).map((v) => v.output)).toEqual([{ clip: "clip:P3-02" }]);
    expect(live.working("run1")).toBe(false);
  });

  it("a run carrying on has one scheduler: a write to it goes to that one, not a second from the log", async () => {
    const { live, clips, made, failures } = slowClips();
    await live.change("run1", (s) => s.answer("approve_shots", { action: "approve", by: "human" }));
    await live.change("run1", (s) => s.answer("per_shot[P3-02].pick", { action: "lock", selection: ["1.1"], by: "human" }));
    const opened = made.opened;
    await live.change("run1", (s) => s.answer("per_shot[P3-01].pick", { action: "lock", selection: ["1.1"], by: "human" }));
    expect(made.opened).toBe(opened);

    // Let go once nothing is in flight: the next write opens the run afresh.
    clips.get("P3-02")!();
    await live.idle();
    await live.change("run1", (s) => s.answer("voices[L1].listen", { action: "approve", by: "human" }));
    expect(made.opened).toBe(opened + 1);
    expect(failures).toEqual([]);
  });

  it("a change that's refused is a plain error, and the next write still goes through", async () => {
    const { live, state } = slowClips();
    await expect(live.change("run1", (s) => s.answer("per_shot[P3-01].pick", { action: "lock", selection: ["1.1"], by: "human" }))).rejects.toThrow("isn't waiting for an answer");
    await live.change("run1", (s) => s.answer("approve_shots", { action: "approve", by: "human" }));
    await live.idle();
    expect(state().nodes["approve_shots"]?.status).toBe("completed");
  });
});

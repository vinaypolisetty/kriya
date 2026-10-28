import { describe, expect, it } from "vitest";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadText } from "../src/load.js";
import { Recorder, readRun, replay, Scheduler, type Executors, type Graph, type Judged } from "../src/index.js";

const recipe = (text: string): Graph => {
  const r = loadText(text);
  expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
  return r.graphs[0]!;
};
const problems = (text: string) => loadText(text).problems.filter((p) => p.severity === "error").map((p) => p.message);

function start(g: Graph, exec: Executors, inputs: Record<string, unknown> = {}) {
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(g, rec, exec, [g]);
  s.start("a".repeat(64), inputs);
  s.run();
  return { s, rec, log };
}

const voice = recipe(`graph: voice
level: line
nodes:
  - id: speak
    kind: model
    capability: audio.speech
    trust: always
    check: { seconds: { max: 8 } }
    out: { audio: audio, seconds: number }
  - id: faster
    kind: model
    capability: audio.speech
    trust: always
    refines: speak
    out: { audio: audio, seconds: number }
edges:
  - { from: speak, to: faster, when: "not verdict.pass" }
  - { from: speak, to: END, when: "verdict.pass" }
  - { from: faster, to: END }
`);

describe("code checks: limits on what a step made (Day 20)", () => {
  it("a line over 8 s gets a failing verdict with the reason, and an edge routes on verdict.pass", () => {
    const takes = [9.4, 6.2];
    const { rec, log } = start(voice, { produce: () => [{ audio: "a.wav", seconds: takes.shift()! }], decide: () => undefined });
    const v = rec.state.nodes.speak!.versions["1.1"]!;
    expect(v.verdicts).toEqual([{ by: "code", pass: false, issues: [{ type: "seconds_over", what: "seconds is 9.4, over 8" }], cost_usd: 0 }]);
    expect(rec.state.nodes.speak!.versions["2.1"]).toMatchObject({ madeBy: "faster", output: { seconds: 6.2 } });
    expect(rec.state.status).toBe("completed");
    expect(replay(readRun(log, "run1"))).toEqual(rec.state);
  });

  it("a line under the limit passes and goes straight on", () => {
    const { rec } = start(voice, { produce: () => [{ audio: "a.wav", seconds: 5 }], decide: () => undefined });
    expect(rec.state.nodes.speak!.versions["1.1"]!.verdicts[0]).toMatchObject({ pass: true, issues: [] });
    expect(rec.state.nodes.faster).toBeUndefined();
  });
});

describe("a yes/no check: found: { is: true } (D-74)", () => {
  const find = recipe(`graph: find
level: company
nodes:
  - id: research
    kind: model
    capability: llm.research
    trust: always
    check: { found: { is: true } }
    out: { found: boolean, release: text }
edges:
  - { from: research, to: END, when: "verdict.pass" }
`);
  it("a find that read the release passes; one that didn't fails as 'not found'", () => {
    const yes = start(find, { produce: () => [{ found: true, release: "Revenue up 9%" }], decide: () => undefined });
    expect(yes.rec.state.nodes.research!.versions["1.1"]!.verdicts[0]).toMatchObject({ by: "code", pass: true, issues: [] });
    const no = start(find, { produce: () => [{ found: false, release: "the fetch limit ran out" }], decide: () => undefined });
    expect(no.rec.state.nodes.research!.versions["1.1"]!.verdicts[0]).toMatchObject({ by: "code", pass: false, issues: [{ type: "not_found", what: "not found" }] });
    expect(replay(readRun(no.log, "run1"))).toEqual(no.rec.state);
  });
});

const panel = (trust: string, screen = false) =>
  recipe(`graph: shot
level: shot
nodes:
  - id: draw
    kind: model
    capability: image.generate
    options: 3
    trust: ${trust}
    check:
      rubric: ["Only the listed characters appear; no extra people."]
    out: { image: image }
${screen ? `  - id: pick
    kind: screen
    review: pick_one
    show: draw.image
    actions:
      - { id: lock, needs: [selection], locks: true }
edges:
  - { from: draw, to: pick }
  - { from: pick, to: END }` : `edges:
  - { from: draw, to: END }`}
`);

const draws = () => [1, 2, 3].map((i) => ({ image: `img${i}` }));
/** A judge that fails the candidates it's told to, with an extra person at the edge. */
const judge = (bad: string[], calls: string[][] = []) => (_n: unknown, _c: unknown, cands: { version: string }[]): Judged[] => {
  calls.push(cands.map((c) => c.version));
  return cands.map((c) => ({ version: c.version, pass: !bad.includes(c.version), issues: bad.includes(c.version) ? [{ type: "extra_character", where: "right edge", fix: "crop" }] : [], model: "judge-1", cost_usd: 0.01 }));
};

describe("a rubric: a judge looks at every candidate (Day 20)", () => {
  it("each candidate gets the judge's verdict, with its model and cost", () => {
    const { rec } = start(panel("ask_me", true), { produce: draws, check: judge(["1.1"]), decide: () => undefined });
    const vs = rec.state.nodes.draw!.versions;
    expect(vs["1.1"]!.verdicts).toEqual([{ by: "llm", pass: false, issues: [{ type: "extra_character", where: "right edge", fix: "crop" }], model: "judge-1", cost_usd: 0.01 }]);
    expect(vs["1.2"]!.verdicts[0]!.pass).toBe(true);
    expect(rec.state.costUsd).toBeCloseTo(0.03);
  });

  it("the screen shows each candidate's verdict, so a bad panel is caught before anyone picks it", () => {
    const { s } = start(panel("ask_me", true), { produce: draws, check: judge(["1.1"]), decide: () => undefined });
    expect(s.inbox()[0]!.shows.map((x) => [x.version, x.verdict?.pass])).toEqual([["1.1", false], ["1.2", true], ["1.3", true]]);
    expect(s.inbox()[0]!.shows[0]!.verdict!.issues).toEqual([{ type: "extra_character", where: "right edge", fix: "crop" }]);
  });

  it("when_confident locks the first candidate that passed; with none passing, it asks", () => {
    const one = start(panel("when_confident"), { produce: draws, check: judge(["1.1"]), decide: () => undefined });
    expect(one.rec.state.nodes.draw!.locked).toEqual({ version: "1.2", by: "auto" });
    expect(one.rec.state.status).toBe("completed");
    const none = start(panel("when_confident"), { produce: draws, check: judge(["1.1", "1.2", "1.3"]), decide: () => undefined });
    expect(none.rec.state.nodes.draw!.locked).toBeUndefined();
    expect(none.s.inbox()).toHaveLength(1); // the generated approval
  });

  it("a slow judge: the step waits on it, a restart asks the judge again (not the model), then it carries on", () => {
    let produced = 0;
    const calls: string[][] = [];
    const exec: Executors = { produce: () => (produced++, draws()), check: (_n, c) => ({ ticket: `check:${c.idempotencyKey}` }), decide: () => undefined };
    const { rec, log } = start(panel("when_confident"), exec);
    expect(rec.state.nodes.draw).toMatchObject({ status: "waiting_external", ticket: "check:run1/draw#1/check", ticketKind: "check_job" });

    // The process dies; a new one resumes.
    const r2 = Recorder.resume(log, "run1");
    const s2 = new Scheduler(panel("when_confident"), r2, { ...exec, check: (n, c, cands) => (calls.push(["again"]), { ticket: `check:${c.idempotencyKey}` }) }, []);
    s2.recover();
    expect(calls).toEqual([["again"]]);
    expect(produced).toBe(1);
    s2.deliverVerdicts("check:run1/draw#1/check", judge(["1.1"])(null, null, [{ version: "1.1" }, { version: "1.2" }, { version: "1.3" }]));
    s2.run();
    expect(r2.state.nodes.draw!.locked).toEqual({ version: "1.2", by: "auto" });
    expect(replay(readRun(log, "run1"))).toEqual(r2.state);
  });

  it("with nothing to judge it, a rubric fails the step plainly", () => {
    const { rec } = start(panel("ask_me", true), { produce: draws, decide: () => undefined });
    expect(rec.state.nodes.draw!.failure).toBe("it has a rubric, and nothing here can judge it: set up a vision model (models: { llm: anthropic })");
  });

  it("checking again later records new verdicts without moving any lock", () => {
    const { s, rec } = start(panel("ask_me", true), { produce: draws, check: judge([]), decide: () => undefined });
    const { candidates, ctx } = s.checkRequest("draw");
    expect(candidates.map((c) => c.version)).toEqual(["1.1", "1.2", "1.3"]);
    expect(ctx.idempotencyKey).toBe("run1/draw#1/check");
    s.recordVerdicts("draw", judge(["1.3"])(null, null, candidates));
    expect(rec.state.nodes.draw!.versions["1.3"]!.verdicts.map((v) => v.pass)).toEqual([true, false]); // both kept, in history
    expect(s.inbox()[0]!.shows.map((x) => x.verdict!.pass)).toEqual([true, true, false]);
    s.recordVerdicts("draw", judge([])(null, null, candidates)); // the rubric changed and 1.3 passes now
    expect(s.inbox()[0]!.shows.map((x) => x.verdict!.pass)).toEqual([true, true, true]); // the latest judgement counts
    expect(() => s.checkRequest("pick")).toThrow("'pick' has no rubric to check against");
  });
});

describe("check: mistakes are caught when the recipe loads", () => {
  const step = (check: string, out = "{ audio: audio, seconds: number }") => `graph: g
level: line
nodes:
  - id: speak
    kind: model
    capability: audio.speech
    check: ${check}
    out: ${out}
edges:
  - { from: speak, to: END }
`;
  it("a limit on something that isn't a number the step makes, with the nearest name", () => {
    expect(problems(step("{ secconds: { max: 8 } }"))).toEqual(["'secconds' isn't a number this step makes. Did you mean 'seconds'? A check limits a number in its out (seconds) or has a rubric"]);
  });
  it("a limit with no bound, and min above max", () => {
    expect(problems(step("{ seconds: {} }"))).toEqual(["say the limit, e.g. seconds: { max: 8 }"]);
    expect(problems(step("{ seconds: { min: 9, max: 8 } }"))).toEqual(["min (9) is above max (8)"]);
  });
  it("a rubric on a step that makes audio: the judge can't listen (written work is fine, D-73)", () => {
    expect(problems(step('{ rubric: ["clear"] }'))).toEqual(["a rubric is judged by looking at images or reading words, and this step makes audio; limit a number instead, e.g. seconds: { max: 8 }"]);
  });
  it("a yes/no check needs a boolean the step makes, and takes is:, not min or max (D-74)", () => {
    expect(problems(step("{ found: { is: true } }", "{ found: boolean, release: text }"))).toEqual([]);
    expect(problems(step("{ fund: { is: true } }", "{ found: boolean }"))).toEqual(["'fund' isn't a yes/no (boolean) this step makes. Did you mean 'found'? 'is:' checks one in its out (found)"]);
    expect(problems(step("{ found: { is: true, min: 1 } }", "{ found: boolean }"))).toEqual(["'found' is a yes/no: use is: true or is: false, not min or max"]);
  });
  it("a rubric on written work is fine; on a step with no outputs there's nothing to judge", () => {
    expect(problems(step('{ rubric: ["every number is in the release"] }', "{ summary: text, total: number, notes: list<text> }"))).toEqual([]);
    expect(problems(step('{ rubric: ["clear"] }', "{}"))).toEqual(["a rubric needs something to judge, and this step declares no outputs (out:)"]);
  });
  it("an edge reading 'verdict' from a step with no check", () => {
    expect(problems(`graph: g
level: line
nodes:
  - id: speak
    kind: model
    capability: audio.speech
    out: { audio: audio }
edges:
  - { from: speak, to: END, when: "verdict.pass" }
`)).toEqual(["'speak' has no check:, so it has no 'verdict'. Add one, e.g. check: { rubric: [...] }"]);
  });
});

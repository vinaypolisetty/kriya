import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadText, memoryBlobs, readRun, Recorder, replay, Scheduler, type Graph, type Tools } from "@kriya/engine";
import { anthropicExecutors, describeError, Jobs, settle } from "../src/index.js";

type Params = Record<string, unknown> & { messages: { role: string; content: unknown }[] };

/** A fake Anthropic client: answers from a script, remembers every request. */
function fakeClient(script: (params: Params, n: number) => unknown) {
  const requests: Params[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Params) => {
          requests.push(JSON.parse(JSON.stringify(params)) as Params);
          const r = script(params, requests.length);
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const message = (content: unknown[], stop_reason = "end_turn", extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_details: null,
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...extra,
});

const RELEASE = "a".repeat(64);
const load = (text: string): Graph => {
  const r = loadText(text);
  expect(r.problems).toEqual([]);
  return r.graphs[0]!;
};

function start(g: Graph, client: Anthropic, inputs: Record<string, unknown>, tools?: Tools) {
  const jobs = new Jobs();
  const exec = { ...anthropicExecutors({ graphs: [g], jobs, client, ...(tools ? { tools } : {}) }), decide: () => ({ action: "approve" }) };
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(g, rec, exec, [g], { blobs: memoryBlobs(), ...(tools ? { tools } : {}) });
  s.start(RELEASE, inputs);
  return { s, rec, jobs, log };
}

// ── llm.write ──────────────────────────────────────────────────────────────

const shotList = load(`graph: part
level: part
inputs:
  story_pages: text
  part_no: number
types:
  shot:
    fields: { id: text, action: text, animate: boolean }
nodes:
  - id: shot_list
    kind: model
    capability: llm.write
    prompt: |
      Turn these pages into shots named P{{inputs.part_no}}-NN.
      {{inputs.story_pages}}
    uses: [inputs.story_pages, inputs.part_no]
    trust: always
    out: { shots: list<shot>, hook: text }
edges:
  - { from: shot_list, to: END }
`);

const shots = { shots: [{ id: "P3-01", action: "Tanker arrives", animate: false }], hook: "Who will close the valve?" };

describe("llm.write: a model step's answer fits its declared outputs", () => {
  it("asks Claude with the prompt filled in and a strict schema; the answer becomes the step's version", async () => {
    const { client, requests } = fakeClient(() => message([{ type: "text", text: JSON.stringify(shots) }]));
    const { s, rec, jobs } = start(shotList, client, { story_pages: "Mitra spots the tanker.", part_no: 3 });
    await settle(s, jobs, describeError);

    expect(rec.state.status).toBe("completed");
    expect(rec.state.nodes.shot_list!.versions["1.1"]!.output).toEqual(shots);
    const req = requests[0]!;
    expect(req).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01", "context-management-2025-06-27"] });
    expect((req.messages[0]!.content as { text: string }[]).at(-1)!.text).toBe("Turn these pages into shots named P3-NN.\nMitra spots the tanker.");
    expect(req.output_config).toEqual({
      effort: "high",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            shots: { type: "array", items: { type: "object", properties: { id: { type: "string" }, action: { type: "string" }, animate: { type: "boolean" } }, required: ["id", "action", "animate"], additionalProperties: false } },
            hook: { type: "string" },
          },
          required: ["shots", "hook"],
          additionalProperties: false,
        },
      },
    });
  });

  it("records the exact model version and the cost on the version (rule 6)", async () => {
    const { client } = fakeClient(() => message([{ type: "text", text: JSON.stringify(shots) }], "end_turn", { model: "claude-opus-4-8" })); // served by the fallback
    const { s, jobs, log } = start(shotList, client, { story_pages: "x", part_no: 3 });
    await settle(s, jobs, describeError);
    const produced = readRun(log, "run1").find((e) => e.type === "CandidateProduced");
    expect(produced).toMatchObject({ model: "claude-opus-4-8", cost_usd: (1000 * 5 + 200 * 25) / 1e6 });
  });

  it("a step that pins its model uses it", async () => {
    const pinned = load(`graph: g
level: part
nodes:
  - { id: w, kind: model, capability: llm.write, model: claude-haiku-5-5, prompt: hi, trust: always, out: { t: text } }
edges:
  - { from: w, to: END }
`);
    const { client, requests } = fakeClient(() => message([{ type: "text", text: '{"t":"ok"}' }]));
    const { s, jobs } = start(pinned, client, {});
    await settle(s, jobs, describeError);
    expect(requests[0]!.model).toBe("claude-haiku-5-5");
  });

  it("an applied tip's words follow the prompt, and are recorded with it (D-76)", async () => {
    const g = load(`graph: g
level: part
nodes:
  - { id: w, kind: model, capability: llm.write, prompt: "Summarize the release.", trust: always, out: { t: text } }
edges:
  - { from: w, to: END }
`);
    const { client, requests } = fakeClient(() => message([{ type: "text", text: '{"t":"ok"}' }]));
    const jobs = new Jobs();
    const exec = { ...anthropicExecutors({ graphs: [g], jobs, client, prevent: (n) => (n.id === "w" ? ["Only numbers the release states."] : []) }), decide: () => ({ action: "approve" }) };
    const rec = Recorder.start(new SqliteEventLog(openDatabase(":memory:")), "run1");
    const s = new Scheduler(g, rec, exec, [g], { blobs: memoryBlobs() });
    s.start(RELEASE, {});
    await settle(s, jobs, describeError);
    const sent = (requests[0]!.messages[0]!.content as { type: string; text: string }[])[0]!.text;
    expect(sent).toBe("Summarize the release.\nOnly numbers the release states.");
    expect(rec.state.nodes.w!.versions["1.1"]!.prompt).toBe(sent);
  });

  it("options: 3 makes three requests, three candidates", async () => {
    const three = load(`graph: g
level: part
nodes:
  - { id: w, kind: model, capability: llm.write, prompt: hi, options: 3, out: { t: text } }
`);
    let n = 0;
    const { client, requests } = fakeClient(() => message([{ type: "text", text: JSON.stringify({ t: `take ${++n}` }) }]));
    const { s, rec, jobs } = start(three, client, {});
    await settle(s, jobs, describeError);
    expect(requests).toHaveLength(3);
    expect(Object.values(rec.state.nodes.w!.versions).map((v) => v.output.t).sort()).toEqual(["take 1", "take 2", "take 3"]);
  });

  it("a refusal fails the step plainly, with the category", async () => {
    const { client } = fakeClient(() => message([], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: null } }));
    const { s, rec, jobs } = start(shotList, client, { story_pages: "x", part_no: 3 });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.shot_list).toMatchObject({ status: "failed", failure: "Claude declined this step (cyber)" });
  });

  it("a bad key fails the step with what to fix", async () => {
    const { client } = fakeClient(() => new Anthropic.AuthenticationError(401, {}, "invalid x-api-key", new Headers()));
    const { s, rec, jobs } = start(shotList, client, { story_pages: "x", part_no: 3 });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.shot_list!.failure).toBe("Claude rejected the API key. Check ANTHROPIC_API_KEY in .env");
  });
});

// ── Agents ─────────────────────────────────────────────────────────────────

const researcher = load(`graph: research
level: part
inputs:
  topic: text
nodes:
  - id: analyst
    kind: agent
    goal: Write a short report on the topic
    tools: [search]
    uses: [inputs.topic]
    trust: always
    out: { report: text }
edges:
  - { from: analyst, to: END }
`);

const searchTool: Tools = {
  call: (_tool, args) => ({ hits: [`about ${(args as { q: string }).q}`] }),
  describe: (tool) => (tool === "search" ? { description: "Search the web", input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } } : undefined),
};

/** Turn 1 (only the goal so far): think, search and note. Turn 2: finish. */
const agentScript = (p: Params) =>
  p.messages.length === 1
    ? message(
        [
          { type: "thinking", thinking: "", signature: "sig-1" },
          { type: "tool_use", id: "toolu_1", name: "search", input: { q: "tanker mafia" } },
          { type: "tool_use", id: "toolu_2", name: "note", input: { key: "angle", text: "focus on Pune" } },
        ],
        "tool_use",
      )
    : message([{ type: "tool_use", id: "toolu_3", name: "finish", input: { report: "Tankers set the price." } }], "tool_use");

describe("agents: one request per turn, the conversation rebuilt append-only", () => {
  it("fills {{refs}} in the goal from what the step received", async () => {
    const g = load(`graph: g
level: part
inputs:
  topic: text
nodes:
  - { id: a, kind: agent, goal: "Write about {{inputs.topic}}", tools: [search], trust: always, out: { report: text } }
edges:
  - { from: a, to: END }
`);
    const { client, requests } = fakeClient(agentScript);
    const { s, jobs } = start(g, client, { topic: "water tankers" }, searchTool);
    await settle(s, jobs, describeError);
    expect(requests[0]!.messages[0]).toEqual({ role: "user", content: "Goal: Write about water tankers" });
  });

  it("runs to finish; the final answer is the step's version", async () => {
    const { client, requests } = fakeClient(agentScript);
    const { s, rec, jobs } = start(researcher, client, { topic: "water tankers" }, searchTool);
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.analyst!.versions["1.1"]!.output).toEqual({ report: "Tankers set the price." });
    expect(requests).toHaveLength(2);
  });

  it("every request starts with the previous request's messages, unchanged, thinking blocks included", async () => {
    const { client, requests } = fakeClient(agentScript);
    const { s, jobs } = start(researcher, client, { topic: "water tankers" }, searchTool);
    await settle(s, jobs, describeError);
    const [first, second] = requests;
    expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
    expect(second!.messages[1]).toEqual({ role: "assistant", content: agentScript({ messages: [{ role: "user", content: "" }] }).content });
    expect(second!.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: JSON.stringify({ hits: ["about tanker mafia"] }), is_error: false },
        { type: "tool_result", tool_use_id: "toolu_2", content: JSON.stringify({ saved: "angle" }), is_error: false },
        { type: "text", text: "Your notes:\n- angle: focus on Pune" },
      ],
    });
    expect(first!.system).toBe(second!.system);
    expect(first!.tools).toEqual(second!.tools);
  });

  it("offers the step's tools, the built-ins and a strict finish, in a fixed order; clears old results server-side", async () => {
    const { client, requests } = fakeClient(agentScript);
    const { s, jobs } = start(researcher, client, { topic: "x" }, searchTool);
    await settle(s, jobs, describeError);
    const tools = requests[0]!.tools as { name: string; strict?: boolean }[];
    expect(tools.map((t) => t.name)).toEqual(["ask_human", "finish", "list_files", "note", "read_file", "recall", "search", "write_file"]);
    expect(tools.find((t) => t.name === "finish")!.strict).toBe(true);
    expect(requests[0]!.context_management).toEqual({ edits: [{ type: "clear_tool_uses_20250919" }] });
    expect(requests[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("records each turn's model version, tokens (cache included) and cost", async () => {
    const { client } = fakeClient(agentScript);
    const { s, jobs, log } = start(researcher, client, { topic: "x" }, searchTool);
    await settle(s, jobs, describeError);
    const turn = readRun(log, "run1").find((e) => e.type === "AgentTurn");
    expect(turn).toMatchObject({ model: "claude-opus-5-5", tokens: { input: 1000, output: 200 }, cost_usd: (1000 * 4 + 200 * 20) / 1e6, context_window: 1_000_000 });
  });

  it("an agent that answers in text instead of calling finish: a single text output takes it as written", async () => {
    const { client } = fakeClient(() => message([{ type: "text", text: "Tankers set the price." }]));
    const { s, rec, jobs } = start(researcher, client, { topic: "x" }, searchTool);
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.analyst!.versions["1.1"]!.output).toEqual({ report: "Tankers set the price." });
  });

  it("a tool with no description fails the step and says what to do", async () => {
    const { client } = fakeClient(agentScript);
    const { s, rec, jobs } = start(researcher, client, { topic: "x" }, { call: () => null });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.analyst!.failure).toBe("the tool 'search' has no description for Claude; describe it in the tools setup");
  });

  it("a process that dies mid-request: the next one asks again with the same conversation, and replay matches", async () => {
    const { client, requests } = fakeClient(agentScript);
    const { s, rec, jobs, log } = start(researcher, client, { topic: "water tankers" }, searchTool);
    s.run(); // turn 1 is in flight; the process dies before it's delivered
    expect(rec.state.nodes.analyst!.status).toBe("waiting_external");

    const jobs2 = new Jobs();
    const exec2 = { ...anthropicExecutors({ graphs: [researcher], jobs: jobs2, client, tools: searchTool }), decide: () => ({ action: "approve" }) };
    const r2 = Recorder.resume(log, "run1");
    const s2 = new Scheduler(researcher, r2, exec2, [researcher], { blobs: memoryBlobs(), tools: searchTool });
    s2.recover();
    expect(jobs2.size).toBe(1);
    await settle(s2, jobs2, describeError);
    expect(r2.state.status).toBe("completed");
    expect(requests[1]!.messages).toEqual(requests[0]!.messages); // the same turn, asked again
    expect(requests).toHaveLength(3); // turn 1 twice (the first answer was lost), then turn 2
    expect(replay(readRun(log, "run1"))).toEqual(r2.state);
    void jobs; // the first process's job died with it
  });
});

// ── checks: the judge (Day 20) ─────────────────────────────────────────────

describe("a rubric judged by Claude (Day 20)", () => {
  const shot = load(`graph: shot
level: shot
inputs:
  item: json
nodes:
  - id: draw
    kind: model
    capability: image.generate
    options: 2
    prompt: "{{item.action}}. Characters: {{item.characters@look}}"
    uses: [item.action, item.characters@look]
    check:
      rubric: ["Only the listed characters appear; no extra people.", "No readable text."]
    out: { image: image }
  - id: pick
    kind: screen
    review: pick_one
    show: draw.image
    actions:
      - { id: lock, needs: [selection], locks: true }
edges:
  - { from: draw, to: pick }
  - { from: pick, to: END }
`);
  const png = (tag: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new TextEncoder().encode(tag)]);
  const media = { read: (v: string) => (v.startsWith("blob:") ? { bytes: png(v), mime: "image/png" } : undefined), write: (b: Uint8Array) => `blob:${b.length}` };

  function judged(answers: unknown[]) {
    const { client, requests } = fakeClient((_p, n) => message([{ type: "text", text: JSON.stringify(answers[n - 1]) }]));
    const jobs = new Jobs();
    const claude = anthropicExecutors({ graphs: [shot], jobs, client, media });
    const exec = { produce: () => [{ image: "blob:p1" }, { image: "blob:p2" }], check: claude.check, decide: () => undefined };
    const log = new SqliteEventLog(openDatabase(":memory:"));
    const rec = Recorder.start(log, "run1");
    const s = new Scheduler(shot, rec, exec, [shot], { assets: { facet: (e: string) => ({ version: "v1", value: { image: "x.png", words: e === "Bheem" ? "a very tall bodybuilder" : "a big-bellied man" } }) } });
    s.start(RELEASE, { item: { action: "Bheem leaps up", characters: ["Bheem", "Dhanpat"] } });
    return { s, rec, log, jobs, requests };
  }

  it("each candidate's image goes to Claude with what was asked and the rules; the answer is a verdict with fixes", async () => {
    const { s, rec, log, jobs, requests } = judged([
      { pass: false, issues: [{ type: "extra_character", what: "a third man in a red shirt", where: "right edge", fix: "crop" }] },
      { pass: true, issues: [] },
    ]);
    await settle(s, jobs, describeError);
    expect(requests).toHaveLength(2);
    const content = requests[0]!.messages[0]!.content as { type: string; source?: { type: string; media_type: string; data: string }; text?: string }[];
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(png("blob:p1")).toString("base64") } });
    expect(content[1]!.text).toBe(
      "What the step was asked:\nBheem leaps up. Characters: Bheem (a very tall bodybuilder); Dhanpat (a big-bellied man)\n\nRules:\n1. Only the listed characters appear; no extra people.\n2. No readable text.",
    );
    expect((requests[0]!.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    const vs = rec.state.nodes.draw!.versions;
    expect(vs["1.1"]!.verdicts).toEqual([{ by: "llm", pass: false, issues: [{ type: "extra_character", what: "a third man in a red shirt", where: "right edge", fix: "crop" }], model: "claude-opus-5-5", cost_usd: 0.008 }]);
    expect(vs["1.2"]!.verdicts[0]).toMatchObject({ pass: true, issues: [] });
    expect(s.inbox()[0]!.shows.map((x) => x.verdict?.pass)).toEqual([false, true]);
    expect(replay(readRun(log, "run1"))).toEqual(rec.state);
  });

  it("a 'pass' that lists issues counts as a fail, and an empty 'where' is left out", async () => {
    const { s, rec, jobs } = judged([
      { pass: true, issues: [{ type: "readable_text", what: "a sign says RAJA", where: "", fix: "edit" }] },
      { pass: true, issues: [] },
    ]);
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.draw!.versions["1.1"]!.verdicts[0]).toMatchObject({ pass: false, issues: [{ type: "readable_text", what: "a sign says RAJA", fix: "edit" }] });
  });
});

describe("a rubric on written work: the judge reads it (D-73)", () => {
  const summary = load(`graph: company
level: company
inputs:
  item: json
nodes:
  - id: summarize
    kind: model
    capability: llm.write
    prompt: "Summarize {{item.company}}'s quarter from this release only:\\n{{item.release}}"
    uses: [item.company, item.release]
    check:
      rubric: ["Every number appears in the release, with the same value."]
    out: { headline: text, revenue: text }
  - id: review
    kind: screen
    review: approve
    show: summarize.headline
    actions:
      - { id: approve, locks: true }
edges:
  - { from: summarize, to: review }
  - { from: review, to: END }
`);

  it("no image and no media store needed: the candidate's text goes to Claude with what the step was given; no crop on offer", async () => {
    const { client, requests } = fakeClient(() => message([{ type: "text", text: JSON.stringify({ pass: false, issues: [{ type: "unsupported_number", what: "revenue 12.4 isn't in the release (it says 12.1)", where: "revenue", fix: "edit", keep: "" }] }) }]));
    const jobs = new Jobs();
    const claude = anthropicExecutors({ graphs: [summary], jobs, client });
    const exec = { produce: () => [{ headline: "Acme Tea grew", revenue: "$12.4M" }], check: claude.check, decide: () => undefined };
    const log = new SqliteEventLog(openDatabase(":memory:"));
    const rec = Recorder.start(log, "run1");
    const s = new Scheduler(summary, rec, exec, [summary]);
    s.start(RELEASE, { item: { company: "Acme Tea", release: "Revenue was $12.1M." } });
    await settle(s, jobs, describeError);

    const p = requests[0]!;
    expect(p.system).toMatch(/written by a step/);
    const content = p.messages[0]!.content as { type: string; text?: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]!.text).toContain("Summarize Acme Tea's quarter from this release only:\nRevenue was $12.1M.");
    expect(content[0]!.text).toContain("The candidate:\n");
    expect(content[0]!.text).toContain("$12.4M");
    const schema = (p.output_config as { format: { schema: { properties: { issues: { items: { properties: { fix: { enum: string[] } } } } } } } }).format.schema;
    expect(schema.properties.issues.items.properties.fix.enum).toEqual(["edit", "retry"]);
    expect(rec.state.nodes.summarize!.versions["1.1"]!.verdicts[0]).toMatchObject({ pass: false, issues: [{ type: "unsupported_number", where: "revenue", fix: "edit" }] });
    expect(replay(readRun(log, "run1"))).toEqual(rec.state);
  });
});

describe("llm.research: Claude with web search and web fetch (D-74)", () => {
  const finder = load(`graph: find
level: company
inputs:
  item: text
nodes:
  - id: research
    kind: model
    capability: llm.research
    trust: always
    params: { max_searches: 3, max_fetches: 2, domains: [apple.com] }
    prompt: "Find the latest quarterly earnings release for {{item}}."
    uses: [item]
    out: { company: text, release: text, url: text, date: text }
edges:
  - { from: research, to: END }
`);
  const found = { company: "Apple Inc.", release: "Revenue $94.0 billion, up 10 percent", url: "https://www.apple.com/newsroom/q3", date: "July 30, 2026" };

  it("searches and fetches with limits; a paused search is carried on; the pages read are the version's references; each search adds a cent", async () => {
    const usage = (searches: number) => ({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: searches, web_fetch_requests: 1 } });
    const { client, requests } = fakeClient((_p, n) =>
      n === 1
        ? message([{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "Apple Q3 results" } }], "pause_turn", { usage: usage(2) })
        : message([
            { type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_result", url: "https://www.apple.com/newsroom/q3", content: { type: "document", source: { type: "text", media_type: "text/plain", data: "…" } } } },
            { type: "text", text: JSON.stringify(found) },
          ], "end_turn", { usage: usage(1) }),
    );
    const { s, rec, jobs, log } = start(finder, client, { item: "AAPL" });
    await settle(s, jobs, describeError);

    expect(requests).toHaveLength(2);
    const tools = requests[0]!.tools as { type: string; max_uses: number; allowed_domains?: string[] }[];
    expect(tools.map((t) => [t.type, t.max_uses, t.allowed_domains])).toEqual([["web_search_20260209", 3, ["apple.com"]], ["web_fetch_20260209", 2, undefined]]);
    expect(requests[0]!.system).toMatch(/Find what the step asks for on the web/);
    expect((requests[0]!.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    // The paused message goes back unchanged, after the question.
    expect(requests[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect((requests[1]!.messages[1]!.content as { type: string }[])[0]!.type).toBe("server_tool_use");

    const v = rec.state.nodes.research!.versions["1.1"]!;
    expect(v.output).toEqual(found);
    expect(v.references).toEqual([{ label: "page 1", ref: "https://www.apple.com/newsroom/q3" }]);
    expect(v.costUsd).toBeCloseTo(0.008 * 2 + 0.03, 6); // two requests' tokens, three searches
    expect(replay(readRun(log, "run1"))).toEqual(rec.state);
  });

  it("a search that keeps pausing stops after 6 rounds with a plain reason", async () => {
    const { client } = fakeClient(() => message([{ type: "server_tool_use", id: "s", name: "web_search", input: {} }], "pause_turn"));
    const { s, rec, jobs } = start(finder, client, { item: "AAPL" });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.research?.failure).toMatch(/didn't finish after 6 rounds/);
  });
});

describe("fields typed library.<kind>: only names the Library has", () => {
  it("the schema Claude answers to lists the Library's places and characters; a kind with none is a plain error", async () => {
    const g = load(`graph: part
level: part
types:
  shot:
    fields: { id: text, place: library.place, characters: list<library.character> }
nodes:
  - id: shot_list
    kind: model
    capability: llm.write
    prompt: Break it into shots.
    trust: always
    out: { shots: list<shot> }
edges:
  - { from: shot_list, to: END }
`);
    const { client, requests } = fakeClient(() => message([{ type: "text", text: JSON.stringify({ shots: [{ id: "S1", place: "Reservoir", characters: ["Mitra"] }] }) }]));
    const jobs = new Jobs();
    const names = (kind: string) => (kind === "place" ? ["Mitra's chai stall", "Reservoir"] : kind === "character" ? ["Mitra", "Bheem"] : []);
    const exec = { ...anthropicExecutors({ graphs: [g], jobs, client, names }), decide: () => undefined };
    const rec = Recorder.start(new SqliteEventLog(openDatabase(":memory:")), "run1");
    const s = new Scheduler(g, rec, exec, [g]);
    s.start(RELEASE, {});
    await settle(s, jobs, describeError);
    const shot = (requests[0]!.output_config as { format: { schema: { properties: { shots: { items: { properties: Record<string, unknown> } } } } } }).format.schema.properties.shots.items.properties;
    expect(shot.place).toMatchObject({ type: "string", enum: ["Mitra's chai stall", "Reservoir"] });
    expect(shot.characters).toMatchObject({ type: "array", items: { type: "string", enum: ["Mitra", "Bheem"] } });

    const none = anthropicExecutors({ graphs: [g], jobs: new Jobs(), client, names: () => [] });
    const s2 = new Scheduler(g, Recorder.start(new SqliteEventLog(openDatabase(":memory:")), "run2"), { ...none, decide: () => undefined }, [g]);
    s2.start(RELEASE, {});
    expect(() => s2.run()).toThrow("the Library has no place for this step to choose from; add one to library/ (kind: place)");
  });
});

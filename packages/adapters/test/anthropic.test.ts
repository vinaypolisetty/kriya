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

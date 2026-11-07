import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { briefText, claudeChat, claudeRunChat, runBriefText, type ChatBrief, type Media, type RunChatBrief } from "../src/index.js";

/** A step's chat on Claude (D-87): what it's sent, and how its answer is read. */

type Params = Record<string, unknown> & { messages: { role: string; content: unknown }[]; output_config: { format: { schema: unknown } } };

function fakeClient(answer: unknown) {
  const requests: Params[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Params) => {
          requests.push(JSON.parse(JSON.stringify(params)) as Params);
          return {
            model: "claude-opus-5-5",
            content: [{ type: "text", text: JSON.stringify(answer) }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const media: Media = { read: (v) => (v === "blob:abc" ? { bytes: PNG, mime: "image/png" } : undefined), write: () => "" };

const brief = (over: Partial<ChatBrief> = {}): ChatBrief => ({
  step: { key: "per_shot[P3-04].draw", name: "Draw the shot", kind: "model", asks: "Mitra at the tap", makes: ["image (image)"] },
  shapes: [],
  canEdit: true,
  finished: false,
  versions: [
    { n: 1, branch: "main", locked: false, intention: "from recipe", output: { image: "blob:abc" }, checks: "passed" },
    { n: 2, branch: "night", locked: true, intention: 'from v1: "night"', output: { image: "blob:def" }, model: "google/nano-banana-2" },
  ],
  facets: [{ ref: "Mitra.look", value: { image: "sheets/mitra.png", words: "a thin 60-year-old bald man" }, from: "Library" }],
  library: ["Mitra (character): look, voice, speech"],
  story: { inputs: { part_no: 3 }, locked: [{ key: "shot_list", value: { hook: "the tanker never came" } }] },
  images: [{ n: 1, ref: "blob:abc" }, { n: 2, ref: "blob:def" }],
  thread: [
    { by: "you", text: "why so dark?" },
    { by: "kriya", text: "It's night." },
  ],
  message: "make v1 warmer, keep the pose",
  ...over,
});

describe("claudeChat", () => {
  it("sends the conversation, then the brief with the pictures it can read, then the message", async () => {
    const { client, requests } = fakeClient({ reply: "Done.", actions: [] });
    await claudeChat({ client, media })(brief());
    const [req] = requests;
    expect(req!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(req!.messages[0]!.content).toBe("why so dark?");
    const last = req!.messages[2]!.content as { type: string; text?: string }[];
    expect(last.map((b) => b.type)).toEqual(["text", "text", "image", "text"]); // v2's blob isn't readable: left out
    expect(last[1]!.text).toBe("v1:");
    expect(last.at(-1)!.text).toBe("The person says: make v1 warmer, keep the pose");
    expect(req!.output_config.format.schema).toMatchObject({ required: ["reply", "actions"] });
  });

  it("reads the answer as words and actions, with the model and its cost", async () => {
    const { client } = fakeClient({
      reply: "Warming v1.",
      actions: [
        { do: "make", version: 1, why: "", instruction: "warmer light; keep the pose", how: "edit", entity: "", facet: "", field: "", value: "" },
        { do: "lock", version: 2, why: "", instruction: "", how: "edit", entity: "", facet: "", field: "", value: "" },
        { do: "change", version: 0, why: "", instruction: "", how: "edit", entity: "Mitra", facet: "voice", field: "words", value: "older, hoarse" },
        { do: "keep", version: 0, why: "", instruction: "", how: "edit", entity: "Mitra", facet: "voice", field: "", value: "" },
      ],
    });
    const r = await claudeChat({ client, media })(brief());
    expect(r).toEqual({
      text: "Warming v1.",
      actions: [
        { do: "make", from: 1, instruction: "warmer light; keep the pose", how: "edit" },
        { do: "lock", version: 2, why: "" },
        { do: "change", entity: "Mitra", facet: "voice", field: "words", value: "older, hoarse" },
        { do: "keep", entity: "Mitra", facet: "voice" },
      ],
      model: "claude-opus-5-5",
      cost_usd: (1000 * 4 + 200 * 20) / 1e6,
    });
  });

  it("an unanswered message (a crash before the answer) still alternates roles", async () => {
    const { client, requests } = fakeClient({ reply: "Hi.", actions: [] });
    await claudeChat({ client })(brief({ thread: [{ by: "you", text: "one" }, { by: "you", text: "two" }] }));
    expect(requests[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(requests[0]!.messages[0]!.content).toBe("one\n\ntwo");
  });
});

describe("briefText", () => {
  it("lists every version by number, why it exists, its branch and lock, the facets it uses, and the story so far", () => {
    const t = briefText(brief());
    expect(t).toContain("v1: from recipe\n  output: {\"image\":\"blob:abc\"}\n  checks: passed");
    expect(t).toContain('v2 (locked) [branch night]: from v1: "night"');
    expect(t).toContain("It can be edited (how: edit). The run is in progress.");
    expect(t).toContain('- shot_list: {"hook":"the tanker never came"}');
    expect(t).toContain('Library facets it uses:\n- Mitra.look (from the Library): {"image":"sheets/mitra.png","words":"a thin 60-year-old bald man"}');
    expect(t).toContain("In the Library: Mitra (character): look, voice, speech");
  });
});

const runBrief = (over: Partial<RunChatBrief> = {}): RunChatBrief => ({
  run: { id: "alien-3", recipe: "episode" },
  finished: false,
  steps: ["- shot_list: Break it into shots (model) · locked · v1, locked v1", "- per_shot[P3-04].draw: Draw the shot (model) · waiting for you · v1–v3"],
  whole: [{ ...brief(), step: { key: "shot_list", name: "Break it into shots", kind: "model", asks: "Turn these pages into shots", makes: ["shots (list<shot>)"] }, shapes: ["shot: id (text), action (text)"], versions: [{ n: 1, branch: "main", locked: true, intention: "from recipe", output: { shots: [{ id: "P3-05", action: "Mitra at the tap" }] } }] }],
  library: ["Mitra (character): look, voice, speech"],
  story: { inputs: { part_no: 3 }, locked: [{ key: "per_shot[P3-04].draw", value: { image: "(media)" } }] },
  thread: [{ by: "you", text: "hi" }, { by: "kriya", text: "Hello." }],
  message: "add a shot after P3-05 where Mitra spots the leak",
  ...over,
});

describe("claudeRunChat (D-95)", () => {
  it("sends the conversation, then the run in words and the message, and every action names its step", async () => {
    const { client, requests } = fakeClient({
      reply: "Added P3-05a.",
      actions: [
        { step: "shot_list", do: "patch", version: 1, why: "", instruction: "", how: "edit", edits: '[{"op":"add"}]', entity: "", facet: "", field: "", value: "" },
        { step: "", do: "change", version: 0, why: "", instruction: "", how: "edit", edits: "", entity: "Mitra", facet: "voice", field: "words", value: "older" },
      ],
    });
    const r = await claudeRunChat({ client })(runBrief());
    const [req] = requests;
    expect(req!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const last = req!.messages[2]!.content as { type: string; text?: string }[];
    expect(last.map((b) => b.type)).toEqual(["text", "text"]); // no pictures
    expect(last[1]!.text).toBe("The person says: add a shot after P3-05 where Mitra spots the leak");
    expect(req!.output_config.format.schema).toMatchObject({ properties: { actions: { items: { required: expect.arrayContaining(["step", "do", "edits"]) } } } });
    expect(r.actions).toEqual([
      { step: "shot_list", do: "patch", from: 1, edits: '[{"op":"add"}]' },
      { step: "", do: "change", entity: "Mitra", facet: "voice", field: "words", value: "older" },
    ]);
  });
});

describe("runBriefText (D-95)", () => {
  it("lists every step in a line, shows the run's own steps whole, then the Library and the story", () => {
    const t = runBriefText(runBrief());
    expect(t).toContain("Run: alien-3 (recipe episode). It's in progress.");
    expect(t).toContain("Its steps, a line each:\n- shot_list: Break it into shots (model) · locked · v1, locked v1\n- per_shot[P3-04].draw");
    expect(t).toContain("Step: Break it into shots (shot_list, a model step).");
    expect(t).toContain('v1 (locked): from recipe\n  output: {"shots":[{"id":"P3-05","action":"Mitra at the tap"}]}');
    expect(t).toContain("What its lists hold:\nshot: id (text), action (text)");
    expect(t).toContain('- per_shot[P3-04].draw: {"image":"(media)"}');
    expect(runBriefText(runBrief({ finished: true }))).toContain("It's finished, so it's frozen.");
  });
});

import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { briefText, claudeChat, type ChatBrief, type Media } from "../src/index.js";

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
  canEdit: true,
  finished: false,
  versions: [
    { n: 1, branch: "main", locked: false, intention: "from recipe", output: { image: "blob:abc" }, checks: "passed" },
    { n: 2, branch: "night", locked: true, intention: 'from v1: "night"', output: { image: "blob:def" }, model: "google/nano-banana-2" },
  ],
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
        { do: "make", version: 1, why: "", instruction: "warmer light; keep the pose", how: "edit" },
        { do: "lock", version: 2, why: "", instruction: "", how: "edit" },
      ],
    });
    const r = await claudeChat({ client, media })(brief());
    expect(r).toEqual({
      text: "Warming v1.",
      actions: [
        { do: "make", from: 1, instruction: "warmer light; keep the pose", how: "edit" },
        { do: "lock", version: 2, why: "" },
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
  it("lists every version by number, why it exists, its branch and lock, and the story so far", () => {
    const t = briefText(brief());
    expect(t).toContain("v1: from recipe\n  output: {\"image\":\"blob:abc\"}\n  checks: passed");
    expect(t).toContain('v2 (locked) [branch night]: from v1: "night"');
    expect(t).toContain("It can be edited (how: edit). The run is in progress.");
    expect(t).toContain('- shot_list: {"hook":"the tanker never came"}');
  });
});

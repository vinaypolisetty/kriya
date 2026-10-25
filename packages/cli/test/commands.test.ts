import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { openStore } from "@kriya/store";
import { Recorder } from "@kriya/engine";
import { main } from "../src/commands.js";

/** Runs one `kriya …` command in `cwd`, capturing what it prints. */
async function kriya(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), cwd });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function project(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kriya-cli-"));
  expect((await kriya(dir, "init", "p3", "--example", "mohalla-mitra")).code).toBe(0);
  return join(dir, "p3");
}

/** Writes one Library entity, `library/<file>.yaml`. */
function entity(cwd: string, file: string, yaml: string): void {
  writeFileSync(join(cwd, "library", `${file}.yaml`), yaml);
}

/** Answers whatever is first in the inbox, the simplest way each screen allows. */
async function answerFirst(cwd: string): Promise<string> {
  const inbox = (await kriya(cwd, "inbox")).out;
  const first = inbox.split("\n")[0]!;
  const button = /buttons: (\w+)/.exec(inbox)![1]!;
  const pick = /^\s+(\d+\.\d+)\s/m.exec(inbox)?.[1];
  const r = await kriya(cwd, "decide", "1", button, ...(pick ? ["--pick", pick] : []));
  expect(r.code, r.err).toBe(0);
  return first;
}

describe("a full fake episode from the terminal (Day 13)", () => {
  it("init → run → inbox / decide until done → status", async () => {
    const cwd = await project();
    const started = await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=Pages 7 to 9");
    expect(started.out).toContain("✓ Started part_recipe-1 (part_recipe)");
    expect(started.out).toContain("1 waiting on you");

    let answered = 0;
    while (!(await kriya(cwd, "inbox")).out.startsWith("Nothing is waiting on you.")) {
      await answerFirst(cwd);
      expect(++answered).toBeLessThan(20);
    }
    // approve shots, 3 panels, 2 clip approvals (S1 and S3 are animated; when_confident asks until checkers exist), 3 voice lines, watch
    expect(answered).toBe(1 + 3 + 2 + 3 + 1);

    const status = (await kriya(cwd, "status", "part_recipe-1")).out;
    expect(status.split("\n")[0]).toBe("part_recipe-1 · part_recipe · completed");
    expect(status).toContain("✓ assemble · locked 1.1");
  });

  it("runs survive between commands: every command is a new process reading .kriya/", async () => {
    const cwd = await project();
    await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    expect(existsSync(join(cwd, ".kriya", "kriya.db"))).toBe(true);
    expect((await kriya(cwd, "status")).out).toMatch(/^part_recipe-1\s+part_recipe\s+running · 1 waiting on you$/);
  });

  it("an edit shows up as the next version, and the only option needs no --pick", async () => {
    const cwd = await project();
    await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    await kriya(cwd, "decide", "1", "approve");
    expect((await kriya(cwd, "decide", "1", "edit", "--pick", "1.3", "--note", "add the gamcha")).code).toBe(0);
    expect((await kriya(cwd, "inbox")).out).toMatch(/per_shot\[S1\]\.pick: Pick one panel\n\s+2\.1\s+fake:\/\/image\/per_shot\[S1\]\.edit/);
    expect((await kriya(cwd, "decide", "1", "lock")).code).toBe(0);
  });

  it("lock moves a lock and says what went stale", async () => {
    const cwd = await project();
    await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    await kriya(cwd, "decide", "1", "approve");
    await kriya(cwd, "decide", "1", "edit", "--pick", "1.3", "--note", "add the gamcha");
    await kriya(cwd, "decide", "1", "lock");
    while (!(await kriya(cwd, "inbox")).out.startsWith("Nothing")) (await answerFirst(cwd));

    const r = await kriya(cwd, "lock", "part_recipe-1", "per_shot[S1].draw", "1.1", "--why", "the first one was better");
    expect(r.out).toContain("✓ Locked per_shot[S1].draw to 1.1");
    expect(r.out).toContain("↻ per_shot: item S1 changed");
    expect(r.out).toContain("↻ assemble: 'per_shot' changed");
  });

  it("rebuild redoes the stale work, and the run finishes again (Q-20)", async () => {
    const cwd = await project();
    await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    while (!(await kriya(cwd, "inbox")).out.startsWith("Nothing")) (await answerFirst(cwd));
    await kriya(cwd, "lock", "part_recipe-1", "per_shot[S1].draw", "1.2");

    const r = await kriya(cwd, "rebuild", "part_recipe-1");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^✓ Rebuilding from /);
    while (!(await kriya(cwd, "inbox")).out.startsWith("Nothing")) (await answerFirst(cwd));
    const status = (await kriya(cwd, "status", "part_recipe-1")).out;
    expect(status.split("\n")[0]).toBe("part_recipe-1 · part_recipe · completed");
    expect(status).not.toContain("↻");
    expect((await kriya(cwd, "rebuild", "part_recipe-1")).out).toContain("Nothing is stale; there's nothing to rebuild");
  });
});

describe("adopt from the terminal (Day 14)", () => {
  it("merges two panels into one with two parents, then you lock it", async () => {
    const cwd = await project();
    await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    await kriya(cwd, "decide", "1", "approve");

    const r = await kriya(cwd, "adopt", "part_recipe-1", "per_shot[S1].draw", "1.2", "1.3", "--note", "use its sky");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("✓ Adopted into per_shot[S1].draw: 2.1 (from 1.2, taking from 1.3). Nothing is locked yet");
    expect((await kriya(cwd, "inbox")).out).toMatch(/per_shot\[S1\]\.pick: Pick one panel\n\s+2\.1\s+fake:\/\/image\/per_shot\[S1\]\.edit/);
    expect((await kriya(cwd, "decide", "1", "lock")).code).toBe(0);
    expect((await kriya(cwd, "status", "part_recipe-1")).out).toContain("per_shot[S1].draw · locked 2.1");
  });

  it("needs a note saying what to take", async () => {
    const cwd = await project();
    await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    const r = await kriya(cwd, "adopt", "part_recipe-1", "per_shot[S1].draw", "1.2", "1.3");
    expect(r.code).toBe(1);
    expect(r.err).toBe('✗ say what to take from 1.3 with --note, e.g. --note "use its sky"');
  });
});

describe("agents from the terminal (Day 14a)", () => {
  it("an agent step calls a tool, answers, and waits for your approval like any step", async () => {
    const cwd = await project();
    writeFileSync(
      join(cwd, "recipes", "research.yaml"),
      `graph: research
level: part
inputs:
  topic: text
nodes:
  - id: analyst
    kind: agent
    goal: Write a short report on the topic
    tools: [search]
    uses: [inputs.topic]
    out: { report: text }
edges:
  - { from: analyst, to: END }
`,
    );
    const r = await kriya(cwd, "run", "research", "--input", "topic=water tankers");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("1 waiting on you");
    expect((await kriya(cwd, "inbox")).out).toContain("research-1 · analyst: Approve 'analyst'");
    expect((await kriya(cwd, "decide", "1", "approve")).code).toBe(0);
    expect((await kriya(cwd, "status", "research-1")).out.split("\n")[0]).toBe("research-1 · research · completed");
    // The tool's result is stored by hash, so a later process can read it back.
    expect(readdirSync(join(cwd, ".kriya", "blobs"), { recursive: true }).length).toBeGreaterThan(0);
  });
});

describe("an agent asks you a question from the terminal (Day 14b)", () => {
  it("the question waits in the inbox; kriya decide reply --note answers it, in a later process", async () => {
    const cwd = await project();
    writeFileSync(
      join(cwd, "recipes", "brief.yaml"),
      `graph: brief
level: part
nodes:
  - id: writer
    kind: agent
    goal: Write the episode brief
    tools: [ask_human]
    out: { brief: text }
edges:
  - { from: writer, to: END }
`,
    );
    expect((await kriya(cwd, "run", "brief")).out).toContain("1 waiting on you");
    const inbox = (await kriya(cwd, "inbox")).out;
    expect(inbox).toContain("brief-1 · writer: writer asks: Anything I should know before I start? (Write the episode brief)");
    expect(inbox).toContain("buttons: reply (--note)");

    const r = await kriya(cwd, "decide", "1", "reply", "--note", "Part 3 is set in Pune");
    expect(r.code, r.err).toBe(0);
    expect((await kriya(cwd, "inbox")).out).toContain("writer: Approve 'writer'");
    await kriya(cwd, "decide", "1", "approve");
    expect((await kriya(cwd, "status", "brief-1")).out.split("\n")[0]).toBe("brief-1 · brief · completed");
  });
});

describe("models: anthropic (Day 15)", () => {
  const recipe = `graph: brief
level: part
inputs:
  topic: text
nodes:
  - id: outline
    kind: model
    capability: llm.write
    prompt: "Outline an episode about {{inputs.topic}}"
    uses: [inputs.topic]
    trust: always
    out: { outline: text }
  - id: writer
    kind: agent
    goal: Write the episode brief from the outline
    tools: [search]
    uses: [outline.outline]
    trust: always
    out: { brief: text }
edges:
  - { from: outline, to: writer }
  - { from: writer, to: END }
`;

  async function claudeProject(): Promise<string> {
    const cwd = await project();
    writeFileSync(join(cwd, "recipes", "brief.yaml"), recipe);
    writeFileSync(join(cwd, "kriya.yaml"), readFileSync(join(cwd, "kriya.yaml"), "utf8").replace("models: fake", "models: anthropic"));
    return cwd;
  }

  /** A stand-in for the Anthropic API on localhost: an outline, then an agent that searches once and finishes. */
  async function standIn() {
    const bodies: { messages: unknown[]; tools?: unknown[] }[] = [];
    const reply = (content: unknown[], stop_reason: string) => ({
      id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_details: null,
      usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const server: Server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const body = JSON.parse(data) as { messages: unknown[]; tools?: unknown[] };
        bodies.push(body);
        const answer = !body.tools
          ? reply([{ type: "text", text: JSON.stringify({ outline: "1. Tanker arrives 2. Mitra acts" }) }], "end_turn")
          : body.messages.length === 1
            ? reply([{ type: "tool_use", id: "toolu_1", name: "search", input: { q: "tanker" } }], "tool_use")
            : reply([{ type: "tool_use", id: "toolu_2", name: "finish", input: { brief: "Mitra stops the tanker mafia." } }], "tool_use");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    return { bodies, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
  }

  it("without a key: the run stops before calling, status still works, and adding the key carries on", async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN, url: process.env.ANTHROPIC_BASE_URL };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const api = await standIn();
    try {
      const cwd = await claudeProject();
      const r = await kriya(cwd, "run", "brief", "--input", "topic=water tankers");
      expect(r.code).toBe(1);
      expect(r.err).toBe("✗ this step needs Claude, and there's no key. Put ANTHROPIC_API_KEY=… in .env at the project root (see .env.example), then run the command again");
      expect(api.bodies).toHaveLength(0);

      const st = await kriya(cwd, "status", "brief-1");
      expect(st.code).toBe(0);
      expect(st.err).toContain("! brief-1: this step needs Claude, and there's no key.");
      expect(st.out.split("\n")[0]).toBe("brief-1 · brief · running");

      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.ANTHROPIC_BASE_URL = api.url;
      const done = await kriya(cwd, "status", "brief-1"); // any command picks the run up again
      expect(done.out).toContain("⏳ waiting on the models…");
      expect(done.out).toContain("brief-1 · brief · completed");
      expect(api.bodies).toHaveLength(3);
    } finally {
      api.close();
      for (const [k, v] of [["ANTHROPIC_API_KEY", saved.key], ["ANTHROPIC_AUTH_TOKEN", saved.token], ["ANTHROPIC_BASE_URL", saved.url]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it("runs a text step and an agent through the real SDK, over HTTP, to a stand-in API", async () => {
    const api = await standIn();
    const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = api.url;
    try {
      const cwd = await claudeProject();
      const r = await kriya(cwd, "run", "brief", "--input", "topic=water tankers");
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain("⏳ waiting on the models…");
      expect(r.out).toContain("completed");
      expect(api.bodies).toHaveLength(3); // the outline, then two agent turns
      const status = (await kriya(cwd, "status", "brief-1")).out;
      expect(status).toContain("✓ outline · locked 1.1");
      expect(status).toContain("✓ writer · locked 1.1");
    } finally {
      api.close();
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saved.url;
    }
  });
});

describe("show: what a run made", () => {
  it("lists every step with its versions, then shows one step's full output", async () => {
    const cwd = await project();
    await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    const all = (await kriya(cwd, "show", "part_recipe-1")).out;
    expect(all.split("\n")[0]).toBe("part_recipe-1 · part_recipe · running · 1 waiting on you · spent $0.00");
    expect(all).toContain("✓ shot_list\n      versions: 1.1");
    expect(all).toContain("See one step in full: kriya show part_recipe-1 <step>");

    const one = (await kriya(cwd, "show", "part_recipe-1", "shot_list")).out;
    expect(one).toContain("Version 1.1 · not locked");
    expect(one).toContain("shots:\n  - id: S1");
    expect(one).toContain("hook: hook (fake) for shot_list");
  });

  it("an agent step shows its turns and tool calls", async () => {
    const cwd = await project();
    writeFileSync(join(cwd, "recipes", "brief.yaml"), "graph: brief\nlevel: part\nnodes:\n  - { id: writer, kind: agent, goal: Write the brief, tools: [search], trust: always, out: { brief: text } }\nedges:\n  - { from: writer, to: END }\n");
    await kriya(cwd, "run", "brief");
    const out = (await kriya(cwd, "show", "brief-1", "writer")).out;
    expect(out).toContain("Turns (2, $0.00):");
    expect(out).toContain('   1  search {"goal":"Write the brief"}');
    expect(out).toContain("   2  finish");
    expect(out).toContain("Version 1.1 · 🔒 locked");
  });

  it("says plainly what isn't there", async () => {
    const cwd = await project();
    await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    expect((await kriya(cwd, "show", "part_recipe-1", "shotlist")).err).toBe("✗ run 'part_recipe-1' has no step 'shotlist' (it has: shot_list, approve_shots)");
    expect((await kriya(cwd, "show", "part_recipe-1", "shot_list", "9.9")).err).toBe("✗ 'shot_list' has no version 9.9 (it has: 1.1)");
  });
});

describe("a run's recipes", () => {
  it("adding an unrelated recipe doesn't flag a run; editing one it uses does", async () => {
    const cwd = await project();
    await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    writeFileSync(join(cwd, "recipes", "other.yaml"), "graph: other\nlevel: part\nnodes:\n  - { id: t, kind: tool, tool: x }\n");
    expect((await kriya(cwd, "status")).out).not.toContain("recipes changed");

    const shot = join(cwd, "recipes", "shot.yaml");
    writeFileSync(shot, readFileSync(shot, "utf8").replace("Only these characters.", "Only these characters, please."));
    expect((await kriya(cwd, "status")).out).toContain("part_recipe-1            part_recipe      running · 1 waiting on you · recipes changed");
  });

  it("a new project ignores .env as well as .kriya/", async () => {
    const cwd = await project();
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(".kriya/\n.env\n");
  });
});

describe("models: { image: replicate } (Day 16)", () => {
  /** PNG bytes: enough for kriya to tell the type. */
  const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);

  /** A stand-in for Replicate on localhost: predictions succeed on the first poll (or fail, if `refused` names them); outputs are served from here too. */
  async function replicateStandIn(refused: string[] = []) {
    const creates: { input: { prompt: string; image_input?: string[]; aspect_ratio?: string } }[] = [];
    let n = 0;
    const server: Server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.method === "POST" && req.url!.endsWith("/predictions")) {
          creates.push(JSON.parse(data));
          return send(201, { id: `p${++n}`, status: "starting", version: "v123", output: null, error: null });
        }
        const get = /\/predictions\/(\w+)$/.exec(req.url!);
        if (get && refused.includes(get[1]!)) return send(200, { id: get[1], status: "failed", version: "v123", output: null, error: "The input or output was flagged as sensitive. (E005)" });
        if (get) return send(200, { id: get[1], status: "succeeded", version: "v123", output: `${base}/out/${get[1]}.png`, error: null });
        const out = /\/out\/(\w+)\.png$/.exec(req.url!);
        if (out) {
          res.writeHead(200);
          return res.end(png(`panel ${out[1]}`));
        }
        send(404, { detail: "not found" });
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    return { creates, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
  }

  it("a refused job fails the step; status says how to try again, and retry makes new predictions (Q-23)", async () => {
    const api = await replicateStandIn(["p2"]);
    const saved = { token: process.env.REPLICATE_API_TOKEN, url: process.env.REPLICATE_BASE_URL };
    process.env.REPLICATE_API_TOKEN = "r8_test";
    process.env.REPLICATE_BASE_URL = api.url;
    try {
      const cwd = await project();
      writeFileSync(join(cwd, "kriya.yaml"), readFileSync(join(cwd, "kriya.yaml"), "utf8").replace("models: fake", "models:\n  image: replicate"));
      entity(cwd, "bheem", "name: Bheem\nkind: character\nlook: a very tall bodybuilder\n");
      entity(cwd, "reservoir", "name: Reservoir\nkind: place\nlook: a concrete water tank\n");
      const item = JSON.stringify({ id: "P3-08", action: "Bheem leaps up screaming", characters: ["Bheem"], place: "Reservoir", lines: [], animate: false });
      await kriya(cwd, "run", "shot_recipe", "--input", `item=${item}`);

      const failed = (await kriya(cwd, "status", "shot_recipe-1")).out;
      expect(failed).toContain("✗ draw · Replicate couldn't make the image: The input or output was flagged as sensitive. (E005)");
      expect(failed).toContain("Try again: kriya retry shot_recipe-1 'draw'");

      const r = await kriya(cwd, "retry", "shot_recipe-1", "draw");
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain("✓ Retrying draw");
      expect(r.out).toContain("1 waiting on you");
      expect(api.creates).toHaveLength(6); // three refused-or-kept, then three new: a new attempt is a new job
      expect((await kriya(cwd, "show", "shot_recipe-1", "draw")).out).toMatch(/Version 2\.3/);
      expect((await kriya(cwd, "retry", "shot_recipe-1", "draw")).err).toBe("✗ 'draw' hasn't failed (it's completed), so there's nothing to retry");
    } finally {
      api.close();
      for (const [k, v] of [["REPLICATE_API_TOKEN", saved.token], ["REPLICATE_BASE_URL", saved.url]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it("draws three real candidates for one shot, with the character sheets as references; show makes them viewable", async () => {
    const api = await replicateStandIn();
    const saved = { token: process.env.REPLICATE_API_TOKEN, url: process.env.REPLICATE_BASE_URL };
    process.env.REPLICATE_API_TOKEN = "r8_test";
    process.env.REPLICATE_BASE_URL = api.url;
    try {
      const cwd = await project();
      mkdirSync(join(cwd, "sheets"));
      writeFileSync(join(cwd, "sheets", "bheem.png"), png("bheem"));
      writeFileSync(join(cwd, "sheets", "reservoir.png"), png("reservoir"));
      writeFileSync(join(cwd, "kriya.yaml"), readFileSync(join(cwd, "kriya.yaml"), "utf8").replace("models: fake", "models:\n  image: replicate"));
      entity(cwd, "bheem", "name: Bheem\nkind: character\nlook: { image: sheets/bheem.png, words: a very tall bodybuilder with a red-and-white checked gamcha }\n");
      entity(cwd, "reservoir", "name: Reservoir\nkind: place\nlook: a concrete water tank on stilts above red mud\n");
      const item = JSON.stringify({ id: "P3-08", action: "Bheem leaps up screaming", characters: ["Bheem"], place: "Reservoir", lines: [], animate: false });

      const r = await kriya(cwd, "run", "shot_recipe", "--input", `item=${item}`);
      expect(r.code, r.err).toBe(0);
      expect(api.creates).toHaveLength(3);
      expect(api.creates[0]!.input.image_input).toHaveLength(1); // Bheem's sheet; the reservoir is words only
      expect(api.creates[0]!.input.prompt).toContain("Characters: Bheem, a very tall bodybuilder with a red-and-white checked gamcha (image 1)");
      expect(api.creates[0]!.input.prompt).toContain("Place: Reservoir, a concrete water tank on stilts above red mud");

      const shown = (await kriya(cwd, "show", "shot_recipe-1", "draw")).out;
      expect(shown).toMatch(/Version 1\.3 · not locked · google\/nano-banana-2:v123 · \$0\.07/);
      expect(shown).toContain("Prompt:\n  Anime-influenced".slice(0, 9)); // the prompt, indented
      expect(shown).toMatch(/References:\n {2}1\. Bheem's look · sha256:[0-9a-f]{12}/);
      const view = /Open the files:\n {2}(\S+)/.exec(shown)![1]!;
      expect(view).toMatch(/^\.kriya\/view\/[0-9a-f]{12}\.png$/);
      expect(readFileSync(join(cwd, view)).subarray(8).toString()).toBe("panel p3");
      expect(readdirSync(join(cwd, ".kriya", "jobs"))).toHaveLength(1); // the ledger: one step, three predictions

      // Lock a panel, then redraw Bheem's sheet in place: the shot that used it goes stale.
      expect((await kriya(cwd, "decide", "1", "lock", "--pick", "1.2")).code).toBe(0);
      expect((await kriya(cwd, "status", "shot_recipe-1")).out.split("\n")[0]).toBe("shot_recipe-1 · shot_recipe · completed");
      writeFileSync(join(cwd, "sheets", "bheem.png"), png("bheem, round 3"));
      const after = (await kriya(cwd, "status", "shot_recipe-1")).out;
      expect(after).toContain("↻ draw · stale: Bheem's look changed · locked 1.2");
    } finally {
      api.close();
      for (const [k, v] of [["REPLICATE_API_TOKEN", saved.token], ["REPLICATE_BASE_URL", saved.url]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

describe("the Library (Day 18)", () => {
  const MITRA = "name: Mitra\nkind: character\nlook: { image: sheets/mitra.png, words: a thin 60-year-old bald man }\nvoice: { voice: Charon, words: calm and dry }\nspeech: Hinglish\n";
  const line = JSON.stringify({ id: "L06", speaker: "Mitra", hinglish: "Ek cutting chai, extra cheeni, aur ek confession.", emotion: "dry, satisfied", caption_en: "One confession." });
  const shot = JSON.stringify({ id: "P3-04", characters: ["Mitra"], place: "Chai stall", action: "Mitra writes in his notebook", lines: [], animate: false });
  /** What one step of a run received from the Library, `Entity.facet` → version, read from its event log. */
  const received = (cwd: string, run: string, step: string) => {
    const store = openStore(join(cwd, ".kriya"));
    try {
      return Object.values(Recorder.resume(store.events, run).state.nodes[step]!.versions)[0]!.assets;
    } finally {
      store.close();
    }
  };

  async function cast() {
    const cwd = await project();
    mkdirSync(join(cwd, "sheets"));
    writeFileSync(join(cwd, "sheets", "mitra.png"), "mitra, round 1");
    entity(cwd, "mitra", MITRA);
    entity(cwd, "tiwari", "name: Tiwari\nkind: character\nlook: { image: sheets/tiwari.png }\n");
    entity(cwd, "stall", "name: Chai stall\nkind: place\nlook: a small wooden chai stall\n");
    return cwd;
  }

  it("@Mitra resolves to his look for a panel and his voice and speech for a line", async () => {
    const cwd = await cast();
    expect((await kriya(cwd, "run", "voice_recipe", "--input", `item=${line}`, "--id", "line")).code).toBe(0);
    expect((await kriya(cwd, "run", "shot_recipe", "--input", `item=${shot}`, "--id", "shot")).code).toBe(0);
    const voice = received(cwd, "line", "speak");
    expect(Object.keys(voice!).sort()).toEqual(["Mitra.speech", "Mitra.voice"]);
    expect(Object.keys(received(cwd, "shot", "draw")!).sort()).toEqual(["Chai stall.look", "Mitra.look"]);

    // Approve both, then give Mitra a new voice: the line he spoke goes stale; the panel doesn't.
    expect((await kriya(cwd, "decide", "line:listen", "approve")).code).toBe(0);
    expect((await kriya(cwd, "decide", "shot:pick", "lock", "--pick", "1.1")).code).toBe(0);
    entity(cwd, "mitra", MITRA.replace("Charon", "Puck"));
    expect((await kriya(cwd, "status", "line")).out).toContain("Mitra's voice changed");
    expect((await kriya(cwd, "status", "shot")).out).not.toContain("stale");
    expect((await kriya(cwd, "status")).out).toContain("voice_recipe     completed · 1 stale"); // finished runs say so too
    expect(received(cwd, "line", "speak")!["Mitra.voice"]).toBe(voice!["Mitra.voice"]); // the old take keeps the version it used
  });

  it("kriya library lists everyone by kind, with versions, what's missing, and files that aren't there", async () => {
    const cwd = await cast();
    const r = await kriya(cwd, "library");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(
      ["character", "  Mitra       look v1 · voice v1 · speech v1 · needs: rules", "  Tiwari      look ✗ (sheets/tiwari.png isn't there) · needs: voice, speech, rules", "place", "  Chai stall  look v1"].join("\n"),
    );
  });

  it("every version is kept: redrawing a sheet in place makes v2 and the old file stays in .kriya", async () => {
    const cwd = await cast();
    await kriya(cwd, "library");
    writeFileSync(join(cwd, "sheets", "mitra.png"), "mitra, round 2");
    entity(cwd, "mitra", MITRA.replace("Charon", "Puck"));
    const r = (await kriya(cwd, "library", "Mitra")).out;
    expect(r).toMatch(/^Mitra · character · library\/mitra\.yaml\n\n {2}look v2\n {4}v2 · \d{4}-\d\d-\d\d · current · image: sheets\/mitra\.png · words: a thin 60-year-old bald man\n {4}v1 · /);
    expect(r).toContain("  voice v2\n    v2 · ");
    expect(r).toMatch(/v1 · [\d-]+ · voice: Charon · words: calm and dry/);
    const store = openStore(join(cwd, ".kriya"));
    try {
      const sha = (t: string) => createHash("sha256").update(t).digest("hex");
      expect(store.blobs.get(sha("mitra, round 1"))?.toString()).toBe("mitra, round 1");
    } finally {
      store.close();
    }
  });

  it("mistakes in the Library are plain, with the nearest name", async () => {
    const cwd = await project();
    entity(cwd, "a", "name: Mitra\nkind: charcter\n");
    entity(cwd, "b", "name: Bheem\nkind: character\nlok: a very tall bodybuilder\n");
    entity(cwd, "c", "name: Mitra\n");
    entity(cwd, "d", "kind: place\n");
    const r = await kriya(cwd, "run", "voice_recipe", "--input", `item=${line}`);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      [
        "✗ your Library has problems:",
        "  library/a.yaml: there's no kind 'charcter'. Did you mean 'character'? Kinds: character, place, music (kinds: in kriya.yaml)",
        "  library/b.yaml: a character has no 'lok'. Did you mean 'look'? A character has: look, voice, speech, rules",
        "  library/c.yaml: 'Mitra' is already in library/a.yaml; each entity has one file",
        "  library/d.yaml: needs a name, e.g. name: Mitra (the name recipes use, like item.speaker)",
      ].join("\n"),
    );
  });

  it("a project with the old library: in kriya.yaml is told where it went", async () => {
    const cwd = await project();
    writeFileSync(join(cwd, "kriya.yaml"), `${readFileSync(join(cwd, "kriya.yaml"), "utf8")}library:\n  Mitra.look: x\n`);
    expect((await kriya(cwd, "status")).err).toContain("✗ kriya.yaml: the Library moved to the library/ folder, one file per entity");
  });
});

describe("plain errors", () => {
  it("outside a project", async () => {
    const r = await kriya(mkdtempSync(join(tmpdir(), "kriya-none-")), "status");
    expect(r.code).toBe(1);
    expect(r.err).toBe("✗ there's no kriya.yaml here or in any folder above. Start a project with: kriya init <folder>");
  });

  it("an unknown recipe lists the real ones", async () => {
    expect((await kriya((await project()), "run", "nope")).err).toBe("✗ there's no recipe 'nope' (you have: part_recipe, shot_recipe, voice_recipe)");
  });

  it("missing and unknown inputs", async () => {
    const cwd = await project();
    expect((await kriya(cwd, "run", "part_recipe")).err).toBe("✗ 'part_recipe' needs --input story_pages=… --input part_no=…");
    expect((await kriya(cwd, "run", "part_recipe", "--input", "part=3")).err).toMatch(/has no input 'part' \(it takes: story_pages, part_no\)/);
    expect((await kriya(cwd, "run", "part_recipe", "--input", "part_no=three", "--input", "story_pages=x")).err).toBe("✗ input 'part_no' is a number, got 'three'");
  });

  it("a button that doesn't exist, and a button missing what it needs", async () => {
    const cwd = await project();
    await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    expect((await kriya(cwd, "decide", "1", "yes")).err).toBe("✗ step 'approve_shots' has no button 'yes' (it has: approve, redo)");
    expect((await kriya(cwd, "decide", "1", "redo")).err).toBe("✗ the 'redo' button needs a note");
  });

  it("broken recipes are reported in plain words before anything runs", async () => {
    const cwd = await project();
    const file = join(cwd, "recipes", "voice.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("capability: audio.speech\n    prompt", "capabilty: audio.speech\n    prompt"));
    const r = await kriya(cwd, "status");
    expect(r.code).toBe(1);
    expect(r.err).toContain("'capabilty' isn't a setting for a model step. Did you mean 'capability'?");
  });

  it("an unknown example lists the ones that exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kriya-cli-"));
    expect((await kriya(dir, "init", "p3", "--example", "mohalla-example")).err).toBe("✗ there's no example called 'mohalla-example'. Examples: mohalla-mitra");
    expect((await kriya(dir, "init", "--examples")).out).toBe("Examples: mohalla-mitra");
  });

  it("init refuses to overwrite a project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kriya-cli-"));
    await kriya(dir, "init", "p3");
    expect((await kriya(dir, "init", "p3")).err).toBe("✗ 'p3' already has a kriya.yaml");
  });
});

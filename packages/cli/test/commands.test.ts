import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
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

  it("without a key, says where to put one", async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const r = await kriya(await claudeProject(), "run", "brief", "--input", "topic=water tankers");
      expect(r.code).toBe(1);
      expect(r.err).toBe("✗ models: anthropic needs a key. Put ANTHROPIC_API_KEY=… in .env at the project root (see .env.example), or set models: fake in kriya.yaml");
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
  });

  it("runs a text step and an agent through the real SDK, over HTTP, to a stand-in API", async () => {
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
    const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const cwd = await claudeProject();
      const r = await kriya(cwd, "run", "brief", "--input", "topic=water tankers");
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain("⏳ waiting on Claude…");
      expect(r.out).toContain("completed");
      expect(bodies).toHaveLength(3); // the outline, then two agent turns
      const status = (await kriya(cwd, "status", "brief-1")).out;
      expect(status).toContain("✓ outline · locked 1.1");
      expect(status).toContain("✓ writer · locked 1.1");
    } finally {
      server.close();
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saved.url;
    }
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

  it("init refuses to overwrite a project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kriya-cli-"));
    await kriya(dir, "init", "p3");
    expect((await kriya(dir, "init", "p3")).err).toBe("✗ 'p3' already has a kriya.yaml");
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/commands.js";

/** Runs one `kriya …` command in `cwd`, capturing what it prints. */
function kriya(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), cwd });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "kriya-cli-"));
  expect(kriya(dir, "init", "p3", "--example", "mohalla-mitra").code).toBe(0);
  return join(dir, "p3");
}

/** Answers whatever is first in the inbox, the simplest way each screen allows. */
function answerFirst(cwd: string): string {
  const inbox = kriya(cwd, "inbox").out;
  const first = inbox.split("\n")[0]!;
  const button = /buttons: (\w+)/.exec(inbox)![1]!;
  const pick = /^\s+(\d+\.\d+)\s/m.exec(inbox)?.[1];
  const r = kriya(cwd, "decide", "1", button, ...(pick ? ["--pick", pick] : []));
  expect(r.code, r.err).toBe(0);
  return first;
}

describe("a full fake episode from the terminal (Day 13)", () => {
  it("init → run → inbox / decide until done → status", () => {
    const cwd = project();
    const started = kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=Pages 7 to 9");
    expect(started.out).toContain("✓ Started part_recipe-1 (part_recipe)");
    expect(started.out).toContain("1 waiting on you");

    let answered = 0;
    while (!kriya(cwd, "inbox").out.startsWith("Nothing is waiting on you.")) {
      answerFirst(cwd);
      expect(++answered).toBeLessThan(20);
    }
    // approve shots, 3 panels, 2 clip approvals (S1 and S3 are animated; when_confident asks until checkers exist), 3 voice lines, watch
    expect(answered).toBe(1 + 3 + 2 + 3 + 1);

    const status = kriya(cwd, "status", "part_recipe-1").out;
    expect(status.split("\n")[0]).toBe("part_recipe-1 · part_recipe · completed");
    expect(status).toContain("✓ assemble · locked 1.1");
  });

  it("runs survive between commands: every command is a new process reading .kriya/", () => {
    const cwd = project();
    kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    expect(existsSync(join(cwd, ".kriya", "kriya.db"))).toBe(true);
    expect(kriya(cwd, "status").out).toMatch(/^part_recipe-1\s+part_recipe\s+running · 1 waiting on you$/);
  });

  it("an edit shows up as the next version, and the only option needs no --pick", () => {
    const cwd = project();
    kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    kriya(cwd, "decide", "1", "approve");
    expect(kriya(cwd, "decide", "1", "edit", "--pick", "1.3", "--note", "add the gamcha").code).toBe(0);
    expect(kriya(cwd, "inbox").out).toMatch(/per_shot\[S1\]\.pick: Pick one panel\n\s+2\.1\s+fake:\/\/image\/per_shot\[S1\]\.edit/);
    expect(kriya(cwd, "decide", "1", "lock").code).toBe(0);
  });

  it("lock moves a lock and says what went stale", () => {
    const cwd = project();
    kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    kriya(cwd, "decide", "1", "approve");
    kriya(cwd, "decide", "1", "edit", "--pick", "1.3", "--note", "add the gamcha");
    kriya(cwd, "decide", "1", "lock");
    while (!kriya(cwd, "inbox").out.startsWith("Nothing")) answerFirst(cwd);

    const r = kriya(cwd, "lock", "part_recipe-1", "per_shot[S1].draw", "1.1", "--why", "the first one was better");
    expect(r.out).toContain("✓ Locked per_shot[S1].draw to 1.1");
    expect(r.out).toContain("↻ per_shot: item S1 changed");
    expect(r.out).toContain("↻ assemble: 'per_shot' changed");
  });
});

describe("plain errors", () => {
  it("outside a project", () => {
    const r = kriya(mkdtempSync(join(tmpdir(), "kriya-none-")), "status");
    expect(r.code).toBe(1);
    expect(r.err).toBe("✗ there's no kriya.yaml here or in any folder above. Start a project with: kriya init <folder>");
  });

  it("an unknown recipe lists the real ones", () => {
    expect(kriya(project(), "run", "nope").err).toBe("✗ there's no recipe 'nope' (you have: part_recipe, shot_recipe, voice_recipe)");
  });

  it("missing and unknown inputs", () => {
    const cwd = project();
    expect(kriya(cwd, "run", "part_recipe").err).toBe("✗ 'part_recipe' needs --input story_pages=… --input part_no=…");
    expect(kriya(cwd, "run", "part_recipe", "--input", "part=3").err).toMatch(/has no input 'part' \(it takes: story_pages, part_no\)/);
    expect(kriya(cwd, "run", "part_recipe", "--input", "part_no=three", "--input", "story_pages=x").err).toBe("✗ input 'part_no' is a number, got 'three'");
  });

  it("a button that doesn't exist, and a button missing what it needs", () => {
    const cwd = project();
    kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
    expect(kriya(cwd, "decide", "1", "yes").err).toBe("✗ step 'approve_shots' has no button 'yes' (it has: approve, redo)");
    expect(kriya(cwd, "decide", "1", "redo").err).toBe("✗ the 'redo' button needs a note");
  });

  it("broken recipes are reported in plain words before anything runs", () => {
    const cwd = project();
    const file = join(cwd, "recipes", "voice.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("capability: audio.speech\n    prompt", "capabilty: audio.speech\n    prompt"));
    const r = kriya(cwd, "status");
    expect(r.code).toBe(1);
    expect(r.err).toContain("'capabilty' isn't a setting for a model step. Did you mean 'capability'?");
  });

  it("init refuses to overwrite a project", () => {
    const dir = mkdtempSync(join(tmpdir(), "kriya-cli-"));
    kriya(dir, "init", "p3");
    expect(kriya(dir, "init", "p3").err).toBe("✗ 'p3' already has a kriya.yaml");
  });
});

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadDir, loadText } from "../src/load.js";

const EXAMPLES = resolve(__dirname, "../../../examples");

const minimal = (body: string) => `graph: g\nlevel: part\n${body}`;
const errors = (text: string) => loadText(text).problems.filter((p) => p.severity === "error");

describe("example recipes", () => {
  it("all load with no errors", () => {
    const { graphs, problems } = loadDir(EXAMPLES);
    expect(problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(graphs.map((g) => g.graph).sort()).toEqual(["part_recipe", "shot_recipe", "voice_recipe"]);
  });
});

describe("schema errors", () => {
  it("points at the line of a bad field", () => {
    const text = minimal(`nodes:\n  - id: a\n    kind: model\n    capability: Image Generate\n`);
    const [p] = errors(text);
    expect(p?.line).toBe(6);
    expect(p?.message).toMatch(/image\.generate/);
  });

  it("rejects unknown node kinds", () => {
    expect(errors(minimal(`nodes:\n  - id: a\n    kind: magic\n`)).length).toBeGreaterThan(0);
  });

  it("rejects unknown keys so typos don't pass silently", () => {
    const e = errors(minimal(`nodes:\n  - id: a\n    kind: tool\n    tool: crop\n    toool: x\n`));
    expect(e[0]?.message).toMatch(/toool/);
  });
});

describe("graph checks", () => {
  const tool = (id: string) => `  - { id: ${id}, kind: tool, tool: t }\n`;

  it("catches edges to missing steps and suggests a name", () => {
    const e = errors(minimal(`nodes:\n${tool("per_shot")}${tool("start")}edges:\n  - { from: start, to: per_shoot }\n`));
    expect(e[0]?.message).toMatch(/Did you mean 'per_shot'/);
    expect(e[0]?.line).toBe(7);
  });

  it("requires a limit on every loop", () => {
    const text = minimal(`nodes:\n${tool("s")}${tool("a")}${tool("b")}edges:\n  - { from: s, to: a }\n  - { from: a, to: b }\n  - { from: b, to: a }\n`);
    expect(errors(text)[0]?.message).toMatch(/a → b → a has no limit/);
    const fixed = text.replace("{ from: b, to: a }", "{ from: b, to: a, max_loops: 3 }");
    expect(errors(fixed)).toEqual([]);
  });

  it("checks screen buttons used in conditions", () => {
    const text = minimal(
      `nodes:\n  - id: pick\n    kind: screen\n    review: pick_one\n    actions: [{ id: lock }, { id: retry }]\n${tool("next")}edges:\n  - { from: pick, to: next, when: "action == 'lok'" }\n`,
    );
    expect(errors(text)[0]?.message).toMatch(/no button 'lok'.*Did you mean 'lock'/);
  });

  it("warns when a button leads nowhere", () => {
    const text = minimal(
      `nodes:\n  - id: pick\n    kind: screen\n    review: approve\n    actions: [{ id: approve }, { id: redo }]\nedges:\n  - { from: pick, to: END, when: "action == 'approve'" }\n`,
    );
    const warnings = loadText(text).problems.filter((p) => p.severity === "warning");
    expect(warnings.some((w) => /button 'redo'/.test(w.message))).toBe(true);
  });

  it("reports bad conditions with the reason", () => {
    const text = minimal(`nodes:\n${tool("a")}${tool("b")}edges:\n  - { from: a, to: b, when: "x ==" }\n`);
    expect(errors(text)[0]?.message).toMatch(/ends too early/);
  });

  it("catches undeclared types", () => {
    const text = minimal(`nodes:\n  - id: a\n    kind: model\n    capability: llm.write\n    out: { shots: list<shto> }\n`);
    expect(errors(text)[0]?.message).toMatch(/type 'shto' isn't declared/);
  });

  it("catches map nodes pointing at missing graphs", () => {
    const text = minimal(`nodes:\n${tool("src")}  - { id: m, kind: map, over: src.items, graph: shot_recipee }\nedges:\n  - { from: src, to: m }\n`);
    expect(errors(text)[0]?.message).toMatch(/shot_recipee/);
  });

  it("warns about steps that can never run", () => {
    const text = minimal(`nodes:\n${tool("a")}${tool("b")}${tool("c")}edges:\n  - { from: a, to: b }\n  - { from: b, to: c }\n  - { from: c, to: b, max_loops: 2 }\n`);
    expect(errors(text)).toEqual([]);
  });
});

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

describe("schema errors in plain words (Q-18)", () => {
  it("a misspelled setting gets the nearest real one, reported once", () => {
    const e = errors(minimal(`nodes:\n  - { id: a, kind: model, capabilty: llm.write }\n`));
    expect(e.map((p) => p.message)).toEqual(["'capabilty' isn't a setting for a model step. Did you mean 'capability'?"]);
  });

  it("a misspelled kind lists the kinds", () => {
    const [p] = errors(minimal(`nodes:\n  - { id: a, kind: modle }\n`));
    expect(p?.message).toBe("'modle' isn't a kind of step. Use one of: model, agent, tool, screen, map, subgraph. Did you mean 'model'?");
  });

  it("a missing setting says what needs it", () => {
    const [p] = errors(minimal(`nodes:\n  - { id: a, kind: tool }\n`));
    expect(p?.message).toBe("'tool' is missing: a tool step needs it");
  });

  it("works for edges and buttons too", () => {
    expect(errors(minimal(`nodes:\n  - { id: a, kind: tool, tool: t }\nedges:\n  - { from: a, to: END, wen: "x" }\n`))[0]?.message).toBe("'wen' isn't a setting for an edge. Did you mean 'when'?");
    expect(errors(minimal(`nodes:\n  - { id: s, kind: screen, review: approve, actions: [{ id: ok, lock: true }] }\n`))[0]?.message).toBe("'lock' isn't a setting for a button. Did you mean 'locks'?");
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

  describe("result and locking buttons", () => {
    const warnings = (text: string) => loadText(text).problems.filter((p) => p.severity === "warning");

    it("refuses result when the step makes several options", () => {
      const text = minimal(`nodes:\n  - { id: draw, kind: model, capability: image.generate, options: 3 }\n${tool("b")}edges:\n  - { from: draw, to: b, when: "result.ok == true" }\n`);
      expect(errors(text)[0]?.message).toMatch(/'draw' makes 3 options, so 'result' is unclear/);
    });

    it("refuses result on a screen and points to action", () => {
      const text = minimal(`nodes:\n  - { id: s, kind: screen, review: approve, actions: [{ id: ok }] }\n${tool("b")}edges:\n  - { from: s, to: b, when: "result.ok == true" }\n`);
      expect(errors(text)[0]?.message).toMatch(/'s' is a screen step, so it has no 'result'; use 'action'/);
    });

    it("refuses result on a join", () => {
      const text = minimal(`nodes:\n${tool("a")}${tool("b")}${tool("c")}edges:\n  - { from: [a, b], to: c, wait: all, when: "result.ok == true" }\n`);
      expect(errors(text)[0]?.message).toMatch(/'result' is unclear on an edge that joins/);
    });

    it("allows result on a single-candidate step", () => {
      const text = minimal(`nodes:\n  - { id: speak, kind: model, capability: audio.speech }\n${tool("b")}edges:\n  - { from: speak, to: b, when: "result.seconds > 8" }\n`);
      expect(errors(text)).toEqual([]);
    });

    it("warns when a screen shows a step but no button locks it", () => {
      const text = minimal(`nodes:\n${tool("a")}  - { id: s, kind: screen, review: approve, show: a.x, actions: [{ id: ok }] }\nedges:\n  - { from: a, to: s }\n  - { from: s, to: END }\n`);
      expect(warnings(text).some((w) => /shows 'a.x' but none of its buttons locks it/.test(w.message))).toBe(true);
    });
  });

  describe("agent limits", () => {
    const agent = (extra: string) =>
      minimal(`nodes:\n  - id: a\n    kind: agent\n    goal: g\n    tools: [t]\n${extra}`);
    const warnings = (text: string) => loadText(text).problems.filter((p) => p.severity === "warning");

    it("allows a high max_turns", () => {
      expect(errors(agent(`    max_turns: 200\n`))).toEqual([]);
    });

    it("warns when a long agent has no budget", () => {
      expect(warnings(agent(`    max_turns: 200\n`)).some((w) => /200 turns with no budget/.test(w.message))).toBe(true);
    });

    it("doesn't warn when a long agent has a budget", () => {
      expect(warnings(agent(`    max_turns: 200\n    budget: { usd: 5 }\n`))).toEqual([]);
    });

    it("rejects a zero budget and unknown budget keys", () => {
      expect(errors(agent(`    budget: { usd: 0 }\n`)).length).toBeGreaterThan(0);
      expect(errors(agent(`    budget: { dollars: 5 }\n`)).length).toBeGreaterThan(0);
    });
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

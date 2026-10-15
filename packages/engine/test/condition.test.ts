import { describe, expect, it } from "vitest";
import { ConditionError, evaluate, literalsComparedTo, parseCondition, pathsIn } from "../src/condition.js";

const run = (src: string, scope: Record<string, unknown>) => evaluate(parseCondition(src), scope);

describe("conditions", () => {
  it("compares paths with literals", () => {
    expect(run("action == 'redo'", { action: "redo" })).toBe(true);
    expect(run("action != 'redo'", { action: "redo" })).toBe(false);
    expect(run("speak.seconds > 8", { speak: { seconds: 9.5 } })).toBe(true);
  });

  it("handles and / or / not with precedence", () => {
    const s = { action: "lock", item: { animate: false } };
    expect(run("action == 'lock' and item.animate == true", s)).toBe(false);
    expect(run("action == 'lock' and not item.animate", s)).toBe(true);
    expect(run("action == 'x' or action == 'lock' and item.animate == false", s)).toBe(true);
    expect(run("(action == 'x' or action == 'lock') and item.animate", s)).toBe(false);
  });

  it("treats missing paths as undefined, never throwing", () => {
    expect(run("item.missing.deep == true", {})).toBe(false);
  });

  it("reports readable parse errors", () => {
    expect(() => parseCondition("action == 'redo")).toThrow(ConditionError);
    expect(() => parseCondition("action ==")).toThrow(/ends too early/);
    expect(() => parseCondition("a == 1 b")).toThrow(/unexpected 'b'/);
    expect(() => parseCondition("")).toThrow(/empty/);
  });

  it("lists the paths and action literals it reads", () => {
    const e = parseCondition("action == 'lock' and item.animate == true");
    expect(pathsIn(e)).toEqual([["action"], ["item", "animate"]]);
    expect(literalsComparedTo(e, "action")).toEqual(["lock"]);
  });

  it("cannot call functions", () => {
    expect(() => parseCondition("process.exit(1)")).toThrow(ConditionError);
  });
});

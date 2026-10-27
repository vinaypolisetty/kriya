import { describe, expect, it } from "vitest";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadText, readRun, Recorder, replay, Scheduler, type Executors, type Judged, type Shown } from "@kriya/engine";
import { suggestFix } from "../src/index.js";

const PICK = { actions: [{ id: "lock", needs: ["selection" as const], locks: true }, { id: "edit", needs: ["selection" as const, "note" as const], locks: false }, { id: "crop", needs: ["selection" as const, "region" as const], locks: false }, { id: "retry", needs: ["note" as const], locks: false }] };
const shown = (version: string, issues: NonNullable<Shown["verdict"]>["issues"]): Shown => ({ version, value: `img${version}`, verdict: { pass: issues.length === 0, issues } });

describe("the fix policy: what to press, from the checks (Day 21)", () => {
  it("a candidate that passed is locked", () => {
    expect(suggestFix(PICK, [shown("1.1", [{ type: "missing_character", what: "Bheem is missing" }]), shown("1.2", [])])).toMatchObject({ action: "lock", selection: ["1.2"] });
  });

  it("an extra person at the edge, with an area to keep: crop it, free", () => {
    const s = suggestFix(PICK, [
      shown("1.1", [{ type: "missing_character", what: "Bheem is missing", fix: "retry" }]),
      shown("1.2", [{ type: "extra_character", what: "a man in a red shirt", where: "right edge", fix: "crop", keep: "0,0,0.8,1" }]),
    ]);
    expect(s).toMatchObject({ action: "crop", selection: ["1.2"], region: "0,0,0.8,1" });
  });

  it("a duplicate in the middle: edit it, in the words the failure table says work", () => {
    const s = suggestFix(PICK, [shown("1.1", [{ type: "duplicate_character", what: "a second Tinku behind the stove", where: "center", fix: "edit" }])]);
    expect(s).toMatchObject({ action: "edit", selection: ["1.1"], note: "Exactly one of each character, do not add copies: remove a second Tinku behind the stove. Keep everything else exactly the same." });
  });

  it("the cheapest repair wins across candidates: an edit beats a retry", () => {
    const s = suggestFix(PICK, [
      shown("1.1", [{ type: "missing_character", what: "Mitra is missing" }]),
      shown("1.2", [{ type: "readable_text", what: "a sign says RAJA.", where: "top left", fix: "edit" }]),
    ]);
    expect(s).toMatchObject({ action: "edit", selection: ["1.2"], note: "Remove all writing: a sign says RAJA. No text, no signs with writing. Keep everything else exactly the same." });
  });

  it("nothing close: retry, with every issue as the note", () => {
    const s = suggestFix(PICK, [shown("1.1", [{ type: "missing_character", what: "Bheem is missing" }]), shown("1.2", [{ type: "missing_character", what: "Mitra is missing" }])]);
    expect(s).toMatchObject({ action: "retry", note: "Fix: Bheem is missing; Mitra is missing" });
    expect(s!.selection).toBeUndefined();
  });

  it("an issue the knowledge base doesn't know takes the judge's fix; a crop with no area to keep becomes an edit", () => {
    expect(suggestFix(PICK, [shown("1.1", [{ type: "odd_shadow", what: "a shadow points the wrong way", fix: "edit" }])])).toMatchObject({ action: "edit", note: "Fix: a shadow points the wrong way. Keep everything else exactly the same." });
    expect(suggestFix(PICK, [shown("1.1", [{ type: "stray_object", what: "a bucket at the edge", where: "left edge", fix: "crop" }])])).toMatchObject({ action: "edit" });
  });

  it("no checks, or no button for the fix: no suggestion", () => {
    expect(suggestFix(PICK, [{ version: "1.1", value: "x" }])).toBeUndefined();
    expect(suggestFix({ actions: [PICK.actions[0]!] }, [shown("1.1", [{ type: "missing_character", what: "Bheem is missing" }])])).toBeUndefined();
  });
});

describe("a screen that follows its checks: judged, fixed, judged again, locked", () => {
  it("the bad panel is edited with the rule's words, the edit passes, and the screen locks it, all on the record", () => {
    const g = loadText(`graph: shot
level: shot
nodes:
  - id: draw
    kind: model
    capability: image.generate
    options: 2
    check: { rubric: ["Exactly one of each character."] }
    out: { image: image }
  - id: pick
    kind: screen
    review: pick_one
    show: draw.image
    trust: when_confident
    actions:
      - { id: lock, needs: [selection], locks: true }
      - { id: edit, needs: [selection, note] }
      - { id: retry, needs: [note] }
  - id: edit
    kind: model
    capability: image.edit
    refines: draw
    prompt: "{{pick.note}}"
    uses: [pick.note]
    check: { rubric: ["Exactly one of each character."] }
    out: { image: image }
edges:
  - { from: draw, to: pick }
  - { from: pick, to: edit, when: "action == 'edit'" }
  - { from: pick, to: draw, when: "action == 'retry'", max_loops: 2 }
  - { from: edit, to: pick, max_loops: 3 }
  - { from: pick, to: END, when: "action == 'lock'" }
`);
    expect(g.problems).toEqual([]);
    const graph = g.graphs[0]!;
    const notes: string[] = [];
    const exec: Executors = {
      produce: (node, ctx) => (node.id === "edit" ? (notes.push(ctx.instruction ?? ""), [{ image: "fixed" }]) : [{ image: "a" }, { image: "b" }]),
      check: (_n, _c, cands): Judged[] =>
        cands.map((c) => (c.output.image === "fixed" ? { version: c.version, pass: true, issues: [] } : { version: c.version, pass: false, issues: [c.version === "1.2" ? { type: "duplicate_character", what: "a second Tinku", fix: "edit" } : { type: "missing_character", what: "Bheem is missing", fix: "retry" }] })),
      decide: (node, ctx) => {
        const s = suggestFix(node, ctx.shows ?? []);
        if (!s) return undefined;
        const { why: _w, ...d } = s;
        return { ...d, by: "auto" };
      },
    };
    const log = new SqliteEventLog(openDatabase(":memory:"));
    const rec = Recorder.start(log, "run1");
    const s = new Scheduler(graph, rec, exec, [graph]);
    s.start("a".repeat(64), {});
    s.run();
    expect(notes).toEqual(["Exactly one of each character, do not add copies: remove a second Tinku. Keep everything else exactly the same."]);
    expect(rec.state.nodes.draw!.locked).toEqual({ version: "2.1", by: "auto" });
    expect(rec.state.nodes.draw!.versions["2.1"]).toMatchObject({ parents: ["1.2"], madeBy: "edit" });
    expect(rec.state.nodes.pick!.decisions.map((d) => [d.action, d.by])).toEqual([["edit", "auto"], ["lock", "auto"]]);
    expect(rec.state.status).toBe("completed");
    expect(replay(readRun(log, "run1"))).toEqual(rec.state);
  });
});

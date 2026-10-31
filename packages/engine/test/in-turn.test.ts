/**
 * One shot at a time: a for-each whose items go in turn, reading what came before
 * through `so_far`, with redos that send exactly what a person said ok to. Runs
 * the real episode_by_shot recipes with a shot list that has voices and clips.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadDir } from "../src/load.js";
import { Recorder, readRun, replay, Scheduler, type Decision, type Executors, type Node, type StepContext } from "../src/index.js";

const { graphs } = loadDir(resolve(__dirname, "../../../examples"));
const top = graphs.find((g) => g.graph === "episode_by_shot")!;
const SERIES = { series: { style: "2D cartoon", rules: "no film songs", cast: ["Mitra"], music: { main: "main.mp3" } } };
const LIBRARY = { assets: { facet: (entity: string, facet: string) => ({ version: "v1", value: `${entity}:${facet}` }) } };

const line = (id: string) => ({ id, speaker: "Mitra", hinglish: `say ${id}`, emotion: "warm", caption_en: id });
const SHOTS = [
  { id: "S1", characters: ["Mitra"], place: "Stall", action: "pours chai", animate: true, music: "main", lines: [line("L1"), line("L2")] },
  { id: "S2", characters: ["Mitra"], place: "Stall", action: "looks up", animate: false, music: "main", lines: [line("L1")] },
  { id: "S3", characters: ["Mitra"], place: "Lane", action: "walks off", animate: false, music: "main", lines: [] },
];

type Script = Record<string, (Decision | ((c: StepContext) => Decision))[]>;

/** Presses the obvious button on every screen, except what `script` says for a step's key, in order. */
function harness(
  script: Script = {},
  overrides: Record<string, (ctx: StepContext) => Record<string, unknown> | { ticket: string }> = {},
  waitAt: string[] = [],
  prompts: Record<string, string> = {},
) {
  const calls: string[] = [];
  const asked: Record<string, StepContext[]> = {};
  const tickets: { ticket: string; output: Record<string, unknown>; prompt: string }[] = [];
  const usual: Record<string, (c: StepContext) => Decision> = {
    approve_shots: () => ({ action: "approve" }),
    pick: (c) => ({ action: "use", selection: [c.shows!.at(-1)!.version] }),
    see_clip: () => ({ action: "use" }),
    listen: () => ({ action: "use" }),
    watch: () => ({ action: "next" }),
  };
  const exec: Executors = {
    produce(node: Node, ctx) {
      calls.push(ctx.key);
      (asked[ctx.key] ??= []).push(ctx);
      if (overrides[node.id]) {
        const got = overrides[node.id]!(ctx);
        if ("ticket" in got) return got as { ticket: string };
        return [got];
      }
      if (node.id === "shot_list") return [{ shots: SHOTS, hook: "Next week" }];
      if (node.id === "assemble" || node.id === "cut") return [{ reel: `reel:${ctx.key}#${ctx.visit}`, seconds: 10 }];
      if (node.id.startsWith("word_")) return [{ prompt: `proposal ${ctx.visit} from ${node.id}` }];
      if (node.kind === "model" && node.out.image) {
        const reported = prompts[ctx.key];
        if (reported) {
          tickets.push({ ticket: `job${tickets.length}`, output: { image: `image:${ctx.key}#${ctx.visit}` }, prompt: reported });
          return { ticket: tickets.at(-1)!.ticket };
        }
        return [{ image: `image:${ctx.key}#${ctx.visit}` }];
      }
      if (node.kind === "model" && node.out.clip) return [{ clip: `clip:${ctx.key}#${ctx.visit}` }];
      return [{ audio: `audio:${ctx.key}#${ctx.visit}`, seconds: 3 }];
    },
    check: (_n, _c, cands) => cands.map((c) => ({ version: c.version, pass: true, issues: [] })),
    decide(node, ctx) {
      calls.push(ctx.key);
      if (waitAt.includes(ctx.key)) return undefined;
      const next = script[ctx.key]?.shift();
      if (next) return typeof next === "function" ? next(ctx) : next;
      if (node.id === "watch" && ctx.key === "watch") return { action: "approve" };
      const d = usual[node.id];
      if (!d) throw new Error(`no decision for '${ctx.key}'`);
      return d(ctx);
    },
  };
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(top, rec, exec, graphs, LIBRARY);
  s.start("a".repeat(64), { story_pages: "pages", part_no: 1 }, SERIES);
  /** Runs until nothing's left to do, handing back each job the way a provider does, with the prompt it got. */
  const go = () => {
    s.run();
    for (let job = tickets.shift(); job; job = tickets.shift()) {
      s.deliver(job.ticket, [job.output], [{ prompt: job.prompt }]);
      s.run();
    }
  };
  return { s, rec, calls, asked, log, go, exec };
}

describe("a one-at-a-time for-each", () => {
  it("finishes each shot before the next one starts, in list order", () => {
    const { calls, go, rec, log } = harness();
    go();
    expect(rec.state.status).toBe("completed");
    const shots = calls.flatMap((c) => /^per_shot\[(\w+)\]/.exec(c)?.[1] ?? []);
    expect(shots.filter((k, i) => k !== shots[i - 1])).toEqual(["S1", "S2", "S3"]); // never back and forth
    expect(calls.filter((c) => c.endsWith("speak"))).toEqual(["per_shot[S1].voices[L1].speak", "per_shot[S1].voices[L2].speak", "per_shot[S2].voices[L1].speak"]);
    expect(replay(readRun(log, "run1"))).toEqual(rec.state);
  });

  it("waits with nothing started on the shots to come", () => {
    const { go, rec } = harness({}, { draw: () => ({ ticket: "t" }) });
    go();
    expect(Object.keys(rec.state.nodes).filter((k) => k.startsWith("per_shot["))).toEqual(["per_shot[S1].draw"]);
  });

  it("the movie after each shot holds every shot so far, a shot with no clip reading null", () => {
    const { asked, go } = harness();
    go();
    const cut = (k: string) => asked[`per_shot[${k}].cut`]![0]!.uses;
    expect((cut("S1")["so_far.items"] as { id: string }[]).map((x) => x.id)).toEqual(["S1"]);
    expect((cut("S3")["so_far.items"] as { id: string }[]).map((x) => x.id)).toEqual(["S1", "S2", "S3"]);
    expect(cut("S3")["so_far.panel"]).toEqual(["image:per_shot[S1].draw#1", "image:per_shot[S2].draw#1", "image:per_shot[S3].draw#1"]);
    expect(cut("S3")["so_far.clip"]).toEqual(["clip:per_shot[S1].animate#1", null, null]);
    expect(cut("S3")["so_far.audio"]).toEqual([
      ["audio:per_shot[S1].voices[L1].speak#1", "audio:per_shot[S1].voices[L2].speak#1"],
      ["audio:per_shot[S2].voices[L1].speak#1"],
      [],
    ]);
  });

  it("a change to shot 1 doesn't make the movies after shots 2 and 3 stale, only the Reel", () => {
    const { s, rec, go } = harness({
      "per_shot[S1].pick": [{ action: "change", selection: ["1.1"], note: "darker" }],
      "per_shot[S1].ok_picture": [{ action: "send" }],
      "per_shot[S1].animate": [],
    });
    go();
    expect(rec.state.status).toBe("completed");
    s.lock("per_shot[S1].draw", "1.1");
    const stale = s.stale().map((x) => x.key);
    expect(stale).not.toContain("per_shot[S2].cut");
    expect(stale).not.toContain("per_shot[S3].cut");
    expect(stale).toContain("per_shot[S1].animate");
  });

  it("a failed shot stops the line; retrying carries on from it and asks nothing already done", () => {
    let tries = 0;
    const h = harness({}, {
      speak: (c) => (c.key === "per_shot[S2].voices[L1].speak" && tries++ === 0 ? { ticket: "t" } : { audio: `audio:${c.key}`, seconds: 3 }),
    });
    h.go();
    h.s.failJob("t", "the voice model refused");
    h.go();
    expect(h.rec.state.nodes.per_shot?.status).toBe("failed");
    expect(h.rec.state.nodes.per_shot?.failure).toBe("item S2 didn't finish");
    expect(Object.keys(h.rec.state.nodes).some((k) => k.startsWith("per_shot[S3]"))).toBe(false);

    const before = h.calls.length;
    h.s.retry("per_shot[S2].voices[L1].speak");
    h.go();
    expect(h.rec.state.status).toBe("completed");
    const after = h.calls.slice(before);
    expect(after.filter((c) => c.startsWith("per_shot[S1]"))).toEqual([]);
    expect(after.some((c) => c.startsWith("per_shot[S3]"))).toBe(true);
    expect(replay(readRun(h.log, "run1"))).toEqual(h.rec.state);
  });
});

describe("a redo is a conversation", () => {
  it("note → prompt → change → prompt → send: the model gets the approved words and nothing else", () => {
    const { asked, go, rec, log } = harness({
      "per_shot[S1].pick": [{ action: "change", selection: ["1.1"], note: "Mitra looks scared" }],
      "per_shot[S1].ok_picture": [{ action: "change", note: "and it's night" }, { action: "send" }],
    });
    go();
    expect(rec.state.status).toBe("completed");
    const words = asked["per_shot[S1].word_picture"]!;
    expect(words).toHaveLength(2);
    expect(words[0]!.uses["pick.note"]).toBe("Mitra looks scared");
    expect(words[0]!.instruction).toBeUndefined();
    expect(words[1]!.instruction).toBe("and it's night");
    expect(words[1]!.uses["ok_picture.selected"]).toBe("proposal 1 from word_picture");

    const edit = asked["per_shot[S1].edit_picture"]!;
    expect(edit).toHaveLength(1);
    expect(edit[0]!.send).toBe("proposal 2 from word_picture");
    expect(edit[0]!.parent?.version).toBe("1.1");
    // The proposal is shown, never locked, so nothing can go stale over it.
    expect(rec.state.nodes["per_shot[S1].word_picture"]?.locked).toBeUndefined();
    expect(rec.state.nodes["per_shot[S1].draw"]?.locked?.version).toBe("2.1");
    expect(replay(readRun(log, "run1"))).toEqual(rec.state);
  });

  it("nothing goes to the image model until Send it", () => {
    const { calls, s, rec } = harness({ "per_shot[S1].pick": [{ action: "change", selection: ["1.1"], note: "darker" }] }, {}, ["per_shot[S1].ok_picture"]);
    s.run();
    expect(rec.state.nodes["per_shot[S1].ok_picture"]?.status).toBe("awaiting_human");
    expect(calls).toContain("per_shot[S1].word_picture");
    expect(calls).not.toContain("per_shot[S1].edit_picture");
    expect(calls).not.toContain("per_shot[S1].redraw_picture");
  });

  it("the writer reads the prompt that really made what's on screen", () => {
    const { asked, go } = harness(
      { "per_shot[S1].pick": [{ action: "change", selection: ["1.1"], note: "darker" }], "per_shot[S1].ok_picture": [{ action: "send" }] },
      {},
      [],
      { "per_shot[S1].draw": "the words the image model really got" },
    );
    go();
    expect(asked["per_shot[S1].word_picture"]![0]!.uses["pick.prompt"]).toBe("the words the image model really got");
  });

  it("Draw a new one goes to a fresh drawing, not an edit", () => {
    const { asked, go } = harness({
      "per_shot[S1].pick": [{ action: "redraw", note: "wider, from the street" }],
      "per_shot[S1].ok_picture": [{ action: "send" }],
    });
    go();
    expect(asked["per_shot[S1].redraw_picture"]).toHaveLength(1);
    expect(asked["per_shot[S1].edit_picture"]).toBeUndefined();
  });

  it("a voice and a clip work the same way", () => {
    const { asked, go, rec } = harness({
      "per_shot[S1].see_clip": [{ action: "change", note: "slower" }],
      "per_shot[S1].ok_clip": [{ action: "send" }],
      "per_shot[S1].voices[L2].listen": [{ action: "change", note: "angrier" }],
      "per_shot[S1].voices[L2].ok_voice": [{ action: "send" }],
    });
    go();
    expect(rec.state.status).toBe("completed");
    expect(asked["per_shot[S1].remake_clip"]![0]!.send).toBe("proposal 1 from word_clip");
    expect(asked["per_shot[S1].remake_clip"]![0]!.uses["pick.selected"]).toBe("image:per_shot[S1].draw#1");
    expect(asked["per_shot[S1].voices[L2].respeak"]![0]!.send).toBe("proposal 1 from word_voice");
    expect(rec.state.nodes["per_shot[S1].voices[L2].speak"]?.locked?.version).toBe("2.1");
    expect(rec.state.nodes["per_shot[S1].voices[L1].speak"]?.locked?.version).toBe("1.1");
  });
});

describe("going back from the movie", () => {
  it("Change a voice asks each line again, remakes only what you change, and makes the movie again", () => {
    const { calls, go, rec } = harness({
      "per_shot[S1].watch": [{ action: "voice" }],
      "per_shot[S1].voices[L2].listen": [{ action: "use" }, { action: "change", note: "softer" }],
      "per_shot[S1].voices[L2].ok_voice": [{ action: "send" }],
    });
    go();
    expect(rec.state.status).toBe("completed");
    const s1 = calls.filter((c) => c.startsWith("per_shot[S1].voices") || c === "per_shot[S1].cut");
    expect(s1).toEqual([
      "per_shot[S1].voices[L1].speak", "per_shot[S1].voices[L1].listen",
      "per_shot[S1].voices[L2].speak", "per_shot[S1].voices[L2].listen",
      "per_shot[S1].cut",
      "per_shot[S1].voices[L1].listen",
      "per_shot[S1].voices[L2].listen", "per_shot[S1].voices[L2].word_voice", "per_shot[S1].voices[L2].ok_voice", "per_shot[S1].voices[L2].respeak", "per_shot[S1].voices[L2].listen",
      "per_shot[S1].cut",
    ]);
    expect(rec.state.nodes["per_shot[S1].voices"]?.locked?.version).toBe("2.1");
  });

  it("Change the picture on a shot with no clip goes straight back to the movie", () => {
    const { calls, go, rec } = harness({ "per_shot[S2].watch": [{ action: "picture" }] });
    go();
    expect(rec.state.status).toBe("completed");
    expect(calls.filter((c) => c === "per_shot[S2].cut")).toHaveLength(2);
    expect(calls.filter((c) => c.endsWith("speak")).filter((c) => c.startsWith("per_shot[S2]"))).toHaveLength(1);
  });

  it("from the finished Reel, Go back asks each shot's movie again and pays for nothing", () => {
    const { calls, go, rec } = harness({ watch: [{ action: "back" }] });
    go();
    expect(rec.state.status).toBe("completed");
    const after = calls.slice(calls.lastIndexOf("watch") === -1 ? 0 : calls.indexOf("watch") + 1);
    expect(after).toEqual(["per_shot[S1].watch", "per_shot[S2].watch", "per_shot[S3].watch", "assemble", "watch"]);
  });
});

describe("a crash", () => {
  it("while a redo is out, picks up the same words and pays once", () => {
    const sent: (string | undefined)[] = [];
    const h = harness(
      { "per_shot[S1].pick": [{ action: "change", selection: ["1.1"], note: "darker" }], "per_shot[S1].ok_picture": [{ action: "send" }] },
      { edit_picture: (c) => (sent.push(c.send), { ticket: "edit" }) },
    );
    h.go();
    expect(sent).toEqual(["proposal 1 from word_picture"]);

    const again = Recorder.resume(h.log, "run1");
    expect(again.state).toEqual(h.rec.state);
    const after = new Scheduler(top, again, h.exec, graphs, LIBRARY);
    after.recover();
    expect(sent).toEqual(["proposal 1 from word_picture", "proposal 1 from word_picture"]);
    after.deliver("edit", [{ image: "image:edited" }]);
    after.run();
    expect(again.state.nodes["per_shot[S1].draw"]?.versions["2.1"]?.output).toEqual({ image: "image:edited" });
    expect(Object.keys(again.state.nodes["per_shot[S1].draw"]?.versions ?? {})).toEqual(["1.1", "2.1"]);
    expect(h.calls.filter((c) => c === "per_shot[S1].draw")).toHaveLength(1); // the original isn't drawn again
  });

  it("between two shots, the next one starts once", () => {
    const h = harness({}, {}, ["per_shot[S2].pick"]);
    h.go();
    const reopened = () => {
      const r = Recorder.resume(h.log, "run1");
      const s = new Scheduler(top, r, h.exec, graphs, LIBRARY);
      s.recover();
      return { r, s };
    };
    const first = reopened();
    expect(first.r.state.nodes.per_shot?.items?.started).toEqual(["S1", "S2"]);
    const second = reopened();
    expect(second.r.state.nodes.per_shot?.items?.started).toEqual(["S1", "S2"]);
    expect(h.calls.filter((c) => c === "per_shot[S2].draw")).toHaveLength(1);
  });
});


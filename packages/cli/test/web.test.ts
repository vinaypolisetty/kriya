import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@kriya/store";
import { main, type IO } from "../src/commands.js";
import { loadProject } from "../src/project.js";
import { estimates, mediaIn, startWeb, type WebItem } from "../src/web.js";

async function kriya(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), cwd });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A fake project with one shot waiting on its pick screen. */
async function waitingShot() {
  const dir = mkdtempSync(join(tmpdir(), "kriya-web-"));
  await kriya(dir, "init", "p3", "--example", "mohalla-mitra");
  const cwd = join(dir, "p3");
  const shot = JSON.stringify({ id: "P3-04", characters: ["Mitra"], place: "Chai stall", action: "Mitra writes", lines: [], animate: false });
  expect((await kriya(cwd, "run", "shot_recipe", "--input", `item=${shot}`, "--id", "shot")).code).toBe(0);
  const io: IO = { out: () => {}, err: () => {}, cwd };
  const web = await startWeb(loadProject(cwd), { port: 0, io });
  return { cwd, web };
}

const get = async (web: { url: string }, path: string) => {
  const r = await fetch(web.url + path);
  return { status: r.status, body: (await r.json()) as { items: WebItem[]; error?: string; project?: string } };
};

/** The next `changed` event from the server's event stream, or a timeout. */
function nextChange(web: { url: string }, after: () => Promise<unknown>): Promise<number> {
  return new Promise((ok, fail) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => (ctrl.abort(), fail(new Error("no change event"))), 5000);
    void fetch(`${web.url}/api/events`, { signal: ctrl.signal }).then(async (r) => {
      const reader = r.body!.getReader();
      let seen = 0;
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        for (const m of buf.matchAll(/event: changed\ndata: (\d+)\n\n/g)) {
          seen++;
          if (seen === 1) void after(); // the first event says hello; act, then wait for the news
          else {
            clearTimeout(timer);
            ctrl.abort();
            return ok(Number(m[1]));
          }
        }
        buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
      }
    }).catch((e: unknown) => (e as Error).name === "AbortError" || fail(e));
  });
}

describe("kriya web: the inbox over HTTP (Day 22)", () => {
  it("lists what's waiting on you, with each candidate's checks and the suggested fix, and reading writes nothing", async () => {
    const { cwd, web } = await waitingShot();
    try {
      const store = openStore(join(cwd, ".kriya"));
      const before = store.events.read("shot").length;
      const { status, body } = await get(web, "/api/inbox");
      expect(status).toBe(200);
      expect(body.project).toBe("p3");
      expect(body.items).toHaveLength(1);
      const item = body.items[0]!;
      expect(item).toMatchObject({ id: "shot:pick", run: "shot", key: "pick", review: "pick_one", working: false });
      expect(item.shows.map((s) => [s.version, s.verdict?.pass])).toEqual([["1.1", true], ["1.2", true], ["1.3", true]]);
      expect(item.buttons.map((b) => b.id)).toEqual(["lock", "edit", "crop", "retry"]);
      expect(item.suggested).toMatchObject({ action: "lock", selection: ["1.1"] });
      expect(store.events.read("shot").length).toBe(before);
      store.close();
    } finally {
      await web.close();
    }
  });

  it("a decision from the browser locks the panel and the item leaves the inbox; a bad one is a plain 400", async () => {
    const { cwd, web } = await waitingShot();
    try {
      const r = await fetch(`${web.url}/api/decide`, { method: "POST", body: JSON.stringify({ run: "shot", key: "pick", action: "lock", selection: ["1.2"] }) });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { items: unknown[] }).items).toEqual([]);
      await new Promise((ok) => setTimeout(ok, 50));
      expect((await kriya(cwd, "status", "shot")).out).toContain("✓ draw · locked 1.2");
      const bad = await fetch(`${web.url}/api/decide`, { method: "POST", body: JSON.stringify({ run: "shot" }) });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("say which run, step and button: { run, key, action }");
    } finally {
      await web.close();
    }
  });

  it("your answer wins: a screen that has since become automatic can't answer in your place (Day 23)", async () => {
    const { cwd, web } = await waitingShot();
    try {
      // The recipe changes while the server runs: the pick screen now follows its checks.
      const recipe = join(cwd, "recipes", "shot.yaml");
      writeFileSync(recipe, readFileSync(recipe, "utf8").replace("    review: pick_one\n", "    review: pick_one\n    trust: when_confident\n"));
      const r = await fetch(`${web.url}/api/decide`, { method: "POST", body: JSON.stringify({ run: "shot", key: "pick", action: "lock", selection: ["1.2"], note: "the clearest one" }) });
      expect(r.status, await r.clone().text()).toBe(200);
      await new Promise((ok) => setTimeout(ok, 50));
      const store = openStore(join(cwd, ".kriya"));
      const decided = store.events.read("shot").filter((e) => e.type === "HumanDecision").map((e) => e.payload);
      store.close();
      expect(decided).toEqual([{ node: "pick", action: "lock", selection: ["1.2"], note: "the clearest one", by: "human" }]);
      expect((await kriya(cwd, "status", "shot")).out).toContain("✓ draw · locked 1.2 (\"the clearest one\")");
    } finally {
      await web.close();
    }
  });

  it("a run as its recipe's graph: each step's kind and live state, the arrows with their words, loops marked (Day 24)", async () => {
    const { cwd, web } = await waitingShot();
    try {
      const runs = (await (await fetch(`${web.url}/api/runs`)).json()) as { runs: { id: string; recipe: string; status: string; waiting: number }[] };
      expect(runs.runs).toEqual([expect.objectContaining({ id: "shot", recipe: "shot_recipe", status: "running", waiting: 1 })]);

      const g = (await (await fetch(`${web.url}/api/runs/shot/graph`)).json()) as {
        recipe: string;
        nodes: { id: string; kind: string; detail: string; status: string; waitingOnYou: boolean; versions: { id: string; verdict?: { pass: boolean } }[] }[];
        edges: { from: string; to: string; label?: string; back?: boolean; limit?: number }[];
      };
      expect(g.recipe).toBe("shot_recipe");
      const node = (id: string) => g.nodes.find((n) => n.id === id)!;
      expect(node("draw")).toMatchObject({ kind: "model", detail: "AI · draws · 3 options · checked", status: "completed", waitingOnYou: false });
      expect(node("draw").versions.map((v) => [v.id, v.verdict?.pass])).toEqual([["1.1", true], ["1.2", true], ["1.3", true]]);
      expect(node("pick")).toMatchObject({ kind: "screen", detail: "You decide · 4 buttons", status: "awaiting_human", waitingOnYou: true });
      expect(node("animate")).toMatchObject({ status: "not_started" });
      expect(g.edges).toContainEqual({ from: "pick", to: "draw", label: "retry", back: true, limit: 4 });
      expect(g.edges).toContainEqual({ from: "pick", to: "animate", label: "lock · item.animate" });
    } finally {
      await web.close();
    }
  });

  it("a one-at-a-time for-each says so, and the shots to come haven't started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kriya-web-"));
    await kriya(dir, "init", "p3", "--example", "mohalla-mitra");
    const cwd = join(dir, "p3");
    await kriya(cwd, "run", "episode_by_shot", "--input", "part_no=3", "--input", "story_pages=x", "--id", "ep");
    await kriya(cwd, "decide", "1", "approve");
    const web = await startWeb(loadProject(cwd), { port: 0, io: { out: () => {}, err: () => {}, cwd } });
    try {
      const g = (await (await fetch(`${web.url}/api/runs/ep/graph`)).json()) as { nodes: { id: string; inTurn?: boolean; items?: { key: string; status: string }[] }[] };
      const shots = g.nodes.find((n) => n.id === "per_shot")!;
      expect(shots.inTurn).toBe(true);
      expect(shots.items!.map((i) => i.status)).toEqual(["awaiting_human", "not_started", "not_started"]);
    } finally {
      await web.close();
    }
  });

  it("a for-each step shows each item's state, and opening one shows that item's own steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kriya-web-"));
    await kriya(dir, "init", "p3", "--example", "mohalla-mitra");
    const cwd = join(dir, "p3");
    await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x", "--id", "part");
    await kriya(cwd, "decide", "1", "approve");
    const web = await startWeb(loadProject(cwd), { port: 0, io: { out: () => {}, err: () => {}, cwd } });
    try {
      type Step = { key: string; name: string; status: string; waitingOnYou: boolean };
      const g = (await (await fetch(`${web.url}/api/runs/part/graph`)).json()) as { nodes: { id: string; items?: { key: string; label: string; status: string; steps: Step[] }[] }[] };
      const shots = g.nodes.find((n) => n.id === "per_shot")!.items!;
      expect((g.nodes.find((n) => n.id === "per_shot") as { inTurn?: boolean }).inTurn).toBeUndefined();
      expect(shots.map((i) => [i.key, i.status])).toEqual([["per_shot[S1]", "awaiting_human"], ["per_shot[S2]", "awaiting_human"], ["per_shot[S3]", "awaiting_human"]]);
      // Each item carries its own steps, so the box can open them in place: the pick waits on you, the drawing is made.
      expect(shots[0]!.steps.find((s) => s.key === "per_shot[S1].pick")).toEqual({ key: "per_shot[S1].pick", name: "Pick one panel", status: "awaiting_human", waitingOnYou: true, asksYou: true });
      expect(shots[0]!.steps.find((s) => s.key === "per_shot[S1].draw")!.waitingOnYou).toBe(false);
      const one = (await (await fetch(`${web.url}/api/runs/part/graph?at=${encodeURIComponent("per_shot[S2]")}`)).json()) as { recipe: string; trail: { label: string }[]; nodes: { key: string; status: string }[] };
      expect(one.recipe).toBe("shot_recipe");
      expect(one.trail.map((t) => t.label)).toEqual(["part_recipe", "S2"]);
      expect(one.nodes.find((n) => n.key === "per_shot[S2].pick")!.status).toBe("awaiting_human");
      expect((await fetch(`${web.url}/api/runs/part/graph?at=nope[x]`)).status).toBe(400);

      // The Inputs box: what the run, and each item, was started with; every decision with what it was made on.
      expect(((await (await fetch(`${web.url}/api/runs/part/graph`)).json()) as { given: unknown }).given).toEqual({ part_no: 3, story_pages: "x" });
      expect(((await (await fetch(`${web.url}/api/runs/part/graph?at=${encodeURIComponent("per_shot[S2]")}`)).json()) as { given: { item: { id: string } } }).given.item.id).toBe("S2");
      const whole = (await (await fetch(`${web.url}/api/runs/part/trace?all=1`)).json()) as { lines: { text: string }[]; decisions: unknown[] };
      expect(whole.lines[0]!.text).toMatch(/^Run started: part_recipe with part_no=3, story_pages=x/);
      expect(whole.decisions).toEqual([
        expect.objectContaining({ key: "approve_shots", step: "Approve the shot list", reviews: "shot_list", action: "approve", by: "human", on: [expect.objectContaining({ version: "1.1" })], locked: "Break it into shots 1.1", next: "Make each shot" }),
      ]);
      // A step's panel shows the decisions made on it, here or on the screen that reviews it.
      const step = (key: string) => fetch(`${web.url}/api/runs/part/trace?key=${key}`).then((r) => r.json() as Promise<{ decisions: { key: string }[] }>);
      expect((await step("shot_list")).decisions.map((d) => d.key)).toEqual(["approve_shots"]);
      expect((await step("approve_shots")).decisions.map((d) => d.key)).toEqual(["approve_shots"]);
      expect((await step("assemble")).decisions).toEqual([]);
      const picks = ((await (await fetch(`${web.url}/api/inbox`)).json()) as { items: WebItem[] }).items.filter((i) => i.key.endsWith(".pick"));
      expect(picks.map((i) => [i.batch, i.item])).toEqual([["part:per_shot[].pick", "S1"], ["part:per_shot[].pick", "S2"], ["part:per_shot[].pick", "S3"]]); // one batch: every shot's pick
    } finally {
      await web.close();
    }
  });

  it("retry from the browser: plain refusals for a step that hasn't failed or a request that names none", async () => {
    const { web } = await waitingShot();
    try {
      const r = await fetch(`${web.url}/api/retry`, { method: "POST", body: JSON.stringify({ run: "shot", key: "draw" }) });
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toBe("'draw' hasn't failed (it's completed), so there's nothing to retry");
      expect((await fetch(`${web.url}/api/retry`, { method: "POST", body: "{}" })).status).toBe(400);
      expect((await fetch(`${web.url}/api/retry`, { method: "POST", body: JSON.stringify({ run: "shot", key: "draw", note: 3 }) })).status).toBe(400);
      expect((await fetch(`${web.url}/api/retry`, { method: "POST", body: JSON.stringify({ run: "shot", key: "draw", leaveOut: "line.emotion" }) })).status).toBe(400);
    } finally {
      await web.close();
    }
  });

  it("media from the store comes back with its type", async () => {
    const { cwd, web } = await waitingShot();
    try {
      const store = openStore(join(cwd, ".kriya"));
      const { hash } = store.blobs.put(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
      store.close();
      const r = await fetch(`${web.url}/api/media/${hash}`);
      expect(r.headers.get("content-type")).toBe("image/png");
      expect((await fetch(`${web.url}/api/media/${"0".repeat(64)}`)).status).toBe(404);
    } finally {
      await web.close();
    }
  });

  it("live: a decision made in the terminal reaches the browser as a change event", async () => {
    const { cwd, web } = await waitingShot();
    try {
      const seq = await nextChange(web, () => kriya(cwd, "decide", "shot:pick", "lock", "--pick", "1.1"));
      expect(seq).toBeGreaterThan(0);
      expect((await get(web, "/api/inbox")).body.items).toEqual([]);
    } finally {
      await web.close();
    }
  });
});

describe("versions and branches from the browser (Day 26, D-71)", () => {
  const post = async (web: { url: string }, path: string, body: unknown) => {
    const r = await fetch(web.url + path, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { error?: string } };
  };
  const shown = async (web: { url: string }) => (await get(web, "/api/inbox")).body.items[0]!.shows.map((s) => s.version);

  it("branching off a version and switching back changes what the review shows; the graph has the tree", async () => {
    const { web } = await waitingShot();
    try {
      expect((await post(web, "/api/branch", { run: "shot", key: "draw", name: "darker", from: "1.2" })).status).toBe(200);
      expect(await shown(web)).toEqual(["1.2"]);
      expect((await get(web, "/api/inbox")).body.items[0]!.branch).toBe("darker");
      const g = (await (await fetch(`${web.url}/api/runs/shot/graph`)).json()) as { nodes: { id: string; branch?: string; branches?: unknown; versions: { id: string; branch: string; parents: string[] }[] }[] };
      const draw = g.nodes.find((n) => n.id === "draw")!;
      expect(draw).toMatchObject({ branch: "darker", branches: [{ name: "main" }, { name: "darker", from: "1.2" }] });
      expect(draw.versions[0]).toMatchObject({ id: "1.1", branch: "main", parents: [] });

      expect((await post(web, "/api/switch", { run: "shot", key: "draw", branch: "main" })).status).toBe(200);
      expect(await shown(web)).toEqual(["1.1", "1.2", "1.3"]);
      expect((await get(web, "/api/inbox")).body.items[0]!.branch).toBeUndefined();
    } finally {
      await web.close();
    }
  });

  it("plain refusals: a branch that exists, one that doesn't, a bad name, no version to start from", async () => {
    const { web } = await waitingShot();
    try {
      await post(web, "/api/branch", { run: "shot", key: "draw", name: "darker", from: "1.2" });
      expect(await post(web, "/api/branch", { run: "shot", key: "draw", name: "darker", from: "1.1" })).toEqual({ status: 409, body: { error: expect.stringContaining("already a branch called 'darker'") } });
      expect(await post(web, "/api/switch", { run: "shot", key: "draw", branch: "brighter" })).toEqual({ status: 409, body: { error: expect.stringContaining("no branch called 'brighter'") } });
      expect((await post(web, "/api/branch", { run: "shot", key: "draw", name: "Darker Sky", from: "1.1" })).body.error).toMatch(/lowercase letters/);
      expect((await post(web, "/api/branch", { run: "shot", key: "draw", name: "warm" })).status).toBe(400);
      expect(await shown(web)).toEqual(["1.2"]); // nothing above changed anything
    } finally {
      await web.close();
    }
  });
});

describe("the project's recipes on the home page", () => {
  it("lists every recipe file as written, with the graph it defines and its problems", async () => {
    const { cwd, web } = await waitingShot();
    try {
      type Body = { recipes: { file: string; text: string; created: string; graph?: string; level?: string; steps?: number; problems: { line: number }[] }[] };
      const body = (await (await fetch(`${web.url}/api/recipes`)).json()) as Body;
      const shot = body.recipes.find((x) => x.graph === "shot_recipe")!;
      expect(shot).toMatchObject({ level: "shot", problems: [] });
      expect(shot.steps).toBeGreaterThan(0);
      expect(shot.text).toBe(readFileSync(join(cwd, "recipes", shot.file), "utf8"));

      writeFileSync(join(cwd, "recipes", "broken.yaml"), "graph: broken\nlevel: shot\nnodes:\n  - id: a\n    kind: modle\n");
      const after = (await (await fetch(`${web.url}/api/recipes`)).json()) as Body;
      const broken = after.recipes.find((x) => x.file === "broken.yaml")!;
      expect(broken.graph).toBeUndefined();
      // Oldest file first: the one just written comes last.
      expect(after.recipes.at(-1)!.file).toBe("broken.yaml");
      expect(after.recipes.every((x) => !Number.isNaN(Date.parse(x.created)))).toBe(true);
      expect(broken.problems.length).toBeGreaterThan(0);
    } finally {
      await web.close();
    }
  });
});

describe("the Library, read-only, in the browser (Day 26)", () => {
  it("lists who's in it with each facet's version, files as media, history newest first, and what's missing", async () => {
    const { cwd, web } = await waitingShot();
    try {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      writeFileSync(join(cwd, "mitra.png"), png);
      writeFileSync(join(cwd, "library", "mitra.yaml"), "name: Mitra\nkind: character\nlook: { image: mitra.png, words: a thin bald man }\nvoice: Charon\n");
      writeFileSync(join(cwd, "library", "bheem.yaml"), "name: Bheem\nkind: character\nlook: { image: sheets/bheem.png }\n");
      await get(web, "/api/library");
      writeFileSync(join(cwd, "library", "mitra.yaml"), "name: Mitra\nkind: character\nlook: { image: mitra.png, words: a thin bald man }\nvoice: Achird\n");

      const r = await fetch(`${web.url}/api/library`);
      const body = (await r.json()) as { entities: { name: string; needs: string[]; facets: { facet: string; n?: number; missing?: string[]; value: unknown; history: { n: number; current: boolean; value: unknown }[] }[] }[] };
      const mitra = body.entities.find((e) => e.name === "Mitra")!;
      expect(mitra.needs).toEqual(["speech", "rules"]);
      const look = mitra.facets.find((f) => f.facet === "look")!;
      expect(look).toMatchObject({ n: 1, value: { image: { file: "mitra.png", type: "image/png", url: expect.stringMatching(/^\/api\/media\/[0-9a-f]{64}$/) }, words: "a thin bald man" } });
      expect((await fetch(web.url + (look.value as { image: { url: string } }).image.url)).status).toBe(200);
      expect(mitra.facets.find((f) => f.facet === "voice")!.history).toEqual([
        expect.objectContaining({ n: 2, current: true, value: "Achird" }),
        expect.objectContaining({ n: 1, current: false, value: "Charon" }),
      ]);
      const bheem = body.entities.find((e) => e.name === "Bheem")!.facets[0]!;
      expect(bheem).toMatchObject({ facet: "look", missing: ["sheets/bheem.png"], value: { image: { file: "sheets/bheem.png", missing: true } } });
    } finally {
      await web.close();
    }
  });
});

describe("media on a review (Oct 26, real Part 3)", () => {
  const h = "a".repeat(64);
  const types = (hash: string) => (hash === h ? "video/mp4" : undefined);
  it("finds the clip inside an approval's whole output, not just a bare value", () => {
    expect(mediaIn(`blob:${h}`, types)).toEqual({ url: `/api/media/${h}`, type: "video/mp4" });
    expect(mediaIn({ clip: `blob:${h}` }, types)).toEqual({ url: `/api/media/${h}`, type: "video/mp4" });
    expect(mediaIn({ note: "hi", clip: `blob:${"b".repeat(64)}` }, types)).toBeUndefined(); // a blob the store doesn't have
    expect(mediaIn("words", types)).toBeUndefined();
  });
});

describe("kriya web --lan: a phone pairs once, everyone else is turned away (D-68)", () => {
  it("needs the pairing cookie from another device; the pairing link sets it; the token survives a restart", async () => {
    const { cwd, web: local } = await waitingShot();
    await local.close();
    const io: IO = { out: () => {}, err: () => {}, cwd };
    // As a phone: requests from this machine don't count as paired here.
    const web = await startWeb(loadProject(cwd), { port: 0, io, lan: true, trustLoopback: false });
    try {
      const token = readFileSync(join(cwd, ".kriya", "web-token"), "utf8").trim();
      expect(token.length).toBeGreaterThanOrEqual(32);
      expect(web.lan!.pair).toMatch(new RegExp(`/pair\\?token=${token}$`));

      const api = await fetch(`${web.url}/api/inbox`);
      expect(api.status).toBe(401);
      expect(((await api.json()) as { error: string }).error).toContain("this device isn't paired");
      expect((await fetch(`${web.url}/`)).status).toBe(401);
      expect((await fetch(`${web.url}/api/media/${"0".repeat(64)}`)).status).toBe(401);
      expect((await fetch(`${web.url}/pair?token=nope`)).status).toBe(403);

      const pair = await fetch(`${web.url}/pair?token=${token}`, { redirect: "manual" });
      expect(pair.status).toBe(302);
      const cookie = pair.headers.get("set-cookie")!;
      expect(cookie).toMatch(/^kriya_pair=[^;]+; HttpOnly; SameSite=Strict/);
      const paired = await fetch(`${web.url}/api/inbox`, { headers: { cookie: cookie.split(";")[0]! } });
      expect(paired.status).toBe(200);
      const item = ((await paired.json()) as { items: WebItem[] }).items[0]!;
      expect(item).toMatchObject({ batch: "shot:pick" });
    } finally {
      await web.close();
    }
    const again = await startWeb(loadProject(cwd), { port: 0, io, lan: true, trustLoopback: false });
    try {
      expect(again.lan!.pair.endsWith(readFileSync(join(cwd, ".kriya", "web-token"), "utf8").trim())).toBe(true); // the same phone stays paired
    } finally {
      await again.close();
    }
  });

  it("this machine needs no token; without --lan nothing else can reach it", async () => {
    const { cwd, web } = await waitingShot();
    try {
      expect(web.lan).toBeUndefined();
      expect((await fetch(`${web.url}/api/inbox`)).status).toBe(200);
    } finally {
      await web.close();
    }
    const lan = await startWeb(loadProject(cwd), { port: 0, io: { out: () => {}, err: () => {}, cwd }, lan: true });
    try {
      expect((await fetch(`${lan.url}/api/inbox`)).status).toBe(200);
    } finally {
      await lan.close();
    }
  });
});

describe("what a button will cost, before you press it (Day 25)", () => {
  it("Try again costs another set of panels; Edit costs one edit; from what they cost in this run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kriya-web-"));
    await kriya(dir, "init", "p3", "--example", "mohalla-mitra");
    const project = loadProject(join(dir, "p3"));
    const v = (costUsd: number, madeBy?: string) => ({ costUsd, ...(madeBy ? { madeBy } : {}) });
    const state = {
      graph: "shot_recipe",
      nodes: { draw: { versions: { "1.1": v(0.067), "1.2": v(0.067), "1.3": v(0.067), "2.1": v(0.07, "edit") } } },
    } as unknown as Parameters<typeof estimates>[1];
    expect(estimates(project, state, "pick")).toEqual({ retry: 0.201, edit: 0.07 }); // crop has run nowhere yet: no guess
    const part = { graph: "part_recipe", nodes: { "per_shot[S1].draw": { versions: { "1.1": v(0.05), "1.2": v(0.05), "1.3": v(0.05) } } } } as unknown as Parameters<typeof estimates>[1];
    expect(estimates(project, part, "per_shot[S1].pick")).toEqual({ retry: 0.15 });
  });
});

describe("tips in the browser (Day 35, D-76)", () => {
  it("the inbox's tips come from failed checks; Apply saves to kb.yaml and the tip goes; an unknown one is a plain 400", async () => {
    const { cwd, web } = await waitingShot();
    try {
      const tipsNow = async () => (await (await fetch(`${web.url}/api/tips`)).json()) as { tips: { id: string; hits: number }[]; applied: unknown[] };
      expect((await tipsNow()).tips).toEqual([]);
      const store = openStore(join(cwd, ".kriya"));
      for (const v of ["1.1", "1.2", "1.3"]) store.events.append("shot", "VerdictRecorded", { node: "draw", version: v, by: "llm", pass: false, issues: [{ type: "missing_character" }] });
      store.close();
      expect((await tipsNow()).tips).toMatchObject([{ id: "missing_character:shot_recipe.draw", hits: 3 }]);

      const post = (body: unknown) => fetch(`${web.url}/api/tips`, { method: "POST", body: JSON.stringify(body) });
      const bad = await post({ id: "nope", answer: "apply" });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("there's no tip 'nope' now; it may have been answered already");
      const r = await post({ id: "missing_character:shot_recipe.draw", answer: "apply" });
      expect(await r.json()).toEqual({ tips: [], applied: [{ rule: "kb_missing_character", step: "shot_recipe.draw" }] });
      expect(readFileSync(join(cwd, "kb.yaml"), "utf8")).toContain("rule: kb_missing_character");
    } finally {
      await web.close();
    }
  });
});

describe("what happened, in the browser (Day 36)", () => {
  it("a run's trace: each arrow's count, each review's last answer, and one step's lines in plain words", async () => {
    const { cwd, web } = await waitingShot();
    try {
      const get = async (q: string) => (await (await fetch(`${web.url}/api/runs/shot/trace${q}`)).json()) as { lines: { text: string; tone: string }[]; taken: number[]; answers: Record<string, unknown> };
      const before = await get("");
      expect(before.lines).toEqual([]); // lines only for one step
      expect(before.answers).toEqual({});
      const loop = loadProject(cwd).graphs.find((g) => g.graph === "shot_recipe")!.edges.findIndex((e) => e.from === "pick" && e.to === "draw");
      expect(before.taken[loop]).toBe(0); // the retry loop: "up to 4×", not used

      expect((await kriya(cwd, "decide", "1", "retry", "--note", "brighter")).code).toBe(0);
      const after = await get("");
      expect(after.taken[loop]).toBe(1);
      expect(after.answers).toEqual({ pick: { action: "retry", by: "human" } });
      const pick = await get("?key=pick");
      expect(pick.lines.map((l) => [l.text, l.tone])).toContainEqual(['You pressed retry · note: "brighter"', "you"]);

      const missing = await fetch(`${web.url}/api/runs/nope/trace`);
      expect(missing.status).toBe(400);
    } finally {
      await web.close();
    }
  });
});

describe("kriya web in a folder of projects", () => {
  it("home lists each project; each is served under /p/<folder>/, its media from the top too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kriya-web-many-"));
    await kriya(dir, "init", "comic", "--example", "mohalla-mitra");
    await kriya(dir, "init", "desk", "--example", "earnings-report");
    const shot = JSON.stringify({ id: "P3-04", characters: ["Mitra"], place: "Chai stall", action: "Mitra writes", lines: [], animate: false });
    expect((await kriya(join(dir, "comic"), "run", "shot_recipe", "--input", `item=${shot}`, "--id", "shot")).code).toBe(0);
    const web = await startWeb({ folder: dir, projects: ["comic", "desk"].map((p) => loadProject(join(dir, p))) }, { port: 0, io: { out: () => {}, err: () => {}, cwd: dir } });
    try {
      const home = (await (await fetch(`${web.url}/api/projects`)).json()) as { projects: { folder: string; recipes: { graph: string }[]; runs: number; waiting: number }[] };
      expect(home.projects.map((p) => [p.folder, p.runs, p.waiting])).toEqual([["comic", 1, 1], ["desk", 0, 0]]);
      expect(home.projects[1]!.recipes.map((r) => r.graph).sort()).toEqual(["quarter_from_releases", "quarter_review"]); // not the ones that run inside them

      const inbox = await get(web, "/p/comic/api/inbox");
      expect(inbox.body.project).toBe("comic");
      expect(inbox.body.items).toHaveLength(1);
      expect((await get(web, "/p/desk/api/inbox")).body.items).toEqual([]);
      expect((await get(web, "/api/inbox")).status).toBe(404); // no project picked
      expect((await get(web, "/p/nobody/api/inbox")).body.error).toBe(`there's no project 'nobody' in ${dir}`);

      // A file in one project's store, asked for from the top: whichever project has it serves it.
      const store = openStore(join(dir, "desk", ".kriya"));
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const { hash } = store.blobs.put(png);
      store.close();
      const r = await fetch(`${web.url}/api/media/${hash}`);
      expect([r.status, r.headers.get("content-type")]).toEqual([200, "image/png"]);
      expect((await get(web, `/api/media/${"0".repeat(64)}`)).body.error).toBe("no such file");
      expect((await fetch(`${web.url}/p/comic/`)).headers.get("content-type")).toMatch(/text\/(html|plain)/); // the app
    } finally {
      await web.close();
    }
  });
});

describe("a new run from the browser", () => {
  it("lists the project's files, saves an upload once, starts a run on it, and refuses plainly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kriya-web-"));
    await kriya(dir, "init", "fc", "--example", "funny-clips");
    const cwd = join(dir, "fc");
    mkdirSync(join(cwd, "clips"), { recursive: true });
    writeFileSync(join(cwd, "clips", "fall.mp4"), "a clip (fake tools never open it)");
    const web = await startWeb(loadProject(cwd), { port: 0, io: { out: () => {}, err: () => {}, cwd } });
    try {
      const files = (await (await fetch(`${web.url}/api/files`)).json()) as { files: { path: string; type: string }[] };
      expect(files.files).toContainEqual(expect.objectContaining({ path: "clips/fall.mp4", type: "video" }));

      const bytes = readFileSync(join(cwd, "clips", "fall.mp4"));
      const send = (name: string, body: BodyInit) => fetch(`${web.url}/api/files?name=${encodeURIComponent(name)}`, { method: "POST", body }).then(async (r) => ({ status: r.status, body: (await r.json()) as { path?: string; error?: string } }));
      expect((await send("my fall.mp4", bytes)).body.path).toBe("uploads/my_fall.mp4");
      expect((await send("my fall.mp4", bytes)).body.path).toBe("uploads/my_fall.mp4"); // the same file again: saved once
      expect((await send("my fall.mp4", new Uint8Array([1, 2, 3]))).body.path).toBe("uploads/my_fall-2.mp4");
      expect((await send("notes.txt", bytes)).status).toBe(400);

      const start = (body: unknown) => fetch(`${web.url}/api/runs`, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as { id?: string; error?: string } }));
      expect(await start({ recipe: "clip", inputs: { video: "uploads/my_fall.mp4" } })).toEqual({ status: 200, body: { id: "clip-1" } });
      for (let i = 0; i < 50 && !(await get(web, "/api/inbox")).body.items.some((x) => x.id === "clip-1:check_moments"); i++) await new Promise((r) => setTimeout(r, 100));
      expect((await get(web, "/api/inbox")).body.items.map((x) => x.id)).toContain("clip-1:check_moments");

      expect((await start({ recipe: "clip", inputs: {} })).body.error).toMatch(/needs 'video'/);
      expect((await start({ recipe: "clip", inputs: { video: "clips/nope.mp4" } })).body.error).toMatch(/there's no 'clips\/nope.mp4'/);
      expect((await start({ recipe: "clp", inputs: {} })).body.error).toMatch(/no recipe 'clp'/);
      expect((await start({ recipe: "clip", inputs: { video: "uploads/my_fall.mp4" }, id: "clip-1" })).body.error).toMatch(/already a run called 'clip-1'/);
    } finally {
      await web.close();
    }
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@kriya/store";
import { main, type IO } from "../src/commands.js";
import { loadProject } from "../src/project.js";
import { estimates, startWeb, type WebItem } from "../src/web.js";

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

  it("a for-each step shows each item's state, and opening one shows that item's own steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kriya-web-"));
    await kriya(dir, "init", "p3", "--example", "mohalla-mitra");
    const cwd = join(dir, "p3");
    await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x", "--id", "part");
    await kriya(cwd, "decide", "1", "approve");
    const web = await startWeb(loadProject(cwd), { port: 0, io: { out: () => {}, err: () => {}, cwd } });
    try {
      const g = (await (await fetch(`${web.url}/api/runs/part/graph`)).json()) as { nodes: { id: string; items?: { key: string; label: string; status: string }[] }[] };
      const shots = g.nodes.find((n) => n.id === "per_shot")!.items!;
      expect(shots.map((i) => [i.key, i.status])).toEqual([["per_shot[S1]", "awaiting_human"], ["per_shot[S2]", "awaiting_human"], ["per_shot[S3]", "awaiting_human"]]);
      const one = (await (await fetch(`${web.url}/api/runs/part/graph?at=${encodeURIComponent("per_shot[S2]")}`)).json()) as { recipe: string; trail: { label: string }[]; nodes: { key: string; status: string }[] };
      expect(one.recipe).toBe("shot_recipe");
      expect(one.trail.map((t) => t.label)).toEqual(["part_recipe", "S2"]);
      expect(one.nodes.find((n) => n.key === "per_shot[S2].pick")!.status).toBe("awaiting_human");
      expect((await fetch(`${web.url}/api/runs/part/graph?at=nope[x]`)).status).toBe(400);
      const picks = ((await (await fetch(`${web.url}/api/inbox`)).json()) as { items: WebItem[] }).items.filter((i) => i.key.endsWith(".pick"));
      expect(picks.map((i) => [i.batch, i.item])).toEqual([["part:per_shot[].pick", "S1"], ["part:per_shot[].pick", "S2"], ["part:per_shot[].pick", "S3"]]); // one batch: every shot's pick
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

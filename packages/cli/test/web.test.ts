import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@kriya/store";
import { main, type IO } from "../src/commands.js";
import { loadProject } from "../src/project.js";
import { startWeb, type WebItem } from "../src/web.js";

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

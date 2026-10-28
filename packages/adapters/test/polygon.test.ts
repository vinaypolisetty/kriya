import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadText, readRun, Recorder, replay, Scheduler } from "@kriya/engine";
import { describeError, Jobs, MissingPolygonKey, polygonTools, settle } from "../src/index.js";

const recipe = loadText(`graph: q
level: quarter
inputs:
  tickers: list<text>
types:
  filing:
    fields: { id: text, company: text, release: text }
nodes:
  - id: fetch
    kind: tool
    tool: polygon.financials
    uses: [inputs.tickers]
    args: { tickers: inputs.tickers }
    out: { filings: list<filing> }
edges:
  - { from: fetch, to: END }
`).graphs[0]!;

const income = (fy: number, end: string, revenue: number, op: number) => ({
  tickers: ["AAPL"], cik: "320193", timeframe: "quarterly", fiscal_year: fy, fiscal_quarter: 3, period_end: end, filing_date: `${fy}-08-01`,
  revenue, operating_income: op, diluted_earnings_per_share: fy === 2025 ? 1.57 : 1.4,
});

/** A Polygon stand-in: answers by path, remembers every request. */
function polygon(routes: Record<string, (url: URL) => { status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: { url: URL; auth: string | null }[] = [];
  const fetch = (async (input: string, init?: { headers?: Record<string, string> }) => {
    const url = new URL(input);
    calls.push({ url, auth: init?.headers?.authorization ?? null });
    const route = Object.entries(routes).find(([p]) => url.pathname.startsWith(p));
    const r = route ? route[1](url) : { status: 404, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers ?? {} });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const NEW_ENDPOINTS = {
  "/v3/reference/tickers/AAPL": () => ({ status: 200, body: { results: { name: "Apple Inc." } } }),
  "/stocks/financials/v1/income-statements": () => ({ status: 200, body: { status: "OK", results: [income(2025, "2025-06-28", 94_036_000_000, 28_202_000_000), income(2024, "2024-06-29", 85_777_000_000, 25_352_000_000)] } }),
  "/stocks/financials/v1/cash-flow-statements": () => ({ status: 200, body: { results: [{ period_end: "2025-06-28", net_cash_from_operating_activities: 27_867_000_000 }] } }),
  "/stocks/financials/v1/balance-sheets": () => ({ status: 200, body: { results: [{ period_end: "2025-06-28", cash_and_equivalents: 36_269_000_000 }] } }),
};

function run(fetch: typeof globalThis.fetch, tickers: unknown = ["aapl"]) {
  const jobs = new Jobs();
  const tools = polygonTools({ jobs, fetch, sleep: async () => {} });
  const exec = { produce: tools.produce, decide: () => undefined };
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(recipe, rec, exec, [recipe]);
  s.start("a".repeat(64), { tickers });
  return { s, rec, log, jobs };
}

describe("polygon.financials: each company's reported quarter, as text (D-74)", () => {
  let saved: string | undefined;
  beforeEach(() => ((saved = process.env.POLYGON_API_KEY), (process.env.POLYGON_API_KEY = "test-key")));
  afterEach(() => (saved === undefined ? delete process.env.POLYGON_API_KEY : (process.env.POLYGON_API_KEY = saved)));

  it("fetches the statements, writes the latest quarter beside the same quarter a year earlier, with changes worked out", async () => {
    const { fetch, calls } = polygon(NEW_ENDPOINTS);
    const { s, rec, log, jobs } = run(fetch);
    await settle(s, jobs, describeError);

    const v = rec.state.nodes.fetch!.versions["1.1"]!;
    expect(v.model).toBe("polygon:/stocks/financials/v1");
    const [f] = (v.output as { filings: { id: string; company: string; release: string }[] }).filings;
    expect(f).toMatchObject({ id: "AAPL", company: "Apple Inc." });
    expect(f!.release).toContain("Apple Inc. (AAPL): reported results for fiscal Q3 2025, the quarter ended 2025-06-28, filed 2025-08-01. Source: Polygon.");
    expect(f!.release).toContain("- Revenue: $94.04 billion ($85.78 billion; up 9.6%)");
    expect(f!.release).toContain("- Diluted earnings per share: $1.57 per share ($1.40 per share; up 12.1%)");
    expect(f!.release).toContain("- Operating margin (operating income ÷ revenue): 30.0% (29.6%; up 0.4 percentage points)");
    expect(f!.release).toContain("- Net cash from operating activities: $27.87 billion");
    expect(f!.release).toContain("Balance sheet at 2025-06-28:\n- Cash and equivalents: $36.27 billion");
    expect(f!.release).not.toMatch(/cik|Fiscal year/); // ids and dates aren't numbers to report

    const income = calls.find((c) => c.url.pathname.endsWith("income-statements"))!;
    expect(income.url.searchParams.get("tickers")).toBe("AAPL");
    expect(income.url.searchParams.get("timeframe")).toBe("quarterly");
    expect(income.auth).toBe("Bearer test-key");
    expect(replay(readRun(log, "run1"))).toEqual(rec.state);
  });

  it("on a plan without the new endpoints, falls back to /vX/reference/financials", async () => {
    const legacy = (fy: string, end: string, revenue: number) => ({
      fiscal_period: "Q3", fiscal_year: fy, end_date: end, filing_date: `${fy}-08-01`, company_name: "Apple Inc.",
      financials: { income_statement: { revenues: { value: revenue, unit: "USD", label: "Revenues" }, operating_income_loss: { value: revenue * 0.3 } } },
    });
    const { fetch } = polygon({
      "/v3/reference/tickers/AAPL": () => ({ status: 200, body: { results: { name: "Apple Inc." } } }),
      "/stocks/financials/v1/": () => ({ status: 403, body: { status: "NOT_AUTHORIZED" } }),
      "/vX/reference/financials": () => ({ status: 200, body: { results: [legacy("2025", "2025-06-28", 94e9), legacy("2024", "2024-06-29", 85e9)] } }),
    });
    const { s, rec, jobs } = run(fetch);
    await settle(s, jobs, describeError);
    const v = rec.state.nodes.fetch!.versions["1.1"]!;
    expect(v.model).toBe("polygon:/vX/reference/financials");
    expect((v.output as { filings: { release: string }[] }).filings[0]!.release).toContain("- Revenues: $94.00 billion ($85.00 billion; up 10.6%)");
  });

  it("plain failures: no key, an unknown ticker, a plan without financials, no tickers", async () => {
    delete process.env.POLYGON_API_KEY;
    expect(() => run(polygon(NEW_ENDPOINTS).fetch)).not.toThrow(); // the run starts; the step fails with what to do
    const noKey = run(polygon(NEW_ENDPOINTS).fetch);
    expect(() => noKey.s.run()).toThrow(MissingPolygonKey);
    process.env.POLYGON_API_KEY = "test-key";

    const unknown = run(polygon({ "/v3/reference/tickers/": () => ({ status: 404 }) }).fetch, ["ZZZZ"]);
    await settle(unknown.s, unknown.jobs, describeError);
    expect(unknown.rec.state.nodes.fetch?.failure).toBe("Polygon has no ticker 'ZZZZ'; check the symbol");

    const noPlan = run(polygon({ "/v3/reference/tickers/AAPL": () => ({ status: 200, body: { results: { name: "Apple" } } }), "/stocks/": () => ({ status: 403 }), "/vX/": () => ({ status: 403 }) }).fetch);
    await settle(noPlan.s, noPlan.jobs, describeError);
    expect(noPlan.rec.state.nodes.fetch?.failure).toMatch(/your Polygon plan doesn't include company financials/);

    const none = run(polygon(NEW_ENDPOINTS).fetch, []);
    await settle(none.s, none.jobs, describeError);
    expect(none.rec.state.nodes.fetch?.failure).toMatch(/'fetch' needs tickers/);
  });

  it("a rate limit waits as long as Polygon asks, then carries on", async () => {
    let first = true;
    const { fetch } = polygon({
      ...NEW_ENDPOINTS,
      "/v3/reference/tickers/AAPL": () => (first ? ((first = false), { status: 429, headers: { "retry-after": "2" } }) : { status: 200, body: { results: { name: "Apple Inc." } } }),
    });
    const { s, rec, jobs } = run(fetch);
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.fetch?.locked).toBeDefined();
  });
});

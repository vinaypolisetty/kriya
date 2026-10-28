/**
 * Polygon (now Massive) as a data source: the `polygon.financials` tool step
 * fetches each company's reported quarterly results and writes them out as
 * text, one filing per ticker (`{ id, company, release }`), so a recipe can
 * summarize them exactly as it would an earnings release (D-74).
 *
 * - Statements come from `/stocks/financials/v1/{income-statements,
 *   cash-flow-statements, balance-sheets}`; on a plan without those it falls
 *   back to the older `/vX/reference/financials`. The company's name comes
 *   from `/v3/reference/tickers/<ticker>`.
 * - The latest quarter is shown next to the same quarter a year earlier, so
 *   growth compares like with like; the balance sheet is the latest only.
 * - Changes and the operating margin are worked out here, in code, and
 *   written into the text: a summary judged on "every number appears in the
 *   source" can then quote growth instead of computing it.
 * - Every number Polygon returns is written out with a readable label, rather
 *   than a hand-picked few, so nothing is guessed and nothing is left out.
 * - It runs as a job like a model call (D-53); what it fetched is recorded
 *   once and replayed, never fetched again, with the endpoint as its version.
 *
 * Plain `fetch`. The key is `POLYGON_API_KEY` (or `MASSIVE_API_KEY`) in `.env`.
 */
import type { Executors, Node, StepContext } from "@kriya/engine";
import type { Jobs } from "./jobs.js";

export const POLYGON_TOOLS = ["polygon.financials"] as const;

export type PolygonOptions = {
  jobs: Jobs;
  /** Defaults to https://api.polygon.io; https://api.massive.com is the same service. */
  base?: string;
  /** For tests. */
  fetch?: typeof fetch;
  /** For tests: how long to wait before asking again after a 429. */
  sleep?: (ms: number) => Promise<void>;
};

export class MissingPolygonKey extends Error {
  constructor() {
    super("this step fetches financials from Polygon and there's no key: put POLYGON_API_KEY=… in the project's .env");
  }
}
export class PolygonError extends Error {}

/** One reporting period, whichever endpoint it came from: its numbers by name, per statement. */
type Period = { year: number; quarter: number; end: string; filed?: string; income: Numbers; cash: Numbers; balance: Numbers };
type Numbers = Record<string, number>;

const META = new Set(["cik", "tickers", "timeframe", "fiscal_year", "fiscal_quarter", "period_end", "filing_date", "start_date", "end_date"]);

export function polygonTools(opts: PolygonOptions): Pick<Executors, "produce"> & { handles(node: Node): boolean } {
  const base = (opts.base ?? "https://api.polygon.io").replace(/\/$/, "");
  const http = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms)));
  const key = () => process.env.POLYGON_API_KEY ?? process.env.MASSIVE_API_KEY;

  /** One GET, with the key as a bearer token; a 429 waits as long as Polygon asks, a few times. */
  const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    for (let attempt = 0; ; attempt++) {
      const r = await http(`${base}${path}`, { headers: { authorization: `Bearer ${key()}` } });
      if (r.status === 429 && attempt < 4) {
        await sleep(Math.min(60, Number(r.headers.get("retry-after")) || 15 * (attempt + 1)) * 1000);
        continue;
      }
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: r.status, body };
    }
  };
  const results = (b: Record<string, unknown>) => (Array.isArray(b.results) ? (b.results as Record<string, unknown>[]) : []);
  const refused = (status: number, what: string): never => {
    if (status === 401) throw new PolygonError("Polygon didn't accept the key in .env (POLYGON_API_KEY); check it on your Polygon dashboard");
    if (status === 429) throw new PolygonError("Polygon is rate-limiting this key; try the step again in a minute");
    throw new PolygonError(`Polygon answered ${status} for ${what}`);
  };

  /** The new statement endpoints, or undefined when the plan doesn't include them (then the legacy one is tried). */
  const statements = async (ticker: string): Promise<{ periods: Period[]; version: string } | undefined> => {
    const q = (path: string, limit: number) => get(`/stocks/financials/v1/${path}?tickers=${encodeURIComponent(ticker)}&timeframe=quarterly&limit=${limit}&sort=period_end.desc`);
    const income = await q("income-statements", 5);
    if (income.status === 403) return undefined;
    if (income.status !== 200) refused(income.status, `${ticker}'s income statements`);
    const [cash, balance] = await Promise.all([q("cash-flow-statements", 5), q("balance-sheets", 1)]);
    const byEnd = (rows: Record<string, unknown>[]) => new Map(rows.map((r) => [String(r.period_end), numbers(r)]));
    const cashBy = cash.status === 200 ? byEnd(results(cash.body)) : new Map<string, Numbers>();
    const balanceBy = balance.status === 200 ? byEnd(results(balance.body)) : new Map<string, Numbers>();
    const periods = results(income.body).map((r) => ({
      year: Number(r.fiscal_year),
      quarter: Number(r.fiscal_quarter),
      end: String(r.period_end),
      ...(r.filing_date ? { filed: String(r.filing_date) } : {}),
      income: numbers(r),
      cash: cashBy.get(String(r.period_end)) ?? {},
      balance: balanceBy.get(String(r.period_end)) ?? {},
    }));
    return { periods, version: "polygon:/stocks/financials/v1" };
  };

  /** The older `/vX/reference/financials`, on plans without the new endpoints. */
  const legacy = async (ticker: string): Promise<{ periods: Period[]; version: string }> => {
    const r = await get(`/vX/reference/financials?ticker=${encodeURIComponent(ticker)}&timeframe=quarterly&limit=5&order=desc&sort=period_of_report_date`);
    if (r.status === 403) throw new PolygonError("your Polygon plan doesn't include company financials (they need Stocks Advanced, or the Financials & Ratios add-on)");
    if (r.status !== 200) refused(r.status, `${ticker}'s financials`);
    const section = (f: Record<string, unknown> | undefined, name: string): Numbers => {
      const s = (f?.[name] ?? {}) as Record<string, { value?: unknown }>;
      return Object.fromEntries(Object.entries(s).flatMap(([k, v]) => (typeof v?.value === "number" ? [[k, v.value]] : [])));
    };
    const periods = results(r.body).map((x) => {
      const f = x.financials as Record<string, unknown> | undefined;
      return {
        year: Number(x.fiscal_year),
        quarter: Number(String(x.fiscal_period ?? "").replace(/^Q/, "")),
        end: String(x.end_date),
        ...(x.filing_date ? { filed: String(x.filing_date) } : {}),
        income: section(f, "income_statement"),
        cash: section(f, "cash_flow_statement"),
        balance: section(f, "balance_sheet"),
      };
    });
    return { periods, version: "polygon:/vX/reference/financials" };
  };

  const filing = async (ticker: string) => {
    const t = ticker.trim().toUpperCase();
    const ref = await get(`/v3/reference/tickers/${encodeURIComponent(t)}`);
    if (ref.status === 404) throw new PolygonError(`Polygon has no ticker '${t}'; check the symbol`);
    if (ref.status !== 200) refused(ref.status, `ticker ${t}`);
    const company = String((ref.body.results as { name?: unknown } | undefined)?.name ?? t);
    const got = (await statements(t)) ?? (await legacy(t));
    if (got.periods.length === 0) throw new PolygonError(`Polygon has no quarterly results for ${t} yet`);
    return { filing: { id: t, company, release: describe(company, t, got.periods) }, version: got.version };
  };

  return {
    handles: (node) => node.kind === "tool" && (POLYGON_TOOLS as readonly string[]).includes(node.tool),

    produce(node, ctx) {
      if (node.kind !== "tool") throw new Error(`Polygon doesn't run ${node.kind} steps`);
      if (!key()) throw new MissingPolygonKey(); // before the ticket: nothing starts without a key
      const ticket = `polygon:${ctx.idempotencyKey}`;
      opts.jobs.start(ticket, {
        kind: "outputs",
        run: async () => {
          const tickers = tickersOf(node, ctx); // inside the job, so a missing list fails the step plainly
          // One at a time: a free or starter key allows only a few calls a minute.
          const got: Awaited<ReturnType<typeof filing>>[] = [];
          for (const t of tickers) got.push(await filing(t));
          const versions = [...new Set(got.map((g) => g.version))].join(", ");
          return { outputs: [{ filings: got.map((g) => g.filing) }], meta: [{ model: versions, cost_usd: 0 }] };
        },
      });
      return { ticket };
    },
  };
}

/** The tickers a step asks for: `args: { tickers: inputs.tickers }` (a list, or one comma-separated string). */
function tickersOf(node: Extract<Node, { kind: "tool" }>, ctx: StepContext): string[] {
  const a = node.args.tickers;
  const v = typeof a === "string" && a in ctx.uses ? ctx.uses[a] : a;
  const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
  const tickers = list.map((t) => t.trim()).filter(Boolean);
  if (tickers.length === 0) throw new Error(`'${node.id}' needs tickers, e.g. args: { tickers: inputs.tickers } with --input tickers='["AAPL","MSFT"]'`);
  return tickers;
}

/** A record's numbers, without its dates and ids. */
function numbers(r: Record<string, unknown>): Numbers {
  return Object.fromEntries(Object.entries(r).flatMap(([k, v]) => (typeof v === "number" && !META.has(k) ? [[k, v]] : [])));
}

/**
 * The company's results as plain text, the way a release reads: the latest
 * quarter beside the same quarter a year earlier, then the balance sheet.
 */
export function describe(company: string, ticker: string, periods: Period[]): string {
  const [latest] = [...periods].sort((a, b) => b.end.localeCompare(a.end));
  const ago = periods.find((p) => p.quarter === latest!.quarter && p.year === latest!.year - 1);
  const q = (p: Period) => `fiscal Q${p.quarter} ${p.year}`;
  const lines = [
    `${company} (${ticker}): reported results for ${q(latest!)}, the quarter ended ${latest!.end}${latest!.filed ? `, filed ${latest!.filed}` : ""}. Source: Polygon.`,
    ago ? `Each line gives ${q(latest!)}, then in brackets ${q(ago)} (the quarter ended ${ago.end}) and the change.` : "No results for the same quarter a year earlier were available.",
  ];
  const vs = (k: string, v: number, b: number | undefined) => {
    if (b === undefined) return "";
    const change = b !== 0 && Math.sign(b) === Math.sign(v) ? `; ${v >= b ? "up" : "down"} ${Math.abs(((v - b) / Math.abs(b)) * 100).toFixed(1)}%` : "";
    return ` (${money(k, b)}${change})`;
  };
  const section = (title: string, now: Numbers, before?: Numbers) => {
    const rows = Object.entries(now).map(([k, v]) => `- ${label(k)}: ${money(k, v)}${vs(k, v, before?.[k])}`);
    if (rows.length) lines.push("", `${title}:`, ...rows);
  };
  const margin = (p?: Period) => {
    const revenue = p?.income.revenue ?? p?.income.revenues;
    const op = p?.income.operating_income ?? p?.income.operating_income_loss;
    return revenue && op !== undefined ? (op / revenue) * 100 : undefined;
  };
  section("Income statement", latest!.income, ago?.income);
  const m = margin(latest), mAgo = margin(ago);
  if (m !== undefined) {
    const moved = mAgo !== undefined ? ` (${mAgo.toFixed(1)}%; ${m >= mAgo ? "up" : "down"} ${Math.abs(m - mAgo).toFixed(1)} percentage points)` : "";
    lines.push(`- Operating margin (operating income ÷ revenue): ${m.toFixed(1)}%${moved}`);
  }
  section("Cash flow", latest!.cash, ago?.cash);
  section(`Balance sheet at ${latest!.end}`, latest!.balance);
  return lines.join("\n");
}

/** `net_income_loss_attributable_common_shareholders` → "Net income loss attributable common shareholders". */
const label = (k: string) => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, " ");

/** A value with its unit: per-share amounts in dollars, share counts as counts, everything else in $ with B/M. */
function money(k: string, v: number): string {
  if (/per_share/.test(k)) return `$${v.toFixed(2)} per share`;
  if (/shares/.test(k)) return `${(v / 1e6).toFixed(1)} million shares`;
  const a = Math.abs(v);
  const s = a >= 1e9 ? `$${(a / 1e9).toFixed(2)} billion` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)} million` : `$${a.toLocaleString("en-US")}`;
  return v < 0 ? `-${s}` : s;
}

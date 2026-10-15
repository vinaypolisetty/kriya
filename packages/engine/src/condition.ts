/**
 * A small, safe condition language for edges.
 *
 *   action == 'redo'
 *   item.animate == true and attempts < 4
 *   not (verdict.pass) or item.place != 'stall'
 *
 * No function calls, no assignment, no model calls: a condition can only read
 * recorded data, so the path a run takes is deterministic.
 */

export type Expr =
  | { type: "lit"; value: string | number | boolean | null }
  | { type: "path"; path: string[] }
  | { type: "not"; expr: Expr }
  | { type: "and" | "or"; left: Expr; right: Expr }
  | { type: "cmp"; op: CmpOp; left: Expr; right: Expr };

type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

export class ConditionError extends Error {
  constructor(message: string, readonly at: number) {
    super(message);
  }
}

type Tok = { t: "op" | "str" | "num" | "word" | "lp" | "rp"; v: string; at: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(") { out.push({ t: "lp", v: c, at: i++ }); continue; }
    if (c === ")") { out.push({ t: "rp", v: c, at: i++ }); continue; }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">="].includes(two)) { out.push({ t: "op", v: two, at: i }); i += 2; continue; }
    if (c === "<" || c === ">") { out.push({ t: "op", v: c, at: i++ }); continue; }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ConditionError("text is missing its closing quote", i);
      out.push({ t: "str", v: src.slice(i + 1, end), at: i });
      i = end + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: num[0], at: i }); i += num[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
    if (word) { out.push({ t: "word", v: word[0], at: i }); i += word[0].length; continue; }
    throw new ConditionError(`unexpected character '${c}'`, i);
  }
  return out;
}

export function parseCondition(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isWord = (w: string) => peek()?.t === "word" && peek()!.v === w;

  function orExpr(): Expr {
    let left = andExpr();
    while (isWord("or")) { p++; left = { type: "or", left, right: andExpr() }; }
    return left;
  }
  function andExpr(): Expr {
    let left = notExpr();
    while (isWord("and")) { p++; left = { type: "and", left, right: notExpr() }; }
    return left;
  }
  function notExpr(): Expr {
    if (isWord("not")) { p++; return { type: "not", expr: notExpr() }; }
    return cmpExpr();
  }
  function cmpExpr(): Expr {
    const left = operand();
    const t = peek();
    if (t?.t === "op") {
      p++;
      return { type: "cmp", op: t.v as CmpOp, left, right: operand() };
    }
    return left;
  }
  function operand(): Expr {
    const t = toks[p++];
    if (!t) throw new ConditionError("condition ends too early", src.length);
    if (t.t === "lp") {
      const e = orExpr();
      if (toks[p++]?.t !== "rp") throw new ConditionError("missing ')'", t.at);
      return e;
    }
    if (t.t === "str") return { type: "lit", value: t.v };
    if (t.t === "num") return { type: "lit", value: Number(t.v) };
    if (t.t === "word") {
      if (t.v === "true" || t.v === "false") return { type: "lit", value: t.v === "true" };
      if (t.v === "null") return { type: "lit", value: null };
      if (["and", "or", "not"].includes(t.v)) throw new ConditionError(`'${t.v}' needs something on both sides`, t.at);
      return { type: "path", path: t.v.split(".") };
    }
    throw new ConditionError(`unexpected '${t.v}'`, t.at);
  }

  if (toks.length === 0) throw new ConditionError("condition is empty", 0);
  const e = orExpr();
  if (p < toks.length) throw new ConditionError(`unexpected '${toks[p]!.v}'`, toks[p]!.at);
  return e;
}

/** All dotted paths a condition reads, e.g. ["action"], ["item", "animate"]. */
export function pathsIn(e: Expr): string[][] {
  switch (e.type) {
    case "lit": return [];
    case "path": return [e.path];
    case "not": return pathsIn(e.expr);
    default: return [...pathsIn(e.left), ...pathsIn(e.right)];
  }
}

/** String literals compared directly against a given path, e.g. action == 'redo' → ['redo']. */
export function literalsComparedTo(e: Expr, path: string): string[] {
  switch (e.type) {
    case "lit":
    case "path": return [];
    case "not": return literalsComparedTo(e.expr, path);
    case "and":
    case "or": return [...literalsComparedTo(e.left, path), ...literalsComparedTo(e.right, path)];
    case "cmp": {
      const hit = (a: Expr, b: Expr) =>
        a.type === "path" && a.path.join(".") === path && b.type === "lit" && typeof b.value === "string" ? [b.value] : [];
      return [...hit(e.left, e.right), ...hit(e.right, e.left)];
    }
  }
}

export function evaluate(e: Expr, scope: Record<string, unknown>): unknown {
  switch (e.type) {
    case "lit": return e.value;
    case "path": {
      let v: unknown = scope;
      for (const k of e.path) v = v != null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
      return v;
    }
    case "not": return !evaluate(e.expr, scope);
    case "and": return Boolean(evaluate(e.left, scope)) && Boolean(evaluate(e.right, scope));
    case "or": return Boolean(evaluate(e.left, scope)) || Boolean(evaluate(e.right, scope));
    case "cmp": {
      const a = evaluate(e.left, scope) as never;
      const b = evaluate(e.right, scope) as never;
      switch (e.op) {
        case "==": return a === b;
        case "!=": return a !== b;
        case "<": return a < b;
        case "<=": return a <= b;
        case ">": return a > b;
        case ">=": return a >= b;
      }
    }
  }
}

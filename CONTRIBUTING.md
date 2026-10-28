# Contributing to kriya

How to make a change that fits. Read [docs/architecture.md](docs/architecture.md) for how the code fits together. This page covers how to write and land code here. Most rules are checked by CI; the rest are checked in review.

## Set up

```bash
pnpm install                      # Node 20+, pnpm 10+
pnpm test                         # vitest, every package
pnpm typecheck                    # tsc --noEmit, every package
pnpm validate:examples            # every recipe in examples/
pnpm check:conventions            # the rules marked ✓ below
pnpm --filter @kriya/web build    # the browser app, served by `kriya web`
bin/kriya help                    # the CLI, from this checkout
```

The media-tool tests need `ffmpeg` and Python with Pillow; without them they skip themselves. Nothing in `pnpm test` needs an API key or spends money.

## Landing a change

1. **One change, one branch, one PR to `master`.** A roadmap day, a fix, or a docs change. Branch from an up-to-date `master`. Don't stack PRs on each other: a PR based on another branch merges into that branch, not into `master`.
2. **Small and reviewable.** If a PR needs a map to read, split it.
3. **All checks pass locally** before you commit: test, typecheck, validate:examples, check:conventions. CI runs the same, plus the web build.
4. **Every new test is proven.** Break the code it covers and watch it fail, then put the code back. A test that passes either way is noise.
5. **The PR says what and why**, and how you checked it. A new runtime dependency needs its reason in the PR (see [Dependencies](#dependencies)).
6. **Design changes get a decision.** If the change settles a question of behaviour, add a row to [docs/17-decisions.md](docs/17-decisions.md) (next `D-nn`, date, the decision, the reason) and cite it in the code. Don't reverse an existing decision without discussing it first.

## The non-negotiables

These come from the design ([CLAUDE.md](CLAUDE.md) has the short list). A PR that breaks one isn't merged, however good the rest is.

1. **The engine is deterministic; models are not.** Anything a model, agent, judge, tool or person produces is recorded as an event the first time and replayed after that, never asked again.
2. **Conditions read recorded data only.** No model calls, no clock. Judgement goes in a step that records a verdict.
3. **Only locked outputs flow downstream.**
4. **Stable ids, not names.** Renaming a label never breaks a reference, a run or a lock.
5. **Every loop has a limit** (`max_loops`); the validator enforces it.
6. **Record the exact model version** of every call.
7. **Nothing silently changes a lock.**
8. **Creators bring their own keys.** Keys come from `.env`; never commit one, never log one.

## Code

### Language and structure

- TypeScript, strict mode, ES modules. Relative imports end in `.js` (NodeNext).
- **The engine's run core does no I/O.** In `events`, `state`, `recorder`, `scheduler`, `condition`, `spec` and `validate`: no `fs`, no `fetch`, no `Date.now()`, no `Math.random()`. Only `load.ts` reads recipe files. The core reaches outside through interfaces it defines (`Executors`, `Tools`, `Blobs`, `Assets`, `EventSink`), and tests pass fakes. `engine` imports no other `@kriya` package. ✓
- **Pure where possible**, everywhere: `state.apply`, `fixes.suggestFix`, `condition.evaluate` and `schema.fieldsSchema` take data and return data.
- **Zod for every outside shape**: recipe files, `kriya.yaml`, API bodies, LLM tool inputs, events. Derive types with `z.infer`. Schemas are `.strict()`, so a typo is an error instead of being silently ignored.
- **Plain JSON in events.** No `undefined`, `NaN`, `Date` or class instances in a payload; the recorder refuses them.

### Comments

Every source file opens with a header comment ✓ that says what the module is *for*, what it promises, and anything surprising about it. Good examples: [`state.ts`](packages/engine/src/state.ts), [`replicate.ts`](packages/adapters/src/replicate.ts), [`web.ts`](packages/cli/src/web.ts).

Inside the code, comment the **why**, never the *what*:

```ts
// Read-only first: the person's answer is recorded before anything else runs, so nothing
// (an automatic screen, a recovered job) can answer in their place.
```

- Exported functions and types get a one-line `/** … */` doc comment that says what they mean, not how they work.
- **Cite the decision** behind non-obvious behaviour: `(D-46)`. ✓ Every `D-nn` you cite must exist.
- **Name the real incident** behind a fix, with its date, when there is one: *"a six-line hook ran over it, Oct 26"*. The next reader then knows the code isn't arbitrary.
- No commented-out code, no `TODO` without a roadmap day or open question (`Q-nn`) next to it.
- When behaviour changes, update the header comment in the same commit. A stale header is worse than none.

### Errors are for creators

kriya's users write recipes, not code. Every message a creator can see (validator, CLI, web) must:

- say **what's wrong** in plain words, then **how to fix it**;
- **suggest the nearest valid name** when one was misspelled (use `suggest()` from the engine);
- point at the place: `file:line:col` for recipes, the step key for runs.

```
✗ recipes/part.yaml:99:13  part_recipe › edges[0].from
    'from' points at 'shot_lst', which isn't a node. Did you mean 'shot_list'?
✗ there's no run 'part-1'. See your runs with: kriya status
```

In the CLI, throw `UserError` for anything the creator can fix. Plain `Error`s are for bugs, and the message says so (*"this is a bug in kriya, not your recipe"*).

### Naming and words

- Use the [vocabulary](docs/19-glossary.md) consistently: *recipe*, *step*, *candidate*, *version*, *lock*, *stale*, *Library*, *facet*. In code and in UI text: a person **locks** a version, a step **goes stale**, work is **kept** or **rebuilt**.
- Ids are lowercase with underscores (`shot_list`, `per_shot`). Node keys inside a for-each step are `map[item].step` (`per_shot[P3-04].draw`).
- UI and CLI text is sentence case, short, and second person ("waiting for you", "Try again").

### Web

- `packages/web` talks only to `kriya web`'s API (`src/api.ts`); no business logic in components that the server should own.
- Colours are CSS custom properties on `:root`, with a dark-mode override. No hard-coded colours in components.
- Every view works at 390 px wide (the phone), and touch targets are at least 40 px.

### Dependencies

No new runtime dependency without a reason in the PR description. Prefer the platform (`node:http`, `fetch`, `node:util` `parseArgs`) and a few lines of our own over a package. Pin exact versions for anything that touches money or media formats.

## Tests

- In `packages/<pkg>/test/`, named `*.test.ts`. ✓
- **Every validator rule** has a test with a recipe that breaks it.
- **Every event** a test records should end with a replay check: `expect(replay(events())).toEqual(rec.state)`.
- **Every bug fix** starts as a failing test that reproduces it, ideally in the same order of events that broke the real run (see `stale.test.ts`, "the real Part 3 order").
- Tests use fakes written in the test, SQLite in memory, and the real example recipes. Stub `fetch` for providers.
- Name tests as sentences about behaviour: *"a retry on a branch puts its candidates there"*, not *"test branch 2"*.

## Docs

| Change | Update |
|---|---|
| A behaviour decision | [17-decisions.md](docs/17-decisions.md) |
| A recipe field or node option | [04-graph-spec.md](docs/04-graph-spec.md) |
| A CLI command or flag | [cli.md](docs/cli.md) ✓ and the CLI's `HELP` |
| A web route | the route list at the top of `cli/src/web.ts` ✓ |
| A package's job or public API | its `README.md` ✓ |
| How packages fit, or how to extend one | [architecture.md](docs/architecture.md) |
| A roadmap day | [16-roadmap.md](docs/16-roadmap.md): mark it ✅ with what was really checked |

## Review checklist

Reviewers (and authors, before asking) check:

- [ ] Does the engine still do no I/O, and is every non-deterministic result recorded before it's used?
- [ ] Do new events replay to the same state? Does `apply` refuse impossible ones?
- [ ] Can a crash between any two writes lose work or pay twice?
- [ ] Is every message a creator might see plain, actionable, and pointed at a place?
- [ ] Does each new test fail without the change?
- [ ] Are header comments, the decision log and the docs above still true?
- [ ] Do the checks pass: `pnpm test && pnpm typecheck && pnpm validate:examples && pnpm check:conventions`?

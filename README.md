# kriya

**A durable orchestration engine for multi-step creative and production pipelines, with humans in the loop.**

kriya runs workflows made of three kinds of steps, treated as equals:

| Step kind | Who decides what happens next | Example |
|---|---|---|
| **Workflow** | The graph you declared | Script → shot list → panels → clips → voices → Reel |
| **Agent** | A model, inside tools and a budget you set | A fix agent chooses edit, crop or regenerate |
| **UI action** | A human, on a generated screen | Pick one of 3 panels, approve a voice line |

Every step is a small conversation that produces **versions**. You **lock** one, and only locked work flows to the next step. When a locked choice changes upstream, the work that depended on it is marked **stale** and rebuilt only after you approve the plan and cost. Runs are **durable**: they can wait days for a human, survive crashes, and replay from an event log.

The first use case is *Mohalla Mitra*, an Instagram motion-comic series: story → shots → images → clips → voices → music → assembled Reel. The engine itself is generic: hiring pipelines, permit reviews, research reports and software delivery all fit the same model (see [docs/13-use-cases.md](docs/13-use-cases.md)).

## Status

**v0.1 in progress** (target: late November 2026). Today the repo contains:

- The **graph spec** as Zod schemas (`packages/engine/src/spec.ts`)
- A **safe condition language** for edges (`condition.ts`)
- A **validator** that catches broken references, unlimited loops, unknown buttons and undeclared types, with line numbers and "did you mean" suggestions (`validate.ts`, `load.ts`)
- The **Mohalla Mitra recipes** as YAML (`examples/mohalla-mitra/`)
- Tests for all of the above

Next: event log, scheduler, version trees, locks and stale tracking. See [docs/16-roadmap.md](docs/16-roadmap.md).

## Quickstart

```bash
pnpm install
pnpm test                # unit tests
pnpm typecheck           # TypeScript
pnpm validate:examples   # validate every recipe under examples/
```

Requires Node 20+ and pnpm 10+.

## What a recipe looks like

```yaml
graph: shot_recipe
level: shot
nodes:
  - id: draw
    kind: model
    capability: image.generate
    options: 3
    uses: [item.action, item.characters@look, item.place@look, series.style]
  - id: pick
    kind: screen
    review: pick_one
    show: draw.image
    actions:
      - { id: lock, needs: [selection] }
      - { id: edit, needs: [selection, note] }
      - { id: retry, needs: [note] }
  - id: edit
    kind: model
    capability: image.edit
    context: local
edges:
  - { from: draw, to: pick }
  - { from: pick, to: draw, when: "action == 'retry'", max_loops: 4 }
  - { from: pick, to: edit, when: "action == 'edit'" }
  - { from: edit, to: pick, max_loops: 4 }
  - { from: pick, to: END,  when: "action == 'lock'" }
```

The validator explains mistakes in plain words:

```
✗ shot.yaml:77:23  shot_recipe › edges[6].to
    'to' points at 'animat', which isn't a node. Did you mean 'animate'?
✗ shot.yaml:72:35  shot_recipe › edges[1].when
    screen 'pick' has no button 'retyr'. Did you mean 'retry'? (it has: lock, edit, crop, retry)
✗ shot.yaml:71:3   shot_recipe › edges
    loop draw → pick → draw has no limit; add max_loops to the edge that goes back
```

## Repository layout

```
packages/
  engine/            graph spec, conditions, validation, loader (runtime coming next)
examples/
  mohalla-mitra/     part, shot and voice recipes for the reference use case
docs/                full design: concepts, engine, spec, authoring, UI, decisions, roadmap
CLAUDE.md            context and conventions for AI coding assistants
```

## Documentation

New here? Open the folder in VS Code and follow [docs/getting-started-vscode.md](docs/getting-started-vscode.md).

Start with [docs/README.md](docs/README.md). The most important pages:

- [Vision](docs/01-vision.md): what this is and who it's for
- [Core concepts](docs/02-concepts.md): levels, nodes, versions, branches, locks, context, stale
- [Engine](docs/03-engine.md): how runs execute, suspend and resume
- [Graph spec](docs/04-graph-spec.md): the file format, field by field
- [Decisions](docs/17-decisions.md): what's been decided and why

## License

Apache-2.0. See [LICENSE](LICENSE).

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

**v0.1 in progress** (target: late November 2026). Working today:

- **Recipes** in YAML, validated with line numbers and "did you mean" suggestions
- **A durable engine:** an append-only event log, state rebuilt by replay, crash-safe calls with idempotency keys, for-each steps, joins, loop limits
- **Versions, locks, branches and stale tracking**, with plain reasons for what changed; rebuild, retry, adopt and keep
- **Real providers:** Claude (writing, judging, agents) and Replicate (images, clips, voices, music), with costs and model versions recorded; local ffmpeg tools, including a Reel assembler
- **Checks and a fix loop:** a Claude judge plus knowledge-base rules that suggest crop, edit or retry
- **The Library:** characters, places and tracks, with facet history
- **A CLI** (`bin/kriya`) and **a browser app** (`kriya web`): run graphs, a review inbox, phone review over home wifi

On Oct 26 the real Part 3 of *Mohalla Mitra* was made end to end through kriya: 13 panels, 4 clips and 19 voice lines, assembled into a 106-second Reel. A second, text-only example, [earnings reports](examples/earnings-report/README.md), runs on the same engine.

What's next: [docs/16-roadmap.md](docs/16-roadmap.md).

## Quickstart

```bash
pnpm install
pnpm test                # unit tests (no keys, no cost)
pnpm typecheck           # TypeScript
pnpm validate:examples   # validate every recipe under examples/
pnpm check:conventions   # the repo's conventions (CONTRIBUTING.md)

# a whole episode with fake models, from the terminal
alias kriya="$PWD/bin/kriya"
cd /tmp && kriya init p3 --example mohalla-mitra && cd p3
kriya run part_recipe --input part_no=3 --input story_pages="Page 7…"
kriya inbox
```

Requires Node 20+ and pnpm 10+. For real models, put keys in the project's `.env` and set `models:` in `kriya.yaml` ([docs/cli.md](docs/cli.md)).

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
  engine/            the recipe format, validation, and the deterministic core (events, state, scheduler)
  store/             the event log and Library history on SQLite; media by content hash
  adapters/          Claude, Replicate and ffmpeg tools as jobs; the fix policy
  cli/               projects on disk, the kriya commands, and the kriya web server
  web/               the browser app (React): run graph, inbox, review, Library
examples/
  mohalla-mitra/     part, shot and voice recipes for the reference use case
  earnings-report/   a text-only example: summarize, score and rank a quarter's earnings releases
docs/                design (01–19), architecture, CLI, decisions, roadmap, write-ups
scripts/             repo checks (conventions)
bin/kriya            runs the CLI from this checkout
```

## Documentation

New here? Open the folder in VS Code and follow [docs/getting-started-vscode.md](docs/getting-started-vscode.md).

**Changing the code?** Read [docs/architecture.md](docs/architecture.md) (how the packages fit, the life of a run, where to make a change) and [CONTRIBUTING.md](CONTRIBUTING.md) (conventions, tests, the review checklist). Each package has a README.

For the design, start with [docs/README.md](docs/README.md). The most important pages:

- [Vision](docs/01-vision.md): what this is and who it's for
- [Core concepts](docs/02-concepts.md): levels, nodes, versions, branches, locks, context, stale
- [Engine](docs/03-engine.md): how runs execute, suspend and resume
- [Graph spec](docs/04-graph-spec.md): the file format, field by field
- [Decisions](docs/17-decisions.md): what's been decided and why

## License

Apache-2.0. See [LICENSE](LICENSE).

# Getting started in VS Code

## 1. Install once

- **Node.js 20 or newer**: https://nodejs.org (LTS)
- **pnpm**: in a terminal, `npm install -g pnpm` (or `corepack enable`)
- **Git**: https://git-scm.com
- **VS Code**: https://code.visualstudio.com

## 2. Open the project

```bash
git clone https://github.com/vinaypolisetty/kriya ~/code/kriya
```

VS Code → **File → Open Folder…** → `~/code/kriya`. Accept **"Install recommended extensions"** when prompted (Claude Code, Vitest, YAML, ESLint, Prettier, GitHub Actions, Markdown). Then, in the terminal (**View → Terminal**):

```bash
pnpm install              # also builds the browser app
pnpm test                 # every package; no keys, no cost
pnpm validate:examples    # 7 graph(s) loaded · 0 error(s)
```

## 3. Run something

```bash
export PATH="$PWD/bin:$PATH"
kriya init ~/kriya-demo --example mohalla-mitra && cd ~/kriya-demo
kriya run part_recipe --input part_no=1 --input story_pages="Mitra opens his chai stall" && kriya web
```

Then [writing-recipes.md](writing-recipes.md) to make your own, and [architecture.md](architecture.md) before changing kriya itself. Changes go on a branch with a PR to `master`; CI runs the same checks ([CONTRIBUTING.md](../CONTRIBUTING.md)).

## 4. Real models (optional)

Keys live in each project's `.env`, not in the kriya repo:

```bash
cp ~/code/kriya/.env.example ~/kriya-demo/.env   # then paste your Anthropic and Replicate keys
```

and set `models:` in the project's `kriya.yaml` ([cli.md](cli.md)). `kriya init` puts `.env` in the project's `.gitignore`.

## 5. Working with Claude Code in VS Code

Claude Code reads `CLAUDE.md` automatically: the project summary, commands, layout, design rules and vocabulary. Good first prompts:

- "Read docs/16-roadmap.md: what's the next day, and what's its done-when?"
- "Add a validator rule that type-checks connections, with tests."
- "kriya log part_recipe-1 says a step went stale. Walk me through why, from docs/07 and the code."

## Handy

- **Run and Debug** panel → "Validate example recipes" or "Debug engine tests".
- The **Testing** panel (Vitest extension) runs and debugs single tests.
- Example recipes are in `examples/`; errors print with file:line.

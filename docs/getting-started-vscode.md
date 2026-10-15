# Getting started in VS Code

## 1. Install once

- **Node.js 20 or newer**: https://nodejs.org (LTS)
- **pnpm**: in a terminal, `npm install -g pnpm` (or `corepack enable`)
- **Git**: https://git-scm.com
- **VS Code**: https://code.visualstudio.com

## 2. Open the project

1. Unzip `kriya.zip` somewhere like `~/code/kriya`.
2. VS Code → **File → Open Folder…** → choose the `kriya` folder.
3. Accept **"Install recommended extensions"** when prompted (Claude Code, Vitest, YAML, ESLint, Prettier, GitHub Actions, Markdown).
4. Open the terminal (**View → Terminal**) and run:

```bash
pnpm install
pnpm test
pnpm validate:examples
```

You should see 18 passing tests and `3 graph(s) loaded · 0 error(s)`.

## 3. Put it on GitHub

```bash
# create an empty repo on github.com first (no README), then:
git remote add origin https://github.com/<you>/kriya.git
git push -u origin main
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests and recipe validation on every push.

## 4. Keys (needed from Week 3)

```bash
cp .env.example .env    # then paste your Replicate and Anthropic keys
```

`.env` is in `.gitignore`.

## 5. Working with Claude Code in VS Code

Claude Code reads `CLAUDE.md` automatically: the project summary, commands, layout, design rules and vocabulary. Good first prompts:

- "Read docs/16-roadmap.md and start Day 4: storage."
- "Add a validator rule that type-checks connections, with tests."
- "Explain how stale propagation should work, from docs/07."

## Handy

- **Run and Debug** panel → "Validate example recipes" or "Debug engine tests".
- The **Testing** panel (Vitest extension) runs and debugs single tests.
- YAML recipes are in `examples/mohalla-mitra/`; errors print with file:line.

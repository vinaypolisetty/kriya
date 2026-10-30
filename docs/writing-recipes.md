# Writing a recipe

A recipe is a YAML file in your project's `recipes/` folder. This page builds one from nothing, a blog post that an AI drafts, you pick, a judge checks and a second step polishes, then runs it once per topic. Every recipe and every message below was run as written. For every field, see [04-graph-spec](04-graph-spec.md).

Start with a project. `kriya init` makes `kriya.yaml` (fake models, no keys) and an empty `recipes/` folder:

```bash
kriya init blog && cd blog
```

## 1. Two steps: draft, then you pick

`recipes/post.yaml`:

```yaml
graph: post
level: post
description: Draft a short post, let a person pick one, and polish it.

inputs:
  item: text   # the topic

nodes:
  - id: draft
    kind: model
    name: Draft the post
    capability: llm.write
    options: 2
    prompt: |
      Write a short blog post about {{item}}: a title and three paragraphs.
    uses: [item]
    out:
      title: text
      body: text

  - id: pick
    kind: screen
    name: Pick a draft
    review: pick_one
    show: draft.body
    actions:
      - { id: lock, needs: [selection], locks: true }
      - { id: retry, needs: [note] }

edges:
  - { from: draft, to: pick }
  - { from: pick, to: draft, when: "action == 'retry'", max_loops: 3 }
  - { from: pick, to: END, when: "action == 'lock'" }
```

What each part does:

- **`inputs`** are what a run starts with: `kriya run post --input item=…`. It's called `item` because in step 4 the same recipe runs once per topic, and a for-each hands each one over as `item`.
- **`draft`** is a `model` step. `capability: llm.write` sends it to a writing model; `options: 2` makes two candidates. `uses` lists what it reads, and `{{item}}` puts it in the prompt. `out` declares what it must return: here a title and a body, both text. A real model answers to exactly these fields.
- **`pick`** is a `screen`: it stops for you. `show` is what you see, one `draft.body` per candidate. Each action is a button; `needs` says what pressing it takes (`selection`: which candidate, `note`: words). `locks: true` makes the button lock your pick as the draft's output.
- **`edges`** are the arrows. `when` reads what was pressed. An arrow that goes back closes a loop, and every loop needs `max_loops`: here you can ask for new drafts at most 3 times.

Run it:

```text
$ kriya run post --input item="why chai tastes better in a clay cup"
✓ Started post-1 (post)
  running · 1 waiting on you
$ kriya inbox
 1  post-1 · pick: Pick a draft
      1.1  body (fake) for draft
      1.2  body (fake) for draft
      buttons: lock (--pick) 🔒 · retry (--note)
$ kriya decide 1 retry --note "shorter, and funnier"
$ kriya decide 1 lock --pick 2.1
✓ lock on pick
  completed
```

Versions are numbered *attempt.candidate*: 1.1 and 1.2 were the first two drafts, and 2.1 and 2.2 the two after your note. `kriya log post-1` tells the whole story:

```text
  23:16  pick  You pressed retry · note: "shorter, and funnier"
  23:16  draft  Attempt 2 started
  23:16  draft  Made 2.1 · asked: "shorter, and funnier"
  …
  23:16  pick  You pressed lock on 2.1
  23:16  draft  Locked 2.1 by you
```

`kriya web` shows the same run as a graph, with each step's versions and what happened.

## 2. A judge, so you only see the good ones

Add a `check` to the draft, and let the pick screen trust it:

```yaml
  - id: draft
    # … as before …
    check:
      rubric:
        - Three paragraphs, each under 80 words.
        - No made-up statistics.

  - id: pick
    # … as before …
    trust: when_confident   # a draft that passed its checks locks itself; otherwise it asks you
```

Every candidate is now judged against the rubric before you see it (with `models: anthropic`, by Claude, which reads the text against what the step was asked). `kriya inbox` shows each verdict and a suggested button. With `trust: when_confident`, a candidate that passed locks itself, and one that failed gets the fix the knowledge base suggests (edit, crop or retry), for up to 3 rounds before it asks you. Every automatic press is recorded as `by: auto`, so `kriya log` says "Pressed automatically" rather than "You pressed".

When the same issue keeps failing the same step, `kriya tips` offers words to add to its prompt ([cli.md](cli.md)).

## 3. A step that only sees what you locked

```yaml
  - id: polish
    kind: model
    name: Polish it
    capability: llm.write
    prompt: |
      Tighten this post. Keep its voice. Title: {{draft.title}}
      {{draft.body}}
    uses: [draft.title, draft.body]
    out:
      final: text

edges:
  # … the first two as before …
  - { from: pick, to: polish, when: "action == 'lock'" }
  - { from: polish, to: END }
```

`{{draft.body}}` is the **locked** draft: the one you picked, never a rejected candidate. If you later lock a different draft, `polish` goes **stale** (`kriya status` says why), and `kriya rebuild` redoes it and nothing else.

`polish` is the last step and has no screen of its own, so kriya asks you to approve its result ("Approve 'Polish it'"). Add `trust: always` to a step to skip that.

Changing a recipe a run already used is fine: the steps whose settings changed go stale, and the run waits for `kriya rebuild` (or `kriya keep`, to keep what you have).

## 4. Once per topic

A second recipe runs the first for each topic, `recipes/batch.yaml`:

```yaml
graph: batch
level: batch
inputs:
  topics: list<text>
nodes:
  - id: posts
    kind: map
    name: Write each post
    over: inputs.topics
    graph: post
edges:
  - { from: posts, to: END }
```

```text
$ kriya run batch --input 'topics=["clay-cups","monsoon-chai"]'
  running · 2 waiting on you
$ kriya inbox
 1  batch-1 · posts[clay-cups].polish: Approve 'Polish it'
 2  batch-1 · posts[monsoon-chai].polish: Approve 'Polish it'
```

Each value becomes an item, `posts[clay-cups]`, with its own drafts, locks and loop counts, and reaches the `post` recipe as `item`. That's its only input: had `post` asked for `topic`, kriya would refuse before running:

```text
✗ recipes/batch.yaml:10:12  batch › nodes[0].graph
    'post' runs once per item, so its one input is item, but it also asks for 'topic', which a for-each can't give it. In post, rename the input to item and read {{item}}
```

Values in a plain list are also the items' names, so they use letters, digits, `-` and `_` (`clay-cups`, not `clay cups`; kriya says so if not). For richer items, make a list of records with an `id` field, like the Mohalla Mitra shot list does, and read their fields as `{{item.title}}`.

## When it's wrong

kriya checks recipes before anything runs (`kriya status` is enough), and says what's wrong, where, and the nearest valid name:

```text
✗ recipes/post.yaml:47:24  post › edges[0].to
    'to' points at 'pik', which isn't a node. Did you mean 'pick'?
✗ recipes/post.yaml:47:3  post › edges
    loop draft → pick → draft has no limit; add max_loops to the edge that goes back
```

`pnpm validate:examples` (in the kriya repo) or the same check in your project catches these before a run.

## Renaming a recipe

Runs remember the recipe id they started with. To rename one, change `graph:` and keep the old id in `was:`, so those runs still open and carry on ([D-78](17-decisions.md)):

```yaml
graph: episode
was: [part_recipe]
```

The file name doesn't matter; rename it freely.

## Where next

- More step kinds: `agent` (a model with tools, looping until done), `tool` (crop, compress, assemble a Reel), `subgraph`, `refines` (an edit that makes new versions of another step). See [04-graph-spec](04-graph-spec.md).
- Characters, places and tracks a recipe can name (`{{item.characters@look}}`): the Library, in [cli.md](cli.md).
- Real models: set `models:` in `kriya.yaml` and put keys in `.env` ([cli.md](cli.md)).
- Three full examples: [`examples/mohalla-mitra`](../examples/mohalla-mitra), [`examples/earnings-report`](../examples/earnings-report/README.md) and [`examples/funny-clips`](../examples/funny-clips/README.md) (a video you already have: a for-each inside a for-each, and `attach` to carry the frame into it).

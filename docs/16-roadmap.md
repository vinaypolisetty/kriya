# 16 · Roadmap

## v0.1 — 42 days, 2 hours a day (Tue Oct 13 → Mon Nov 23, 2026)

Goal: a durable engine, two real use cases, a review inbox, and a repo that's easy to try and understand. The printable version is *Orchestrator-v0.1-42-Day-Plan.pdf*.

Rules: tick a day when its "done when" is met, not when time runs out. Days 14 and 28 are buffers. If a day overruns, carry it forward and drop the lowest task of the week, never the week's finish line.

### Week 1 · Engine foundations (Oct 13–19)

| Day | Date | Focus | Tasks | Done when |
|---|---|---|---|---|
| 1 | Tue Oct 13 | Set up the repo ✅ | Name, license, pnpm monorepo, CI | A test passes in CI |
| 2 | Wed Oct 14 | Graph spec ✅ | Zod schemas: graph, node kinds, edges, typed fields | A sample graph validates |
| 3 | Thu Oct 15 | Mohalla Mitra recipes in YAML ✅ | Part/shot/voice recipes; loader with readable errors | Recipes load; broken ones give readable errors |
| 4 | Fri Oct 16 | Storage ✅ | SQLite (`better-sqlite3`): append-only events; content-addressed blob store. Other tables added when first needed | Write and read a blob by hash |
| 5 | Sat Oct 17 | Event log ✅ | Append-only events; rebuild state by replay; agent events included (D-26) | Replay == live state, at every event (a crash after any event loses nothing) |
| 6 | Sun Oct 18 | Scheduler ✅ | Ready queue with fake executors; condition evaluator wired to edges; joins | A branch and a capped loop pass |
| 7 | Mon Oct 19 | For-each and join ✅ | Map fan-out with stable keys; per-item loops; map outputs as ordered lists (D-41); wait-for-all joins; [weekly notes](notes/week-01.md). Map-to-map links by key: when a recipe first needs one | Part graph runs end to end with fakes |

(Days 1–3 were completed together on Oct 13.)

### Week 2 · Versions, locks and durable waits (Oct 20–26)

| Day | Date | Focus | Done when |
|---|---|---|---|
| 8 | Tue Oct 20 | Version tree ✅: candidates, parents, lock; locking buttons and generated approvals (D-42); `result` for routing on drafts (D-43); only locked outputs enter context | Lock/context tests pass |
| 9 | Wed Oct 21 | Branches ✅: create, switch, park; `replay_change`; `refines` so edits and redos become new versions of the same step (D-44); screens can wait for an answer. Adopt moved to Day 14 | Branch tests pass; one instruction replayed onto two items; the pick screen shows the edited panel |
| 10 | Thu Oct 22 | Cache keys and stale ✅ (spec + inputs + refs + item; per-input hashes, D-45); rebuild reuses unchanged items | Changing one shot marks only its work stale |
| 11 | Fri Oct 23 | Durable waits ✅: tickets (`deliver`); atomic steps; idempotency keys; `recover()`; crash at every write (D-46) | Resume makes no duplicate calls |
| 12 | Sat Oct 24 | Context and assets ✅: inheritance (`inherits`), full/local/isolated, facets with versions, blocking on missing facets, @mentions, removed defaults, overrides (D-47); reference validation (B-1, B-2) | Context tests pass |
| 13 | Sun Oct 25 | CLI ✅: `kriya init, run, status, inbox, decide, lock` ([docs/cli.md](cli.md)); plain schema errors (Q-18) | A full fake episode from the terminal |
| 14 | Mon Oct 26 | Buffer + write-up ✅: [deterministic orchestration of non-deterministic models](notes/writeup-determinism.md); `adopt` (two parents, D-49); `kriya adopt`, `kriya rebuild` (Q-20) | Draft saved; adopt tests pass |
| 14a | from slack | **Agent loop** ✅ (D-26, D-50): `AgentExecutor.turn()`, the engine-owned turn loop, a tool registry (only listed tools), `max_turns` and `budget.usd` checked between turns. Fakes only | An agent calls 3 tools and returns a final answer; a crash at any write resumes at the same turn with no repeated calls |
| 14b | from slack | **Agents that wait and remember** ✅ (D-51): `ask_human` as a tool (the screen suspend path), slow tools as tickets, offload + `recall`, `note` (D-39 steps 1–3) | An agent pauses for a person, resumes the next day and finishes |
| 14c | from slack (half day) | **File tools for agents** ✅ (D-52) over the blob store: read, write, list; content-addressed so replay stays exact | An agent writes a draft file and reads it back after a crash |

Days 14a–14c use the four days the plan ran ahead by Day 13. They make kriya run agents and tools, not only fixed workflows.

### Week 3 · Real models and the Library (Oct 27–Nov 2)

| Day | Date | Focus | Done when |
|---|---|---|---|
| 15 | Tue Oct 27 | Capability interface + Anthropic adapter ✅ (D-53, D-54): **tool use first**, then write and vision; log model version and cost; agent context use drives clearing (D-39 step 2). Real run on Oct 23: Part 3 shot list (13 shots, 18 lines, $0.13) and a 4-turn caption agent with file tools ($0.02); follow-ups in D-55 | A real Claude agent runs a real tool through kriya; a real shot list from a real story |
| 16 | Wed Oct 28 | Replicate images ✅ (D-56, D-57): Nano Banana generate/edit; polling resume with a job ledger; looks with words; prompts recorded. Real run Oct 24: P3-04, three on-model panels for $0.20. `adopt` and `replay_change` on slow jobs (Q-22) still open | Three real candidates for one shot |
| 17 | Thu Oct 29 | Replicate clips, voice, music ✅ (D-58): Wan 2.7 i2v, Gemini 3.1 Flash TTS, Lyria 2; one job ledger (idempotency keys) for every capability; lengths measured from the bytes. Real run Oct 24: P3-04 as a 5.04 s clip ($0.50 at 720p) and Mitra's L06 line, 7.52 s ($0.008); Gemini refused the "speak faster" retake while the speed instruction led the style (E005, fixed by D-60) | One clip and one voice line |
| 18 | Fri Oct 30 | Library ✅ (D-61): `library/` with one file per entity, kinds, every facet version kept (files too), `kriya library`; P3's cast and places imported. Facets picked by step kind, pinning an old version, and the music kit still open (Q-25); voice cast set from `cast/characters.md` | @Mitra resolves to look and voice |
| 19 | Sat Oct 31 | Tools ✅ (D-62): crop (screen region), compress (`max_mb`), `assemble_reel` (the Part 3 assembler made general, Python worker); tool steps take `uses`; tools run as jobs. Real run Oct 25: the real Tanker Raja Part 3 (15 shots, 4 clips, 19 lines, 4 music cues) assembled through kriya in 2.5 min, 114.9 s and 24 MB vs the hand-run 114.0 s and 26 MB | Assembly runs from the engine |
| 20 | Sun Nov 1 | Checkers ✅ (D-63): `check:` with a rubric (a Claude judge per candidate) and limits on numbers; verdicts on versions, shown on screens; `when_confident` locks a passing candidate; `verdict.pass` in conditions; `kriya check`. Real run Oct 25: the three Day 16 wrong-cast panels all caught with specific issues and fixes ($0.07), after adding "every listed character appears and looks right" to the rubric | A bad panel is caught |
| 21 | Mon Nov 2 | Fix loop ✅ (D-64): a fix policy from verdicts (crop < edit < retry), KB rules seeded from the failure table, the judge's fix when no rule matches; `trust: when_confident` screens press it themselves (`by: auto`); suggestions in the inbox. Real run Oct 25: P3-08 (four characters) drawn, all three judged (SFX lettering), the closest edited with the rule's words, re-judged, locked: no human, $0.33. A tool-using fix agent is still open (Q-26) | One real shot, start to lock, via CLI |

### Week 4 · Review inbox (Nov 3–9)

| Day | Date | Focus | Done when |
|---|---|---|---|
| 22 | Tue Nov 3 | Web scaffold ✅ (D-65): `kriya web` (node:http API over the same project and store as the CLI, media, SSE from the event log) + `packages/web` (Vite + React). Real run Oct 25: P3's three waiting items, with verdicts and suggestions, live | Inbox lists waiting decisions |
| 23 | Wed Nov 4 | Pick-one screen ✅ (D-66): candidates with their issues, the screen's own buttons (enabled by what they need), "Use suggestion"; the note feeds an edit's prompt and now a retry's too; your answer is recorded before anything else runs. Real run Oct 25: P3-01 locked from Chrome with a why, `by: human` | Lock a panel from the browser |
| 24 | Thu Nov 5 | Run graph ✅ (pulled forward from Day 25, D-67): home is the run as its recipe's live graph in the mocks' look; step panel with versions, verdicts and locks; for-each strips you click into; the inbox and review screen restyled | A whole Part at a glance |
| 25 | Fri Nov 6 | Region tool ✅ (drag on the preview; for a crop or to narrow an edit, in words), `beside` values on screens (the line and caption next to the player), cost on buttons from what the step cost in this run. The real crop-and-approve check is the creator's | Crop and approve a line in the UI |
| 26 | Sat Nov 7 | Version tree panel ✅ (D-71): versions grouped by branch with their parents, Branch off from any version, Switch here; the review shows the branch you're on and says so. Read-only Library page (entities by kind, sheets, facet versions and history, what each needs). Checked Oct 26 in Chrome: branched off a panel, the review showed only it, switched back to main | Switch branches from the UI |
| 27 | Sun Nov 8 | Phone layout; batch review; LAN access with a pairing token ✅ (D-38, D-68), pulled forward: `kriya web --lan` with a QR code; the mocks' review screen; a batch steps through every shot's pick. Checked Oct 25 in Chrome over the LAN address (unpaired → paired → three shots locked in a row); the creator reviewed real Part 3 from the phone Oct 26. Oct 26: the rest of the app on a phone: the run graph becomes a step list in run order, each step saying where it goes next ("↺ retry: Draw the shot (up to 4×)"); a step opens as a full-screen sheet; the header and runs list go compact. Checked at 390 px wide | Review a batch on a phone over home wifi |
| 28 | Mon Nov 9 | Buffer + write-up ✅: [locks and stale work](notes/writeup-locks-stale.md) (locks, per-input hashes, re-lock restores, the real stale shot list from Oct 26, what's still only designed) | Draft saved |

### Week 5 · Two real use cases (Nov 10–16)

| Day | Date | Focus | Done when |
|---|---|---|---|
| 29 | Tue Nov 10 | Inspector Tiwari sheet + voice via the platform; start Part 3 ✅ (Oct 25–26): Tiwari in the Library (sheet, Rasalgethi voice, speech); the real Part 3 started from the phone | Tiwari locked in the Library |
| 30 | Wed Nov 11 | Part 3 shots and panels ✅ (Oct 26): all 13 panels locked. Six throttled shots retried through `kriya web`; picks by eye against the judge (P3-06's sign lettering, which the judge missed, edited out with a marked area). Bugs fixed rather than logged (D-72) | All panels locked |
| 31 | Thu Nov 12 | Part 3 clips and voices ✅ (Oct 26): 4 clips and 19 lines locked. Worst bugs fixed (D-72): faster takes flipping stale ↔ fresh; a join that never fired, so the run ended "failed"; no way to keep a stale shot list after a recipe change (`kriya keep`); clip approvals showing JSON | All media locked |
| 32 | Fri Nov 13 | Assemble, watch, fix, re-render; post. Oct 26: assembled through kriya (106.1 s, 1080×1920, −19 dB mean); the end card's title ran over a six-line hook, fixed in the assembler and checked on a re-render. Watching, approving and posting are the creator's | Part 3 live on Instagram |
| 33 | Sat Nov 14 | Second use case: earnings report recipe (text-only) ✅ (D-73): `examples/earnings-report` (summarize from the release only, judged; score against the desk's thesis; write; read; rank the quarter). The engine gaps it found, fixed: a judge for written work, for-each over the run's inputs, examples with their own settings. Real run Oct 27 on two fictional filings with Claude, $0.24: the judge failed a summary that computed numbers the release never states; the fix loop redid it; both reports and the ranking came out grounded. The report step then got the same number rule | Recipe validates and starts |
| 34 | Sun Nov 15 | Run on two companies; fix gaps ✅ (D-74). The gap was getting the releases: `llm.research` steps (Claude with web search and web fetch), a for-each over plain names and over another for-each's results, and yes/no checks (`found: { is: true }`) so a find that couldn't read the release comes to a person instead of flowing on. Real run Oct 27, `tickers=["NFLX","KO"]`, $1.79 in all: both Q3 2026 releases found on SEC EDGAR (Coca-Cola's published that day); the judge failed two Netflix summaries for subtle misreadings (guidance "kept" when the release says updated; growth "slowed each quarter" against its own table) and the fix loop redid them; two reports and a ranking, Coca-Cola first. An earlier run had found nothing for Coca-Cola and still written a report about it: that's what the yes/no check fixes | Two finished reports |
| 35 | Mon Nov 16 | Knowledge base: Part 3 failures → rules; tips in CLI/inbox ✅ (D-76). Rules gained `prevent` words; failed checks are counted per step across runs, and 3 on one step make a tip (`kriya tips`, the terminal inbox, the browser inbox), unless the prompt already says it. Apply puts the words into that step's every new prompt; nothing locked goes stale. Checked Oct 27 on the real Part 3 project: of its 57 issues, `kriya tips` offers two for `shot_recipe.draw` (wrong looks ×19, missing characters ×9); the three others were already in its prompt. Applying one and drawing again (Replicate stand-in) put the words in all three prompts | A new tip appears and applies |

### Week 6 · Ship v0.1 (Nov 17–23)

| Day | Date | Focus | Done when |
|---|---|---|---|
| 36 | Tue Nov 17 | README: demo GIF, posted Reel, 3-command quickstart ✅ (Oct 27, except the posted Reel's link). The README leads with what kriya does, a GIF of the real Part 3 project in `kriya web`, and three commands that work from a fresh clone (checked: clone → install, with the web app built on install, → init → run → web). Making the GIF showed the graph didn't say what happened ("redo ×3" read as three redos; a review just said "done"), so: `kriya log` and each step's **What happened** (the event log in plain words), loops that say "up to 3×" or "1 of 3", reviews that say what was pressed and by whom, boxes you can drag like cards on a board. Also fixed: a locked step showing an old failure; a finished run whose recipe gained a step ending "failed" | A stranger understands it in a minute |
| 37 | Wed Nov 18 | Docs: architecture, spec reference, writing recipes, adding adapters ✅ (Oct 27). New: [writing-recipes.md](writing-recipes.md), a recipe built from nothing in four steps, every snippet and message run as written. Architecture (with adding adapters) and the spec reference existed; brought up to date, and the VS Code guide no longer says to unzip a zip. Writing the guide found a silent hole: a for-each's recipe asking for any input but `item` got nothing. The validator now refuses it, with the fix | docs/ complete |
| 38 | Thu Nov 19 | Fresh-machine test, docker compose, fake-model example (no keys) | Clone-to-running < 10 min |
| 39 | Fri Nov 20 | Coverage + CI badge; roadmap issues; good-first-issue labels | Issues board public |
| 40 | Sat Nov 21 | 3-minute demo video | Video linked from README |
| 41 | Sun Nov 22 | Tag v0.1; publish posts; share | v0.1 released |
| 42 | Mon Nov 23 | Resume/LinkedIn; three interview stories | Stories ready; v0.2 planned |

### Found making genie Part 2 (Oct 28)

The real run of *The Genie of the Old Well*, Part 2, turned up these. Done ones are kept for the record; the rest go into the days above when there's room, before the polish.

| # | What | Why | Done when |
|---|---|---|---|
| G-1 | **Try again with a change** ✅ (D-79): a failed step tries again with a note and without the inputs you leave out, from `kriya retry` or the step's panel | Gemini refused a voice line three times running; plain retry (D-59) can't change the input | A refused line goes through after leaving out its emotion |
| G-2 | **A failed refining step hands its target back done** ✅. `too_long` (refines `speak`) was refused and left `speak` "running"; every restart asked Replicate for a line nobody wanted, and the run stopped replaying | Found when genie-2 crashed `kriya web`. Repaired by appending events; nothing deleted but three rows, backed up | Test: a refused refiner, then a restart, makes no new job |
| G-3 | **Refining steps' other failures.** Audit `edit` and `crop` (and `adopt`, `replay_change`) for the same hole as G-2: failing while blocked, failing the judge, a refused ticket, a crash mid-attempt | G-2 was the first refiner to fail for real; the others share the code path and have no failure tests | One test per refiner per failure kind |
| G-4 | **Looking never spends.** `kriya status`, `show`, `log` and `library` open runs read-only; only `run`, `decide`, `retry`, `rebuild` and a new `kriya resume <run>` drive. Today every command `recover()`s first (D-48), so a status check ran a queued retry | Checking on a run must be safe at any time, mid-repair most of all | `kriya status` on a run with a ready step records nothing |
| G-5 | **Change a line's words from the browser** (D-35's item edit, v0.1 slice): edit one item of a locked list (a shot's action, a line's Hinglish) as a recorded change; that item's work goes stale, the others keep theirs | Twice the creator typed a rewritten line into the retry note, which only changes *how* it's said. The note box now says so, but the real need is editing the words | A line edited in the browser re-voices only that line |
| G-6 | **One writer per run in `kriya web`.** Each button opens a new Scheduler while an earlier one may still be settling jobs for the same run; the Recorder doesn't check it's at the log's head. Not the cause of G-2, but nothing stops it | Two writers with different views of a run would corrupt its log | The Recorder refuses to append behind the log; the server reuses one live Scheduler per run |
| G-7 | **Episode recipe asks for 4 to 6 animated shots**, not exactly 4 | The model dropped the script's biggest moment (P2-06) to keep the count at 4 | Recipe change in the Mohalla Mitra project |
| G-8 | **Lalit gets a character sheet** | The only main character described in words alone; P2-08's retry lost his shirt and mustache | `library/lalit.yaml` has `look.image` |
| G-9 | **A tool's settings are checked like a recipe's.** Each local tool declares its args as a strict Zod schema; `validate` refuses an unknown one and names the nearest | The recipe said `fit: whole`; master's assembler didn't know it and silently cropped every panel of Part 2 and burned captions in | A recipe with `fti: whole` fails validation with "did you mean fit?" |
| G-10 | **Land the Reel settings** (a decision, with the PR): `fit: pan\|whole`, `background: blur\|black`, `captions`, with tests. They sit uncommitted in the working tree; PR #43 (`fit` only) was closed unmerged | Part 1 was built from a side checkout that had them, Part 2 from master that didn't | Merged, and Parts 1 and 2 rebuild the same from master |
| G-11 | **Local tools are pinned too** (rule 6): the assemble event records a hash of the tool's code and worker, shown by `kriya show` | The same recipe built different Reels depending on which checkout `kriya web` ran from, and whether it had restarted since the code changed. Finding out which code made a cut took reading old session logs | `kriya show <run> assemble` prints the tool version |
| G-12 | **Files a step reads are stored by content.** `music/*.mp3` (and any path arg) goes into the blob store when read, and the event records the hash | Swapping music files under the same names changed the Reel and kriya couldn't tell; rebuilding genie-1 today would use whatever `music/` holds now | Replacing a track marks the Reels that used it stale |
| G-13 | **Music per story**, overriding the series' tracks (through `inherits`, or music as a Library kind, Q-25c) | The Genie's own cues reached both Reels only by copying them over the series files for one rebuild and copying back, twice | The Genie story sets its tracks; Tanker Raja keeps its own |
| G-14 | **Cut a shot from the review screen**: a recorded decision on the run ("leave out P2-12"), not a recipe edit. Today's `leave_out: [P2-12]` in `episode.yaml` is a stopgap that applies to every episode | Shot 12 repeated Shot 6's "meri ek ichha" beat; dropping it after review meant changing the recipe. Fix also insists on a note even when the change isn't one | Cut on the review screen; the next cut leaves the shot out and the event says who cut it |
| G-15 | **One aspect ratio per series**, read by both `draw` and `assemble` | Panels were drawn 16:9 for a 9:16 Reel, so the assembler had to crop or letterbox | Changing it in `kriya.yaml` changes both |
| G-16 | **A story checker on the shot list** flags a repeated line or beat before any image is drawn | Shot 12 got an image, a clip and three voices before it was cut as redundant | Part 2's shot list gets a note on P2-12 |

G-9 to G-12 and G-14 are kriya code; G-10 and G-9 first, since one stops the other's failure from happening silently. G-13, G-15 and G-16 need a decision each.

G-7 and G-8 are project changes in `~/Orchestrator/projects/mohalla-mitra`, not kriya code; they're here so Part 3 doesn't repeat them.

## Pace after v0.1

v0.1 ran at about the full-time estimate's pace (Day 35's work landed Oct 27, three weeks early), so the full-time table below is the part-time plan. Dates assume v0.1 ships Nov 23; move them up by however far ahead it ships.

| Release | Weeks | Dates |
|---|---|---|
| v0.2 Builder | 6 | Nov 24 → Jan 4 |
| v0.3 Smart authoring | 5 | Jan 5 → Feb 8 |
| v0.4 Others can use it | 6 | Feb 9 → Mar 22 |

Same rules as v0.1: tick a week when its "done when" is met; if one overruns, drop the lowest task, never the release's finish line.

## v0.2 — Builder (Nov 24 → Jan 4)

Goal: build and change recipes in the browser, and let agents write and run their own tools safely. Graph operations come first: the editor here and the assistant in v0.3 both stand on them (D-17).

| Wk | Dates | Focus | Done when |
|---|---|---|---|
| 1 | Nov 24–30 | **Graph operations** in the engine: pure functions (`add_node`, `remove_node`, `move_node`, `connect`, `set_config`, `set_condition`, `wrap_in_map`, `add_field`, `add_button`) from a graph to the next graph plus problems; undo and redo. **Writing recipes back** with the `yaml` Document API, keeping comments and order (D-33) | Every op round-trips on the Mohalla Mitra and earnings-report recipes; the file diff is only the change |
| 2 | Dec 1–7 | **Sandbox runner on Deno** (D-77): permissions limit network to an allowlist, no env, one work folder. Runs are jobs (D-53, D-62); results are recorded, never re-run on replay. **Secrets broker**: a local proxy adds keys, so agent code never sees them (D-32) | An agent writes a tool, runs it, and a crash-resume replays its result without running it again |
| 3 | Dec 8–14 | **Agent-written tools become trusted tools.** `run_code` as a built-in agent tool over the workspace (D-52). Promotion is a screen: the code, its tests and its permissions; Approve writes it to `tools/` | One tool goes from sandbox to trusted through the inbox |
| 4 | Dec 15–21 | **Build mode in the browser**: recipe view, step cards, settings forms generated from the node schemas, UI-action settings (buttons → where they go), validation as you edit | A Part recipe edited in the browser gives a clean YAML diff |
| 5 | Dec 22–28 | **Drag and drop** (dnd-kit): palette into a slot, reorder, into a for-each; a non-drag alternative for each. **Conditions as sentences with pickers** (D-36); no assistant conversion yet | earnings-report built from scratch in the browser |
| 6 | Dec 29–Jan 4 | **Click-through test** (fake models, $0), **publish**, **run upgrades** (a run moves to a new release; only changed work goes stale, D-45). Tag v0.2 | A run in progress upgrades and only the affected shots go stale |

Run upgrades are the riskiest week: today a release is a hash pinned at the start of a run, with no way to move. If anything slips, cut click-through polish, not upgrades. The canvas, the assistant and custom blocks wait for v0.3.

## v0.3 — Smart authoring (Jan 5 → Feb 8)

Goal: say what you want and get a correct change to the recipe; see branching flows as a canvas.

| Wk | Dates | Focus | Done when |
|---|---|---|---|
| 1 | Jan 5–11 | **Eval set first**: ~40 "request → expected change" cases from real Mohalla Mitra and earnings edits, scored on validating and changing the right parts of the graph | Harness runs; a baseline score is recorded |
| 2 | Jan 12–18 | **Builder assistant**: a Claude agent whose only write tools are the graph operations; reads the graph, catalog, Library and run history. Proposes a change set shown in the recipe; Apply / Change / Discard is one undo step | ≥ 80% on the eval set |
| 3 | Jan 19–25 | **The assistant inside the forms**: typed conditions converted to pickers (D-36), inferred output fields (D-37), fixes offered for validation errors, "Describe it" as a starting point | A typed condition comes back as pickers and saves as the condition language |
| 4 | Jan 26–Feb 1 | **Canvas view** (`@xyflow/react`) editing through the same operations; each button its own arrow, loops dashed with their limit. The run view keeps its own graph, tuned for phones | A branch wired on the canvas shows up in the recipe view |
| 5 | Feb 2–8 | **Knowledge-base tips in the builder** (D-76) on the step cards they're for; **branch/adopt UI**; **custom blocks** (save a subgraph, insert it anywhere). Tag v0.3 | A tip shows on a card and applies in one click |

Custom blocks are the first cut if week 5 overruns.

## v0.4 — Others can use it (Feb 9 → Mar 22)

Goal: an invite-only hosted beta for about ten creators, not open sign-up. (Proposed; not yet a decision.)

| Wk | Dates | Focus |
|---|---|---|
| 1 | Feb 9–15 | **Hosting**: one machine per workspace with its own SQLite and blobs on a volume, so the engine barely changes; hosted-grade sandboxing (Firecracker / gVisor) |
| 2 | Feb 16–22 | **Accounts** and **guided key setup**: creators' own keys (D-9), encrypted at rest, used through the secrets broker; a spend cap per workspace |
| 3 | Feb 23–Mar 1 | **Templates and forks**: a template is a recipe folder, a fork is a copy (D-33). Motion comic, Earnings report, Faceless explainer |
| 4 | Mar 2–8 | **Onboarding**: pick a template → click-through with fake models, no keys → add a key → a first real run under $1 |
| 5 | Mar 9–15 | **PWA and push** (D-38); phone polish |
| 6 | Mar 16–22 | Security pass on code execution and keys; invite the beta; tag v0.4 |

## Later

- **Docker sandbox** (D-77): when an agent-written tool needs native programs (Python, ffmpeg) that Deno can't give it.

## Full-time estimate (for reference)

| Phase | Full-time | Cumulative |
|---|---|---|
| Engine core | 2–3 weeks | ~3 weeks |
| Personal MVP (Part 3 end to end, YAML recipes) | 3–4 weeks | ~6–7 weeks |
| Builder v1 | 5–7 weeks | ~3 months |
| Smart authoring | 4–6 weeks | ~4–4.5 months |
| Usable by others | 4–6 weeks | ~5–6 months |

Riskiest parts: run upgrades and stale tracking (test thoroughly, early); condition UX for non-technical users; builder-assistant reliability (needs an eval set); generalizing assembly beyond Reels.

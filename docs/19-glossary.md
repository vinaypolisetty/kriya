# 19 · Glossary

| Term | Meaning |
|---|---|
| **Adopt** | Create a version that borrows from another version or branch (two parents) |
| **Agent** | A node where a model decides the next step, within listed tools and a budget |
| **Asset** | A Library entity (character, place, style, music kit, rules) |
| **Barrier** | A join that waits for all items of a stage, optionally with human sign-off |
| **Branch** | A user-created alternate path in a node, with its own conversation; parked when another is locked |
| **Builder assistant** | Chat that proposes graph operations in Build mode; can only do what clicks can |
| **Bundle** | A set of graphs that refer to each other |
| **Cache key** | Hash of spec, inputs, facet versions, prompt template and model version; decides reuse vs stale |
| **Candidate** | One of N automatic outputs per attempt (`options: 3`) |
| **Capability** | What a model step does (`image.generate`), independent of provider |
| **Checker** | Code, LLM or human judge that records a verdict |
| **Condition** | A rule on an edge (`action == 'redo'`) that reads only recorded data |
| **Context** | What a node sees: locked upstream outputs, inherited locks, facets, mentions |
| **Context mode** | Full, local or isolated |
| **Event log** | Append-only record of everything the engine did; source of truth for state |
| **Facet** | One aspect of an asset used by certain node kinds (look, voice, speech, rules) |
| **Fix** | retry, regenerate with patch, edit, transform, swap provider, decompose, escalate, waive |
| **Graph / recipe** | A workflow definition: nodes and edges at one level |
| **Knowledge base (KB)** | Failure → fix rules that prevent, detect and repair |
| **Level** | A creator-defined scope (series, story, part, shot) that runs a graph |
| **Library** | The project's assets and their facet versions |
| **Lock** | Marks one version as a node's output; only locked work flows downstream |
| **Manual mode** | The creator runs a model outside and uploads the result; the step resumes |
| **Map** | A node that runs a graph once per item, keyed by stable item ids |
| **Micro-agent** | The conversational agent scoped to one node |
| **Node** | One step in a graph |
| **Override** | A change to an asset at a lower level (episode) that doesn't change the project version |
| **Plan** | What a higher-level agent proposes before acting: affected nodes, cost |
| **Release** | Immutable, hashed set of published graph versions; runs pin one |
| **Run** | One execution of a graph at a level |
| **Screen / UI action** | A node where a human decides on a generated screen; buttons are outgoing edges |
| **Stale** | Work whose inputs changed after an upstream lock moved; out of context until rebuilt |
| **Stable id** | Permanent id for nodes, fields and conditions so renames break nothing |
| **Suspend / ticket** | How a step waits for a model job, a human or a timer without blocking |
| **Trust** | Per-step autonomy: ask me · decide when confident · always decide |
| **Verdict** | A checker's structured result: pass, issues, suggested fixes |
| **Version** | Any output in a node's version tree |
| **Waive** | Accept with a known flaw, recorded with a reason |

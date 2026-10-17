# 08 · Persistence

Authoring is saved as **versioned definitions**, kept separate from run state and media.

## Stores

| Store | Holds | Changes how | v0.1 → later |
|---|---|---|---|
| **Definitions** | Levels, graphs (nodes + edges), asset kinds, knowledge-base rules | **Files in a recipe folder are canonical** (git-friendly YAML/JSON); publish snapshots the folder into an immutable, hashed release ([D-33](17-decisions.md)) | Recipe folder + release snapshots in SQLite → Postgres (JSON columns) |
| **Run state** | Event log per run: versions, branches, locks, decisions, stale marks | Append-only | Same DB, `events` table |
| **Media** | Images, clips, audio, sheets, Reels | Write-once, content-addressed by hash | Local folder → S3/R2 |
| **Secrets** | Creators' API keys | Encrypted | `.env` (v0.1) → KMS/Vault envelope encryption |

## Each graph version is one JSON document

Stored whole (nodes + edges together), not as rows in node and edge tables: atomic to save, easy to hash for releases, easy to diff by stable id. Index tables are derived for queries like "which graphs use `@Bheem · look`?"

Example node as stored by the builder:

```json
{
  "id": "step_7f3a",
  "name": "Draw each shot",
  "kind": "model",
  "capability": "image.generate",
  "model": "replicate:google/nano-banana@<version>",
  "uses": ["item.description", "item.characters@look", "item.place@look", "series.style"],
  "options": 3,
  "review": { "style": "pick_one", "precheck": "rubric_panel" },
  "on_fail": { "fixes": ["edit", "crop", "retry"], "max": 4, "then": "ask_me" },
  "trust": "ask_me"
}
```

A condition stores both forms:

```json
{ "id": "cond_91e0",
  "said": "If the shot is marked animate, make a clip",
  "rule": { "if": { "field": "item.animate", "op": "==", "value": true }, "then": { "run": "step_c4d2" } } }
```

The engine executes only `rule`. `said` is for display. If they disagree, the builder flags it.

## Four rules

1. **Stable ids, not names.** Steps, fields and conditions get permanent ids. Renaming "Draw each shot" to "Make panels" breaks nothing.
2. **Files are the draft; publish freezes a release.** The recipe folder is the working draft: edited by hand, in git, or by the builder through graph operations (which write the files back, keeping comments and key order). Publishing snapshots every definition into a **release**: a manifest pinning the exact version of each, identified by a hash. Releases live in the database so runs can pin them; the files stay the source of truth.
3. **Runs pin a release.** Editing never changes a running episode. Upgrading compares releases by stable id (see [07](07-versions-branches-locks.md)).
4. **The Library is versioned separately from recipes.** Recipes define *kinds*; the Library holds *things* (Mitra, look v2), each facet with its own versions. Runs record which facet versions they used.

## Tables (sketch)

```
projects             id, owner, name
definitions          id, project_id, kind (level|graph|asset_kind|kb_rule), stable_id
definition_versions  id, definition_id, body (json), hash, parent_id, status (draft|published)
draft_ops            id, definition_id, seq, op (json), author (human|assistant), chat_ref
releases             id, project_id, hash, manifest (definition_version ids), published_at
assets               id, project_id, kind, name, aliases
facet_versions       id, asset_id, facet, value | blob_hash, locked, created_at
runs                 id, release_hash, level, parent_run_id, status
events               run_id, seq, type, payload (json), at        ← append-only
node_instances       run_id, key (e.g. per_shot[P3-04].draw), state, cache_key   ← projection
versions             id, run_id, node_key, parents, blob_hash | value, locked, meta (json) ← projection
blobs                hash, mime, size, storage_uri
kb_rules             id, scope (provider|domain|project), symptom, detect, prevent, repair, hits
secrets              owner_id, provider, encrypted_key      (later; .env in v0.1)
```

`draft_ops` records each builder/assistant operation with the chat that produced it, so "why is this step here?" can be answered later.

## Templates and export

- A **template** is a published release copied into a new project with its origin recorded, so a fork can be told "the original has an update".
- **There is no separate export.** A recipe folder already is the shareable format; forking is `git clone`, and recipe changes are reviewed as diffs. Locks, runs, assets and media are run data and stay out of the recipe folder (database + blob store).

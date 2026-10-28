# @kriya/web

kriya in a browser: each run as a live graph of its steps, a step's versions and branches, the inbox, the review screen (phone first), and the Library. It talks only to the API that `kriya web` serves; it holds no run logic of its own.

React 19 and Vite. No router or state library: routes live in the URL hash, and live data comes from `useLive()`.

## Files

| File | What it is |
|---|---|
| [`main.tsx`](src/main.tsx) | Mounts `<App>` |
| [`App.tsx`](src/App.tsx) | Header, routes (`#/run/…`, `#/inbox`, `#/review/…`, `#/library/…`), runs list, inbox |
| [`Graph.tsx`](src/Graph.tsx) | A run's recipe as a graph (desktop) or a step list (phone, `useNarrow`) |
| [`NodePanel.tsx`](src/NodePanel.tsx) | One step: state, why, version tree by branch, Branch off / Switch here, Try again |
| [`Screen.tsx`](src/Screen.tsx) | The review: the big preview, candidates, checks, suggestion, note, marked area, buttons; batches |
| [`Region.tsx`](src/Region.tsx) | Drag on an image to mark an area (`x,y,w,h` fractions) |
| [`Library.tsx`](src/Library.tsx) | The Library, read-only: entities by kind; one entity's facets and history |
| [`api.ts`](src/api.ts) | API types, calls (`decide`, `retry`, `branchOff`, `switchBranch`), and `useLive(path)` |
| [`style.css`](src/style.css) | Colour tokens on `:root` (light and dark), layout, the phone breakpoint at 760 px |

## Develop

```bash
cd your-project && kriya web            # the API, on :4317
pnpm --filter @kriya/web dev            # the app with hot reload; /api is proxied to :4317
pnpm --filter @kriya/web build          # what kriya web serves (packages/web/dist)
```

## Rules for changing it

- New data comes from a route in `cli/src/web.ts`. Add its types and call to `api.ts`, and read it with `useLive` so it updates when any run changes.
- Colours come from the CSS tokens, never hard-coded, so dark mode keeps working.
- Every view works at 390 px wide, with touch targets of at least 40 px. Check the phone layout before calling a UI change done.
- UI words follow the vocabulary: lock, stale, version, branch, Library.

## Tests

The API is tested in `packages/cli/test/web.test.ts`. The UI has no automated tests yet: check changes by eye in a browser, at desktop width and at 390 px.

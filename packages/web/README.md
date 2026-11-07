# @kriya/web

kriya in a browser: each run as a live graph where everything opens in place (a step's versions and branches, a review, a for-each item's own graph), the inbox, and the Library. It talks only to the API that `kriya web` serves; it holds no run logic of its own.

React 19 and Vite. No router or state library: routes live in the URL hash, and live data comes from `useLive()`.

## Files

| File | What it is |
|---|---|
| [`main.tsx`](src/main.tsx) | Mounts `<App>` |
| [`App.tsx`](src/App.tsx) | Header, routes (`#/run/…`, `#/inbox`, `#/review/…`, `#/library/…`), runs list, inbox; **Talk to this run** beside a run's graph (D-95) |
| [`Graph.tsx`](src/Graph.tsx) | A run's recipe as a graph (desktop) or a step list (phone, `useNarrow`). Boxes open in place, and the Inputs box and video steps play their video. On desktop it's a canvas: zoom with pinch, ⌘-scroll, ⌘+/−/0 or the corner buttons; pan by scrolling or dragging empty space |
| [`simple.ts`](src/simple.ts) | The simple view: only the steps a person acts on, with every moment, drawing and page a node on one graph |
| [`NodePanel.tsx`](src/NodePanel.tsx) | One step: state, why, version tree by branch, Branch off / Switch here, Try again; `Talk`, a conversation and its box, for a step's chat and the run's |
| [`Mentions.tsx`](src/Mentions.tsx) | @ in a step's chat (D-96): the text box's list of what to point at, and a message with its refs marked |
| [`Screen.tsx`](src/Screen.tsx) | The review: the big preview, candidates, checks, suggestion, note, marked area, buttons; batches. `embedded` is the one-tap version inside a box on the graph |
| [`Region.tsx`](src/Region.tsx) | Drag on an image to mark an area (`x,y,w,h` fractions) |
| [`Library.tsx`](src/Library.tsx) | The Library, read-only: entities by kind; one entity's facets and history |
| [`Theme.tsx`](src/Theme.tsx) | The Theme picker: Auto (the device's), Light or Dark, kept in this browser |
| [`api.ts`](src/api.ts) | API types, calls (`decide`, `retry`, `branchOff`, `switchBranch`), and `useLive(path)` |
| [`style.css`](src/style.css) | Colour tokens on `:root` (each `light-dark(light, dark)`), layout, the phone breakpoint at 760 px |

## Develop

```bash
cd your-project && kriya web            # the API, on :4317
pnpm --filter @kriya/web dev            # the app with hot reload; /api is proxied to :4317
pnpm --filter @kriya/web build          # what kriya web serves (packages/web/dist)
```

## Rules for changing it

- New data comes from a route in `cli/src/web.ts`. Add its types and call to `api.ts`, and read it with `useLive` so it updates when any run changes.
- Colours come from the CSS tokens, never hard-coded, so both themes keep working. A new colour is a new token with its light and dark values side by side.
- Every view works at 390 px wide, with touch targets of at least 40 px. Check the phone layout before calling a UI change done.
- UI words follow the vocabulary: lock, stale, version, branch, Library.

## Tests

The API is tested in `packages/cli/test/web.test.ts`. The UI has no automated tests yet: check changes by eye in a browser, at desktop width and at 390 px.

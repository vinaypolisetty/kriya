# Earnings report

kriya's second example, and a text-only one: the same engine as the Mohalla Mitra comic, with no images or audio.

For each company that reported, kriya:
1. summarizes the release, using the release only. A judge checks every number against it; a summary that passes locks itself, and one that doesn't comes to you;
2. scores it against the desk's thesis (in `kriya.yaml`);
3. writes a one-page report for you to read, edit or redo.

Then it ranks the quarter for you to approve.

```bash
kriya init q3 --example earnings-report && cd q3
kriya run quarter_review --input quarter="Q3 2026" --input filings=@filings.json
kriya inbox
```

`filings.json` holds two sample releases for **fictional** companies (Acme Tea Co. and Lantern Rail Ltd.). To use real ones, replace it with your own: one entry per company, with `id` (the ticker), `company` and `release` (the release's text).

With `models: fake` (the default) everything runs with made-up text and no cost. For real reports, set `models: { llm: anthropic }` and put `ANTHROPIC_API_KEY` in `.env`.

The thesis, the scoring criteria and the style are the desk's: edit them in `kriya.yaml`. Changing them later makes the scores and reports that read them go stale, with the reason.

This is a research workflow for your own thesis. It describes how a company fits it, and the recipe tells every step never to make a buy, sell or hold call.

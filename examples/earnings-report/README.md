# Earnings report

kriya's second example, and a text-only one: the same engine as the Mohalla Mitra comic, with no images or audio.

For each company, kriya:
1. summarizes its reported results, using those results only. A judge checks every number against them; a summary that passes locks itself, and one that doesn't is redone with the judge's note;
2. scores it against the desk's thesis (in `kriya.yaml`);
3. writes a one-page report for you to read, edit or redo.

Then it ranks the quarter for you to approve.

## Two ways in

**From Polygon, by ticker** (`quarter_review`). The first step fetches each company's latest reported quarter, the same quarter a year earlier, and the balance sheet, with the changes worked out:

```bash
kriya init q3 --example earnings-report && cd q3
# in kriya.yaml:  models: { llm: anthropic, data: polygon }
# in .env:        ANTHROPIC_API_KEY=…  POLYGON_API_KEY=…
kriya run quarter_review --input quarter="Q3 2026" --input tickers='["AAPL","MSFT"]'
kriya inbox
```

Company financials need a Polygon plan that includes them (Stocks Advanced, or the Financials & Ratios add-on). Polygon is now called Massive; to use its new host, set `polygon: { base: https://api.massive.com }`.

**From releases you paste** (`quarter_from_releases`). `filings.json` holds two sample releases for **fictional** companies (Acme Tea Co. and Lantern Rail Ltd.). Replace them with your own, one entry per company with `id` (the ticker), `company` and `release` (the text):

```bash
kriya run quarter_from_releases --input quarter="Q3 2026" --input filings=@filings.json
```

With `models: fake` (the default) both run with made-up data and text, at no cost.

## Notes

The thesis, the scoring criteria and the style belong to the desk: edit them in `kriya.yaml`. If you change them later, the scores and reports that read them go stale, with the reason.

This is a research workflow for your own thesis. It describes how a company fits it, and every step is told never to make a buy, sell or hold call.

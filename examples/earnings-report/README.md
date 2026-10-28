# Earnings report

kriya's second example, and a text-only one: the same engine as the Mohalla Mitra comic, with no images or audio.

For each company, kriya:
1. **finds its latest earnings release on the web.** Claude searches, prefers the company's own investor-relations page, reads it, and copies the results out with the page's address;
2. summarizes it, using the release only. A judge checks every number against it; a summary that passes locks itself, and one that doesn't is redone with the judge's note;
3. scores it against the desk's thesis (in `kriya.yaml`);
4. writes a one-page report, ending with its source, for you to read, edit or redo.

Then it ranks the quarter for you to approve.

## Run it

```bash
kriya init q3 --example earnings-report && cd q3
# in kriya.yaml:  models: { llm: anthropic }      in .env:  ANTHROPIC_API_KEY=…
kriya run quarter_review --input quarter="Q3 2026" --input tickers='["AAPL","MSFT"]'
kriya inbox
```

The review shows each report's source beside it, and `kriya show <run> 'find[AAPL].research'` lists the pages Claude read. A company costs roughly $0.15–0.40: tokens, plus a cent per web search (at most 5 a company; change `max_searches` in `find.yaml`).

**Releases you already have:** `quarter_from_releases` starts from text you paste instead of searching. `filings.json` holds two sample releases for **fictional** companies (Acme Tea Co. and Lantern Rail Ltd.):

```bash
kriya run quarter_from_releases --input quarter="Q3 2026" --input filings=@filings.json
```

With `models: fake` (the default) both run with made-up text, at no cost.

## Notes

The thesis, the scoring criteria and the style belong to the desk: edit them in `kriya.yaml`. If you change them later, the scores and reports that read them go stale, with the reason.

This is a research workflow for your own thesis. It describes how a company fits it, and every step is told never to make a buy, sell or hold call. Check anything that matters against the source.

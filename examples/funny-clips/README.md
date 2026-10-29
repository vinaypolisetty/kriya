# Funny clips

A funny video in, the same video out with a caricature cut in at every funny moment.

kriya:
1. **takes a frame every half second** from the video. Claude can't watch video, but it can look through frames;
2. **finds the funny moments.** Claude lists each one with the second the gag lands, what happened, and everyone in the frame, people and animals, with what they look like and where they stand;
3. **you check the moments.** Approve, or say what's off in a note ("drop m2; the fall is at 16.5; add the dog at 31") and Claude looks again;
4. **writes the joke for each moment.** Claude, as a roast comic, picks who's in it (often not just the one who fell: the friend who laughed, the dog that planned it), how they appear, and a caption of 6 words at most. A judge drops takes that wouldn't make a stranger laugh or that punch at someone's looks; you pick the funniest of three, or ask for another ("meaner", "make it about the phone");
5. **draws each caricature from the real frame**, three to pick from, so they still look like themselves;
6. **cuts them in.** The video plays up to each moment, cuts away for a second and a half, and comes back where it left off.

Claude picks the layout per moment:

| Layout | What you see | Best when |
|---|---|---|
| `group` | one scene with everyone, full screen | they interact: the shove, the chase |
| `one_each` | one caricature after another | it's a reveal: the fall... the friend laughing... the dog, smug |
| `over_frame` | the real frame frozen, each caricature popped over where they stand | the real scene is already funny |

## Run it

```bash
kriya init clips --example funny-clips && cd clips
# put a clip in the project, e.g. clips/fall.mp4 (under a minute)
# in kriya.yaml:  models: { llm: anthropic, image: replicate }
#                 tools: { python: ~/.venv/bin/python, font: fonts/Bold.ttf }   (a Python with Pillow)
# in .env:        ANTHROPIC_API_KEY=…  REPLICATE_API_TOKEN=…
kriya run clip --input video=clips/fall.mp4
kriya inbox          # or kriya web
```

With `models: fake` and `tools: fake` (the defaults) the whole run goes through with made-up moments, at no cost.

The style and the sense of humour are in `kriya.yaml` (`comedy.style`, `comedy.humour`); every joke reads them.

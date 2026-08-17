# Daily Doomsayer
https://visionmorph.github.io/daily-doomsayer/

Daily Doomsayer is an experimental news aggregator that presents current events as a market for human dread. Instead of assigning a financial price to each story, the site uses the **Doom Index** to give it a score from 0 to 100 based on the severity, scale, certainty, and consequences of the reported event. The result resembles a newspaper, financial terminal, and warning system merged into one publication.

## The DREAD model

The Doom Index is calculated by **DREAD**, a versioned scoring model that evaluates story titles, summaries, source coverage, and—when available—article context. Scores correspond to five severity levels: **Uneasy, Ominous, Alarming, Dire,** and **Catastrophic**.

DREAD is tested against guided human ratings so that new versions can be compared with the public model before they are promoted. The model switcher on the website lets readers compare public and experimental interpretations of the same stories.

## Visual concept

Story images are intentionally corrupted with duplicated image layers, displaced fragments, irregular timing, color blending, and a red exclusion overlay. This visual interference makes the page feel unstable and imperfect, reflecting how frightening events are distorted, repeated, and consumed through digital media.

Together, the scoring and visual system make each headline feel as though the website has assigned a live market price to human dread.

## How it works

1. Scheduled GitHub Actions collect stories from publisher RSS feeds.
2. Node.js scripts clean and organize the stories, retrieve available article images and context, and calculate DREAD scores.
3. The generated story data is saved for the static website.
4. Browser-side JavaScript builds the page, applies the selected DREAD model, and renders the animated image corruption.
5. A separate calibration page records guided human ratings used to evaluate future DREAD versions.

## Technology

- HTML, CSS, and vanilla JavaScript
- Node.js
- RSS Parser and HTML entity decoding
- JSON and generated JavaScript data files
- GitHub Actions for scheduled collection, scoring, testing, and evaluation
- GitHub Pages for hosting

Daily Doomsayer does not republish complete articles. Headlines link to their original publishers in a new browser tab.

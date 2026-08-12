# Blind calibration reviews

1. Run **Update calibration benchmark** so `review-queue.js` contains the
   latest sanitized review queue.
2. Open `review-calibration.html`. It uses separate browser storage and never
   loads the previous human ratings or either DREAD model score.
3. Complete the randomized queue and export the ratings.
4. Upload every export as a new file in
   `data/human-calibration/reviews/raw/`. Do not overwrite an earlier review
   export.
5. Run **Update blind calibration review** if the upload did not trigger it
   automatically.

The review workflow compares each blind second judgment with the original
guided judgment. Stable records enter calibration benchmark version 2
automatically. Records that need inspection or adjudication remain excluded
until a decision is added under `reviews/adjudicated/`.

`calibration-benchmark.v2.json` remains marked `draft` until every queued story
has been reviewed and every flagged disagreement has been adjudicated. Synthetic
Dire and Catastrophic scenarios are intentionally kept out of this real-story
benchmark.

An adjudication file uses this shape:

```json
{
  "schemaVersion": "1.0",
  "records": [
    {
      "benchmarkId": "example-benchmark-id",
      "decision": "accept-review",
      "reasoning": "The second judgment better reflects the reported event and excludes background harm.",
      "adjudicatedAt": "2026-08-12T18:00:00.000Z"
    }
  ]
}
```

Valid decisions are `accept-review`, `accept-original`, and `custom`. A custom
decision must also include a whole-number `score` from 0 through 100.

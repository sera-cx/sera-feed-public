# Sera Feed (published output)

Generated feed JSON for the **sera.money** app. The source pipeline lives in a private repository; feed artifacts are published here and must not be edited by hand.

- `latest.json` — current feed (brief + categories + items)
- `YYYY-MM-DD.json` — immutable daily archives
- `schema/feed-v1.schema.json` — public JSON Schema for the additive v1 archival contract
- `INTEGRATION.md` — client contract, compatibility guarantees, and rendering guidance

Production endpoint: `https://sera-cx.github.io/sera-feed-public/latest.json`

Public schema: `https://sera-cx.github.io/sera-feed-public/schema/feed-v1.schema.json`

## Validate a publication

Node.js 18.18 or newer is required.

```bash
npm ci
npm run check
```

`npm run check` runs the validator tests and validates every committed feed artifact. The validator checks:

- draft 2020-12 schema conformance;
- the frozen full v1 profile for `latest.json` and archives dated 2026-06-18 or later;
- unique item/category IDs and priorities;
- category, alert, currency-impact, and derived-outlook consistency;
- safe canonical HTTPS source/image URLs for current artifacts;
- archive filename/date and monotonic `generatedAt` values; and
- exact equality between `latest.json` and the newest dated archive.

For pull-request automation, also compare against the target branch:

```bash
npm run validate -- --changed-since origin/main
npm run validate -- --format json
```

The changed-since check rejects modification, deletion, or renaming of a dated archive that already exists in the base revision. Adding a new archive and updating `latest.json` together is allowed.

## Publication rules

1. Generate and validate a new `YYYY-MM-DD.json` artifact.
2. Copy the exact same JSON value to `latest.json`.
3. Never rewrite an existing dated archive.
4. Run `npm run check` before publishing.

The schema intentionally preserves pre-freeze v1 archives. Stricter current-profile guarantees are enforced by `scripts/validate-feed.mjs`, so historical data remains immutable without weakening new publications.

Content is information, not investment advice.

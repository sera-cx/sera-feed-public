# Sera Feed — Integration Guide

For the **sera.money** app team. Everything needed to build the Feed screen end to end. The endpoint is live now; no backend work is required on your side.

---

## 1. The endpoint

```
GET https://sera-cx.github.io/sera-feed-public/latest.json
```

- **No auth.** No API key, no token, no custom headers.
- **Plain HTTPS GET** returning `application/json; charset=utf-8` (~36 KB).
- **CORS-open** (`access-control-allow-origin: *`) — works from native code or a webview.
- Hosted on GitHub's CDN. It stays up independently of how the content is built.

**Daily archives** (same shape, immutable once written):

```
GET https://sera-cx.github.io/sera-feed-public/2026-06-11.json
```

> **Read the base URL from remote config — do not hard-code it.** We will move the feed to `https://feed.sera.money/latest.json` later; with the host in config that's a flip, not an app release.

---

## 2. When to fetch & how to cache

The feed rebuilds **hourly**. Recommended:

- Fetch on **app launch** and on **pull-to-refresh**. There's no value polling faster than ~hourly.
- The response sends an `ETag` and `cache-control: max-age=600`. Send the last `ETag` back as `If-None-Match` and you get a **`304 Not Modified`** (empty body) when nothing changed — cheap and bandwidth-free.
- Cache the last good payload locally and render it offline; the feed is just as useful a few hours old.

```ts
const res = await fetch(FEED_BASE + "/latest.json",
  lastEtag ? { headers: { "If-None-Match": lastEtag } } : {});

if (res.status === 304) return cachedFeed;     // nothing changed
const feed: Feed = await res.json();
saveCache(feed, res.headers.get("ETag"));
return feed;
```

```swift
var req = URLRequest(url: URL(string: feedBase + "/latest.json")!)
if let etag = lastEtag { req.setValue(etag, forHTTPHeaderField: "If-None-Match") }
let (data, resp) = try await URLSession.shared.data(for: req)
if (resp as? HTTPURLResponse)?.statusCode == 304 { return cachedFeed }
let feed = try JSONDecoder().decode(Feed.self, from: data)
```

**Staleness guard:** if `generatedAt` is older than ~26 hours, show a quiet "feed paused" state rather than presenting day-old news as current.

---

## 3. Response shape

```jsonc
{
  "version": 1,
  "date": "2026-06-11",                 // YYYY-MM-DD
  "generatedAt": "2026-06-11T17:48:02.000Z",  // ISO 8601 — use for staleness check
  "enrichment": "ai",                   // "ai" | "heuristic" | "mixed" (provenance; informational)
  "brief": { /* DailyBrief, see §4 — CAN BE null */ },
  "categories": [ /* Category[], see §5 — render order */ ],
  "items": [ /* FeedItem[], see §6 — pre-ranked, ≤8 per category */ ]
}
```

Render order on screen, top to bottom:

1. **`brief`** → the pinned "Sera's Daily Brief" card (§4).
2. **`categories`** → section headers / tabs, in `priority` order (§5).
3. **`items`** → cards within each category (§6).

---

## 4. `brief` — the pinned card  ⚠️ nullable

`brief` is `null` when there's no fresh brief (e.g. a quiet build). **Hide the card entirely when null.**

```json
{
  "headline": "The ECB blinks first as war inflation goes global",
  "summary": "The European Central Bank raised rates for the first time since 2023 — the first major central bank to move since the US-Iran war sent energy prices surging — and officials are already hinting at another rise in July. The dollar stays firm on safe-haven demand and hot US producer prices...",
  "pairsToWatch": [
    { "pair": "EUR/USD", "note": "Post-hike follow-through, with ECB officials floating another move in July." },
    { "pair": "USD/JPY", "note": "Stuck near 160.50 — BoJ decision Tuesday and intervention risk cap the upside." }
  ],
  "calendar": [
    "UK monthly GDP data due Friday morning",
    "Bank of Japan decision expected Tuesday — a 25bp hike is widely tipped"
  ],
  "spendIdea": "Father's Day is ten days out (21 June) — Esquire's tested gift list plus a rare $15-off Nintendo Switch 2 deal cover dad and the family without blowing the budget.",
  "transferTip": "With the BoJ on Tuesday and the Fed next week, avoid locking in big transfers right around central bank announcements — quieter windows usually price better."
}
```

| Field | Type | Render |
|-------|------|--------|
| `headline` | string (≤70 chars) | Card title |
| `summary` | string (3–5 sentences) | Card body |
| `pairsToWatch` | `{ pair, note }[]` (2–4) | A small list/row of pairs, `note` as subtext. May be `[]`. |
| `calendar` | string[] (0–4) | Bulleted "today" list. May be `[]`. |
| `spendIdea` | string | The casual Life & Money line — give it a distinct, lighter treatment |
| `transferTip` | string | Practical money-movement note — natural spot for a "Send money" CTA |

---

## 5. `categories` — sections (World News first)

Render sections/tabs in **ascending `priority`**. Do not reorder — World News leading is a product decision.

| priority | id | label | emoji |
|----------|----|----|----|
| 1 | `world` | World News | 🌍 |
| 2 | `central-banks` | Central Banks | 🏛️ |
| 3 | `fx-analysis` | FX Analysis | 📈 |
| 4 | `markets` | Market Movers | ⚡ |
| 5 | `life` | Life & Money | 🎁 |

Each object: `{ id, label, priority, emoji, description }`. Use `emoji` as the fallback visual when an item has no image (§6). `description` is one-line section subtext if you want it.

---

## 6. `items` — the cards

Already ranked (category priority → relevance → recency) and capped at 8 per category. Filter by `item.category` to fill each section.

**With image, FX item:**
```json
{
  "id": "b4c0a6bc9398",
  "category": "world",
  "headline": "US threatens further strikes on Iran and seizure of Kharg Island fuel hub",
  "summary": "President Trump warned of a 'very hard' attack on Iran tonight and said the US would take control of the Kharg Island oil hub, as the ceasefire appears close to collapse.",
  "whyItMatters": "Escalation pushes oil higher and money into safe havens, lifting the dollar and pressuring riskier currencies.",
  "currencies": ["USD", "CHF"],
  "impact": "bullish",
  "fxRelevance": 95,
  "region": "Global",
  "tags": ["iran", "oil", "geopolitics", "safe-haven"],
  "source": { "name": "The Guardian World", "url": "https://www.theguardian.com/world/live/2026/jun/11/..." },
  "publishedAt": "2026-06-11T16:40:20.000Z",
  "imageUrl": "https://i.guim.co.uk/img/media/.../4723.jpg?width=140&quality=85&auto=format"
}
```

**Lifestyle item (no currencies, no image):**
```json
{
  "id": "3f8fc453a700",
  "category": "life",
  "headline": "Esquire's Father's Day gift picks dad will actually love",
  "summary": "Esquire's editors round up tested gift ideas for Father's Day on 21 June, across a wide range of budgets.",
  "whyItMatters": "Ten days out is the sweet spot — order now and skip the panic-buying premium.",
  "currencies": [],
  "impact": "neutral",
  "fxRelevance": 70,
  "region": "Global",
  "tags": ["fathers-day", "gifts"],
  "source": { "name": "Google News — Travel Deals", "url": "https://news.google.com/rss/articles/..." },
  "publishedAt": "2026-06-11T17:04:00.000Z",
  "imageUrl": null
}
```

| Field | Type | Render notes |
|-------|------|--------------|
| `id` | string | Stable key for lists/dedupe |
| `category` | enum | One of the 5 ids in §5 |
| `headline` | string (≤90) | Card title |
| `summary` | string | What happened, 1–2 sentences |
| `whyItMatters` | string | The "so what" — **give it visual emphasis** (it's the value of the feed) |
| `currencies` | string[] (ISO 4217) | Render as chips, most-affected first. **Can be `[]`** (lifestyle). |
| `impact` | `bullish`\|`bearish`\|`neutral`\|`mixed` | Applies to the **first** currency → arrow/color (↑green / ↓red / –grey / ⇅amber) |
| `fxRelevance` | int 0–100 | Optional: a subtle "hot" badge at ≥90 |
| `region` | string | Short label ("US", "Eurozone", "Japan", "Global") — optional chip |
| `tags` | string[] (≤4) | Optional |
| `source` | `{ name, url }` | **Attribution required.** Show `name`; tapping the card opens `url`. |
| `publishedAt` | string (ISO 8601) | Relative time ("3h ago") |
| `imageUrl` | string \| **null** | See image rules below |

### Image rules (important)

- `imageUrl` is **https or `null`**, sourced from the publisher's own feed image.
- Many items have **no image** (`null`) — central-bank notices, wire links, etc.
- Publisher CDNs can also **block hot-linking** (image request fails at runtime).
- **In both cases, fall back to the category `emoji` tile** (🌍 / 🏛️ / 📈 / ⚡ / 🎁). Never show a broken-image placeholder. Treat images as a bonus, not a guarantee.

---

## 7. TypeScript types

Copy-paste:

```ts
type CategoryId = "world" | "central-banks" | "fx-analysis" | "markets" | "life";
type Impact = "bullish" | "bearish" | "neutral" | "mixed";

interface Category {
  id: CategoryId;
  label: string;
  priority: number;   // render ascending
  emoji: string;
  description: string;
}

interface FeedItem {
  id: string;
  category: CategoryId;
  headline: string;
  summary: string;
  whyItMatters: string;
  currencies: string[];          // ISO 4217; may be []
  impact: Impact;                // for currencies[0]
  fxRelevance: number;           // 0–100
  region: string;
  tags: string[];
  source: { name: string; url: string };
  publishedAt: string;           // ISO 8601
  imageUrl: string | null;       // https or null
}

interface PairToWatch { pair: string; note: string; }

interface DailyBrief {
  headline: string;
  summary: string;
  pairsToWatch: PairToWatch[];
  calendar: string[];
  spendIdea: string;
  transferTip: string;
}

interface Feed {
  version: 1;
  date: string;                  // YYYY-MM-DD
  generatedAt: string;           // ISO 8601
  enrichment: "ai" | "heuristic" | "mixed";
  brief: DailyBrief | null;      // hide card when null
  categories: Category[];
  items: FeedItem[];
}
```

---

## 8. Edge cases checklist

- [ ] `brief === null` → hide the brief card.
- [ ] `imageUrl === null` **or image fails to load** → category emoji tile.
- [ ] `currencies === []` → no currency chips (normal for Life & Money).
- [ ] `pairsToWatch` / `calendar` can be `[]` → hide those rows.
- [ ] `generatedAt` older than ~26h → "feed paused" state.
- [ ] Empty `items` (rare) → friendly empty state, keep the brief if present.
- [ ] Always show the source name; card tap opens `source.url`.
- [ ] Show an **"Information, not investment advice"** disclaimer near the brief.

---

## 9. Compliance note

This is curated news and commentary, **not financial advice**. Keep a visible disclaimer on the screen. Item summaries describe events and directional read-through; they never instruct the user to buy/sell or transact.

---

*Questions or contract change requests: reply this week — we freeze the contract after that. To preview live data, just open the endpoint URL in a browser.*

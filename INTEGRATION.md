# Sera Feed — Integration Guide

For the **sera.money** app team. Everything needed to build the Feed screen end to end. The endpoint is live now; no backend work is required on your side.

> **Contract status: v1 — FROZEN (2026-06-18).** Build against this shape with confidence. See [Contract version & stability](#contract-version--stability) for the compatibility guarantee.

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

## 2. Store the feed locally and fall back to it  ⭐ required

**Treat the last feed you successfully fetched as the source of truth.** Persist it to local storage and render *that* — the network fetch only ever upgrades what you already have. This makes the screen instant, offline-capable, and resilient to our endpoint being slow, stale, or briefly unreachable.

The rules:

1. **On launch, render the stored feed immediately** (don't block the screen on the network).
2. **Then fetch in the background.** On a successful response with a **newer `generatedAt`**, replace the stored copy and re-render. Otherwise, keep showing what you have.
3. **Never downgrade.** Only replace the stored feed when the fetched one has a strictly newer `generatedAt`. If a fetch fails, times out, or returns a `304`/older/identical payload, **keep the stored feed on screen** — do not clear it, do not show an error screen.
4. **First launch with nothing stored and no network** → show a friendly empty/loading state, retry on next launch or pull-to-refresh.

The feed rebuilds roughly hourly, so fetch on **app launch** and **pull-to-refresh** — no value polling faster. The response sends an `ETag` and `cache-control: max-age=600`; send the last `ETag` back as `If-None-Match` to get a cheap **`304 Not Modified`** when nothing changed.

```ts
// Returns the feed to render. Always falls back to the stored copy.
async function loadFeed(): Promise<Feed | null> {
  const stored = readStoredFeed();           // last good feed, or null
  try {
    const res = await fetch(FEED_BASE + "/latest.json",
      storedEtag ? { headers: { "If-None-Match": storedEtag } } : {});

    if (res.status === 304) return stored;     // unchanged — keep stored
    if (!res.ok) return stored;                // server hiccup — keep stored

    const fetched: Feed = await res.json();
    // Only upgrade: never replace a newer stored feed with an older fetch.
    if (stored && fetched.generatedAt <= stored.generatedAt) return stored;

    saveStoredFeed(fetched, res.headers.get("ETag"));
    return fetched;
  } catch {
    return stored;                             // offline / timeout — keep stored
  }
}
```

```swift
func loadFeed() async -> Feed? {
  let stored = readStoredFeed()               // last good feed, or nil
  var req = URLRequest(url: URL(string: feedBase + "/latest.json")!)
  if let etag = storedEtag { req.setValue(etag, forHTTPHeaderField: "If-None-Match") }
  do {
    let (data, resp) = try await URLSession.shared.data(for: req)
    let http = resp as? HTTPURLResponse
    if http?.statusCode == 304 { return stored }
    guard http?.statusCode == 200 else { return stored }
    let fetched = try JSONDecoder().decode(Feed.self, from: data)
    if let s = stored, fetched.generatedAt <= s.generatedAt { return stored }
    saveStoredFeed(fetched, http?.value(forHTTPHeaderField: "ETag"))
    return fetched
  } catch { return stored }                    // offline / decode fail — keep stored
}
```

> `generatedAt` is an ISO-8601 string; ISO timestamps compare correctly as plain strings, so `a <= b` works without date parsing.

**Staleness label (optional, cosmetic):** even while showing a stored feed, if its `generatedAt` is older than ~26h you may show a subtle "Updated yesterday"-style label so users know it's not breaking news. Keep showing the content — an old feed still beats a blank screen.

> **Note on our side:** our endpoint always serves the most recent build and stays up independently of how the feed is generated, so "no new feed" normally just means the same `generatedAt` as last time (your `304`/no-upgrade path). The local store is your guarantee the screen still works even if our endpoint is ever unreachable.

---

## 3. Response shape

```jsonc
{
  "version": 1,
  "date": "2026-06-11",                 // YYYY-MM-DD
  "generatedAt": "2026-06-11T17:48:02.000Z",  // ISO 8601 — use for staleness check
  "enrichment": "ai",                   // "ai" | "heuristic" | "mixed" (provenance; informational)
  "sentiment": { /* risk-on/off dial, see §3.1 — always present */ },
  "brief": { /* DailyBrief, see §4 — CAN BE null */ },
  "categories": [ /* Category[], see §5 — render order */ ],
  "items": [ /* FeedItem[], see §6 — pre-ranked, ≤8 per category */ ],
  "alerts": [ /* string[] — ids of push-worthy items, see §6.1; [] on quiet days */ ],
  "currencyOutlook": [ /* CurrencyOutlook[] — daily movers board, see §6.2 */ ],
  "currencyViews": [ /* CurrencyView[] — per-currency analysis, see §6.5 */ ],
  "rates": [ /* FxRate[] — live Sera mid-market rates, see §3.2 */ ]
}
```

Render order on screen, top to bottom:

1. **`sentiment`** → the risk-on/off dial (§3.1).
2. **`brief`** → the pinned "Sera's Daily Brief" card (§4).
3. **`categories`** → section headers / tabs, in `priority` order (§5).
4. **`items`** → cards within each category (§6).

---

## 3.1 `sentiment` — risk-on / risk-off dial

A small market-mood gauge for the top of the feed, derived from the day's items. **Always present** (never null).

```jsonc
"sentiment": {
  "score": 18,            // -100 (risk-off) .. +100 (risk-on)
  "label": "neutral",     // "risk-on" | "risk-off" | "neutral"
  "summary": "Mixed signals — no clear risk-on or risk-off tilt across currencies today.",
  "basis": 16             // # of items that informed the score
}
```

- Render as a needle/bar from −100→+100, or just a colored pill from `label` (green risk-on / red risk-off / grey neutral) with `summary` as the caption.
- It's a **heuristic mood indicator, not a data feed** — safe-haven strength reads risk-off, higher-yield/EM strength reads risk-on, weighted by each item's relevance. Treat it as ambient color, not a number to trade on (the disclaimer covers it).
- `basis` of 0 means a very quiet build → `score` 0 / `neutral`; render the neutral pill.

---

## 3.2 `rates` — live Sera mid-market rates

Top-level array of **live FX rates from Sera's own pricing**, USD-base, for the currencies present in the feed. Fetched at build time, so they're as-of `generatedAt`. This is what ties the news/analysis to the rate a user actually gets.

```jsonc
"rates": [
  { "pair": "USD/PHP", "rate": 60.6871, "source": "wise", "ts": 0 },
  { "pair": "USD/JPY", "rate": 161.305, "source": "wise", "ts": 0 }
]
```

- **Join by the quote (right) side of `pair`** — e.g. attach `USD/JPY` to the JPY currency view / outlook / chip. Show it next to the analysis: *"JPY — weakening · USD/JPY 161.31"*.
- ⚠️ **Label it exactly "Sera mid-market rate."** It's the Wise mid-market rate, which equals what the user gets **because Convert is fee-free at v1** — so it's accurate to call it the Sera rate, but don't call it a generic "market rate." If Sera ever adds a spread, this feed will expose a separate net-rate field and you'd switch to that; until then, "Sera mid-market rate" is correct.
- **`source`**: `"wise"` = live; `"reference"` = fallback. If you want to be fully transparent, show a subtle "live"/"indicative" tag from this.
- **May be `[]`** if the rates API was briefly unreachable at build time (rates are a bonus, never block the feed) → just hide the rate chip and show the analysis alone. Also `ts` is currently `0` (placeholder) — don't render it as a timestamp; use `generatedAt` for "as of".
- This is a **rate, not a prediction** — it pairs naturally with the directional `currencyViews` (§6.5): "here's where it is, here's which way the news is leaning." Keep the "information, not advice" disclaimer nearby.

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
  "spendIdea": "The yen's at multi-month lows — if Japan's on your list, your money stretches noticeably further right now.",
  "transferTip": "With the BoJ on Tuesday and the Fed next week, avoid locking in big transfers right around central bank announcements — quieter windows usually price better."
}
```

| Field | Type | Render |
|-------|------|--------|
| `headline` | string (≤70 chars) | Card title |
| `summary` | string (3–5 sentences) | Card body |
| `pairsToWatch` | `{ pair, note }[]` (2–4) | A small list/row of pairs, `note` as subtext. May be `[]`. |
| `calendar` | string[] (0–4) | Bulleted "today" list. May be `[]`. |
| `spendIdea` | string | A warm "your money goes further" line tied to an FX move (e.g. weak yen → cheaper Japan trip) — give it a distinct, lighter treatment |
| `transferTip` | string | Practical money-movement note — natural spot for a "Send money" CTA |

---

## 5. `categories` — sections (World News first)

Render sections/tabs in **ascending `priority`**. Do not reorder — World News leading is a product decision.

| priority | id | label | icon |
|----------|----|----|----|
| 1 | `world` | World News | `globe` |
| 2 | `central-banks` | Central Banks | `bank` |
| 3 | `fx-analysis` | FX Analysis | `trending-up` |
| 4 | `markets` | Market Movers | `activity` |

Each object: `{ id, label, priority, icon, description }`. `description` is one-line section subtext if you want it.

> **`life` (Life & Money) was retired** — the feed no longer produces it, so `categories` has these **4** entries and no item has `category: "life"`. The value remains valid in the schema enum (a feed *could* contain it without failing validation), so keep your `default`/unknown-category branch — but you don't need a Life tab.

**`icon` is a semantic name, not an asset — render it with your own line-icon set.** The feed deliberately ships no glyph or SVG; map each `icon` value (or just the stable `id`) to the matching line icon in your design system, so it inherits your stroke weight, theming, and dark mode. The names above are the common conventions (they line up with Lucide / Phosphor / SF Symbols equivalents — e.g. `bank` ≈ `landmark` / `building.columns`), but they're just labels: if your set uses different names, map them however you like — keying off `id` is perfectly fine. Use this same category icon as the fallback tile when an item has no image (§6). If you'd rather we host actual SVGs instead of naming icons, say so and we'll switch to an `iconUrl`.

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
  "currencyImpacts": [{ "code": "USD", "direction": "up" }, { "code": "CHF", "direction": "up" }],
  "fxDriver": "geopolitics",
  "fxRelevance": 95,
  "region": "Global",
  "countries": ["US"],
  "tags": ["iran", "oil", "geopolitics", "safe-haven"],
  "source": { "name": "The Guardian World", "url": "https://www.theguardian.com/world/live/2026/jun/11/..." },
  "publishedAt": "2026-06-11T16:40:20.000Z",
  "imageUrl": "https://i.guim.co.uk/img/media/.../4723.jpg?width=140&quality=85&auto=format"
}
```

**Item with no image (icon fallback) — central-bank story:**
```json
{
  "id": "4e4126bbf23e",
  "category": "central-banks",
  "headline": "UK inflation unexpectedly holds steady ahead of the BoE decision",
  "summary": "British inflation came in flat rather than cooling further, complicating the Bank of England's rate call due shortly.",
  "whyItMatters": "Stickier inflation makes BoE cuts harder to justify, a near-term support for the pound.",
  "currencies": ["GBP"],
  "impact": "bullish",
  "currencyImpacts": [{ "code": "GBP", "direction": "up" }],
  "fxDriver": "rate-decision",
  "fxRelevance": 85,
  "region": "UK",
  "countries": ["GB"],
  "tags": ["uk-inflation", "boe", "cpi"],
  "source": { "name": "Bloomberg", "url": "https://www.bloomberg.com/..." },
  "publishedAt": "2026-06-18T14:47:00.000Z",
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
| `currencies` | string[] (ISO 4217) | Render as chips, most-affected first. **Can be `[]`** (rare — a story with no clear single currency). |
| `impact` | `bullish`\|`bearish`\|`neutral`\|`mixed` | At-a-glance badge for the **first** currency → arrow/color (↑green / ↓red / –grey / ⇅amber) |
| `currencyImpacts` | `{code, direction}[]` | Direction (`up`/`down`/`unclear`) **per** currency in `currencies`, same order. Use to personalize per the user's currencies — see §6.3. `[]` when `currencies` is empty. |
| `fxDriver` | enum | What kind of catalyst (see §6.3) — optional filter/group/badge |
| `topics` | string[] | **Controlled topic tags for your topic filters** — see §6.6. An item can carry several. |
| `fxRelevance` | int 0–100 | Optional: a subtle "hot" badge at ≥90 |
| `region` | string | Human label ("US", "Eurozone", "Japan", "Global") — display chip |
| `countries` | string[] (ISO 3166-1 α-2) | Countries the item concerns — match against the user's countries to personalize (§6.4). `[]` = globally relevant. |
| `tags` | string[] (≤4) | Optional |
| `source` | `{ name, url }` | **Attribution required.** Show `name`; tapping the card opens `url`. |
| `publishedAt` | string (ISO 8601) | Relative time ("3h ago") |
| `imageUrl` | string \| **null** | See image rules below |

### Image rules (important)

- `imageUrl` is **https or `null`**, sourced from the publisher's own feed image.
- Many items have **no image** (`null`) — central-bank notices, wire links, etc.
- Publisher CDNs can also **block hot-linking** (image request fails at runtime).
- **In both cases, fall back to the category's line-icon tile** (the `icon` from §5, rendered with your own icon set). Never show a broken-image placeholder. Treat images as a bonus, not a guarantee.

---

## 6.1 `alerts` — push-notification candidates

Top-level `alerts` is an array of **item `id`s** the feed considers significant enough to push (high FX relevance). It's a subset of `items` — look each id up in the list you already have; no duplicated data.

```jsonc
"alerts": ["28c649b824d7", "08197b8cd954"]   // [] on a quiet day
```

- **The feed only flags candidates — you own delivery.** Decide whether/when to push, respect the user's notification settings, and **dedupe against ids you've already sent** (the same id can appear across a couple of hourly builds while the story is current).
- Good push payload: the item's `headline` + `whyItMatters`, deep-linking to that card.
- Optional: gate by `impact !== "neutral"` or by the user's currencies (`item.currencies`) so a USD-only user isn't pinged about a JPY event.
- Don't badge or reorder the feed from `alerts` — it's purely a push hint; in-feed ranking already reflects importance.

---

## 6.2 `currencyOutlook` — daily movers board

Top-level array summarizing **which currencies the day's news is pushing up or down**, aggregated from every item's `currencyImpacts`. Most-cited first. Great for a compact "what's moving" strip above or below the brief.

```jsonc
"currencyOutlook": [
  { "code": "USD", "net": "up",    "signals": 5 },
  { "code": "JPY", "net": "down",  "signals": 3 },
  { "code": "EUR", "net": "down",  "signals": 3 },
  { "code": "INR", "net": "up",    "signals": 2 }
]
```

- `net`: `up` | `down` | `mixed` (mixed = equal up/down signals). `signals` = how many items gave it a clear direction (drives ordering and confidence).
- Only currencies with at least one clear (non-`unclear`) signal appear. `[]` on a quiet day.
- Render as a row of chips (`USD ↑`, `JPY ↓`) or a small table. It's a **net read of today's news**, not live FX rates — pair it with the disclaimer, don't show it as a price.

---

## 6.3 FX impact: `currencyImpacts` + `fxDriver` (the core of the feed)

These two per-item fields are what make this an FX feed rather than a headline list.

**`currencyImpacts`** gives the expected direction for **each** affected currency, because FX is relative — one story typically moves a pair in opposite directions:

```jsonc
"currencies": ["USD", "JPY"],
"impact": "bullish",                                  // at-a-glance, first currency
"currencyImpacts": [
  { "code": "USD", "direction": "up" },               // dollar strengthens
  { "code": "JPY", "direction": "down" }               // yen weakens
]
```

- `direction`: `up` (strengthens) / `down` (weakens) / `unclear`. Entry order matches `currencies`. The first entry always agrees with `impact`.
- **This is the hook for corridor personalization.** sera.money knows each user's currencies — look them up here to tailor the line: for a USD→JPY sender, `JPY: down` → *"the yen is weakening — your transfer goes further."* You can also sort or badge items by relevance to the user's own currencies.

**`fxDriver`** is the catalyst type — one of: `rate-decision`, `intervention`, `economic-data`, `geopolitics`, `commodity`, `capital-flows`, `policy-commentary`, `other` (catch-all). Use it to group ("Rate decisions today"), filter, or icon-badge cards, and to help users learn what actually moves money.

> Backfill note: items enriched before these fields existed have a best-effort `currencyImpacts` (primary currency only; others `unclear`) and an inferred `fxDriver`. Items from current builds are fully reasoned. Code defensively (`unclear` and `other` are always valid).

---

## 6.4 Personalize by country & corridor (the "For You" view)

The feed is one global artifact — **personalization happens in the app**, which is the only side that knows the user. The feed just ships the metadata to make matching precise: each item's `countries` (ISO α-2) and `currencies` (ISO 4217). You hold the user's **country set** and **currency set**, and rank.

**Build the user's sets** from what you already know — and make it two-sided, which is the whole point for a remittance app:

```ts
const userCountries = new Set([
  user.residenceCountry,        // where they are (earning)
  user.originCountry,           // where they're from (diaspora — optional)
  ...user.corridors.map(c => c.destinationCountry),  // where they send
]);
const userCurrencies = new Set([
  user.homeCurrency,
  ...user.corridors.flatMap(c => [c.fromCurrency, c.toCurrency]),
]);
```

**Score each item** — boost on overlap, keep global items eligible:

```ts
function personalScore(item: FeedItem): number {
  let s = item.fxRelevance;                                   // 0–100 base
  if (item.countries.some(c => userCountries.has(c))) s += 30;
  if (item.currencies.some(c => userCurrencies.has(c))) s += 25;
  // items with countries:[] AND currencies:[] are globally relevant —
  // they keep their base score and still surface, just not boosted.
  return s;
}
```

Two good ways to surface it:
- **A "For You" tab/section** sorted by `personalScore` — mixes categories, leads with what touches the user's money.
- **Keep the category sections** (World News first) but within each, sort by `personalScore` so a PH-relevant item floats up for a Philippines user.

Tie it to the per-currency direction for a concrete line: for a US→PH sender, an item with `currencyImpacts` containing `{ "PH"…, but really PHP }` → *"the peso is weakening — your transfer goes further."* (Look up the user's **send-to currency** in `currencyImpacts`.)

**Don't** hard-filter to only the user's countries — users still want the big global stories (a Fed decision moves everyone's money). Boost, don't exclude. And keep all of this client-side: we never need to know who the user is, which keeps the feed cacheable and private.

---

## 6.5 `currencyViews` — per-currency analysis ("what the market is saying")

A synthesized read on each well-covered currency: a **directional bias**, how strongly we hold it, a plain-language narrative, the drivers, and any **attributed** analyst forecasts. Great for a "Currencies" tab, or a detail screen when a user taps a currency chip. Always present, may be empty (only currencies with enough coverage that day get a view).

```jsonc
{
  "code": "JPY",
  "bias": "weakening",                 // strengthening | weakening | range-bound | mixed
  "conviction": "high",                // low | medium | high — how strong/consistent the signal
  "summary": "The yen sits near its weakest since July 2024. Even the BoJ's hike to 1.0% hasn't stemmed the slide while the gap to US rates stays wide — markets are watching for intervention.",
  "drivers": ["wide US–Japan rate gap", "BoJ hike not enough", "intervention risk"],
  "analystForecasts": ["Scotiabank: USD/JPY toward 162"]   // attributed third-party calls; [] if none
}
```

- **Render:** a per-currency card — `bias` as a strengthening/weakening/range pill (↑/↓/↔), `conviction` as a small strength indicator, `summary` as the body, `drivers` as chips, `analystForecasts` as an "Analysts say" list. Pair with the user's corridor (§6.4): show their send-to currency's view first.
- **It is analysis, not a forecast.** `bias` is a directional lean, **never a predicted rate level**. `analystForecasts` relays *third-party* (bank/research) calls **with attribution** — those may quote a number, but it's the analyst's, not ours. We never publish a house price target. Keep the "information, not advice" disclaimer especially visible here.
- `analystForecasts` is often `[]` (only populated when an attributed forecast appears that day). `currencyViews` itself is `[]` on quiet days. Code for both.

---

## 6.6 `topics` — controlled tags for your topic filters

Each item carries a `topics` array from a **fixed controlled vocabulary**, so your topic toggles filter reliably (don't filter on the free-form `tags` — those are descriptive, not controlled). An item can have several. The exact values:

```
fx · crypto · economics · rates · stocks · commodity · stablecoins · geopolitics · tech · remittance
```

- **`economics`** is the combined **Macro & Policy** bucket — label the toggle **"Economics"**. It covers economic data (inflation, GDP, jobs) *and* government / central-bank policy, regulation, and fiscal news. (There is no separate `macro` or `policy` value — fold those two toggles into one "Economics".) `geopolitics` stays its own topic.
- **Filter** by intersection: a topic toggle shows items whose `topics` include that value. Multi-select = union.
- **Coverage is uneven by design** (it's an FX/transfer feed): `fx`, `rates`, `economics`, `geopolitics` are rich; `commodity`/`remittance` are moderate; `crypto`/`stablecoins` are growing (we just added dedicated sources — core to Sera); `stocks`/`tech` are intentionally sparse (only when they read through to FX). So expect some toggles to show fewer items — show a friendly "nothing here today" state rather than assuming a bug.
- These are a **superset-safe enum** — if we add a topic later it's additive; your filter UI can hard-code the list above. Unknown values won't appear, but coding defensively (ignore an unrecognized topic) is free insurance.

> This is the field that backs the "Topics" selector. Wire each toggle to its slug — and merge the old "Macro" + "Policy" toggles into one **"Economics"**.

---

## 7. TypeScript types

Copy-paste:

```ts
// "life" is retired (never emitted) but still validates; keep a default branch.
type CategoryId = "world" | "central-banks" | "fx-analysis" | "markets";
type Impact = "bullish" | "bearish" | "neutral" | "mixed";
type FxDirection = "up" | "down" | "unclear";
type FxDriver =
  | "rate-decision" | "intervention" | "economic-data" | "geopolitics"
  | "commodity" | "capital-flows" | "policy-commentary" | "other";

interface CurrencyImpact { code: string; direction: FxDirection; }
interface CurrencyOutlook { code: string; net: "up" | "down" | "mixed"; signals: number; }
interface CurrencyView {
  code: string;
  bias: "strengthening" | "weakening" | "range-bound" | "mixed";
  conviction: "low" | "medium" | "high";
  summary: string;
  drivers: string[];
  analystForecasts: string[];   // attributed; may be []
}
interface FxRate {
  pair: string;                 // "USD/PHP"
  rate: number;
  source: string;               // "wise" (live) | "reference" (fallback)
  ts: number;                   // placeholder 0 for now — use feed.generatedAt
}

interface Category {
  id: CategoryId;
  label: string;
  priority: number;   // render ascending
  icon: string;       // semantic line-icon name — render with your own set
  description: string;
}

interface FeedItem {
  id: string;
  category: CategoryId;
  headline: string;
  summary: string;
  whyItMatters: string;
  currencies: string[];          // ISO 4217; may be []
  impact: Impact;                // at-a-glance, for currencies[0]
  currencyImpacts: CurrencyImpact[];  // direction per currency, same order
  fxDriver: FxDriver;            // catalyst type
  fxRelevance: number;           // 0–100
  region: string;                // human label
  topics: string[];              // controlled topic tags for filters — see §6.6
  countries: string[];           // ISO 3166-1 alpha-2; [] = global. See §6.4
  tags: string[];
  source: { name: string; url: string };
  publishedAt: string;           // ISO 8601
  imageUrl: string | null;       // https or null
}

interface Sentiment {
  score: number;                 // -100 (risk-off) .. +100 (risk-on)
  label: "risk-on" | "risk-off" | "neutral";
  summary: string;
  basis: number;
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
  sentiment: Sentiment;          // always present
  brief: DailyBrief | null;      // hide card when null
  categories: Category[];
  items: FeedItem[];
  alerts: string[];              // ids of push-worthy items (subset of items)
  currencyOutlook: CurrencyOutlook[];  // daily movers board (derived)
  currencyViews: CurrencyView[];       // per-currency analysis; may be []
  rates: FxRate[];                     // live Sera mid-market rates; may be []
}
```

---

## 8. Edge cases checklist

- [ ] **Persist the last good feed; render from the store first** (§2) — instant, offline-capable.
- [ ] **Fetch failed / timed out / `304` / older payload → keep showing the stored feed** (§2). Never blank the screen on a failed refresh.
- [ ] **Never downgrade** — only replace the stored feed when the fetched `generatedAt` is strictly newer.
- [ ] `sentiment` is always present (§3.1) — render the dial/pill from `label`; `basis: 0` → neutral.
- [ ] `brief === null` → hide the brief card.
- [ ] `imageUrl === null` **or image fails to load** → category line-icon tile (your own asset, keyed off `icon`/`id`).
- [ ] `currencies === []` → no currency chips (rare — a story with no single clear currency).
- [ ] `pairsToWatch` / `calendar` can be `[]` → hide those rows.
- [ ] `generatedAt` older than ~26h → optional subtle "updated yesterday" label; keep showing the content.
- [ ] Empty `items` (rare) → friendly empty state, keep the brief if present.
- [ ] `alerts` is for push only (§6.1) — dedupe against already-sent ids; don't use it to badge/reorder the feed.
- [ ] Always show the source name; card tap opens `source.url`.
- [ ] Show an **"Information, not investment advice"** disclaimer near the brief.

---

## 8.5 Screen blueprint & UX states (build a *good* screen, not just a correct one)

A suggested assembly — adapt to your design system, but the **states** below are the difference between correct and good.

**Layout, top to bottom:**
1. **Header** — "Feed" title, the `sentiment` pill (§3.1), and a quiet "Updated {relative time}" from `generatedAt`.
2. **Daily Brief** card (§4) — pinned; hide if `brief` is null.
3. **Movers strip** (optional) — `currencyOutlook` as small chips (`USD ↑` `JPY ↓`), horizontally scrollable. Tapping a chip deep-links to that currency's view.
4. **Category sections** — in `priority` order (**World News first**), each with its item cards. Within a section, sort by the user's corridor relevance (§6.4) so their currencies float up.
5. **Currencies tab/screen** (separate) — `currencyViews` (§6.5) as cards, each pairing the **bias + the live rate** (§3.2): *"JPY · weakening · USD/JPY 161.31"*, with drivers as chips and an "Analysts say" list.

**The states that matter:**
| State | Do this |
|---|---|
| **First paint** | Render the **stored** feed instantly (§2). Skeletons only on true cold start (nothing stored). |
| **Refreshing** | Update in the background; never blank the screen while fetching. |
| **Offline / fetch fails / 304 / older** | Keep showing the stored feed (§2). No error screen. |
| **Stale (>26h)** | Keep the content; add a subtle "Updated yesterday"-style label. |
| **No image** (≈40% of items) | Category line-icon tile — make it look **intentional** (brand color + icon), not a broken-image gap. |
| **No rate** (USD base, or `rates` empty) | Hide the rate chip entirely — never show an empty/zero rate. |
| **Empty section / `[]` arrays** | Hide the row/section quietly; don't render empty headers. |

**Polish that users feel:**
- **Impact direction = color *and* icon** (↑green / ↓red / –grey / ⇅amber). Never color alone — it fails for color-blind users and in bright sun.
- **Tap targets:** item card → `source.url`; currency chip → that currency's view; alert/push → the specific item.
- **Relative timestamps** ("3h ago"), not raw ISO.
- **Label the rate exactly "Sera mid-market rate"** (§3.2) — and put the "information, not advice" disclaimer where the analysis and rate live, not just under the brief.
- **Gold (`XAU`) and similar** can appear in `currencyOutlook`/impacts as a market signal — don't render it as a sendable currency or attach a transfer CTA.

---

## 9. Compliance note

This is curated news and commentary, **not financial advice**. Keep a visible disclaimer on the screen. Item summaries describe events and directional read-through; they never instruct the user to buy/sell or transact.

---

## Contract version & stability

**This is contract `version: 1`, frozen 2026-06-18.** Build against the shape in this document with confidence.

**Our guarantee within v1 — changes are additive only:**
- We will **not** remove or rename a field, change a field's type, or repurpose an existing enum value.
- We **may** add new optional fields, and add new values to the open-ended string fields (`region`, `tags`, `countries`, `currencies`). Treat those as open sets.
- Enum fields with a fixed set today (`category`, `impact`, `currencyImpacts[].direction`, `fxDriver`, `sentiment.label`, `currencyOutlook[].net`, `enrichment`) won't gain new values under v1. If we ever need to, that's a v2.

**What you should do to stay compatible:**
- **Ignore unknown fields** — don't fail to parse if a new field appears.
- **Read `version`** — it will stay `1`. If you ever see `2`, that's a breaking release; we'll give you the new spec and run both in parallel for a transition window, so nothing breaks overnight.
- Have a fallback branch for any enum (`default:` case) so an unexpected value degrades gracefully rather than crashing.

**Enforcement (our side):** the feed is validated against a machine schema (`src/contract.ts`) on every build — a feed that doesn't conform is **never published**, so what you receive always matches this doc.

### Changelog
- **v1.3 (2026-06-20)** — Additive: per-item `topics` (controlled tags for the app's topic filters, §6.6). Also added stablecoin/crypto/remittance sources to back the on-brand topics. Topic vocabulary merges Macro + Policy into one `economics` value (label it "Economics"); geopolitics stays separate. New optional-to-consume field; no breaking change.
- **2026-06-20** — **Life & Money retired.** `categories` is now 4 (no `life`); no item has `category: "life"`. Schema unchanged (the enum still accepts `life`), so this is a *content* change, not a contract break — but drop the Life tab. Brief's `spendIdea` stays, now FX-themed ("your money goes further").
- **v1.2 (2026-06-20)** — Additive: `rates` (live Sera mid-market rates, §3.2). New optional-to-consume field; no breaking change.
- **v1.1 (2026-06-20)** — Additive: `currencyViews` (per-currency analysis, §6.5). New optional-to-consume field; no breaking change.
- **v1 (2026-06-18)** — Frozen. Includes: `sentiment` dial, `brief`, category `icon` names (line icons), per-item `currencyImpacts` + `fxDriver` + `countries`, top-level `alerts` + `currencyOutlook`, and the persist/fallback contract (§2).

---

*To preview live data, open the endpoint URL in a browser. Breaking-change requests: let us know and we'll scope a v2 — v1 stays stable in the meantime.*

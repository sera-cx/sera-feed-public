import { isDeepStrictEqual } from "node:util";

export const FULL_PROFILE_DATE = "2026-06-18";

const FULL_TOP_LEVEL_FIELDS = [
  "sentiment",
  "alerts",
  "currencyOutlook",
  "currencyViews",
  "rates",
];

const FULL_ITEM_FIELDS = ["currencyImpacts", "fxDriver", "countries"];

function issue(file, path, code, message) {
  return { file, path, code, message };
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function validateUrl(file, path, value, { strictEncoding = true } = {}) {
  if (typeof value !== "string") return [];
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return [issue(file, path, "unsafe_url_scheme", "Expected an https URL")];
    }
    if (url.username || url.password) {
      return [issue(file, path, "url_contains_credentials", "URLs must not contain credentials")];
    }
    if (strictEncoding && /\s|&(?:#\d+|#x[a-f0-9]+|amp);/i.test(value)) {
      return [issue(file, path, "url_not_canonical", "URL contains whitespace or HTML-encoded query separators")];
    }
    return [];
  } catch {
    return [issue(file, path, "invalid_url", "Expected an absolute URL")];
  }
}

function validateFullProfile(file, feed) {
  const issues = [];
  for (const field of FULL_TOP_LEVEL_FIELDS) {
    if (!(field in feed)) {
      issues.push(issue(file, `/${field}`, "missing_current_field", `Current v1 feeds require '${field}'`));
    }
  }

  for (const [index, category] of (feed.categories ?? []).entries()) {
    if (!("icon" in category)) {
      issues.push(issue(file, `/categories/${index}/icon`, "missing_current_field", "Current categories require 'icon'"));
    }
  }

  for (const [index, item] of (feed.items ?? []).entries()) {
    for (const field of FULL_ITEM_FIELDS) {
      if (!(field in item)) {
        issues.push(issue(file, `/items/${index}/${field}`, "missing_current_field", `Current items require '${field}'`));
      }
    }
  }
  return issues;
}

function validateCurrencyImpacts(file, item, index) {
  if (!Array.isArray(item.currencies) || !Array.isArray(item.currencyImpacts)) return [];
  const issues = [];
  const codes = item.currencyImpacts.map((impact) => impact?.code);
  if (codes.length !== item.currencies.length || codes.some((code, i) => code !== item.currencies[i])) {
    issues.push(issue(
      file,
      `/items/${index}/currencyImpacts`,
      "currency_impact_order_mismatch",
      "currencyImpacts codes must exactly match currencies in the same order",
    ));
  }

  if (item.currencies.length > 0 && item.currencyImpacts[0]) {
    const expected = {
      bullish: "up",
      bearish: "down",
      neutral: "unclear",
      mixed: "unclear",
    }[item.impact];
    if (expected && item.currencyImpacts[0].direction !== expected) {
      issues.push(issue(
        file,
        `/items/${index}/currencyImpacts/0/direction`,
        "primary_impact_mismatch",
        `Impact '${item.impact}' requires first direction '${expected}'`,
      ));
    }
  }
  return issues;
}

function deriveCurrencyOutlook(items) {
  const counts = new Map();
  for (const item of items ?? []) {
    for (const impact of item.currencyImpacts ?? []) {
      if (impact.direction !== "up" && impact.direction !== "down") continue;
      const count = counts.get(impact.code) ?? { up: 0, down: 0 };
      count[impact.direction] += 1;
      counts.set(impact.code, count);
    }
  }
  return [...counts.entries()]
    .map(([code, count]) => ({
      code,
      net: count.up === count.down ? "mixed" : count.up > count.down ? "up" : "down",
      signals: count.up + count.down,
    }))
    .sort((a, b) => b.signals - a.signals || a.code.localeCompare(b.code));
}

export function validateFeedSemantics(file, feed, { requireFullProfile = false } = {}) {
  const issues = [];
  if (requireFullProfile) issues.push(...validateFullProfile(file, feed));

  const categoryIds = (feed.categories ?? []).map((category) => category.id);
  for (const id of duplicates(categoryIds)) {
    issues.push(issue(file, "/categories", "duplicate_category_id", `Duplicate category id '${id}'`));
  }
  const priorities = (feed.categories ?? []).map((category) => category.priority);
  for (const priority of duplicates(priorities)) {
    issues.push(issue(file, "/categories", "duplicate_category_priority", `Duplicate category priority '${priority}'`));
  }
  for (let index = 1; index < priorities.length; index += 1) {
    if (priorities[index] <= priorities[index - 1]) {
      issues.push(issue(file, `/categories/${index}/priority`, "categories_not_sorted", "Categories must be ordered by ascending priority"));
      break;
    }
  }

  const itemIds = (feed.items ?? []).map((item) => item.id);
  const itemIdSet = new Set(itemIds);
  for (const id of duplicates(itemIds)) {
    issues.push(issue(file, "/items", "duplicate_item_id", `Duplicate item id '${id}'`));
  }

  const categoryIdSet = new Set(categoryIds);
  const itemsPerCategory = new Map();
  const generatedAt = Date.parse(feed.generatedAt);
  for (const [index, item] of (feed.items ?? []).entries()) {
    if (!categoryIdSet.has(item.category)) {
      issues.push(issue(file, `/items/${index}/category`, "unknown_category_reference", `Unknown category '${item.category}'`));
    }
    itemsPerCategory.set(item.category, (itemsPerCategory.get(item.category) ?? 0) + 1);
    if (Number.isFinite(generatedAt) && Date.parse(item.publishedAt) > generatedAt) {
      issues.push(issue(file, `/items/${index}/publishedAt`, "future_item_timestamp", "publishedAt must not be later than generatedAt"));
    }
    issues.push(...validateCurrencyImpacts(file, item, index));
    issues.push(...validateUrl(file, `/items/${index}/source/url`, item.source?.url));
    if (item.imageUrl !== null && item.imageUrl !== undefined) {
      issues.push(...validateUrl(file, `/items/${index}/imageUrl`, item.imageUrl, { strictEncoding: requireFullProfile }));
    }
  }

  for (const [category, count] of itemsPerCategory) {
    if (count > 8) {
      issues.push(issue(file, "/items", "category_item_limit_exceeded", `Category '${category}' has ${count} items; maximum is 8`));
    }
  }

  for (const [index, alertId] of (feed.alerts ?? []).entries()) {
    if (!itemIdSet.has(alertId)) {
      issues.push(issue(file, `/alerts/${index}`, "unknown_alert_reference", `Alert '${alertId}' does not reference an item`));
    }
  }

  for (const [field, values] of [
    ["currencyOutlook", (feed.currencyOutlook ?? []).map((entry) => entry.code)],
    ["currencyViews", (feed.currencyViews ?? []).map((entry) => entry.code)],
    ["rates", (feed.rates ?? []).map((entry) => entry.pair)],
  ]) {
    for (const value of duplicates(values)) {
      issues.push(issue(file, `/${field}`, `duplicate_${field}_key`, `Duplicate ${field} key '${value}'`));
    }
  }

  for (const [index, rate] of (feed.rates ?? []).entries()) {
    if (!rate.pair?.startsWith("USD/") || rate.pair === "USD/USD") {
      issues.push(issue(file, `/rates/${index}/pair`, "non_usd_base_rate", "Rates must use USD as base and a different quote currency"));
    }
  }

  if (requireFullProfile && Array.isArray(feed.currencyOutlook)) {
    const derived = deriveCurrencyOutlook(feed.items);
    if (!isDeepStrictEqual(feed.currencyOutlook, derived)) {
      issues.push(issue(file, "/currencyOutlook", "currency_outlook_mismatch", "currencyOutlook must equal the signal aggregation of item currencyImpacts"));
    }
  }

  if (feed.sentiment && feed.sentiment.basis > (feed.items?.length ?? 0)) {
    issues.push(issue(file, "/sentiment/basis", "sentiment_basis_exceeds_items", "sentiment basis cannot exceed item count"));
  }
  return issues;
}

export function validatePublication(files) {
  const issues = [];
  const archives = files
    .filter(({ file }) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .sort((a, b) => a.data.date.localeCompare(b.data.date));
  const latest = files.find(({ file }) => file === "latest.json");

  for (const archive of archives) {
    const expected = `${archive.data.date}.json`;
    if (archive.file !== expected) {
      issues.push(issue(archive.file, "/date", "archive_filename_mismatch", `Payload date requires filename '${expected}'`));
    }
  }

  for (let index = 1; index < archives.length; index += 1) {
    const previous = archives[index - 1];
    const current = archives[index];
    if (Date.parse(current.data.generatedAt) <= Date.parse(previous.data.generatedAt)) {
      issues.push(issue(
        current.file,
        "/generatedAt",
        "archive_generated_at_not_monotonic",
        `generatedAt must be later than ${previous.file}`,
      ));
    }
  }

  if (!latest) {
    issues.push(issue("latest.json", "/", "latest_missing", "latest.json is required"));
    return issues;
  }
  const matchingArchive = archives.find(({ data }) => data.date === latest.data.date);
  if (!matchingArchive) {
    issues.push(issue("latest.json", "/date", "latest_archive_missing", `No archive exists for date '${latest.data.date}'`));
  } else if (!isDeepStrictEqual(latest.data, matchingArchive.data)) {
    issues.push(issue("latest.json", "/", "latest_archive_mismatch", `latest.json must exactly match '${matchingArchive.file}'`));
  }

  const newest = [...archives].sort((a, b) =>
    Date.parse(b.data.generatedAt) - Date.parse(a.data.generatedAt) || b.data.date.localeCompare(a.data.date),
  )[0];
  if (newest && latest.data.generatedAt !== newest.data.generatedAt) {
    issues.push(issue("latest.json", "/generatedAt", "latest_not_newest", `latest.json must point to newest archive '${newest.file}'`));
  }
  return issues;
}

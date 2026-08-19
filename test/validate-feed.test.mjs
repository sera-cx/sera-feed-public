import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateArchiveImmutability } from "../scripts/lib/git-immutability.mjs";
import { validateFeedSemantics } from "../scripts/lib/semantic-checks.mjs";
import { validateFeedDirectory } from "../scripts/validate-feed.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIR, "..");
const VALID_FIXTURE = resolve(TEST_DIR, "fixtures/valid/minimal-current.json");
const INVALID_FIXTURE = resolve(TEST_DIR, "fixtures/invalid/missing-headline.json");

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function withTempDirectory(callback) {
  const directory = await mkdtemp(resolve(tmpdir(), "sera-feed-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writePublication(directory, archive, latest = archive) {
  await writeFile(resolve(directory, `${archive.date}.json`), `${JSON.stringify(archive, null, 2)}\n`);
  await writeFile(resolve(directory, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
}

test("validates every committed production artifact", async () => {
  const result = await validateFeedDirectory({ rootDir: REPOSITORY_ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.deepEqual(result.files, ["2026-06-11.json", "2026-06-17.json", "2026-06-18.json", "latest.json"]);
});

test("accepts a minimal full-profile publication", async () => {
  await withTempDirectory(async (directory) => {
    const feed = await loadJson(VALID_FIXTURE);
    await writePublication(directory, feed);
    const result = await validateFeedDirectory({ rootDir: directory });
    assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  });
});

test("reports structural errors with stable JSON pointers", async () => {
  await withTempDirectory(async (directory) => {
    const feed = await loadJson(INVALID_FIXTURE);
    await writePublication(directory, feed);
    const result = await validateFeedDirectory({ rootDir: directory });
    assert.equal(result.ok, false);
    assert(result.errors.some((error) =>
      error.code === "schema_required" && error.path === "/items/0/headline",
    ));
  });
});

test("enforces the frozen full profile on current artifacts", async () => {
  await withTempDirectory(async (directory) => {
    const feed = await loadJson(VALID_FIXTURE);
    delete feed.sentiment;
    await writePublication(directory, feed);
    const result = await validateFeedDirectory({ rootDir: directory });
    assert.equal(result.ok, false);
    assert(result.errors.some((error) => error.code === "missing_current_field" && error.path === "/sentiment"));
  });
});

test("detects duplicate ids, dangling alerts, and currency-impact mismatches", async () => {
  await withTempDirectory(async (directory) => {
    const feed = await loadJson(VALID_FIXTURE);
    const duplicate = structuredClone(feed.items[0]);
    duplicate.currencyImpacts[0].code = "EUR";
    feed.items.push(duplicate);
    feed.alerts.push("ffffffffffff");
    feed.currencyOutlook = [
      { code: "EUR", net: "up", signals: 1 },
      { code: "USD", net: "up", signals: 1 }
    ];
    await writePublication(directory, feed);
    const result = await validateFeedDirectory({ rootDir: directory });
    const codes = new Set(result.errors.map((error) => error.code));
    assert(codes.has("duplicate_item_id"));
    assert(codes.has("unknown_alert_reference"));
    assert(codes.has("currency_impact_order_mismatch"));
  });
});

test("rejects unsafe current URLs without penalizing immutable legacy encoding", async () => {
  await withTempDirectory(async (directory) => {
    const feed = await loadJson(VALID_FIXTURE);
    feed.items[0].imageUrl = "https://example.com/image.jpg?width=140&#038;quality=85";
    await writePublication(directory, feed);
    const result = await validateFeedDirectory({ rootDir: directory });
    assert(result.errors.some((error) => error.code === "url_not_canonical"));
    const legacyIssues = validateFeedSemantics("2026-06-17.json", feed, { requireFullProfile: false });
    assert.equal(legacyIssues.some((error) => error.code === "url_not_canonical"), false);
  });
});

test("requires latest.json to exactly match the newest archive", async () => {
  await withTempDirectory(async (directory) => {
    const archive = await loadJson(VALID_FIXTURE);
    const latest = structuredClone(archive);
    latest.items[0].summary = "Different content under the same publication date.";
    await writePublication(directory, archive, latest);
    const result = await validateFeedDirectory({ rootDir: directory });
    assert(result.errors.some((error) => error.code === "latest_archive_mismatch"));
  });
});

test("sorts diagnostics deterministically", async () => {
  await withTempDirectory(async (directory) => {
    const feed = await loadJson(VALID_FIXTURE);
    feed.alerts = ["ffffffffffff", "eeeeeeeeeeee"];
    await writePublication(directory, feed);
    const first = await validateFeedDirectory({ rootDir: directory });
    const second = await validateFeedDirectory({ rootDir: directory });
    assert.deepEqual(first.errors, second.errors);
    assert.deepEqual(first.errors, [...first.errors].sort((a, b) =>
      a.file.localeCompare(b.file) || a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message),
    ));
  });
});

test("detects modification of an existing dated archive", async () => {
  await withTempDirectory(async (directory) => {
    const feed = await loadJson(VALID_FIXTURE);
    await writePublication(directory, feed);
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "feed-test@example.com"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "Feed Test"], { cwd: directory });
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: directory });
    feed.items[0].summary = "A forbidden archive rewrite.";
    await writeFile(resolve(directory, `${feed.date}.json`), `${JSON.stringify(feed, null, 2)}\n`);
    const issues = validateArchiveImmutability(directory, "HEAD");
    assert.deepEqual(issues.map((entry) => entry.code), ["immutable_archive_changed"]);
  });
});

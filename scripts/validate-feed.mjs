#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { validateArchiveImmutability } from "./lib/git-immutability.mjs";
import { FULL_PROFILE_DATE, validateFeedSemantics, validatePublication } from "./lib/semantic-checks.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_SCHEMA = resolve(DEFAULT_ROOT, "schema/feed-v1.schema.json");
const FEED_FILE_PATTERN = /^(latest|\d{4}-\d{2}-\d{2})\.json$/;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_ERRORS = 100;

function issue(file, path, code, message) {
  return { file, path, code, message };
}

function sortIssues(issues) {
  return issues.sort((a, b) =>
    a.file.localeCompare(b.file) || a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message),
  );
}

function schemaIssues(file, errors = []) {
  return errors.map((error) => {
    const suffix = error.keyword === "required" ? `/${error.params.missingProperty}` : "";
    return issue(file, `${error.instancePath || ""}${suffix}` || "/", `schema_${error.keyword}`, error.message ?? "Schema validation failed");
  });
}

async function readJson(filePath, file, maxFileBytes) {
  const metadata = await stat(filePath);
  if (metadata.size > maxFileBytes) {
    return { error: issue(file, "/", "file_too_large", `File exceeds ${maxFileBytes} bytes`) };
  }
  try {
    return { data: JSON.parse(await readFile(filePath, "utf8")) };
  } catch (error) {
    return { error: issue(file, "/", "invalid_json", error.message) };
  }
}

export async function validateFeedDirectory({
  rootDir = DEFAULT_ROOT,
  schemaPath = DEFAULT_SCHEMA,
  changedSince,
  maxErrors = DEFAULT_MAX_ERRORS,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
} = {}) {
  const root = resolve(rootDir);
  const schema = JSON.parse(await readFile(resolve(schemaPath), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const names = (await readdir(root)).filter((name) => FEED_FILE_PATTERN.test(name)).sort();
  const issues = [];
  const validFiles = [];

  for (const file of names) {
    const result = await readJson(resolve(root, file), file, maxFileBytes);
    if (result.error) {
      issues.push(result.error);
      continue;
    }
    const schemaValid = validateSchema(result.data);
    if (!schemaValid) {
      issues.push(...schemaIssues(file, validateSchema.errors));
      continue;
    }
    const requireFullProfile = file === "latest.json" || result.data.date >= FULL_PROFILE_DATE;
    issues.push(...validateFeedSemantics(file, result.data, { requireFullProfile }));
    validFiles.push({ file, data: result.data });
  }

  if (!names.includes("latest.json")) {
    issues.push(issue("latest.json", "/", "latest_missing", "latest.json is required"));
  }
  if (names.includes("latest.json") && validFiles.length === names.length) {
    issues.push(...validatePublication(validFiles));
  }
  if (changedSince) {
    issues.push(...validateArchiveImmutability(root, changedSince));
  }

  const sorted = sortIssues(issues);
  const truncated = sorted.length > maxErrors;
  return {
    ok: sorted.length === 0,
    root,
    files: names,
    errors: sorted.slice(0, maxErrors),
    errorCount: sorted.length,
    truncated,
  };
}

function parseArgs(argv) {
  const options = { rootDir: DEFAULT_ROOT, schemaPath: DEFAULT_SCHEMA, format: "text" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--root" && value) {
      options.rootDir = resolve(value);
      index += 1;
    } else if (arg === "--schema" && value) {
      options.schemaPath = resolve(value);
      index += 1;
    } else if (arg === "--changed-since" && value) {
      options.changedSince = value;
      index += 1;
    } else if (arg === "--format" && (value === "text" || value === "json")) {
      options.format = value;
      index += 1;
    } else if (arg === "--max-errors" && value && Number.isInteger(Number(value)) && Number(value) > 0) {
      options.maxErrors = Number(value);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument '${arg}'`);
    }
  }
  return options;
}

function printText(result) {
  if (result.ok) {
    process.stdout.write(`Validated ${result.files.length} feed artifacts (0 errors).\n`);
    return;
  }
  for (const error of result.errors) {
    process.stderr.write(`${error.file}:${error.path} [${error.code}] ${error.message}\n`);
  }
  if (result.truncated) process.stderr.write(`... ${result.errorCount - result.errors.length} more errors omitted\n`);
  process.stderr.write(`Validation failed with ${result.errorCount} error(s).\n`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const { format, ...validationOptions } = options;
  try {
    const result = await validateFeedDirectory(validationOptions);
    if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printText(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const fatal = { ok: false, code: "validator_failed", message: error.message };
    if (format === "json") process.stdout.write(`${JSON.stringify(fatal, null, 2)}\n`);
    else process.stderr.write(`Validator failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();

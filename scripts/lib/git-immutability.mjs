import { spawnSync } from "node:child_process";

const ARCHIVE_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;

function issue(file, code, message) {
  return { file, path: "/", code, message };
}

function runGit(rootDir, args) {
  return spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function validateArchiveImmutability(rootDir, baseRef) {
  if (typeof baseRef !== "string" || baseRef.length > 200 || baseRef.startsWith("-")) {
    return [issue("(git)", "invalid_git_base", "changed-since ref is invalid")];
  }
  const resolved = runGit(rootDir, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  if (resolved.status !== 0) {
    return [issue("(git)", "git_base_unavailable", `Cannot resolve changed-since ref '${baseRef}'`)];
  }

  const diff = runGit(rootDir, ["diff", "--name-status", "--find-renames", baseRef, "--"]);
  if (diff.status !== 0) {
    return [issue("(git)", "git_diff_failed", diff.stderr.trim() || "Unable to inspect archive history")];
  }

  const issues = [];
  for (const line of diff.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [status, oldPath] = line.split("\t");
    if (!ARCHIVE_PATTERN.test(oldPath ?? "")) continue;
    if (status === "M" || status === "D" || status === "T" || status.startsWith("R")) {
      issues.push(issue(oldPath, "immutable_archive_changed", `Existing dated archive cannot be ${status === "D" ? "deleted" : status.startsWith("R") ? "renamed" : status === "T" ? "type-changed" : "modified"}`));
    }
  }
  return issues;
}

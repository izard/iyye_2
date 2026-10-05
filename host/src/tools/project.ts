// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The `project` toolkit (plan 0.007 S5): read-only looks into the
 * repositories Iyye observes, for its background investigations.
 *
 * - The repository is chosen by name from a fixed set (`workspace`, and
 *   `project` when the owner configured one); the model cannot name a path.
 * - git runs with fixed arguments and a minimal environment; no shell.
 * - `read_file` resolves the path inside the repository (symlinks included),
 *   refuses `.git` and likely secrets, and returns at most 4000 characters.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { IyyeTool, Toolkit } from "./broker.ts";

const MAX = 4000;
const SECRET = /(^|\/)(\.env[^/]*|.*\.(pem|key|p12|pfx)|id_[a-z0-9]+|secrets?(\/|$)|credentials?[^/]*|.*token[^/]*)$/i;

export function projectToolkit(repos: Record<string, string>): Toolkit {
	const names = Object.keys(repos);
	const repoParam = Type.Union(names.map((n) => Type.Literal(n)));
	const git = (repo: string, ...args: string[]) =>
		execFileSync("git", ["-C", repos[repo]!, ...args], {
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 2_000_000,
			env: { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: repos[repo]! },
		});
	const known = (repo: string): string | null =>
		repos[repo] && existsSync(join(repos[repo]!, ".git")) ? null : `no repository named ${JSON.stringify(repo)}`;
	const clip = (s: string) => (s.length > MAX ? `${s.slice(0, MAX)}\n… (cut at ${MAX} characters)` : s);

	const tools: IyyeTool[] = [
		{
			name: "git_log",
			label: "Git log",
			description: `The latest commits of one of Iyye's repositories (${names.join(", ")}): short hash, date and subject.`,
			summary: "the latest commits of a repository",
			parameters: Type.Object({ repo: repoParam }),
			run: async ({ repo }: { repo: string }) =>
				known(repo) ?? (git(repo, "log", "-n", "20", "--date=short", "--format=%h %ad %s").trim() || "no commits"),
		},
		{
			name: "git_show",
			label: "Git show",
			description: "One commit of a repository: its subject, the files it changed and the diff.",
			summary: "one commit's changes",
			parameters: Type.Object({ repo: repoParam, commit: Type.String({ pattern: "^[0-9a-f]{4,40}$" }) }),
			run: async ({ repo, commit }: { repo: string; commit: string }) => {
				const err = known(repo);
				if (err) return err;
				try {
					return clip(git(repo, "show", "--stat", "--patch", "--format=%h %s", commit, "--"));
				} catch {
					return `no commit ${commit} in ${repo}`;
				}
			},
		},
		{
			name: "git_status",
			label: "Git status",
			description: "Uncommitted changes in a repository: one line per changed file.",
			summary: "uncommitted changes of a repository",
			parameters: Type.Object({ repo: repoParam }),
			run: async ({ repo }: { repo: string }) =>
				known(repo) ?? (git(repo, "status", "--porcelain").trim() || "clean"),
		},
		{
			name: "read_file",
			label: "Read a file",
			description: "Read a file of a repository, by its path relative to the repository.",
			summary: "a file of a repository",
			parameters: Type.Object({ repo: repoParam, path: Type.String({ minLength: 1, maxLength: 200 }) }),
			run: async ({ repo, path }: { repo: string; path: string }) => {
				const err = known(repo);
				if (err) return err;
				const refused = refusePath(repos[repo]!, path);
				if (refused) return refused;
				return clip(readFileSync(resolve(repos[repo]!, path), "utf8"));
			},
		},
	];
	return { name: "project", description: "Iyye's own code repositories", effect: "read", tools };
}

/** Why `path` may not be read in `root`, or null. */
export function refusePath(root: string, path: string): string | null {
	if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) return "refused: give a path inside the repository";
	if (path.split(/[\\/]/)[0] === ".git") return "refused: the repository's internals are not readable";
	if (SECRET.test(path)) return "refused: this looks like a secret";
	const full = resolve(root, path);
	if (!existsSync(full)) return `no such file: ${path}`;
	let real: string;
	try {
		real = realpathSync(full);
	} catch {
		return `no such file: ${path}`;
	}
	const base = realpathSync(root);
	const rel = relative(base, real);
	if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep)[0] === ".git")
		return "refused: outside the repository";
	if (!statSync(real).isFile()) return `not a file: ${path}`;
	return null;
}

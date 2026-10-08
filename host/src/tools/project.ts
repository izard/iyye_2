// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The `project` toolkit (plan 0.007 S5): read-only looks into Iyye's own
 * repositories, for its background investigations and, since 2026-10-08, the
 * owner's own turns (effect `private`: never a contact's).
 *
 * - The repository is chosen by name from a fixed set (`workspace`, and
 *   `project`: by default the iyye_2 repository Iyye runs from); a path is
 *   always inside it. An absolute path from another machine that names the
 *   repository's folder ("/home/me/…/iyye_2/host/…") is read as the same
 *   path here; anything else outside it is refused.
 * - git runs with fixed arguments and a minimal environment; no shell.
 * - `read_file` resolves the path inside the repository (symlinks included),
 *   refuses `.git` and likely secrets, and returns at most 4000 characters.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
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
			parameters: Type.Object({ repo: repoParam, path: Type.String({ minLength: 1, maxLength: 300 }) }),
			run: async ({ repo, path }: { repo: string; path: string }) => {
				const err = known(repo);
				if (err) return err;
				const rel = inRepo(repos[repo]!, path);
				const refused = refusePath(repos[repo]!, rel);
				if (refused) return refused;
				return clip(readFileSync(resolve(repos[repo]!, rel), "utf8"));
			},
		},
		{
			name: "list_dir",
			label: "List a folder",
			description:
				"List a folder of a repository (by its path relative to the repository; empty for the top): its files and folders, folders ending with /. Folders git ignores (like node_modules) are listed too.",
			summary: "the files and folders in a folder of a repository",
			parameters: Type.Object({ repo: repoParam, path: Type.Optional(Type.String({ maxLength: 300 })) }),
			run: async ({ repo, path }: { repo: string; path?: string }) => {
				const err = known(repo);
				if (err) return err;
				const rel = inRepo(repos[repo]!, path?.trim() || ".");
				const refused = refuseDir(repos[repo]!, rel);
				if (refused) return refused;
				const entries = readdirSync(resolve(repos[repo]!, rel), { withFileTypes: true })
					.filter((e) => e.name !== ".git")
					.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
					.sort();
				const shown = entries.slice(0, MAX_ENTRIES);
				return `${rel === "." ? repo : rel}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}\n${shown.join("\n")}${entries.length > MAX_ENTRIES ? `\n… and ${entries.length - MAX_ENTRIES} more` : ""}`;
			},
		},
	];
	return { name: "project", description: "Iyye's own code repositories", effect: "private", tools };
}

const MAX_ENTRIES = 200;

/**
 * A path as the repository sees it. An absolute path inside it becomes
 * relative; one from another machine that names the repository's own folder
 * ("/home/me/src/iyye_2/host/x" for a repository called iyye_2) becomes the
 * part after that folder. Anything else is returned as given (and refused).
 */
export function inRepo(root: string, path: string): string {
	const p = path.trim().replace(/\\/g, "/");
	if (!isAbsolute(p)) return p;
	const here = relative(root, p);
	if (!here.startsWith("..") && !isAbsolute(here)) return here || ".";
	const name = basename(root);
	const at = p.split("/").lastIndexOf(name);
	return at >= 0
		? p
				.split("/")
				.slice(at + 1)
				.join("/") || "."
		: p;
}

/** Why folder `path` may not be listed in `root`, or null. */
export function refuseDir(root: string, path: string): string | null {
	if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) return "refused: give a path inside the repository";
	if (path.split(/[\\/]/)[0] === ".git") return "refused: the repository's internals are not readable";
	const full = resolve(root, path);
	if (!existsSync(full)) return `no such folder: ${path}`;
	const real = realpathSync(full);
	const rel = relative(realpathSync(root), real);
	if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep)[0] === ".git")
		return "refused: outside the repository";
	if (!statSync(real).isDirectory()) return `not a folder: ${path}`;
	return null;
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

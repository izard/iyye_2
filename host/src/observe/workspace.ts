// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Iyye's workspace repository (plan 0.007 S4, owner decision 5): a git
 * repository for code and artifacts Iyye itself produces, like 1.x's
 * generated streams. The host creates it once; commits are made only by the
 * host (author "Iyye"), never by a model with a shell. In 0.007 it is created
 * and observed; nothing writes code to it yet.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";

const README = `# Iyye's workspace

Code and artifacts that Iyye produces itself. Commits are made by Iyye's host,
with the job and evidence that produced them in the message.
`;

/** Create the repository with one first commit, unless it exists. Returns true if it was created. */
export function ensureWorkspace(dir: string, log: Logger): boolean {
	if (existsSync(join(dir, ".git"))) return false;
	mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			timeout: 10_000,
			env: {
				PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
				HOME: dir,
				GIT_AUTHOR_NAME: "Iyye",
				GIT_AUTHOR_EMAIL: "iyye@localhost",
				GIT_COMMITTER_NAME: "Iyye",
				GIT_COMMITTER_EMAIL: "iyye@localhost",
			},
		});
	git("init", "-q");
	writeFileSync(join(dir, "README.md"), README);
	git("add", "README.md");
	git("commit", "-q", "-m", "Start Iyye's workspace");
	log.info("workspace: created", { dir });
	return true;
}

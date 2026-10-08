// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * 2026-10-08: the owner's turns read Iyye's own repositories (the `project`
 * toolkit, effect `private`: the owner and Iyye's own work, never a contact),
 * with `list_dir` next to `read_file`, and paths from another machine read as
 * the same path here.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig, PROJECT_ROOT } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { openDb } from "../src/state/db.ts";
import { ToolBroker } from "../src/tools/broker.ts";
import { inRepo, projectToolkit } from "../src/tools/project.ts";

describe("project access", () => {
	let base: string;
	let repo: string;
	before(() => {
		base = mkdtempSync(join(tmpdir(), "iyye-project-"));
		repo = join(base, "iyye_2");
		mkdirSync(join(repo, "host", "node_modules", "better-sqlite3", "prebuilds"), { recursive: true });
		writeFileSync(join(repo, "host", "node_modules", "better-sqlite3", "prebuilds", "linux-arm64.node"), "x");
		writeFileSync(join(repo, "host", "package.json"), '{"name":"iyye-host"}');
		writeFileSync(join(repo, ".gitignore"), "node_modules\n");
		execFileSync("git", ["init", "-q", repo]);
		writeFileSync(join(base, "outside.txt"), "secret");
		symlinkSync(base, join(repo, "host", "escape"));
	});
	after(() => rmSync(base, { recursive: true, force: true }));

	const kit = () => projectToolkit({ project: repo });
	const run = (name: string, args: Record<string, unknown>) =>
		kit()
			.tools.find((t) => t.name === name)!
			.run(args as never, { scope: "owner", principal: "owner" }, undefined);

	test("the owner and Iyye's own work get it; a contact never does", () => {
		const broker = new ToolBroker({ db: openDb(":memory:"), log: silentLogger, toolkits: [kit()] });
		assert.ok(broker.forSession({ scope: "owner", principal: "owner" }).names.includes("list_dir"));
		assert.ok(broker.forSession({ scope: "iyye:bg:x", principal: "iyye" }).names.includes("read_file"));
		assert.deepEqual(broker.forSession({ scope: "contact:c1", principal: "contact", trusted: true }).names, []);
	});

	test("list_dir lists ignored folders too, and refuses .git, .. and symlinks out of the repository", async () => {
		assert.match(await run("list_dir", { repo: "project" }), /^project: \d+ entr.*\nhost\//s);
		assert.equal(
			await run("list_dir", { repo: "project", path: "host/node_modules/better-sqlite3/prebuilds" }),
			"host/node_modules/better-sqlite3/prebuilds: 1 entry\nlinux-arm64.node",
		);
		assert.match(await run("list_dir", { repo: "project", path: "../" }), /refused/);
		assert.match(await run("list_dir", { repo: "project", path: ".git" }), /refused/);
		assert.match(await run("list_dir", { repo: "project", path: "host/escape" }), /refused: outside/);
		assert.match(await run("read_file", { repo: "project", path: "host/escape/outside.txt" }), /refused: outside/);
	});

	test("a path from another machine that names the repository's folder is read as the same path here", async () => {
		assert.equal(inRepo(repo, "/home/akomarov/Downloads/iyye/iyye_2/host/node_modules"), "host/node_modules");
		assert.equal(inRepo(repo, join(repo, "host")), "host");
		assert.equal(inRepo(repo, "/etc/passwd"), "/etc/passwd");
		assert.match(
			await run("list_dir", { repo: "project", path: "/home/akomarov/Downloads/iyye/iyye_2/host/node_modules" }),
			/^host\/node_modules: 1 entry\nbetter-sqlite3\//,
		);
		assert.equal(
			await run("read_file", { repo: "project", path: "/home/me/iyye_2/host/package.json" }),
			'{"name":"iyye-host"}',
		);
		assert.match(await run("read_file", { repo: "project", path: "/etc/passwd" }), /refused/);
	});

	test("by default the project repository is the iyye_2 repository Iyye runs from; 0 turns it off", () => {
		assert.equal(loadConfig({}).projectRepo, PROJECT_ROOT.replace(/\/$/, ""));
		assert.equal(loadConfig({ IYYE2_PROJECT_REPO: "0" }).projectRepo, null);
	});
});

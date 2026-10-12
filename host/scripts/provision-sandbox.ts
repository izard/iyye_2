// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Provision the sandbox's root filesystem (owner decision 2026-10-12), once:
 * download Alpine's minirootfs (pinned: version, sha256 and sha512), extract
 * it without host ownership, install python3 from Alpine's signed repository
 * in a provisioning container (the only configuration ever given the host's
 * network), and write `provisioned.json` (the packages and a hash of the
 * tree). The host refuses a root that no longer matches it.
 *
 *   node scripts/provision-sandbox.ts [--force]
 *
 * Needs Linux, rootless runc (user namespaces allowed for runc by AppArmor)
 * and network for the download. Writes only under `<state>/sandbox`.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { provisionConfig } from "../src/sandbox/config.ts";
import { ALPINE, checkProvisioned, type SandboxManifest, sandboxPaths, treeHash } from "../src/sandbox/provision.ts";

const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });
const config = loadConfig();
const p = sandboxPaths(config.stateDir);
if (process.platform !== "linux" || process.arch !== "arm64") {
	console.error(
		`provision-sandbox: only Linux on arm64 is pinned (${ALPINE.arch}); this is ${process.platform}/${process.arch}`,
	);
	process.exit(2);
}
if (!values.force && checkProvisioned(config.stateDir) === null) {
	console.log("provision-sandbox: already provisioned and matching its manifest (--force to redo)");
	process.exit(0);
}
mkdirSync(p.dir, { recursive: true, mode: 0o700 });
const env = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: process.env.HOME ?? "/" };

// 1. The pinned minirootfs, both digests checked.
const tarball = join(p.dir, `alpine-minirootfs-${ALPINE.version}-${ALPINE.arch}.tar.gz`);
if (!existsSync(tarball)) {
	console.log(`downloading ${ALPINE.url}`);
	const res = await fetch(ALPINE.url);
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
	writeFileSync(`${tarball}.partial`, Buffer.from(await res.arrayBuffer()));
	renameSync(`${tarball}.partial`, tarball);
}
const bytes = readFileSync(tarball);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const sha512 = createHash("sha512").update(bytes).digest("hex");
if (sha256 !== ALPINE.sha256 || sha512 !== ALPINE.sha512) {
	rmSync(tarball, { force: true });
	throw new Error(`the minirootfs does not match its pins (sha256 ${sha256})`);
}

// 2. Extracted without the archive's ownership.
const partial = join(p.dir, "rootfs.partial");
rmSync(partial, { recursive: true, force: true });
mkdirSync(partial, { mode: 0o755 });
execFileSync("tar", ["-xzf", tarball, "-C", partial, "--no-same-owner"], { env, stdio: "inherit" });

// 3. Packages installed inside, with the host's network, by Alpine's apk (it checks the repository's signatures).
const scratch = mkdtempSync(join(p.dir, "provision-"));
const work = join(scratch, "work");
mkdirSync(work);
const state = join(scratch, "runc");
const run = (label: string, script: string) => {
	const bundle = join(scratch, label);
	mkdirSync(bundle);
	const c = provisionConfig({
		rootfs: partial,
		work,
		args: ["/bin/sh", "-c", script],
		uid: process.getuid!(),
		gid: process.getgid!(),
		tmpMb: 512,
		fileMb: 1024,
		memoryMb: 2048,
		tasks: 256,
	});
	writeFileSync(join(bundle, "config.json"), JSON.stringify(c));
	execFileSync(
		"runc",
		["--root", state, "run", "--bundle", bundle, `iyye-provision-${randomBytes(4).toString("hex")}`],
		{
			env,
			stdio: "inherit",
			timeout: 600_000,
		},
	);
};
try {
	run("install", `apk add --no-cache ${ALPINE.packages.join(" ")}`);
	run("list", "apk info -v | sort > /work/packages.txt; python3 --version");
	const packages = readFileSync(join(work, "packages.txt"), "utf8").split("\n").filter(Boolean);
	// 4. The manifest, then the root takes its place (atomically: rename).
	const tree = treeHash(partial);
	rmSync(p.rootfs, { recursive: true, force: true });
	renameSync(partial, p.rootfs);
	if (treeHash(p.rootfs) !== tree) throw new Error("the tree changed while being moved");
	const manifest: SandboxManifest = {
		alpine: ALPINE.version,
		sha256: ALPINE.sha256,
		packages,
		tree,
		created_at: new Date().toISOString(),
	};
	writeFileSync(p.manifest, `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o600 });
	console.log(`provision-sandbox: done; ${packages.length} packages, tree ${tree.slice(0, 12)}`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
	rmSync(partial, { recursive: true, force: true });
}

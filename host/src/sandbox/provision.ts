// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The sandbox's root filesystem (owner decision 2026-10-12): Alpine's
 * minirootfs, pinned by version and both published digests, with python3
 * installed once from Alpine's signed repository by
 * `scripts/provision-sandbox.ts`. Its manifest (`provisioned.json`) records
 * the packages and a hash of the whole tree; the host refuses to run a
 * sandbox whose root no longer matches it (the pattern of Kev's
 * `provisioned.json`).
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export const ALPINE = {
	version: "3.24.2",
	arch: "aarch64",
	url: "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/alpine-minirootfs-3.24.2-aarch64.tar.gz",
	sha256: "9bf70a7f18ea44094cbb5f70c58f9af129c8214745743db0e68e5502cc2ce773",
	sha512:
		"c717aa68d67a354c7f46488eacb459c7a80951bcd7ea255f04a574aba1a6c5144f2117866e674f27fc92df0f05dd7685c1e6824b88ddd41994803d6fb025395c",
	packages: ["python3"],
} as const;

export interface SandboxManifest {
	alpine: string;
	sha256: string;
	packages: string[];
	tree: string;
	created_at: string;
}

/** A hash of every path, its type, mode, size and content (or link target), in sorted order. */
export function treeHash(root: string): string {
	const h = createHash("sha256");
	const walk = (rel: string) => {
		const abs = join(root, rel);
		const st = lstatSync(abs);
		const mode = (st.mode & 0o7777).toString(8);
		if (st.isSymbolicLink()) h.update(`l ${rel} ${readlinkSync(abs)}\n`);
		else if (st.isDirectory()) {
			h.update(`d ${rel} ${mode}\n`);
			for (const name of readdirSync(abs).sort()) walk(rel ? `${rel}/${name}` : name);
		} else if (st.isFile())
			h.update(`f ${rel} ${mode} ${createHash("sha256").update(readFileSync(abs)).digest("hex")}\n`);
		else h.update(`o ${rel} ${mode}\n`);
	};
	walk("");
	return h.digest("hex");
}

export function sandboxPaths(stateDir: string) {
	const dir = join(stateDir, "sandbox");
	return {
		dir,
		rootfs: join(dir, "rootfs"),
		manifest: join(dir, "provisioned.json"),
		work: join(dir, "work"),
		runs: join(dir, "runs"),
		state: join(dir, "runc"),
	};
}

/** Why the provisioned root cannot be used (null: it matches its manifest). Hashing it takes a second or two. */
export function checkProvisioned(stateDir: string): string | null {
	const p = sandboxPaths(stateDir);
	if (!existsSync(p.manifest) || !existsSync(p.rootfs)) return "not provisioned (node scripts/provision-sandbox.ts)";
	let m: SandboxManifest;
	try {
		m = JSON.parse(readFileSync(p.manifest, "utf8")) as SandboxManifest;
	} catch {
		return "its manifest is damaged; provision again";
	}
	if (m.alpine !== ALPINE.version || m.sha256 !== ALPINE.sha256) return "provisioned from another Alpine release";
	if (treeHash(p.rootfs) !== m.tree) return "its root filesystem no longer matches its manifest; provision again";
	return null;
}

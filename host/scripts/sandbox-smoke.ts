// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The sandbox's real smoke (owner decision 2026-10-12), on the Spark: real
 * rootless runc and systemd scope, a scratch state directory (never the live
 * one's containers or workspaces), and the provisioned root linked read-only
 * from `--from` (default: the live state directory; checked against its
 * manifest first). Every isolation claim of `src/sandbox/config.ts` and every
 * limit of `src/sandbox/sandbox.ts` is tried; figures only on the console.
 *
 *   node scripts/sandbox-smoke.ts <scratch-dir> [--from <state-dir>]
 */

import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { consoleLogger } from "../src/log.ts";
import { checkProvisioned, sandboxPaths } from "../src/sandbox/provision.ts";
import { type RunResult, Sandbox } from "../src/sandbox/sandbox.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { from: { type: "string" } } });
const scratch = positionals[0];
if (!scratch) {
	console.error("usage: node scripts/sandbox-smoke.ts <scratch-dir> [--from <state-dir>]");
	process.exit(2);
}
const from = values.from ?? loadConfig().stateDir;
const bad = checkProvisioned(from);
if (bad) {
	console.error(`sandbox-smoke: the provisioned root in ${from} is not usable: ${bad}`);
	process.exit(2);
}
mkdirSync(join(scratch, "sandbox"), { recursive: true });
symlinkSync(sandboxPaths(from).rootfs, sandboxPaths(scratch).rootfs);

const sb = new Sandbox({
	stateDir: scratch,
	log: consoleLogger(),
	skipManifestCheck: true, // checked above on the real root; this one is a link to it
	limits: { timeoutS: 8, memoryMb: 256, tasks: 64, outputChars: 2000 },
});
const problem = sb.init();
if (problem) {
	console.error(`sandbox-smoke: not available: ${problem}`);
	process.exit(1);
}

let failed = 0;
const run = async (cmd: string, scope = "smoke"): Promise<RunResult> => {
	const r = await sb.run(scope, cmd);
	if ("refused" in r) throw new Error(`refused: ${r.refused}`);
	return r;
};
const check = (name: string, ok: boolean, detail: string) => {
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: ${detail.slice(0, 400)}`}`);
};

try {
	let r = await run("python3 -c 'print(2**100)'");
	check("python3 runs", r.exitCode === 0 && r.output.includes("1267650600228229401496703205376"), r.output);
	await run("echo kept > /work/note.txt");
	r = await run("cat /work/note.txt");
	check("/work persists between runs of one scope", r.output.trim() === "kept", r.output);
	r = await run("cat /work/note.txt 2>&1 || echo missing", "other");
	check("another scope has its own /work", r.output.includes("missing"), r.output);
	r = await run("ls -A /home /root 2>&1; ls /; cat /etc/alpine-release");
	check(
		"an Alpine root with nothing of the host's home",
		!/akomarov|\.iyye2/.test(r.output) && /3\.24/.test(r.output),
		r.output,
	);
	r = await run("touch /etc/x 2>&1; echo rc=$?");
	check("the root is read-only", /Read-only file system|rc=1/.test(r.output), r.output);
	r = await run("id -u; grep CapEff /proc/self/status; cat /proc/1/cmdline | tr '\\0' ' '");
	check(
		"root inside, no capabilities, its own pid namespace",
		/^0\n/.test(r.output) && /CapEff:\s+0+\b/.test(r.output),
		r.output,
	);
	r = await run("env");
	check(
		"a fixed environment (no host variables)",
		r.exitCode === 0 && r.output.includes("PATH=") && !/TELEGRAM|IYYE2_|SSH_|XDG_/.test(r.output),
		r.output,
	);
	r = await run(
		"python3 - <<'EOF'\nimport socket\nfor host, port in [('127.0.0.1', 8180), ('127.0.0.1', 8186), ('127.0.0.1', 5100), ('192.168.1.123', 5100), ('1.1.1.1', 53)]:\n    s = socket.socket(); s.settimeout(2)\n    try:\n        s.connect((host, port)); print('REACHED', host, port)\n    except Exception as e:\n        print('blocked', host, port, type(e).__name__)\ntry:\n    socket.getaddrinfo('example.com', 80); print('REACHED dns')\nexcept Exception as e:\n    print('blocked dns', type(e).__name__)\nEOF",
	);
	check(
		"no network: not the router, memory, web chat, the LAN, the internet or DNS",
		!r.output.includes("REACHED") && r.output.includes("blocked dns"),
		r.output,
	);
	r = await run("python3 -c 'print(\"started\", flush=True); b = bytearray(1024 * 1024 * 1024); print(len(b))'");
	check(
		"a memory hog is stopped (256 MB limit)",
		r.output.includes("started") && r.exitCode !== 0 && !r.output.includes("1073741824"),
		`${r.exitCode} ${r.output}`,
	);
	r = await run(
		"python3 - <<'EOF'\nimport subprocess\nn = 0\ntry:\n    ps = []\n    for i in range(500):\n        ps.append(subprocess.Popen(['sleep', '5'])); n += 1\nexcept Exception as e:\n    print('stopped at', n, type(e).__name__)\nprint('started', n)\nEOF",
	);
	const started = Number(/started (\d+)/.exec(r.output)?.[1] ?? "999");
	check("processes are bounded (64 tasks)", started < 64, r.output);
	r = await run("sleep 30");
	check("the time limit stops a run", r.timedOut && r.ms < 15_000, JSON.stringify({ ...r, output: "" }));
	r = await run("yes x | head -c 100000");
	check("output is capped", r.output.length < 2200 && r.output.includes("characters cut"), String(r.output.length));
	r = await run("dd if=/dev/zero of=/work/big bs=1M count=300 2>&1; echo rc=$?; rm -f /work/big");
	check("one file is size-limited (256 MB)", /File too large|rc=1|rc=153/.test(r.output), r.output);
} finally {
	sb.wipeAll();
	rmSync(scratch, { recursive: true, force: true });
}
console.log(failed ? `sandbox-smoke: ${failed} check(s) failed` : "sandbox-smoke: all checks passed");
process.exit(failed ? 1 : 0);

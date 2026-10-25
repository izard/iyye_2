// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Serve the thinking tool's model to Iyye from another of the owner's machines
 * with rapid-mlx (2026-10-14; any OpenAI-compatible server would do, this
 * script starts rapid-mlx), run by the owner on that machine (the MBP):
 *
 *   cd host && node scripts/remote-thinking.ts <model directory> --listen 192.168.1.177 \
 *     [--port 8191] [--endpoint mbp] [--rapid-mlx <its path>] [-- <more rapid-mlx serve arguments>]
 *
 * - rapid-mlx listens only on 127.0.0.1 and checks the API key on every
 *   request (given in its environment, never on a command line); the LAN
 *   address gets only the HTTPS front, with the certificate and key that
 *   `remote-model.ts` uses (`remote-front.ts`), so the Spark keeps one copy.
 * - `--reasoning-parser qwen3` is passed unless the arguments after `--` name
 *   one: the host refuses a server that leaves the model's reasoning in its
 *   answer.
 * - On macOS it runs under `caffeinate -i`, so the machine does not sleep
 *   while idle. A closed lid on battery still sleeps: keep it on power.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { copyHint, ensureSecrets, freeLocalPort, startFront } from "./remote-front.ts";

const all = process.argv.slice(2);
const dash = all.indexOf("--");
const args = dash >= 0 ? all.slice(0, dash) : all;
const extra = dash >= 0 ? all.slice(dash + 1) : [];
const opt = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const modelDir = args[0];
const listen = opt("--listen");
const port = Number(opt("--port") ?? 8191);
const endpoint = opt("--endpoint") ?? "mbp";
const local = join(homedir(), ".local/bin/rapid-mlx");
const rapidMlx = opt("--rapid-mlx") ?? (existsSync(local) ? local : "rapid-mlx");
if (!modelDir || modelDir.startsWith("--") || !listen || !isIP(listen) || !Number.isInteger(port)) {
	console.error(
		"usage: node scripts/remote-thinking.ts <model directory> --listen <this machine's LAN address> [--port 8191] [--endpoint mbp] [--rapid-mlx <path>] [-- <rapid-mlx serve arguments>]",
	);
	process.exit(2);
}
const model = resolve(modelDir);
if (!existsSync(model)) {
	console.error(`${model} does not exist`);
	process.exit(2);
}
const name = basename(model);
if (!/^[A-Za-z0-9._-]+$/.test(name)) {
	console.error(`the model directory's name must be letters, digits, dots, dashes or underscores: ${name}`);
	process.exit(2);
}

const secrets = ensureSecrets(endpoint, listen);
const innerPort = await freeLocalPort();
const serverArgs = [
	"serve",
	model,
	"--host",
	"127.0.0.1",
	"--port",
	String(innerPort),
	...(extra.includes("--reasoning-parser") ? [] : ["--reasoning-parser", "qwen3"]),
	...extra,
];
console.log(`
${copyHint(secrets, endpoint)}
and start the host with IYYE2_THINKING_MODEL=${name}@${endpoint}=https://${listen}:${port}

Serving ${name} on https://${listen}:${port}: ${rapidMlx} ${serverArgs.join(" ")}
`);
const [cmd, cmdArgs] =
	process.platform === "darwin" ? ["/usr/bin/caffeinate", ["-i", rapidMlx, ...serverArgs]] : [rapidMlx, serverArgs];
// No stdin: rapid-mlx asks at startup whether to upgrade itself ("Run it now? [Y/n]") and would wait there,
// never listening; without a terminal it skips the question and serves.
const child = spawn(cmd, cmdArgs as string[], {
	stdio: ["ignore", "inherit", "inherit"],
	env: { ...process.env, RAPID_MLX_API_KEY: readFileSync(secrets.keyFile, "utf8").trim() },
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => {
	console.error(`${new Date().toISOString()} rapid-mlx exited (${signal ? `signal ${signal}` : `code ${code}`})`);
	process.exit(code ?? (signal ? 1 : 0));
});
startFront({
	secrets,
	listen,
	port,
	innerPort,
	onFail: () => {
		child.kill("SIGTERM");
		process.exit(1);
	},
});

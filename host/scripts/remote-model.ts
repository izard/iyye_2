// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Serve one registry model to Iyye from another of the owner's machines
 * (plan 0.012), run by the owner on that machine (the MBP):
 *
 *   cd host && node scripts/remote-model.ts qwen38-27b-tak --listen 192.168.1.177 [--port 8190] [--endpoint mbp]
 *
 * - llama-server serves the model with the registry's own server arguments
 *   (defaults, then the model's), so it matches what the host expects; the
 *   host refuses an endpoint whose file or context differs.
 * - HTTPS with a self-signed certificate and an API key, both made once in
 *   `~/.iyye-remote-model/` (0700; the key and the private key 0600). The key
 *   is given to llama-server as a file, never on a command line, and
 *   llama-server checks it on every request.
 * - TLS is this script's own (Node's), in front of llama-server: the MBP's
 *   llama.cpp is built without OpenSSL (2026-10-09: "the server is built
 *   without SSL support"). llama-server listens only on 127.0.0.1; the LAN
 *   address gets only this front, which forwards each request unchanged and
 *   streams the answer back.
 * - On macOS it runs under `caffeinate -i`, so the machine does not sleep
 *   while idle. A closed lid on battery still sleeps: keep it on power.
 *
 * The first run prints what to copy to the Spark: `cert.pem` and `api_key`
 * into `~/.iyye2/remote/<endpoint>/` (0600), and IYYE2_REMOTE_MODEL. The
 * certificate, key and front are shared with `remote-thinking.ts`
 * (`remote-front.ts`).
 */

import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { loadConfig } from "../src/config.ts";
import { serverCliArgs } from "../src/models/preset.ts";
import { findModel, loadRegistry } from "../src/models/registry.ts";
import { copyHint, ensureSecrets, freeLocalPort, startFront } from "./remote-front.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const modelName = args[0];
const listen = opt("--listen");
const port = Number(opt("--port") ?? 8190);
const endpoint = opt("--endpoint") ?? "mbp";
if (!modelName || modelName.startsWith("--") || !listen || !isIP(listen) || !Number.isInteger(port)) {
	console.error(
		"usage: node scripts/remote-model.ts <registry model> --listen <this machine's LAN address> [--port 8190] [--endpoint mbp]",
	);
	process.exit(2);
}

const config = loadConfig();
const registry = loadRegistry(config.modelsRegistry);
const spec = findModel(registry, modelName);
if (!spec) {
	console.error(`${modelName} is not in ${config.modelsRegistry}`);
	process.exit(2);
}
if (!spec.available) {
	console.error(`${modelName}: ${spec.path} is missing on this machine`);
	process.exit(2);
}

const secrets = ensureSecrets(endpoint, listen);
// llama-server on a free port of 127.0.0.1, reachable from the LAN only through the HTTPS front.
const innerPort = await freeLocalPort();
const serverArgs = [
	"--model",
	spec.path,
	"--alias",
	spec.name,
	...serverCliArgs(registry, spec),
	"--host",
	"127.0.0.1",
	"--port",
	String(innerPort),
	"--api-key-file",
	secrets.keyFile,
];
console.log(`
${copyHint(secrets, endpoint)}
and start the host with IYYE2_REMOTE_MODEL=${spec.name}@${endpoint}=https://${listen}:${port}
Then: /use ${spec.name}@${endpoint} background

Serving ${spec.name} on https://${listen}:${port}: ${config.llamaServer} ${serverArgs.join(" ")}
`);
const [cmd, cmdArgs] =
	process.platform === "darwin"
		? ["/usr/bin/caffeinate", ["-i", config.llamaServer, ...serverArgs]]
		: [config.llamaServer, serverArgs];
const child = spawn(cmd, cmdArgs as string[], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => {
	console.error(`${new Date().toISOString()} llama-server exited (${signal ? `signal ${signal}` : `code ${code}`})`);
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

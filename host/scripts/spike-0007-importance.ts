// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * S0 spike (plan 0.007): the `observation_importance` question on Kev, over
 * hand-made machine and workspace changes with an expected answer. Starts its
 * own Kev on a free port with a scratch state directory whose model cache
 * links to the provisioned one (like scripts/decisions-smoke.ts); never
 * touches the running host's Kev.
 *
 *   node scripts/spike-0007-importance.ts <scratch-dir>
 */

import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { DecisionService } from "../src/decisions/service.ts";
import { consoleLogger } from "../src/log.ts";

const scratch = process.argv[2];
if (!scratch) {
	console.error("usage: node scripts/spike-0007-importance.ts <scratch-dir>");
	process.exit(2);
}

const QUESTIONS: Record<string, string> = {
	importance_v1:
		"The state is a change Iyye's own probe observed on the computer it runs on or in its own code repository. Is this change worth remembering long-term and telling the owner about, rather than routine noise?",
	importance_v2:
		"The state describes a change between two measurements of the computer or of a code repository. Would the owner of this computer want to be told about this change today, because it may need attention or is a notable event, rather than being routine fluctuation?",
};

// [state, expected worth telling?]
const CASES: [Record<string, unknown>, boolean][] = [
	[
		{ domain: "machine", change: "free disk space on the home volume fell from 412 GB to 38 GB since yesterday" },
		true,
	],
	[
		{
			domain: "machine",
			change: "free disk space on the home volume changed from 412.3 GB to 411.9 GB since the last probe",
		},
		false,
	],
	[{ domain: "machine", change: "the memory service (Hindsight) restarted 4 times in the last hour" }, true],
	[{ domain: "machine", change: "CPU load average changed from 2.1 to 2.4" }, false],
	[{ domain: "machine", change: "reclaimable memory dropped from 66 GB to 3 GB; swap grew from 0 to 18 GB" }, true],
	[{ domain: "machine", change: "uptime increased by 2 hours" }, false],
	[{ domain: "machine", change: "loaded models changed: gemma-4-26B unloaded at night, as scheduled" }, false],
	[{ domain: "machine", change: "free disk space is 9% of the volume, below the 10% warning level" }, true],
	[
		{
			domain: "workspace",
			change:
				"3 new commits since yesterday: 'Add a disk watch helper', 'Raise the disk threshold to 80 GB', 'Add notes'",
		},
		true,
	],
	[{ domain: "workspace", change: "no new commits; working tree clean" }, false],
	[{ domain: "workspace", change: "a file was changed but not committed for 3 days: disk_watch.py" }, true],
	[{ domain: "workspace", change: "the commit count went from 41 to 41" }, false],
	[{ domain: "machine", change: "the decision service (Kev) has been down for 2 hours and could not restart" }, true],
	[{ domain: "machine", change: "the temperature sensor reading moved from 48 °C to 49 °C" }, false],
	[
		{
			domain: "workspace",
			change: "the latest commit deleted 1200 lines from the workspace, including the tests folder",
		},
		true,
	],
];

const config = loadConfig();
const live = join(config.stateDir, "decisions");
const stateDir = join(scratch, "decisions");
mkdirSync(stateDir, { recursive: true });
if (!existsSync(join(stateDir, "hf"))) symlinkSync(join(live, "hf"), join(stateDir, "hf"));
copyFileSync(join(live, "provisioned.json"), join(stateDir, "provisioned.json"));
const port = await new Promise<number>((resolve) => {
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const p = (s.address() as { port: number }).port;
		s.close(() => resolve(p));
	});
});
const svc = new DecisionService({
	installDir: config.decisions.installDir,
	stateDir,
	port,
	model: config.decisions.model,
	log: consoleLogger(),
	healthIntervalMs: 5000,
});
svc.start();
const out: unknown[] = [];
try {
	const t0 = Date.now();
	while (svc.status.state !== "up") {
		if (["not installed", "needs provisioning"].includes(svc.status.state) || Date.now() - t0 > 180_000)
			throw new Error(`not up: ${svc.status.state}: ${svc.status.detail}`);
		await new Promise((r) => setTimeout(r, 500));
	}
	for (const [state, expected] of CASES) {
		const res = await fetch(`${svc.baseUrl}/v1/systemone`, {
			method: "POST",
			headers: { authorization: `Bearer ${svc.apiKey()}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: "kev-latest",
				state,
				questions: Object.fromEntries(
					Object.entries(QUESTIONS).map(([id, instructions]) => [id, { type: "noul", instructions }]),
				),
			}),
		});
		const body = (await res.json()) as { answers: Record<string, { noul: number }> };
		const ps = Object.fromEntries(Object.entries(body.answers).map(([q, a]) => [q, Number(a.noul.toFixed(3))]));
		out.push({ expected, ps, change: state.change });
		console.log(expected ? "WORTH" : "noise", JSON.stringify(ps), state.change);
	}
	for (const q of Object.keys(QUESTIONS)) {
		const rows = out as { expected: boolean; ps: Record<string, number> }[];
		const yes = rows.filter((r) => r.expected).map((r) => r.ps[q]!);
		const no = rows.filter((r) => !r.expected).map((r) => r.ps[q]!);
		const band = rows.filter((r) => r.ps[q]! > 0.3 && r.ps[q]! < 0.6).length;
		const agree = rows.filter((r) => (r.ps[q]! >= 0.6 && r.expected) || (r.ps[q]! <= 0.3 && !r.expected)).length;
		console.log(
			`${q}: worth min ${Math.min(...yes).toFixed(2)} · noise max ${Math.max(...no).toFixed(2)} · at the 0.3/0.6 band: ${agree}/${rows.length} agree, ${band} unsure`,
		);
	}
} finally {
	await svc.stop();
	writeFileSync(join(scratch, "importance.json"), JSON.stringify(out, null, 2));
}

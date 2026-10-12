// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The sandbox's OCI runtime configuration (owner decision 2026-10-12): a
 * rootless runc container, built here and nowhere else, so its isolation is
 * one reviewed function with tests.
 *
 * - **No network:** its own network namespace, loopback only and down. The
 *   host's loopback holds the model router (no auth), Hindsight (unscoped
 *   memory), Postgres, Kev, SearXNG and the web chat; a run must reach none
 *   of them. `runConfig` refuses to return a configuration without it.
 * - **Filesystem:** the provisioned Alpine root, read-only; `/work` (the
 *   conversation's workspace) the only host directory, read-write; `/tmp` a
 *   size-capped tmpfs. Nothing of the home directory or Iyye's state.
 * - **Privileges:** user namespace (root inside is the host user outside), no
 *   capabilities, no new privileges, a fixed environment (no host variables).
 * - **Limits:** memory (no swap) and the number of tasks on the container's
 *   own cgroup (`linux.resources`; runc creates it in the systemd user tree
 *   the runner's scope delegates: a scope's own limits would not hold, since
 *   runc moves the container out of it); file sizes and open files by
 *   rlimits. CPU is bounded only by the wall-clock limit (the user tree does
 *   not delegate the cpu controller).
 *
 * `provisionConfig` is the one configuration with the host's network: used
 * only by `scripts/provision-sandbox.ts` to install packages into the root.
 */

export interface RunConfigInput {
	rootfs: string;
	work: string;
	args: string[];
	uid: number;
	gid: number;
	tmpMb: number;
	fileMb: number;
	/** Kernel limits on the container's own cgroup (runc creates it under the delegated systemd user tree). */
	memoryMb: number;
	tasks: number;
}

const ENV = [
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	"HOME=/work",
	"LANG=C.UTF-8",
	"PYTHONDONTWRITEBYTECODE=1",
	"PYTHONUNBUFFERED=1",
];

const NAMESPACES = ["pid", "ipc", "uts", "mount", "user", "network", "cgroup"] as const;

function base(i: RunConfigInput, readonlyRoot: boolean, namespaces: readonly string[]) {
	return {
		ociVersion: "1.2.0",
		process: {
			terminal: false,
			user: { uid: 0, gid: 0 },
			args: i.args,
			env: ENV,
			cwd: "/work",
			capabilities: { bounding: [], effective: [], inheritable: [], permitted: [], ambient: [] },
			rlimits: [
				{ type: "RLIMIT_NOFILE", hard: 256, soft: 256 },
				{ type: "RLIMIT_FSIZE", hard: i.fileMb * 1024 * 1024, soft: i.fileMb * 1024 * 1024 },
				{ type: "RLIMIT_CORE", hard: 0, soft: 0 },
			],
			noNewPrivileges: true,
		},
		root: { path: i.rootfs, readonly: readonlyRoot },
		hostname: "sandbox",
		mounts: [
			{ destination: "/proc", type: "proc", source: "proc" },
			{
				destination: "/dev",
				type: "tmpfs",
				source: "tmpfs",
				options: ["nosuid", "strictatime", "mode=755", "size=65536k"],
			},
			{
				destination: "/dev/pts",
				type: "devpts",
				source: "devpts",
				options: ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"],
			},
			{
				destination: "/dev/shm",
				type: "tmpfs",
				source: "shm",
				options: ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"],
			},
			{ destination: "/dev/mqueue", type: "mqueue", source: "mqueue", options: ["nosuid", "noexec", "nodev"] },
			{ destination: "/sys", type: "none", source: "/sys", options: ["rbind", "nosuid", "noexec", "nodev", "ro"] },
			{
				destination: "/tmp",
				type: "tmpfs",
				source: "tmpfs",
				options: ["nosuid", "nodev", "mode=1777", `size=${i.tmpMb}m`],
			},
			{ destination: "/work", type: "bind", source: i.work, options: ["rbind", "rw", "nosuid", "nodev"] },
		],
		linux: {
			resources: {
				memory: { limit: i.memoryMb * 1024 * 1024, swap: i.memoryMb * 1024 * 1024 },
				pids: { limit: i.tasks },
			},
			uidMappings: [{ containerID: 0, hostID: i.uid, size: 1 }],
			gidMappings: [{ containerID: 0, hostID: i.gid, size: 1 }],
			namespaces: namespaces.map((type) => ({ type })),
			maskedPaths: [
				"/proc/acpi",
				"/proc/asound",
				"/proc/kcore",
				"/proc/keys",
				"/proc/latency_stats",
				"/proc/timer_list",
				"/proc/timer_stats",
				"/proc/sched_debug",
				"/proc/scsi",
				"/sys/firmware",
				"/sys/devices/virtual/powercap",
			],
			readonlyPaths: ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
		},
	};
}

export type OciConfig = ReturnType<typeof base>;

/** A run's configuration: always its own network namespace (checked), the root read-only. */
export function runConfig(i: RunConfigInput): OciConfig {
	const c = base(i, true, NAMESPACES);
	assertIsolated(c);
	return c;
}

/** The isolation every run configuration must have; throws otherwise (a test calls it on `runConfig`'s output). */
export function assertIsolated(c: OciConfig): void {
	const ns = new Set(c.linux.namespaces.map((n) => n.type));
	for (const need of NAMESPACES) if (!ns.has(need)) throw new Error(`sandbox: the ${need} namespace is missing`);
	if (!c.root.readonly) throw new Error("sandbox: the root must be read-only");
	if (!c.process.noNewPrivileges) throw new Error("sandbox: noNewPrivileges must be set");
	if (!(c.linux.resources.memory.limit > 0) || !(c.linux.resources.pids.limit > 0))
		throw new Error("sandbox: memory and task limits must be set");
	if (Object.values(c.process.capabilities).some((list) => list.length > 0))
		throw new Error("sandbox: no capabilities may be granted");
	const binds = c.mounts.filter((m) => m.type === "bind" || m.options?.includes("rbind"));
	for (const b of binds)
		if (b.destination !== "/work" && !(b.destination === "/sys" && b.options?.includes("ro")))
			throw new Error(`sandbox: no host directory but /work may be mounted (${b.destination})`);
}

/**
 * The provisioning configuration (`scripts/provision-sandbox.ts` only): the host's network (no network
 * namespace) and its resolver, a writable root, to install packages with Alpine's signed repository.
 */
export function provisionConfig(i: Omit<RunConfigInput, "work"> & { work: string }): OciConfig {
	const c = base(
		i,
		false,
		NAMESPACES.filter((n) => n !== "network"),
	);
	c.mounts.push({
		destination: "/etc/resolv.conf",
		type: "bind",
		source: "/etc/resolv.conf",
		options: ["rbind", "ro"],
	});
	return c;
}

// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The PostgreSQL cluster that holds Iyye's long-term memory (plan 0.002 L1,
 * owner decision §8.4: conda-forge PostgreSQL with pgvector in `memory/pg`).
 *
 * The cluster is owned through `pg_ctl` on Iyye's own data directory, so
 * start, stop, status and crash adoption never touch any other Postgres:
 * - created once with `initdb` (scram-sha-256, password from a 0600 file);
 * - an `iyye.conf` include pins it to 127.0.0.1:<port>, TCP only (no Unix
 *   socket), and a connection limit sized for Hindsight's capped pool;
 * - the password is never on a command line: `--pwfile` for initdb and
 *   `PGPASSWORD` in the child environment for psql.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "../log.ts";
import { portListener } from "../process/supervised.ts";

const run = promisify(execFile);

export const DB_USER = "iyye";
export const DB_NAME = "hindsight";

export interface PostgresOptions {
	/** Directory holding bin/initdb, bin/pg_ctl, bin/psql (the conda prefix). */
	binDir: string;
	/** Iyye's memory state directory; the cluster lives in `<stateDir>/pgdata`. */
	stateDir: string;
	port: number;
	log: Logger;
	maxConnections?: number;
}

export class PostgresError extends Error {}

export class PostgresCluster {
	private readonly o: Required<PostgresOptions>;

	constructor(opts: PostgresOptions) {
		this.o = { maxConnections: 50, ...opts };
	}

	get dataDir(): string {
		return join(this.o.stateDir, "pgdata");
	}

	private get passwordFile(): string {
		return join(this.o.stateDir, "secrets", "db_password");
	}

	/** The connection URL for Hindsight. Contains the password: never log it. */
	url(): string {
		return `postgresql://${DB_USER}:${this.password()}@127.0.0.1:${this.o.port}/${DB_NAME}`;
	}

	installed(): boolean {
		return ["initdb", "pg_ctl", "psql", "postgres"].every((b) => existsSync(join(this.o.binDir, b)));
	}

	/** Create the cluster on first use; (re)write its connection settings every time. */
	async ensureCluster(): Promise<void> {
		this.password(); // initdb reads it from the 0600 file
		if (!existsSync(join(this.dataDir, "PG_VERSION"))) {
			this.o.log.info("memory: creating the PostgreSQL cluster", { dataDir: this.dataDir });
			await this.exec("initdb", [
				"-D",
				this.dataDir,
				"-U",
				DB_USER,
				"--auth=scram-sha-256",
				`--pwfile=${this.passwordFile}`,
				"-E",
				"UTF8",
				"--locale=C",
			]);
			const conf = join(this.dataDir, "postgresql.conf");
			writeFileSync(conf, `${readFileSync(conf, "utf8")}\ninclude_if_exists = 'iyye.conf'\n`);
		}
		writeFileSync(
			join(this.dataDir, "iyye.conf"),
			[
				"# Written by the Iyye host on every start; edits are overwritten.",
				`port = ${this.o.port}`,
				"listen_addresses = '127.0.0.1'",
				"unix_socket_directories = ''",
				`max_connections = ${this.o.maxConnections}`,
				"",
			].join("\n"),
		);
	}

	/** True when a postmaster is running on this cluster's data directory. */
	async running(): Promise<boolean> {
		try {
			await this.exec("pg_ctl", ["status", "-D", this.dataDir]);
			return true;
		} catch {
			return false;
		}
	}

	/** Start (or keep, after a host crash) the cluster, then make sure the database and pgvector exist. */
	async start(): Promise<"started" | "adopted"> {
		await this.ensureCluster();
		let how: "started" | "adopted" = "adopted";
		if (!(await this.running())) {
			const listener = await portListener(this.o.port);
			if (listener) {
				throw new PostgresError(`port ${this.o.port} is already in use by ${listener}; not touching it`);
			}
			mkdirSync(join(this.o.stateDir, "logs"), { recursive: true });
			await this.exec("pg_ctl", [
				"start",
				"-D",
				this.dataDir,
				"-l",
				join(this.o.stateDir, "logs", "postgres.log"),
				"-w",
				"-t",
				"60",
			]);
			how = "started";
		}
		const exists = (await this.psql("postgres", `SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'`)).trim();
		if (exists !== "1") await this.psql("postgres", `CREATE DATABASE ${DB_NAME}`);
		await this.psql(DB_NAME, "CREATE EXTENSION IF NOT EXISTS vector");
		this.o.log.info(`memory: PostgreSQL ${how}`, { port: this.o.port });
		return how;
	}

	async stop(): Promise<void> {
		if (!(await this.running())) return;
		await this.exec("pg_ctl", ["stop", "-D", this.dataDir, "-m", "fast", "-w", "-t", "60"]);
		this.o.log.info("memory: PostgreSQL stopped");
	}

	async psql(database: string, sql: string): Promise<string> {
		const { stdout } = await this.exec("psql", [
			"-h",
			"127.0.0.1",
			"-p",
			String(this.o.port),
			"-U",
			DB_USER,
			"-d",
			database,
			"-Atc",
			sql,
		]);
		return stdout;
	}

	/** The cluster password, created once (0600). */
	private password(): string {
		if (!existsSync(this.passwordFile)) {
			mkdirSync(join(this.o.stateDir, "secrets"), { recursive: true, mode: 0o700 });
			writeFileSync(this.passwordFile, randomBytes(24).toString("hex"), { mode: 0o600 });
		}
		chmodSync(this.passwordFile, 0o600);
		return readFileSync(this.passwordFile, "utf8").trim();
	}

	private async exec(bin: string, args: string[]): Promise<{ stdout: string }> {
		try {
			return await run(join(this.o.binDir, bin), args, {
				env: { PATH: "/usr/bin:/bin", PGPASSWORD: this.password(), LC_ALL: "C" },
				timeout: 120_000,
			});
		} catch (err) {
			const e = err as { stderr?: string; message: string };
			throw new PostgresError(`${bin} failed: ${(e.stderr || e.message).trim().split("\n").slice(-2).join(" ")}`);
		}
	}
}

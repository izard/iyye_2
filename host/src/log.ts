// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

export type LogFields = Record<string, unknown>;

export interface Logger {
	info(msg: string, fields?: LogFields): void;
	warn(msg: string, fields?: LogFields): void;
	error(msg: string, fields?: LogFields): void;
}

/** One line per record on stderr: `time level message {fields}`. */
export function consoleLogger(): Logger {
	const write = (level: string, msg: string, fields?: LogFields) => {
		const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
		process.stderr.write(`${new Date().toISOString()} ${level} ${msg}${extra}\n`);
	};
	return {
		info: (m, f) => write("INFO", m, f),
		warn: (m, f) => write("WARN", m, f),
		error: (m, f) => write("ERROR", m, f),
	};
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

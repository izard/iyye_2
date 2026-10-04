// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner authentication for the local web chat (plan M4, HLD §9.2). Binding to
 * 127.0.0.1 is a location, not an identity: any local process or a web page
 * using DNS rebinding could reach the port. The owner proves themselves with
 * a token only they can read (a 0600 file in the state directory), exchanged
 * once for a session cookie.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../../state/db.ts";
import { createWebSession, deleteWebSession, findWebSession, pruneWebSessions } from "../../state/web.ts";

export const SESSION_COOKIE = "iyye_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

/** Read the owner token, creating it (32 random bytes, mode 0600) on first start. */
export function ensureOwnerToken(stateDir: string): { token: string; created: boolean } {
	const path = join(stateDir, "owner_token");
	if (existsSync(path)) {
		if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
		const token = readFileSync(path, "utf8").trim();
		if (/^[0-9a-f]{64}$/.test(token)) return { token, created: false };
	}
	const token = randomBytes(32).toString("hex");
	writeFileSync(path, `${token}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return { token, created: true };
}

/** Constant-time comparison; unequal lengths are rejected before timingSafeEqual (which would throw). */
export function tokenMatches(presented: unknown, expected: string): boolean {
	if (typeof presented !== "string") return false;
	const a = Buffer.from(presented);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

function hashId(id: string): string {
	return createHash("sha256").update(id).digest("hex");
}

export interface NewSession {
	id: string;
	csrf: string;
}

export class WebSessions {
	private readonly db: Db;
	private readonly now: () => Date;

	constructor(db: Db, now: () => Date = () => new Date()) {
		this.db = db;
		this.now = now;
	}

	create(): NewSession {
		pruneWebSessions(this.db, this.now());
		const id = randomBytes(32).toString("base64url");
		const csrf = randomBytes(24).toString("base64url");
		createWebSession(this.db, hashId(id), csrf, this.now(), SESSION_TTL_MS);
		return { id, csrf };
	}

	/** The session's CSRF token if the cookie names a live session. */
	lookup(cookieHeader: string | undefined): { id: string; csrf: string } | null {
		const id = parseCookies(cookieHeader)[SESSION_COOKIE];
		if (!id) return null;
		const s = findWebSession(this.db, hashId(id), this.now());
		return s ? { id, csrf: s.csrf } : null;
	}

	destroy(id: string): void {
		deleteWebSession(this.db, hashId(id));
	}

	static cookie(id: string): string {
		// No Secure flag: this is plain HTTP on 127.0.0.1.
		return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
	}

	static clearCookie(): string {
		return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
	}
}

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (header ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
}

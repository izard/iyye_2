// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The guarded HTTP client (plan 0.004 §3.2): the only way a tool reads the
 * network. HLD §9.1: typed HTTP read tools enforce allowed methods and
 * destinations.
 *
 * - GET only; `http`/`https` only; ports 80 and 443 only; no credentials in
 *   the URL; no cookies, no Referer, a fixed User-Agent.
 * - Every address a hostname resolves to is checked, and one blocked address
 *   blocks the whole request: loopback, private, link-local, CGNAT,
 *   multicast, documentation, reserved, IPv6 ULA/link-local, and IPv4 inside
 *   IPv6 (mapped, NAT64) are refused. On this machine that protects
 *   Hindsight, Kev, llama.cpp, PostgreSQL and the owner's web chat, which all
 *   listen on 127.0.0.1.
 * - No DNS rebinding: the connection goes to the address that passed the
 *   check (a pinned `lookup`); TLS still verifies the hostname.
 * - Redirects are followed by hand, at most 5, each hop checked again.
 * - Limits: total time, body size (after decompression, so a compression
 *   bomb stops at the cap), text-like content types only.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export class FetchRefused extends Error {}

export interface FetchedPage {
	/** The URL that answered, after redirects. */
	url: string;
	status: number;
	contentType: string;
	body: string;
	/** True when the body was cut at the size cap. */
	truncated: boolean;
}

export interface GuardedHttpOptions {
	userAgent?: string;
	/** Total time for one request, all redirects included. */
	timeoutMs?: number;
	/** Bytes kept after decompression. */
	maxBytes?: number;
	maxRedirects?: number;
	/** Tests: name resolution. Defaults to the system resolver, all addresses. */
	resolve?: (host: string) => Promise<string[]>;
	/** Tests: the address check. Defaults to `isBlockedAddress`. */
	isBlocked?: (ip: string) => boolean;
	/** Tests: allowed ports. Defaults to 80 and 443. */
	ports?: number[];
}

const TEXT_TYPES = /^(text\/(html|plain|xml)|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))$/;

const BLOCKED = (() => {
	const b = new BlockList();
	for (const [net, bits] of [
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["127.0.0.0", 8],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.0.0.0", 24],
		["192.0.2.0", 24],
		["192.88.99.0", 24],
		["192.168.0.0", 16],
		["198.18.0.0", 15],
		["198.51.100.0", 24],
		["203.0.113.0", 24],
		["224.0.0.0", 4],
		["240.0.0.0", 4],
	] as const) {
		b.addSubnet(net, bits, "ipv4");
	}
	for (const [net, bits] of [
		["::", 128],
		["::1", 128],
		["100::", 64],
		["2001:db8::", 32],
		["2002::", 16],
		["fc00::", 7],
		["fe80::", 10],
		["fec0::", 10],
		["ff00::", 8],
	] as const) {
		b.addSubnet(net, bits, "ipv6");
	}
	return b;
})();

/** True for any address a tool must never reach. Unparseable input is blocked. */
export function isBlockedAddress(ip: string): boolean {
	const family = isIP(ip);
	if (family === 4) return BLOCKED.check(ip, "ipv4");
	if (family !== 6) return true;
	const lower = ip.toLowerCase();
	// IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64 (64:ff9b::a.b.c.d): check the IPv4.
	const embedded = embeddedIpv4(lower);
	if (embedded !== null) return embedded === "" || isBlockedAddress(embedded);
	return BLOCKED.check(lower, "ipv6");
}

/** The IPv4 address carried inside an IPv6 one, "" if malformed, null if none. */
function embeddedIpv4(ip: string): string | null {
	const m = /^(?:::ffff:|::|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(ip);
	if (!m) return null;
	if (m[1]) return isIP(m[1]) === 4 ? m[1] : "";
	const hi = Number.parseInt(m[2]!, 16);
	const lo = Number.parseInt(m[3]!, 16);
	return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export class GuardedHttp {
	private readonly o: Required<GuardedHttpOptions>;

	constructor(opts: GuardedHttpOptions = {}) {
		this.o = {
			userAgent: "Iyye/2.0 (self-hosted personal assistant; read-only web tool)",
			timeoutMs: 20_000,
			maxBytes: 2 * 1024 * 1024,
			maxRedirects: 5,
			resolve: async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address),
			isBlocked: isBlockedAddress,
			ports: [80, 443],
			...opts,
		};
	}

	/** GET a text resource. Throws FetchRefused (policy) or an Error (network, HTTP). */
	async get(rawUrl: string): Promise<FetchedPage> {
		const deadline = Date.now() + this.o.timeoutMs;
		let url = this.checkUrl(rawUrl);
		for (let hop = 0; ; hop++) {
			const address = await this.checkHost(url.hostname);
			const res = await this.request(url, address, deadline);
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				if (hop >= this.o.maxRedirects) throw new FetchRefused(`more than ${this.o.maxRedirects} redirects`);
				url = this.checkUrl(new URL(res.headers.location, url).toString());
				continue;
			}
			const contentType = (res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
			if (status >= 400) {
				res.resume();
				throw new Error(`HTTP ${status} from ${url.host}`);
			}
			if (!TEXT_TYPES.test(contentType)) {
				res.resume();
				throw new FetchRefused(`not a text page (${contentType || "no content type"})`);
			}
			const { bytes, truncated } = await this.readBody(res, deadline);
			return {
				url: url.toString(),
				status,
				contentType,
				body: decode(bytes, String(res.headers["content-type"] ?? ""), contentType),
				truncated,
			};
		}
	}

	private checkUrl(raw: string): URL {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new FetchRefused("not a valid URL");
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchRefused("only http and https URLs");
		if (url.username || url.password) throw new FetchRefused("URLs with credentials are not fetched");
		const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
		if (!this.o.ports.includes(port)) throw new FetchRefused("only ports 80 and 443");
		url.hash = "";
		return url;
	}

	/** Resolve and check every address; return the one to connect to. */
	private async checkHost(hostname: string): Promise<string> {
		const host = hostname.replace(/^\[|\]$/g, "");
		if (/^localhost\.?$/i.test(host) || /\.localhost\.?$/i.test(host))
			throw new FetchRefused("local addresses are not fetched");
		const addresses = isIP(host) ? [host] : await this.o.resolve(host).catch(() => [] as string[]);
		if (addresses.length === 0) throw new Error(`cannot resolve ${host}`);
		if (addresses.some((a) => this.o.isBlocked(a)))
			throw new FetchRefused("local or private addresses are not fetched");
		return addresses[0]!;
	}

	private request(url: URL, address: string, deadline: number): Promise<IncomingMessage> {
		const timeout = deadline - Date.now();
		if (timeout <= 0) return Promise.reject(new Error("timed out"));
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		return new Promise((resolve, reject) => {
			const req = send(
				url,
				{
					method: "GET",
					headers: {
						"user-agent": this.o.userAgent,
						accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1",
						"accept-encoding": "gzip, deflate, br",
						"accept-language": "en,ru;q=0.8,*;q=0.5",
					},
					// Connect to the checked address only; the hostname still goes to TLS (SNI and verification).
					lookup: (_host, opts, cb) => {
						const family = isIP(address);
						if ((opts as { all?: boolean }).all) {
							(cb as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
						} else {
							(cb as (e: null, a: string, f: number) => void)(null, address, family);
						}
					},
					timeout,
				},
				resolve,
			);
			req.on("timeout", () => req.destroy(new Error("timed out")));
			req.on("error", reject);
			req.end();
		});
	}

	private readBody(res: IncomingMessage, deadline: number): Promise<{ bytes: Buffer; truncated: boolean }> {
		const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
		const stream =
			enc === "gzip" || enc === "x-gzip"
				? res.pipe(createGunzip())
				: enc === "br"
					? res.pipe(createBrotliDecompress())
					: enc === "deflate"
						? res.pipe(createInflate())
						: res;
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			let done = false;
			const finish = (truncated: boolean) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				res.destroy();
				resolve({ bytes: Buffer.concat(chunks), truncated });
			};
			const timer = setTimeout(
				() => {
					if (done) return;
					done = true;
					res.destroy();
					reject(new Error("timed out"));
				},
				Math.max(1, deadline - Date.now()),
			);
			stream.on("data", (c: Buffer) => {
				if (done) return;
				const room = this.o.maxBytes - size;
				if (c.length >= room) {
					chunks.push(c.subarray(0, room));
					size += room;
					finish(true);
					return;
				}
				chunks.push(c);
				size += c.length;
			});
			stream.on("end", () => finish(false));
			stream.on("error", (err) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				reject(err);
			});
		});
	}
}

/** Decode with the header's charset, else an HTML meta charset, else UTF-8. */
function decode(bytes: Buffer, header: string, contentType: string): string {
	let charset = /charset=["']?([\w-]+)/i.exec(header)?.[1];
	if (!charset && contentType.includes("html")) {
		const head = bytes.subarray(0, 4096).toString("latin1");
		charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
	}
	try {
		return new TextDecoder(charset ?? "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

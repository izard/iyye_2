// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Downloading an image someone sent on Telegram (2026-10-09, the vision tool):
 * `getFile`, then the file itself. Only the host calls this, with a file id
 * from an admitted event, never a URL or id a model wrote.
 *
 * - The download URL holds the bot token: it is never logged, and every error
 *   message is scrubbed of it.
 * - At most `maxBytes`, checked as it arrives, and the bytes must be a JPEG,
 *   PNG or WebP image, whatever Telegram or the sender said.
 */

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

export class TelegramFileError extends Error {}

export class TelegramFiles {
	private readonly token: string;
	private readonly apiBase: string;

	constructor(opts: { token: string; apiBase?: string }) {
		this.token = opts.token;
		this.apiBase = opts.apiBase ?? "https://api.telegram.org";
	}

	async download(fileId: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: ImageMime }> {
		try {
			const res = await fetch(`${this.apiBase}/bot${this.token}/getFile`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ file_id: fileId }),
				...(signal ? { signal } : {}),
			});
			const body = (await res.json().catch(() => ({}))) as {
				ok?: boolean;
				description?: string;
				result?: { file_path?: string; file_size?: number };
			};
			const path = body.result?.file_path;
			if (!res.ok || !body.ok || typeof path !== "string")
				throw new TelegramFileError(`Telegram has no such file (${body.description ?? `HTTP ${res.status}`})`);
			if ((body.result?.file_size ?? 0) > maxBytes) throw new TelegramFileError("the image is too large");
			const file = await fetch(
				`${this.apiBase}/file/bot${this.token}/${path.split("/").map(encodeURIComponent).join("/")}`,
				{
					...(signal ? { signal } : {}),
				},
			);
			if (!file.ok || !file.body) throw new TelegramFileError(`the download failed (HTTP ${file.status})`);
			const chunks: Buffer[] = [];
			let total = 0;
			for await (const chunk of file.body as unknown as AsyncIterable<Uint8Array>) {
				total += chunk.byteLength;
				if (total > maxBytes) throw new TelegramFileError("the image is too large");
				chunks.push(Buffer.from(chunk));
			}
			const bytes = Buffer.concat(chunks);
			const mime = imageMime(bytes);
			if (!mime) throw new TelegramFileError("the file is not a JPEG, PNG or WebP image");
			return { bytes, mime };
		} catch (err) {
			const message = (err as Error).message.split(this.token).join("<token>");
			throw err instanceof TelegramFileError ? err : new TelegramFileError(message);
		}
	}
}

/** The image type by its first bytes, or null. */
export function imageMime(b: Buffer): ImageMime | null {
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
		return "image/png";
	if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP")
		return "image/webp";
	return null;
}

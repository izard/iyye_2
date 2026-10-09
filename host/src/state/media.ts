// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";

/** Where the image an event came with is kept once looked at (`<state>/media/<event id>`). Event ids are host-made. */
export function mediaPath(mediaDir: string, eventId: string): string {
	if (!/^[A-Za-z0-9-]+$/.test(eventId)) throw new Error("bad event id");
	return join(mediaDir, eventId);
}

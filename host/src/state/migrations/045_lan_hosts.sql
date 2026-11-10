-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.018 W2: the hosts Iyye has seen on its local network.
--
-- `id` is a hash of the hardware address; the address itself, a host name or
-- a vendor is never kept. `address` is the host's private address when last
-- seen. `label` is the owner's word for it (`/self host <id> <label>`).
-- `ignored`: the owner asked to forget it; the row stays as the id alone, so
-- the host is not listed again when it reappears.

CREATE TABLE lan_hosts (
	id TEXT PRIMARY KEY,
	address TEXT,
	first_seen TEXT NOT NULL,
	last_seen TEXT NOT NULL,
	-- Days it was seen on, and the last of them (UTC day).
	days_seen INTEGER NOT NULL DEFAULT 1,
	last_day TEXT NOT NULL,
	label TEXT,
	ignored INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0, 1))
);

-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Identity links (plan 0.005 I1, HLD §6.2): an account (a contact with its
-- channel bindings) belongs to a person (another contact, or the owner).
-- Only a local owner operation creates or removes a link. Links are one
-- level: a person is never itself an account of someone else.

CREATE TABLE contact_links (
	account_id TEXT PRIMARY KEY REFERENCES contacts (id),
	person_id TEXT NOT NULL REFERENCES contacts (id),
	linked_by TEXT NOT NULL,
	linked_at TEXT NOT NULL,
	CHECK (account_id <> person_id)
);

CREATE INDEX contact_links_person ON contact_links (person_id);

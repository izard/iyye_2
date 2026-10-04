// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0
//
// Owner web chat UI. All text is rendered with textContent, never as HTML.
"use strict";

const $ = (id) => document.getElementById(id);
const state = { csrf: null, after: 0, answered: new Set(), pending: new Map(), acked: new Set() };

async function api(path, options = {}) {
	const headers = { "content-type": "application/json" };
	if (state.csrf) headers["x-csrf-token"] = state.csrf;
	const res = await fetch(path, { credentials: "same-origin", ...options, headers });
	const body = await res.json().catch(() => ({}));
	if (res.status === 401 && path !== "/api/login") showLogin();
	return { status: res.status, body };
}

function showLogin(message) {
	state.csrf = null;
	$("attention").hidden = true;
	$("attention-toggle").hidden = true;
	$("chat").hidden = true;
	$("models").hidden = true;
	$("models-toggle").hidden = true;
	$("login").hidden = false;
	$("login-error").textContent = message || "";
}

function showChat(csrf) {
	state.csrf = csrf;
	$("login").hidden = true;
	$("chat").hidden = false;
	$("models-toggle").hidden = false;
	$("input").focus();
}

async function login(token) {
	const r = await api("/api/login", { method: "POST", body: JSON.stringify({ token }) });
	if (r.status === 200) showChat(r.body.csrf);
	else showLogin("That token was not accepted.");
}

const META = {
	user: (m) => (state.answered.has(m.event_id) ? "" : "waiting for Iyye…"),
	reply: (m) => (m.receipt_level === "client_ack" ? "delivered · seen" : `delivered (${m.receipt_level || m.action_state})`),
	notice: (m) => (m.event_id ? "not answered" : ""),
	command: () => "command",
	command_result: () => "",
};

function render(m) {
	let el = document.querySelector(`[data-seq="${m.seq}"]`);
	if (!el) {
		el = document.createElement("div");
		el.dataset.seq = String(m.seq);
		el.className = `msg ${m.kind}`;
		const text = document.createElement("span");
		text.textContent = m.text;
		const meta = document.createElement("span");
		meta.className = "meta";
		el.append(text, meta);
		$("log").append(el);
		if (m.kind === "user" && m.event_id) state.pending.set(m.event_id, el);
	}
	const meta = el.querySelector(".meta");
	meta.textContent = (META[m.kind] || (() => ""))(m);
	if (m.action_id) meta.title = `action ${m.action_id}`;
}

async function poll() {
	if (!state.csrf) return;
	const r = await api(`/api/messages?after=${state.after}`);
	if (r.status !== 200) return;
	const log = $("log");
	const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
	for (const m of r.body.messages) {
		state.after = Math.max(state.after, m.seq);
		if ((m.kind === "reply" || m.kind === "notice") && m.event_id) {
			state.answered.add(m.event_id);
			const userEl = state.pending.get(m.event_id);
			if (userEl) {
				userEl.querySelector(".meta").textContent = m.kind === "reply" ? "" : "not answered";
				state.pending.delete(m.event_id);
			}
		}
		render(m);
		if (m.action_id && m.receipt_level === "ui_enqueued" && !state.acked.has(m.action_id)) {
			state.acked.add(m.action_id);
			api("/api/ack", { method: "POST", body: JSON.stringify({ action_id: m.action_id }) });
		}
	}
	if (atBottom) log.scrollTop = log.scrollHeight;
}

function chip(text, level) {
	const c = document.createElement("span");
	c.className = `chip ${level}`;
	c.textContent = text;
	return c;
}

async function refreshStatus() {
	if (!state.csrf) return;
	const r = await api("/api/status");
	if (r.status !== 200) return;
	const s = r.body;
	const chips = [chip(`router ${s.router}`, s.router === "up" ? "ok" : "bad")];
	for (const [channel, c] of Object.entries(s.channels)) {
		chips.push(chip(`${channel}: ${c.model || "no model"} (${c.status})`, c.status === "loaded" ? "ok" : "warn"));
	}
	const tg = s.telegram.startsWith("connected") ? "ok" : s.telegram.startsWith("failed") ? "bad" : "warn";
	chips.push(chip(`telegram ${s.telegram}`, tg));
	if (s.memory) {
		// The status leads with the mode ("awake, day 2 · long-term up: …"); colour by the long-term part.
		const lt = s.memory.replace(/^.*?long-term /, "");
		const mem = /^up\b/.test(lt) && !s.memory.includes(" — ") ? "ok" : /^(failed|retrying)/.test(lt) ? "bad" : "warn";
		chips.push(chip(`memory ${s.memory}`, mem));
	}
	if (s.web) {
		chips.push(chip(`web search ${s.web}`, s.web.startsWith("up") ? "ok" : /^retrying/.test(s.web) ? "bad" : "warn"));
	}
	if (s.decisions) {
		const dec = s.decisions.startsWith("up") ? "ok" : /^retrying/.test(s.decisions) ? "bad" : "warn";
		chips.push(chip(`decisions ${s.decisions}`, dec));
	}
	if (s.reminders) {
		// A failed or unconfirmed reminder needs the owner (/commitments); otherwise it is information.
		chips.push(chip(`reminders: ${s.reminders}`, /failed|unconfirmed/.test(s.reminders) ? "bad" : "ok"));
	}
	$("status").replaceChildren(...chips);
	const toggle = $("attention-toggle");
	toggle.hidden = !s.attention;
	toggle.textContent = `${s.attention} need${s.attention === 1 ? "s" : ""} attention`;
	if (!s.attention) $("attention").hidden = true;
	else if (!$("attention").hidden) refreshAttention();
}

async function refreshModels() {
	const r = await api("/api/models");
	if (r.status !== 200) return;
	const rows = r.body.models.map((m) => {
		const row = document.createElement("div");
		row.className = "model";
		const name = document.createElement("span");
		name.className = "name";
		name.textContent = m.name;
		const actions = document.createElement("span");
		actions.className = "actions";
		const cmd = (label, command, enabled = true) => {
			const b = document.createElement("button");
			b.textContent = label;
			b.className = "ghost";
			b.disabled = !enabled;
			b.addEventListener("click", () => send(command));
			return b;
		};
		const loaded = m.status === "loaded";
		actions.append(
			cmd(loaded ? "Unload" : "Load", `${loaded ? "/unload" : "/load"} ${m.name}`, m.available),
			cmd("Use for web", `/use ${m.name} web`, loaded),
			cmd("Use for Telegram", `/use ${m.name} telegram`, loaded),
		);
		const info = document.createElement("span");
		info.className = "info";
		info.textContent = [m.status, `${m.ramRequiredGb} GB`, m.selectedFor.length ? `selected: ${m.selectedFor.join(", ")}` : "", m.inUse ? `in use ×${m.inUse}` : ""].filter(Boolean).join(" · ");
		row.append(name, actions, info);
		return row;
	});
	const ram = r.body.availableRamGb == null ? "unknown" : `${r.body.availableRamGb.toFixed(1)} GB`;
	const head = document.createElement("p");
	head.className = "meta";
	head.textContent = `Free RAM: ${ram} · at most ${r.body.modelsMax} loaded`;
	$("models-list").replaceChildren(head, ...rows);
}

const STATE_TEXT = {
	unknown: "may or may not have been sent",
	failed: "failed, will retry",
	terminal_failure: "failed",
};

async function refreshAttention() {
	const r = await api("/api/actions");
	if (r.status !== 200) return;
	const items = r.body.actions.map((a) => {
		const item = document.createElement("div");
		item.className = "item";
		const head = document.createElement("strong");
		head.textContent = `${a.kind === "reply" ? "Reply" : "Notice"} to ${a.recipient}: ${STATE_TEXT[a.state] || a.state}`;
		const meta = document.createElement("span");
		meta.className = "meta";
		meta.textContent = [
			new Date(a.created_at).toLocaleString(),
			`attempts ${a.attempts}`,
			a.chunks.total > 1 ? `parts sent ${a.chunks.delivered}/${a.chunks.total}` : "",
			a.next_attempt_at ? `next try ${new Date(a.next_attempt_at).toLocaleTimeString()}` : "",
			a.last_error || "",
		]
			.filter(Boolean)
			.join(" · ");
		const preview = document.createElement("span");
		preview.className = "preview";
		preview.textContent = a.preview;
		const actions = document.createElement("span");
		actions.className = "actions";
		const resolve = (label, resolution, title) => {
			const b = document.createElement("button");
			b.className = "ghost";
			b.textContent = label;
			b.title = title;
			b.addEventListener("click", async () => {
				b.disabled = true;
				const res = await api("/api/actions/resolve", {
					method: "POST",
					body: JSON.stringify({ action_id: a.id, resolution }),
				});
				if (res.status !== 200) alert(res.body.error || `error ${res.status}`);
				refreshAttention();
				refreshStatus();
			});
			return b;
		};
		actions.append(
			resolve("It arrived", "delivered", "Confirm the recipient got it"),
			resolve("Send again", "resend", "Send the undelivered parts again (may duplicate)"),
			resolve("Dismiss", "dismiss", "Close it as not delivered"),
		);
		item.append(head, meta, preview, actions);
		return item;
	});
	if (items.length === 0) {
		const none = document.createElement("p");
		none.className = "meta";
		none.textContent = "Nothing needs attention.";
		items.push(none);
	}
	$("attention-list").replaceChildren(...items);
}

async function send(text) {
	const id = crypto.randomUUID().replaceAll("-", "");
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const r = await api("/api/messages", { method: "POST", body: JSON.stringify({ client_msg_id: id, text }) });
			if (r.status >= 400) alert(r.body.error || `error ${r.status}`);
			break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 1000)); // retry with the same id: deduplicated
		}
	}
	poll();
}

$("composer").addEventListener("submit", (e) => {
	e.preventDefault();
	const text = $("input").value.trim();
	if (!text) return;
	$("input").value = "";
	send(text);
});
$("input").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		$("composer").requestSubmit();
	}
});
$("login-form").addEventListener("submit", (e) => {
	e.preventDefault();
	login($("login-token").value.trim());
});
$("attention-toggle").addEventListener("click", () => {
	$("attention").hidden = !$("attention").hidden;
	$("models").hidden = true;
	if (!$("attention").hidden) refreshAttention();
});
$("models-toggle").addEventListener("click", () => {
	$("attention").hidden = true;
	$("models").hidden = !$("models").hidden;
	if (!$("models").hidden) refreshModels();
});

(async () => {
	const token = location.hash.slice(1);
	if (token) {
		history.replaceState(null, "", "/");
		await login(token);
	} else {
		const r = await api("/api/session");
		if (r.status === 200) showChat(r.body.csrf);
		else showLogin();
	}
	poll();
	refreshStatus();
	setInterval(poll, 1000);
	setInterval(refreshStatus, 5000);
	setInterval(() => !$("models").hidden && refreshModels(), 5000);
})();

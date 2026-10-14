// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * "Ask the thinking model" (owner decision 2026-10-09, widening plan 0.012):
 * the owner's turns may hand one self-contained question to the reasoning
 * model on the owner's other machine (the MBP) and get its answer back.
 *
 * - Owner-only (effect `act`): the question leaves the Spark, and only the
 *   owner decided that may happen. Never contacts, never background work
 *   (whose model this already is).
 * - The model sees only the question the session wrote: no conversation, no
 *   memory, no tools, no session kept anywhere. Its reasoning is not returned,
 *   only its answer.
 * - It takes the other machine's device slot as a person's job: background work
 *   there gives way, and nothing waits behind a chat on this machine.
 * - No time limit (owner directive: a slow answer beats a timed-out one); the
 *   answer is streamed, so a long think never looks like a hang. The turn's
 *   own cancellation stops it.
 * - Bounded by a daily number of answered questions.
 */

import { Type } from "typebox";
import type { ModelLease, OpResult } from "../models/manager.ts";
import { streamChat } from "../models/stream.ts";
import type { Db } from "../state/db.ts";
import { type IyyeTool, shorten, type Toolkit } from "./broker.ts";

export const THINKING_TOOLKIT = "thinking";
export const ASK_THINKING_TOOL = "ask_thinking_model";
const ANSWERED = "The thinking model answered";
const MAX_QUESTION_CHARS = 8000;
const MAX_ANSWER_CHARS = 8000;
/**
 * rapid-mlx, cut off by `max_tokens` while still reasoning, puts this notice and the tail of its reasoning in
 * the answer: scratch work, never an answer.
 */
const CUT_OFF_MID_THOUGHT = "[truncated — reasoning incomplete";

/** One streamed completion with thinking on: the answer text (reasoning dropped) and whether it was cut off. */
export type ThinkComplete = (
	model: string,
	question: string,
	signal: AbortSignal,
) => Promise<{ text: string; truncated: boolean }>;

export interface ThinkingDeps {
	db: Db;
	/** The other machine's model (`qwen38-27b-tak@mbp`) and the machine's name (`mbp`). */
	model: string;
	machine: string;
	models: { acquire(name: string): Promise<ModelLease | OpResult> };
	/** The other machine's device slot. */
	device: { acquire(label: string): Promise<() => void> };
	complete: ThinkComplete;
	dailyMax: number;
	energy?: { deviceTime(kind: "chat", ms: number, ref: string): void } | null;
	now?: () => Date;
}

const QUESTION = Type.Object(
	{
		question: Type.String({
			description:
				"The whole question, self-contained: every fact, number and condition the model needs, since it sees nothing else.",
		}),
	},
	{ additionalProperties: false },
);

export function thinkingToolkit(d: ThinkingDeps): Toolkit {
	const now = d.now ?? (() => new Date());
	const tool: IyyeTool<typeof QUESTION> = {
		name: ASK_THINKING_TOOL,
		label: "Ask the thinking model",
		description: `Ask the stronger, slower reasoning model on the owner's other computer (${d.machine}) one question that needs careful step-by-step thinking: puzzles, riddles, math, logic, tricky analysis. It sees only the question you write, not this conversation, memory or tools, so include everything it needs. It can take several minutes. Returns its final answer; check it before you pass it on.`,
		summary: `a careful answer from the reasoning model on ${d.machine}`,
		parameters: QUESTION,
		run: async (p, ctx, signal) => {
			const q = shorten(p.question, MAX_QUESTION_CHARS);
			if (!q.text) return "The question is empty. Write the whole question.";
			const used = answeredToday(d.db, now());
			if (used >= d.dailyMax)
				return `The thinking model's daily limit is used up (${d.dailyMax} questions). Answer yourself, and say so.`;
			const lease = await d.models.acquire(d.model);
			if (!("release" in lease))
				return `The thinking model on ${d.machine} is not available now (${lease.message}). Answer yourself, and say so.`;
			const abort = new AbortController();
			const onAbort = () => abort.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			let release: (() => void) | null = null;
			const t0 = now().getTime();
			try {
				release = await d.device.acquire(`thinking:${ctx.scope}`);
				if (abort.signal.aborted) return "Stopped.";
				const r = await d.complete(d.model, q.text, abort.signal);
				const secs = Math.round((now().getTime() - t0) / 1000);
				const text = r.text.trim();
				if (!text)
					return `The thinking model on ${d.machine} gave no answer (after ${secs} s). Answer yourself, and say so.`;
				if (r.truncated && text.startsWith(CUT_OFF_MID_THOUGHT))
					return `The thinking model on ${d.machine} ran out of room while still reasoning (after ${secs} s) and reached no answer. Answer yourself, and say so.`;
				const clipped = text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS)} […]` : text;
				return `${q.note}${ANSWERED} after ${secs} s${r.truncated ? " (it ran out of room; the answer may be incomplete)" : ""}:\n${clipped}`;
			} catch (err) {
				if (abort.signal.aborted) return "Stopped.";
				if (!lease.valid())
					return `The connection to ${d.machine} was lost before the thinking model answered. Answer yourself, and say so.`;
				return `The thinking model on ${d.machine} failed: ${(err as Error).message}. Answer yourself, and say so.`;
			} finally {
				signal?.removeEventListener("abort", onAbort);
				release?.();
				lease.release();
				if (release) d.energy?.deviceTime("chat", now().getTime() - t0, `thinking:${ctx.scope}:${t0}`);
			}
		},
	};
	return {
		name: THINKING_TOOLKIT,
		description: `a stronger reasoning model on ${d.machine} for hard questions`,
		effect: "act",
		tools: [tool],
	};
}

/** Questions the thinking model answered since local midnight. */
function answeredToday(db: Db, now: Date): number {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	return (
		db
			.prepare(
				"SELECT count(*) AS n FROM tool_calls WHERE tool = ? AND outcome = 'ok' AND result LIKE ? AND started_at >= ?",
			)
			.get(ASK_THINKING_TOOL, `%${ANSWERED} after%`, midnight.toISOString()) as { n: number }
	).n;
}

/** The completion: streamed (`streamChat`), thinking on, the server's own sampling and reasoning budget. */
export function thinkComplete(url: (model: string) => string, maxTokens: number): ThinkComplete {
	return (model, question, signal) =>
		streamChat(
			url(model),
			{
				model,
				max_tokens: maxTokens,
				chat_template_kwargs: { enable_thinking: true },
				messages: [
					{
						role: "system",
						content:
							"Think the question through carefully, then give a clear final answer with a short justification.",
					},
					{ role: "user", content: question },
				],
			},
			signal,
		);
}

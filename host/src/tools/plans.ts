// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The `plans` toolkit (plan 0.006 C4), effect `self`: the owner and contacts
 * may propose a plan in their own conversation; Iyye's background work never
 * gets it. The tool only proposes: whether a plan runs is the kernel's rule
 * (`kernel/plans.ts`), and approving one is an owner command. The proposer,
 * scope and route come from the turn, never from the model.
 */

import { Type } from "typebox";
import type { PlanRunner, ProposedStep } from "../kernel/plans.ts";
import type { IyyeTool, ToolContext, Toolkit } from "./broker.ts";

interface StepParam {
	kind: "investigate" | "remind" | "other";
	text: string;
	when?: string;
}

export function plansToolkit(runner: Pick<PlanRunner, "propose">): Toolkit {
	const propose: IyyeTool = {
		name: "plan_propose",
		label: "Propose a plan",
		description:
			'Propose a plan of several steps that Iyye carries out over time, in order. Step kinds: "investigate" (a question Iyye answers by looking with its read-only tools: this machine, its repositories), "remind" (send the person a reminder in this chat at a time; give "when"), "other" (anything else: no tool can do it, so the plan will stop there). Use it only when the person asks for something that takes several steps; a single reminder is reminder_create. The result says whether the plan runs now or waits for the owner\'s approval; tell the person exactly that.',
		summary: "propose a plan of several steps (look into something, remind at a time)",
		parameters: Type.Object({
			intent: Type.String({ minLength: 1, maxLength: 300, description: "What the plan is for, in a sentence" }),
			steps: Type.Array(
				Type.Object({
					kind: Type.Union([Type.Literal("investigate"), Type.Literal("remind"), Type.Literal("other")]),
					text: Type.String({
						minLength: 1,
						maxLength: 400,
						description: "The question to look into, the reminder text, or what the step does",
					}),
					when: Type.Optional(
						Type.String({
							maxLength: 60,
							description:
								'For "remind" only: "in 2 hours", "tomorrow 09:00", "monday 18:30", "12 October 12:00" and the like',
						}),
					),
				}),
				{ minItems: 1, maxItems: 5 },
			),
		}),
		run: async (p: { intent: string; steps: StepParam[] }, ctx: ToolContext) => {
			if (!ctx.turn || ctx.principal === "iyye")
				return "Plans can only be proposed in a conversation with a person.";
			const steps: ProposedStep[] = [];
			for (const [i, s] of p.steps.entries()) {
				if (s.kind === "remind") {
					if (!s.when?.trim())
						return `Not proposed: step ${i + 1} is a reminder without a time. Ask the person when; do not choose yourself.`;
					steps.push({ kind: "remind", text: s.text, when: s.when });
				} else if (s.kind === "investigate") steps.push({ kind: "investigate", question: s.text });
				else steps.push({ kind: "other", description: s.text });
			}
			return runner.propose({
				intent: p.intent,
				steps,
				proposer: ctx.turn.contactId,
				principal: ctx.principal === "owner" ? "owner" : "contact",
				scope: ctx.scope,
				route: ctx.turn.route,
				eventId: ctx.turn.eventId,
				via: ctx.turn.route.channel === "web" ? "web chat" : "Telegram",
			});
		},
	};
	return {
		name: "plans",
		description: "plans of several steps Iyye carries out over time",
		effect: "self",
		tools: [propose] as IyyeTool[],
	};
}

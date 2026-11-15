// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * A calibration temperature for yes/no answers, fitted as Kev fits its own
 * (`kev.metrics.fit_temperature` at its release settings, `TEMPERATURE_FIT`):
 * the temperature on a 121-point log grid from 0.25 to 4 with the lowest mean
 * negative log-likelihood, every question weighted equally. A yes/no answer is
 * a two-way softmax, so at temperature T its probability is
 * sigmoid(margin / T), where the margin is the raw difference between the
 * "true" and "false" logits (or, without logits, the log-odds of the raw
 * probability).
 *
 * Fitted on validation rows only, from answers given at temperature 1, and
 * recorded beside the bundle: never written into the checkpoint
 * (`host/SPIKE-0.017.md` §4).
 *
 * A fit is only as good as its rows (2026-11-15: the first real candidate was
 * fitted on 23 labels, 13 of them of questions it had not been trained on and
 * answered confidently wrong, and came out at 4, the top of the grid, which
 * flattened the answers it had learned). So a fit says whether it can be
 * relied on: it has at least `MIN_FIT_LABELS` rows and does not sit on either
 * end of the grid, where the true minimum may lie outside it.
 */

export interface RawAnswer {
	/** The raw (temperature 1) margin: logit("true") − logit("false"). */
	margin: number;
	label: boolean;
}

const POINTS = 121;
const LOW = 0.25;
const HIGH = 4;
const P_FLOOR = 1e-6;
/** Fewer rows than this and a handful of confident errors decide the temperature. */
export const MIN_FIT_LABELS = 30;

/** The margin of a raw probability, floored away from 0 and 1 as Kev floors probabilities. */
export function marginOf(p: number): number {
	const q = Math.min(1 - P_FLOOR, Math.max(P_FLOOR, p));
	return Math.log(q / (1 - q));
}

/** Mean negative log-likelihood of the answers at a temperature. */
export function meanNll(rows: readonly RawAnswer[], temperature: number): number {
	let sum = 0;
	for (const r of rows) {
		const z = (r.label ? r.margin : -r.margin) / temperature;
		// −log sigmoid(z) = softplus(−z), written so that neither branch overflows.
		sum += z >= 0 ? Math.log1p(Math.exp(-z)) : -z + Math.log1p(Math.exp(z));
	}
	return sum / rows.length;
}

export interface TemperatureFit {
	temperature: number;
	n: number;
	/** Mean NLL at temperature 1 and at the fitted one. */
	nll_raw: number;
	nll_fitted: number;
	/** The fit is the lowest or the highest temperature tried: the best one may lie beyond it. */
	at_bound: boolean;
	/** Enough rows, and not at an end of the grid. Only then is the temperature one to serve with. */
	reliable: boolean;
}

/** Null when there is nothing to fit on. Ties go to the lowest temperature, as numpy's argmin does. */
export function fitTemperature(rows: readonly RawAnswer[]): TemperatureFit | null {
	if (rows.length === 0 || rows.some((r) => !Number.isFinite(r.margin))) return null;
	let best = { t: 1, nll: Number.POSITIVE_INFINITY, i: -1 };
	for (let i = 0; i < POINTS; i++) {
		const t = Math.exp(Math.log(LOW) + ((Math.log(HIGH) - Math.log(LOW)) * i) / (POINTS - 1));
		const nll = meanNll(rows, t);
		if (nll < best.nll) best = { t, nll, i };
	}
	const atBound = best.i === 0 || best.i === POINTS - 1;
	return {
		temperature: best.t,
		n: rows.length,
		nll_raw: meanNll(rows, 1),
		nll_fitted: best.nll,
		at_bound: atBound,
		reliable: rows.length >= MIN_FIT_LABELS && !atBound,
	};
}

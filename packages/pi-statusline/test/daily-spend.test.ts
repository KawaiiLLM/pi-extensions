import assert from "node:assert/strict";
import { test } from "vitest";
import { type DailySpend, dailyBudgetPercent, startOfLocalDay } from "../src/daily-spend.js";
import type { PricedUsageWindow, UsageRuntime } from "../src/usage-refresh.js";

const DAY_MS = 86_400_000;
const SEVEN_DAYS = 7 * 24 * 60;
const NOW = startOfLocalDay(1_760_000_000_000) + 9 * 60 * 60 * 1000;
const MIDNIGHT = startOfLocalDay(NOW);

function weekly(window: Partial<PricedUsageWindow>): UsageRuntime {
	return {
		providerId: "openai-codex",
		weekly: {
			bucketId: "codex:secondary",
			windowMinutes: SEVEN_DAYS,
			usedPercent: 0,
			spent: 0,
			resetsAt: (MIDNIGHT + 7 * DAY_MS) / 1000,
			...window,
		},
	};
}

function today(dollars: number): DailySpend {
	return { day: MIDNIGHT, providerId: "openai-codex", dollars };
}

test("a full week ahead spends the window in seven equal days", () => {
	// $200 of a $1400 window is one seventh of it, and one seventh of seven days.
	const spent = (dollars: number) =>
		weekly({ usedPercent: (dollars / 1400) * 100, spent: dollars });
	assert.equal(Math.round(dailyBudgetPercent(spent(200), today(200), NOW) ?? 0), 100);
	assert.equal(Math.round(dailyBudgetPercent(spent(100), today(100), NOW) ?? 0), 50);
});

test("an untouched window reports no spend rather than no reading", () => {
	// Pricing the window would divide by a zero percentage; the ratio does not.
	const usage = weekly({ usedPercent: 0, spent: 0 });
	assert.equal(dailyBudgetPercent(usage, today(0), NOW), 0);
	// Spend that predates the window is today's, but it is not the window's.
	assert.equal(dailyBudgetPercent(usage, today(42), NOW), 0);
});

test("the allowance is what was left at midnight over the days left from midnight", () => {
	// $600 spent for 60% prices the window at $1000, so midnight held $520 for 3 days.
	const usage = weekly({
		usedPercent: 60,
		spent: 600,
		resetsAt: (MIDNIGHT + 3 * DAY_MS) / 1000,
	});
	const percent = dailyBudgetPercent(usage, today(120), NOW);
	assert.ok(percent !== undefined && Math.abs(percent - (120 / (520 / 3)) * 100) < 1e-9);
});

test("the line holds still for the whole day, so an alert cannot lapse by waiting", () => {
	const usage = weekly({ usedPercent: 60, spent: 600, resetsAt: (MIDNIGHT + 3 * DAY_MS) / 1000 });
	const morning = dailyBudgetPercent(usage, today(120), MIDNIGHT + 60_000);
	const night = dailyBudgetPercent(usage, today(120), MIDNIGHT + DAY_MS - 60_000);
	assert.equal(morning, night);
});

test("a window that opened today is charged only for what it has seen", () => {
	const start = MIDNIGHT + 6 * 60 * 60 * 1000;
	const usage = weekly({ usedPercent: 2, spent: 20, resetsAt: (start + 7 * DAY_MS) / 1000 });
	// $50 today, $20 of it after the reset: the earlier $30 belongs to the window that closed.
	const percent = dailyBudgetPercent(usage, today(50), NOW);
	assert.ok(percent !== undefined && Math.abs(percent - (2 / (100 / 7)) * 100) < 1e-9);
});

test("a reading without a matching weekly window from the same account has no budget", () => {
	assert.equal(dailyBudgetPercent(undefined, today(10), NOW), undefined);
	assert.equal(dailyBudgetPercent({ providerId: "openai-codex" }, today(10), NOW), undefined);
	assert.equal(
		dailyBudgetPercent(weekly({ usedPercent: 20, spent: 50 }), undefined, NOW),
		undefined,
	);
	assert.equal(
		dailyBudgetPercent(
			weekly({ usedPercent: 20, spent: 50 }),
			{ ...today(10), providerId: "anthropic" },
			NOW,
		),
		undefined,
	);
});

test("a window resetting today leaves no days to spread the remainder over", () => {
	const usage = weekly({ usedPercent: 20, spent: 50, resetsAt: (MIDNIGHT - 60_000) / 1000 });
	assert.equal(dailyBudgetPercent(usage, today(10), NOW), undefined);
});

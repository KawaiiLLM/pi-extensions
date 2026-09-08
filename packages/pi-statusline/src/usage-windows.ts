import type { UsageBucket, UsageReport } from "./usage-query/types.js";

/** Anything a day or longer is the weekly window; anything shorter, the 5-hour one. */
const WEEKLY_MIN_MINUTES = 24 * 60;

/** Below this much use the spend-to-percent ratio is noise, so the window goes unpriced. */
const MIN_PRICED_PERCENT = 1;

/**
 * How long each carousel reading holds. Long enough to read and to sit still
 * through a burst of renders; short enough that the other reading is never far away.
 */
export const CAROUSEL_PERIOD_MS = 8_000;

export interface UsageWindow {
	bucketId: string;
	usedPercent: number;
	windowMinutes: number;
	/** Unix seconds. */
	resetsAt: number;
}

export interface UsageWindows {
	fiveHour?: UsageWindow;
	weekly?: UsageWindow;
}

/**
 * Which window a bucket describes is stated by its own length, not by where it
 * arrived in the report: providers have been seen listing the 5-hour window
 * first and, later, only a 7-day one in that same position. Classify by length
 * and let order mean nothing beyond first-wins within a class.
 */
export function selectUsageWindows(report: UsageReport): UsageWindows {
	const windows: UsageWindows = {};
	for (const bucket of report.buckets) {
		// Codex also reports independent model quotas (e.g. Spark), not account windows.
		if (report.providerId === "openai-codex" && bucket.groupId !== "codex") continue;
		const window = usageWindow(bucket);
		if (!window) continue;
		if (window.windowMinutes >= WEEKLY_MIN_MINUTES) windows.weekly ??= window;
		else windows.fiveHour ??= window;
	}
	return windows;
}

function usageWindow(bucket: UsageBucket): UsageWindow | undefined {
	if (bucket.unit !== "percent" || bucket.used === undefined) return undefined;
	if (bucket.windowMinutes === undefined || bucket.windowMinutes <= 0) return undefined;
	if (bucket.resetsAt === undefined || !Number.isFinite(bucket.resetsAt)) return undefined;
	return {
		bucketId: bucket.id,
		usedPercent: bucket.used,
		windowMinutes: bucket.windowMinutes,
		resetsAt: bucket.resetsAt,
	};
}

/** Unix milliseconds at which the window opened. */
export function usageWindowStart(window: UsageWindow): number {
	return window.resetsAt * 1000 - window.windowMinutes * 60_000;
}

/**
 * What the whole window is worth at API prices: the spend observed so far,
 * scaled by the share of the window it consumed.
 */
export function usageWindowDollars(spentDollars: number, usedPercent: number): number | undefined {
	if (usedPercent < MIN_PRICED_PERCENT || spentDollars <= 0) return undefined;
	return (spentDollars / usedPercent) * 100;
}

/**
 * `12% (4h 45m)` alternating with `12% ($647)` when the window has a price.
 * Both readings are padded to the same width so the segment does not jitter.
 */
export function formatUsageWindow(
	window: UsageWindow,
	windowDollars: number | undefined,
	now: number,
): string {
	const percent = Math.round(window.usedPercent);
	const frames = [`${percent}% (${formatTimeRemaining(minutesUntil(window.resetsAt, now))})`];
	if (windowDollars !== undefined) {
		frames.push(`${percent}% (${formatEstimatedCost(windowDollars)})`);
	}
	return rotateFrames(frames, now, CAROUSEL_PERIOD_MS);
}

export function minutesUntil(epochSeconds: number, now: number): number {
	return Math.round(Math.max(0, epochSeconds * 1000 - now) / 60_000);
}

export function formatTimeRemaining(totalMinutes: number): string {
	if (totalMinutes >= 1440) {
		const days = Math.floor(totalMinutes / 1440);
		const hours = Math.floor((totalMinutes % 1440) / 60);
		return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	}
	if (totalMinutes >= 60) {
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	return `${totalMinutes}m`;
}

/**
 * Whole dollars only: the figure is an extrapolation, so cents would advertise
 * a precision it does not have.
 */
export function formatEstimatedCost(dollars: number): string {
	return dollars >= 1 ? `$${Math.round(dollars)}` : "<$1";
}

export function rotateFrames(frames: readonly string[], now: number, periodMs: number): string {
	const width = Math.max(...frames.map((frame) => frame.length));
	const frame = frames[Math.floor(now / periodMs) % frames.length] ?? "";
	const left = Math.floor((width - frame.length) / 2);
	return frame.padStart(frame.length + left).padEnd(width);
}

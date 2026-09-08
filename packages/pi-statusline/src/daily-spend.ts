import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageRuntime } from "./usage-refresh.js";
import { sumProviderSpend } from "./usage-spend.js";
import { usageWindowStart } from "./usage-windows.js";

const DAY_MS = 86_400_000;

export interface DailySpend {
	/** Local midnight this figure covers, so a day rollover is visible without re-reading the clock. */
	day: number;
	providerId: string;
	dollars: number;
}

export function startOfLocalDay(now: number): number {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/**
 * Today's spend as a share of today's allowance, where the allowance is the
 * quota left at the start of today spread over the days left in the window.
 * Both terms are read off the current numbers, and both are constant across a
 * day, so the line never drifts under the spend already measured against it: an
 * alert that has come on stays on, and a day of overspending tightens every
 * later day instead of moving a line that was already crossed.
 *
 * The arithmetic stays in percent of the window. The provider reports the share
 * used exactly, while turning that share into dollars means dividing local spend
 * by it, which has no answer at all until the first percent is used. Local spend
 * still fixes the ratio between today and the window, and the dollar scale
 * cancels out of that ratio.
 */
export function dailyBudgetPercent(
	usage: UsageRuntime | undefined,
	today: DailySpend | undefined,
	now: number,
): number | undefined {
	const window = usage?.weekly;
	if (!window || !today || usage.providerId !== today.providerId) return undefined;
	// A window that opened today owns only the spend since it opened.
	const spentInWindow = Math.min(today.dollars, window.spent);
	const usedToday = window.spent > 0 ? (window.usedPercent * spentInWindow) / window.spent : 0;
	const anchor = Math.max(startOfLocalDay(now), usageWindowStart(window));
	const days = (window.resetsAt * 1000 - anchor) / DAY_MS;
	if (!(days > 0)) return undefined;
	const budget = (100 - window.usedPercent + usedToday) / days;
	if (!(budget > 0)) return undefined;
	return (usedToday / budget) * 100;
}

export interface DailySpendRefresherOptions {
	sessionsDir: string;
	onUpdate: (spend: DailySpend | undefined) => void;
}
export interface DailySpendRefresher {
	refresh(ctx: ExtensionContext): void;
	stop(): void;
}

/**
 * Today's spend read straight from the session logs, so it survives the
 * providers whose subscription usage the API cannot answer for.
 */
export function createDailySpendRefresher(
	options: DailySpendRefresherOptions,
): DailySpendRefresher {
	let revision = 0;
	let owner: ExtensionContext["sessionManager"] | undefined;
	return {
		refresh(ctx) {
			const providerId = ctx.model?.provider;
			const current = ++revision;
			owner = ctx.sessionManager;
			if (!providerId) {
				options.onUpdate(undefined);
				return;
			}
			const day = startOfLocalDay(Date.now());
			void sumProviderSpend(options.sessionsDir, providerId, day)
				.then((dollars) => {
					if (current !== revision || owner !== ctx.sessionManager) return;
					options.onUpdate({ day, providerId, dollars });
				})
				.catch(() => {
					if (current === revision && owner === ctx.sessionManager) options.onUpdate(undefined);
				});
		},
		stop() {
			revision += 1;
			owner = undefined;
			options.onUpdate(undefined);
		},
	};
}

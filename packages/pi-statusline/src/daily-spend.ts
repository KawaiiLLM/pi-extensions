import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageRuntime } from "./usage-refresh.js";
import { sumProviderSpend } from "./usage-spend.js";

/** The weekly window spread evenly, as a share of the window per day. */
const DAILY_SHARE = 100 / 7;

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
 * Today's spend as a share of an even day's worth of the weekly window: a
 * seventh of the window is today's allowance, and this is how much of it is
 * gone.
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
): number | undefined {
	const window = usage?.weekly;
	if (!window || !today || usage.providerId !== today.providerId) return undefined;
	// A window that opened today owns only the spend since it opened.
	const spentInWindow = Math.min(today.dollars, window.spent);
	const usedToday = window.spent > 0 ? (window.usedPercent * spentInWindow) / window.spent : 0;
	return (usedToday / DAILY_SHARE) * 100;
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

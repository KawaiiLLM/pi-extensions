import {
	type ExtensionAPI,
	type ExtensionContext,
	readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import {
	awaitWithDeadline,
	errorMessage,
	redactUsageError,
	UsageCache,
} from "./usage-query/core.js";
import {
	createOAuthCredentialCandidateReader,
	type StoredCredentialReader,
} from "./usage-query/oauth-credential-source.js";
import { adapterForProvider, queryProviderUsage, resolveUsageAuth } from "./usage-query/query.js";
import type { UsageReport } from "./usage-query/types.js";
import { sumProviderSpend } from "./usage-spend.js";
import {
	selectUsageWindows,
	type UsageWindow,
	usageWindowDollars,
	usageWindowStart,
} from "./usage-windows.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
export const USAGE_TIMEOUT_MS = 15_000;
const FAILURE_BACKOFF_MS = 30_000;

export interface PricedUsageWindow extends UsageWindow {
	windowDollars?: number;
}
export interface UsageRuntime {
	providerId: string;
	fiveHour?: PricedUsageWindow;
	weekly?: PricedUsageWindow;
}
export interface UsageSnapshot {
	report?: UsageReport;
	usage?: UsageRuntime;
	error?: string;
}
export interface UsageRefresherOptions {
	sessionsDir: string;
	onUpdate: (usage: UsageRuntime | undefined) => void;
	credentialReader?: StoredCredentialReader;
}
export interface UsageRefresher {
	refresh(ctx: ExtensionContext): void;
	query(ctx: ExtensionContext, force?: boolean, signal?: AbortSignal): Promise<UsageSnapshot>;
	stop(): void;
}

/** One account-scoped report shared by the footer and the usage menu. */
export function createUsageRefresher(
	pi: ExtensionAPI,
	options: UsageRefresherOptions,
): UsageRefresher {
	const reader = options.credentialReader ?? readStoredCredential;
	const candidates = createOAuthCredentialCandidateReader(pi, reader);
	const cache = new UsageCache(CACHE_TTL_MS);
	const controllers = new Set<AbortController>();
	let background: AbortController | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let owner: ExtensionContext["sessionManager"] | undefined;
	let modelKey: string | undefined;
	let identity: string | undefined;
	let revision = 0;
	let snapshot: UsageSnapshot = {};

	const clearTimer = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};
	const clearReport = () => {
		const hadUsage = snapshot.usage !== undefined;
		snapshot = {};
		if (hadUsage) options.onUpdate(undefined);
	};
	const stop = () => {
		revision++;
		clearTimer();
		background?.abort();
		for (const controller of controllers) controller.abort();
		controllers.clear();
		background = undefined;
		owner = undefined;
		modelKey = undefined;
		identity = undefined;
		cache.clear();
		clearReport();
	};
	const query = async (
		ctx: ExtensionContext,
		force = false,
		callerSignal?: AbortSignal,
	): Promise<UsageSnapshot> => {
		callerSignal?.throwIfAborted();
		const key = usageModelIdentity(ctx);
		if (owner !== ctx.sessionManager || modelKey !== key) {
			stop();
			owner = ctx.sessionManager;
			modelKey = key;
		}
		const current = ++revision;
		const controller = new AbortController();
		controllers.add(controller);
		const signal = callerSignal
			? AbortSignal.any([controller.signal, callerSignal])
			: controller.signal;
		const check = () => {
			signal.throwIfAborted();
			if (current !== revision || owner !== ctx.sessionManager || usageModelIdentity(ctx) !== key) {
				throw new DOMException("Usage identity changed", "AbortError");
			}
		};
		let secrets: readonly string[] = [];
		let resolvedIdentity: string | undefined;
		try {
			const adapter = adapterForProvider(ctx.model?.provider);
			if (adapter?.semantics.kind !== "consumer-subscription") {
				clearReport();
				return { error: "The current provider does not expose subscription usage here." };
			}
			const resolveAuth = () =>
				awaitWithDeadline(
					resolveUsageAuth(ctx, adapter, undefined, reader, candidates),
					signal,
					USAGE_TIMEOUT_MS,
					"resolving current usage credentials",
				);
			const auth = await resolveAuth();
			check();
			if (!auth) {
				identity = undefined;
				clearReport();
				return { error: "No matching official subscription credential is available." };
			}
			secrets = auth.secrets;
			resolvedIdentity = `${adapter.id}:${auth.fingerprint}`;
			if (identity !== resolvedIdentity) {
				cache.clear();
				clearReport();
				identity = resolvedIdentity;
			}
			const guard = async () => {
				const again = await resolveAuth();
				check();
				if (!again || again.fingerprint !== auth.fingerprint) {
					identity = undefined;
					cache.clear();
					clearReport();
					throw new Error("Provider credentials changed during the usage request.");
				}
			};
			const cached = force ? undefined : cache.get(adapter.id, auth.fingerprint);
			const report =
				cached ?? (await queryProviderUsage(adapter, auth, signal, USAGE_TIMEOUT_MS, guard));
			await guard();
			const windows = selectUsageWindows(report);
			const price = async (
				window: UsageWindow | undefined,
			): Promise<PricedUsageWindow | undefined> => {
				if (!window) return undefined;
				const spent = await sumProviderSpend(
					options.sessionsDir,
					adapter.id,
					usageWindowStart(window),
					signal,
				);
				return { ...window, windowDollars: usageWindowDollars(spent, window.usedPercent) };
			};
			const usage = {
				providerId: adapter.id,
				fiveHour: await price(windows.fiveHour),
				weekly: await price(windows.weekly),
			};
			await guard();
			if (!cached) cache.set(adapter.id, auth.fingerprint, report);
			snapshot = { report, usage };
			options.onUpdate(usage);
			return snapshot;
		} catch (error) {
			check();
			let stillCurrent = false;
			const adapter = adapterForProvider(ctx.model?.provider);
			if (adapter && resolvedIdentity && identity === resolvedIdentity) {
				try {
					const again = await awaitWithDeadline(
						resolveUsageAuth(ctx, adapter, undefined, reader, candidates),
						signal,
						USAGE_TIMEOUT_MS,
						"revalidating failed usage query",
					);
					stillCurrent = !!again && `${adapter.id}:${again.fingerprint}` === resolvedIdentity;
				} catch {
					/* Unknown identity cannot retain an old account's report. */
				}
			}
			check();
			if (!stillCurrent) {
				identity = undefined;
				cache.clear();
				clearReport();
			}
			snapshot = { ...snapshot, error: redactUsageError(errorMessage(error), secrets) };
			return snapshot;
		} finally {
			controllers.delete(controller);
		}
	};
	const refresh = (ctx: ExtensionContext) => {
		clearTimer();
		background?.abort();
		// query may reset the owner synchronously, so register the background controller after it starts.
		const controller = new AbortController();
		const result = query(ctx, false, controller.signal);
		background = controller;
		void result
			.then((state) => {
				if (
					controller.signal.aborted ||
					owner !== ctx.sessionManager ||
					modelKey !== usageModelIdentity(ctx)
				)
					return;
				if (!state.report && !state.error) return;
				if (adapterForProvider(ctx.model?.provider)?.semantics.kind !== "consumer-subscription")
					return;
				timer = setTimeout(() => refresh(ctx), state.error ? FAILURE_BACKOFF_MS : CACHE_TTL_MS);
				timer.unref?.();
			})
			.catch(() => {
				// A newer menu/turn query owns publication; keep the periodic refresh alive.
				if (!controller.signal.aborted && owner === ctx.sessionManager) {
					clearTimer();
					timer = setTimeout(() => refresh(ctx), CACHE_TTL_MS);
					timer.unref?.();
				}
			});
	};
	return { refresh, query, stop };
}

export function usageModelIdentity(ctx: ExtensionContext): string {
	return `${ctx.model?.provider}/${ctx.model?.id}/${ctx.model?.api}/${ctx.model?.baseUrl}`;
}

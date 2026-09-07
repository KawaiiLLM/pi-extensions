import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { syncCheckConfigFingerprint, syncConfigReviewFingerprint } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import type { StartupObservation } from "../sync/sync-inspection.js";
import {
	compareSyncInclude,
	type RemoteSelectionDecision,
	sameSyncInclude,
} from "../sync/sync-policy.js";
import { safeTerminalText } from "./terminal-text.js";

const STATUS_KEY = "sync";
const WIDGET_KEY = "sync:attention";

export type SyncAttentionOrigin = "sync" | "pull" | "push";

export interface SyncAttentionState {
	decision: RemoteSelectionDecision;
	origin: SyncAttentionOrigin;
	offered: boolean;
}

export function syncAttentionMatchesConfig(attention: SyncAttentionState, config: AnySyncConfig) {
	return (
		attention.decision.setupName === config.setupName &&
		attention.decision.configIdentity === syncConfigReviewFingerprint(config) &&
		sameSyncInclude(attention.decision.localInclude, config.include)
	);
}

export interface SyncAttentionController {
	observe(observation: StartupObservation): void;
	observation(): StartupObservation | undefined;
	clearObservation(): void;
	notifyObservation(ctx: ExtensionContext): void;
	set(decision: RemoteSelectionDecision, origin: SyncAttentionOrigin): void;
	current(): SyncAttentionState | undefined;
	markOffered(): boolean;
	clear(ctx: ExtensionContext): void;
	reset(ctx: ExtensionContext): void;
	publish(ctx: ExtensionContext, signal?: AbortSignal): Promise<void>;
}

export function createSyncAttentionController(): SyncAttentionController {
	let state: SyncAttentionState | undefined;
	let observation: StartupObservation | undefined;
	let generation = 0;

	return {
		observe(value) {
			generation++;
			observation = value;
		},
		observation() {
			return observation;
		},
		clearObservation() {
			generation++;
			observation = undefined;
		},
		notifyObservation(ctx) {
			if (observation && observationNeedsAttention(observation)) {
				ctx.ui.notify(observationLines(observation).join("\n"), "warning");
			}
		},
		set(decision, origin) {
			generation++;
			state = { decision, origin, offered: false };
		},
		current() {
			return state;
		},
		markOffered() {
			if (!state || state.offered) return false;
			state = { ...state, offered: true };
			return true;
		},
		clear(ctx) {
			generation++;
			state = undefined;
			clearAttentionPresentation(ctx);
		},
		reset(ctx) {
			generation++;
			state = undefined;
			observation = undefined;
			clearAttentionPresentation(ctx);
		},
		async publish(ctx, signal) {
			const currentGeneration = ++generation;
			if (signal?.aborted) return;
			if (!state && (!observation || !observationNeedsAttention(observation))) {
				clearAttentionPresentation(ctx);
				return;
			}
			const presentation = state
				? attentionPresentation(state.decision)
				: {
						status: "changes to review",
						lines: observationLines(observation as StartupObservation),
					};
			if (ctx.mode !== "tui") {
				ctx.ui.setStatus(STATUS_KEY, presentation.status);
				return;
			}
			// Keep Kit outside the eager startup graph; module loading owns no cancellable resources.
			const { EditorStatusWidget } = await import("./attention-widget.js");
			if (generation !== currentGeneration || signal?.aborted) return;
			ctx.ui.setStatus(STATUS_KEY, presentation.status);
			ctx.ui.setWidget(
				WIDGET_KEY,
				(_tui, theme) =>
					new EditorStatusWidget({
						theme,
						renderBody: (width) =>
							presentation.lines.map((line, index) =>
								width === 0
									? ""
									: truncateToWidth(theme.fg(index === 0 ? "warning" : "muted", line), width, "…"),
							),
					}),
			);
		},
	};
}

function attentionPresentation(decision: RemoteSelectionDecision) {
	const setupName = safeTerminalText(decision.setupName);
	const comparison = compareSyncInclude(decision.localInclude, decision.remoteInclude);
	const difference =
		comparison.remoteOnly.length === 0 && comparison.localOnly.length === 0
			? "Only list order differs"
			: `Remote ${comparison.remoteOnly.length} · Device ${comparison.localOnly.length}`;
	return {
		status: "review needed",
		lines: [`Pi Sync needs review · ${setupName}`, difference, "No changes · Run /sync to review"],
	};
}

export function observationMatchesConfig(observation: StartupObservation, config: AnySyncConfig) {
	return observation.configIdentity === syncCheckConfigFingerprint(config);
}

export function observationSummary(observation: StartupObservation) {
	const result = observation.inspection;
	if (result.emptyInclude) return "No included content selected";
	if (result.selectionState?.kind === "different")
		return "Synced-content list differs; review needed";
	if (result.firstSync)
		return result.head
			? "No sync baseline; review remote and local content"
			: "Remote empty; no sync baseline";
	if (!result.head) return "Remote snapshot missing; review needed";
	if (result.localChanged && result.remoteChanged)
		return "Local and remote changed since last sync; review needed";
	if (result.remoteChanged) return "Remote changed since last sync";
	if (result.localChanged) return "Local content changed since last sync";
	if (result.selectionState?.kind === "legacy")
		return "Legacy remote has no authoritative content list";
	return "No changes detected since last sync";
}

export function observationNeedsAttention(observation: StartupObservation) {
	const result = observation.inspection;
	return (
		result.emptyInclude ||
		result.firstSync ||
		!result.head ||
		result.localChanged ||
		result.remoteChanged ||
		result.selectionState?.kind !== "same"
	);
}

function observationLines(observation: StartupObservation) {
	return [
		`Pi Sync check · ${safeTerminalText(observation.setupName)}`,
		observationSummary(observation),
		"No startup transfer · Run /sync to review",
	];
}

function clearAttentionPresentation(ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

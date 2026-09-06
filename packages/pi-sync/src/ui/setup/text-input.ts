import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { safeTerminalText } from "../terminal-text.js";

export async function requiredExistingBucket(
	ctx: ExtensionCommandContext,
	example: string,
	signal?: AbortSignal,
) {
	const value = await ctx.ui.input(
		`Existing bucket\n\nThe bucket must already exist; pi-sync will not create it.\nExample: ${safeTerminalText(example)}`,
		undefined,
		{ signal },
	);
	if (signal?.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: new DOMException("The operation was aborted", "AbortError");
	}
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized) {
		ctx.ui.notify("Enter the name of an existing R2/S3 bucket, or cancel setup.", "warning");
		return undefined;
	}
	return normalized;
}

export async function requiredInput(
	ctx: ExtensionCommandContext,
	title: string,
	defaultValue: string,
	signal?: AbortSignal,
) {
	return withoutPlaceholder(await promptTextInput(ctx, title, { defaultValue }, signal));
}

export async function requiredValueInput(
	ctx: ExtensionCommandContext,
	title: string,
	example: string,
	signal?: AbortSignal,
) {
	return withoutPlaceholder(await promptTextInput(ctx, title, { example }, signal));
}

export async function promptTextInput(
	ctx: ExtensionCommandContext,
	title: string,
	options: { defaultValue?: string; example?: string },
	signal?: AbortSignal,
) {
	if (signal?.aborted) signal.throwIfAborted();
	// Pi's TUI ignores input placeholders. Keep guidance visible in the title in every UI mode.
	const hint =
		options.defaultValue !== undefined
			? `Default: ${safeTerminalText(options.defaultValue)} (leave blank to keep)`
			: `Example: ${safeTerminalText(options.example ?? "")}\nEnter your own value; this example is not a default.`;
	const value = await ctx.ui.input(`${title}\n\n${hint}`, undefined, { signal });
	if (signal?.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: new DOMException("The operation was aborted", "AbortError");
	}
	if (value === undefined) return undefined;
	const normalized = value.trim() || options.defaultValue;
	if (!normalized) {
		ctx.ui.notify(`${title.split("\n")[0]} is required.`, "warning");
		return undefined;
	}
	return normalized;
}

function withoutPlaceholder(value: string | undefined) {
	// Preserve the existing Git/S3 placeholder policy; WebDAV permits literal angle brackets.
	return value?.includes("<") || value?.includes(">") ? undefined : value;
}

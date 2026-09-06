import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { normalizeStoragePath, validateConfigName } from "./config.js";
import { normalizeGitBranch, normalizeGitDirectory } from "./git-config.js";
import { errorMessage, requiredInput, safeTerminalText } from "./manager-helpers.js";
import { normalizeWebDavPath } from "./webdav-config.js";

export async function promptInitialSetupName(
	ctx: ExtensionCommandContext,
	preset: string,
	signal?: AbortSignal,
) {
	while (!signal?.aborted) {
		const hint = "For example: home or work. Leave blank for default.";
		// Pi styles the whole input title as accent; give only the guidance a muted role.
		const guidance = ctx.mode === "tui" ? ctx.ui.theme.fg("muted", hint) : hint;
		const name = await requiredInput(ctx, `Sync setup name\n${guidance}`, "default", signal);
		if (!name) return undefined;
		try {
			validateConfigName(name, "sync setup");
			// Validate the same suggestions the backend prompts will offer, without changing the name.
			const suggestedPath = `pi-sync/${name}`;
			normalizeStoragePath(suggestedPath);
			if (preset === "Git") {
				normalizeGitBranch(suggestedPath);
				normalizeGitDirectory(suggestedPath);
			} else if (preset === "WebDAV") {
				normalizeWebDavPath(suggestedPath);
			}
			return name;
		} catch (error) {
			ctx.ui.notify(
				`This name cannot be used for the sync setup or its suggested storage location. ${safeTerminalText(errorMessage(error))} Enter another name (for example, default).`,
				"warning",
			);
		}
	}
	return undefined;
}

import type { SegmentName } from "../types.js";
import { MONO_PRESET } from "./mono.js";
import { adaptTextColor } from "./oklch.js";
import type { PowerlinePreset } from "./types.js";

const TEXT_COLORS: Partial<Record<SegmentName, string>> = {
	model: "#AA79F2",
	thinking: "#AA79F2",
	context: "#A2DAF4",
	tokens: "#A2DAF4",
	five_hour: "#DDF048",
	weekly: "#FAB48C",
	cache: "#F85488",
	cost: "#FFEB38",
};

// Preset colors are static; never repeat the lightness search during width fitting or redraws.
const foregrounds = new Map<string, string>();

export const PRISM_PRESET: PowerlinePreset = {
	...MONO_PRESET,
	foreground(name, colors) {
		const text = TEXT_COLORS[name];
		if (!text || !colors.bg) return colors.fg ?? "#f0f0f0";
		const key = `${text}/${colors.bg}`;
		let result = foregrounds.get(key);
		if (!result) {
			result = adaptTextColor(text, colors.bg, 4);
			foregrounds.set(key, result);
		}
		return result;
	},
};

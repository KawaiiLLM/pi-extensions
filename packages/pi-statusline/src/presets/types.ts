import type { PaletteColor, SegmentName } from "../types.js";

export interface PowerlinePreset {
	lead?: string;
	/** Colours in ramp order, assigned to segments by their position in a row. */
	ramp: PaletteColor[];
	/** Optional field-specific text color; backgrounds still follow the ramp. */
	foreground?: (name: SegmentName, colors: PaletteColor) => string;
	extensionSeparator?: string;
}

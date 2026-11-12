import type { EchoMoment, EchoSea } from "../core/emotion-types.js";
/**
 * Echo Starmap — a canvas full-sky chart of an EchoSea.
 *
 * Every moment becomes a star on the affect grid (valence right, arousal
 * up), colored by the shared echoColor ramp so it matches the 3D renderer.
 * Dense neighborhoods grow nebula haze, bonds draw constellation-like
 * lines, and an "Axes" toggle reveals the underlying grid. Hover (or tap)
 * a star for its label and date; clicks report through `onSelect`.
 *
 * Renders purely from props — no fetching, no timers. Redraws are
 * rAF-coalesced: resize, data, and toggle changes arriving in one frame
 * cost a single full-sky pass.
 */
export interface EchoStarmapProps {
    sea: EchoSea;
    /** Component height: px number or CSS size; defaults to filling the parent. */
    height?: number | string;
    fontFamily?: string;
    /** Fired on click/tap: the hit moment, or null for empty sky. */
    onSelect?: (moment: EchoMoment | null) => void;
}
export default function EchoStarmap({ sea, height, fontFamily, onSelect, }: EchoStarmapProps): import("react").JSX.Element;

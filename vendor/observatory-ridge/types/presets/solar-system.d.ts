import type { RidgeSnapshot, RidgeStarTheme } from "../core/types.js";
/**
 * The classic. Default face of Observatory Ridge — a warm G-type sun and the
 * eight planets everyone grew up with. Swap it out with your own snapshot to
 * make the sky yours.
 */
export declare const SOLAR_STAR_THEME: RidgeStarTheme;
/** A cool blue-white alternative star theme. */
export declare const BLUE_STAR_THEME: RidgeStarTheme;
export declare function solarSystemSnapshot(): RidgeSnapshot;

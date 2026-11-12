import type { EchoMoment, EchoSea } from "../core/emotion-types.js";
/**
 * Echo starmap drawing core — a full-sky, astronomy-photo rendering of an
 * EchoSea on the affect grid.
 *
 * The sky is composed back to front: a seeded dust field for galaxy grain,
 * a palette-tinted airglow density field (moments pile up into colored
 * haze), nebula glow around dense clusters, bond lines with greedy
 * anti-crossing, then the stars themselves — most are dim dust points,
 * the brightest slice gets diffraction spikes and a white-hot core, the
 * way real astrophotography separates magnitudes.
 *
 * Placement is the valence/arousal plane: x runs dark to bright valence,
 * y runs storming (top) to calm (bottom). Affect readings are often
 * coarse-grained, so coincident moments are scattered into small star
 * clusters by deterministic id-hash jitter. No randomness survives a
 * redraw: same sea, same sky.
 */
export interface EchoHitPoint {
    x: number;
    y: number;
    r: number;
    moment: EchoMoment;
}
export interface EchoSkyOptions {
    /** Draw the affect grid, axes, and quadrant labels. */
    showAxis: boolean;
    /** CSS font family for axis labels. */
    fontFamily: string;
}
export declare function echoColorRgb(valence: number, arousal: number): string;
export declare function drawEchoSky(ctx: CanvasRenderingContext2D, W: number, H: number, sea: EchoSea, opts: EchoSkyOptions): EchoHitPoint[];

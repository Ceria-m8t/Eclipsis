import type { EchoMoment, EchoSea } from "../core/emotion-types.js";
/**
 * Echo Galaxy — how the days felt, as a night sky.
 *
 * Every moment is a star: valence picks the hue (shared `echoColor` ramp, so
 * the 2D Echo view agrees), arousal drives brightness, importance drives
 * size, heat adds an ember bonus and a slow pulse on the top stars. Bonds
 * render as faint ties. Very dark storms (valence < -0.5, arousal > 0.6)
 * collapse into black wells with dim accretion rings.
 *
 * Scope note (matches NearFocus3D): no post-processing bloom. The glow is
 * layered additive sprites — a hot core over soft halos — which keeps the
 * production look without a composer or an extra peer dependency.
 */
export interface EchoGalaxyProps {
    sea: EchoSea;
    /** Font stack for the in-scene labels. */
    fontFamily?: string;
    /** Called when a moment is selected (null on empty-space click). Render
     * your own detail card from this — the scene marks selection with a glow. */
    onSelect?: (moment: EchoMoment | null) => void;
}
export default function EchoGalaxy({ sea, fontFamily, onSelect, }: EchoGalaxyProps): import("react").JSX.Element;

import type { RidgePlanet, RidgeSnapshot } from "../core/types.js";
/**
 * Near Focus 2D — an SVG star-system chart.
 *
 * Concentric orbits (one per planet), an asteroid belt of unattributed
 * memories between the inner and outer families, glowing candy-colored
 * planets, and a starfield dust background. Tap a planet, the star, or the
 * belt to open a detail card. Designed for low-power devices: one SVG, a
 * 30fps clock, and a memoized dust field.
 */
export interface NearFocus2DProps {
    snapshot: RidgeSnapshot;
    /** Candy wheel for planets, assigned by orbit order. */
    palette?: string[];
    background?: string;
    fontFamily?: string;
    onSelect?: (selection: NearFocus2DSelection) => void;
}
export type NearFocus2DSelection = {
    kind: "star";
} | {
    kind: "belt";
} | {
    kind: "planet";
    planet: RidgePlanet;
} | null;
export declare function orbitRadius(index: number, planetCount: number): number;
export default function NearFocus2D({ snapshot, palette, background, fontFamily, onSelect, }: NearFocus2DProps): import("react").JSX.Element;

import type { RidgePlanet, RidgeSnapshot, RidgeStarTheme } from "../core/types.js";
/**
 * Near Focus 3D — a navigable star system.
 *
 * The star breathes at the center under a seam-safe halo shader, planets ride
 * accumulated orbits with archetype-shaded surfaces and particle rings,
 * memories orbit their planet as cratered moons, unattributed memories drift
 * in a two-belt asteroid field, and tapping a planet glides the camera into a
 * follow orbit around it. Bloom runs through an effect composer whose pixel
 * ratio is capped at 2 (see the README pitfall log).
 */
export interface NearFocus3DProps {
    snapshot: RidgeSnapshot;
    theme?: RidgeStarTheme;
    onSelect?: (selection: NearFocus3DSelection) => void;
    fontFamily?: string;
}
export type NearFocus3DSelection = {
    kind: "star";
} | {
    kind: "planet";
    planet: RidgePlanet;
} | null;
export default function NearFocus3D({ snapshot, theme, onSelect, fontFamily, }: NearFocus3DProps): import("react").JSX.Element;

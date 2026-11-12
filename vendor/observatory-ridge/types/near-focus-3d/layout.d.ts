import type { RidgeMemory, RidgePlanet, RidgeSnapshot } from "../core/types.js";
/**
 * Near Focus 3D layout model.
 *
 * Pure math: turns a RidgeSnapshot into orbital parameters for planets,
 * satellites (a planet's memories), and the asteroid belt (unattributed
 * memories). Everything is deterministic — visual randomness comes from
 * hash01 on stable ids, never Math.random.
 */
export declare const TAU: number;
/** Innermost orbit anchor. */
export declare const PLANET_ORBIT_MIN = 4.3;
/** Planets with at least this many memories earn a Saturn-style particle ring. */
export declare const MEMORY_RING_THRESHOLD = 12;
/** Visual radius multiplier for an unfocused planet — layout and render share it. */
export declare const PLANET_VISUAL_SCALE = 0.52;
export declare function clamp(value: number, min: number, max: number): number;
export declare function hasMemoryRing(memoryCount: number): boolean;
/**
 * Ring/satellite system plane per planet. Rings can be tilted (character),
 * but rings and camera focus share this one function so a focused planet
 * always reads level. Tilt is capped low enough to stay believable.
 */
export declare function planetSystemTilt(planetId: string): [number, number];
export interface PlanetNode {
    planet: RidgePlanet;
    /** Stable scene key, `planet:<id>`. */
    key: string;
    memoryCount: number;
    rank: number;
    /** Importance blend — more important planets take inner orbits. */
    score: number;
    size: number;
    radius: number;
    phase: number;
    inclination: number;
    ascendingNode: number;
    angularSpeed: number;
}
export interface SatelliteNode {
    memory: RidgeMemory;
    key: string;
    localRadius: number;
    phase: number;
    inclination: number;
    angularSpeed: number;
    size: number;
    color: string;
}
export interface AsteroidNode {
    memory: RidgeMemory;
    key: string;
    radius: number;
    phase: number;
    inclination: number;
    ascendingNode: number;
    angularSpeed: number;
    size: number;
    color: string;
}
export interface NearFocusLayout {
    planets: PlanetNode[];
    satellitesByPlanet: Map<string, SatelliteNode[]>;
    asteroids: AsteroidNode[];
    /** Main belt center — embedded in the planet sequence like Mars/Jupiter. */
    mainBeltCenter: number;
    /** Outer edge of the planet region (outermost orbit + its footprint). */
    outerEdge: number;
    /** Cold outer belt center, just past the planet region. */
    outerBelt: number;
}
export declare function memoryCategoryColor(category: unknown): string;
/** Orbital footprint: sphere (or ring A-ring outer edge) plus breathing pad. */
export declare function planetFootprint(size: number, memoryCount: number): number;
export declare function buildNearFocusLayout(snapshot: RidgeSnapshot): NearFocusLayout;

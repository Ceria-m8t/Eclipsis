import type { EchoBond, EchoMoment } from "../core/emotion-types.js";
/**
 * Deterministic layout for the Echo Galaxy.
 *
 * The scatter looks random but every coordinate is derived from the moment's
 * id via hash01, plus three semantic axes borrowed from the production
 * design this component was extracted from:
 *   x drifts with valence (bright moments lean one way, dark the other),
 *   y lifts with arousal (storms float, calm sinks),
 *   z stretches with time (the cloud reads front-to-back as a timeline).
 * A short bond-spring pass then pulls linked moments together. No
 * Math.random anywhere: the same sea always renders the same sky.
 */
export type LayoutMoment = EchoMoment & {
    x: number;
    y: number;
    z: number;
};
export interface NormalizedBond {
    source: string;
    target: string;
    strength: number;
}
/** 0-1 attention value; missing heat reads as a faint ember, not zero. */
export declare function clampHeat(heat: number | undefined): number;
/** Label/flare ranking: importance dominates, heat breaks ties (production rule). */
export declare function echoScore(moment: EchoMoment): number;
/** Drop bonds with unknown endpoints or self-loops; dedupe keeping the strongest. */
export declare function normalizedBonds(moments: EchoMoment[], bonds: EchoBond[] | undefined): NormalizedBond[];
export declare function layoutMoments(moments: EchoMoment[], bonds: NormalizedBond[]): LayoutMoment[];

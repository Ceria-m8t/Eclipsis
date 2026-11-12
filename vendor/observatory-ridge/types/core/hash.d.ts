/**
 * Deterministic hashing for visual randomness.
 *
 * PITFALL (learned the hard way): raw FNV-1a has weak avalanche on inputs
 * that differ only in their last characters — e.g. sequential ids like
 * `planet-01`, `planet-02`. Feed those to a naive hash and every planet
 * rolls the same ring type, the same tilt, the same face. We finish with
 * the MurmurHash3 fmix32 mixer so sequential inputs still land uniformly.
 */
export declare function hash01(value: string, salt?: number): number;
/** Golden angle in radians — spreads any count of items evenly around a circle. */
export declare const GOLDEN_ANGLE = 2.399963229728653;

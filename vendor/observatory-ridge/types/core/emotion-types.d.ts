/**
 * Echo Sea data contract — the emotional counterpart of `RidgeSnapshot`.
 *
 * Where the knowledge views render what you know, the Echo Sea renders how
 * the days felt. A moment is one remembered point in time with an affect
 * reading; bonds link moments that belong together. Adapters normalize
 * whatever the host application records (diary entries, mood check-ins,
 * message sentiment) into this shape — renderers never fetch private data
 * themselves.
 */
export interface EchoMoment {
    /** Stable unique ID. */
    id: string;
    /** ISO 8601 date or datetime; drives placement along the time axis. */
    date: string;
    /** Pleasantness of the moment, -1 (dark) through 1 (bright). */
    valence: number;
    /** Intensity of the moment, 0 (calm) through 1 (storming). */
    arousal: number;
    /** Optional 1-5 weight; larger moments render larger. Defaults to 3. */
    importance?: number;
    /** Optional 0-1 attention value; brighter when higher. */
    heat?: number;
    /** Short, already-redacted display label. */
    label?: string;
    /** Rendering family: diary-like events vs attributed memories. */
    kind?: "event" | "memory";
}
export interface EchoBond {
    /** `EchoMoment.id` on each end. Invalid references are ignored. */
    source: string;
    target: string;
    /** Optional 0-1 strength; stronger bonds render brighter. */
    strength?: number;
}
export interface EchoSea {
    moments: EchoMoment[];
    bonds?: EchoBond[];
}
/** Clamp helpers shared by both Echo renderers. */
export declare function clampValence(v: number): number;
export declare function clampArousal(a: number): number;
export declare function clampImportance(i: number | undefined): number;
/**
 * Shared valence/arousal color ramp, ported verbatim from the upstream
 * renderer: deep blue for the low days, grey-lavender around neutral, then
 * burning through amber into red-hot for the bright ones. No green anywhere —
 * moods don't come in green. Arousal adds heat to every band. Both Echo
 * renderers use this so a moment keeps its color across views.
 */
export declare function echoColorRGB(valence: number, arousal: number): [number, number, number];
/** CSS form of `echoColorRGB` for canvas renderers. */
export declare function echoColor(valence: number, arousal: number): string;

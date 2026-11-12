import type { RidgeEdge, RidgeGraph, RidgeMemory } from "../core/types.js";
/**
 * Galaxy View — a community-colored memory graph.
 *
 * Every node is a memory. Label propagation groups connected memories into
 * topic communities; each community gets a pastel color and a gravity anchor,
 * so related memories condense into colored nebulae inside one galaxy ball.
 * Sparse data still reads as a galaxy thanks to per-node companion dust.
 */
export interface GalaxyViewProps {
    graph: RidgeGraph;
    /** Pastel community palette. Defaults to a 12-color set. */
    palette?: string[];
    /** Scene background. Pure black lets nebula edges dissolve. */
    background?: string;
    /** Called when a memory is selected (null when deselected). */
    onSelect?: (memory: RidgeMemory | null) => void;
    /** Font stack for labels/panels. */
    fontFamily?: string;
    /** Companion dust points per node (visual density; 0 disables). */
    dustPerNode?: number;
}
type LayoutNode = RidgeMemory & {
    x: number;
    y: number;
    z: number;
};
/** Deterministic label propagation. Seeds from `category`, converges along edges. */
export declare function detectCommunities(nodes: RidgeMemory[], edges: RidgeEdge[]): Map<string, number>;
/**
 * Force layout tuned for "ball of colored nebulae":
 * - community anchors on a golden-angle sphere (blobs form where they're born)
 * - degree-normalized springs (hubs relax, exclusive pairs hug — d3 wisdom)
 * - dual gravity: toward the community anchor and toward the global center
 * - deterministic: seeded by id hashes, identical on every load
 */
export declare function galaxyLayout(nodes: RidgeMemory[], edges: RidgeEdge[], community: Map<string, number>): LayoutNode[];
export default function GalaxyView({ graph, palette, background, onSelect, fontFamily, dustPerNode, }: GalaxyViewProps): import("react").JSX.Element;
export {};

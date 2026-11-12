import * as THREE from "three";
/**
 * Canvas-generated textures for Near Focus 3D. All deterministic; owners are
 * responsible for disposal (see useDisposableTexture in NearFocus3D).
 */
export declare function makeSoftParticleTexture(size?: number): THREE.CanvasTexture;
/** Soft core plus thin horizontal/vertical diffraction spikes — camera-lens bright stars. */
export declare function makeStarburstTexture(size?: number): THREE.CanvasTexture;
/** Horizontal lens-flare bar: long gradient masked by a vertical falloff. */
export declare function makeLensFlareTexture(width?: number, height?: number): THREE.CanvasTexture;
/**
 * Deep-sky dome texture: base color plus a faint galactic band glow only.
 * PITFALL (README): equirectangular textures pinch at the poles — discrete
 * stars belong to Points layers, the dome only carries seamless low-frequency
 * color so the projection distortion never shows.
 */
export declare function makeDeepSkyTexture(width?: number, height?: number): THREE.CanvasTexture;
/**
 * Moon surface with fbm rock grain and cratered basins (dark bowl, bright
 * rim). Plastic-ball satellites were the original sin — the fix is a surface
 * with a story on it. Five shared variants cover the whole scene.
 */
export declare function makeMoonSurfaceTexture(variant?: number, size?: number): THREE.CanvasTexture;
/** Warp streak with a glowing head — shown while the camera is traveling. */
export declare function makeCourseStreakTexture(width?: number, height?: number): THREE.CanvasTexture;

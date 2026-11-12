import { useCallback as e, useEffect as t, useId as n, useMemo as r, useRef as i, useState as a } from "react";
import { Canvas as o, useFrame as s, useThree as c } from "@react-three/fiber";
import { Billboard as l, Html as u, Line as d, OrbitControls as f } from "@react-three/drei";
import * as p from "three";
import { ACESFilmicToneMapping as m, AdditiveBlending as h, AgXToneMapping as g, BufferGeometry as _, CineonToneMapping as v, Clock as y, Color as b, ColorManagement as x, Float32BufferAttribute as S, HalfFloatType as C, LinearToneMapping as w, Mesh as T, MeshBasicMaterial as E, NeutralToneMapping as D, NoBlending as O, OrthographicCamera as k, RawShaderMaterial as ee, ReinhardToneMapping as te, SRGBTransfer as ne, ShaderMaterial as A, UniformsUtils as j, Vector2 as M, Vector3 as N, WebGLRenderTarget as P } from "three";
import { Fragment as F, jsx as I, jsxs as L } from "react/jsx-runtime";
//#region src/core/hash.ts
function R(e, t = 0) {
	let n = (2166136261 ^ t) >>> 0;
	for (let t = 0; t < e.length; t += 1) n ^= e.charCodeAt(t), n = Math.imul(n, 16777619) >>> 0;
	return n ^= n >>> 16, n = Math.imul(n, 2246822507) >>> 0, n ^= n >>> 13, n = Math.imul(n, 3266489909) >>> 0, n = (n ^ n >>> 16) >>> 0, n / 4294967296;
}
var re = 2.399963229728653, ie = [
	"#a8e6c7",
	"#c5b3f0",
	"#f0a8c8",
	"#f0d8a0",
	"#a0c4f0",
	"#f5b895",
	"#8fd8d0",
	"#d8aef0",
	"#b5d8a0",
	"#f0a898",
	"#96c8e8",
	"#ece3a0"
], z = (e, t) => e < t ? -1 : +(e > t), ae = (e, t = .5) => Number.isFinite(e) ? Math.min(1, Math.max(0, e)) : t;
function oe(e, t) {
	let n = new Set(e.map((e) => e.id)), r = /* @__PURE__ */ new Map();
	for (let e of t) {
		if (!n.has(e.source) || !n.has(e.target) || e.source === e.target) continue;
		let [t, i] = z(e.source, e.target) <= 0 ? [e.source, e.target] : [e.target, e.source], a = JSON.stringify([t, i]), o = ae(e.weight), s = r.get(a);
		(!s || o > s.weight) && r.set(a, {
			source: t,
			target: i,
			weight: o
		});
	}
	return [...r.values()].sort((e, t) => z(e.source, t.source) || z(e.target, t.target));
}
function se(e, t) {
	let n = /* @__PURE__ */ new Map(), r = /* @__PURE__ */ new Map(), i = [...e].sort((e, t) => z(e.id, t.id));
	for (let e of i) {
		let t = e.category?.trim(), i = t ? `category:${t}` : `node:${e.id}`;
		n.set(e.id, i), r.set(e.id, t ? i : null);
	}
	let a = /* @__PURE__ */ new Map();
	for (let n of oe(e, t)) a.has(n.source) || a.set(n.source, []), a.has(n.target) || a.set(n.target, []), a.get(n.source).push({
		id: n.target,
		weight: n.weight
	}), a.get(n.target).push({
		id: n.source,
		weight: n.weight
	});
	for (let e = 0; e < 12; e += 1) {
		let e = 0;
		for (let t of i) {
			let i = a.get(t.id);
			if (!i || !i.length) continue;
			let o = /* @__PURE__ */ new Map(), s = n.get(t.id);
			o.set(s, .22);
			let c = r.get(t.id);
			c && o.set(c, (o.get(c) || 0) + .75);
			for (let e of i) {
				let t = n.get(e.id);
				o.set(t, (o.get(t) || 0) + e.weight);
			}
			let l = s, u = o.get(s) || 0;
			for (let [e, t] of o) (t > u + 1e-9 || Math.abs(t - u) <= 1e-9 && z(e, l) < 0) && (l = e, u = t);
			l !== s && (n.set(t.id, l), e += 1);
		}
		if (!e) break;
	}
	let o = /* @__PURE__ */ new Map();
	for (let e of n.values()) o.set(e, (o.get(e) || 0) + 1);
	let s = [...o.entries()].sort((e, t) => t[1] - e[1] || z(e[0], t[0])).map(([e]) => e), c = new Map(s.map((e, t) => [e, t])), l = /* @__PURE__ */ new Map();
	for (let [e, t] of n) l.set(e, c.get(t) || 0);
	return l;
}
function ce(e, t, n) {
	let r = e.map((e) => ({
		...e,
		x: 0,
		y: 0,
		z: 0
	})), i = r.length, a = /* @__PURE__ */ new Map(), o = (e) => {
		let t = n.get(e);
		return Number.isFinite(t) ? t : 0;
	}, s = [...new Set(r.map((e) => o(e.id)))].sort((e, t) => e - t), c = new Map(s.map((e, t) => [e, t])), l = Math.max(1, s.length), u = (e) => c.get(o(e)) ?? 0, d = [], f = Math.PI * (3 - Math.sqrt(5));
	for (let e = 0; e < l; e += 1) {
		let t = 1 - 2 * (l > 1 ? e / (l - 1) : .5), n = Math.sqrt(Math.max(0, 1 - t * t)), r = e * f, i = l === 1 ? 0 : 8 + R(`community-${e}`, 31) * 12;
		d.push([
			Math.cos(r) * n * i,
			t * i * .82,
			Math.sin(r) * n * i
		]);
	}
	r.forEach((e, t) => {
		a.set(e.id, t);
		let n = d[u(e.id)], r = R(e.id, 7) * Math.PI * 2, i = Math.acos(2 * R(e.id, 11) - 1), o = 4 + R(e.id, 13) * 12;
		e.x = n[0] + Math.sin(i) * Math.cos(r) * o, e.y = n[1] + Math.cos(i) * o * .9, e.z = n[2] + Math.sin(i) * Math.sin(r) * o;
	});
	let p = oe(e, t).map((e) => ({
		s: a.get(e.source),
		t: a.get(e.target),
		w: e.weight
	})), m = new Float32Array(i);
	for (let e of p) m[e.s] += 1, m[e.t] += 1;
	let h = new Float32Array(i), g = new Float32Array(i), _ = new Float32Array(i), v = Math.min(120, Math.max(56, Math.round(9e3 / Math.max(1, i)))), y = i <= 96, b = Math.min(18, Math.max(0, i - 1)), x = b ? Math.max(1, (i - 1) / (b * 2)) : 1, S = (e, t, n, i) => {
		let a = r[e].x - r[t].x, o = r[e].y - r[t].y, s = r[e].z - r[t].z, c = a * a + o * o + s * s + .5, l = Math.sqrt(c), u = n / c * i;
		h[e] += a / l * u, g[e] += o / l * u, _[e] += s / l * u, h[t] -= a / l * u, g[t] -= o / l * u, _[t] -= s / l * u;
	};
	for (let e = 0; e < v; e += 1) {
		let t = 1 - e / v, n = 500 * t, a = .048 * t;
		if (y) for (let e = 0; e < i; e += 1) for (let t = e + 1; t < i; t += 1) S(e, t, n, 1);
		else for (let t = 0; t < i; t += 1) for (let r = 0; r < b; r += 1) {
			let a = (Math.imul(t + 1, 2654435761) ^ Math.imul(e + 1, 2246822507) ^ Math.imul(r + 1, 3266489909)) >>> 0;
			a = (a ^ a >>> 16) >>> 0;
			let o = a % i;
			o === t && (o = (o + 1) % i), S(t, o, n, x);
		}
		for (let e of p) {
			let t = r[e.s], n = r[e.t], i = n.x - t.x, o = n.y - t.y, s = n.z - t.z, c = Math.sqrt(i * i + o * o + s * s) + .01, l = 6 + (1 - e.w) * 8, u = 1 / Math.max(1, Math.min(m[e.s], m[e.t])), d = (c - l) * a * 2 * (.3 + e.w) * u;
			h[e.s] += i / c * d, g[e.s] += o / c * d, _[e.s] += s / c * d, h[e.t] -= i / c * d, g[e.t] -= o / c * d, _[e.t] -= s / c * d;
		}
		for (let e = 0; e < i; e += 1) {
			let n = d[u(r[e].id)], i = (m[e] === 0 ? .008 : .004) * t;
			h[e] += (n[0] - r[e].x) * i, g[e] += (n[1] - r[e].y) * i, _[e] += (n[2] - r[e].z) * i, h[e] -= r[e].x * .0012 * t, g[e] -= r[e].y * .0012 * t, _[e] -= r[e].z * .0012 * t, h[e] *= .82, g[e] *= .82, _[e] *= .82;
			let a = Math.hypot(h[e], g[e], _[e]), o = .8 + t * 2.2;
			if (a > o) {
				let t = o / a;
				h[e] *= t, g[e] *= t, _[e] *= t;
			}
			r[e].x += h[e], r[e].y += g[e], r[e].z += _[e];
		}
	}
	if (i) {
		let e = r.reduce((e, t) => (e[0] += t.x, e[1] += t.y, e[2] += t.z, e), [
			0,
			0,
			0
		]);
		e[0] /= i, e[1] /= i, e[2] /= i;
		let t = 0;
		for (let n of r) n.x -= e[0], n.y -= e[1], n.z -= e[2], t = Math.max(t, Math.hypot(n.x, n.y, n.z));
		if (t > 46) {
			let e = 46 / t;
			for (let t of r) t.x *= e, t.y *= e, t.z *= e;
		}
	}
	return r;
}
function le() {
	let e = document.createElement("canvas");
	e.width = e.height = 64;
	let t = e.getContext("2d"), n = t.createRadialGradient(32, 32, 0, 32, 32, 32);
	n.addColorStop(0, "rgba(255,255,255,1)"), n.addColorStop(.22, "rgba(255,255,255,0.9)"), n.addColorStop(.5, "rgba(255,255,255,0.3)"), n.addColorStop(1, "rgba(255,255,255,0)"), t.fillStyle = n, t.fillRect(0, 0, 64, 64);
	let r = new p.CanvasTexture(e);
	return r.needsUpdate = !0, r;
}
function ue({ nodes: n, selId: i, connectedIds: a, community: o, palette: s, dustPerNode: c }) {
	let l = r(() => le(), []);
	t(() => () => l.dispose(), [l]);
	let u = e((e) => s[(o.get(e.id) || 0) % s.length], [o, s]), [d, f] = r(() => {
		let e = new Float32Array(n.length * 3), t = new Float32Array(n.length * 3);
		return n.forEach((n, r) => {
			e[r * 3] = n.x, e[r * 3 + 1] = n.y, e[r * 3 + 2] = n.z;
			let o = n.id === i, s = a.has(n.id), c = new p.Color(o ? "#ffffff" : s ? "#cfe4ff" : u(n)), l = o ? 1.5 : s ? 1.15 : .62 + ae(n.heat, .2) * .5;
			t[r * 3] = c.r * l, t[r * 3 + 1] = c.g * l, t[r * 3 + 2] = c.b * l;
		}), [e, t];
	}, [
		n,
		i,
		a,
		u
	]), [m, h] = r(() => {
		let e = c, t = new Float32Array(n.length * e * 3), r = new Float32Array(n.length * e * 3);
		return n.forEach((n, i) => {
			let a = new p.Color(u(n));
			for (let o = 0; o < e; o += 1) {
				let s = (i * e + o) * 3, c = R(n.id, 71 + o * 13) * Math.PI * 2, l = Math.acos(2 * R(n.id, 73 + o * 13) - 1), u = 1.2 + R(n.id, 79 + o * 13) * 3.4;
				t[s] = n.x + Math.sin(l) * Math.cos(c) * u, t[s + 1] = n.y + Math.cos(l) * u, t[s + 2] = n.z + Math.sin(l) * Math.sin(c) * u;
				let d = .18 + R(n.id, 83 + o * 13) * .3;
				r[s] = a.r * d, r[s + 1] = a.g * d, r[s + 2] = a.b * d;
			}
		}), [t, r];
	}, [
		n,
		u,
		c
	]);
	return /* @__PURE__ */ L(F, { children: [c > 0 && /* @__PURE__ */ L("points", {
		raycast: () => null,
		children: [/* @__PURE__ */ L("bufferGeometry", { children: [/* @__PURE__ */ I("bufferAttribute", {
			attach: "attributes-position",
			args: [m, 3]
		}), /* @__PURE__ */ I("bufferAttribute", {
			attach: "attributes-color",
			args: [h, 3]
		})] }), /* @__PURE__ */ I("pointsMaterial", {
			map: l,
			vertexColors: !0,
			size: 1.8,
			sizeAttenuation: !0,
			transparent: !0,
			opacity: .7,
			depthWrite: !1,
			blending: p.AdditiveBlending
		})]
	}), /* @__PURE__ */ L("points", { children: [/* @__PURE__ */ L("bufferGeometry", { children: [/* @__PURE__ */ I("bufferAttribute", {
		attach: "attributes-position",
		args: [d, 3]
	}), /* @__PURE__ */ I("bufferAttribute", {
		attach: "attributes-color",
		args: [f, 3]
	})] }), /* @__PURE__ */ I("pointsMaterial", {
		map: l,
		vertexColors: !0,
		size: 3.6,
		sizeAttenuation: !0,
		transparent: !0,
		opacity: .95,
		depthWrite: !1,
		blending: p.AdditiveBlending
	})] })] });
}
function de({ nodes: e, edges: t, selId: n }) {
	let i = !!n, a = r(() => {
		let r = /* @__PURE__ */ new Map();
		e.forEach((e) => r.set(e.id, e));
		let a = [], o = [];
		for (let e of t) {
			let t = r.get(e.source), s = r.get(e.target);
			if (!(!t || !s)) if (a.push(t.x, t.y, t.z, s.x, s.y, s.z), n && (e.source === n || e.target === n)) o.push(.55, .8, 1, .55, .8, 1);
			else {
				let t = i ? .4 : 1, n = (.08 + (e.weight ?? .3) * .15) * .4;
				o.push(.3 * n * t, .4 * n * t, .6 * n * t, .3 * n * t, .4 * n * t, .6 * n * t);
			}
		}
		return {
			p: new Float32Array(a),
			c: new Float32Array(o)
		};
	}, [
		e,
		t,
		n,
		i
	]);
	return a.p.length ? /* @__PURE__ */ L("lineSegments", { children: [/* @__PURE__ */ L("bufferGeometry", { children: [/* @__PURE__ */ I("bufferAttribute", {
		attach: "attributes-position",
		args: [a.p, 3]
	}), /* @__PURE__ */ I("bufferAttribute", {
		attach: "attributes-color",
		args: [a.c, 3]
	})] }), /* @__PURE__ */ I("lineBasicMaterial", {
		vertexColors: !0,
		transparent: !0,
		opacity: i ? .5 : .3,
		blending: p.AdditiveBlending
	})] }) : null;
}
function fe({ nodes: e, onPick: n }) {
	let { camera: i, gl: a } = c(), o = r(() => new p.Vector3(), []);
	return t(() => {
		let t = a.domElement, r = null, s = (e) => {
			r = [e.clientX, e.clientY];
		}, c = (a) => {
			if (r && Math.hypot(a.clientX - r[0], a.clientY - r[1]) > 5) return;
			let s = t.getBoundingClientRect(), c = (a.clientX - s.left) / s.width * 2 - 1, l = -((a.clientY - s.top) / s.height) * 2 + 1, u = null, d = .06;
			for (let t of e) {
				if (o.set(t.x, t.y, t.z).project(i), o.z < -1 || o.z > 1) continue;
				let e = Math.hypot(o.x - c, o.y - l);
				e < d && (d = e, u = t);
			}
			n(u);
		};
		return t.addEventListener("pointerdown", s), t.addEventListener("click", c), () => {
			t.removeEventListener("pointerdown", s), t.removeEventListener("click", c);
		};
	}, [
		e,
		i,
		a,
		n,
		o
	]), null;
}
function pe({ nodes: e }) {
	let { camera: n, size: r } = c();
	return t(() => {
		if (!(n instanceof p.PerspectiveCamera) || !e.length || !r.width || !r.height) return;
		let t = 8;
		for (let n of e) t = Math.max(t, Math.hypot(n.x, n.y, n.z));
		let i = p.MathUtils.degToRad(n.fov), a = 2 * Math.atan(Math.tan(i / 2) * (r.width / r.height)), o = t / Math.sin(Math.min(i, a) / 2) * 1.3;
		n.position.set(0, o * .28, o), n.near = Math.max(.1, o / 500), n.far = Math.max(500, o * 12), n.lookAt(0, 0, 0), n.updateProjectionMatrix();
	}, [
		n,
		e,
		r.height,
		r.width
	]), null;
}
function me({ graph: n, palette: i = ie, background: s = "#000000", onSelect: c, fontFamily: l = "ui-monospace, monospace", dustPerNode: d = 4 }) {
	let [p, m] = a(null), h = r(() => {
		let e = i.filter((e) => typeof e == "string" && e.trim().length > 0);
		return e.length ? e : ie;
	}, [i]), g = Number.isFinite(d) ? Math.min(32, Math.max(0, Math.floor(d))) : 4, { nodes: _, community: v, edges: y } = r(() => {
		let e = oe(n.nodes, n.edges), t = se(n.nodes, e);
		return {
			nodes: ce(n.nodes, e, t),
			community: t,
			edges: e
		};
	}, [n.edges, n.nodes]), b = r(() => _.find((e) => e.id === p) || null, [_, p]);
	t(() => {
		p && !b && (m(null), c?.(null));
	}, [
		c,
		b,
		p
	]);
	let x = r(() => {
		let e = /* @__PURE__ */ new Set();
		if (!b) return e;
		for (let t of y) t.source === b.id && e.add(t.target), t.target === b.id && e.add(t.source);
		return e;
	}, [y, b]), S = e((e) => {
		m(e?.id || null), c?.(e);
	}, [c]);
	return /* @__PURE__ */ L("div", {
		style: {
			position: "relative",
			width: "100%",
			height: "100%",
			background: s,
			fontFamily: l
		},
		children: [/* @__PURE__ */ L(o, {
			dpr: [1, 2],
			camera: {
				position: [
					0,
					40,
					90
				],
				fov: 50,
				near: .1,
				far: 3e3
			},
			style: { background: s },
			children: [
				/* @__PURE__ */ I("ambientLight", { intensity: .08 }),
				/* @__PURE__ */ I(pe, { nodes: _ }),
				/* @__PURE__ */ I(ue, {
					nodes: _,
					selId: b?.id || null,
					connectedIds: x,
					community: v,
					palette: h,
					dustPerNode: g
				}),
				/* @__PURE__ */ I(de, {
					nodes: _,
					edges: y,
					selId: b?.id || null
				}),
				b && /* @__PURE__ */ I("group", {
					position: [
						b.x,
						b.y + 1.6,
						b.z
					],
					children: /* @__PURE__ */ I(u, {
						center: !0,
						distanceFactor: 18,
						style: { pointerEvents: "none" },
						children: /* @__PURE__ */ I("div", {
							style: {
								color: "#e8eef8",
								fontSize: 11,
								whiteSpace: "nowrap",
								textShadow: `0 0 8px ${s}, 0 0 4px ${s}`
							},
							children: b.title
						})
					})
				}),
				/* @__PURE__ */ I(fe, {
					nodes: _,
					onPick: S
				}),
				/* @__PURE__ */ I(f, {
					enableDamping: !0,
					dampingFactor: .04,
					rotateSpeed: .3,
					zoomSpeed: .5,
					minDistance: 5,
					maxDistance: 1500
				})
			]
		}), b && /* @__PURE__ */ L("div", {
			style: {
				position: "absolute",
				bottom: 10,
				left: 10,
				right: 10,
				background: "rgba(2,6,12,0.94)",
				border: "1px solid rgba(120,150,190,0.18)",
				borderRadius: 6,
				padding: 12,
				color: "#cdd8ea",
				fontSize: 12
			},
			children: [
				/* @__PURE__ */ I("button", {
					type: "button",
					onClick: () => S(null),
					style: {
						position: "absolute",
						top: 4,
						right: 8,
						background: "none",
						border: 0,
						color: "#5a6a80",
						fontSize: 16,
						cursor: "pointer"
					},
					"aria-label": "Close",
					children: "×"
				}),
				/* @__PURE__ */ I("div", {
					style: {
						fontSize: 13,
						color: "#e8eef8",
						marginBottom: 4
					},
					children: b.title
				}),
				b.preview && /* @__PURE__ */ I("div", {
					style: {
						opacity: .7,
						lineHeight: 1.5
					},
					children: b.preview
				}),
				b.date && /* @__PURE__ */ I("div", {
					style: {
						opacity: .45,
						marginTop: 6,
						fontSize: 10
					},
					children: b.date
				})
			]
		})]
	});
}
//#endregion
//#region src/near-focus-2d/NearFocus2D.tsx
var B = [
	"#ff6d8a",
	"#ffb26b",
	"#ffd166",
	"#c5e05a",
	"#6fe6a3",
	"#3ed3ff",
	"#5aa9ff",
	"#8f7ff5",
	"#c98bf5",
	"#f48fce",
	"#ff8a65",
	"#7fd8c8"
], V = Object.freeze({
	viewMinX: -16,
	viewMinY: 0,
	viewWidth: 392,
	viewHeight: 410,
	centerX: 180,
	centerY: 200,
	innerCount: 8,
	beltInner: 110,
	beltOuter: 124,
	outerMaxRadius: 175.5
});
function he(e, t) {
	let n = V.innerCount;
	if (e < n) return 44 + e * 9;
	let r = Math.max(1, t - n), i = Math.min(6.5, (V.outerMaxRadius - 130) / Math.max(1, r - 1));
	return 130 + (e - n) * i;
}
function ge(e, t, n) {
	let r = parseInt(e.slice(1), 16), i = parseInt(t.slice(1), 16), a = (e) => Math.round((r >> e & 255) * (1 - n) + (i >> e & 255) * n);
	return `#${(a(16) << 16 | a(8) << 8 | a(0)).toString(16).padStart(6, "0")}`;
}
var _e = [
	"225,228,240",
	"225,228,240",
	"225,228,240",
	"236,232,222",
	"172,192,240",
	"172,192,240",
	"255,226,185",
	"230,122,136",
	"178,224,208",
	"196,178,238"
], ve = (() => {
	let e = 1234567, t = () => (e = e * 1664525 + 1013904223 >>> 0, e / 4294967296), n = Math.round(V.viewWidth * V.viewHeight / 400);
	return Array.from({ length: n }, () => ({
		x: V.viewMinX + t() * V.viewWidth,
		y: V.viewMinY + t() * V.viewHeight,
		r: .25 + t() * .85,
		fill: `rgba(${_e[Math.floor(t() * _e.length)]},${(.1 + t() * .34).toFixed(3)})`
	}));
})();
function ye(e = 30, n = !0) {
	let [r, i] = a(0);
	return t(() => {
		if (!n || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
		let t = 0, r = 0, a = (n) => {
			document.visibilityState !== "hidden" && n - r > 1e3 / e && (r = n, i(n)), t = requestAnimationFrame(a);
		};
		return t = requestAnimationFrame(a), () => cancelAnimationFrame(t);
	}, [e, n]), r;
}
var be = (e, t) => {
	(e.key === "Enter" || e.key === " ") && (e.preventDefault(), t());
};
function xe({ snapshot: e, palette: i = B, background: o = "#020408", fontFamily: s = "ui-monospace, monospace", onSelect: c }) {
	let l = ye(30, !0), [u, d] = a(null), f = n().replace(/[^a-zA-Z0-9_-]/g, ""), p = (e) => `or2d-${f}-${e}`, m = r(() => i.length ? i.map((e, t) => /^#[0-9a-f]{6}$/i.test(e) ? e : B[t % B.length]) : B, [i]), h = l / 1e3, g = (Math.sin(h * .7) + 1) / 2, { centerX: _, centerY: v } = V, y = r(() => {
		let t = [...e.planets].sort((e, t) => (Number.isFinite(e.rank) ? e.rank : 2 ** 53 - 1) - (Number.isFinite(t.rank) ? t.rank : 2 ** 53 - 1) || (e.id < t.id ? -1 : +(e.id > t.id))), n = (e) => Number.isFinite(e.memoryCount) ? Math.max(0, e.memoryCount) : 0, r = Math.max(1, ...t.map(n));
		return t.map((e, i) => {
			let a = he(i, t.length), o = n(e);
			return {
				planet: e,
				memoryCount: o,
				orbit: i,
				rx: a,
				color: m[i % m.length],
				r: 3.2 + Math.min(o / r * 3, 3),
				phase: R(e.id, 17) * Math.PI * 2 + i * re,
				speed: 15 / a ** 1.5
			};
		});
	}, [e.planets, m]), b = r(() => {
		let t = (e, t, n, r) => {
			let i = R(e, 29 + t) * Math.PI * 2, a = V.beltInner + R(e, 31 + t) * (V.beltOuter - V.beltInner);
			return {
				x: _ + Math.cos(i) * a,
				y: v + Math.sin(i) * a,
				r: n + R(e, 37 + t) * n * 1.3,
				opacity: r + R(e, 41 + t) * .22,
				color: R(e, 43 + t) < .5 ? "#c8a37a" : "#8fa3bd"
			};
		};
		return [
			...Array.from({ length: 90 }, (e, n) => t(`belt-fill-${n}`, 7, .35, .13)),
			...e.asteroids.map((e) => t(e.id, 0, .5, .24)),
			...Array.from({ length: 8 }, (e, n) => t(`belt-rock-${n}`, 13, 1.15, .3))
		];
	}, [
		e,
		_,
		v
	]), x = r(() => /* @__PURE__ */ I("g", {
		pointerEvents: "none",
		children: ve.map((e, t) => /* @__PURE__ */ I("circle", {
			cx: e.x,
			cy: e.y,
			r: e.r,
			fill: e.fill
		}, `df-${t}`))
	}), []), S = u?.kind === "star", C = u?.kind === "belt", w = u?.kind === "planet" && y.find((e) => e.planet.id === u.id) || null, T = (e) => {
		if (d(e), c) if (e === null) c(null);
		else if (e.kind === "star") c({ kind: "star" });
		else if (e.kind === "belt") c({ kind: "belt" });
		else {
			let t = y.find((t) => t.planet.id === e.id);
			t && c({
				kind: "planet",
				planet: t.planet
			});
		}
	};
	t(() => {
		u?.kind === "planet" && !w && (d(null), c?.(null));
	}, [
		c,
		w,
		u
	]);
	let E = (e) => e.date || "";
	return /* @__PURE__ */ L("div", {
		style: {
			position: "relative",
			width: "100%",
			height: "100%",
			background: o,
			fontFamily: s,
			display: "flex",
			flexDirection: "column"
		},
		children: [/* @__PURE__ */ I("div", {
			style: {
				flex: 1,
				minHeight: 0
			},
			children: /* @__PURE__ */ L("svg", {
				width: "100%",
				height: "100%",
				viewBox: `${V.viewMinX} ${V.viewMinY} ${V.viewWidth} ${V.viewHeight}`,
				style: { display: "block" },
				onClick: () => T(null),
				onKeyDown: (e) => {
					e.key === "Escape" && T(null);
				},
				role: "group",
				"aria-label": "Interactive memory star system",
				children: [
					/* @__PURE__ */ I("style", { children: "\n            .or2d-interactive { outline: none; }\n            .or2d-keyboard-focus { opacity: 0; pointer-events: none; }\n            .or2d-interactive:focus-visible .or2d-keyboard-focus { opacity: 0.9; }\n          " }),
					/* @__PURE__ */ L("defs", { children: [
						/* @__PURE__ */ L("radialGradient", {
							id: p("sun"),
							cx: "50%",
							cy: "50%",
							r: "50%",
							children: [
								/* @__PURE__ */ I("stop", {
									offset: "0%",
									stopColor: "#ffffff",
									stopOpacity: "1"
								}),
								/* @__PURE__ */ I("stop", {
									offset: "25%",
									stopColor: "#fff5d4",
									stopOpacity: "0.95"
								}),
								/* @__PURE__ */ I("stop", {
									offset: "50%",
									stopColor: "#ffc24a",
									stopOpacity: "0.7"
								}),
								/* @__PURE__ */ I("stop", {
									offset: "75%",
									stopColor: "#f4511e",
									stopOpacity: "0.35"
								}),
								/* @__PURE__ */ I("stop", {
									offset: "100%",
									stopColor: "#7a2503",
									stopOpacity: "0"
								})
							]
						}),
						/* @__PURE__ */ L("radialGradient", {
							id: p("corona"),
							cx: "50%",
							cy: "50%",
							r: "50%",
							children: [/* @__PURE__ */ I("stop", {
								offset: "0%",
								stopColor: "#ffd77a",
								stopOpacity: "0.25"
							}), /* @__PURE__ */ I("stop", {
								offset: "100%",
								stopColor: "#ffd77a",
								stopOpacity: "0"
							})]
						}),
						/* @__PURE__ */ I("filter", {
							id: p("blur-lg"),
							x: "-70%",
							y: "-70%",
							width: "240%",
							height: "240%",
							children: /* @__PURE__ */ I("feGaussianBlur", { stdDeviation: "5" })
						}),
						/* @__PURE__ */ I("filter", {
							id: p("blur-sm"),
							x: "-70%",
							y: "-70%",
							width: "240%",
							height: "240%",
							children: /* @__PURE__ */ I("feGaussianBlur", { stdDeviation: "2.5" })
						}),
						y.map(({ planet: e, orbit: t, color: n }) => /* @__PURE__ */ L("radialGradient", {
							id: p(`pg-${t}`),
							cx: "50%",
							cy: "50%",
							r: "50%",
							children: [
								/* @__PURE__ */ I("stop", {
									offset: "0%",
									stopColor: "#ffffff"
								}),
								/* @__PURE__ */ I("stop", {
									offset: "26%",
									stopColor: "#ffffff"
								}),
								/* @__PURE__ */ I("stop", {
									offset: "44%",
									stopColor: ge(n, "#ffffff", .2)
								}),
								/* @__PURE__ */ I("stop", {
									offset: "62%",
									stopColor: n,
									stopOpacity: "0.92"
								}),
								/* @__PURE__ */ I("stop", {
									offset: "82%",
									stopColor: n,
									stopOpacity: "0.3"
								}),
								/* @__PURE__ */ I("stop", {
									offset: "100%",
									stopColor: n,
									stopOpacity: "0"
								})
							]
						}, `pg-${e.id}`))
					] }),
					x,
					y.map(({ planet: e, rx: t }) => {
						let n = u?.kind === "planet" && e.id === u.id;
						return /* @__PURE__ */ I("circle", {
							pointerEvents: "none",
							cx: _,
							cy: v,
							r: t,
							fill: "none",
							stroke: n ? "rgba(255,216,146,0.5)" : "rgba(200,216,240,0.14)",
							strokeWidth: n ? .8 : .6,
							strokeDasharray: n ? void 0 : "0.7 5.8",
							strokeLinecap: "round"
						}, `orbit-${e.id}`);
					}),
					/* @__PURE__ */ I("g", {
						pointerEvents: "none",
						opacity: C ? 1 : .82 + Math.sin(h * .4) * .14,
						children: b.map((e, t) => /* @__PURE__ */ I("circle", {
							cx: e.x,
							cy: e.y,
							r: C ? e.r * 1.25 : e.r,
							fill: e.color,
							opacity: C ? Math.min(1, e.opacity * 2) : e.opacity
						}, `dust-${t}`))
					}),
					/* @__PURE__ */ L("g", {
						className: "or2d-interactive",
						role: "button",
						tabIndex: 0,
						"aria-label": `Asteroid belt, ${e.asteroids.length} memories`,
						onKeyDown: (e) => be(e, () => T(C ? null : { kind: "belt" })),
						onClick: (e) => {
							e.stopPropagation(), T(C ? null : { kind: "belt" });
						},
						style: { cursor: "pointer" },
						children: [
							/* @__PURE__ */ I("circle", {
								cx: _,
								cy: v,
								r: (V.beltInner + V.beltOuter) / 2,
								fill: "none",
								stroke: "rgba(0,0,0,0)",
								strokeWidth: V.beltOuter - V.beltInner + 8,
								pointerEvents: "stroke"
							}),
							/* @__PURE__ */ I("circle", {
								className: "or2d-keyboard-focus",
								cx: _,
								cy: v,
								r: (V.beltInner + V.beltOuter) / 2,
								fill: "none",
								stroke: "#d9e8ff",
								strokeWidth: 1,
								strokeDasharray: "3 4"
							}),
							C && /* @__PURE__ */ L("g", {
								pointerEvents: "none",
								children: [/* @__PURE__ */ I("circle", {
									cx: _,
									cy: v,
									r: V.beltInner - 2.5,
									fill: "none",
									stroke: "rgba(255,216,146,0.5)",
									strokeWidth: .7,
									strokeDasharray: "3 4"
								}), /* @__PURE__ */ I("circle", {
									cx: _,
									cy: v,
									r: V.beltOuter + 2.5,
									fill: "none",
									stroke: "rgba(255,216,146,0.5)",
									strokeWidth: .7,
									strokeDasharray: "3 4"
								})]
							})
						]
					}),
					/* @__PURE__ */ I("circle", {
						pointerEvents: "none",
						cx: _,
						cy: v,
						r: 92 + g * 10,
						fill: `url(#${p("corona")})`,
						opacity: .55
					}),
					/* @__PURE__ */ I("circle", {
						pointerEvents: "none",
						cx: _,
						cy: v,
						r: 58 + g * 8,
						fill: `url(#${p("corona")})`
					}),
					/* @__PURE__ */ L("g", {
						className: "or2d-interactive",
						role: "button",
						tabIndex: 0,
						"aria-label": `Star ${e.star.name}`,
						onKeyDown: (e) => be(e, () => T(S ? null : { kind: "star" })),
						onClick: (e) => {
							e.stopPropagation(), T(S ? null : { kind: "star" });
						},
						style: { cursor: "pointer" },
						children: [
							/* @__PURE__ */ I("circle", {
								cx: _,
								cy: v,
								r: 32,
								fill: `url(#${p("sun")})`
							}),
							/* @__PURE__ */ I("circle", {
								cx: _,
								cy: v,
								r: 20 + g * 4,
								fill: "#fff8e1",
								opacity: .35,
								filter: `url(#${p("blur-lg")})`
							}),
							/* @__PURE__ */ I("circle", {
								cx: _,
								cy: v,
								r: 12 + g * 2,
								fill: "#fff",
								opacity: .8,
								filter: `url(#${p("blur-sm")})`
							}),
							/* @__PURE__ */ I("circle", {
								className: "or2d-keyboard-focus",
								cx: _,
								cy: v,
								r: 39,
								fill: "none",
								stroke: "#d9e8ff",
								strokeWidth: 1,
								strokeDasharray: "3 4"
							}),
							S && /* @__PURE__ */ I("circle", {
								cx: _,
								cy: v,
								r: 37,
								fill: "none",
								stroke: "#d9e8ff",
								strokeWidth: .8,
								strokeDasharray: "3 4",
								opacity: .85
							})
						]
					}),
					y.map(({ planet: e, orbit: t, rx: n, r, phase: i, speed: a, color: s }) => {
						let c = i + h * a, d = _ + Math.cos(c) * n, f = v + Math.sin(c) * n, m = u?.kind === "planet" && e.id === u.id;
						return /* @__PURE__ */ L("g", {
							className: "or2d-interactive",
							role: "button",
							tabIndex: 0,
							"aria-label": `${e.name}, ${Number.isFinite(e.memoryCount) ? Math.max(0, e.memoryCount) : 0} memories`,
							onKeyDown: (t) => be(t, () => T(m ? null : {
								kind: "planet",
								id: e.id
							})),
							onClick: (t) => {
								t.stopPropagation(), T(m ? null : {
									kind: "planet",
									id: e.id
								});
							},
							style: { cursor: "pointer" },
							children: [
								/* @__PURE__ */ I("circle", {
									cx: d,
									cy: f,
									r: 15,
									fill: "rgba(0,0,0,0)"
								}),
								/* @__PURE__ */ I("circle", {
									className: "or2d-keyboard-focus",
									cx: d,
									cy: f,
									r: r + 5,
									fill: "none",
									stroke: "#d9e8ff",
									strokeWidth: .9,
									strokeDasharray: "2.5 3"
								}),
								/* @__PURE__ */ I("circle", {
									cx: d,
									cy: f,
									r: r * 1.5,
									fill: `url(#${p(`pg-${t}`)})`,
									opacity: .95 + Math.sin(l * .0018 + i * 7) * .05
								}),
								m && /* @__PURE__ */ L(F, { children: [/* @__PURE__ */ I("circle", {
									cx: d,
									cy: f,
									r: r + 4,
									fill: "none",
									stroke: "#d9e8ff",
									strokeWidth: .7,
									strokeDasharray: "2.5 3",
									opacity: .85
								}), /* @__PURE__ */ I("text", {
									x: d,
									y: f - r - 7,
									textAnchor: "middle",
									style: {
										fontSize: 8,
										fill: "#fff",
										paintOrder: "stroke",
										stroke: o,
										strokeWidth: 2.5
									},
									children: e.name
								})] }),
								/* @__PURE__ */ I("circle", {
									cx: d,
									cy: f,
									r: r * 3.4,
									fill: s,
									opacity: .06,
									pointerEvents: "none"
								})
							]
						}, e.id);
					})
				]
			})
		}), /* @__PURE__ */ I("div", {
			"aria-live": "polite",
			style: {
				borderTop: "1px solid rgba(255,223,146,0.12)",
				background: "rgba(2,4,8,0.9)",
				padding: "8px 14px 10px",
				minHeight: 72,
				color: "#cdd8ea",
				fontSize: 11
			},
			children: w ? /* @__PURE__ */ L(F, { children: [
				/* @__PURE__ */ L("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 7
					},
					children: [
						/* @__PURE__ */ I("span", { style: {
							width: 6,
							height: 14,
							background: w.color,
							display: "inline-block"
						} }),
						/* @__PURE__ */ I("span", {
							style: {
								color: "#efede6",
								fontSize: 12
							},
							children: w.planet.name
						}),
						/* @__PURE__ */ L("span", {
							style: {
								marginLeft: "auto",
								opacity: .55,
								fontSize: 9
							},
							children: [w.memoryCount, " memories"]
						})
					]
				}),
				w.planet.definition && /* @__PURE__ */ I("div", {
					style: {
						marginTop: 5,
						opacity: .8,
						lineHeight: 1.5
					},
					children: w.planet.definition
				}),
				(w.planet.memories || []).slice(0, 3).map((e) => /* @__PURE__ */ L("div", {
					style: {
						display: "flex",
						justifyContent: "space-between",
						gap: 8,
						marginTop: 5
					},
					children: [/* @__PURE__ */ I("span", {
						style: {
							opacity: .75,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap"
						},
						children: e.title
					}), /* @__PURE__ */ I("span", {
						style: {
							opacity: .4,
							flexShrink: 0,
							fontSize: 9
						},
						children: E(e)
					})]
				}, e.id))
			] }) : S ? /* @__PURE__ */ L(F, { children: [/* @__PURE__ */ I("div", {
				style: {
					color: "#efede6",
					fontSize: 12
				},
				children: e.star.name
			}), e.star.definition && /* @__PURE__ */ I("div", {
				style: {
					marginTop: 5,
					opacity: .8
				},
				children: e.star.definition
			})] }) : C ? /* @__PURE__ */ L(F, { children: [/* @__PURE__ */ I("div", {
				style: {
					color: "#efede6",
					fontSize: 12
				},
				children: "Asteroid belt"
			}), /* @__PURE__ */ L("div", {
				style: {
					marginTop: 5,
					opacity: .8
				},
				children: [e.asteroids.length, " unattributed memories drifting here."]
			})] }) : /* @__PURE__ */ L("div", {
				style: { opacity: .5 },
				children: [
					e.planets.length,
					" planets · ",
					e.asteroids.length,
					" drifting memories — tap anything."
				]
			})
		})]
	});
}
//#endregion
//#region node_modules/three/examples/jsm/shaders/CopyShader.js
var Se = {
	name: "CopyShader",
	uniforms: {
		tDiffuse: { value: null },
		opacity: { value: 1 }
	},
	vertexShader: "\n\n		varying vec2 vUv;\n\n		void main() {\n\n			vUv = uv;\n			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );\n\n		}",
	fragmentShader: "\n\n		uniform float opacity;\n\n		uniform sampler2D tDiffuse;\n\n		varying vec2 vUv;\n\n		void main() {\n\n			vec4 texel = texture2D( tDiffuse, vUv );\n			gl_FragColor = opacity * texel;\n\n\n		}"
}, H = class {
	constructor() {
		this.isPass = !0, this.enabled = !0, this.needsSwap = !0, this.clear = !1, this.renderToScreen = !1;
	}
	setSize() {}
	render() {
		console.error("THREE.Pass: .render() must be implemented in derived pass.");
	}
	dispose() {}
}, Ce = new k(-1, 1, 1, -1, 0, 1), we = new class extends _ {
	constructor() {
		super(), this.setAttribute("position", new S([
			-1,
			3,
			0,
			-1,
			-1,
			0,
			3,
			-1,
			0
		], 3)), this.setAttribute("uv", new S([
			0,
			2,
			0,
			0,
			2,
			0
		], 2));
	}
}(), Te = class {
	constructor(e) {
		this._mesh = new T(we, e);
	}
	dispose() {
		this._mesh.geometry.dispose();
	}
	render(e) {
		e.render(this._mesh, Ce);
	}
	get material() {
		return this._mesh.material;
	}
	set material(e) {
		this._mesh.material = e;
	}
}, Ee = class extends H {
	constructor(e, t) {
		super(), this.textureID = t === void 0 ? "tDiffuse" : t, e instanceof A ? (this.uniforms = e.uniforms, this.material = e) : e && (this.uniforms = j.clone(e.uniforms), this.material = new A({
			name: e.name === void 0 ? "unspecified" : e.name,
			defines: Object.assign({}, e.defines),
			uniforms: this.uniforms,
			vertexShader: e.vertexShader,
			fragmentShader: e.fragmentShader
		})), this.fsQuad = new Te(this.material);
	}
	render(e, t, n) {
		this.uniforms[this.textureID] && (this.uniforms[this.textureID].value = n.texture), this.fsQuad.material = this.material, this.renderToScreen ? (e.setRenderTarget(null), this.fsQuad.render(e)) : (e.setRenderTarget(t), this.clear && e.clear(e.autoClearColor, e.autoClearDepth, e.autoClearStencil), this.fsQuad.render(e));
	}
	dispose() {
		this.material.dispose(), this.fsQuad.dispose();
	}
}, De = class extends H {
	constructor(e, t) {
		super(), this.scene = e, this.camera = t, this.clear = !0, this.needsSwap = !1, this.inverse = !1;
	}
	render(e, t, n) {
		let r = e.getContext(), i = e.state;
		i.buffers.color.setMask(!1), i.buffers.depth.setMask(!1), i.buffers.color.setLocked(!0), i.buffers.depth.setLocked(!0);
		let a, o;
		this.inverse ? (a = 0, o = 1) : (a = 1, o = 0), i.buffers.stencil.setTest(!0), i.buffers.stencil.setOp(r.REPLACE, r.REPLACE, r.REPLACE), i.buffers.stencil.setFunc(r.ALWAYS, a, 4294967295), i.buffers.stencil.setClear(o), i.buffers.stencil.setLocked(!0), e.setRenderTarget(n), this.clear && e.clear(), e.render(this.scene, this.camera), e.setRenderTarget(t), this.clear && e.clear(), e.render(this.scene, this.camera), i.buffers.color.setLocked(!1), i.buffers.depth.setLocked(!1), i.buffers.color.setMask(!0), i.buffers.depth.setMask(!0), i.buffers.stencil.setLocked(!1), i.buffers.stencil.setFunc(r.EQUAL, 1, 4294967295), i.buffers.stencil.setOp(r.KEEP, r.KEEP, r.KEEP), i.buffers.stencil.setLocked(!0);
	}
}, Oe = class extends H {
	constructor() {
		super(), this.needsSwap = !1;
	}
	render(e) {
		e.state.buffers.stencil.setLocked(!1), e.state.buffers.stencil.setTest(!1);
	}
}, ke = class {
	constructor(e, t) {
		if (this.renderer = e, this._pixelRatio = e.getPixelRatio(), t === void 0) {
			let n = e.getSize(new M());
			this._width = n.width, this._height = n.height, t = new P(this._width * this._pixelRatio, this._height * this._pixelRatio, { type: C }), t.texture.name = "EffectComposer.rt1";
		} else this._width = t.width, this._height = t.height;
		this.renderTarget1 = t, this.renderTarget2 = t.clone(), this.renderTarget2.texture.name = "EffectComposer.rt2", this.writeBuffer = this.renderTarget1, this.readBuffer = this.renderTarget2, this.renderToScreen = !0, this.passes = [], this.copyPass = new Ee(Se), this.copyPass.material.blending = O, this.clock = new y();
	}
	swapBuffers() {
		let e = this.readBuffer;
		this.readBuffer = this.writeBuffer, this.writeBuffer = e;
	}
	addPass(e) {
		this.passes.push(e), e.setSize(this._width * this._pixelRatio, this._height * this._pixelRatio);
	}
	insertPass(e, t) {
		this.passes.splice(t, 0, e), e.setSize(this._width * this._pixelRatio, this._height * this._pixelRatio);
	}
	removePass(e) {
		let t = this.passes.indexOf(e);
		t !== -1 && this.passes.splice(t, 1);
	}
	isLastEnabledPass(e) {
		for (let t = e + 1; t < this.passes.length; t++) if (this.passes[t].enabled) return !1;
		return !0;
	}
	render(e) {
		e === void 0 && (e = this.clock.getDelta());
		let t = this.renderer.getRenderTarget(), n = !1;
		for (let t = 0, r = this.passes.length; t < r; t++) {
			let r = this.passes[t];
			if (r.enabled !== !1) {
				if (r.renderToScreen = this.renderToScreen && this.isLastEnabledPass(t), r.render(this.renderer, this.writeBuffer, this.readBuffer, e, n), r.needsSwap) {
					if (n) {
						let t = this.renderer.getContext(), n = this.renderer.state.buffers.stencil;
						n.setFunc(t.NOTEQUAL, 1, 4294967295), this.copyPass.render(this.renderer, this.writeBuffer, this.readBuffer, e), n.setFunc(t.EQUAL, 1, 4294967295);
					}
					this.swapBuffers();
				}
				De !== void 0 && (r instanceof De ? n = !0 : r instanceof Oe && (n = !1));
			}
		}
		this.renderer.setRenderTarget(t);
	}
	reset(e) {
		if (e === void 0) {
			let t = this.renderer.getSize(new M());
			this._pixelRatio = this.renderer.getPixelRatio(), this._width = t.width, this._height = t.height, e = this.renderTarget1.clone(), e.setSize(this._width * this._pixelRatio, this._height * this._pixelRatio);
		}
		this.renderTarget1.dispose(), this.renderTarget2.dispose(), this.renderTarget1 = e, this.renderTarget2 = e.clone(), this.writeBuffer = this.renderTarget1, this.readBuffer = this.renderTarget2;
	}
	setSize(e, t) {
		this._width = e, this._height = t;
		let n = this._width * this._pixelRatio, r = this._height * this._pixelRatio;
		this.renderTarget1.setSize(n, r), this.renderTarget2.setSize(n, r);
		for (let e = 0; e < this.passes.length; e++) this.passes[e].setSize(n, r);
	}
	setPixelRatio(e) {
		this._pixelRatio = e, this.setSize(this._width, this._height);
	}
	dispose() {
		this.renderTarget1.dispose(), this.renderTarget2.dispose(), this.copyPass.dispose();
	}
}, Ae = {
	name: "OutputShader",
	uniforms: {
		tDiffuse: { value: null },
		toneMappingExposure: { value: 1 }
	},
	vertexShader: "\n		precision highp float;\n\n		uniform mat4 modelViewMatrix;\n		uniform mat4 projectionMatrix;\n\n		attribute vec3 position;\n		attribute vec2 uv;\n\n		varying vec2 vUv;\n\n		void main() {\n\n			vUv = uv;\n			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );\n\n		}",
	fragmentShader: "\n	\n		precision highp float;\n\n		uniform sampler2D tDiffuse;\n\n		#include <tonemapping_pars_fragment>\n		#include <colorspace_pars_fragment>\n\n		varying vec2 vUv;\n\n		void main() {\n\n			gl_FragColor = texture2D( tDiffuse, vUv );\n\n			// tone mapping\n\n			#ifdef LINEAR_TONE_MAPPING\n\n				gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );\n\n			#elif defined( REINHARD_TONE_MAPPING )\n\n				gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );\n\n			#elif defined( CINEON_TONE_MAPPING )\n\n				gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );\n\n			#elif defined( ACES_FILMIC_TONE_MAPPING )\n\n				gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );\n\n			#elif defined( AGX_TONE_MAPPING )\n\n				gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );\n\n			#elif defined( NEUTRAL_TONE_MAPPING )\n\n				gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );\n\n			#endif\n\n			// color space\n\n			#ifdef SRGB_TRANSFER\n\n				gl_FragColor = sRGBTransferOETF( gl_FragColor );\n\n			#endif\n\n		}"
}, je = class extends H {
	constructor() {
		super();
		let e = Ae;
		this.uniforms = j.clone(e.uniforms), this.material = new ee({
			name: e.name,
			uniforms: this.uniforms,
			vertexShader: e.vertexShader,
			fragmentShader: e.fragmentShader
		}), this.fsQuad = new Te(this.material), this._outputColorSpace = null, this._toneMapping = null;
	}
	render(e, t, n) {
		this.uniforms.tDiffuse.value = n.texture, this.uniforms.toneMappingExposure.value = e.toneMappingExposure, (this._outputColorSpace !== e.outputColorSpace || this._toneMapping !== e.toneMapping) && (this._outputColorSpace = e.outputColorSpace, this._toneMapping = e.toneMapping, this.material.defines = {}, x.getTransfer(this._outputColorSpace) === ne && (this.material.defines.SRGB_TRANSFER = ""), this._toneMapping === w ? this.material.defines.LINEAR_TONE_MAPPING = "" : this._toneMapping === te ? this.material.defines.REINHARD_TONE_MAPPING = "" : this._toneMapping === v ? this.material.defines.CINEON_TONE_MAPPING = "" : this._toneMapping === m ? this.material.defines.ACES_FILMIC_TONE_MAPPING = "" : this._toneMapping === g ? this.material.defines.AGX_TONE_MAPPING = "" : this._toneMapping === D && (this.material.defines.NEUTRAL_TONE_MAPPING = ""), this.material.needsUpdate = !0), this.renderToScreen === !0 ? (e.setRenderTarget(null), this.fsQuad.render(e)) : (e.setRenderTarget(t), this.clear && e.clear(e.autoClearColor, e.autoClearDepth, e.autoClearStencil), this.fsQuad.render(e));
	}
	dispose() {
		this.material.dispose(), this.fsQuad.dispose();
	}
}, Me = class extends H {
	constructor(e, t, n = null, r = null, i = null) {
		super(), this.scene = e, this.camera = t, this.overrideMaterial = n, this.clearColor = r, this.clearAlpha = i, this.clear = !0, this.clearDepth = !1, this.needsSwap = !1, this._oldClearColor = new b();
	}
	render(e, t, n) {
		let r = e.autoClear;
		e.autoClear = !1;
		let i, a;
		this.overrideMaterial !== null && (a = this.scene.overrideMaterial, this.scene.overrideMaterial = this.overrideMaterial), this.clearColor !== null && (e.getClearColor(this._oldClearColor), e.setClearColor(this.clearColor, e.getClearAlpha())), this.clearAlpha !== null && (i = e.getClearAlpha(), e.setClearAlpha(this.clearAlpha)), this.clearDepth == 1 && e.clearDepth(), e.setRenderTarget(this.renderToScreen ? null : n), this.clear === !0 && e.clear(e.autoClearColor, e.autoClearDepth, e.autoClearStencil), e.render(this.scene, this.camera), this.clearColor !== null && e.setClearColor(this._oldClearColor), this.clearAlpha !== null && e.setClearAlpha(i), this.overrideMaterial !== null && (this.scene.overrideMaterial = a), e.autoClear = r;
	}
}, Ne = {
	name: "LuminosityHighPassShader",
	shaderID: "luminosityHighPass",
	uniforms: {
		tDiffuse: { value: null },
		luminosityThreshold: { value: 1 },
		smoothWidth: { value: 1 },
		defaultColor: { value: new b(0) },
		defaultOpacity: { value: 0 }
	},
	vertexShader: "\n\n		varying vec2 vUv;\n\n		void main() {\n\n			vUv = uv;\n\n			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );\n\n		}",
	fragmentShader: "\n\n		uniform sampler2D tDiffuse;\n		uniform vec3 defaultColor;\n		uniform float defaultOpacity;\n		uniform float luminosityThreshold;\n		uniform float smoothWidth;\n\n		varying vec2 vUv;\n\n		void main() {\n\n			vec4 texel = texture2D( tDiffuse, vUv );\n\n			float v = luminance( texel.xyz );\n\n			vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity );\n\n			float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );\n\n			gl_FragColor = mix( outputColor, texel, alpha );\n\n		}"
}, Pe = class e extends H {
	constructor(e, t, n, r) {
		super(), this.strength = t === void 0 ? 1 : t, this.radius = n, this.threshold = r, this.resolution = e === void 0 ? new M(256, 256) : new M(e.x, e.y), this.clearColor = new b(0, 0, 0), this.renderTargetsHorizontal = [], this.renderTargetsVertical = [], this.nMips = 5;
		let i = Math.round(this.resolution.x / 2), a = Math.round(this.resolution.y / 2);
		this.renderTargetBright = new P(i, a, { type: C }), this.renderTargetBright.texture.name = "UnrealBloomPass.bright", this.renderTargetBright.texture.generateMipmaps = !1;
		for (let e = 0; e < this.nMips; e++) {
			let t = new P(i, a, { type: C });
			t.texture.name = "UnrealBloomPass.h" + e, t.texture.generateMipmaps = !1, this.renderTargetsHorizontal.push(t);
			let n = new P(i, a, { type: C });
			n.texture.name = "UnrealBloomPass.v" + e, n.texture.generateMipmaps = !1, this.renderTargetsVertical.push(n), i = Math.round(i / 2), a = Math.round(a / 2);
		}
		let o = Ne;
		this.highPassUniforms = j.clone(o.uniforms), this.highPassUniforms.luminosityThreshold.value = r, this.highPassUniforms.smoothWidth.value = .01, this.materialHighPassFilter = new A({
			uniforms: this.highPassUniforms,
			vertexShader: o.vertexShader,
			fragmentShader: o.fragmentShader
		}), this.separableBlurMaterials = [];
		let s = [
			3,
			5,
			7,
			9,
			11
		];
		i = Math.round(this.resolution.x / 2), a = Math.round(this.resolution.y / 2);
		for (let e = 0; e < this.nMips; e++) this.separableBlurMaterials.push(this.getSeperableBlurMaterial(s[e])), this.separableBlurMaterials[e].uniforms.invSize.value = new M(1 / i, 1 / a), i = Math.round(i / 2), a = Math.round(a / 2);
		this.compositeMaterial = this.getCompositeMaterial(this.nMips), this.compositeMaterial.uniforms.blurTexture1.value = this.renderTargetsVertical[0].texture, this.compositeMaterial.uniforms.blurTexture2.value = this.renderTargetsVertical[1].texture, this.compositeMaterial.uniforms.blurTexture3.value = this.renderTargetsVertical[2].texture, this.compositeMaterial.uniforms.blurTexture4.value = this.renderTargetsVertical[3].texture, this.compositeMaterial.uniforms.blurTexture5.value = this.renderTargetsVertical[4].texture, this.compositeMaterial.uniforms.bloomStrength.value = t, this.compositeMaterial.uniforms.bloomRadius.value = .1;
		let c = [
			1,
			.8,
			.6,
			.4,
			.2
		];
		this.compositeMaterial.uniforms.bloomFactors.value = c, this.bloomTintColors = [
			new N(1, 1, 1),
			new N(1, 1, 1),
			new N(1, 1, 1),
			new N(1, 1, 1),
			new N(1, 1, 1)
		], this.compositeMaterial.uniforms.bloomTintColors.value = this.bloomTintColors;
		let l = Se;
		this.copyUniforms = j.clone(l.uniforms), this.blendMaterial = new A({
			uniforms: this.copyUniforms,
			vertexShader: l.vertexShader,
			fragmentShader: l.fragmentShader,
			blending: h,
			depthTest: !1,
			depthWrite: !1,
			transparent: !0
		}), this.enabled = !0, this.needsSwap = !1, this._oldClearColor = new b(), this.oldClearAlpha = 1, this.basic = new E(), this.fsQuad = new Te(null);
	}
	dispose() {
		for (let e = 0; e < this.renderTargetsHorizontal.length; e++) this.renderTargetsHorizontal[e].dispose();
		for (let e = 0; e < this.renderTargetsVertical.length; e++) this.renderTargetsVertical[e].dispose();
		this.renderTargetBright.dispose();
		for (let e = 0; e < this.separableBlurMaterials.length; e++) this.separableBlurMaterials[e].dispose();
		this.compositeMaterial.dispose(), this.blendMaterial.dispose(), this.basic.dispose(), this.fsQuad.dispose();
	}
	setSize(e, t) {
		let n = Math.round(e / 2), r = Math.round(t / 2);
		this.renderTargetBright.setSize(n, r);
		for (let e = 0; e < this.nMips; e++) this.renderTargetsHorizontal[e].setSize(n, r), this.renderTargetsVertical[e].setSize(n, r), this.separableBlurMaterials[e].uniforms.invSize.value = new M(1 / n, 1 / r), n = Math.round(n / 2), r = Math.round(r / 2);
	}
	render(t, n, r, i, a) {
		t.getClearColor(this._oldClearColor), this.oldClearAlpha = t.getClearAlpha();
		let o = t.autoClear;
		t.autoClear = !1, t.setClearColor(this.clearColor, 0), a && t.state.buffers.stencil.setTest(!1), this.renderToScreen && (this.fsQuad.material = this.basic, this.basic.map = r.texture, t.setRenderTarget(null), t.clear(), this.fsQuad.render(t)), this.highPassUniforms.tDiffuse.value = r.texture, this.highPassUniforms.luminosityThreshold.value = this.threshold, this.fsQuad.material = this.materialHighPassFilter, t.setRenderTarget(this.renderTargetBright), t.clear(), this.fsQuad.render(t);
		let s = this.renderTargetBright;
		for (let n = 0; n < this.nMips; n++) this.fsQuad.material = this.separableBlurMaterials[n], this.separableBlurMaterials[n].uniforms.colorTexture.value = s.texture, this.separableBlurMaterials[n].uniforms.direction.value = e.BlurDirectionX, t.setRenderTarget(this.renderTargetsHorizontal[n]), t.clear(), this.fsQuad.render(t), this.separableBlurMaterials[n].uniforms.colorTexture.value = this.renderTargetsHorizontal[n].texture, this.separableBlurMaterials[n].uniforms.direction.value = e.BlurDirectionY, t.setRenderTarget(this.renderTargetsVertical[n]), t.clear(), this.fsQuad.render(t), s = this.renderTargetsVertical[n];
		this.fsQuad.material = this.compositeMaterial, this.compositeMaterial.uniforms.bloomStrength.value = this.strength, this.compositeMaterial.uniforms.bloomRadius.value = this.radius, this.compositeMaterial.uniforms.bloomTintColors.value = this.bloomTintColors, t.setRenderTarget(this.renderTargetsHorizontal[0]), t.clear(), this.fsQuad.render(t), this.fsQuad.material = this.blendMaterial, this.copyUniforms.tDiffuse.value = this.renderTargetsHorizontal[0].texture, a && t.state.buffers.stencil.setTest(!0), this.renderToScreen ? (t.setRenderTarget(null), this.fsQuad.render(t)) : (t.setRenderTarget(r), this.fsQuad.render(t)), t.setClearColor(this._oldClearColor, this.oldClearAlpha), t.autoClear = o;
	}
	getSeperableBlurMaterial(e) {
		let t = [];
		for (let n = 0; n < e; n++) t.push(.39894 * Math.exp(-.5 * n * n / (e * e)) / e);
		return new A({
			defines: { KERNEL_RADIUS: e },
			uniforms: {
				colorTexture: { value: null },
				invSize: { value: new M(.5, .5) },
				direction: { value: new M(.5, .5) },
				gaussianCoefficients: { value: t }
			},
			vertexShader: "varying vec2 vUv;\n				void main() {\n					vUv = uv;\n					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );\n				}",
			fragmentShader: "#include <common>\n				varying vec2 vUv;\n				uniform sampler2D colorTexture;\n				uniform vec2 invSize;\n				uniform vec2 direction;\n				uniform float gaussianCoefficients[KERNEL_RADIUS];\n\n				void main() {\n					float weightSum = gaussianCoefficients[0];\n					vec3 diffuseSum = texture2D( colorTexture, vUv ).rgb * weightSum;\n					for( int i = 1; i < KERNEL_RADIUS; i ++ ) {\n						float x = float(i);\n						float w = gaussianCoefficients[i];\n						vec2 uvOffset = direction * invSize * x;\n						vec3 sample1 = texture2D( colorTexture, vUv + uvOffset ).rgb;\n						vec3 sample2 = texture2D( colorTexture, vUv - uvOffset ).rgb;\n						diffuseSum += (sample1 + sample2) * w;\n						weightSum += 2.0 * w;\n					}\n					gl_FragColor = vec4(diffuseSum/weightSum, 1.0);\n				}"
		});
	}
	getCompositeMaterial(e) {
		return new A({
			defines: { NUM_MIPS: e },
			uniforms: {
				blurTexture1: { value: null },
				blurTexture2: { value: null },
				blurTexture3: { value: null },
				blurTexture4: { value: null },
				blurTexture5: { value: null },
				bloomStrength: { value: 1 },
				bloomFactors: { value: null },
				bloomTintColors: { value: null },
				bloomRadius: { value: 0 }
			},
			vertexShader: "varying vec2 vUv;\n				void main() {\n					vUv = uv;\n					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );\n				}",
			fragmentShader: "varying vec2 vUv;\n				uniform sampler2D blurTexture1;\n				uniform sampler2D blurTexture2;\n				uniform sampler2D blurTexture3;\n				uniform sampler2D blurTexture4;\n				uniform sampler2D blurTexture5;\n				uniform float bloomStrength;\n				uniform float bloomRadius;\n				uniform float bloomFactors[NUM_MIPS];\n				uniform vec3 bloomTintColors[NUM_MIPS];\n\n				float lerpBloomFactor(const in float factor) {\n					float mirrorFactor = 1.2 - factor;\n					return mix(factor, mirrorFactor, bloomRadius);\n				}\n\n				void main() {\n					gl_FragColor = bloomStrength * ( lerpBloomFactor(bloomFactors[0]) * vec4(bloomTintColors[0], 1.0) * texture2D(blurTexture1, vUv) +\n						lerpBloomFactor(bloomFactors[1]) * vec4(bloomTintColors[1], 1.0) * texture2D(blurTexture2, vUv) +\n						lerpBloomFactor(bloomFactors[2]) * vec4(bloomTintColors[2], 1.0) * texture2D(blurTexture3, vUv) +\n						lerpBloomFactor(bloomFactors[3]) * vec4(bloomTintColors[3], 1.0) * texture2D(blurTexture4, vUv) +\n						lerpBloomFactor(bloomFactors[4]) * vec4(bloomTintColors[4], 1.0) * texture2D(blurTexture5, vUv) );\n				}"
		});
	}
};
Pe.BlurDirectionX = new M(1, 0), Pe.BlurDirectionY = new M(0, 1);
//#endregion
//#region src/presets/solar-system.ts
var Fe = {
	starHot: "#fff3d2",
	starWarm: "#e8a052",
	keyLight: "#ffd6a0",
	background: "#01040c"
}, Ie = {
	starHot: "#5e97f2",
	starWarm: "#a3c2f4",
	keyLight: "#d4e2ff",
	background: "#01040c"
};
function Le() {
	let e = (e, t, n, r, i) => ({
		id: `sol-${e}`,
		name: t,
		archetype: n,
		definition: r,
		rank: e,
		memoryCount: i,
		memories: []
	});
	return {
		star: {
			name: "Sol",
			definition: "The one that lights everything you remember."
		},
		planets: [
			e(1, "Mercury", "rocky", "Small, fast, scorched.", 8),
			e(2, "Venus", "volcanic", "Beautiful and uninhabitable.", 12),
			e(3, "Earth", "oceanic", "Home. Every memory starts here.", 42),
			e(4, "Mars", "rocky", "The one we keep writing stories about.", 18),
			e(5, "Jupiter", "gas", "Giant. Keeps the neighborhood safe.", 24),
			e(6, "Saturn", "gas", "The rings everybody came to see.", 20),
			e(7, "Uranus", "ice", "Rolls sideways. Judged unfairly.", 9),
			e(8, "Neptune", "ice", "Far, blue, patient.", 11)
		],
		asteroids: []
	};
}
//#endregion
//#region src/near-focus-3d/layout.ts
var U = Math.PI * 2, Re = 4.3, ze = .58, Be = 2.6, Ve = .094, He = .045, Ue = 8, We = 64, Ge = .52;
function W(e, t, n) {
	return Math.max(t, Math.min(n, e));
}
function Ke(e) {
	return Number.isFinite(e) && e >= 12;
}
function qe(e) {
	return [.05 + R(e, 353) * .19, R(e, 359) * U];
}
var Je = [
	"#9a835c",
	"#756f86",
	"#94727a",
	"#66878a",
	"#718873",
	"#947866",
	"#627f90",
	"#788188"
];
function Ye(e) {
	let t = typeof e == "string" ? e.trim().toLowerCase() : "";
	return t ? Je[Math.floor(R(t, 83) * Je.length)] : "#76858b";
}
function G(e) {
	return Number.isFinite(e.heat) ? W(e.heat, 0, 1) : .3;
}
function Xe(e) {
	let t = Date.parse(String(e.date || ""));
	return Number.isFinite(t) ? t : 0;
}
function Ze(e, t) {
	return G(t) - G(e) || Xe(t) - Xe(e) || e.id.localeCompare(t.id);
}
function Qe(e) {
	let t = [...e || []].filter((e) => !!String(e?.id || "").trim()).sort(Ze), n = /* @__PURE__ */ new Map();
	for (let e of t) n.has(e.id) || n.set(e.id, e);
	return [...n.values()];
}
function $e(e) {
	return R(e.id, 61);
}
function et(e) {
	return Number.isFinite(e.memoryCount) ? Math.max(0, Math.floor(e.memoryCount)) : 0;
}
function K(e) {
	return Number.isFinite(e.rank) ? Math.max(0, Math.floor(e.rank)) : 2 ** 53 - 1;
}
function tt(e) {
	return W(.24 + W(Math.log1p(et(e)) / Math.log1p(140), 0, 1) ** 1.5 * 1.02 + $e(e) * .1, .24, 1.42);
}
function nt(e) {
	let t = 1 / (1 + K(e)), n = W(Math.log1p(et(e)) / Math.log1p(200), 0, 1);
	return W(t * .35 + n * .45 + $e(e) * .2, 0, 1);
}
function rt(e, t) {
	return e * Ge * (Ke(t) ? 2.08 : 1) + .08;
}
function it(e) {
	let t = .75 + R(e.id, 733) * .6;
	return W((.06 + G(e) * .14) * t, .055, .21);
}
function at(e) {
	let t = .7 + R(e.id, 727) * .6;
	return W((.062 + G(e) * .046) * t, .05, .14);
}
function ot(e, t, n, r, i) {
	let a = `${t}:${e.id}`, o = Ke(r) ? 2.15 : 1.25, s = n * .8 * o + .34, c = s + i * .42 + (R(a, 103) - .5) * .05;
	return {
		memory: e,
		key: `memory:${e.id}`,
		localRadius: c,
		phase: R(a, 107) * U,
		inclination: (R(a, 109) - .5) * .06,
		angularSpeed: .24 * (c / s) ** -1.5 * (.9 + R(a, 113) * .2),
		size: it(e),
		color: Ye(e.category)
	};
}
function st(e, t, n) {
	let r = `memory:${e.id}`, i = Math.floor(R(r, 179) * 8) === 0, a = R(r, 151), o = R(r, 163), s = R(r, 181) < .5 ? -1 : 1, c = t;
	return {
		memory: e,
		key: r,
		radius: i ? c - 2.4 + a * 5.2 : c - 1.4 + a * 2.8,
		phase: R(r, 157) * U,
		inclination: i ? s * (.18 + o * .26) : (o - .5) * .16,
		ascendingNode: R(r, 167) * U,
		angularSpeed: i ? .01 + R(r, 173) * .007 : .015 + R(r, 173) * .004,
		size: at(e),
		color: Ye(e.category)
	};
}
function ct(e) {
	let t = [...e.planets || []].filter((e) => !!String(e?.id || "").trim()).sort((e, t) => K(e) - K(t) || e.id.localeCompare(t.id)), n = /* @__PURE__ */ new Map();
	for (let e of t) n.has(e.id) || n.set(e.id, e);
	let r = [...n.values()].map((e) => ({
		planet: e,
		memoryCount: et(e),
		rank: K(e),
		score: nt(e),
		size: tt(e)
	})), i = [...r].sort((e, t) => t.score - e.score || e.rank - t.rank || e.planet.id.localeCompare(t.planet.id)), a = /* @__PURE__ */ new Map(), o = /* @__PURE__ */ new Map(), s = Re, c = 0, l = 5.9, u = Math.max(1, Math.floor(i.length * .4));
	i.forEach((e, t) => {
		let n = rt(e.size, e.memoryCount);
		t === u && (l = s + Be / 2, s += Be);
		let r = s + (c > 0 || t === u ? Math.max(c, n) + ze : n);
		a.set(e.planet.id, r), o.set(e.planet.id, t), s = r, c = n;
	}), i.length > 0 && u >= i.length && (l = s + Be / 2);
	let d = r.map((e) => {
		let t = e.planet.id, n = o.get(t) || 0, r = a.get(t) ?? 4.3;
		return {
			planet: e.planet,
			key: `planet:${t}`,
			memoryCount: e.memoryCount,
			rank: e.rank,
			score: e.score,
			size: e.size,
			radius: r,
			phase: n * re + R(t, 17) * .9,
			inclination: (R(t, 41) - .5) * He,
			ascendingNode: R(t, 53) * U,
			angularSpeed: Ve * (r / Re) ** -1.35 * (.97 + R(t, 67) * .06)
		};
	}), f = Re;
	for (let e of d) f = Math.max(f, e.radius + rt(e.size, e.memoryCount));
	let p = f + 2.2, m = /* @__PURE__ */ new Map();
	for (let e of d) {
		let t = Qe(e.planet.memories).slice(0, Ue);
		m.set(e.planet.id, t.map((t, n) => ot(t, e.planet.id, e.size, e.memoryCount, n)));
	}
	return {
		planets: d,
		satellitesByPlanet: m,
		asteroids: Qe(e.asteroids).slice(0, We).map((e) => st(e, l, p)),
		mainBeltCenter: l,
		outerEdge: f,
		outerBelt: p
	};
}
//#endregion
//#region src/near-focus-3d/shaders.ts
var lt = {
	void: "#020606",
	panel: "#070a13",
	stellar: "#e8a052",
	stellarCore: "#fff3d2",
	corona: "#ffc878",
	coldDust: "#52698f",
	warmDust: "#c18459",
	target: "#d9e8ff",
	text: "#e7edf8"
}, ut = [
	{
		archetype: "rocky",
		archetypeIndex: 0,
		base: "#735f5a",
		deep: "#38272a",
		accent: "#b18d75",
		atmosphere: "#a8b2c3",
		atmosphereStrength: .05,
		ring: "#9e8b78"
	},
	{
		archetype: "oceanic",
		archetypeIndex: 1,
		base: "#3c6f9e",
		deep: "#102642",
		accent: "#92b0c6",
		atmosphere: "#83b9e6",
		atmosphereStrength: .15,
		ring: "#8395ad"
	},
	{
		archetype: "gas",
		archetypeIndex: 2,
		base: "#9b7467",
		deep: "#3c2526",
		accent: "#d0a273",
		atmosphere: "#d8bb98",
		atmosphereStrength: .11,
		ring: "#b19a7d"
	},
	{
		archetype: "ice",
		archetypeIndex: 3,
		base: "#6f85a9",
		deep: "#202944",
		accent: "#c0cde0",
		atmosphere: "#9bb9e8",
		atmosphereStrength: .13,
		ring: "#91a2bb"
	},
	{
		archetype: "volcanic",
		archetypeIndex: 4,
		base: "#7c443f",
		deep: "#32171c",
		accent: "#d06c50",
		atmosphere: "#ad8178",
		atmosphereStrength: .035,
		ring: "#956c5f"
	}
];
function dt(e, t) {
	let n = t ? ut.findIndex((e) => e.archetype === t) : -1;
	return ut[n >= 0 ? n : Math.floor(R(e, 211) * ut.length)];
}
var ft = "\n  varying vec3 vLocalPosition;\n  varying vec3 vWorldNormal;\n  varying vec3 vWorldPosition;\n  void main() {\n    vLocalPosition = position;\n    vWorldNormal = normalize(mat3(modelMatrix) * normal);\n    vec4 world = modelMatrix * vec4(position, 1.0);\n    vWorldPosition = world.xyz;\n    gl_Position = projectionMatrix * viewMatrix * world;\n  }\n", pt = "\n  varying vec2 vUv;\n  void main() {\n    vUv = uv;\n    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n  }\n", mt = "\n  uniform float uTime;\n  uniform float uLuminosity;\n  uniform float uActivity;\n  uniform vec3 uWarm;\n  uniform vec3 uHot;\n  varying vec2 vUv;\n  void main() {\n    vec2 p = vUv * 2.0 - 1.0;\n    float radius = length(p);\n    float angle = atan(p.y, p.x + 0.00001);\n    float pulse = 0.975 + sin(uTime * (0.42 + uActivity * 0.16)) * 0.025;\n    float rayField = 0.5\n      + 0.24 * sin(angle * 5.0 + uTime * 0.035)\n      + 0.16 * sin(angle * 11.0 - uTime * 0.022)\n      + 0.1 * sin(angle * 19.0 + 1.7);\n    rayField = smoothstep(0.28, 0.9, rayField);\n\n    // Thin body fog, long ray-carved corona: the glow should read as the\n    // star's atmosphere, not a light bulb in mist.\n    float core = exp(-radius * radius * 54.0);\n    float innerHalo = exp(-radius * radius * 11.0) * 0.3;\n    float corona = exp(-radius * (3.4 + rayField * 1.6)) * (0.1 + rayField * 0.2);\n    float horizontal = exp(-abs(p.y) * 92.0) * exp(-abs(p.x) * 2.7) * 0.1;\n    float vertical = exp(-abs(p.x) * 108.0) * exp(-abs(p.y) * 5.6) * 0.032;\n    float energy = (core * 0.58 + innerHalo + corona + horizontal + vertical)\n      * pulse * (1.08 + uLuminosity * 0.5);\n    float edge = max(abs(p.x), abs(p.y));\n    energy *= 1.0 - smoothstep(0.78, 0.985, edge);\n    if (energy < 0.0025) discard;\n\n    vec3 color = mix(uWarm, uHot, clamp(core * 1.35 + innerHalo * 0.42, 0.0, 1.0));\n    color *= 0.7 + core * 0.5 + horizontal * 0.4;\n    gl_FragColor = vec4(color, clamp(energy, 0.0, 0.75));\n  }\n", ht = "\n  float hash31(vec3 p) {\n    p = fract(p * 0.1031);\n    p += dot(p, p.yzx + 33.33);\n    return fract((p.x + p.y) * p.z);\n  }\n  float noise3(vec3 p) {\n    vec3 i = floor(p);\n    vec3 f = fract(p);\n    f = f * f * (3.0 - 2.0 * f);\n    return mix(\n      mix(mix(hash31(i + vec3(0,0,0)), hash31(i + vec3(1,0,0)), f.x),\n          mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),\n      mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),\n          mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y),\n      f.z\n    );\n  }\n  float compactFbm(vec3 p, float detail) {\n    float value = noise3(p) * 0.76;\n    if (detail > 0.5) {\n      value += noise3(p * 2.07 + 13.7) * 0.24;\n    }\n    return value;\n  }\n", gt = `
  uniform float uTime;
  uniform float uDetail;
  uniform vec3 uWarm;
  uniform vec3 uHot;
  varying vec3 vLocalPosition;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  ${ht}
  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float facing = clamp(dot(normal, viewDir), 0.0, 1.0);
    vec3 p = normalize(vLocalPosition) * 10.5;
    float granules = compactFbm(p + vec3(uTime * 0.028, -uTime * 0.017, uTime * 0.012), uDetail);
    float fine = noise3(p * 2.0 - vec3(uTime * 0.018, uTime * 0.011, -uTime * 0.014));
    float cells = smoothstep(0.28, 0.84, granules * 0.78 + fine * 0.22);
    float limb = pow(facing, 0.38);
    vec3 color = mix(uWarm * 0.98, uHot * 1.14, 0.4 + cells * 0.42);
    color = mix(uWarm * (0.78 + cells * 0.22), color, 0.3 + limb * 0.7);
    color -= uWarm * (1.0 - cells) * 0.025;
    color += uHot * pow(cells, 3.0) * 0.13;
    color += uHot * pow(facing, 5.0) * 0.12;
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`, _t = `
  uniform vec3 uBase;
  uniform vec3 uDeep;
  uniform vec3 uAccent;
  uniform vec3 uAtmosphere;
  uniform vec3 uKeyColor;
  uniform vec3 uFillColor;
  uniform float uAtmosphereStrength;
  uniform float uArchetype;
  uniform float uSeed;
  uniform float uOpacity;
  uniform float uDetail;
  uniform float uFocus;
  varying vec3 vLocalPosition;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  ${ht}
  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 lightDir = normalize(-vWorldPosition);
    float facing = clamp(dot(normal, viewDir), 0.0, 1.0);
    float nDotL = dot(normal, lightDir);
    float wrap = clamp((nDotL + 0.16) / 1.16, 0.0, 1.0);
    float day = smoothstep(-0.12, 0.18, nDotL);
    vec3 local = normalize(vLocalPosition);
    vec3 samplePoint = local * (3.0 + uSeed * 1.6);
    float broad = compactFbm(samplePoint + uSeed * 19.0, uDetail);
    float fine = noise3(samplePoint * 2.65 - uSeed * 7.0);
    float latitude = local.y;
    float gasBands = 0.5 + 0.5 * sin(latitude * 22.0 + (broad - 0.5) * 7.5 + uSeed * 17.0);
    float gasStorm = smoothstep(0.62, 0.84, abs(broad - fine));
    float terrain = smoothstep(0.38, 0.66, broad * 0.76 + fine * 0.24);
    vec3 surface = mix(uDeep, uBase, 0.42 + broad * 0.38);
    if (uArchetype > 0.5 && uArchetype < 1.5) {
      vec3 ocean = mix(uDeep, uBase, 0.36 + broad * 0.36);
      vec3 land = mix(uBase, uAccent, 0.3 + fine * 0.26);
      surface = mix(ocean, land, terrain * 0.58);
      surface = mix(surface, uAtmosphere, smoothstep(0.74, 0.9, fine) * 0.18);
    } else if (uArchetype > 1.5 && uArchetype < 2.5) {
      surface = mix(uDeep, uBase, 0.44 + gasBands * 0.34);
      surface = mix(surface, uAccent, gasStorm * 0.16 + gasBands * 0.09);
    } else if (uArchetype > 2.5 && uArchetype < 3.5) {
      surface = mix(uDeep, uBase, 0.42 + broad * 0.36);
      surface = mix(surface, uAccent, smoothstep(0.62, 0.86, fine) * 0.17);
    } else if (uArchetype > 3.5) {
      float fissure = smoothstep(0.58, 0.76, abs(broad - fine));
      surface = mix(uDeep, uBase, 0.18 + terrain * 0.5);
      surface = mix(surface, uAccent, fissure * 0.26);
    } else {
      surface = mix(uDeep, uBase, 0.2 + terrain * 0.52);
      surface = mix(surface, uAccent, smoothstep(0.68, 0.9, fine) * 0.16);
    }
    vec3 keyLight = uKeyColor * (0.11 + wrap * 0.82);
    vec3 fillLight = uFillColor * (0.2 + facing * 0.12);
    vec3 nightSurface = mix(uDeep, uFillColor * 0.34, 0.46) * (0.36 + facing * 0.08);
    vec3 daySurface = surface * (keyLight + fillLight);
    vec3 color = mix(nightSurface, daySurface, day);
    color += uFillColor * (0.012 + facing * 0.014);

    // The fresnel rim is what makes a planet look alive — be generous.
    float rim = pow(1.0 - facing, 2.3);
    float sunRim = pow(1.0 - facing, 3.2) * smoothstep(-0.3, 0.35, nDotL);
    float atmosphereMask = 0.06 + uAtmosphereStrength * (0.95 + day * 1.7) + uFocus * 0.12;
    color += uAtmosphere * rim * atmosphereMask;
    color += mix(uAtmosphere, uKeyColor, 0.55) * sunRim * (0.22 + uAtmosphereStrength * 1.4);

    vec3 halfVector = lightDir + viewDir;
    vec3 halfDir = halfVector / max(length(halfVector), 0.0001);
    float specPower = 12.0;
    float specStrength = 0.025;
    if (uArchetype > 0.5 && uArchetype < 1.5) {
      specPower = 64.0;
      specStrength = 0.22;
    } else if (uArchetype > 1.5 && uArchetype < 2.5) {
      specPower = 20.0;
      specStrength = 0.055;
    } else if (uArchetype > 2.5 && uArchetype < 3.5) {
      specPower = 36.0;
      specStrength = 0.1;
    }
    float specular = pow(max(dot(normal, halfDir), 0.0), specPower) * day * specStrength;
    color += mix(uKeyColor, uAtmosphere, 0.22) * specular;
    color += mix(uBase, uAtmosphere, 0.3) * uFocus * (0.035 + rim * 0.055);
    gl_FragColor = vec4(color, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
//#endregion
//#region src/near-focus-3d/textures.ts
function vt(e = 64) {
	let t = document.createElement("canvas");
	t.width = e, t.height = e;
	let n = t.getContext("2d"), r = e / 2, i = n.createRadialGradient(r, r, 0, r, r, r);
	i.addColorStop(0, "rgba(255,255,255,1)"), i.addColorStop(.16, "rgba(255,255,255,0.9)"), i.addColorStop(.52, "rgba(255,255,255,0.24)"), i.addColorStop(1, "rgba(255,255,255,0)"), n.fillStyle = i, n.fillRect(0, 0, e, e);
	let a = new p.CanvasTexture(t);
	return a.colorSpace = p.SRGBColorSpace, a;
}
function yt(e = 128) {
	let t = document.createElement("canvas");
	t.width = e, t.height = e;
	let n = t.getContext("2d"), r = e / 2, i = n.createRadialGradient(r, r, 0, r, r, r * .32);
	i.addColorStop(0, "rgba(255,255,255,1)"), i.addColorStop(.35, "rgba(255,255,255,0.5)"), i.addColorStop(1, "rgba(255,255,255,0)"), n.fillStyle = i, n.fillRect(0, 0, e, e);
	let a = (e, t, i) => {
		n.save(), n.translate(r, r), n.rotate(e);
		let a = n.createLinearGradient(-t, 0, t, 0);
		a.addColorStop(0, "rgba(255,255,255,0)"), a.addColorStop(.5, "rgba(255,255,255,0.85)"), a.addColorStop(1, "rgba(255,255,255,0)"), n.fillStyle = a, n.fillRect(-t, -i / 2, t * 2, i), n.restore();
	};
	a(0, r * .96, e * .022), a(Math.PI / 2, r * .96, e * .022);
	let o = new p.CanvasTexture(t);
	return o.colorSpace = p.SRGBColorSpace, o;
}
function bt(e = 512, t = 40) {
	let n = document.createElement("canvas");
	n.width = e, n.height = t;
	let r = n.getContext("2d"), i = r.createLinearGradient(0, 0, e, 0);
	i.addColorStop(0, "rgba(255,255,255,0)"), i.addColorStop(.18, "rgba(255,255,255,0.12)"), i.addColorStop(.5, "rgba(255,255,255,0.95)"), i.addColorStop(.82, "rgba(255,255,255,0.12)"), i.addColorStop(1, "rgba(255,255,255,0)"), r.fillStyle = i, r.fillRect(0, 0, e, t);
	let a = r.createLinearGradient(0, 0, 0, t);
	a.addColorStop(0, "rgba(0,0,0,0)"), a.addColorStop(.5, "rgba(0,0,0,1)"), a.addColorStop(1, "rgba(0,0,0,0)"), r.globalCompositeOperation = "destination-in", r.fillStyle = a, r.fillRect(0, 0, e, t);
	let o = new p.CanvasTexture(n);
	return o.colorSpace = p.SRGBColorSpace, o;
}
function xt(e) {
	let t = (t, n) => {
		let r = Math.imul(t, 374761393) + Math.imul(n, 668265263) + Math.imul(e, 1442695041) | 0;
		return r = Math.imul(r ^ r >>> 13, 1274126177), ((r ^ r >>> 16) >>> 0) / 4294967296;
	}, n = (e) => e * e * (3 - 2 * e);
	return (e, r) => {
		let i = Math.floor(e), a = Math.floor(r), o = n(e - i), s = n(r - a), c = t(i, a), l = t(i + 1, a), u = t(i, a + 1), d = t(i + 1, a + 1);
		return c + (l - c) * o + (u - c) * s + (c - l - u + d) * o * s;
	};
}
function St(e, t, n, r = 4) {
	let i = 0, a = .5, o = 1;
	for (let s = 0; s < r; s += 1) i += e(t * o, n * o) * a, a *= .5, o *= 2.05;
	return i;
}
function Ct(e = 2048, t = 1024) {
	let n = document.createElement("canvas");
	n.width = e, n.height = t;
	let r = n.getContext("2d");
	r.fillStyle = "#050c1f", r.fillRect(0, 0, e, t), r.globalCompositeOperation = "lighter";
	let i = "88,104,150";
	for (let n = 0; n < e; n += 4) {
		let a = n / e, o = (.5 + Math.sin(a * Math.PI * 2 + .8) * .14) * t, s = r.createLinearGradient(0, o - t * .16, 0, o + t * .16);
		s.addColorStop(0, `rgba(${i},0)`), s.addColorStop(.5, `rgba(${i},0.055)`), s.addColorStop(1, `rgba(${i},0)`), r.fillStyle = s, r.fillRect(n, o - t * .16, 4, t * .32);
	}
	let a = new p.CanvasTexture(n);
	return a.colorSpace = p.NoColorSpace, a.mapping = p.EquirectangularReflectionMapping, a;
}
function wt(e = 0, t = 256) {
	let n = document.createElement("canvas");
	n.width = t, n.height = t;
	let r = n.getContext("2d"), i = xt(811 + e * 97), a = r.createImageData(t, t);
	for (let e = 0; e < t; e += 1) for (let n = 0; n < t; n += 1) {
		let r = n / t, o = e / t, s = St(i, r * 6, o * 6, 4), c = St(i, r * 18 + 9, o * 18 + 9, 3), l = 150 + (s - .5) * 110 + (c - .5) * 50, u = (e * t + n) * 4, d = Math.max(70, Math.min(235, l));
		a.data[u] = d, a.data[u + 1] = d, a.data[u + 2] = d, a.data[u + 3] = 255;
	}
	r.putImageData(a, 0, 0);
	let o = 15 + e * 2;
	for (let n = 0; n < o; n += 1) {
		let i = `moon-${e}-crater-${n}`, a = R(i, 907) * t, o = R(i, 911) * t, s = R(i, 929) > .72, c = (s ? 14 : 4) + R(i, 919) * (t * (s ? .13 : .07)), l = r.createRadialGradient(a, o, 0, a, o, c);
		l.addColorStop(0, "rgba(22,22,28,0.72)"), l.addColorStop(.68, "rgba(34,34,42,0.46)"), l.addColorStop(.86, "rgba(240,240,246,0.5)"), l.addColorStop(1, "rgba(240,240,246,0)"), r.fillStyle = l, r.fillRect(a - c, o - c, c * 2, c * 2);
	}
	let s = new p.CanvasTexture(n);
	return s.colorSpace = p.SRGBColorSpace, s;
}
function Tt(e = 160, t = 32) {
	let n = document.createElement("canvas");
	n.width = e, n.height = t;
	let r = n.getContext("2d"), i = t / 2, a = r.createLinearGradient(0, 0, e, 0);
	a.addColorStop(0, "rgba(255,255,255,0)"), a.addColorStop(.24, "rgba(255,255,255,0.08)"), a.addColorStop(.7, "rgba(255,255,255,0.34)"), a.addColorStop(.9, "rgba(255,255,255,0.92)"), a.addColorStop(1, "rgba(255,255,255,0)"), r.save(), r.shadowColor = "rgba(105,174,255,0.72)", r.shadowBlur = t * .18, r.fillStyle = a, r.beginPath(), r.moveTo(e * .02, i), r.lineTo(e * .88, i - t * .075), r.quadraticCurveTo(e * .965, i, e * .88, i + t * .075), r.closePath(), r.fill(), r.restore(), r.strokeStyle = a, r.lineWidth = Math.max(1, t * .035), r.lineCap = "round", r.beginPath(), r.moveTo(e * .08, i), r.lineTo(e * .94, i), r.stroke();
	let o = r.createRadialGradient(e * .91, i, 0, e * .91, i, t * .28);
	o.addColorStop(0, "rgba(255,255,255,1)"), o.addColorStop(.24, "rgba(255,255,255,0.78)"), o.addColorStop(1, "rgba(255,255,255,0)"), r.fillStyle = o, r.fillRect(e * .84, i - t * .3, t * .6, t * .6);
	let s = new p.CanvasTexture(n);
	return s.colorSpace = p.SRGBColorSpace, s;
}
//#endregion
//#region src/near-focus-3d/NearFocus3D.tsx
var Et = new p.Vector3(0, 0, 0), Dt = [
	"#8795b4",
	"#68799f",
	"#54658c"
], Ot = .65, kt = .5;
function At(e, t, n) {
	let r = new p.Vector3();
	e.getWorldPosition(r).project(t);
	let i = r.x * n.width * .5 + n.width * .5, a = -r.y * n.height * .5 + n.height * .5;
	return r.z >= -1 && r.z <= 1 && i >= 54 && i <= n.width - 54 && a >= 28 && a <= n.height - 80 ? [i, a] : [-1e4, -1e4];
}
function q(e, n = []) {
	let i = r(e, n);
	return t(() => () => i.dispose(), [i]), i;
}
var jt = null;
function Mt() {
	return jt ||= [
		0,
		1,
		2,
		3,
		4
	].map((e) => wt(e)), jt;
}
var J = (e) => {
	let t = Math.sin(e * 127.1 + 311.7) * 43758.5453;
	return t - Math.floor(t);
}, Nt = (e) => {
	let t = Math.max(1e-6, J(e)), n = J(e + .5);
	return Math.sqrt(-2 * Math.log(t)) * Math.cos(2 * Math.PI * n);
};
function Pt({ particleTexture: e }) {
	let { positions: n, colors: i, sizes: a } = r(() => {
		let e = 5200, t = new Float32Array(e * 3), n = new Float32Array(e * 3), r = new Float32Array(e), i = new p.Vector3(.42, 1, .3).normalize(), a = new p.Color("#ffdf92"), o = new p.Color("#fff2d8"), s = new p.Color("#aac8ff"), c = new p.Color("#f2f4f8"), l = new p.Vector3(), u = 0, d = 0;
		for (; u < e && d < e * 8;) {
			d += 1;
			let e = J(7 + d * 5.3) * Math.PI * 2, f = Math.asin(2 * J(7 + d * 6.1) - 1);
			l.set(Math.cos(f) * Math.cos(e), Math.sin(f), Math.cos(f) * Math.sin(e));
			let p = Math.abs(l.dot(i)) < .24 + Math.abs(Nt(7 + d * 2.7)) * .05;
			if (!(p ? J(7 + d * 3.9) < .8 : J(7 + d * 3.9) < .16)) continue;
			let m = 72 + J(7 + d * 3.1) * 23;
			t.set([
				l.x * m,
				l.y * m,
				l.z * m
			], u * 3);
			let h = J(7 + d * 7.7), g = p ? h < .68 ? a.clone().lerp(o, J(d)) : c.clone() : h < .45 ? s.clone().lerp(c, J(d)) : c.clone();
			n.set([
				g.r,
				g.g,
				g.b
			], u * 3);
			let _ = J(7 + d * 9.1);
			r[u] = (p ? 1 : .78) * (.35 + _ * _ * _ * 2.6), u += 1;
		}
		return {
			positions: t,
			colors: n,
			sizes: r
		};
	}, []), o = r(() => new p.ShaderMaterial({
		uniforms: { map: { value: e } },
		vertexShader: "\n      attribute float size;\n      varying vec3 vColor;\n      void main() {\n        vColor = color;\n        vec4 mv = modelViewMatrix * vec4(position, 1.0);\n        gl_PointSize = size * (240.0 / -mv.z);\n        gl_Position = projectionMatrix * mv;\n      }\n    ",
		fragmentShader: "\n      uniform sampler2D map;\n      varying vec3 vColor;\n      void main() {\n        gl_FragColor = vec4(vColor, 1.0) * texture2D(map, gl_PointCoord);\n      }\n    ",
		vertexColors: !0,
		transparent: !0,
		depthWrite: !1,
		blending: p.AdditiveBlending
	}), [e]);
	return t(() => () => o.dispose(), [o]), /* @__PURE__ */ I("points", {
		frustumCulled: !1,
		raycast: () => null,
		material: o,
		children: /* @__PURE__ */ L("bufferGeometry", { children: [
			/* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-position",
				args: [n, 3]
			}),
			/* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-color",
				args: [i, 3]
			}),
			/* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-size",
				args: [a, 1]
			})
		] })
	});
}
function Ft(e, t, n, r, i) {
	let a = Math.PI * (3 - Math.sqrt(5)), o = 1 - (e + .5) / t * 2, s = (e + i) * a + (R(`star-jitter-${i}-${e}`, 101) - .5) * .18, c = Math.sqrt(Math.max(0, 1 - o * o)), l = n + R(`star-radius-${i}-${e}`, 107) * r;
	return [
		Math.cos(s) * c * l,
		o * l,
		Math.sin(s) * c * l
	];
}
function It({ sparkTexture: e }) {
	let [t, n] = r(() => {
		let e = /* @__PURE__ */ new Float32Array(138), t = /* @__PURE__ */ new Float32Array(138), n = new p.Color("#ffd8a8"), r = new p.Color("#9ab9ff"), i = new p.Color("#ffffff");
		for (let a = 0; a < 46; a += 1) {
			e.set(Ft(a, 46, 32, 36, 8700), a * 3);
			let o = R(`bright-anchor-color-${a}`, 269), s = o < .18 ? n : o < .52 ? r : i, c = .78 + R(`bright-anchor-luma-${a}`, 271) * .22;
			t.set([
				s.r * c,
				s.g * c,
				s.b * c
			], a * 3);
		}
		return [e, t];
	}, [46]);
	return /* @__PURE__ */ L("points", {
		frustumCulled: !1,
		raycast: () => null,
		renderOrder: -30,
		children: [/* @__PURE__ */ L("bufferGeometry", { children: [/* @__PURE__ */ I("bufferAttribute", {
			attach: "attributes-position",
			args: [t, 3]
		}), /* @__PURE__ */ I("bufferAttribute", {
			attach: "attributes-color",
			args: [n, 3]
		})] }), /* @__PURE__ */ I("pointsMaterial", {
			map: e,
			vertexColors: !0,
			size: 9.2,
			sizeAttenuation: !1,
			transparent: !0,
			opacity: .84,
			alphaTest: .008,
			blending: p.AdditiveBlending,
			depthWrite: !1,
			fog: !1,
			toneMapped: !1
		})]
	});
}
function Lt({ node: e }) {
	let t = r(() => {
		let t = [];
		for (let n = 0; n <= 128; n += 1) {
			let r = n / 128 * Math.PI * 2;
			t.push(new p.Vector3(Math.cos(r) * e.radius, 0, Math.sin(r) * e.radius));
		}
		return t;
	}, [e.radius]), n = e.rank <= 3 ? 0 : e.rank <= 7 ? 1 : 2;
	return /* @__PURE__ */ I("group", {
		rotation: [
			e.inclination,
			e.ascendingNode,
			0
		],
		children: /* @__PURE__ */ I(d, {
			points: t,
			color: Dt[n],
			lineWidth: [
				1.25,
				1,
				.8
			][n],
			transparent: !0,
			opacity: [
				.18,
				.13,
				.09
			][n],
			raycast: () => null
		})
	});
}
function Rt({ radius: e, color: t, visible: n }) {
	if (!n) return null;
	let r = [
		.18,
		Math.PI * .5 + .18,
		Math.PI + .18,
		Math.PI * 1.5 + .18
	];
	return /* @__PURE__ */ I("group", {
		rotation: [
			-Math.PI / 2,
			0,
			0
		],
		children: r.map((n, r) => /* @__PURE__ */ L("mesh", {
			raycast: () => null,
			rotation: [
				0,
				0,
				n
			],
			children: [/* @__PURE__ */ I("torusGeometry", { args: [
				e,
				Math.max(.004, e * .006),
				4,
				18,
				Math.PI * .19
			] }), /* @__PURE__ */ I("meshBasicMaterial", {
				color: t,
				transparent: !0,
				opacity: .5,
				depthTest: !0,
				depthWrite: !1,
				toneMapped: !1
			})]
		}, r))
	});
}
function zt({ theme: e, motionTime: t, onSelect: n, flareTexture: a }) {
	let o = i(null), c = i(null), u = i(null), d = 2.4, f = r(() => ({
		uTime: { value: 0 },
		uDetail: { value: 1 },
		uWarm: { value: new p.Color(e.starWarm) },
		uHot: { value: new p.Color(e.starHot) }
	}), [e.starHot, e.starWarm]), m = r(() => ({
		uTime: { value: 0 },
		uLuminosity: { value: Ot },
		uActivity: { value: kt },
		uWarm: { value: new p.Color(e.starWarm) },
		uHot: { value: new p.Color(e.starHot) }
	}), [e.starHot, e.starWarm]);
	return s(() => {
		let e = t.current;
		if (o.current) {
			let t = 1 + Math.sin(e * .55) * .0043;
			o.current.scale.setScalar(t);
		}
		c.current && (c.current.uniforms.uTime.value = e), u.current && (u.current.uniforms.uTime.value = e);
	}), /* @__PURE__ */ L("group", {
		ref: o,
		onClick: (e) => {
			e.stopPropagation(), n();
		},
		children: [
			/* @__PURE__ */ I(l, {
				follow: !0,
				raycast: () => null,
				renderOrder: -4,
				children: /* @__PURE__ */ L("mesh", {
					scale: [
						25.3,
						25.3,
						1
					],
					raycast: () => null,
					children: [/* @__PURE__ */ I("planeGeometry", { args: [1, 1] }), /* @__PURE__ */ I("shaderMaterial", {
						ref: u,
						uniforms: m,
						vertexShader: pt,
						fragmentShader: mt,
						transparent: !0,
						blending: p.AdditiveBlending,
						depthTest: !0,
						depthWrite: !1,
						toneMapped: !1
					})]
				})
			}),
			/* @__PURE__ */ L("mesh", { children: [/* @__PURE__ */ I("sphereGeometry", { args: [
				d,
				58,
				40
			] }), /* @__PURE__ */ I("shaderMaterial", {
				ref: c,
				uniforms: f,
				vertexShader: ft,
				fragmentShader: gt
			})] }),
			/* @__PURE__ */ L("mesh", {
				scale: 1.05,
				raycast: () => null,
				children: [/* @__PURE__ */ I("sphereGeometry", { args: [
					d,
					48,
					32
				] }), /* @__PURE__ */ I("meshBasicMaterial", {
					color: e.starHot,
					side: p.BackSide,
					transparent: !0,
					opacity: .2,
					blending: p.AdditiveBlending,
					depthWrite: !1,
					toneMapped: !1
				})]
			}),
			/* @__PURE__ */ L(l, {
				follow: !0,
				raycast: () => null,
				renderOrder: -3,
				children: [/* @__PURE__ */ L("mesh", {
					raycast: () => null,
					scale: [
						d * 7,
						d * .72,
						1
					],
					children: [/* @__PURE__ */ I("planeGeometry", { args: [1, 1] }), /* @__PURE__ */ I("meshBasicMaterial", {
						map: a,
						color: e.starWarm,
						transparent: !0,
						opacity: .07,
						blending: p.AdditiveBlending,
						depthWrite: !1,
						toneMapped: !1
					})]
				}), /* @__PURE__ */ L("mesh", {
					raycast: () => null,
					scale: [
						d * 3.8,
						d * .34,
						1
					],
					children: [/* @__PURE__ */ I("planeGeometry", { args: [1, 1] }), /* @__PURE__ */ I("meshBasicMaterial", {
						map: a,
						color: e.starWarm,
						transparent: !0,
						opacity: .09,
						blending: p.AdditiveBlending,
						depthWrite: !1,
						toneMapped: !1
					})]
				})]
			})
		]
	});
}
function Bt({ satellite: e }) {
	let n = R(e.memory.id, 191) * U, i = r(() => {
		let t = [];
		for (let n = 0; n < 56; n += 1) {
			let r = n / 56 * Math.PI * 2;
			t.push(new p.Vector3(Math.cos(r) * e.localRadius, 0, Math.sin(r) * e.localRadius));
		}
		return new p.BufferGeometry().setFromPoints(t);
	}, [e.localRadius]);
	return t(() => () => i.dispose(), [i]), /* @__PURE__ */ I("group", {
		rotation: [
			e.inclination,
			n,
			0
		],
		children: /* @__PURE__ */ I("lineLoop", {
			geometry: i,
			raycast: () => null,
			children: /* @__PURE__ */ I("lineBasicMaterial", {
				color: lt.coldDust,
				transparent: !0,
				opacity: .3,
				depthWrite: !1,
				toneMapped: !1
			})
		})
	});
}
function Vt({ satellite: e, motionTime: t }) {
	let n = i(null), a = R(e.memory.id, 191) * U, o = e.size * .85, c = Mt()[Math.floor(R(e.memory.id, 983) * 5)], l = r(() => new p.Color(e.color).lerp(new p.Color("#fff7ea"), .3), [e.color]);
	return s(() => {
		n.current && (n.current.rotation.y = e.phase + t.current * e.angularSpeed);
	}), /* @__PURE__ */ I("group", {
		rotation: [
			e.inclination,
			a,
			0
		],
		raycast: () => null,
		children: /* @__PURE__ */ I("group", {
			ref: n,
			children: /* @__PURE__ */ I("group", {
				position: [
					e.localRadius,
					0,
					0
				],
				children: /* @__PURE__ */ L("mesh", {
					raycast: () => null,
					rotation: [
						0,
						R(e.memory.id, 977) * U,
						0
					],
					children: [/* @__PURE__ */ I("sphereGeometry", { args: [
						o,
						20,
						16
					] }), /* @__PURE__ */ I("meshStandardMaterial", {
						map: c,
						bumpMap: c,
						bumpScale: .35,
						color: e.color,
						emissive: l,
						emissiveIntensity: .34,
						roughness: .88,
						metalness: .04
					})]
				})
			})
		})
	});
}
function Ht({ node: e, visualSize: t, active: n, dimmed: a, motionTime: o, particleTexture: c, ringColor: l }) {
	let u = i(null), d = Math.min(460, Math.max(230, Math.round(e.memoryCount * 11))), f = qe(e.planet.id), m = R(e.planet.id, 373), h = m < .3 ? 0 : m < .6 ? 2 : m < .78 ? 1 : m < .92 ? 3 : 4, g = [
		1,
		1.35,
		.8,
		1.7,
		.7
	][h], _ = [
		1,
		.8,
		1.2,
		.5,
		1.45
	][h], v = Math.round(d * _), y = (h === 0 ? [[
		1.45,
		1.72,
		1
	], [
		1.78,
		2.08,
		.55
	]] : h === 1 ? [[
		1.4,
		1.95,
		.75
	]] : h === 2 ? [
		[
			1.45,
			1.58,
			.9
		],
		[
			1.66,
			1.78,
			.7
		],
		[
			1.88,
			2.02,
			.5
		]
	] : h === 3 ? [[
		1.5,
		1.68,
		1.25
	]] : [[
		1.38,
		2.2,
		.4
	]]).map(([e, n, r]) => [
		t * e,
		t * n,
		r
	]), [b, x] = r(() => {
		let n = new Float32Array(v * 3), r = new Float32Array(v * 3), i = new p.Color(l).lerp(new p.Color("#f4f0e6"), .22), a = i.clone().multiplyScalar(.72);
		for (let o = 0; o < v; o += 1) {
			let s = `${e.planet.id}-memory-ring-${o}`, c = R(s, 317) * Math.PI * 2, l = R(s, 311) * y.length, u = y[Math.min(y.length - 1, Math.floor(l))], d = (R(s, 331) + R(s, 401)) / 2, f = u[0] + d * (u[1] - u[0]), p = (R(s, 337) + R(s, 409) - 1) * Math.max(.012, t * .035);
			n.set([
				Math.cos(c) * f,
				p,
				Math.sin(c) * f
			], o * 3);
			let m = u[2] >= .8 ? i : a, h = (.45 + R(s, 349) * .55) * Math.min(1.15, u[2]);
			r.set([
				m.r * h,
				m.g * h,
				m.b * h
			], o * 3);
		}
		return [n, r];
	}, [
		v,
		e.planet.id,
		l,
		h,
		t
	]);
	s(() => {
		u.current && (u.current.rotation.y = o.current * .045);
	});
	let S = n ? .3 : a ? .02 : .19;
	return /* @__PURE__ */ L("group", {
		ref: u,
		rotation: [
			f[0],
			f[1],
			0
		],
		raycast: () => null,
		children: [y.map((e, t) => /* @__PURE__ */ L("mesh", {
			rotation: [
				-Math.PI / 2,
				0,
				0
			],
			raycast: () => null,
			children: [/* @__PURE__ */ I("ringGeometry", { args: [
				e[0],
				e[1],
				96
			] }), /* @__PURE__ */ I("meshBasicMaterial", {
				color: l,
				transparent: !0,
				opacity: S * e[2],
				side: p.DoubleSide,
				blending: p.AdditiveBlending,
				depthWrite: !1,
				toneMapped: !1
			})]
		}, t)), /* @__PURE__ */ L("points", {
			frustumCulled: !1,
			raycast: () => null,
			children: [/* @__PURE__ */ L("bufferGeometry", { children: [/* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-position",
				args: [b, 3]
			}), /* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-color",
				args: [x, 3]
			})] }), /* @__PURE__ */ I("pointsMaterial", {
				map: c,
				vertexColors: !0,
				size: .032 * g,
				sizeAttenuation: !0,
				transparent: !0,
				opacity: n ? .95 : a ? .06 : .75,
				alphaTest: .02,
				blending: p.AdditiveBlending,
				depthWrite: !1,
				toneMapped: !1
			})]
		})]
	});
}
function Ut({ node: e, satellites: n, selected: o, dimmed: c, theme: l, fontFamily: d, particleTexture: f, motionTime: m, positionMap: h, onSelect: g }) {
	let _ = i(null), v = i(null), y = i(null), [b, x] = a(!1), S = r(() => new p.Vector3(), []), C = r(() => dt(e.planet.id, e.planet.archetype), [e.planet.archetype, e.planet.id]), w = e.size * (o ? .8 : Ge), T = r(() => ({
		uBase: { value: new p.Color(C.base) },
		uDeep: { value: new p.Color(C.deep) },
		uAccent: { value: new p.Color(C.accent) },
		uAtmosphere: { value: new p.Color(C.atmosphere) },
		uKeyColor: { value: new p.Color(l.keyLight) },
		uFillColor: { value: new p.Color("#36537f") },
		uAtmosphereStrength: { value: C.atmosphereStrength },
		uArchetype: { value: C.archetypeIndex },
		uSeed: { value: R(e.planet.id, 197) },
		uOpacity: { value: 1 },
		uDetail: { value: 1 },
		uFocus: { value: 0 }
	}), [
		e.planet.id,
		C,
		l.keyLight
	]), E = o ? w * 1.05 : Math.max(e.size * 1.25, .42), D = c && !b ? .045 : 1;
	T.uOpacity.value = D, T.uFocus.value = +!!o, t(() => {
		let t = h.current;
		return t.set(e.key, S), () => {
			t.get(e.key) === S && t.delete(e.key), document.body.style.removeProperty("cursor");
		};
	}, [
		e.key,
		h,
		S
	]), s(() => {
		_.current && (_.current.rotation.y = e.phase + m.current * e.angularSpeed), v.current && (v.current.getWorldPosition(S), h.current.set(e.key, S)), y.current && (y.current.rotation.y = m.current * .075 + e.phase);
	}, -1);
	let O = b || o ? 1.025 : 1;
	return /* @__PURE__ */ I("group", {
		rotation: [
			e.inclination,
			e.ascendingNode,
			0
		],
		children: /* @__PURE__ */ I("group", {
			ref: _,
			children: /* @__PURE__ */ L("group", {
				ref: v,
				position: [
					e.radius,
					0,
					0
				],
				onPointerOver: (e) => {
					e.stopPropagation(), x(!0), document.body.style.cursor = "pointer";
				},
				onPointerOut: () => {
					x(!1), document.body.style.removeProperty("cursor");
				},
				onClick: (e) => {
					e.stopPropagation(), g();
				},
				children: [
					/* @__PURE__ */ L("mesh", { children: [/* @__PURE__ */ I("sphereGeometry", { args: [
						E,
						14,
						10
					] }), /* @__PURE__ */ I("meshBasicMaterial", {
						transparent: !0,
						opacity: 0,
						colorWrite: !1,
						depthWrite: !1
					})] }),
					/* @__PURE__ */ L("group", {
						ref: y,
						scale: O,
						children: [/* @__PURE__ */ L("mesh", { children: [/* @__PURE__ */ I("sphereGeometry", { args: [
							w,
							o ? 48 : 36,
							o ? 32 : 24
						] }), /* @__PURE__ */ I("shaderMaterial", {
							uniforms: T,
							vertexShader: ft,
							fragmentShader: _t,
							transparent: D < 1,
							depthWrite: D >= 1,
							dithering: !0
						})] }), /* @__PURE__ */ I(Rt, {
							radius: w * 1.24,
							color: lt.target,
							visible: o
						})]
					}),
					Ke(e.memoryCount) && /* @__PURE__ */ I(Ht, {
						node: e,
						visualSize: w,
						active: o,
						dimmed: c,
						motionTime: m,
						particleTexture: f,
						ringColor: C.ring
					}),
					o && n.map((e) => /* @__PURE__ */ I(Bt, { satellite: e }, `orbit-${e.key}`)),
					o && n.map((e) => /* @__PURE__ */ I(Vt, {
						satellite: e,
						motionTime: m
					}, e.key)),
					(o || b) && /* @__PURE__ */ I(u, {
						center: !0,
						position: [
							0,
							w + .43,
							0
						],
						calculatePosition: At,
						style: { pointerEvents: "none" },
						children: /* @__PURE__ */ L("div", {
							style: {
								color: o ? "#f5f8ff" : "rgba(224,233,250,0.86)",
								fontSize: o ? 12 : 10,
								fontFamily: d,
								whiteSpace: "nowrap",
								userSelect: "none",
								textShadow: "0 1px 3px #01030a, 0 0 8px rgba(94,122,188,0.46)"
							},
							children: [
								e.planet.name,
								" · ",
								e.memoryCount
							]
						})
					})
				]
			})
		})
	});
}
function Wt({ prefix: e, center: n, halfWidth: i, thickness: a, count: o, colorA: s, colorB: c, dotSize: l, particleTexture: u }) {
	let d = r(() => {
		let t = new Float32Array(o * 3), r = new Float32Array(o * 3), l = new p.Color(s), u = new p.Color(c), d = new p.Color();
		for (let s = 0; s < o; s += 1) {
			let o = R(`${e}-a-${s}`, 131) * Math.PI * 2, c = n + (R(`${e}-r-${s}`, 137) - .5) * 2 * i;
			t[s * 3] = Math.cos(o) * c, t[s * 3 + 1] = (R(`${e}-y-${s}`, 139) - .5) * a, t[s * 3 + 2] = Math.sin(o) * c;
			let f = .55 + R(`${e}-b-${s}`, 149) * .45;
			d.copy(l).lerp(u, R(`${e}-c-${s}`, 151)).multiplyScalar(f), r[s * 3] = d.r, r[s * 3 + 1] = d.g, r[s * 3 + 2] = d.b;
		}
		let f = new p.BufferGeometry();
		return f.setAttribute("position", new p.BufferAttribute(t, 3)), f.setAttribute("color", new p.BufferAttribute(r, 3)), f;
	}, [
		e,
		n,
		i,
		a,
		o,
		s,
		c
	]);
	return t(() => () => d.dispose(), [d]), /* @__PURE__ */ I("points", {
		geometry: d,
		raycast: () => null,
		children: /* @__PURE__ */ I("pointsMaterial", {
			map: u,
			size: l,
			vertexColors: !0,
			transparent: !0,
			opacity: .68,
			depthWrite: !1,
			sizeAttenuation: !0,
			fog: !1
		})
	});
}
function Gt({ motionTime: e, particleTexture: t, mainBeltCenter: n, outerBase: r }) {
	let a = i(null);
	return s(() => {
		a.current && (a.current.rotation.y = e.current * .012);
	}), /* @__PURE__ */ I(F, { children: /* @__PURE__ */ I("group", {
		ref: a,
		raycast: () => null,
		children: /* @__PURE__ */ I(Wt, {
			prefix: "belt-dust-inner",
			center: n,
			halfWidth: 1.3,
			thickness: .5,
			count: 820,
			colorA: "#c8a37a",
			colorB: "#8a715a",
			dotSize: .16,
			particleTexture: t
		})
	}) });
}
function Kt({ asteroids: e, motionTime: n }) {
	let a = i(null), o = r(() => new p.SphereGeometry(1, 18, 14), []);
	t(() => () => o.dispose(), [o]);
	let c = r(() => e.map((e) => new p.Euler(e.inclination, e.ascendingNode, 0)), [e]), l = r(() => new p.Matrix4(), []), u = r(() => new p.Quaternion(), []), d = r(() => new p.Vector3(), []), f = r(() => new p.Vector3(), []);
	return t(() => {
		let t = a.current;
		t && (e.forEach((e, n) => {
			t.setColorAt(n, new p.Color(e.color).multiplyScalar(1.75));
		}), t.instanceColor && (t.instanceColor.needsUpdate = !0));
	}, [e]), s(() => {
		let t = a.current;
		if (!t) return;
		let r = n.current;
		e.forEach((e, n) => {
			let i = e.phase + r * e.angularSpeed;
			f.set(Math.cos(i) * e.radius, 0, -Math.sin(i) * e.radius).applyEuler(c[n]), u.identity(), d.setScalar(e.size), l.compose(f, u, d), t.setMatrixAt(n, l);
		}), t.instanceMatrix.needsUpdate = !0;
	}, -1), e.length ? /* @__PURE__ */ I("instancedMesh", {
		ref: a,
		args: [
			o,
			void 0,
			e.length
		],
		raycast: () => null,
		children: /* @__PURE__ */ I("meshBasicMaterial", { toneMapped: !1 })
	}) : null;
}
function qt(e, t, n, r) {
	let i = Math.max(8, e + 3.2), a = p.MathUtils.degToRad(t), o = 2 * Math.atan(Math.tan(a / 2) * (n / r)), s = i / Math.tan(o / 2), c = (i * .42 + 3) / Math.tan(a / 2);
	return Math.max(s, c) * 1.12;
}
function Jt(e, t, n, r) {
	let i = r.x - n.x, a = r.y - n.y, o = r.z - n.z;
	[
		i,
		a,
		o
	].every(Number.isFinite) && (e.x += i, e.y += a, e.z += o, t.x += i, t.y += a, t.z += o, n.copy(r));
}
function Yt({ controlsRef: e, navKey: n, fitDistance: a, interactingRef: o, cameraMotionRef: l, positionMap: u }) {
	let { camera: d, invalidate: f } = c(), m = i(!0), h = i(n), g = i(0), _ = r(() => new p.Vector3(), []), v = r(() => new p.Vector3(), []), y = r(() => new p.Vector3(), []), b = r(() => new p.Vector3(), []), x = r(() => new p.Vector3(), []), S = r(() => new p.Vector3(.5, a * .34, a), [a]), C = r(() => new p.Vector3(0, 3.4, 5.2), []), w = r(() => new p.Vector3(), []), T = r(() => new p.Euler(), []), E = (e) => {
		if (e && e.startsWith("planet:")) {
			let [t, n] = qe(e.slice(7));
			return T.set(t, n, 0), w.copy(C).applyEuler(T);
		}
		return w.copy(C);
	};
	return t(() => {
		h.current = n, m.current = !0, g.current = 0, l.current = !0, f();
	}, [
		l,
		f,
		n,
		S
	]), s((t, n) => {
		let r = h.current ? u.current.get(h.current) : Et;
		if (o.current) {
			r && h.current && !l.current && e.current ? Jt(d.position, e.current.target, x, r) : r && x.copy(r);
			return;
		}
		if (!r) {
			l.current && f();
			return;
		}
		let i = e.current;
		if (!l.current) {
			h.current && i && (Jt(d.position, i.target, x, r), i.update());
			return;
		}
		m.current ? (v.copy(r), h.current ? _.copy(r).add(E(h.current)) : _.copy(S), y.copy(d.position), b.copy(i?.target || Et), x.copy(r), m.current = !1) : h.current && (v.copy(r), _.copy(r).add(E(h.current)), x.copy(r)), g.current = Math.min(1, g.current + Math.min(n, .1) / 1.35);
		let a = g.current, s = a * a * a * (a * (a * 6 - 15) + 10);
		if (d.position.lerpVectors(y, _, s), h.current) {
			let e = Math.min(.9, y.distanceTo(_) * .07) * Math.sin(a * Math.PI);
			d.position.y += e;
		}
		if (i && (i.target.lerpVectors(b, v, s), i.update()), a >= 1) {
			d.position.copy(_), i && (i.target.copy(v), i.update()), l.current = !1;
			return;
		}
		f();
	}, -.5), null;
}
function Xt({ cameraMotionRef: e, enabled: n }) {
	let a = i(null), o = i(null), c = r(() => new p.Object3D(), []), l = q(() => Tt(160, 32)), u = r(() => Array.from({ length: 10 }, (e, t) => ({
		angle: t / 10 * Math.PI * 2 + (R(`course-angle-${t}`, 239) - .5) * .22,
		phase: (t * .61803398875 + R(`course-phase-${t}`, 251) * .24) % 1,
		length: t % 6 == 0 ? .24 + t / 10 * .08 : t % 3 == 0 ? .14 + t / 10 * .04 : .065 + t * 5 % 10 / 10 * .055,
		thickness: t % 6 == 0 ? .046 : t % 3 == 0 ? .037 : .029
	})), [10]);
	return t(() => {
		o.current?.instanceMatrix.setUsage(p.DynamicDrawUsage);
	}, [10]), s(({ camera: t, clock: r }) => {
		let i = n && e.current;
		a.current && (a.current.visible = i), !(!i || !a.current || !o.current) && (a.current.position.copy(t.position), a.current.quaternion.copy(t.quaternion), u.forEach(({ angle: e, phase: t, length: n, thickness: i }, a) => {
			let s = (r.elapsedTime * 1.7 + t) % 1, l = .22 + s * .82, u = l + n + s * .045, d = Math.cos(e) * l * 1.46, f = Math.sin(e) * l * .9, p = Math.cos(e) * u * 1.46, m = Math.sin(e) * u * .9;
			c.position.set((d + p) / 2, (f + m) / 2, -3), c.rotation.set(0, 0, Math.atan2(m - f, p - d)), c.scale.set(Math.hypot(p - d, m - f), i, 1), c.updateMatrix(), o.current.setMatrixAt(a, c.matrix);
		}), o.current.instanceMatrix.needsUpdate = !0);
	}, -.25), /* @__PURE__ */ I("group", {
		ref: a,
		visible: !1,
		children: /* @__PURE__ */ L("instancedMesh", {
			ref: o,
			args: [
				void 0,
				void 0,
				10
			],
			renderOrder: 20,
			frustumCulled: !1,
			children: [/* @__PURE__ */ I("planeGeometry", { args: [1, 1] }), /* @__PURE__ */ I("meshBasicMaterial", {
				map: l,
				color: lt.target,
				transparent: !0,
				opacity: .72,
				blending: p.AdditiveBlending,
				depthTest: !1,
				depthWrite: !1,
				side: p.DoubleSide,
				toneMapped: !1
			})]
		})
	});
}
function Zt() {
	let { gl: e, scene: n, camera: i, size: a, viewport: o } = c(), l = r(() => {
		let t = new ke(e), r = new Me(n, i), a = new Pe(new p.Vector2(1, 1), .58, .44, .68), o = new je();
		return t.addPass(r), t.addPass(a), t.addPass(o), {
			composer: t,
			bloomPass: a,
			outputPass: o
		};
	}, [
		i,
		e,
		n
	]);
	return t(() => {
		let e = Math.min(o.dpr, 2);
		l.composer.setPixelRatio(e), l.composer.setSize(a.width, a.height), l.bloomPass.strength = .58, l.bloomPass.radius = .44, l.bloomPass.threshold = .68;
	}, [
		l,
		a.height,
		a.width,
		o.dpr
	]), t(() => () => {
		l.bloomPass.dispose(), l.outputPass.dispose(), l.composer.dispose();
	}, [l]), t(() => {
		let t = e.info.autoReset;
		return e.info.autoReset = !1, () => {
			e.info.autoReset = t, e.info.reset();
		};
	}, [e]), s(() => {
		e.info.reset(), l.composer.render();
	}, 1), null;
}
function Qt({ layout: e, theme: n, fontFamily: r, selection: a, onPick: o }) {
	let l = i(0), u = i(/* @__PURE__ */ new Map()), d = i(null), m = i(!1), h = i(!0), g = c((e) => e.camera), _ = c((e) => e.size), v = q(() => vt(64)), y = q(() => yt(128)), b = q(() => bt(512, 40)), x = q(() => Ct(2048, 1024));
	t(() => {
		let e = u.current;
		return () => {
			e.clear(), document.body.style.removeProperty("cursor");
		};
	}, []), s((e, t) => {
		l.current += Math.min(t, .05);
	}, -2);
	let S = a?.kind === "planet" ? a.id : null, C = S ? `planet:${S}` : null, w = g instanceof p.PerspectiveCamera && _.width && _.height ? qt(e.outerEdge, g.fov, _.width, _.height) : 30.5;
	return /* @__PURE__ */ L(F, { children: [
		/* @__PURE__ */ I("color", {
			attach: "background",
			args: [n.background]
		}),
		/* @__PURE__ */ I("fog", {
			attach: "fog",
			args: [
				n.background,
				28,
				82
			]
		}),
		/* @__PURE__ */ I("ambientLight", { intensity: .055 }),
		/* @__PURE__ */ I("hemisphereLight", {
			color: "#5c76a6",
			groundColor: "#09060b",
			intensity: .32
		}),
		/* @__PURE__ */ I("directionalLight", {
			color: "#7695c4",
			intensity: .22,
			position: [
				0,
				5,
				8
			]
		}),
		/* @__PURE__ */ I("pointLight", {
			color: n.keyLight,
			intensity: 80.8,
			distance: 80,
			decay: 2
		}),
		/* @__PURE__ */ L("mesh", {
			raycast: () => null,
			renderOrder: -50,
			rotation: [
				.22,
				-.64,
				-.18
			],
			children: [/* @__PURE__ */ I("sphereGeometry", { args: [
				92,
				48,
				28
			] }), /* @__PURE__ */ I("meshBasicMaterial", {
				map: x,
				side: p.BackSide,
				depthWrite: !1,
				fog: !1,
				toneMapped: !1
			})]
		}),
		/* @__PURE__ */ I(Pt, { particleTexture: v }),
		/* @__PURE__ */ I(It, { sparkTexture: y }),
		!C && /* @__PURE__ */ L("group", {
			position: [
				0,
				-.045,
				0
			],
			rotation: [
				-Math.PI / 2,
				0,
				0
			],
			raycast: () => null,
			children: [/* @__PURE__ */ L("mesh", {
				raycast: () => null,
				renderOrder: -10,
				scale: [
					3.4,
					3.4,
					1
				],
				children: [/* @__PURE__ */ I("planeGeometry", { args: [2, 2] }), /* @__PURE__ */ I("meshBasicMaterial", {
					map: v,
					color: "#d68e4d",
					transparent: !0,
					opacity: .085,
					blending: p.AdditiveBlending,
					depthTest: !1,
					depthWrite: !1,
					toneMapped: !1
				})]
			}), /* @__PURE__ */ L("mesh", {
				raycast: () => null,
				renderOrder: -11,
				scale: [
					9.6,
					9.6,
					1
				],
				children: [/* @__PURE__ */ I("planeGeometry", { args: [2, 2] }), /* @__PURE__ */ I("meshBasicMaterial", {
					map: v,
					color: "#345279",
					transparent: !0,
					opacity: .018,
					blending: p.AdditiveBlending,
					depthTest: !1,
					depthWrite: !1,
					toneMapped: !1
				})]
			})]
		}),
		!S && e.planets.map((e) => /* @__PURE__ */ I(Lt, { node: e }, `orbit-${e.key}`)),
		/* @__PURE__ */ I(zt, {
			theme: n,
			motionTime: l,
			onSelect: () => o(a?.kind === "star" ? null : { kind: "star" }),
			flareTexture: b
		}),
		e.planets.map((t) => /* @__PURE__ */ I(Ut, {
			node: t,
			satellites: S === t.planet.id && e.satellitesByPlanet.get(t.planet.id) || [],
			selected: S === t.planet.id,
			dimmed: !!S && S !== t.planet.id,
			theme: n,
			fontFamily: r,
			particleTexture: v,
			motionTime: l,
			positionMap: u,
			onSelect: () => o(S === t.planet.id ? null : {
				kind: "planet",
				id: t.planet.id
			})
		}, t.key)),
		/* @__PURE__ */ I(Gt, {
			motionTime: l,
			particleTexture: v,
			mainBeltCenter: e.mainBeltCenter,
			outerBase: e.outerEdge
		}),
		/* @__PURE__ */ I(Kt, {
			asteroids: e.asteroids,
			motionTime: l
		}),
		/* @__PURE__ */ I(Xt, {
			cameraMotionRef: h,
			enabled: !!C
		}),
		/* @__PURE__ */ I(Zt, {}),
		/* @__PURE__ */ I(Yt, {
			controlsRef: d,
			navKey: C,
			fitDistance: w,
			interactingRef: m,
			cameraMotionRef: h,
			positionMap: u
		}),
		/* @__PURE__ */ I(f, {
			ref: d,
			makeDefault: !0,
			enableDamping: !0,
			dampingFactor: .055,
			enablePan: !0,
			screenSpacePanning: !1,
			panSpeed: .9,
			touches: {
				ONE: p.TOUCH.ROTATE,
				TWO: p.TOUCH.DOLLY_PAN
			},
			rotateSpeed: .42,
			zoomSpeed: .72,
			minDistance: 5.5,
			maxDistance: Math.max(62, w * 1.5),
			minPolarAngle: .16,
			maxPolarAngle: Math.PI * .48,
			onStart: () => {
				m.current = !0, h.current = !1;
			},
			onEnd: () => {
				m.current = !1;
			}
		})
	] });
}
function $t({ snapshot: e, theme: n = Fe, onSelect: s, fontFamily: c = "ui-monospace, monospace" }) {
	let [l, u] = a(null), [d, f] = a(""), [m, h] = a(!1), [g, _] = a(!1), v = i(null), y = r(() => ct(e), [e]), b = r(() => e.planets.reduce((e, t) => e + Math.max(t.memoryCount || 0, t.memories?.length || 0), 0), [e]), x = r(() => {
		let e = d.trim().toLocaleLowerCase();
		return e ? y.planets.filter((t) => t.planet.name.toLocaleLowerCase().includes(e)).slice(0, 7) : [];
	}, [y, d]), S = l?.kind === "planet" && y.planets.find((e) => e.planet.id === l.id) || null, C = (e) => {
		if (u(e), s) if (e === null) s(null);
		else if (e.kind === "star") s({ kind: "star" });
		else {
			let t = y.planets.find((t) => t.planet.id === e.id);
			t && s({
				kind: "planet",
				planet: t.planet
			});
		}
	};
	return t(() => {
		l?.kind === "planet" && !S && (u(null), s?.(null));
	}, [
		s,
		S,
		l
	]), /* @__PURE__ */ L("div", {
		style: {
			position: "relative",
			width: "100%",
			height: "100%",
			background: n.background,
			fontFamily: c,
			touchAction: "none"
		},
		children: [
			/* @__PURE__ */ I(o, {
				dpr: [1, 2],
				camera: {
					position: [
						.5,
						10.6,
						30.5
					],
					fov: 42,
					near: .1,
					far: 220
				},
				gl: {
					antialias: !0,
					alpha: !1,
					powerPreference: "high-performance"
				},
				onCreated: ({ gl: e }) => {
					e.outputColorSpace = p.SRGBColorSpace, e.toneMapping = p.ACESFilmicToneMapping, e.toneMappingExposure = .98, e.setClearColor(n.background, 1);
				},
				onPointerMissed: () => C(null),
				style: {
					width: "100%",
					height: "100%",
					display: "block",
					touchAction: "none"
				},
				children: /* @__PURE__ */ I(Qt, {
					layout: y,
					theme: n,
					fontFamily: c,
					selection: l,
					onPick: C
				})
			}),
			/* @__PURE__ */ L("div", {
				style: {
					position: "absolute",
					top: 10,
					left: 12,
					pointerEvents: "none",
					color: "rgba(205,216,238,0.82)",
					fontSize: 10,
					lineHeight: 1.7,
					letterSpacing: .6,
					textShadow: "0 1px 3px rgba(1,3,10,0.9)",
					maxWidth: "62%"
				},
				children: [
					/* @__PURE__ */ I("div", {
						style: {
							color: "rgba(239,237,230,0.92)",
							fontSize: 11
						},
						children: e.star.name
					}),
					/* @__PURE__ */ L("div", { children: [
						y.planets.length,
						" 颗行星 · ",
						b,
						" 条记忆在轨道上",
						e.asteroids.length ? ` · ${e.asteroids.length} 颗还在漂` : ""
					] }),
					/* @__PURE__ */ I("div", {
						style: { opacity: .55 },
						children: l?.kind === "planet" ? "点空白处回到全景" : l?.kind === "star" ? e.star.definition || "一切的中心" : "点一颗行星 · 单指转动 · 双指缩放"
					})
				]
			}),
			/* @__PURE__ */ I("div", {
				style: {
					position: "absolute",
					top: 10,
					right: 10,
					display: "flex",
					alignItems: "center",
					gap: 6
				},
				children: /* @__PURE__ */ L("div", {
					style: {
						position: "relative",
						display: "flex",
						alignItems: "center"
					},
					children: [
						/* @__PURE__ */ I("input", {
							ref: v,
							value: d,
							onChange: (e) => f(e.target.value),
							onFocus: () => _(!0),
							onBlur: () => window.setTimeout(() => {
								_(!1), v.current?.value || h(!1);
							}, 140),
							onKeyDown: (e) => {
								e.key === "Enter" && x[0] ? (e.preventDefault(), C({
									kind: "planet",
									id: x[0].planet.id
								}), f(""), _(!1), h(!1)) : e.key === "Escape" && (f(""), _(!1), h(!1));
							},
							placeholder: "找一颗行星",
							"aria-label": "Search planets",
							tabIndex: m ? 0 : -1,
							style: {
								width: m ? 148 : 0,
								opacity: +!!m,
								transition: "width 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease",
								background: "rgba(4,7,16,0.88)",
								border: "1px solid rgba(205,216,238,0.22)",
								borderRight: "none",
								color: "#e8eef8",
								fontSize: 11,
								fontFamily: c,
								padding: m ? "5px 8px" : "5px 0",
								outline: "none"
							}
						}),
						/* @__PURE__ */ I("button", {
							type: "button",
							title: m ? "Close search" : "Search planets",
							"aria-label": m ? "Close search" : "Search planets",
							"aria-expanded": m,
							onClick: () => {
								m ? (f(""), h(!1), _(!1)) : (h(!0), window.setTimeout(() => v.current?.focus(), 30));
							},
							style: {
								background: "rgba(4,7,16,0.88)",
								border: "1px solid rgba(205,216,238,0.22)",
								color: "rgba(205,216,238,0.85)",
								width: 27,
								height: 27,
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								cursor: "pointer",
								padding: 0
							},
							children: /* @__PURE__ */ L("svg", {
								width: "15",
								height: "15",
								viewBox: "0 0 15 15",
								"aria-hidden": "true",
								children: [/* @__PURE__ */ I("circle", {
									cx: "6.4",
									cy: "6.4",
									r: "4.1",
									fill: "none",
									stroke: "currentColor",
									strokeWidth: "1.5"
								}), /* @__PURE__ */ I("line", {
									x1: "9.6",
									y1: "9.6",
									x2: "13.2",
									y2: "13.2",
									stroke: "currentColor",
									strokeWidth: "1.7",
									strokeLinecap: "round"
								})]
							})
						}),
						g && x.length > 0 && /* @__PURE__ */ I("div", {
							role: "listbox",
							"aria-label": "Planet search results",
							style: {
								position: "absolute",
								top: "calc(100% + 4px)",
								right: 0,
								minWidth: 175,
								background: "rgba(4,7,16,0.94)",
								border: "1px solid rgba(205,216,238,0.18)",
								zIndex: 30
							},
							children: x.map((e) => /* @__PURE__ */ L("button", {
								type: "button",
								role: "option",
								"aria-selected": l?.kind === "planet" && l.id === e.planet.id,
								onMouseDown: (e) => e.preventDefault(),
								onClick: () => {
									C({
										kind: "planet",
										id: e.planet.id
									}), f(""), _(!1), h(!1);
								},
								style: {
									display: "flex",
									justifyContent: "space-between",
									gap: 10,
									width: "100%",
									background: "none",
									border: "none",
									borderBottom: "1px solid rgba(205,216,238,0.08)",
									color: "#cdd8ea",
									fontSize: 11,
									fontFamily: c,
									padding: "6px 9px",
									cursor: "pointer",
									textAlign: "left"
								},
								children: [/* @__PURE__ */ I("span", { children: e.planet.name }), /* @__PURE__ */ I("span", {
									style: { opacity: .45 },
									children: e.planet.memoryCount
								})]
							}, e.planet.id))
						})
					]
				})
			})
		]
	});
}
//#endregion
//#region src/core/emotion-types.ts
function Y(e) {
	return Number.isFinite(e) ? Math.max(-1, Math.min(1, e)) : 0;
}
function X(e) {
	return Number.isFinite(e) ? Math.max(0, Math.min(1, e)) : 0;
}
function Z(e) {
	return Number.isFinite(e) ? Math.max(1, Math.min(5, Math.round(e))) : 3;
}
function en(e, t) {
	let n = Y(e), r = X(t);
	if (n < -.5) return [
		.3 + r * .15,
		.35 + r * .1,
		.9 + r * .1
	];
	if (n < -.15) {
		let e = (n + .5) / .35;
		return [
			.3 + e * .35 + r * .1,
			.35 + e * .3 + r * .1,
			.9 - e * .15
		];
	}
	if (n < .15) return [
		.65 + r * .15,
		.65 + r * .1,
		.75 + r * .1
	];
	if (n < .5) {
		let e = (n - .15) / .35;
		return [
			.75 + e * .25,
			.65 - e * .2 + r * .1,
			.55 - e * .3
		];
	}
	return [
		1,
		.4 + r * .15,
		.15 + r * .1
	];
}
function tn(e, t) {
	let [n, r, i] = en(e, t), a = (e) => Math.round(Math.max(0, Math.min(1, e)) * 255);
	return `rgb(${a(n)}, ${a(r)}, ${a(i)})`;
}
//#endregion
//#region src/echo-starmap/echoStarmapCore.ts
var Q = Object.freeze({
	l: 36,
	r: 16,
	t: 16,
	b: 36
}), nn = [
	[
		232,
		96,
		116
	],
	[
		255,
		208,
		130
	],
	[
		242,
		236,
		220
	],
	[
		134,
		222,
		198
	],
	[
		98,
		138,
		235
	],
	[
		158,
		124,
		230
	]
], rn = [
	"225,228,240",
	"225,228,240",
	"225,228,240",
	"236,232,222",
	"172,192,240",
	"172,192,240",
	"255,226,185",
	"230,122,136",
	"178,224,208",
	"196,178,238"
], an = (e) => Number.isFinite(e) ? Math.max(0, Math.min(1, e)) : 0;
function on(e, t, n) {
	let r = t * Math.min(n, 1 - n), i = (t) => {
		let i = (t + e / 30) % 12;
		return n - r * Math.max(-1, Math.min(i - 3, Math.min(9 - i, 1)));
	};
	return [
		Math.round(i(0) * 255),
		Math.round(i(8) * 255),
		Math.round(i(4) * 255)
	];
}
var sn = /hsl\((-?[\d.]+), ([\d.]+)%, ([\d.]+)%\)/;
function cn(e, t) {
	let n = sn.exec(tn(e, t));
	if (!n) return "200,190,170";
	let [r, i, a] = on(Number(n[1]), Number(n[2]) / 100, Number(n[3]) / 100);
	return `${r},${i},${a}`;
}
function ln(e, t, n, r, i, a) {
	return (a - t) * (n - e) - (r - t) * (i - e);
}
function un(e, t, n, r, i, a) {
	let o = i - n, s = a - r, c = o * o + s * s;
	if (c === 0) return Math.hypot(e - n, t - r);
	let l = Math.max(0, Math.min(1, ((e - n) * o + (t - r) * s) / c));
	return Math.hypot(e - (n + l * o), t - (r + l * s));
}
function dn(e, t, n, r, i) {
	let a = t - Q.l - Q.r, o = n - Q.t - Q.b;
	if (a <= 0 || o <= 0) return [];
	let s = Math.min(Math.max(Math.min(t, n) / 420, 1), 1.8), c = (e) => {
		let t = R(e, 1) * Math.PI * 2, n = R(e, 2) * Math.min(a, o) * .045;
		return {
			dx: Math.cos(t) * n,
			dy: Math.sin(t) * n
		};
	}, l = [];
	for (let e of r.moments) {
		let t = Y(e.valence), n = X(e.arousal), r = c(e.id);
		l.push({
			moment: e,
			v: t,
			a: n,
			importance: Z(e.importance),
			heat: Number.isFinite(e.heat) ? an(e.heat) : .4,
			isEvent: e.kind === "event",
			x: Q.l + (t + 1) / 2 * a + r.dx,
			y: Q.t + (1 - n) * o + r.dy,
			rgb: cn(t, n)
		});
	}
	let u = /* @__PURE__ */ new Map();
	for (let e of l) u.set(e.moment.id, e);
	let d = (t) => {
		e.save(), e.globalCompositeOperation = "lighter", t(), e.restore();
	}, f = 1234567, p = () => (f = f * 1664525 + 1013904223 >>> 0, f / 4294967296), m = Math.round(t * n / 650);
	for (let r = 0; r < m; r++) {
		let r = p() * t, i = p() * n, a = (.25 + p() * .85) * s, o = rn[Math.floor(p() * rn.length)];
		e.beginPath(), e.arc(r, i, a, 0, Math.PI * 2), e.fillStyle = `rgba(${o},${(.08 + p() * .3).toFixed(3)})`, e.fill();
	}
	if (typeof document < "u") {
		let t = nn.length, n = new Float32Array(t * 30 * 20);
		for (let e of l) {
			let r = Math.min(29, Math.max(0, Math.floor((e.v + 1) / 2 * 30))), i = Math.min(19, Math.max(0, Math.floor((1 - e.a) * 20))), a = Math.floor(R(e.moment.id, 3) * t) % t;
			for (let e = -1; e <= 1; e++) for (let t = -1; t <= 1; t++) {
				let o = r + t, s = i + e;
				o < 0 || o >= 30 || s < 0 || s >= 20 || (n[a * 30 * 20 + s * 30 + o] += t === 0 && e === 0 ? 1 : .35);
			}
		}
		let r = 0;
		for (let e = 0; e < n.length; e++) n[e] > r && (r = n[e]);
		if (r > 0) {
			let i = document.createElement("canvas");
			i.width = 30, i.height = 20;
			let s = i.getContext("2d");
			if (s) {
				e.save(), e.globalCompositeOperation = "lighter", e.filter = `blur(${Math.round(Math.min(a / 30, o / 20) * .8)}px)`;
				for (let c = 0; c < t; c++) {
					s.clearRect(0, 0, 30, 20);
					let [t, l, u] = nn[c], d = !1;
					for (let e = 0; e < 20; e++) for (let i = 0; i < 30; i++) {
						let a = n[c * 30 * 20 + e * 30 + i];
						a <= 0 || (d = !0, s.fillStyle = `rgba(${t},${l},${u},${(Math.sqrt(a / r) * .08).toFixed(3)})`, s.fillRect(i, e, 1, 1));
					}
					d && e.drawImage(i, Q.l - 26, Q.t - 20, a + 46, o + 42);
				}
				e.filter = "none", e.restore();
			}
		}
	}
	if (i.showAxis) {
		e.strokeStyle = "rgba(255,255,255,0.06)", e.lineWidth = 1;
		for (let t = 0; t <= 4; t++) {
			let n = Q.l + a / 4 * t;
			e.beginPath(), e.moveTo(n, Q.t), e.lineTo(n, Q.t + o), e.stroke();
		}
		for (let t = 0; t <= 4; t++) {
			let n = Q.t + o / 4 * t;
			e.beginPath(), e.moveTo(Q.l, n), e.lineTo(Q.l + a, n), e.stroke();
		}
		e.strokeStyle = "rgba(255,255,255,0.18)";
		let t = Q.l + a / 2, n = Q.t + o;
		e.beginPath(), e.moveTo(Q.l, n), e.lineTo(Q.l + a, n), e.stroke(), e.beginPath(), e.moveTo(t, Q.t), e.lineTo(t, Q.t + o), e.stroke(), e.font = `${Math.round(9 * s)}px ${i.fontFamily}`, e.fillStyle = "rgba(255,255,255,0.18)", e.textAlign = "left", e.fillText("tense · anxious", Q.l + 4, Q.t + 14), e.fillText("down · numb", Q.l + 4, Q.t + o - 4), e.textAlign = "right", e.fillText("elated · excited", Q.l + a - 4, Q.t + 14), e.fillText("calm · tender", Q.l + a - 4, Q.t + o - 4), e.fillStyle = "rgba(255,255,255,0.30)", e.font = `${Math.round(8 * s)}px ${i.fontFamily}`, e.textAlign = "left", e.fillText("negative", Q.l, Q.t + o + 14), e.textAlign = "right", e.fillText("positive", Q.l + a, Q.t + o + 14), e.fillText("calm", Q.l - 4, Q.t + o), e.fillText("storm", Q.l - 4, Q.t + 10), e.textAlign = "left";
	}
	let h = Math.min(a, o) * .12, g = /* @__PURE__ */ new Map(), _ = /* @__PURE__ */ new Map();
	for (let e of l) {
		let t = 0, n = [];
		for (let r of l) r !== e && Math.hypot(e.x - r.x, e.y - r.y) < h && (t++, n.push(r));
		g.set(e.moment.id, t), _.set(e.moment.id, n);
	}
	let v = (e) => (g.get(e) || 0) >= 4, y = /* @__PURE__ */ new Set();
	for (let t of l) {
		if (!v(t.moment.id) || y.has(t.moment.id)) continue;
		let n = [t];
		y.add(t.moment.id);
		for (let e of _.get(t.moment.id) || []) !y.has(e.moment.id) && v(e.moment.id) && (n.push(e), y.add(e.moment.id));
		let r = n.reduce((e, t) => e + t.x, 0) / n.length, i = n.reduce((e, t) => e + t.y, 0) / n.length, a = 0;
		for (let e of n) a = Math.max(a, Math.hypot(e.x - r, e.y - i));
		let o = n.map((e) => e.rgb.split(",").map(Number)), [s, c, l] = o.reduce((e, t) => [
			e[0] + t[0],
			e[1] + t[1],
			e[2] + t[2]
		]).map((e) => Math.round(e / o.length)), u = a + h * .6;
		d(() => {
			let t = e.createRadialGradient(r, i, 0, r, i, u * 1.5);
			t.addColorStop(0, `rgba(${s},${c},${l},0.06)`), t.addColorStop(.5, `rgba(${s},${c},${l},0.03)`), t.addColorStop(1, "transparent"), e.beginPath(), e.arc(r, i, u * 1.5, 0, Math.PI * 2), e.fillStyle = t, e.fill();
			for (let t of n) {
				let n = e.createRadialGradient(t.x, t.y, 0, t.x, t.y, h * .5);
				n.addColorStop(0, `rgba(${s},${c},${l},0.07)`), n.addColorStop(.7, `rgba(${s},${c},${l},0.02)`), n.addColorStop(1, "transparent"), e.beginPath(), e.arc(t.x, t.y, h * .5, 0, Math.PI * 2), e.fillStyle = n, e.fill();
			}
		});
	}
	let b = .6, x = .25, S = Math.min(a, o) * .3, C = [];
	for (let e of r.bonds || []) {
		if (e.source === e.target) continue;
		let t = u.get(e.source), n = u.get(e.target);
		if (!t || !n || v(e.source) && v(e.target)) continue;
		let r = an(e.strength ?? .5);
		r < x || Math.hypot(t.x - n.x, t.y - n.y) > S || C.push({
			idA: e.source,
			idB: e.target,
			x1: t.x,
			y1: t.y,
			x2: n.x,
			y2: n.y,
			priority: r,
			dash: r < b
		});
	}
	let w = (e) => Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
	C.sort((e, t) => t.priority - e.priority || w(t) - w(e));
	let T = (e, t) => e.idA === t.idA || e.idA === t.idB || e.idB === t.idA || e.idB === t.idB, E = (e, t) => {
		if (T(e, t)) return !1;
		let n = ln(t.x1, t.y1, t.x2, t.y2, e.x1, e.y1), r = ln(t.x1, t.y1, t.x2, t.y2, e.x2, e.y2), i = ln(e.x1, e.y1, e.x2, e.y2, t.x1, t.y1), a = ln(e.x1, e.y1, e.x2, e.y2, t.x2, t.y2);
		return (n > 0 && r < 0 || n < 0 && r > 0) && (i > 0 && a < 0 || i < 0 && a > 0) || un(e.x1, e.y1, t.x1, t.y1, t.x2, t.y2) < 6 || un(e.x2, e.y2, t.x1, t.y1, t.x2, t.y2) < 6 || un(t.x1, t.y1, e.x1, e.y1, e.x2, e.y2) < 6 || un(t.x2, t.y2, e.x1, e.y1, e.x2, e.y2) < 6;
	}, D = [], O = /* @__PURE__ */ new Map(), k = /* @__PURE__ */ new Map(), ee = (e, t) => `${Math.round(e / 20)},${Math.round(t / 20)}`;
	for (let e of C) {
		let t = O.get(e.idA) || 0, n = O.get(e.idB) || 0, r = ee(e.x1, e.y1), i = ee(e.x2, e.y2), a = k.get(r) || 0, o = k.get(i) || 0;
		t >= 2 || n >= 2 || a >= 2 || o >= 2 || D.some((t) => E(e, t)) || (D.push(e), O.set(e.idA, t + 1), O.set(e.idB, n + 1), k.set(r, a + 1), k.set(i, o + 1));
	}
	for (let t of D) t.dash ? (e.setLineDash([3, 4]), e.strokeStyle = `rgba(200,190,160,${Math.min(.18, .04 + (t.priority - x) * .4).toFixed(3)})`, e.lineWidth = .5) : (e.setLineDash([]), e.strokeStyle = `rgba(200,190,160,${Math.min(.25, .08 + (t.priority - b) * .42).toFixed(3)})`, e.lineWidth = .8), e.beginPath(), e.moveTo(t.x1, t.y1), e.lineTo(t.x2, t.y2), e.stroke();
	e.setLineDash([]);
	let te = (e) => e.importance + (e.isEvent ? 1.2 : 0) + e.heat, ne = new Set([...l].sort((e, t) => te(t) - te(e)).slice(0, Math.max(12, Math.round(l.length * .12))).map((e) => e.moment.id)), A = new Set(l.filter((e) => e.importance >= 5).sort((e, t) => t.importance + t.heat - (e.importance + e.heat)).slice(0, 6).map((e) => e.moment.id)), j = [];
	for (let t of l) {
		let n = Math.max(2, t.importance), r = ne.has(t.moment.id), i = Math.min(.95, (.3 + (n - 2) * .15 + (t.isEvent ? .1 : 0)) * (.55 + .45 * t.heat)), a = (.7 + (n - 2) * .5 + (t.isEvent ? .5 : 0) + (r ? .4 : 0)) * s;
		if (A.has(t.moment.id)) {
			let n = a * 3.5;
			e.strokeStyle = `rgba(${t.rgb},${(i * .35).toFixed(3)})`, e.lineWidth = .7, e.beginPath(), e.arc(t.x, t.y, n, 0, Math.PI * 2), e.stroke();
		}
		r && d(() => {
			let n = a * (4.5 + t.heat * 2), r = a * 2.2, o = (n, r, i) => {
				e.lineWidth = r;
				for (let [r, a] of [[1, 0], [0, 1]]) {
					let o = e.createLinearGradient(t.x - r * n, t.y - a * n, t.x + r * n, t.y + a * n);
					o.addColorStop(0, "transparent"), o.addColorStop(.5, `rgba(${t.rgb},${i.toFixed(3)})`), o.addColorStop(1, "transparent"), e.strokeStyle = o, e.beginPath(), e.moveTo(t.x - r * n, t.y - a * n), e.lineTo(t.x + r * n, t.y + a * n), e.stroke();
				}
			};
			o(n, Math.max(.8, s * .8), i * .55), o(r, Math.max(1.6, s * 1.5), i * .75);
		}), e.beginPath(), e.arc(t.x, t.y, a, 0, Math.PI * 2), e.fillStyle = `rgba(${t.rgb},${i.toFixed(3)})`, e.fill(), r && (e.beginPath(), e.arc(t.x, t.y, a * .45, 0, Math.PI * 2), e.fillStyle = `rgba(255,255,255,${Math.min(.9, i + .15).toFixed(3)})`, e.fill()), j.push({
			x: t.x,
			y: t.y,
			r: a + 4,
			moment: t.moment
		});
	}
	return j;
}
//#endregion
//#region src/echo-starmap/EchoStarmap.tsx
var fn = "#05060f", pn = "rgba(8,9,26,0.85)", mn = "1px solid rgba(200,216,240,0.08)", hn = [
	{
		label: "low",
		v: -.9,
		a: .55
	},
	{
		label: "calm",
		v: -.35,
		a: .45
	},
	{
		label: "tender",
		v: .15,
		a: .5
	},
	{
		label: "fond",
		v: .55,
		a: .6
	},
	{
		label: "ablaze",
		v: .95,
		a: .75
	}
], gn = (e) => e.date.slice(0, 10);
function _n({ sea: n, height: o = "100%", fontFamily: s = "ui-monospace, monospace", onSelect: c }) {
	let l = i(null), u = i(null), d = i(null), f = i([]), [p, m] = a(!1), [h, g] = a(null), _ = r(() => {
		let e = new Set(n.moments.map((e) => e.id));
		return (n.bonds || []).filter((t) => t.source !== t.target && e.has(t.source) && e.has(t.target)).length;
	}, [n]), v = e(() => {
		let e = d.current, t = u.current;
		if (!e || !t) return;
		let r = t.clientWidth, i = t.clientHeight;
		if (r <= 0 || i <= 0) return;
		let a = window.devicePixelRatio || 1;
		e.width = r * a, e.height = i * a;
		let o = e.getContext("2d");
		o && (o.scale(a, a), o.fillStyle = fn, o.fillRect(0, 0, r, i), f.current = dn(o, r, i, n, {
			showAxis: p,
			fontFamily: s
		}));
	}, [
		n,
		p,
		s
	]), y = i(v), b = i(!1), x = e(() => {
		b.current || (b.current = !0, requestAnimationFrame(() => {
			b.current = !1, y.current();
		}));
	}, []);
	t(() => {
		y.current = v, x();
	}, [v, x]), t(() => {
		let e = u.current;
		if (!e) return;
		let t = new ResizeObserver(x);
		return t.observe(e), () => t.disconnect();
	}, [x]);
	let S = (e, t) => {
		let n = d.current;
		if (!n) return null;
		let r = n.getBoundingClientRect(), i = e - r.left, a = t - r.top;
		return f.current.find((e) => Math.hypot(e.x - i, e.y - a) <= e.r + 4) ?? null;
	}, C = (e, t, n) => {
		let r = l.current?.getBoundingClientRect(), i = r ? r.left : 0, a = r ? r.top : 0, o = r ? r.width : Infinity, s = t - i > o * .6, c = e.moment.valence, u = e.moment.arousal;
		return {
			text: e.moment.label || "moment",
			sub: `${gn(e.moment)} · V ${c >= 0 ? "+" : ""}${c.toFixed(2)} · A ${u.toFixed(2)}`,
			x: t - i + (s ? -12 : 12),
			y: n - a - 10,
			flip: s
		};
	}, w = i(null);
	return /* @__PURE__ */ L("div", {
		ref: l,
		style: {
			position: "relative",
			width: "100%",
			height: o,
			background: fn,
			fontFamily: s,
			display: "flex",
			flexDirection: "column",
			overflow: "hidden",
			color: "#cdd8ea"
		},
		children: [
			/* @__PURE__ */ L("div", {
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 8,
					padding: "6px 10px",
					background: pn,
					borderBottom: mn
				},
				children: [/* @__PURE__ */ L("span", {
					style: {
						fontSize: 11,
						color: "#efede6"
					},
					children: [
						n.moments.length,
						" moments · ",
						_,
						" bonds"
					]
				}), /* @__PURE__ */ I("button", {
					type: "button",
					onClick: () => m((e) => !e),
					"aria-pressed": p,
					style: {
						fontFamily: s,
						fontSize: 9,
						padding: "2px 7px",
						cursor: "pointer",
						borderRadius: 3,
						border: `1px solid ${p ? "rgba(255,223,146,0.35)" : "rgba(200,216,240,0.2)"}`,
						background: p ? "rgba(255,223,146,0.12)" : "transparent",
						color: p ? "rgba(255,223,146,0.7)" : "rgba(200,216,240,0.4)"
					},
					children: "Axes"
				})]
			}),
			/* @__PURE__ */ I("div", {
				ref: u,
				style: {
					flex: 1,
					minHeight: 0,
					position: "relative"
				},
				children: /* @__PURE__ */ I("canvas", {
					ref: d,
					role: "img",
					"aria-label": `Echo starmap of ${n.moments.length} moments`,
					onMouseMove: (e) => {
						let t = S(e.clientX, e.clientY), n = t ? t.moment.id : null;
						n !== w.current && (w.current = n, g(t ? C(t, e.clientX, e.clientY) : null));
					},
					onMouseLeave: () => {
						w.current = null, g(null);
					},
					onClick: (e) => {
						let t = S(e.clientX, e.clientY);
						w.current = t ? t.moment.id : null, g(t ? C(t, e.clientX, e.clientY) : null), c?.(t ? t.moment : null);
					},
					style: {
						position: "absolute",
						top: 0,
						left: 0,
						width: "100%",
						height: "100%",
						display: "block",
						cursor: "crosshair"
					}
				})
			}),
			/* @__PURE__ */ I("div", {
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					gap: 10,
					padding: "5px 10px",
					background: pn,
					borderTop: mn
				},
				children: hn.map((e) => /* @__PURE__ */ L("span", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 3
					},
					children: [/* @__PURE__ */ I("span", { style: {
						width: 6,
						height: 6,
						borderRadius: 3,
						background: tn(e.v, e.a),
						display: "inline-block"
					} }), /* @__PURE__ */ I("span", {
						style: {
							fontSize: 9,
							color: "rgba(200,216,240,0.5)"
						},
						children: e.label
					})]
				}, e.label))
			}),
			h && /* @__PURE__ */ L("div", {
				style: {
					position: "absolute",
					left: h.x,
					top: h.y,
					transform: h.flip ? "translateX(-100%)" : void 0,
					background: "rgba(12,13,34,0.95)",
					border: "1px solid rgba(60,90,140,0.6)",
					padding: "4px 8px",
					maxWidth: 260,
					pointerEvents: "none",
					zIndex: 10
				},
				children: [/* @__PURE__ */ I("div", {
					style: {
						fontSize: 11,
						color: "#efede6"
					},
					children: h.text
				}), /* @__PURE__ */ I("div", {
					style: {
						fontSize: 9,
						color: "rgba(200,216,240,0.5)",
						marginTop: 1
					},
					children: h.sub
				})]
			})
		]
	});
}
//#endregion
//#region src/echo-galaxy/layout.ts
var vn = (e, t) => Number.isFinite(e) ? Math.min(1, Math.max(0, e)) : t;
function yn(e) {
	return vn(e, .1);
}
function bn(e) {
	return Z(e.importance) * 10 + yn(e.heat);
}
var xn = (e, t) => e < t ? -1 : +(e > t);
function Sn(e, t) {
	if (!t?.length) return [];
	let n = new Set(e.map((e) => e.id)), r = /* @__PURE__ */ new Map();
	for (let e of t) {
		if (!n.has(e.source) || !n.has(e.target) || e.source === e.target) continue;
		let [t, i] = xn(e.source, e.target) <= 0 ? [e.source, e.target] : [e.target, e.source], a = JSON.stringify([t, i]), o = vn(e.strength, .5), s = r.get(a);
		(!s || o > s.strength) && r.set(a, {
			source: t,
			target: i,
			strength: o
		});
	}
	return [...r.values()].sort((e, t) => xn(e.source, t.source) || xn(e.target, t.target));
}
function Cn(e) {
	let t = Date.parse(e.date);
	return Number.isFinite(t) ? t : NaN;
}
function wn(e, t) {
	let n = e.map((e) => ({
		...e,
		x: 0,
		y: 0,
		z: 0
	})), r = n.length;
	if (!r) return n;
	let i = n.map(Cn), a = i.filter(Number.isFinite), o = a.length ? Math.min(...a) : 0, s = a.length ? Math.max(Math.max(...a) - o, 1) : 1;
	if (n.forEach((e, t) => {
		let n = vn((e.valence + 1) / 2, .5) * 2 - 1, r = vn(e.arousal, .5), a = Number.isFinite(i[t]) ? (i[t] - o) / s : R(e.id, 41), c = 26 + R(e.id, 3) * 64, l = R(e.id, 5) * Math.PI * 2, u = Math.acos(2 * R(e.id, 7) - 1);
		e.x = Math.sin(u) * Math.cos(l) * c + n * 20, e.y = Math.sin(u) * Math.sin(l) * c * .6 + (r - .5) * 25, e.z = Math.cos(u) * c * .8 + (a - .5) * 50;
	}), t.length) {
		let e = new Map(n.map((e, t) => [e.id, t]));
		for (let r = 0; r < 36; r += 1) {
			let i = 1 - r / 36;
			for (let r of t) {
				let t = n[e.get(r.source)], a = n[e.get(r.target)], o = a.x - t.x, s = a.y - t.y, c = a.z - t.z, l = Math.sqrt(o * o + s * s + c * c) + .01, u = (l - (10 + (1 - r.strength) * 14)) / l * .05 * i * (.4 + r.strength);
				t.x += o * u, t.y += s * u, t.z += c * u, a.x -= o * u, a.y -= s * u, a.z -= c * u;
			}
		}
	}
	let c = n.reduce((e, t) => (e[0] += t.x, e[1] += t.y, e[2] += t.z, e), [
		0,
		0,
		0
	]);
	c[0] /= r, c[1] /= r, c[2] /= r;
	let l = 0;
	for (let e of n) e.x -= c[0], e.y -= c[1], e.z -= c[2], l = Math.max(l, Math.hypot(e.x, e.y, e.z));
	if (l > 64) {
		let e = 64 / l;
		for (let t of n) t.x *= e, t.y *= e, t.z *= e;
	}
	return n;
}
//#endregion
//#region src/echo-galaxy/EchoGalaxy.tsx
var Tn = "#04030a", En = 5, Dn = 36;
function On() {
	let e = document.createElement("canvas");
	e.width = e.height = 128;
	let t = e.getContext("2d"), n = t.createRadialGradient(64, 64, 0, 64, 64, 64);
	n.addColorStop(0, "rgba(255,255,255,1)"), n.addColorStop(.08, "rgba(255,255,255,0.85)"), n.addColorStop(.25, "rgba(255,255,255,0.4)"), n.addColorStop(.5, "rgba(255,255,255,0.12)"), n.addColorStop(.8, "rgba(255,255,255,0.02)"), n.addColorStop(1, "rgba(255,255,255,0)"), t.fillStyle = n, t.fillRect(0, 0, 128, 128);
	let r = new p.CanvasTexture(e);
	return r.generateMipmaps = !1, r.minFilter = p.LinearFilter, r.magFilter = p.LinearFilter, r;
}
function $(e) {
	let [t, n, r] = en(e.valence, e.arousal);
	return new p.Color(t, n, r);
}
function kn(e) {
	return Y(e.valence) < -.5 && X(e.arousal) > .6;
}
function An(e) {
	return e.label || e.date.slice(0, 10);
}
var jn = (e, t) => bn(t) - bn(e) || (e.id < t.id ? -1 : 1);
function Mn({ sprite: e }) {
	let t = r(() => {
		let e = 1600, t = new Float32Array(e * 3), n = new Float32Array(e * 3);
		for (let r = 0; r < e; r += 1) {
			let e = `bg-${r}`, i = 240 + R(e, 1) * 560, a = R(e, 2) * Math.PI * 2, o = Math.acos(2 * R(e, 3) - 1);
			t[r * 3] = Math.sin(o) * Math.cos(a) * i, t[r * 3 + 1] = Math.sin(o) * Math.sin(a) * i, t[r * 3 + 2] = Math.cos(o) * i;
			let s = .2 + R(e, 4) * .4;
			n[r * 3] = s * .85, n[r * 3 + 1] = s * .88, n[r * 3 + 2] = s;
		}
		return {
			pos: t,
			col: n
		};
	}, []), n = r(() => {
		let e = [
			[
				.75,
				.85,
				1
			],
			[
				.9,
				.95,
				1
			],
			[
				1,
				1,
				.95
			],
			[
				1,
				.98,
				.85
			],
			[
				1,
				.85,
				.65
			],
			[
				1,
				.7,
				.55
			]
		], t = /* @__PURE__ */ new Float32Array(540), n = /* @__PURE__ */ new Float32Array(540), r = /* @__PURE__ */ new Float32Array(540);
		for (let i = 0; i < 180; i += 1) {
			let a = `accent-${i}`, o = 220 + R(a, 5) * 600, s = R(a, 6) * Math.PI * 2, c = Math.acos(2 * R(a, 7) - 1);
			t[i * 3] = Math.sin(c) * Math.cos(s) * o, t[i * 3 + 1] = Math.sin(c) * Math.sin(s) * o, t[i * 3 + 2] = Math.cos(c) * o;
			let l = e[Math.floor(R(a, 8) * e.length) % e.length], u = .6 + R(a, 9) * .5;
			n[i * 3] = u * l[0], n[i * 3 + 1] = u * l[1], n[i * 3 + 2] = u * l[2];
			let d = 1.2 + R(a, 10) * .9;
			r[i * 3] = d, r[i * 3 + 1] = d, r[i * 3 + 2] = d;
		}
		return {
			pos: t,
			halo: n,
			core: r
		};
	}, []);
	return /* @__PURE__ */ L(F, { children: [
		/* @__PURE__ */ L("points", {
			raycast: () => null,
			children: [/* @__PURE__ */ L("bufferGeometry", { children: [/* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-position",
				args: [t.pos, 3]
			}), /* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-color",
				args: [t.col, 3]
			})] }), /* @__PURE__ */ I("pointsMaterial", {
				vertexColors: !0,
				size: .9,
				sizeAttenuation: !0,
				transparent: !0,
				opacity: .7,
				depthWrite: !1
			})]
		}),
		/* @__PURE__ */ L("points", {
			raycast: () => null,
			children: [/* @__PURE__ */ L("bufferGeometry", { children: [/* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-position",
				args: [n.pos, 3]
			}), /* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-color",
				args: [n.halo, 3]
			})] }), /* @__PURE__ */ I("pointsMaterial", {
				map: e,
				vertexColors: !0,
				size: 2.4,
				sizeAttenuation: !0,
				transparent: !0,
				opacity: .55,
				depthWrite: !1,
				blending: p.AdditiveBlending
			})]
		}),
		/* @__PURE__ */ L("points", {
			raycast: () => null,
			children: [/* @__PURE__ */ L("bufferGeometry", { children: [/* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-position",
				args: [n.pos, 3]
			}), /* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-color",
				args: [n.core, 3]
			})] }), /* @__PURE__ */ I("pointsMaterial", {
				map: e,
				vertexColors: !0,
				size: .9,
				sizeAttenuation: !0,
				transparent: !0,
				depthWrite: !1,
				blending: p.AdditiveBlending
			})]
		})
	] });
}
function Nn() {
	let e = document.createElement("canvas");
	e.width = 16, e.height = 16;
	let t = e.getContext("2d");
	t.fillStyle = "#ffffff", t.fillRect(4, 4, 8, 8);
	let n = new p.CanvasTexture(e);
	return n.generateMipmaps = !1, n.minFilter = p.NearestFilter, n.magFilter = p.NearestFilter, n;
}
function Pn({ moments: e, sprite: n, pixel: i }) {
	let a = r(() => {
		let t = /* @__PURE__ */ new Map();
		for (let n of e) {
			let e = Z(n.importance);
			t.has(e) || t.set(e, []), t.get(e).push(n);
		}
		return [...t.entries()].sort((e, t) => e[0] - t[0]).map(([e, t]) => {
			let n = new Float32Array(t.length * 3), r = new Float32Array(t.length * 3), i = new Float32Array(t.length * 3);
			return t.forEach((e, t) => {
				n[t * 3] = e.x, n[t * 3 + 1] = e.y, n[t * 3 + 2] = e.z;
				let a = $(e), o = X(e.arousal), s = yn(e.heat), c = e.kind === "memory" ? .85 : 1, l = (.55 + o * .55 + s * .3) * c;
				r[t * 3] = a.r * l, r[t * 3 + 1] = a.g * l, r[t * 3 + 2] = a.b * l;
				let u = 1.1 + o * .9 + s * .5;
				i[t * 3] = u * (.85 + a.r * .15), i[t * 3 + 1] = u * (.85 + a.g * .15), i[t * 3 + 2] = u * (.85 + a.b * .15);
			}), {
				importance: e,
				pos: n,
				halo: r,
				core: i
			};
		});
	}, [e]), o = r(() => i ? Nn() : null, [i]);
	return t(() => () => o?.dispose(), [o]), i && o ? /* @__PURE__ */ I(F, { children: a.map((e) => /* @__PURE__ */ L("points", {
		raycast: () => null,
		children: [/* @__PURE__ */ L("bufferGeometry", { children: [/* @__PURE__ */ I("bufferAttribute", {
			attach: "attributes-position",
			args: [e.pos, 3]
		}), /* @__PURE__ */ I("bufferAttribute", {
			attach: "attributes-color",
			args: [e.halo, 3]
		})] }), /* @__PURE__ */ I("pointsMaterial", {
			map: o,
			vertexColors: !0,
			size: 1.6 + e.importance * .4,
			sizeAttenuation: !0,
			transparent: !0,
			opacity: 1,
			depthWrite: !1,
			alphaTest: .4
		})]
	}, e.importance)) }) : /* @__PURE__ */ I(F, { children: a.map((e) => {
		let t = 2.4 + e.importance * .55;
		return /* @__PURE__ */ L("group", { children: [/* @__PURE__ */ L("points", {
			raycast: () => null,
			children: [/* @__PURE__ */ L("bufferGeometry", { children: [/* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-position",
				args: [e.pos, 3]
			}), /* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-color",
				args: [e.halo, 3]
			})] }), /* @__PURE__ */ I("pointsMaterial", {
				map: n,
				vertexColors: !0,
				size: t,
				sizeAttenuation: !0,
				transparent: !0,
				opacity: .7,
				depthWrite: !1,
				blending: p.AdditiveBlending
			})]
		}), /* @__PURE__ */ L("points", {
			raycast: () => null,
			children: [/* @__PURE__ */ L("bufferGeometry", { children: [/* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-position",
				args: [e.pos, 3]
			}), /* @__PURE__ */ I("bufferAttribute", {
				attach: "attributes-color",
				args: [e.core, 3]
			})] }), /* @__PURE__ */ I("pointsMaterial", {
				map: n,
				vertexColors: !0,
				size: t * .42,
				sizeAttenuation: !0,
				transparent: !0,
				depthWrite: !1,
				blending: p.AdditiveBlending
			})]
		})] }, e.importance);
	}) });
}
function Fn({ moments: e, sprite: t, glow: n }) {
	let a = i(/* @__PURE__ */ new Map()), o = r(() => new Map(e.map((e) => [e.id, R(e.id, 17) * Math.PI * 2])), [e]);
	return s(({ clock: t }) => {
		if (!n) return;
		let r = t.elapsedTime;
		for (let t of e) {
			let e = a.current.get(t.id);
			if (!e) continue;
			let n = yn(t.heat);
			e.scale.setScalar(1 + n * .07 * Math.sin(r * (1.1 + n) + o.get(t.id)));
		}
	}), n ? /* @__PURE__ */ I(F, { children: e.map((e) => {
		let n = $(e), r = .75 + Z(e.importance) * .13;
		return /* @__PURE__ */ L("group", {
			position: [
				e.x,
				e.y,
				e.z
			],
			ref: (t) => {
				t ? a.current.set(e.id, t) : a.current.delete(e.id);
			},
			children: [
				/* @__PURE__ */ I("sprite", {
					scale: [
						r,
						r,
						1
					],
					raycast: () => null,
					children: /* @__PURE__ */ I("spriteMaterial", {
						map: t,
						color: new p.Color(1.6 + n.r * .8, 1.6 + n.g * .8, 1.6 + n.b * .8),
						transparent: !0,
						depthWrite: !1,
						blending: p.AdditiveBlending
					})
				}),
				/* @__PURE__ */ I("sprite", {
					scale: [
						r * 3.2,
						r * 3.2,
						1
					],
					raycast: () => null,
					children: /* @__PURE__ */ I("spriteMaterial", {
						map: t,
						color: new p.Color(n.r * 1.6, n.g * 1.6, n.b * 1.6),
						transparent: !0,
						opacity: .6,
						depthWrite: !1,
						blending: p.AdditiveBlending
					})
				}),
				/* @__PURE__ */ I("sprite", {
					scale: [
						r * 5.5,
						r * 5.5,
						1
					],
					raycast: () => null,
					children: /* @__PURE__ */ I("spriteMaterial", {
						map: t,
						color: n,
						transparent: !0,
						opacity: .22,
						depthWrite: !1,
						blending: p.AdditiveBlending
					})
				})
			]
		}, e.id);
	}) }) : /* @__PURE__ */ I(F, { children: e.map((e) => {
		let t = $(e);
		return /* @__PURE__ */ L("group", {
			position: [
				e.x,
				e.y,
				e.z
			],
			children: [
				/* @__PURE__ */ L("mesh", {
					raycast: () => null,
					children: [/* @__PURE__ */ I("sphereGeometry", { args: [
						.28,
						10,
						10
					] }), /* @__PURE__ */ I("meshBasicMaterial", {
						color: new p.Color(.85 + t.r * .6, .85 + t.g * .6, .85 + t.b * .6),
						transparent: !0,
						opacity: .95,
						depthWrite: !1
					})]
				}),
				/* @__PURE__ */ L("mesh", {
					raycast: () => null,
					children: [/* @__PURE__ */ I("sphereGeometry", { args: [
						.6,
						12,
						12
					] }), /* @__PURE__ */ I("meshBasicMaterial", {
						color: new p.Color(t.r * 1.5, t.g * 1.5, t.b * 1.5),
						transparent: !0,
						opacity: .3,
						blending: p.AdditiveBlending,
						depthWrite: !1
					})]
				}),
				/* @__PURE__ */ L("mesh", {
					raycast: () => null,
					children: [/* @__PURE__ */ I("ringGeometry", { args: [
						1.2,
						1.5,
						32
					] }), /* @__PURE__ */ I("meshBasicMaterial", {
						color: t,
						transparent: !0,
						opacity: .12,
						blending: p.AdditiveBlending,
						depthWrite: !1,
						side: p.DoubleSide
					})]
				})
			]
		}, e.id);
	}) });
}
function In({ moments: e, glow: t }) {
	return e.length ? t ? /* @__PURE__ */ I(F, { children: e.map((e) => {
		let t = Math.PI * (.28 + R(e.id, 53) * .15), n = R(e.id, 59) * Math.PI;
		return /* @__PURE__ */ L("group", {
			position: [
				e.x,
				e.y,
				e.z
			],
			children: [/* @__PURE__ */ L("mesh", {
				raycast: () => null,
				children: [/* @__PURE__ */ I("sphereGeometry", { args: [
					.85,
					24,
					24
				] }), /* @__PURE__ */ I("meshBasicMaterial", {
					color: "#000000",
					depthWrite: !0
				})]
			}), /* @__PURE__ */ L("group", {
				rotation: [
					t,
					n,
					0
				],
				children: [
					/* @__PURE__ */ L("mesh", {
						raycast: () => null,
						children: [/* @__PURE__ */ I("ringGeometry", { args: [
							.9,
							1.15,
							64
						] }), /* @__PURE__ */ I("meshBasicMaterial", {
							color: new p.Color(.36, .34, .42),
							transparent: !0,
							opacity: .5,
							depthWrite: !1,
							side: p.DoubleSide
						})]
					}),
					/* @__PURE__ */ L("mesh", {
						raycast: () => null,
						children: [/* @__PURE__ */ I("ringGeometry", { args: [
							1.15,
							1.55,
							64
						] }), /* @__PURE__ */ I("meshBasicMaterial", {
							color: new p.Color(.24, .24, .3),
							transparent: !0,
							opacity: .35,
							depthWrite: !1,
							side: p.DoubleSide
						})]
					}),
					/* @__PURE__ */ L("mesh", {
						raycast: () => null,
						children: [/* @__PURE__ */ I("ringGeometry", { args: [
							1.55,
							2.1,
							64
						] }), /* @__PURE__ */ I("meshBasicMaterial", {
							color: new p.Color(.16, .16, .22),
							transparent: !0,
							opacity: .18,
							depthWrite: !1,
							side: p.DoubleSide
						})]
					})
				]
			})]
		}, e.id);
	}) }) : /* @__PURE__ */ I(F, { children: e.map((e) => /* @__PURE__ */ L("group", {
		position: [
			e.x,
			e.y,
			e.z
		],
		children: [/* @__PURE__ */ L("mesh", {
			raycast: () => null,
			children: [/* @__PURE__ */ I("sphereGeometry", { args: [
				.4,
				12,
				12
			] }), /* @__PURE__ */ I("meshBasicMaterial", {
				color: "#000000",
				transparent: !0,
				opacity: .9
			})]
		}), /* @__PURE__ */ L("mesh", {
			raycast: () => null,
			children: [/* @__PURE__ */ I("torusGeometry", { args: [
				1.8,
				.15,
				8,
				32
			] }), /* @__PURE__ */ I("meshBasicMaterial", {
				color: new p.Color(.4, .3, .8),
				transparent: !0,
				opacity: .15,
				blending: p.AdditiveBlending,
				depthWrite: !1
			})]
		})]
	}, e.id)) }) : null;
}
function Ln({ moment: e, sprite: t, strong: n }) {
	let r = $(e), i = n ? 1 : .55;
	return /* @__PURE__ */ L("group", {
		position: [
			e.x,
			e.y,
			e.z
		],
		children: [/* @__PURE__ */ I("sprite", {
			scale: [
				6 * i,
				6 * i,
				1
			],
			raycast: () => null,
			children: /* @__PURE__ */ I("spriteMaterial", {
				map: t,
				color: new p.Color(r.r * 1.4, r.g * 1.4, r.b * 1.4),
				transparent: !0,
				opacity: n ? .55 : .4,
				depthWrite: !1,
				blending: p.AdditiveBlending
			})
		}), /* @__PURE__ */ I("sprite", {
			scale: [
				11 * i,
				11 * i,
				1
			],
			raycast: () => null,
			children: /* @__PURE__ */ I("spriteMaterial", {
				map: t,
				color: r,
				transparent: !0,
				opacity: n ? .22 : .14,
				depthWrite: !1,
				blending: p.AdditiveBlending
			})
		})]
	});
}
function Rn({ labeled: e, selected: t, fontFamily: n }) {
	return /* @__PURE__ */ I(F, { children: (t ? [t] : e).map((e) => {
		let r = e.id === t?.id;
		return /* @__PURE__ */ I("group", {
			position: [
				e.x,
				e.y + 2.4,
				e.z
			],
			children: /* @__PURE__ */ I(u, {
				center: !0,
				distanceFactor: 22,
				style: { pointerEvents: "none" },
				children: /* @__PURE__ */ I("div", {
					style: {
						color: r ? "rgba(232,238,248,0.85)" : `#${$(e).getHexString()}`,
						opacity: r ? 1 : .5,
						fontSize: r ? 11 : 9,
						fontFamily: n,
						whiteSpace: "nowrap",
						textShadow: `0 0 12px ${Tn}, 0 0 6px ${Tn}`,
						userSelect: "none"
					},
					children: An(e)
				})
			})
		}, e.id);
	}) });
}
function zn({ moments: e, onPick: n, onHover: i }) {
	let { camera: a, gl: o } = c(), s = r(() => new p.Vector3(), []);
	return t(() => {
		let t = o.domElement, r = (n, r) => {
			let i = t.getBoundingClientRect(), o = (n.clientX - i.left) / i.width * 2 - 1, c = -((n.clientY - i.top) / i.height) * 2 + 1, l = null, u = r;
			for (let t of e) {
				if (s.set(t.x, t.y, t.z).project(a), s.z < -1 || s.z > 1) continue;
				let e = Math.hypot(s.x - o, s.y - c);
				e < u && (u = e, l = t);
			}
			return l;
		}, c = null, l = (e) => {
			c = [e.clientX, e.clientY];
		}, u = (e) => {
			c && Math.hypot(e.clientX - c[0], e.clientY - c[1]) > 5 || n(r(e, .05));
		}, d = (e) => {
			let n = r(e, .045);
			i(n?.id ?? null), t.style.cursor = n ? "pointer" : "";
		};
		return t.addEventListener("pointerdown", l), t.addEventListener("click", u), t.addEventListener("pointermove", d), () => {
			t.removeEventListener("pointerdown", l), t.removeEventListener("click", u), t.removeEventListener("pointermove", d), t.style.cursor = "";
		};
	}, [
		e,
		a,
		o,
		n,
		i,
		s
	]), null;
}
function Bn({ moments: e }) {
	let { camera: n, size: r } = c();
	return t(() => {
		if (!(n instanceof p.PerspectiveCamera) || !e.length || !r.width || !r.height) return;
		let t = 8;
		for (let n of e) t = Math.max(t, Math.hypot(n.x, n.y, n.z));
		let i = p.MathUtils.degToRad(n.fov), a = 2 * Math.atan(Math.tan(i / 2) * (r.width / r.height)), o = t / Math.sin(Math.min(i, a) / 2) * 1.02;
		n.position.set(0, o * .22, o), n.near = Math.max(.1, o / 500), n.far = Math.max(1500, o * 12), n.lookAt(0, 0, 0), n.updateProjectionMatrix();
	}, [
		n,
		e,
		r.height,
		r.width
	]), null;
}
function Vn({ sea: n, fontFamily: i = "ui-monospace, monospace", onSelect: s }) {
	let [c, l] = a(!0), [u, d] = a(null), [p, m] = a(null), h = r(() => On(), []);
	t(() => () => h.dispose(), [h]);
	let { moments: g, bonds: _, flares: v, labeled: y, wells: b } = r(() => {
		let e = Sn(n.moments, n.bonds), t = wn(n.moments, e), r = [...t].sort(jn).filter((e) => !kn(e));
		return {
			moments: t,
			bonds: e,
			flares: r.slice(0, Math.min(Dn, Math.max(3, Math.round(t.length * .15)))),
			labeled: r.slice(0, En),
			wells: t.filter(kn)
		};
	}, [n.moments, n.bonds]), x = r(() => {
		let e = new Set([...v, ...b].map((e) => e.id));
		return g.filter((t) => !e.has(t.id));
	}, [
		g,
		v,
		b
	]), S = r(() => g.find((e) => e.id === u) || null, [g, u]), C = r(() => p && p !== u && g.find((e) => e.id === p) || null, [
		g,
		p,
		u
	]);
	t(() => {
		u && !S && (d(null), s?.(null));
	}, [
		s,
		S,
		u
	]);
	let w = e((e) => {
		d(e?.id || null), s?.(e);
	}, [s]);
	return /* @__PURE__ */ L("div", {
		style: {
			position: "relative",
			width: "100%",
			height: "100%",
			background: Tn,
			fontFamily: i
		},
		children: [/* @__PURE__ */ L(o, {
			dpr: [1, 2],
			camera: {
				position: [
					0,
					12,
					110
				],
				fov: 55,
				near: .1,
				far: 3e3
			},
			style: { background: Tn },
			children: [
				/* @__PURE__ */ I(Bn, { moments: g }),
				/* @__PURE__ */ I(Mn, { sprite: h }),
				/* @__PURE__ */ I(Pn, {
					moments: c ? g : x,
					sprite: h,
					pixel: !c
				}),
				/* @__PURE__ */ I(Fn, {
					moments: v,
					sprite: h,
					glow: c
				}),
				/* @__PURE__ */ I(In, {
					moments: b,
					glow: c
				}),
				S && /* @__PURE__ */ I(Ln, {
					moment: S,
					sprite: h,
					strong: !0
				}),
				C && /* @__PURE__ */ I(Ln, {
					moment: C,
					sprite: h,
					strong: !1
				}),
				/* @__PURE__ */ I(Rn, {
					labeled: y,
					selected: S,
					fontFamily: i
				}),
				/* @__PURE__ */ I(zn, {
					moments: g,
					onPick: w,
					onHover: m
				}),
				/* @__PURE__ */ I(f, {
					enableDamping: !0,
					dampingFactor: .05,
					rotateSpeed: .2,
					zoomSpeed: .4,
					minDistance: 8,
					maxDistance: 1200,
					autoRotate: !0,
					autoRotateSpeed: .05
				})
			]
		}), /* @__PURE__ */ I("button", {
			type: "button",
			onClick: () => l((e) => !e),
			style: {
				position: "absolute",
				top: 10,
				right: 10,
				background: "rgba(8,10,18,0.82)",
				color: "#cdd8ea",
				border: "1px solid rgba(205,216,238,0.25)",
				padding: "4px 10px",
				fontSize: 11,
				fontFamily: i,
				cursor: "pointer"
			},
			children: c ? "◆ PIXEL" : "✦ GLOW"
		})]
	});
}
//#endregion
export { Ie as BLUE_STAR_THEME, Vn as EchoGalaxy, _n as EchoStarmap, re as GOLDEN_ANGLE, me as GalaxyView, xe as NearFocus2D, $t as NearFocus3D, Fe as SOLAR_STAR_THEME, X as clampArousal, Z as clampImportance, Y as clampValence, se as detectCommunities, tn as echoColor, en as echoColorRGB, ce as galaxyLayout, R as hash01, he as orbitRadius, Le as solarSystemSnapshot };

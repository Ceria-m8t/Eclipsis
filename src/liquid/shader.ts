// 液态玻璃着色器（气泡画布和全站玻璃共用）。
// 每块玻璃画一个四边形：圆角矩形 SDF → 圆弧高度场（中心平、贴边弯）→ 分色折射 → 斜面散射 →
// 跟背后亮度联动的料 → 约 1px 亮唇 + 左上/右下两瓣高光 → 接地影。坐标一律是 CSS 像素、y 向下。

export const VS = `#version 300 es
in vec2 aPos;
uniform vec4 uQuad;
uniform vec2 uView;
out vec2 vP;
void main() {
  vP = uQuad.xy + aPos * uQuad.zw;
  vec2 c = vP / uView * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`

export const FS = `#version 300 es
precision highp float;
in vec2 vP;
uniform sampler2D uTex;
uniform vec2 uImgOrigin;
uniform vec2 uImgSize;
uniform vec4 uRect;
uniform vec4 uRadii;   // 左上、右上、右下、左下（CSS 像素）
uniform float uBevel, uRefract, uWobble, uDisp, uShine, uShadow, uTint, uDark, uDpr, uSeed;
uniform vec3 uTintColor;
out vec4 outColor;

// 四个角圆角不一样的圆角矩形（y 向下）
float sdRound(vec2 p, vec2 b, vec4 r4) {
  float r = p.x > 0.0 ? (p.y > 0.0 ? r4.z : r4.y) : (p.y > 0.0 ? r4.w : r4.x);
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec3 bg(vec2 p) {
  return texture(uTex, clamp((p - uImgOrigin) / uImgSize, 0.0, 1.0)).rgb;
}
float angDiff(float a, float b) { float d = a - b; return atan(sin(d), cos(d)); }

void main() {
  vec2 hb = uRect.zw * 0.5;
  vec2 lp = vP - (uRect.xy + hb);
  vec4 r = min(uRadii, vec4(min(hb.x, hb.y)));
  float d = sdRound(lp, hb, r);                 // <0 在玻璃里
  float cov = clamp(0.5 - d * uDpr, 0.0, 1.0);  // 抗锯齿覆盖率

  // 接地影：往下偏一点、柔一点
  float ds = sdRound(lp - vec2(0.0, 2.0), hb, r);
  float sa = uShadow * 0.13 * exp(-max(ds, 0.0) / 4.5) * step(0.0, d + 0.5);

  if (cov <= 0.0) { outColor = vec4(0.0, 0.0, 0.0, sa); return; }

  // 法线（指向外）：SDF 梯度
  vec2 ex = vec2(0.5, 0.0), ey = vec2(0.0, 0.5);
  vec2 n = vec2(sdRound(lp + ex, hb, r) - sdRound(lp - ex, hb, r),
                sdRound(lp + ey, hb, r) - sdRound(lp - ey, hb, r));
  n = length(n) > 1e-5 ? normalize(n) : vec2(0.0, -1.0);

  float dist = max(-d, 0.0);
  float bw = max(1.0, min(uBevel, min(hb.x, hb.y) * 0.8));
  float t = clamp(dist / bw, 0.0, 1.0);
  float e = 1.0 - t;
  // 圆弧高度场：中心严格平，越贴边弯得越厉害
  float m = uRefract * bw * (1.0 - sqrt(max(0.0, 1.0 - e * e)));

  // 波纹：低频双轴扰动，中心轻、边上重；跟着气泡自己的坐标走
  vec2 w = uWobble * 16.0 * (0.35 + 0.65 * e) * vec2(
    sin(lp.y * 0.047 + lp.x * 0.019 + uSeed) + 0.45 * sin(lp.x * 0.093 - lp.y * 0.031 + uSeed * 2.3),
    cos(lp.x * 0.041 - lp.y * 0.027 + uSeed * 1.7) + 0.45 * cos(lp.y * 0.088 + lp.x * 0.036 - uSeed));

  vec2 pg = vP - n * m + w;
  vec3 col = vec3(
    bg(vP - n * m * (1.0 + uDisp) + w).r,
    bg(pg).g,
    bg(vP - n * m * (1.0 - uDisp) + w).b);

  // 斜面散射：只在边上糊一点，中间跟框外一样清楚
  float fr = 3.5 * e * e;
  if (fr > 0.05) {
    vec3 s = bg(pg + vec2(fr, 0.0)) + bg(pg - vec2(fr, 0.0)) + bg(pg + vec2(0.0, fr)) + bg(pg - vec2(0.0, fr));
    col = mix(col, s * 0.25, 0.55 * e);
  }

  // 一点饱和度
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = clamp(mix(vec3(lum), col, 1.12), 0.0, 1.0);

  // 料：跟背后亮度联动，保字可读（白玻璃暗处加白，黑玻璃亮处加黑）
  float amt = uDark > 0.5 ? uTint + 0.32 * smoothstep(0.25, 0.85, lum) : uTint + 0.30 * (1.0 - smoothstep(0.35, 0.8, lum));
  vec3 tc = uDark > 0.5 ? uTintColor * 0.14 : uTintColor;
  col = mix(col, tc, clamp(amt, 0.0, 0.85));
  if (uDark > 0.5) col += 0.035 * (1.0 - lum);   // 暗处提亮，黑玻璃不像一个洞

  // 边光：约 1px 的亮唇，左上那瓣最亮，右下那瓣次之，斜面上一层宽柔光
  float ang = atan(n.y, n.x);
  float ul = exp(-pow(angDiff(ang, -2.36) / 0.62, 2.0));
  float lr = exp(-pow(angDiff(ang, 0.79) / 0.66, 2.0));
  float hair = exp(-pow((dist - 0.55) / 0.62, 2.0));
  float glint = hair * (0.16 + ul * 0.66 + lr * 0.48);
  float soft = e * e * e * (0.10 * ul + 0.05 * lr);
  col = mix(col, vec3(1.0), clamp((glint + soft) * uShine, 0.0, 0.8));
  // 背后很亮时，不亮的那几段换成深色细线，白底上才有边
  float dk = hair * (1.0 - clamp(ul + lr, 0.0, 1.0)) * smoothstep(0.65, 0.92, lum) * 0.22;
  col *= 1.0 - dk;

  outColor = vec4(col * cov, cov + (1.0 - cov) * sa);
}`

export const UNIFORMS = ['uTex', 'uImgOrigin', 'uImgSize', 'uRect', 'uRadii', 'uBevel', 'uRefract', 'uWobble', 'uDisp', 'uShine', 'uShadow', 'uTint', 'uDark', 'uDpr', 'uSeed', 'uTintColor', 'uQuad', 'uView'] as const
export type Uniforms = Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>

/** 编译着色器、建单位四边形、开预乘混合。失败返回 null（调用方退回 CSS） */
export function buildProgram(gl: WebGL2RenderingContext): Uniforms | null {
  const sh = (type: number, text: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, text); gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn('[liquid]', gl.getShaderInfoLog(s)); return null }
    return s
  }
  const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS)
  if (!vs || !fs) return null
  const p = gl.createProgram()!
  gl.attachShader(p, vs); gl.attachShader(p, fs)
  gl.bindAttribLocation(p, 0, 'aPos')
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn('[liquid]', gl.getProgramInfoLog(p)); return null }
  gl.useProgram(p)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  const u = {} as Uniforms
  for (const name of UNIFORMS) u[name] = gl.getUniformLocation(p, name)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.uniform1i(u.uTex, 0)
  return u
}

export function newTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, t)
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const)
    gl.texParameteri(gl.TEXTURE_2D, k, v)
  return t
}

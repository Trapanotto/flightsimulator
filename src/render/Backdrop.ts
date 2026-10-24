import {
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
} from 'three';

/**
 * Start-screen background: golden-hour sky with layered alpine ridges,
 * drawn as one full-screen shader pass (a single draw call).
 * It is a placeholder until the real streamed terrain can be shown behind the menu.
 */

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;

  float hash(float n) { return fract(sin(n) * 43758.5453123); }

  float noise(float x) {
    float i = floor(x);
    float f = fract(x);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(hash(i), hash(i + 1.0), u);
  }

  // Ridged fractal noise gives sharp, alpine-looking peaks.
  float ridge(float x, float seed) {
    float h = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 5; i++) {
      float n = 1.0 - abs(noise(x * freq + seed) * 2.0 - 1.0);
      h += n * n * amp;
      freq *= 2.1;
      amp *= 0.5;
    }
    return h;
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i.x + i.y * 57.0);
    float b = hash(i.x + 1.0 + i.y * 57.0);
    float c = hash(i.x + (i.y + 1.0) * 57.0);
    float d = hash(i.x + 1.0 + (i.y + 1.0) * 57.0);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    float aspect = uResolution.x / uResolution.y;
    vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y);

    // Sky: deep blue zenith to warm horizon.
    vec3 zenith = vec3(0.10, 0.20, 0.42);
    vec3 horizon = vec3(1.00, 0.62, 0.36);
    vec3 col = mix(horizon, zenith, pow(clamp(p.y * 1.25, 0.0, 1.0), 0.65));

    // Sun with soft glow, low over the ridges.
    vec2 sunPos = vec2(0.35 * aspect * 0.5, 0.36);
    float d = length(p - sunPos);
    col += vec3(1.0, 0.78, 0.45) * exp(-d * 9.0) * 0.9;
    col += vec3(1.0, 0.55, 0.30) * exp(-d * 2.2) * 0.35;
    col = mix(col, vec3(1.0, 0.96, 0.85), smoothstep(0.035, 0.028, d));

    // Thin drifting cloud streaks.
    float cl = noise2(vec2(p.x * 2.0 + uTime * 0.01, p.y * 18.0));
    cl *= noise2(vec2(p.x * 5.0 - uTime * 0.015, p.y * 9.0 + 3.0));
    col = mix(col, vec3(1.0, 0.80, 0.68), smoothstep(0.35, 0.75, cl) * smoothstep(0.45, 0.75, p.y) * 0.45);

    // Mountain layers, far to near. Each layer scrolls slower the farther it is (parallax).
    vec3 haze = mix(horizon, vec3(0.55, 0.55, 0.70), 0.35);
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float depth = 1.0 - fi / 4.0;                 // 1 = far, 0.25 = near
      float speed = 0.004 + 0.012 * (1.0 - depth);
      float x = p.x * (0.9 + fi * 0.45) + uTime * speed + fi * 13.7;
      float base = 0.30 - fi * 0.075;
      float amp = 0.22 + 0.04 * fi;
      float h = base + ridge(x, fi * 7.3) * amp;
      if (p.y < h) {
        // Slope of the skyline: faces turned towards the sun (left of it) get light.
        float slope = (ridge(x + 0.01, fi * 7.3) - ridge(x - 0.01, fi * 7.3)) * amp / 0.02;
        float sunSide = sign(sunPos.x - p.x);
        float light = clamp(0.5 + slope * sunSide * 0.6, 0.0, 1.0);
        // Vertical gullies so faces are not flat.
        float gully = noise2(vec2(x * 22.0, p.y * 3.0 + fi * 5.0));
        vec3 rock = mix(vec3(0.10, 0.09, 0.12), vec3(0.42, 0.30, 0.26), light * (0.82 + 0.18 * gully));
        rock *= mix(1.0, 0.75, fi / 3.0);
        // Snow above a noisy snow line, warm-lit on the sun side.
        float snowLine = base + amp * (0.55 + 0.15 * noise(x * 6.0 + fi)) - gully * 0.03;
        float snow = smoothstep(snowLine, snowLine + 0.02, p.y);
        vec3 snowCol = mix(vec3(0.55, 0.58, 0.72), vec3(1.0, 0.86, 0.74), light);
        vec3 layer = mix(rock, snowCol, snow);
        // Aerial perspective: far ridges fade into haze.
        layer = mix(layer, haze, depth * 0.78);
        col = layer;
      }
    }

    // Vignette and gentle grain to avoid gradient banding.
    vec2 q = vUv - 0.5;
    col *= 1.0 - dot(q, q) * 0.55;
    col += (hash(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uTime) - 0.5) / 255.0;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Backdrop {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: ShaderMaterial;
  private readonly resolution = new Vector2();
  private frame = 0;
  private running = false;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    // The background is soft, so it does not need full resolution.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5) * 0.75);

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uTime: { value: 0 }, uResolution: { value: this.resolution } },
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new Mesh(new PlaneGeometry(2, 2), this.material));

    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.reducedMotion) {
      this.render(0);
      return;
    }
    const loop = (now: number) => {
      if (!this.running) return;
      this.render(now / 1000);
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  private render(time: number): void {
    this.material.uniforms.uTime!.value = time;
    this.renderer.render(this.scene, this.camera);
  }

  private readonly resize = () => {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.renderer.setSize(w, h, false);
    this.resolution.set(w, h);
    if (this.reducedMotion) this.render(0);
  };

  private readonly onVisibility = () => {
    if (document.hidden) this.stop();
    else this.start();
  };
}

import {
  BackSide,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
  Vector3,
  type Camera,
} from 'three/webgpu';
import {
  dot,
  float,
  max,
  mix,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  uniform,
} from 'three/tsl';
import { solarPosition } from './solar';

const DEG = Math.PI / 180;

/** The light of the moment, for everything that is lit or tinted by the sky. */
export interface SkyState {
  date: Date;
  /** Unit vector towards the sun in render space (x east, y up, z south). */
  sunDirection: Vector3;
  /** Degrees above the horizon. */
  sunElevation: number;
  /** Degrees from north, clockwise. */
  sunAzimuth: number;
}

/**
 * Sky, sun light and ambient light.
 *
 * Phase 0 placeholder: an analytic gradient with a sun disc. Phase 1 replaces the inside with
 * the physically based atmosphere; this interface stays.
 */
export class Sky {
  /** Add to the scene: the dome and the lights. */
  readonly object = new Group();
  readonly state: SkyState;
  readonly sun = new DirectionalLight(0xffffff, 3);
  readonly ambient = new HemisphereLight(0xbfd4ff, 0x6b6257, 1);
  private readonly dome: Mesh;
  private readonly uSun = uniform(new Vector3(0, 1, 0));
  private readonly uZenith = uniform(new Color(0.12, 0.3, 0.7));
  private readonly uHorizon = uniform(new Color(0.62, 0.76, 0.92));
  private readonly uSunColor = uniform(new Color(1, 0.96, 0.88));

  constructor(
    date: Date,
    private lon: number,
    private lat: number,
  ) {
    this.state = { date, sunDirection: new Vector3(0, 1, 0), sunElevation: 45, sunAzimuth: 180 };
    const dir = normalize(positionLocal);
    const height = max(dir.y, 0);
    const sky = mix(this.uHorizon, this.uZenith, pow(height, 0.45));
    // Below the horizon: the haze colour, darker further down (hidden by terrain later).
    const ground = this.uHorizon.mul(0.55);
    const base = mix(ground, sky, smoothstep(-0.08, 0.0, dir.y));
    const toSun = max(dot(dir, this.uSun), 0);
    const disc = smoothstep(0.99985, 0.99995, toSun).mul(40);
    const glow = pow(toSun, 220).mul(1.2).add(pow(toSun, 12).mul(0.18));
    const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
    material.colorNode = base.add(this.uSunColor.mul(disc.add(glow)).mul(float(1)));
    this.dome = new Mesh(new SphereGeometry(1, 48, 24), material);
    this.dome.renderOrder = -1;
    this.dome.frustumCulled = false;
    this.object.name = 'Sky';
    this.object.add(this.dome, this.sun, this.sun.target, this.ambient);
    this.setTime(date);
  }

  /** Where on Earth the sky is seen from (sun position). */
  setLocation(lon: number, lat: number) {
    this.lon = lon;
    this.lat = lat;
    this.setTime(this.state.date);
  }

  setTime(date: Date) {
    const s = this.state;
    s.date = date;
    const { azimuth, elevation } = solarPosition(date, this.lat, this.lon);
    s.sunAzimuth = azimuth;
    s.sunElevation = elevation;
    const az = azimuth * DEG;
    const el = elevation * DEG;
    // Render space: x east, y up, z south.
    s.sunDirection.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
    this.uSun.value.copy(s.sunDirection);

    // Day 1 .. night 0, and how low the sun stands (warm light).
    const day = Math.min(1, Math.max(0, (elevation + 6) / 12));
    const low = 1 - Math.min(1, Math.max(0, elevation / 25));
    this.uZenith.value.setRGB(0.12, 0.3, 0.7).multiplyScalar(0.02 + 0.98 * day);
    this.uHorizon.value
      .setRGB(0.62, 0.76, 0.92)
      .lerp(new Color(0.95, 0.62, 0.38), low * 0.7)
      .multiplyScalar(0.03 + 0.97 * day);
    this.uSunColor.value.setRGB(1, 0.96, 0.88).lerp(new Color(1, 0.55, 0.25), low * 0.8);
    this.sun.color.copy(this.uSunColor.value);
    this.sun.intensity = 3.2 * Math.min(1, Math.max(0, (elevation + 1) / 8));
    this.ambient.intensity = 0.08 + 0.9 * day;
  }

  /** Per frame: the dome and the sun light follow the camera. */
  update(camera: Camera) {
    this.dome.position.copy(camera.position);
    // Always inside the view distance, whatever the device's far plane is.
    const far = (camera as { far?: number }).far;
    if (far) this.dome.scale.setScalar(far * 0.9);
    this.sun.target.position.copy(camera.position);
    this.sun.position.copy(camera.position).addScaledVector(this.state.sunDirection, 1000);
  }
}

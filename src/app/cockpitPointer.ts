import { type PerspectiveCamera, Raycaster, Vector2 } from 'three/webgpu';
import {
  type AircraftVisual,
  type ControlHit,
  REPEAT,
  dragControl,
  isDragged,
  pressControl,
  wheelControl,
} from '@aircraft';
import type { ControlSpec } from '@sim';

/** What the pointer needs from the app. */
export interface CockpitPointerHost {
  camera: PerspectiveCamera;
  visual(): AircraftVisual;
  /** The pilot sits in the cockpit of a running flight. */
  active(): boolean;
  spec(id: string): ControlSpec | undefined;
  get(id: string): number;
  /** `held`: the pointer stays down on a control that springs back (the start key). */
  set(id: string, value: number, held: boolean): void;
  /** Wheel or pinch over nothing: zoom in on the panel. Factor > 1 zooms out. */
  zoom(factor: number): void;
}

interface Held {
  pointer: number;
  spec: ControlSpec;
  hit: ControlHit;
  /** Value to set when the pointer comes up. */
  release?: number;
  /** A lever being dragged: where the pointer was, and whether it moved at all. */
  drag?: { y: number; moved: boolean };
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Mouse and touch on the 3D cockpit: a press on a switch, knob or lever operates it, a press
 * anywhere else is left to the camera (drag to look). Attach BEFORE the camera rig's own
 * listeners: a press that hits a control must not also start a look-around.
 */
export function attachCockpitPointer(el: HTMLElement, host: CockpitPointerHost): () => void {
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  let held: Held | undefined;
  let lastHover = 0;

  const pick = (e: { clientX: number; clientY: number }): ControlHit | null => {
    if (!host.active()) return null;
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    host.camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, host.camera);
    return host.visual().pickControl(raycaster);
  };

  const press = (h: Held) => {
    const r = pressControl(h.spec, host.get(h.spec.id), h.hit);
    h.release = r.release;
    host.set(h.spec.id, r.value, r.release !== undefined);
  };

  const down = (e: PointerEvent) => {
    if (e.button !== 0 || held) return;
    const hit = pick(e);
    const spec = hit && host.spec(hit.control);
    if (!hit || !spec) return;
    // This press belongs to the control: the camera must not take it for a drag.
    e.stopImmediatePropagation();
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    held = { pointer: e.pointerId, spec, hit };
    if (isDragged(spec)) {
      held.drag = { y: e.clientY, moved: false };
      return;
    }
    press(held);
    // A held knob keeps turning.
    if (spec.kind === 'knob') {
      const again = () => {
        if (!held) return;
        press(held);
        held.timer = setTimeout(again, REPEAT.interval * 1000);
      };
      held.timer = setTimeout(again, REPEAT.delay * 1000);
    }
  };

  const move = (e: PointerEvent) => {
    if (held && e.pointerId === held.pointer) {
      e.stopImmediatePropagation();
      const d = held.drag;
      if (!d) return;
      const dy = e.clientY - d.y;
      if (Math.abs(dy) < 1) return;
      d.y = e.clientY;
      d.moved = true;
      const id = held.spec.id;
      host.set(id, dragControl(held.spec, host.get(id), dy, el.clientHeight), false);
      return;
    }
    // A hand over anything that can be operated (mouse only, a few times a second).
    if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
    const now = performance.now();
    if (now - lastHover < 80) return;
    lastHover = now;
    el.style.cursor = pick(e) ? 'pointer' : '';
  };

  const up = (e: PointerEvent) => {
    if (!held || e.pointerId !== held.pointer) return;
    e.stopImmediatePropagation();
    clearTimeout(held.timer);
    // A tap on a lever without dragging steps it.
    if (held.drag && !held.drag.moved) press(held);
    if (held.release !== undefined) host.set(held.spec.id, held.release, false);
    held = undefined;
  };

  const wheel = (e: WheelEvent) => {
    if (!host.active()) return;
    // In the cockpit the wheel never moves the outside camera.
    e.stopImmediatePropagation();
    e.preventDefault();
    const hit = pick(e);
    const spec = hit && host.spec(hit.control);
    if (hit && spec && spec.kind !== 'toggle' && spec.kind !== 'button') {
      // Away from the user turns up.
      const next = wheelControl(spec, host.get(spec.id), -e.deltaY / 100, hit);
      host.set(spec.id, next, false);
    } else host.zoom(Math.exp(e.deltaY * 0.001));
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', wheel, { passive: false });
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('wheel', wheel);
  };
}

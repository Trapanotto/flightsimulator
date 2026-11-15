import { signal, useComputed, useSignal, useSignalEffect } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { game, settings, touchInput } from '../api';
import {
  IconBrake,
  IconChevronDown,
  IconChevronUp,
  IconGear,
  IconReverse,
} from '../components/icons';
import { typeFeatures } from '../fleet';
import { throttleLabel } from '../fleetText';
import { formatPercent } from '../format';
import { t } from '../i18n';
import { flownAircraft } from '../nav';
import {
  clampToCircle,
  leverValue,
  sliderAxis,
  stickAxes,
  stickToControls,
  tiltAngles,
  tiltAxes,
  travelValue,
} from '../touchMath';

/** Portrait or not: the speed brake lever lies down in portrait, it stands in landscape. */
const PORTRAIT = '(orientation: portrait)';
const portrait = signal(typeof matchMedia !== 'undefined' && matchMedia(PORTRAIT).matches);
if (typeof matchMedia !== 'undefined')
  matchMedia(PORTRAIT).addEventListener('change', (e) => (portrait.value = e.matches));

/**
 * One pointer per control: each control captures the pointer that started on it and ignores
 * all others, so the left thumb on the stick and the right thumb on the throttle work at the
 * same time.
 */
function usePointerOwner() {
  return useRef<number | null>(null);
}

/** Set by the stick while a thumb is on it; tilt steering yields to it. */
const stickHeld = { current: false };

function Stick() {
  const zone = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const owner = usePointerOwner();
  const centre = useRef({ x: 0, y: 0, r: 1 });

  const move = (x: number, y: number) => {
    const c = centre.current;
    const k = clampToCircle(x - c.x, y - c.y, c.r);
    if (knob.current) knob.current.style.transform = `translate3d(${k.x}px, ${k.y}px, 0)`;
    const axes = stickAxes(x - c.x, y - c.y, c.r);
    const out = stickToControls(axes, settings.invertPitch.value);
    touchInput.pitch.value = out.pitch;
    touchInput.roll.value = out.roll;
  };
  const release = (e: PointerEvent) => {
    if (e.pointerId !== owner.current) return;
    owner.current = null;
    stickHeld.current = false;
    zone.current?.classList.remove('is-active');
    if (knob.current) knob.current.style.transform = '';
    touchInput.pitch.value = null;
    touchInput.roll.value = null;
  };

  return (
    <div
      ref={zone}
      class="stick-zone"
      role="group"
      aria-label={t('touch.stick')}
      onPointerDown={(e) => {
        if (owner.current !== null || !base.current) return;
        e.preventDefault();
        owner.current = e.pointerId;
        stickHeld.current = true;
        zone.current?.setPointerCapture(e.pointerId);
        zone.current?.classList.add('is-active');
        const r = base.current.getBoundingClientRect();
        centre.current = { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 - 8 };
        move(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.pointerId === owner.current) move(e.clientX, e.clientY);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <div class="stick-base" ref={base}>
        <span class="stick-cross" aria-hidden="true" />
        <div class="stick-knob" ref={knob} />
      </div>
    </div>
  );
}

function Throttle() {
  const track = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const owner = usePointerOwner();
  const dragging = useSignal(false);
  const local = useSignal(0);
  // While not dragged, the lever shows the aircraft's throttle, so keyboard changes show too.
  const shown = useComputed(() =>
    dragging.value ? local.value : (game.levers.value?.throttle ?? touchInput.throttle.value ?? 0),
  );
  const shownText = useComputed(() => formatPercent(shown.value));
  useSignalEffect(() => {
    const v = shown.value;
    const el = track.current;
    el?.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    if (handle.current && el) {
      const travel = el.clientHeight - handle.current.offsetHeight;
      handle.current.style.transform = `translate3d(0, ${((1 - v) * travel).toFixed(1)}px, 0)`;
    }
    el?.style.setProperty('--level', String(v));
  });

  const set = (y: number) => {
    const el = track.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = (handle.current?.offsetHeight ?? 0) / 2;
    const v = leverValue(y, r.top + pad, r.height - 2 * pad);
    local.value = v;
    touchInput.throttle.value = v;
  };
  const release = (e: PointerEvent) => {
    if (e.pointerId !== owner.current) return;
    owner.current = null;
    dragging.value = false;
  };

  return (
    <div class="throttle">
      <span class="touch-caption caps" aria-hidden="true">
        {throttleLabel(flownAircraft.value)}
      </span>
      <div
        ref={track}
        class={`throttle-track${dragging.value ? ' is-active' : ''}`}
        role="slider"
        aria-label={t('touch.throttle')}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        onPointerDown={(e) => {
          if (owner.current !== null) return;
          e.preventDefault();
          owner.current = e.pointerId;
          track.current?.setPointerCapture(e.pointerId);
          dragging.value = true;
          set(e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.pointerId === owner.current) set(e.clientY);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        <span class="throttle-fill" aria-hidden="true" />
        <span class="throttle-scale" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <div class="throttle-handle" ref={handle} aria-hidden="true">
          <span class="num">{shownText}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The speed brake: a lever that stays where it is left, like the throttle. It shows the
 * aircraft's lever while not touched, so the keys show here too.
 */
function SpeedbrakeLever() {
  const track = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const owner = usePointerOwner();
  const dragging = useSignal(false);
  const local = useSignal(0);
  const flat = portrait.value;
  const shown = useComputed(() =>
    dragging.value
      ? local.value
      : (game.levers.value?.speedbrake ?? touchInput.speedbrake.value ?? 0),
  );
  const out = useComputed(() => shown.value > 0.02);
  useSignalEffect(() => {
    const v = shown.value;
    const el = track.current;
    el?.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    el?.style.setProperty('--level', String(v));
    if (handle.current && el) {
      const travel = flat
        ? el.clientWidth - handle.current.offsetWidth
        : el.clientHeight - handle.current.offsetHeight;
      handle.current.style.transform = flat
        ? `translate3d(${(v * travel).toFixed(1)}px, 0, 0)`
        : `translate3d(0, ${(v * travel).toFixed(1)}px, 0)`;
    }
  });
  const set = (e: PointerEvent) => {
    const el = track.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const h = handle.current;
    const v = flat
      ? travelValue(e.clientX, r.left + (h?.offsetWidth ?? 0) / 2, r.width - (h?.offsetWidth ?? 0))
      : travelValue(
          e.clientY,
          r.top + (h?.offsetHeight ?? 0) / 2,
          r.height - (h?.offsetHeight ?? 0),
        );
    local.value = v;
    touchInput.speedbrake.value = v;
  };
  const release = (e: PointerEvent) => {
    if (e.pointerId !== owner.current) return;
    owner.current = null;
    dragging.value = false;
  };
  return (
    <div class={`speedbrake${flat ? ' is-flat' : ''}`}>
      <span class="touch-caption caps" aria-hidden="true">
        SPD BRK
      </span>
      <div
        ref={track}
        class={`speedbrake-track${dragging.value ? ' is-active' : ''}${out.value ? ' is-out' : ''}`}
        role="slider"
        aria-label={t('touch.speedbrake')}
        aria-orientation={flat ? 'horizontal' : 'vertical'}
        aria-valuemin={0}
        aria-valuemax={100}
        onPointerDown={(e) => {
          if (owner.current !== null) return;
          e.preventDefault();
          owner.current = e.pointerId;
          track.current?.setPointerCapture(e.pointerId);
          dragging.value = true;
          set(e);
        }}
        onPointerMove={(e) => {
          if (e.pointerId === owner.current) set(e);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        <span class="speedbrake-fill" aria-hidden="true" />
        <div class="speedbrake-handle" ref={handle} aria-hidden="true" />
      </div>
    </div>
  );
}

function Rudder() {
  const track = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const owner = usePointerOwner();
  const set = (x: number) => {
    const el = track.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const v = sliderAxis(x, r.left, r.width);
    touchInput.yaw.value = v;
    const k = Math.max(-1, Math.min(1, ((x - r.left) / r.width) * 2 - 1));
    if (knob.current)
      knob.current.style.transform = `translate3d(${((k * (r.width - 48)) / 2).toFixed(1)}px,0,0)`;
  };
  const release = (e: PointerEvent) => {
    if (e.pointerId !== owner.current) return;
    owner.current = null;
    track.current?.classList.remove('is-active');
    if (knob.current) knob.current.style.transform = '';
    touchInput.yaw.value = null;
  };
  return (
    <div class="rudder">
      <span class="touch-caption caps" aria-hidden="true">
        {t('touch.rudder')}
      </span>
      <div
        ref={track}
        class="rudder-track"
        role="group"
        aria-label={t('touch.rudder')}
        onPointerDown={(e) => {
          if (owner.current !== null) return;
          e.preventDefault();
          owner.current = e.pointerId;
          track.current?.setPointerCapture(e.pointerId);
          track.current?.classList.add('is-active');
          set(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.pointerId === owner.current) set(e.clientX);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        <span class="rudder-centre" aria-hidden="true" />
        <div class="rudder-knob" ref={knob} aria-hidden="true" />
      </div>
    </div>
  );
}

/** A button that acts on touch-down (no waiting for the finger to lift), for flight. */
function PadButton(props: {
  label: string;
  class?: string;
  onPress: () => void;
  onRelease?: () => void;
  children: ComponentChildren;
}) {
  const owner = usePointerOwner();
  const ref = useRef<HTMLButtonElement>(null);
  const up = (e: PointerEvent) => {
    if (e.pointerId !== owner.current) return;
    owner.current = null;
    ref.current?.classList.remove('is-pressed');
    props.onRelease?.();
  };
  return (
    <button
      ref={ref}
      type="button"
      tabIndex={-1}
      class={`pad-btn ${props.class ?? ''}`}
      aria-label={props.label}
      onPointerDown={(e) => {
        if (owner.current !== null) return;
        e.preventDefault();
        owner.current = e.pointerId;
        ref.current?.setPointerCapture(e.pointerId);
        ref.current?.classList.add('is-pressed');
        props.onPress();
      }}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      // Keyboard and assistive technology still get a working button.
      onClick={(e) => {
        if (e.detail === 0) {
          props.onPress();
          props.onRelease?.();
        }
      }}
    >
      {props.children}
    </button>
  );
}

function Buttons({ reverse }: { reverse: boolean }) {
  // Computed: the buttons re-render only when a state flips, not with every telemetry update.
  const gear = useComputed(() => {
    const g = game.telemetry.value?.gear ?? 1;
    return g >= 0.99 ? 'down' : g <= 0.01 ? 'up' : 'moving';
  });
  const braking = useComputed(() => touchInput.brake.value || !!game.levers.value?.brake);
  const reversing = useComputed(() => touchInput.reverse.value || !!game.levers.value?.reverse);
  const meter = useRef<HTMLElement>(null);
  useSignalEffect(() => {
    const f = game.telemetry.value?.flaps ?? game.levers.value?.flaps ?? 0;
    if (meter.current) meter.current.style.transform = `scaleX(${f})`;
  });
  const gearState = gear.value;
  const brake = braking.value;
  return (
    <div class="pad">
      <PadButton
        label={t('touch.flapsUp')}
        class="pad-flaps-up"
        onPress={() => touchInput.flapsUp.value++}
      >
        <IconChevronUp size={22} />
        <span class="pad-text">{t('hud.flaps')}</span>
      </PadButton>
      <PadButton
        label={t('touch.gear')}
        class={`pad-gear is-${gearState}`}
        onPress={() => touchInput.gearToggle.value++}
      >
        <IconGear size={22} />
        <span class="pad-text">{t('hud.gear')}</span>
      </PadButton>
      <PadButton
        label={t('touch.flapsDown')}
        class="pad-flaps-down"
        onPress={() => touchInput.flapsDown.value++}
      >
        <IconChevronDown size={22} />
        <span class="pad-flaps-meter" aria-hidden="true">
          <i ref={meter} />
        </span>
      </PadButton>
      <PadButton
        label={t('touch.brake')}
        class={`pad-brake${brake ? ' is-on' : ''}`}
        onPress={() => (touchInput.brake.value = true)}
        onRelease={() => (touchInput.brake.value = false)}
      >
        <IconBrake size={22} />
        <span class="pad-text">{t('hud.brake')}</span>
      </PadButton>
      {reverse && (
        <PadButton
          label={t('touch.reverse')}
          class={`pad-rev${reversing.value ? ' is-on' : ''}`}
          onPress={() => (touchInput.reverse.value = true)}
          onRelease={() => (touchInput.reverse.value = false)}
        >
          <IconReverse size={22} />
          <span class="pad-text">REV</span>
        </PadButton>
      )}
    </div>
  );
}

/**
 * Tilt steering: the device is the yoke. The attitude when steering starts counts as level.
 * The stick wins while a thumb is on it.
 */
function useTilt(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return;
    let neutral: number | null = null;
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null || stickHeld.current) return;
      const angle =
        screen.orientation?.angle ?? (window as { orientation?: number }).orientation ?? 0;
      const a = tiltAngles(e.beta, e.gamma, angle);
      if (neutral === null) neutral = a.pitch;
      const out = tiltAxes(a, neutral, settings.invertPitch.value);
      touchInput.pitch.value = out.pitch;
      touchInput.roll.value = out.roll;
    };
    const onRotate = () => (neutral = null);
    window.addEventListener('deviceorientation', onTilt);
    window.addEventListener('orientationchange', onRotate);
    return () => {
      window.removeEventListener('deviceorientation', onTilt);
      window.removeEventListener('orientationchange', onRotate);
      touchInput.pitch.value = null;
      touchInput.roll.value = null;
    };
  }, [enabled]);
}

/** On-screen flight controls for touch: stick, rudder, throttle and the system buttons. */
export function TouchControls() {
  useTilt(settings.tiltSteering.value);
  useEffect(() => {
    touchInput.active.value = true;
    return () => {
      touchInput.active.value = false;
      touchInput.pitch.value = null;
      touchInput.roll.value = null;
      touchInput.yaw.value = null;
      touchInput.throttle.value = null;
      touchInput.brake.value = false;
      touchInput.speedbrake.value = null;
      touchInput.reverse.value = false;
    };
  }, []);
  // Speed brake and reverse only for the types that have them: the Cessna's layout stays.
  const f = typeFeatures(flownAircraft.value);
  return (
    <div
      class={`touch${game.view.value === 'cockpit' ? ' is-cockpit' : ''}${f.speedbrake ? ' has-sb' : ''}${f.reverse ? ' has-rev' : ''}`}
      aria-label={t('touch.controls')}
      role="group"
      onContextMenu={(e) => e.preventDefault()}
    >
      <Stick />
      <Rudder />
      <Buttons reverse={f.reverse} />
      {f.speedbrake && <SpeedbrakeLever />}
      <Throttle />
    </div>
  );
}

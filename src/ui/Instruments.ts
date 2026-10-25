/**
 * Head-up instruments drawn with DOM/CSS (no draw calls): heading tape and an attitude
 * indicator (horizon line + pitch ladder) around a fixed aircraft symbol.
 */

const PX_PER_DEG_TAPE = 6;
const PX_PER_DEG_PITCH = 7;

export class Instruments {
  readonly el: HTMLElement;
  private readonly tape: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly ladder: HTMLElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'instruments';
    this.el.setAttribute('aria-hidden', 'true');

    // Heading tape: three full turns so it can scroll endlessly.
    const ticks: string[] = [];
    for (let d = -360; d <= 720; d += 5) {
      const label = ((d % 360) + 360) % 360;
      const major = label % 10 === 0;
      const name = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[label];
      ticks.push(
        `<span class="tick${major ? ' major' : ''}" style="left:${d * PX_PER_DEG_TAPE}px">${
          major ? `<b>${name ?? String(label / 10).padStart(2, '0')}</b>` : ''
        }</span>`,
      );
    }

    const rungs: string[] = [];
    for (let p = -80; p <= 80; p += 10) {
      if (p === 0) continue;
      rungs.push(
        `<div class="rung${p < 0 ? ' down' : ''}" style="top:${-p * PX_PER_DEG_PITCH}px"><span>${Math.abs(p)}</span><i></i><span>${Math.abs(p)}</span></div>`,
      );
    }

    this.el.innerHTML = `
      <div class="hdg-window"><div class="hdg-tape">${ticks.join('')}</div><div class="hdg-caret"></div></div>
      <div class="hdg-readout">000°</div>
      <div class="adi"><div class="adi-ladder"><div class="horizon"></div>${rungs.join('')}</div>
        <div class="aircraft-symbol"><i></i><b></b><i></i></div></div>`;
    parent.appendChild(this.el);
    this.tape = this.el.querySelector('.hdg-tape')!;
    this.heading = this.el.querySelector('.hdg-readout')!;
    this.ladder = this.el.querySelector('.adi-ladder')!;
  }

  /** Angles in degrees: heading 0..360, pitch nose up positive, bank right wing down positive. */
  update(headingDeg: number, pitchDeg: number, bankDeg: number) {
    const h = ((headingDeg % 360) + 360) % 360;
    this.tape.style.transform = `translateX(${-h * PX_PER_DEG_TAPE}px)`;
    const text = `${String(Math.round(h) % 360).padStart(3, '0')}°`;
    if (this.heading.textContent !== text) this.heading.textContent = text;
    this.ladder.style.transform = `rotate(${-bankDeg}deg) translateY(${pitchDeg * PX_PER_DEG_PITCH}px)`;
  }

  set visible(v: boolean) {
    this.el.hidden = !v;
  }
}

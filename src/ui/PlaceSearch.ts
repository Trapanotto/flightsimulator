import { type Lang, t } from '../i18n';

/** A search hit from the geo.admin.ch SearchServer. */
export interface PlaceHit {
  name: string;
  kind: string;
  lon: number;
  lat: number;
}

const URL_BASE = 'https://api3.geo.admin.ch/rest/services/api/SearchServer';

/** Strips the server's HTML (`<i>Ort</i> <b>Gandria</b> (TI)`) into plain text parts. */
export function parseLabel(label: string): { kind: string; name: string } {
  const kind = /<i>(.*?)<\/i>/.exec(label)?.[1] ?? '';
  const text = label
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const name = kind && text.startsWith(kind) ? text.slice(kind.length).trim() : text;
  return { kind, name };
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceHit[]> {
  const q = new URLSearchParams({ searchText: query, type: 'locations', sr: '4326', limit: '8' });
  const res = await fetch(`${URL_BASE}?${q}`, { signal });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    results?: Array<{ attrs: { label: string; lat: number; lon: number } }>;
  };
  return (data.results ?? []).map((r) => ({
    ...parseLabel(r.attrs.label),
    lon: r.attrs.lon,
    lat: r.attrs.lat,
  }));
}

/** Search box with a result list; calls onPick with the chosen place. */
export class PlaceSearch {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private timer = 0;
  private abort?: AbortController;

  constructor(
    parent: HTMLElement,
    lang: Lang,
    private readonly onPick: (hit: PlaceHit) => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'place-search';
    this.el.innerHTML = `<input type="search" placeholder="${t(lang, 'search.placeholder')}" aria-label="${t(lang, 'search.placeholder')}" /><ul role="listbox" hidden></ul>`;
    parent.appendChild(this.el);
    this.input = this.el.querySelector('input')!;
    this.list = this.el.querySelector('ul')!;
    this.input.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.run(), 280);
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep flight keys out of the text box
      if (e.key === 'Escape') this.close();
      if (e.key === 'Enter')
        (this.list.querySelector('button') as HTMLButtonElement | null)?.click();
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
  }

  private async run() {
    const q = this.input.value.trim();
    this.abort?.abort();
    if (q.length < 2) return this.close();
    this.abort = new AbortController();
    try {
      const hits = await searchPlaces(q, this.abort.signal);
      this.list.replaceChildren(
        ...hits.map((h) => {
          const li = document.createElement('li');
          const b = document.createElement('button');
          b.type = 'button';
          const kind = document.createElement('small');
          kind.textContent = h.kind;
          b.append(h.name, ' ', kind);
          b.addEventListener('click', () => {
            this.close();
            this.input.value = h.name;
            this.input.blur();
            this.onPick(h);
          });
          li.append(b);
          return li;
        }),
      );
      this.list.hidden = hits.length === 0;
    } catch {
      // Aborted or offline: keep the old list.
    }
  }

  private close() {
    this.list.hidden = true;
  }
}

import {
  COURSES,
  type Course,
  type Medal,
  courseLength,
  formatTime,
  loadBestTimes,
  medalFor,
} from '../game/challenges';
import { type Lang, type MessageKey, t } from '../i18n';

/** Small round medal badge (CSS colours); empty string for no medal. */
export function medalBadge(lang: Lang, medal: Medal | null): string {
  if (!medal) return '';
  return `<span class="medal medal-${medal}" title="${t(lang, `medal.${medal}` as MessageKey)}"></span>`;
}

/**
 * Course list as a modal dialog: name, description, length, rings, medal times and the
 * player's best time with its medal. Used from the start screen and in flight.
 */
export function openChallengePicker(lang: Lang, onPick: (course: Course) => void) {
  const tr = (k: MessageKey) => t(lang, k);
  const best = loadBestTimes();
  const dialog = document.createElement('dialog');
  dialog.className = 'challenges';
  dialog.setAttribute('aria-labelledby', 'challenges-title');
  dialog.innerHTML = `
    <h2 id="challenges-title">${tr('menu.challenges')}</h2>
    <p class="challenges-help">${tr('challenge.help')}</p>
    <ul class="course-list">
      ${COURSES.map((c) => {
        const b = best[c.id];
        const m = c.medals;
        return `
        <li>
          <button class="course" data-course="${c.id}">
            <span class="course-head">
              <b>${c.name[lang]}</b>
              <span class="course-best">${
                b === undefined
                  ? tr('challenge.noBest')
                  : `${medalBadge(lang, medalFor(c, b))} ${tr('challenge.best')} ${formatTime(b)}`
              }</span>
            </span>
            <span class="course-desc">${c.description[lang]}</span>
            <span class="course-meta">
              ${(courseLength(c) / 1000).toFixed(1)} km · ${c.gates.length} ${tr('challenge.rings')}${
                c.landing ? ` · ${tr('challenge.land')}` : ''
              }
              <span class="course-medals">
                ${medalBadge(lang, 'gold')} ${formatTime(m.gold)}
                ${medalBadge(lang, 'silver')} ${formatTime(m.silver)}
                ${medalBadge(lang, 'bronze')} ${formatTime(m.bronze)}
              </span>
            </span>
          </button>
        </li>`;
      }).join('')}
    </ul>
    <form method="dialog"><button class="btn btn-small">${tr('challenge.close')}</button></form>
  `;
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelectorAll<HTMLButtonElement>('[data-course]').forEach((b) =>
    b.addEventListener('click', () => {
      dialog.close();
      onPick(COURSES.find((c) => c.id === b.dataset.course)!);
    }),
  );
  dialog.showModal();
  return dialog;
}

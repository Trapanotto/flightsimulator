import { startApp } from '@app';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

startApp(canvas, ui).catch((err: unknown) => {
  console.error(err);
  const note = document.createElement('p');
  note.className = 'fatal';
  note.textContent =
    document.documentElement.lang === 'de'
      ? 'Die Grafik konnte nicht gestartet werden. Bitte einen aktuellen Browser verwenden.'
      : 'Graphics could not be started. Please use a current browser.';
  document.body.appendChild(note);
});

/**
 * File name of a saved picture: the game, the aircraft and the local date and time, so a
 * folder of pictures sorts by when they were taken.
 */
export function pictureName(aircraft: string, date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const time = `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  const name = aircraft
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `trapanotto-${name || 'flight'}-${day}-${time}.png`;
}

/**
 * Saves what the canvas shows as a PNG download.
 *
 * Call it in the same task as the render, right after `renderer.render` (or the pipeline's
 * render) and before the frame callback returns: a WebGPU canvas only holds its picture until
 * the browser presents it, and afterwards reads as blank. `toBlob` takes its copy of the
 * pixels when it is called; only the encoding runs later, which is what the promise waits
 * for. So the app sets a flag in `photoSave`, and the frame loop calls this after drawing
 * the next frame with the interface hidden.
 */
export function savePicture(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('savePicture: the canvas could not be read'));
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      // The download has its own copy once the click went through.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      resolve();
    }, 'image/png');
  });
}

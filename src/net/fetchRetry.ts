/**
 * fetch() with retries for transient failures (network errors, 429, 5xx),
 * using exponential backoff. 4xx other than 429 fail immediately.
 */
export async function fetchRetry(url: string, init?: RequestInit, retries = 3): Promise<Response> {
  let delay = 400;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || (res.status < 500 && res.status !== 429) || attempt >= retries) return res;
    } catch (err) {
      if (attempt >= retries || (err as Error).name === 'AbortError') throw err;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
}

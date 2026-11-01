// XHR rather than fetch: Chromium 44's fetch omits cookies unless told, and lacks AbortController.
// The frame authenticates with an HttpOnly cookie set by the hub (see hub/src/auth.ts).

export function request<T>(method: string, url: string, body?: unknown, timeoutMs = 15000, credentials = true): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.timeout = timeoutMs;
    xhr.withCredentials = credentials; // off for third-party APIs (CORS * forbids credentials)
    if (body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(xhr.responseText ? JSON.parse(xhr.responseText) : (undefined as T));
        } catch (e) {
          reject(e);
        }
      } else {
        reject(new ApiError(xhr.status, xhr.responseText));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network'));
    xhr.ontimeout = () => reject(new ApiError(0, 'timeout'));
    xhr.send(body === undefined ? null : JSON.stringify(body));
  });
}

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}`);
  }
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
};

/** Bridge exposed by the Android wrapper app (apps/android). Absent in a desktop browser. */
interface FrameShellBridge {
  setBrightness?(value: number): void;
  /** Switch the backlight fully off until the given time (ms). Returns false if not permitted. */
  sleepUntil?(wakeAtMs: number): boolean;
  openFrameo?(): void;
  reload?(): void;
  version?(): string;
  /** HQ easter egg: raise media volume to this fraction of max (only raises); restoreVolume puts it back. */
  boostVolume?(fraction: number): void;
  restoreVolume?(): void;
  /** Night: backlight to 0 (screen stays on, tap wakes). False = not possible; use sleepUntil instead. */
  backlightOff?(): boolean;
  backlightRestore?(): void;
}
export const shell: FrameShellBridge | undefined = (window as unknown as { FrameShell?: FrameShellBridge }).FrameShell;

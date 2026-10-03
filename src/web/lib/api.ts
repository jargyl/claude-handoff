// Thin fetch wrapper. Every state-changing request carries X-Handoff, which the
// server requires (a cross-site page can't add custom headers without CORS).

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let unauthorized: (() => void) | null = null;
export function onUnauthorized(fn: () => void) {
  unauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-handoff': '1' };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, "Can't reach the Handoff server. Is it still running?");
  }
  if (res.status === 401) {
    unauthorized?.();
    throw new ApiError(401, 'Access token required');
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.message) msg = j.message;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Upload a file with progress (fetch can't report upload progress). */
export function uploadFile<T>(url: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('x-handoff', '1');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not json */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data?.message ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed. Is the server still running?'));
    xhr.send(file);
  });
}

/** Trigger a browser download for a GET endpoint. */
export function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

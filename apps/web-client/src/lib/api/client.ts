/**
 * Canonical API client for the frontend.
 *
 * Rule: the browser should prefer same-origin `/api` calls. In local Vite dev
 * that path is proxied to 5001; in the single-origin/ngrok shape the
 * control-plane serves both the app shell and the API from 5001 directly.
 * No code outside /lib/api should call `fetch` against the backend directly.
 */

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") as string | undefined) ??
  "";

export const TOKEN_STORAGE_KEY = "parallel_token";
export const USER_STORAGE_KEY = "parallel_user";

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthorized(): boolean {
    // 401 = no/invalid auth (logout). 403 = authenticated but lacks
    // permission (don't logout — caller renders permission error).
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  auth?: boolean;
  bodyEncoding?: "json" | "form";
};

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

function buildQuery(query?: RequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, signal, auth = true, bodyEncoding = "json" } = options;

  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const isFormEncoded = bodyEncoding === "form" && body !== undefined && !isFormData;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  // Let the browser set Content-Type + boundary when the body is FormData.
  if (isFormEncoded) {
    headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  } else if (body !== undefined && !isFormData) {
    headers["Content-Type"] = "application/json";
  }

  if (auth) {
    const token = getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const url = `${API_BASE_URL}${path}${buildQuery(query)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : isFormData
            ? (body as FormData)
            : isFormEncoded
              ? new URLSearchParams(
                  Object.entries(body as Record<string, unknown>).reduce<Record<string, string>>(
                    (params, [key, value]) => {
                      if (value !== undefined && value !== null) {
                        params[key] = String(value);
                      }
                      return params;
                    },
                    {},
                  ),
                ).toString()
            : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(
      `Network error contacting ${path}`,
      0,
      "network_error",
      err,
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const body =
      (payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}) ?? {};
    const message =
      (body.error as string) ||
      (body.message as string) ||
      `Request to ${path} failed (${response.status})`;
    const code = body.code as string | undefined;

    // ONLY 401 triggers logout. 403 means the user is authenticated
    // but doesn't have permission for this specific action — propagate
    // as ApiError so the caller can render a permissions warning,
    // without clearing the session.
    if (response.status === 401 && onUnauthorized) {
      onUnauthorized();
    }

    throw new ApiError(message, response.status, code, body);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...opts, method: "GET" }),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method">) =>
    request<T>(path, { ...opts, method: "POST", body }),
  put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method">) =>
    request<T>(path, { ...opts, method: "PUT", body }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method">) =>
    request<T>(path, { ...opts, method: "PATCH", body }),
  delete: <T>(path: string, opts?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...opts, method: "DELETE" }),
};

export { API_BASE_URL };

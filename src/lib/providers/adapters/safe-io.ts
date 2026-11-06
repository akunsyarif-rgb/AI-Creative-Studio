import {
  UnsafeUrlError, assertPublicHost, assertSafeBaseUrl, parsePublicHttpsUrl, readLimited, type Lookup
} from "@/lib/net/public-url";
import { ProviderError } from "../types";

/**
 * Network plumbing shared by the user-defined provider adapters. The base URL is chosen by the user, so
 * every request re-validates it (https, public host), refuses redirects and has a timeout; image links
 * returned by a provider are downloaded only from public https hosts with bounded, re-validated redirects.
 */

export interface SafeIODeps {
  fetch?: typeof fetch;
  lookup?: Lookup;
}

export const REQUEST_TIMEOUT_MS = 120_000;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 2;

export function mapStatus(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("auth", "The provider rejected the API key.", true);
  if (status === 402) return new ProviderError("insufficient_funds", "The provider reports insufficient credits.", true);
  if (status === 429) return new ProviderError("rate_limited", "The provider rate limit was reached.", true);
  if (status === 400 || status === 404 || status === 405 || status === 415 || status === 422) {
    return new ProviderError("invalid_request", "The provider rejected the request (check the address, model name and size).", true);
  }
  return new ProviderError("unavailable", "The provider is temporarily unavailable.", false);
}

export function createSafeIO(baseUrl: string, deps: SafeIODeps = {}) {
  const fetchImpl = deps.fetch ?? fetch;

  /** Validates the saved base URL (again) and performs one request without following redirects. */
  async function call(path: string, init: RequestInit): Promise<Response> {
    let base: URL;
    try {
      base = await assertSafeBaseUrl(baseUrl, deps.lookup);
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw new ProviderError("invalid_request", `The provider address is not allowed: ${error.message}`, true);
      throw error;
    }
    try {
      return await fetchImpl(`${base.href.replace(/\/$/, "")}${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ProviderError("timeout", "The provider did not respond in time. The request may still have been billed.", false);
      }
      throw new ProviderError("unavailable", "Could not reach the provider.", false);
    }
  }

  /** Downloads an image URL returned by the provider. The API key is never sent. */
  async function downloadImage(rawUrl: string): Promise<Uint8Array> {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        const url = parsePublicHttpsUrl(current);
        await assertPublicHost(url, deps.lookup);
        const res = await fetchImpl(url.href, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) break;
          current = new URL(location, url).href;
          continue;
        }
        if (!res.ok) break;
        return await readLimited(res, MAX_IMAGE_BYTES);
      } catch {
        break;
      }
    }
    // The provider already generated (and may have billed) the image, so the outcome is not "known".
    throw new ProviderError("unknown", "The provider returned an image link that could not be downloaded safely.", false);
  }

  return { call, downloadImage };
}

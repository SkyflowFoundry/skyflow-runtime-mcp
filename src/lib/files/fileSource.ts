import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  extensionFromFileName,
  extensionFromMimeType,
} from "../mappings/fileFormats.js";

/**
 * Resolves tool file inputs (a signed/public URL or inline base64) into the
 * raw bytes the Skyflow file endpoints require.
 *
 * Skyflow's Detect file APIs only accept base64-encoded content, so URLs are
 * downloaded server-side; callers base64-encode {@link ResolvedFile.buffer}
 * once, at the point they build the request, to avoid extra round-trips.
 */

/** Maximum file size accepted from a URL download (raw, decoded bytes). */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

/** Timeout for downloading a file from a URL (covers the body read too). */
export const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Maximum number of HTTP redirects to follow (each hop is re-validated). */
const MAX_REDIRECTS = 5;

/** A resolved input file ready to send to Skyflow. */
export interface ResolvedFile {
  /** Raw (decoded) file bytes. Base64-encode when building the request. */
  buffer: Buffer;
  fileName: string;
  /** Lowercased extension, e.g. "pdf". */
  extension: string;
  /** Content-Type reported by the remote server, when downloaded from a URL. */
  contentType?: string;
}

/** Error thrown for invalid or unfetchable file inputs. */
export class FileSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileSourceError";
  }
}

/**
 * Decide whether an IP address is private, loopback, link-local, or otherwise
 * not a legitimate public download target (SSRF guard).
 */
function isBlockedIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (family === 6) {
    const host = address.toLowerCase();
    if (host === "::1" || host === "::") return true;
    if (host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd")) return true;
    // IPv4-mapped IPv6 in dotted form, e.g. ::ffff:169.254.169.254
    const dotted = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted && isIP(dotted[1]) === 4) return isBlockedIp(dotted[1]);
    // IPv4-mapped IPv6 in hex form, e.g. ::ffff:a9fe:a9fe (Node normalizes to this)
    const hexMapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = Number.parseInt(hexMapped[1], 16);
      const lo = Number.parseInt(hexMapped[2], 16);
      const ipv4 = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
      return isBlockedIp(ipv4);
    }
    return false;
  }
  return false;
}

/**
 * Normalize a URL hostname to a dotted/colon IP literal if it is one in any
 * common encoding (dotted-decimal, 32-bit decimal, hex, IPv6). Returns null for
 * real hostnames. This catches SSRF bypasses like http://2130706433/ (decimal
 * for 127.0.0.1) that a plain string blocklist misses.
 */
function ipLiteralFromHostname(hostname: string): string | null {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return host;

  // 32-bit decimal, e.g. 2130706433
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
    }
  }

  // Hex, e.g. 0x7f000001
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = Number.parseInt(host, 16);
    if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
    }
  }

  return null;
}

const NOT_ALLOWED = (hostname: string) =>
  new FileSourceError(
    `fileUrl host "${hostname}" is not allowed. URLs must point to a publicly reachable file (e.g. a signed S3/GCS URL).`
  );

/**
 * Reject hosts that must not be downloaded from: loopback, private ranges,
 * link-local/cloud-metadata, and CGNAT, in their common literal encodings AND
 * by resolving hostnames so a public name whose A/AAAA record points at an
 * internal address is also blocked (the primary SSRF risk for a
 * fetch-arbitrary-URL feature).
 *
 * Note: DNS is resolved here at check time; a determined attacker controlling
 * their own DNS could still rebind between this lookup and fetch's own
 * resolution (TOCTOU). Closing that fully requires pinning the connection to
 * the validated IP — deployments handling untrusted URLs should also enforce
 * network egress controls to a metadata endpoint.
 */
async function assertHostAllowed(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw NOT_ALLOWED(hostname);
  }

  // IP literal (in any encoding — new URL() normalizes shorthand/octal/decimal
  // forms to dotted-quad before we see the hostname).
  const ipLiteral = ipLiteralFromHostname(host);
  if (ipLiteral) {
    if (isBlockedIp(ipLiteral)) throw NOT_ALLOWED(hostname);
    return;
  }

  // Hostname: resolve and reject if any resolved address is non-public.
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new FileSourceError(`Failed to download fileUrl: could not resolve host "${hostname}".`);
  }
  if (addresses.some(({ address }) => isBlockedIp(address))) {
    throw NOT_ALLOWED(hostname);
  }
}

/** Validate the URL scheme, returning the parsed URL. */
function parseDownloadUrl(fileUrl: string): URL {
  let url: URL;
  try {
    url = new URL(fileUrl);
  } catch {
    throw new FileSourceError(`fileUrl is not a valid URL: ${fileUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FileSourceError(
      `fileUrl must use http(s); got protocol "${url.protocol}"`
    );
  }
  return url;
}

/** Parse a filename out of a Content-Disposition header, if present. */
function fileNameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  // RFC 5987 filename*=UTF-8''name.ext takes precedence over filename="name.ext"
  const extended = header.match(/filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]+)/i);
  if (extended) {
    try {
      const decoded = decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ""));
      if (decoded) return decoded;
    } catch {
      // fall through to the plain filename parameter
    }
  }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : undefined;
}

/** Derive a filename from the URL path, e.g. ".../reports/scan.pdf?sig=..." → "scan.pdf". */
function fileNameFromUrl(url: URL): string | undefined {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Map a download error to a FileSourceError with a friendly reason. Passes an
 * existing FileSourceError through unchanged (e.g. the size-cap abort) and
 * translates a timeout AbortError into the intended "timed out" message.
 */
function downloadFailure(error: unknown): FileSourceError {
  if (error instanceof FileSourceError) return error;
  const reason =
    error instanceof Error && error.name === "AbortError"
      ? `download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`
      : error instanceof Error
        ? error.message
        : "unknown network error";
  return new FileSourceError(`Failed to download fileUrl: ${reason}`);
}

/** Read a response body into a Buffer, aborting if it exceeds the size cap. */
async function readBodyWithCap(
  response: Response,
  controller: AbortController
): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
    controller.abort();
    throw new FileSourceError(
      `File is too large: ${contentLength} bytes (limit ${MAX_DOWNLOAD_BYTES}).`
    );
  }

  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new FileSourceError(
        `File is too large: exceeds ${MAX_DOWNLOAD_BYTES} bytes.`
      );
    }
    return Buffer.from(arrayBuffer);
  }

  // Stream so an absent/understated Content-Length can't force us to buffer an
  // unbounded body into memory before the size check.
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    received += chunk.byteLength;
    if (received > MAX_DOWNLOAD_BYTES) {
      controller.abort();
      throw new FileSourceError(
        `File is too large: exceeds ${MAX_DOWNLOAD_BYTES} bytes.`
      );
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, received);
}

/**
 * Download a file from a signed or public URL, enforcing scheme, host, size,
 * and timeout limits. Redirects are followed manually so each hop's host is
 * re-validated (an initial-host-only check is bypassable via a redirect to an
 * internal address). Returns the raw bytes plus name hints from the response.
 */
export async function downloadFileFromUrl(fileUrl: string): Promise<{
  buffer: Buffer;
  fileName?: string;
  contentType?: string;
}> {
  let url = parseDownloadUrl(fileUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    for (let redirects = 0; ; redirects++) {
      await assertHostAllowed(url.hostname);

      let response: Response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (error) {
        throw downloadFailure(error);
      }

      // Manual redirect handling: re-validate the destination host each hop.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new FileSourceError(
            `Failed to download fileUrl: server responded with HTTP ${response.status} but no redirect location.`
          );
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new FileSourceError(
            `Failed to download fileUrl: too many redirects (>${MAX_REDIRECTS}).`
          );
        }
        try {
          url = new URL(location, url);
        } catch {
          throw new FileSourceError(
            `Failed to download fileUrl: invalid redirect location "${location}".`
          );
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          throw new FileSourceError(
            `Failed to download fileUrl: redirect to unsupported protocol "${url.protocol}".`
          );
        }
        continue;
      }

      if (!response.ok) {
        throw new FileSourceError(
          `Failed to download fileUrl: server responded with HTTP ${response.status}. ` +
            `If this is a signed URL, it may have expired.`
        );
      }

      // Mapped so a timeout *during* the body read reports "timed out" rather
      // than a raw AbortError (the size-cap FileSourceError passes through).
      let buffer: Buffer;
      try {
        buffer = await readBodyWithCap(response, controller);
      } catch (error) {
        throw downloadFailure(error);
      }
      const contentType = response.headers.get("content-type") ?? undefined;
      const fileName =
        fileNameFromContentDisposition(response.headers.get("content-disposition")) ??
        fileNameFromUrl(url);

      return { buffer, fileName, contentType };
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Input accepted by {@link resolveFileInput}. */
export interface FileInputArgs {
  fileUrl?: string;
  fileDataBase64?: string;
  fileName?: string;
}

/**
 * Resolve a tool's file input (URL or inline base64) to raw bytes and a file
 * name with a usable extension.
 *
 * Resolution order for the name: explicit `fileName` arg → Content-Disposition
 * header → URL path → extension inferred from Content-Type.
 */
export async function resolveFileInput(args: FileInputArgs): Promise<ResolvedFile> {
  const { fileUrl, fileDataBase64, fileName } = args;

  if (fileUrl && fileDataBase64) {
    throw new FileSourceError(
      "Provide either fileUrl or fileDataBase64, not both."
    );
  }

  if (fileUrl) {
    const { buffer, fileName: remoteName, contentType } =
      await downloadFileFromUrl(fileUrl);

    let resolvedName = fileName ?? remoteName;
    let extension = resolvedName ? extensionFromFileName(resolvedName) : undefined;

    if (!extension && contentType) {
      const inferred = extensionFromMimeType(contentType);
      if (inferred) {
        extension = inferred;
        resolvedName = `${resolvedName ?? "file"}.${inferred}`;
      }
    }

    if (!resolvedName || !extension) {
      throw new FileSourceError(
        "Could not determine the file type from the URL or response headers. " +
          "Pass fileName (e.g. \"report.pdf\") so the file format is known."
      );
    }

    return { buffer, fileName: resolvedName, extension, contentType };
  }

  if (fileDataBase64) {
    if (!fileName) {
      throw new FileSourceError(
        "fileName is required when passing fileDataBase64 (the extension determines the file format)."
      );
    }
    const extension = extensionFromFileName(fileName);
    if (!extension) {
      throw new FileSourceError(
        `fileName "${fileName}" has no extension; the extension determines the file format.`
      );
    }
    const buffer = Buffer.from(fileDataBase64, "base64");
    if (buffer.byteLength === 0) {
      throw new FileSourceError("fileDataBase64 decoded to an empty file.");
    }
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new FileSourceError(
        `File is too large: ${buffer.byteLength} bytes (limit ${MAX_DOWNLOAD_BYTES}).`
      );
    }
    return { buffer, fileName, extension };
  }

  throw new FileSourceError(
    "A file is required: pass fileUrl (signed or public URL) or fileDataBase64."
  );
}

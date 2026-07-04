import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lookup } from "node:dns/promises";
import {
  resolveFileInput,
  downloadFileFromUrl,
  FileSourceError,
  MAX_DOWNLOAD_BYTES,
} from "../../../src/lib/files/fileSource";

// DNS is resolved by the SSRF guard for hostnames; default to a public address.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
const mockLookup = vi.mocked(lookup);

function stubFetch(response: Response | (() => Promise<Response>)) {
  const impl = typeof response === "function" ? response : async () => response;
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("fileSource", () => {
  beforeEach(() => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("resolveFileInput with base64", () => {
    it("resolves base64 input with a file name", async () => {
      const content = Buffer.from("hello world");
      const resolved = await resolveFileInput({
        fileDataBase64: content.toString("base64"),
        fileName: "Notes.TXT",
      });

      expect(resolved.buffer.equals(content)).toBe(true);
      expect(resolved.fileName).toBe("Notes.TXT");
      expect(resolved.extension).toBe("txt");
    });

    it("rejects base64 payloads over the size limit", async () => {
      const huge = "A".repeat(MAX_DOWNLOAD_BYTES + 8);
      const big = Buffer.from(huge).toString("base64");
      await expect(
        resolveFileInput({ fileDataBase64: big, fileName: "big.txt" })
      ).rejects.toThrow(/too large/);
    });

    it("rejects base64 input without a file name", async () => {
      await expect(
        resolveFileInput({ fileDataBase64: "aGVsbG8=" })
      ).rejects.toThrow(FileSourceError);
    });

    it("rejects file names without an extension", async () => {
      await expect(
        resolveFileInput({ fileDataBase64: "aGVsbG8=", fileName: "noext" })
      ).rejects.toThrow(/extension/);
    });

    it("rejects empty base64 payloads", async () => {
      await expect(
        resolveFileInput({ fileDataBase64: "!!!", fileName: "a.txt" })
      ).rejects.toThrow(/empty/);
    });

    it("rejects providing both fileUrl and fileDataBase64", async () => {
      await expect(
        resolveFileInput({
          fileUrl: "https://example.com/a.txt",
          fileDataBase64: "aGVsbG8=",
          fileName: "a.txt",
        })
      ).rejects.toThrow(/not both/);
    });

    it("rejects when neither input is provided", async () => {
      await expect(resolveFileInput({})).rejects.toThrow(/fileUrl/);
    });
  });

  describe("downloadFileFromUrl", () => {
    it("downloads a file and infers the name from the URL path", async () => {
      const bytes = Buffer.from("pdf bytes");
      stubFetch(new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }));

      const result = await downloadFileFromUrl(
        "https://bucket.s3.amazonaws.com/folder/report.pdf?X-Amz-Signature=abc"
      );

      expect(result.buffer.equals(bytes)).toBe(true);
      expect(result.fileName).toBe("report.pdf");
      expect(result.contentType).toBe("application/pdf");
    });

    it("prefers the Content-Disposition filename over the URL path", async () => {
      stubFetch(
        new Response(Buffer.from("x"), {
          status: 200,
          headers: { "content-disposition": 'attachment; filename="actual.docx"' },
        })
      );

      const result = await downloadFileFromUrl("https://example.com/download?id=42");
      expect(result.fileName).toBe("actual.docx");
    });

    it("rejects non-http(s) URLs", async () => {
      await expect(downloadFileFromUrl("ftp://example.com/a.txt")).rejects.toThrow(/http/);
    });

    it("rejects invalid URLs", async () => {
      await expect(downloadFileFromUrl("not a url")).rejects.toThrow(/not a valid URL/);
    });

    it.each([
      "https://localhost/file.txt",
      "https://127.0.0.1/file.txt",
      "https://10.0.0.5/file.txt",
      "https://192.168.1.10/file.txt",
      "https://172.20.3.4/file.txt",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.internal/file.txt",
      "https://[::1]/file.txt",
      // Alternate IP encodings for internal hosts
      "https://2130706433/file.txt", // decimal for 127.0.0.1
      "https://0x7f000001/file.txt", // hex for 127.0.0.1
      "https://[::ffff:169.254.169.254]/file.txt", // IPv4-mapped IPv6 metadata
      "https://100.64.0.1/file.txt", // carrier-grade NAT
    ])("blocks private/internal host %s", async (url) => {
      await expect(downloadFileFromUrl(url)).rejects.toThrow(/not allowed/);
    });

    it("allows public hosts", async () => {
      stubFetch(new Response(Buffer.from("ok"), { status: 200 }));
      const result = await downloadFileFromUrl("https://storage.googleapis.com/b/file.txt");
      expect(result.buffer.toString()).toBe("ok");
    });

    it.each([
      "https://127.1/file.txt", // shorthand — new URL normalizes to 127.0.0.1
      "https://0177.0.0.1/file.txt", // octal — normalizes to 127.0.0.1
      "https://2852039166/file.txt", // decimal — normalizes to 169.254.169.254
    ])("blocks shorthand/octal/decimal IP forms %s", async (url) => {
      stubFetch(new Response(Buffer.from("x"), { status: 200 }));
      await expect(downloadFileFromUrl(url)).rejects.toThrow(/not allowed/);
    });

    it("blocks a public hostname that resolves to an internal address (DNS SSRF)", async () => {
      mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as any);
      stubFetch(new Response(Buffer.from("secrets"), { status: 200 }));

      await expect(
        downloadFileFromUrl("https://intake.attacker.example/file.pdf")
      ).rejects.toThrow(/not allowed/);
    });

    it("surfaces a DNS resolution failure as a download error", async () => {
      mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
      stubFetch(new Response(Buffer.from("x"), { status: 200 }));

      await expect(
        downloadFileFromUrl("https://nonexistent.example/file.pdf")
      ).rejects.toThrow(/could not resolve/);
    });

    it.each([
      "https://fcbarcelona.com/file.txt", // hostname starting with "fc" is not an IPv6 range
      "https://fdn.example.com/file.txt",
      "https://[fd12:3456::1]/file.txt", // but IPv6 unique-local literals are blocked
    ])("only treats IPv6 literals as IPv6 ranges: %s", async (url) => {
      stubFetch(new Response(Buffer.from("ok"), { status: 200 }));
      if (url.includes("[fd")) {
        await expect(downloadFileFromUrl(url)).rejects.toThrow(/not allowed/);
      } else {
        await expect(downloadFileFromUrl(url)).resolves.toBeDefined();
      }
    });

    it("rejects oversized files based on Content-Length", async () => {
      stubFetch(
        new Response(Buffer.from("x"), {
          status: 200,
          headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) },
        })
      );

      await expect(downloadFileFromUrl("https://example.com/huge.bin")).rejects.toThrow(/too large/);
    });

    it("surfaces HTTP error statuses with a helpful message", async () => {
      stubFetch(new Response("expired", { status: 403 }));

      await expect(downloadFileFromUrl("https://example.com/file.pdf")).rejects.toThrow(/403/);
    });

    it("wraps network errors", async () => {
      stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));

      await expect(downloadFileFromUrl("https://example.com/file.pdf")).rejects.toThrow(
        /ECONNREFUSED/
      );
    });

    it("follows a redirect to another public host", async () => {
      const bytes = Buffer.from("redirected content");
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("start.example.com")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://cdn.example.com/real.pdf" },
          });
        }
        return new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await downloadFileFromUrl("https://start.example.com/redir");
      expect(result.buffer.equals(bytes)).toBe(true);
      expect(result.fileName).toBe("real.pdf");
    });

    it("re-validates the host on each redirect hop (blocks SSRF via redirect)", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        })
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        downloadFileFromUrl("https://public.example.com/redir")
      ).rejects.toThrow(/not allowed/);
    });

    it("rejects a redirect loop that exceeds the hop limit", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://loop.example.com/again" },
        })
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        downloadFileFromUrl("https://loop.example.com/again")
      ).rejects.toThrow(/too many redirects/);
    });

    it("enforces the size cap while streaming when Content-Length is absent", async () => {
      // A body larger than the cap, delivered with no Content-Length header.
      const oversized = new Uint8Array(MAX_DOWNLOAD_BYTES + 1024);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(oversized);
          controller.close();
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(stream, { status: 200 }))
      );

      await expect(
        downloadFileFromUrl("https://example.com/huge-nolength.bin")
      ).rejects.toThrow(/too large/);
    });
  });

  describe("resolveFileInput with URL", () => {
    it("uses the explicit fileName over the remote name", async () => {
      stubFetch(new Response(Buffer.from("data"), { status: 200 }));

      const resolved = await resolveFileInput({
        fileUrl: "https://example.com/blob",
        fileName: "override.csv",
      });

      expect(resolved.fileName).toBe("override.csv");
      expect(resolved.extension).toBe("csv");
    });

    it("falls back to Content-Type when no name is available", async () => {
      stubFetch(
        new Response(Buffer.from("data"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        })
      );

      const resolved = await resolveFileInput({ fileUrl: "https://example.com/download" });

      expect(resolved.extension).toBe("pdf");
      expect(resolved.fileName).toBe("download.pdf");
    });

    it("errors when the file type cannot be determined", async () => {
      stubFetch(
        new Response(Buffer.from("data"), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        })
      );

      await expect(
        resolveFileInput({ fileUrl: "https://example.com/download" })
      ).rejects.toThrow(/fileName/);
    });
  });
});

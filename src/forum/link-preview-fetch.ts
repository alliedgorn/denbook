// T#962 — CVE-2026-111497 (out-of-bounds write in the Brotli decoder bundled
// with Bun < 1.4.4). Bun's fetch() advertises br and decodes it automatically,
// so the link-preview fetch of an arbitrary https URL is the one place where a
// remote server picks the bytes our Brotli decoder runs on.
//
// Interim until Bun >= 1.4.4 (option (b) on T#962, agreed with Gnarl):
//   - ask for identity, so an honest server sends plain HTML;
//   - decompress: false, so a server that sends br anyway is never decoded;
//   - any non-identity Content-Encoding is refused, not parsed.
// Remove this once the runtime is >= 1.4.4 — it costs previews nothing today.

export type PreviewFetch = (url: string, init: RequestInit & { decompress?: boolean }) => Promise<Response>;

export async function fetchPreviewHtml(url: string, fetchImpl: PreviewFetch = fetch): Promise<string | null> {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'DenBook/1.0', 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(5000),
    redirect: 'manual', // Don't follow redirects (prevents redirect-to-internal)
    decompress: false,
  });
  const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  return await response.text();
}

// A file's identity for resuming: name + size + last-modified time. Reading 5 GB just to hash it would
// take minutes, and the backend double-checks every part's exact size before it assembles the file.
// The same file picked again (even after a refresh or on another day) gets the same fingerprint, which
// is how the server finds the unfinished upload to resume.

function fallbackHash(text) {
  // Deterministic non-crypto hash for insecure contexts where crypto.subtle is unavailable (plain http).
  let out = '';
  for (let seed = 0; seed < 8; seed++) {
    let h = 0x811c9dc5 ^ (seed * 0x9e3779b1);
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out; // 64 hex chars
}

export async function computeFingerprint(file) {
  const text = `${file.name}|${file.size}|${file.lastModified}`;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallbackHash(text);
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

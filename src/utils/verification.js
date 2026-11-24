/**
 * Marksheet verification links (QR) — zero-login public verification.
 *
 * A printed marksheet must be verifiable by anyone holding the paper, WITHOUT a
 * teacher login. At the same time nothing sensitive (guardian phone, NID, birth
 * certificate, address…) may travel inside a QR code that is printed in public.
 *
 * So the QR carries ONE base64url payload holding only the display fields a verifier
 * is meant to see plus a short integrity code. Two payload encodings are understood:
 *
 *  • v2 (current, compact) — the fields joined by `|`, e.g. `2|নাম|১২|৪.৫০|বিদ্যালয়|…`.
 *    JSON keys/quotes cost ~40 bytes, which pushes the QR up a whole version and
 *    shrinks every printed module. The compact form keeps the same information in
 *    noticeably fewer bytes, so the printed QR stays easy to scan.
 *  • v1 (legacy) — a JSON object `{v:1,n,r,g,s,c,t,y}`. Still readable, so a marksheet
 *    printed before this change keeps verifying.
 *
 * `vsc` (verification signature code) is a deterministic checksum of those fields, so
 * an edited URL no longer verifies. This is an integrity stamp, not a security
 * boundary: the purpose is to prove the printed paper matches the digital record, not
 * to hide the public display fields (which are printed on the paper anyway).
 *
 * The data never depends on the Realtime Database, so `/verify` works offline and with
 * NO login, exactly as required.
 */

export const VERIFY_ROUTE = '/verify';
export const VERIFY_VERSION = 2;
/** Field order of the compact (v2) payload. */
const COMPACT_FIELDS = Object.freeze(['v', 'n', 'r', 'g', 's', 'c', 't', 'y']);
const FIELD_SEPARATOR = '|';

/** URL-safe base64 (browser + Node, no Buffer dependency). */
const toBase64Url = (text) => {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value) => {
  const normalized = String(value ?? '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/** Stable 7-character integrity code of the display fields. */
export function verificationCode(record = {}) {
  const source = [record?.v ?? VERIFY_VERSION, record?.n, record?.r, record?.g, record?.s, record?.c, record?.t, record?.y]
    .map((part) => String(part ?? ''))
    .join('|');
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(7, '0').slice(0, 7);
}

/** Keeps a value usable inside the `|`-joined payload. */
const field = (value) => String(value ?? '').replace(/[|\r\n]+/g, ' ').trim();

/** Compact (v2) textual payload of a record. */
const encodeCompact = (record) => COMPACT_FIELDS
  .map((key) => (key === 'v' ? String(record?.v ?? VERIFY_VERSION) : field(record?.[key])))
  .join(FIELD_SEPARATOR);

/** Decodes either payload shape, always returning the same record object. */
const decodePayload = (text) => {
  const raw = String(text ?? '');
  if (!raw) return null;
  if (raw.charAt(0) === '{') {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      v: parsed.v ?? 1,
      n: String(parsed.n ?? ''),
      r: String(parsed.r ?? ''),
      g: String(parsed.g ?? ''),
      s: String(parsed.s ?? ''),
      c: String(parsed.c ?? ''),
      t: String(parsed.t ?? ''),
      y: String(parsed.y ?? ''),
    };
  }
  const parts = raw.split(FIELD_SEPARATOR);
  if (parts.length < 2) return null;
  const [v, n, r, g, s, c, t, y] = parts;
  return {
    v: Number(v) || VERIFY_VERSION,
    n: String(n ?? ''),
    r: String(r ?? ''),
    g: String(g ?? ''),
    s: String(s ?? ''),
    c: String(c ?? ''),
    t: String(t ?? ''),
    y: String(y ?? ''),
  };
};

/**
 * Builds the compact verification record of one pupil's marksheet.
 * Only non-sensitive display fields are kept — and only the ones a verifier needs:
 * name (নাম), roll (রোল), GPA and school name (বিদ্যালয়ের নাম).
 *
 * `className` / `resultLabel` / `year` are still accepted (every existing caller passes
 * them) but they are NOT encoded: the class, the result type and the academic year are
 * already printed on the paper, and every extra byte pushes the QR to a higher version
 * and shrinks its printed modules. Dropping them keeps the code comfortably scannable.
 */
export function buildVerificationRecord({
  student,
  result,
  schoolProfile,
  schoolName = '',
} = {}) {
  const gpa = Number(result?.gpa);
  return {
    v: VERIFY_VERSION,
    n: String(student?.name ?? '').trim(),
    r: student?.roll === null || student?.roll === undefined ? '' : String(student.roll).trim(),
    g: Number.isFinite(gpa) ? gpa.toFixed(2) : '',
    s: String(schoolName || schoolProfile?.name || schoolProfile?.schoolName || '').trim(),
    // Reserved for future use (kept in the shape so the URL stays stable).
    c: '',
    t: '',
    y: '',
  };
}

/**
 * Absolute-or-relative public verification URL of one marksheet.
 * `origin` should be `window.location.origin`; when omitted a relative path is returned
 * (still a perfectly scannable QR when the PDF itself is printed from the app domain).
 */
export function buildVerificationUrl(record = {}, origin = '') {
  const payload = {
    v: VERIFY_VERSION,
    n: record?.n ?? '',
    r: record?.r ?? '',
    g: record?.g ?? '',
    s: record?.s ?? '',
    c: record?.c ?? '',
    t: record?.t ?? '',
    y: record?.y ?? '',
  };
  const params = new URLSearchParams();
  // The compact form keeps the QR small enough that its modules stay printable.
  params.set('d', toBase64Url(encodeCompact(payload)));
  params.set('vsc', verificationCode(payload));
  const base = String(origin ?? '').replace(/\/+$/, '');
  return `${base}${VERIFY_ROUTE}?${params.toString()}`;
}

/**
 * Reads a verification record back out of a `/verify?...` URL.
 * Understands both the current compact payload and the legacy JSON payload.
 * Returns `{ ok:false, reason }` for a missing / tampered payload — never throws.
 */
export function readVerificationFromSearch(search = '') {
  try {
    const params = new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
    const encoded = params.get('d');
    if (!encoded) return { ok: false, reason: 'missing', record: null };
    const record = decodePayload(fromBase64Url(encoded));
    if (!record) return { ok: false, reason: 'missing', record: null };
    const expected = verificationCode(record);
    const supplied = params.get('vsc');
    // An old QR without a code still resolves; a MISMATCHED code does not.
    const verified = !supplied || supplied === expected;
    return { ok: verified, reason: verified ? '' : 'tampered', record, code: expected };
  } catch {
    return { ok: false, reason: 'unreadable', record: null };
  }
}

export default {
  VERIFY_ROUTE,
  VERIFY_VERSION,
  buildVerificationRecord,
  buildVerificationUrl,
  readVerificationFromSearch,
  verificationCode,
};

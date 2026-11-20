/**
 * Dynamic school profile helpers.
 *
 * The platform is a multi-tenant SaaS: **nothing** about a school may be hardcoded.
 * Every screen, A4 template and print header reads the active tenant's profile from
 * `schoolData/{schoolId}/profile` and funnels it through these pure helpers, so a
 * blank/new school never renders somebody else's name or address.
 */

/** Canonical, tenant-agnostic shape of `schoolData/{schoolId}/profile`. */
export const EMPTY_SCHOOL_PROFILE = Object.freeze({
  id: '',
  name: '',
  schoolName: '',
  nameEn: '',
  division: '',
  district: '',
  upazila: '',
  // Geography (বিভাগ ➔ জেলা ➔ উপজেলা ➔ গ্রাম/ইউনিয়ন)
  divisionId: '',
  divisionName: '',
  districtId: '',
  districtName: '',
  upazilaId: '',
  upazilaName: '',
  villageOrUnion: '',
  postOffice: '',
  // Identity
  emisCode: '',
  establishedYear: '',
  academicYear: '',
  motto: '',
  logoText: '',
  // Contact
  phone: '',
  email: '',
  website: '',
  // Leadership (only the *label* is static – never a person's name)
  headTeacher: '',
  headTeacherDesignation: 'প্রধান শিক্ষক',
});

const str = (value) => (value === null || value === undefined ? '' : String(value).trim());

/**
 * Merges a remote/partial profile into the canonical shape.
 * Later sources win, but empty strings never erase a known value unless
 * `overwrite` is explicitly requested.
 */
export function normalizeSchoolProfile(raw, ...fallbacks) {
  const merged = { ...EMPTY_SCHOOL_PROFILE };
  [raw, ...fallbacks].forEach((source) => {
    if (!source || typeof source !== 'object') return;
    Object.entries(source).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      // Explicit empty strings are intentional edits and must clear old values.
      merged[key] = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? (typeof value === 'boolean' ? value : str(value))
        : value;
    });
  });
  // Accept requested API names and legacy aliases without reviving cleared values.
  // When both spellings exist, canonical form keys win (including intentional '').
  if (raw?.name !== undefined) merged.name = str(raw.name);
  else if (raw?.schoolName !== undefined) merged.name = str(raw.schoolName);
  if (raw?.divisionName !== undefined) merged.divisionName = str(raw.divisionName);
  else if (raw?.division !== undefined) merged.divisionName = str(raw.division);
  if (raw?.districtName !== undefined) merged.districtName = str(raw.districtName);
  else if (raw?.district !== undefined) merged.districtName = str(raw.district);
  if (raw?.upazilaName !== undefined) merged.upazilaName = str(raw.upazilaName);
  else if (raw?.upazila !== undefined) merged.upazilaName = str(raw.upazila);
  // Keep aliases synchronized for clients using either schema.
  merged.schoolName = merged.name;
  merged.division = merged.divisionName;
  merged.district = merged.districtName;
  merged.upazila = merged.upazilaName;
  if (!merged.villageOrUnion && merged.village) merged.villageOrUnion = str(merged.village);
  if (!merged.address) merged.address = addressLine(merged);
  if (!merged.logoText) merged.logoText = deriveLogoText(merged);
  return merged;
}

/** "গ্রাম/ইউনিয়ন, উপজেলা, জেলা" — never the school name. */
export function addressLine(profile) {
  const parts = [
    str(profile?.villageOrUnion ?? profile?.village),
    str(profile?.upazilaName),
    str(profile?.districtName),
  ].filter(Boolean);
  return parts.join(', ');
}

/** Full postal address including division when available. */
export function fullAddress(profile) {
  const parts = [addressLine(profile), str(profile?.divisionName)].filter(Boolean);
  return parts.join(', ');
}

/** Display name — falls back to a neutral placeholder, never another school. */
export function schoolDisplayName(profile) {
  return str(profile?.name) || str(profile?.schoolName) || 'বিদ্যালয়ের নাম নির্ধারণ করুন';
}

/** Two-character monogram used in the sidebar / document letterhead. */
export function deriveLogoText(profile) {
  const source = str(profile?.name) || str(profile?.nameEn);
  if (!source) return 'বিদ্যালয়'.slice(0, 1);
  return source.replace(/\s+/g, ' ').slice(0, 2);
}

export function schoolLogoText(profile) {
  return str(profile?.logoText) || deriveLogoText(profile);
}

/** "উপজেলা, জেলা" subtitle for the sidebar. */
export function locationSubtitle(profile) {
  const parts = [str(profile?.upazilaName), str(profile?.districtName)].filter(Boolean);
  return parts.join(', ');
}

export function academicYearOf(profile) {
  return str(profile?.academicYear) || str(profile?.session) || '—';
}

/** True once a teacher has supplied the minimum viable tenant identity. */
export function isProfileComplete(profile) {
  return Boolean(str(profile?.name));
}

/** Fields the School Profile form is allowed to write. */
export const SCHOOL_PROFILE_FIELDS = Object.freeze([
  'name',
  'schoolName',
  'nameEn',
  'divisionId',
  'divisionName',
  'division',
  'districtId',
  'districtName',
  'district',
  'upazilaId',
  'upazilaName',
  'upazila',
  'villageOrUnion',
  'postOffice',
  'emisCode',
  'establishedYear',
  'academicYear',
  'motto',
  'logoText',
  'phone',
  'email',
  'website',
  'headTeacher',
  'headTeacherDesignation',
]);

/** Picks only writable profile keys from a form state object. */
export function pickProfileFields(source) {
  const picked = {};
  if (source?.schoolName !== undefined && source?.name === undefined) picked.name = source.schoolName;
  SCHOOL_PROFILE_FIELDS.forEach((field) => {
    if (source && source[field] !== undefined) picked[field] = source[field];
  });
  return picked;
}

export default {
  EMPTY_SCHOOL_PROFILE,
  SCHOOL_PROFILE_FIELDS,
  normalizeSchoolProfile,
  addressLine,
  fullAddress,
  schoolDisplayName,
  schoolLogoText,
  deriveLogoText,
  locationSubtitle,
  academicYearOf,
  isProfileComplete,
  pickProfileFields,
};

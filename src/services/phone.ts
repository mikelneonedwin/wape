/**
 * Utilities for parsing, validating, normalizing, and formatting Nigerian phone numbers.
 */

/**
 * Normalizes a raw string to a standardized +234 international Nigerian mobile number format (e.g. "+2348012345678").
 * Returns null if the number is not a valid Nigerian phone number.
 */
export function normalizeNigerianPhoneNumber(raw: string): string | null {
  if (!raw) return null;

  // Strip all non-digit characters
  const digits = raw.replace(/\D/g, "");

  // International format: 234XXXXXXXXXX (13 digits)
  if (digits.startsWith("234") && digits.length === 13) {
    const localPart = digits.slice(3);
    // Nigerian mobile numbers usually start with 7, 8, or 9
    if (/^[789]\d{9}$/.test(localPart)) {
      return `+234${localPart}`;
    }
  }

  // National format: 0XXXXXXXXXX (11 digits)
  if (digits.startsWith("0") && digits.length === 11) {
    const localPart = digits.slice(1);
    if (/^[789]\d{9}$/.test(localPart)) {
      return `+234${localPart}`;
    }
  }

  // Missing leading zero format: XXXXXXXXXX (10 digits)
  if (digits.length === 10 && /^[789]\d{9}$/.test(digits)) {
    return `+234${digits}`;
  }

  return null;
}

/**
 * Formats a Nigerian phone number into "XXXX XXX XXXX" format (e.g. "0801 234 5678").
 */
export function formatPhoneNumber(phoneNumber: string): string {
  const normalized = normalizeNigerianPhoneNumber(phoneNumber);
  if (normalized && normalized.startsWith("+234") && normalized.length === 14) {
    const local = `0${normalized.slice(4)}`;
    return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
  }
  return phoneNumber;
}

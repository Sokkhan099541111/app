// Shared helper used by every page's "Export to Excel" button to embed a
// logo image via ExcelJS's workbook.addImage(). Prefers the logo uploaded
// on the Company Wialon Credentials settings page (the active company's
// company_logo, served from /uploads/logos/...); falls back to the bundled
// Mango Tracking asset when no company has an active, uploaded logo yet.
//
// The fallback matters more than it looks: until someone uploads a logo in
// Settings, EVERY export uses it -- so it has to be the real company mark,
// not a placeholder from whichever install the code came from.
import defaultLogo from "../assets/mango-tracking-logo.png";

let cachedLogoUrl: string | null | undefined; // undefined = not resolved yet

async function resolveLogoUrl(): Promise<string | null> {
  if (cachedLogoUrl !== undefined) return cachedLogoUrl;
  let resolved: string | null = null;
  try {
    const response = await fetch("/api/company-wialon-credentials/active-logo");
    if (response.ok) {
      const result = await response.json();
      resolved = result?.logo_url || null;
    }
  } catch {
    resolved = null;
  }
  cachedLogoUrl = resolved;
  return resolved;
}

/** Returns the active company's uploaded logo as an ArrayBuffer, ready to
 * pass to workbook.addImage({ buffer, extension: "png" }). Falls back to
 * the bundled Mango Tracking logo if no company logo is set. */
export async function getLogoBuffer(): Promise<ArrayBuffer> {
  const url = await resolveLogoUrl();
  try {
    const response = await fetch(url || defaultLogo);
    if (!response.ok) throw new Error("logo fetch failed");
    return await response.arrayBuffer();
  } catch {
    const fallback = await fetch(defaultLogo);
    return await fallback.arrayBuffer();
  }
}

/**
 * Loads ExcelJS on demand.
 *
 * ExcelJS is one of the largest dependencies in the app, but it is only
 * ever needed the moment someone clicks an "Export Excel" button. When it
 * was imported at the top of all 16 export pages, it was bundled into the
 * main JavaScript file, so every user downloaded it on first page load --
 * including users who never export anything.
 *
 * Using a dynamic import() here tells the bundler to split ExcelJS into a
 * separate file that is fetched only on the first export. The initial page
 * load gets correspondingly smaller.
 *
 * Usage inside an async export handler:
 *
 *     const ExcelJS = await loadExcelJS();
 *     const workbook = new ExcelJS.Workbook();
 */

// Cached so the module is only fetched and evaluated once per session,
// no matter how many times the user exports.
let cached: typeof import("exceljs") | null = null;

export async function loadExcelJS() {
  if (!cached) {
    const mod = await import("exceljs");
    // Depending on how the bundle is emitted, the library may arrive as a
    // default export or as the namespace itself -- accept both.
    cached = ((mod as any).default ?? mod) as typeof import("exceljs");
  }
  return cached;
}

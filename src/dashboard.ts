import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load the dashboard SPA HTML from the built dashboard directory.
 * Returns undefined if the file is not found (dashboard not built).
 */
export function loadDashboardHtml(): string | undefined {
  try {
    return readFileSync(resolve(import.meta.dirname, 'dashboard', 'index.html'), 'utf-8');
  } catch {
    console.error('[dashboard] dashboard/index.html not found — /dashboard route will return 404');
    return undefined;
  }
}

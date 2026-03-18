/**
 * Branch naming utilities for issue tracker integration.
 * Format: fix/<issue-id>-<slug>
 * Slug: lowercase, special chars → hyphens, max 50 chars total
 */

/**
 * Build a git branch name from an issue ID and title.
 * fix/<issue-id>-<slug>
 */
export function buildBranchName(issueId: string, title: string): string {
  const slug = slugify(title, 50);
  return `fix/${issueId}-${slug}`;
}

/**
 * Sanitize a string to be a valid git branch name component.
 * - Lowercase
 * - Special chars → hyphens
 * - Leading/trailing hyphens removed
 * - Consecutive hyphens collapsed
 * - Truncated to maxLength
 */
export function slugify(text: string, maxLength = 50): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, '')        // trim leading/trailing hyphens
    .replace(/-{2,}/g, '-')         // collapse consecutive hyphens
    .slice(0, maxLength)
    .replace(/-+$/, '');            // trim trailing hyphen after slice
}

/**
 * Check if a branch name is valid for use in git.
 */
export function isValidBranchName(name: string): boolean {
  // git branch name rules (simplified):
  // - No spaces, no ~, ^, :, ?, *, [, \, ..
  // - Cannot begin or end with /
  // - Cannot have consecutive /
  // - Cannot end with .lock
  if (!name) return false;
  if (/[\s~^:?*[\\]|\.\./.test(name)) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.endsWith('.lock')) return false;
  return true;
}

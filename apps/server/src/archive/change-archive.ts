/**
 * Change-archive path helpers shared by the archive package ingest pipeline.
 */

const ARCHIVE_PREFIX = ".harness/archive/";
const ARCHIVE_CHANGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;

/** Validate the portable key used to address a change archive. */
export function validateArchiveChangeKey(changeKey: string): string {
  if (!ARCHIVE_CHANGE_KEY_PATTERN.test(changeKey)) {
    throw new Error("ARCHIVE_CHANGE_KEY_INVALID");
  }
  return changeKey;
}

export function archiveRootPrefix(changeKey: string): string {
  return `${ARCHIVE_PREFIX}${changeKey}/`;
}

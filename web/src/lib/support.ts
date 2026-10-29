/**
 * The reference an investor reads to support (T-049, migration 0031): the first 8 hex characters of
 * their KYC subject id, which PT Control's `/support` lookup (admin.support_lookup) accepts. It
 * identifies the record to support staff only; it is not a secret and grants nothing.
 */
export function supportReference(subjectId: string): string {
  return subjectId.replace(/-/g, "").slice(0, 8).toLowerCase();
}

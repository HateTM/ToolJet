// SQL keywords that must not appear in a generated query. The tool schema and the prompt both
// ask for one SELECT, and nothing in this flow runs the statement to find out what it really
// is — a stored DELETE or DROP would sit in the app until a user pressed Run, and then it
// would be their data. ADR-0019 declines to validate what a statement *means*; this only
// checks what kind of statement it is, which is cheap and does not require running anything.
//
// `SELECT ... FOR UPDATE` is caught by this too. That is the intended reading: a query the
// AI wrote to feed a Table widget has no business taking row locks.
const WRITE_STATEMENT_KEYWORDS =
  /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge|call|do|copy|vacuum|comment)\b/i;

// Shared by the CreateQuery step (service.ts) and the UpdateQuery merge (query-update.ts):
// an UPDATE that only rewrites an option's SQL must pass the same read-only bar the CREATE
// path enforced, or a plan could walk a stored read-only query into a write one.
export const isSingleReadOnlyStatement = (sql: string): boolean => {
  const stripped = (sql || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '')
    .trim();

  if (!stripped) return false;
  // A second statement after the first is how a read turns into a write without the opening
  // keyword ever changing.
  if (stripped.includes(';')) return false;
  if (!/^(select|with)\b/i.test(stripped)) return false;
  return !WRITE_STATEMENT_KEYWORDS.test(stripped);
};

/**
 * Transaction export PII minimisation.
 *
 * A `TransactionExportJob` produces a file that leaves the database: it lands
 * in object storage behind a time-limited download URL and is emailed or
 * forwarded to whoever asked for it. Everything in that file is therefore
 * durable, copyable PII — the worst place to put an email address, a login IP,
 * or a free-text memo that somebody typed their mother's maiden name into.
 *
 * Minimisation here is **allowlist, not denylist**. A denylist of "fields we
 * know are PII" loses the moment someone adds a column; an allowlist of fields
 * we have decided to export cannot leak a field that was never considered. New
 * columns are excluded by default, and exporting one is a reviewed decision.
 */

/** Columns a transaction export may contain, in output order. */
export const EXPORT_COLUMNS = [
  'transactionId',
  'stellarHash',
  'assetCode',
  'assetIssuer',
  'amount',
  'status',
  'senderWalletId',
  'receiverWalletId',
  'createdAt',
  'confirmedAt',
] as const;

export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

/**
 * Columns deliberately excluded from every export, kept as documentation of a
 * decision rather than as a runtime filter.
 *
 * - `email`, `displayName`, `authId`, `lastLoginIp`, `lastLoginUserAgent`:
 *   direct identifiers on `User`; not needed for reconciliation.
 * - `requestedBy`: the requesting API key id — an audit field that belongs in
 *   the job row, not in a file that gets forwarded.
 * - `memo`: free text supplied by an end user. It is the most likely place for
 *   accidental PII and has no reconciliation use.
 * - `metadata`: an open JSON column, i.e. unbounded and unreviewed.
 * - `statusReason`: can carry a raw upstream error string.
 */
export const NEVER_EXPORTED_COLUMNS: readonly string[] = [
  'email',
  'displayName',
  'authId',
  'lastLoginIp',
  'lastLoginUserAgent',
  'requestedBy',
  'memo',
  'metadata',
  'statusReason',
];

/** Formats an export may be rendered in. */
export const ExportFormat = {
  CSV: 'CSV',
  JSON: 'JSON',
} as const;

export type ExportFormat = (typeof ExportFormat)[keyof typeof ExportFormat];

/**
 * Stable codes for export minimisation failures. Clients branch on the code,
 * not the message. Add new codes; never repurpose one.
 */
export const ExportMinimisationErrorCode = {
  /** The requested format is not one this service renders. */
  UNSUPPORTED_FORMAT: 'EXPORT_UNSUPPORTED_FORMAT',
  /** A source row is missing a column the allowlist requires. */
  ROW_MISSING_REQUIRED_FIELD: 'EXPORT_ROW_MISSING_REQUIRED_FIELD',
  /** A value is the wrong shape, e.g. an object where a scalar is due. */
  ROW_INVALID_FIELD: 'EXPORT_ROW_INVALID_FIELD',
  /** The export exceeds the maximum row count. */
  TOO_LARGE: 'EXPORT_TOO_LARGE',
} as const;

export type ExportMinimisationErrorCode =
  (typeof ExportMinimisationErrorCode)[keyof typeof ExportMinimisationErrorCode];

/** A failure with a stable code and a message that echoes no row content. */
export class ExportMinimisationError extends Error {
  readonly code: ExportMinimisationErrorCode;

  constructor(code: ExportMinimisationErrorCode, message: string) {
    super(message);
    this.name = 'ExportMinimisationError';
    this.code = code;
  }
}

/** A source transaction row, as read from the store. */
export type ExportRow = Record<string, unknown>;

/** One minimised row: exactly the allowlisted columns, in a fixed order. */
export type MinimisedRow = Record<ExportColumn, string>;

/** Upper bound on rows rendered in one pass, to bound memory and file size. */
export const MAX_EXPORT_ROWS = 10_000;

/**
 * Projects one source row onto {@link EXPORT_COLUMNS}.
 *
 * Invariants:
 *
 * 1. **Allowlist only.** A key that is not in the allowlist is dropped
 *    silently, so a new column in the schema cannot leak into an export by
 *    default.
 * 2. **No truncation of identity, no redaction of amounts.** A minimised row
 *    is a faithful record of the allowlisted columns; a caller reconciling
 *    against the ledger must be able to match every row.
 * 3. **Every value is a string.** CSV and JSON consumers then agree on the
 *    type, and a `null` cannot be rendered as the literal text "null". Missing
 *    optional values become the empty string.
 * 4. **A missing `transactionId` is an error, not an empty cell.** An empty id
 *    would produce a row nobody can reconcile, so the export fails loudly
 *    instead of shipping a file with holes in it.
 *
 * @throws ExportMinimisationError with a stable code. The message never
 *   includes the offending value, which may itself be PII.
 */
export function minimiseExportRow(row: ExportRow): MinimisedRow {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new ExportMinimisationError(
      ExportMinimisationErrorCode.ROW_INVALID_FIELD,
      'Export row must be an object',
    );
  }

  const output = {} as MinimisedRow;

  for (const column of EXPORT_COLUMNS) {
    const value = row[column];

    if (value === undefined || value === null) {
      if (column === 'transactionId') {
        throw new ExportMinimisationError(
          ExportMinimisationErrorCode.ROW_MISSING_REQUIRED_FIELD,
          'Export row is missing transactionId',
        );
      }
      output[column] = '';
      continue;
    }

    // A nested object is the shape an open JSON column takes; a symbol has no
    // meaningful rendering. Stringifying either would defeat the allowlist by
    // smuggling arbitrary content through a string, so both are refused.
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new ExportMinimisationError(
        ExportMinimisationErrorCode.ROW_INVALID_FIELD,
        `Export row field ${column} must be a scalar`,
      );
    }

    output[column] = String(value);
  }

  return output;
}

/**
 * Escapes a value for CSV, including the formula-injection guard.
 *
 * A leading `=`, `+`, `-`, or `@` makes a spreadsheet evaluate the cell. An
 * export is exactly the artefact most likely to be opened in Excel, so a value
 * beginning with `=` must not become a formula. Prefixing with a single quote
 * is the standard, reversible mitigation.
 */
export function escapeCsvValue(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * Renders minimised rows in the requested format.
 *
 * @throws ExportMinimisationError when the format is unsupported, or when more
 *   than {@link MAX_EXPORT_ROWS} rows are supplied. The row bound is a
 *   fail-closed guard: the filter range is client-chosen, so an unbounded
 *   export is a memory-exhaustion vector on the job worker.
 */
export function renderExport(
  rows: MinimisedRow[],
  format: ExportFormat,
): string {
  if (format !== ExportFormat.CSV && format !== ExportFormat.JSON) {
    throw new ExportMinimisationError(
      ExportMinimisationErrorCode.UNSUPPORTED_FORMAT,
      'Unsupported export format',
    );
  }

  if (rows.length > MAX_EXPORT_ROWS) {
    throw new ExportMinimisationError(
      ExportMinimisationErrorCode.TOO_LARGE,
      'Export exceeds the maximum row count',
    );
  }

  if (format === ExportFormat.JSON) {
    return JSON.stringify(rows);
  }

  const lines = [EXPORT_COLUMNS.map(escapeCsvValue).join(',')];
  for (const row of rows) {
    lines.push(EXPORT_COLUMNS.map((c) => escapeCsvValue(row[c])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

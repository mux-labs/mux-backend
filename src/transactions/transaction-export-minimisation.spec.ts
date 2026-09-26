import {
  escapeCsvValue,
  ExportFormat,
  ExportMinimisationError,
  ExportMinimisationErrorCode,
  EXPORT_COLUMNS,
  MAX_EXPORT_ROWS,
  minimiseExportRow,
  NEVER_EXPORTED_COLUMNS,
  renderExport,
} from './transaction-export-minimisation';
import type { MinimisedRow } from './transaction-export-minimisation';

/** A row carrying every PII-bearing column the schema actually has. */
function fullRow() {
  return {
    transactionId: 'tx-1',
    stellarHash: 'abc123',
    assetCode: 'USDC',
    assetIssuer: 'GIssuerIssuerIssuerIssuerIssuerIssuerIssuerIssuer',
    amount: '12.5000000',
    status: 'CONFIRMED',
    senderWalletId: 'wallet-1',
    receiverWalletId: 'wallet-2',
    createdAt: '2026-03-04T00:00:00.000Z',
    confirmedAt: '2026-03-04T00:00:05.000Z',
    // Everything below must be dropped:
    memo: 'ssn 123-45-6789',
    metadata: { ip: '203.0.113.7', kyc: { name: 'Jane Doe' } },
    statusReason: 'upstream said: user Jane Doe <jane@example.com> failed',
    requestedBy: 'api-key-secret-id',
    email: 'jane@example.com',
    displayName: 'Jane Doe',
    authId: 'google-oauth-1234',
    lastLoginIp: '203.0.113.7',
    lastLoginUserAgent: 'Mozilla/5.0 (private)',
  };
}

/** Asserts `run` throws with the given stable code. */
function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ExportMinimisationError);
    expect((err as ExportMinimisationError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with ${code}`);
}

describe('minimiseExportRow', () => {
  it('emits exactly the allowlisted columns', () => {
    const row = minimiseExportRow(fullRow());
    expect(Object.keys(row).sort()).toEqual([...EXPORT_COLUMNS].sort());
  });

  it('drops every PII-bearing column', () => {
    const row = minimiseExportRow(fullRow());
    for (const column of NEVER_EXPORTED_COLUMNS) {
      expect(row).not.toHaveProperty(column);
    }
  });

  it('never leaks PII anywhere in the serialised output', () => {
    const rendered = JSON.stringify(minimiseExportRow(fullRow()));
    for (const secret of [
      '123-45-6789',
      'jane@example.com',
      'Jane Doe',
      '203.0.113.7',
      'google-oauth-1234',
      'Mozilla/5.0',
      'api-key-secret-id',
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it('is allowlist-shaped, so an unknown new column cannot leak', () => {
    const row = minimiseExportRow({
      ...fullRow(),
      brandNewColumnHoldingPii: 'surprise',
    });
    expect(JSON.stringify(row)).not.toContain('surprise');
  });

  it('preserves the reconciliation fields verbatim', () => {
    const row = minimiseExportRow(fullRow());
    expect(row.transactionId).toBe('tx-1');
    expect(row.stellarHash).toBe('abc123');
    expect(row.amount).toBe('12.5000000');
    expect(row.assetIssuer).toBe(fullRow().assetIssuer);
  });

  it('renders every value as a string so CSV and JSON agree', () => {
    const row = minimiseExportRow({ ...fullRow(), amount: 12.5 });
    for (const column of EXPORT_COLUMNS) {
      expect(typeof row[column]).toBe('string');
    }
  });

  it('renders a missing optional value as empty, not "null"', () => {
    const row = minimiseExportRow({ transactionId: 'tx-1' });
    expect(row.stellarHash).toBe('');
    expect(row.confirmedAt).toBe('');
    expect(JSON.stringify(row)).not.toContain('null');
  });

  it('refuses a row with no transactionId instead of emitting a blank id', () => {
    expectCode(
      () => minimiseExportRow({ amount: '1' }),
      ExportMinimisationErrorCode.ROW_MISSING_REQUIRED_FIELD,
    );
  });

  it('refuses a nested object rather than stringifying it into the cell', () => {
    expectCode(
      () =>
        minimiseExportRow({
          ...fullRow(),
          amount: { value: '1' },
        }),
      ExportMinimisationErrorCode.ROW_INVALID_FIELD,
    );
  });

  it.each([[null], [undefined], [[]], ['nope'], [42]])(
    'refuses the non-object row %p',
    (row) =>
      expectCode(
        () => minimiseExportRow(row as Record<string, unknown>),
        ExportMinimisationErrorCode.ROW_INVALID_FIELD,
      ),
  );

  it('does not echo the offending value in the error', () => {
    try {
      minimiseExportRow({ ...fullRow(), amount: { ssn: '123-45-6789' } });
    } catch (err) {
      expect((err as Error).message).not.toContain('123-45-6789');
    }
  });
});

describe('escapeCsvValue', () => {
  it.each([
    ['=cmd|calc', "'=cmd|calc"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@SUM(A1)', "'@SUM(A1)"],
  ])('neutralises the formula prefix in %p', (input, expected) => {
    expect(escapeCsvValue(input)).toBe(`"${expected}"`);
  });

  it('doubles embedded quotes', () => {
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
  });

  it('leaves an ordinary value untouched apart from quoting', () => {
    expect(escapeCsvValue('12.5000000')).toBe('"12.5000000"');
  });
});

describe('renderExport', () => {
  const row: MinimisedRow = minimiseExportRow(fullRow());

  it('renders a header plus one line per row in CSV', () => {
    const csv = renderExport([row], ExportFormat.CSV);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(EXPORT_COLUMNS.map(escapeCsvValue).join(','));
    expect(lines[1]).toContain('"tx-1"');
  });

  it('renders JSON with the same minimised fields', () => {
    const parsed: unknown = JSON.parse(renderExport([row], ExportFormat.JSON));
    expect(parsed).toEqual([row]);
    expect(JSON.stringify(parsed)).not.toContain('jane@example.com');
  });

  it('refuses an unsupported format', () => {
    expectCode(
      () => renderExport([row], 'XLSX' as ExportFormat),
      ExportMinimisationErrorCode.UNSUPPORTED_FORMAT,
    );
  });

  it('refuses an export larger than the documented row bound', () => {
    const many: MinimisedRow[] = Array.from(
      { length: MAX_EXPORT_ROWS + 1 },
      () => row,
    );
    expectCode(
      () => renderExport(many, ExportFormat.CSV),
      ExportMinimisationErrorCode.TOO_LARGE,
    );
  });
});

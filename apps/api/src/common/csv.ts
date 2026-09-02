import type { Response } from 'express';

/**
 * CSV export, in one place.
 *
 * Two details matter and are easy to get wrong. A field containing a comma, a
 * quote or a newline must be quoted with its quotes doubled — the naive
 * `values.join(',')` silently corrupts every row with an address or a rejection
 * note in it. And a field beginning with `=`, `+`, `-` or `@` is executed as a
 * formula when the file is opened in a spreadsheet, so it is prefixed with an
 * apostrophe: an export of user-supplied text is otherwise an injection vector
 * into whoever opens it.
 */

const NEEDS_QUOTING = /[",\n\r]/;
const FORMULA_START = /^[=+\-@\t\r]/;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export function toCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

  // Neutralise a leading character a spreadsheet would treat as a formula.
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return NEEDS_QUOTING.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((column) => toCsvField(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => toCsvField(column.value(row))).join(','));
  }
  // A trailing newline: some tools drop the last row without one.
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Sends a CSV as a download. The BOM is what makes Excel read UTF-8 rather than
 * mangling every name with an accent in it.
 */
export function sendCsv(response: Response, filename: string, body: string): void {
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}"`);
  response.send(`﻿${body}`);
}

/** Keeps a caller-supplied name from breaking out of the header. */
function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || 'export.csv';
}

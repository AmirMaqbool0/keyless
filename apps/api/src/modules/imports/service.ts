import type { Types } from 'mongoose';
import {
  IMPORT_FIELDS,
  IMPORT_TYPE_LABELS,
  suggestMapping,
  type ImportJobDto,
  type ImportMapping,
  type ImportRowError,
  type ImportType,
} from '@keyless/shared';
import { badRequest } from '../../lib/http';
import type { Storage } from '../../lib/storage';
import { storageKey } from '../../lib/storage';
import { ImportJob, type IImportJob, type ImportJobDoc } from '../../models/ImportJob';
import { createImporter, type RowValues } from './importers';
import { coerce, decodeCsv, parseCsv } from './parse';

export const MAX_IMPORT_ROWS = 100_000;
const MAX_STORED_ERRORS = 200;
const SAMPLE_ROWS = 10;

export async function createImportJob(input: {
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  type: ImportType;
  filename: string;
  buffer: Buffer;
  storage: Storage;
}): Promise<ImportJobDoc> {
  const { text, encoding } = decodeCsv(input.buffer);
  let parsed;
  try {
    parsed = parseCsv(text);
  } catch (err) {
    throw badRequest(
      err instanceof Error ? err.message : 'Could not read the CSV file',
      'INVALID_FILE',
    );
  }
  if (!parsed.rows.length) throw badRequest('The file has a header row but no data', 'EMPTY_FILE');
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    throw badRequest(
      `Files can have up to ${MAX_IMPORT_ROWS.toLocaleString()} rows; split it into smaller files`,
      'TOO_MANY_ROWS',
    );
  }

  const key = storageKey(input.orgId.toString(), 'imports', input.filename);
  await input.storage.put(key, input.buffer, 'text/csv');
  return ImportJob.create({
    orgId: input.orgId,
    type: input.type,
    filename: input.filename,
    storageKey: key,
    encoding,
    columns: parsed.columns,
    sampleRows: parsed.rows.slice(0, SAMPLE_ROWS),
    mapping: suggestMapping(input.type, parsed.columns),
    totals: { rows: parsed.rows.length, valid: 0, created: 0, updated: 0, skipped: 0, errors: 0 },
    createdBy: input.userId,
  });
}

/** Reject mappings that point at unknown fields/columns or leave required fields unmapped. */
export function checkMapping(
  type: ImportType,
  columns: string[],
  mapping: ImportMapping,
): ImportMapping {
  const fields = IMPORT_FIELDS[type];
  const clean: ImportMapping = {};
  for (const field of fields) {
    const column = mapping[field.key] ?? null;
    if (column !== null && !columns.includes(column)) {
      throw badRequest(`Column "${column}" is not in the file`, 'INVALID_MAPPING');
    }
    if (field.required && !column) {
      throw badRequest(`Choose a column for "${field.label}"`, 'INVALID_MAPPING');
    }
    clean[field.key] = column;
  }
  return clean;
}

/**
 * Validate every row and (when `commit`) upsert the valid ones. Rows with errors are skipped and
 * reported with their spreadsheet row number (header = row 1).
 */
export async function runImport(
  job: ImportJobDoc,
  opts: { commit: boolean; storage: Storage; currency: string },
): Promise<ImportJobDoc> {
  const fields = IMPORT_FIELDS[job.type];
  const { text } = decodeCsv(await opts.storage.get(job.storageKey));
  const { rows } = parseCsv(text);
  const importer = createImporter(job.type, { currency: opts.currency });
  await importer.prepare(job.orgId);

  const records: unknown[] = [];
  const errors: ImportRowError[] = [];
  let errorCount = 0;
  let invalidRows = 0;

  rows.forEach((row, i) => {
    const rowNo = i + 2;
    const values: RowValues = {};
    const rowErrors: Omit<ImportRowError, 'row'>[] = [];
    for (const field of fields) {
      const column = job.mapping[field.key];
      const result = coerce(field.type, column ? row[column] : undefined);
      if (!result.ok)
        rowErrors.push({ field: field.key, message: `${field.label}: ${result.message}` });
      else if (field.required && result.value === undefined)
        rowErrors.push({ field: field.key, message: `${field.label} is required` });
      else values[field.key] = result.value;
    }
    const outcome = rowErrors.length ? { errors: rowErrors } : importer.toRecord(values);
    if ('record' in outcome) {
      records.push(outcome.record);
    } else {
      invalidRows += 1;
      errorCount += outcome.errors.length;
      for (const e of outcome.errors)
        if (errors.length < MAX_STORED_ERRORS) errors.push({ row: rowNo, ...e });
    }
  });

  job.rowErrors = errors;
  job.totals = {
    rows: rows.length,
    valid: records.length,
    created: 0,
    updated: 0,
    skipped: invalidRows,
    errors: errorCount,
  };
  if (opts.commit) {
    try {
      const counts = await importer.commit(job.orgId, records);
      job.totals = { ...job.totals, created: counts.created, updated: counts.updated };
      job.status = 'completed';
      job.completedAt = new Date();
    } catch (err) {
      job.status = 'failed';
      job.failureMessage = err instanceof Error ? err.message : String(err);
    }
  } else {
    job.status = 'validated';
  }
  job.markModified('totals');
  await job.save();
  return job;
}

export function toImportJobDto(job: IImportJob): ImportJobDto {
  return {
    id: job._id.toString(),
    type: job.type,
    filename: job.filename,
    status: job.status,
    columns: job.columns,
    sampleRows: job.sampleRows,
    mapping: job.mapping,
    totals: job.totals,
    errors: job.rowErrors,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    createdBy: job.createdBy?.toString() ?? null,
  };
}

/** A CSV with just the header row, using labels the auto-mapper recognises. */
export function templateCsv(type: ImportType): { filename: string; body: string } {
  const header = IMPORT_FIELDS[type].map((f) => `"${f.label.replace(/"/g, '""')}"`).join(',');
  return { filename: `keyless-${type}-template.csv`, body: `${header}\r\n` };
}

export const importTypeLabel = (t: ImportType) => IMPORT_TYPE_LABELS[t];

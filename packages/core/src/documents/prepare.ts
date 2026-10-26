import { createRequire } from 'node:module';
import path from 'node:path';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import sharp from 'sharp';
import type { AttachmentKind } from '../models/Attachment';

/**
 * Turns an order document into what the extractor needs:
 *  - PDFs with a real text layer -> layout-preserving text (cheap, exact characters)
 *  - scanned PDFs (little or no text) -> the PDF itself, for the LLM's vision
 *  - images -> normalised JPEG/PNG for vision
 *  - spreadsheets/CSV -> a pipe-separated text table per sheet
 */

export type PreparedDocument = {
  label: string;
  mode: 'text' | 'pdf' | 'image' | 'table';
  /** Text for the LLM (and the offline extractor). Null when only vision can read it. */
  text: string | null;
  pdf?: Buffer;
  image?: { mediaType: 'image/jpeg' | 'image/png'; data: Buffer };
  pageCount: number;
  /** Why a document could not be prepared, when it couldn't. */
  unsupported?: string;
};

/** Below this many characters per page we treat a PDF as scanned. */
const MIN_TEXT_CHARS_PER_PAGE = 80;
const MAX_IMAGE_EDGE = 2000;
const MAX_TABLE_ROWS = 2000;

type TextItem = { str: string; x: number; y: number; width: number; height: number };

/** Rebuild visual lines from positioned text items, keeping column gaps visible. */
function layoutLines(items: TextItem[]): string[] {
  const rows: { y: number; items: TextItem[] }[] = [];
  for (const item of items.filter((i) => i.str.trim())) {
    const tolerance = Math.max(2, item.height * 0.4);
    const row = rows.find((r) => Math.abs(r.y - item.y) <= tolerance);
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  rows.sort((a, b) => b.y - a.y); // PDF y grows upwards
  return rows.map((row) => {
    const sorted = row.items.sort((a, b) => a.x - b.x);
    let line = '';
    let end = -Infinity;
    for (const it of sorted) {
      // A gap wider than a word space means a new column: mark it so tables survive as text.
      // (Word spaces are ~0.25em; text that runs right up to the next column leaves ~0.5em.)
      const gap = it.x - end;
      if (line) line += gap > Math.max(3.5, it.height * 0.4) ? '  |  ' : gap > 1 ? ' ' : '';
      line += it.str.trim();
      end = it.x + it.width;
    }
    return line;
  });
}

export async function pdfText(data: Buffer): Promise<{ text: string; pageCount: number }> {
  // The legacy build runs in Node without a DOM. Imported lazily: it is large.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    standardFontDataUrl: standardFontsDir(),
  });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items: TextItem[] = [];
    for (const raw of content.items) {
      if (!('str' in raw)) continue;
      items.push({
        str: raw.str,
        x: raw.transform[4] as number,
        y: raw.transform[5] as number,
        width: raw.width,
        height: raw.height || Math.abs(raw.transform[3] as number),
      });
    }
    pages.push(`--- Page ${p} ---\n${layoutLines(items).join('\n')}`);
  }
  const pageCount = doc.numPages;
  await task.destroy();
  return { text: pages.join('\n\n'), pageCount };
}

/** pdf.js needs its bundled standard-font metrics to measure text in Node. */
let fontsDir: string | undefined;
function standardFontsDir(): string {
  // pdf.js insists on forward slashes and a trailing "/", even on Windows.
  const dir = path.join(
    path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    'standard_fonts',
  );
  fontsDir ??= `${dir.replace(/\\/g, '/')}/`;
  return fontsDir;
}

function tableText(sheets: { name: string; rows: unknown[][] }[]): string {
  return sheets
    .map((s) => {
      const rows = s.rows
        .slice(0, MAX_TABLE_ROWS)
        .map((r) =>
          r.map((c) =>
            c === null || c === undefined ? '' : String(c).replace(/\s+/g, ' ').trim(),
          ),
        )
        .filter((r) => r.some(Boolean))
        .map((r) => r.join(' | '));
      return `--- Sheet: ${s.name} ---\n${rows.join('\n')}`;
    })
    .join('\n\n');
}

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return v.result ?? ''; // formula
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text; // hyperlink
    return '';
  }
  return v;
}

export async function spreadsheetText(data: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const sheets = wb.worksheets.map((ws) => {
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as ExcelJS.CellValue[]; // 1-based
      rows.push(values.slice(1).map(cellValue));
    });
    return { name: ws.name, rows };
  });
  return tableText(sheets);
}

/** First non-empty worksheet as CSV (for the catalogue/customer import flow). */
export async function xlsxToCsv(data: Buffer): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
  if (!ws) throw new Error('The workbook has no data');
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) =>
    rows.push((row.values as ExcelJS.CellValue[]).slice(1).map(cellValue)),
  );
  const width = Math.max(...rows.map((r) => r.length));
  return Buffer.from(
    Papa.unparse(
      rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')),
      { newline: '\r\n' },
    ),
  );
}

export function csvText(data: Buffer): string {
  const text = stripBom(data.toString('utf8'));
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
  return tableText([{ name: 'CSV', rows: parsed.data }]);
}

export async function normaliseImage(
  data: Buffer,
): Promise<{ mediaType: 'image/jpeg' | 'image/png'; data: Buffer }> {
  // Rotate per EXIF (phone photos), cap the size, and convert HEIC/TIFF/WebP to JPEG.
  const out = await sharp(data, { failOn: 'none' })
    .rotate()
    .resize({
      width: MAX_IMAGE_EDGE,
      height: MAX_IMAGE_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { mediaType: 'image/jpeg', data: out };
}

export async function prepareAttachment(file: {
  filename: string;
  kind: AttachmentKind;
  content: Buffer;
}): Promise<PreparedDocument> {
  const label = file.filename;
  try {
    switch (file.kind) {
      case 'pdf': {
        const { text, pageCount } = await pdfText(file.content);
        const chars = text.replace(/--- Page \d+ ---|\s/g, '').length;
        if (chars / Math.max(pageCount, 1) >= MIN_TEXT_CHARS_PER_PAGE)
          return { label, mode: 'text', text, pageCount };
        return { label, mode: 'pdf', text: null, pdf: file.content, pageCount };
      }
      case 'image':
        return {
          label,
          mode: 'image',
          text: null,
          image: await normaliseImage(file.content),
          pageCount: 1,
        };
      case 'spreadsheet':
        return { label, mode: 'table', text: await spreadsheetText(file.content), pageCount: 1 };
      case 'csv':
        return { label, mode: 'table', text: csvText(file.content), pageCount: 1 };
      default:
        return {
          label,
          mode: 'text',
          text: null,
          pageCount: 0,
          unsupported: `${file.kind} files are not read yet`,
        };
    }
  } catch (err) {
    return {
      label,
      mode: 'text',
      text: null,
      pageCount: 0,
      unsupported: `Could not read ${label}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** The order-relevant part of an email body: drops quoted replies and signatures' tail. */
export function prepareBody(subject: string, text: string): PreparedDocument {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex((l) =>
    /^(>|On .+wrote:$|-{2,}\s*Original Message|From: .+@)/i.test(l.trim()),
  );
  // A forwarded email keeps its content: the order is usually below the forward marker.
  const forwarded = /forwarded message/i.test(text);
  const kept = forwarded || cut <= 0 ? lines : lines.slice(0, cut);
  return {
    label: 'Email body',
    mode: 'text',
    text: `Subject: ${subject}\n\n${kept.join('\n').trim()}`,
    pageCount: 1,
  };
}

/** Drop a leading UTF-8 byte-order mark (Excel's "CSV UTF-8" adds one). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

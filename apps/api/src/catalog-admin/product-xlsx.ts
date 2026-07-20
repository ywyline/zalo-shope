import { inflateRawSync } from 'node:zlib';

import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile, { type Cell, type SheetData } from 'write-excel-file/node';

import {
  PRODUCT_IMPORT_COLUMNS,
  PRODUCT_IMPORT_MAX_BYTES,
  PRODUCT_IMPORT_MAX_ROWS,
  ProductImportFileError,
  parseProductImportRecords,
  type ParsedProductImportRow,
  type ProductImportRecord,
} from './product-import';

const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_MAX_ENTRIES = 128;
const ZIP_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const ZIP_MAX_COMPRESSION_RATIO = 100;
const PRODUCT_IMPORT_MAX_CELL_CHARACTERS = 32_000;

export const PRODUCT_EXPORT_MAX_ROWS = 10_000;
export const PRODUCT_EXPORT_MAX_BYTES = 16 * 1024 * 1024;

export const PRODUCT_EXPORT_COLUMNS = [
  'product_code',
  'product_status',
  'product_enabled',
  'brand_code',
  'main_category_code',
  'secondary_category_codes',
  'name_vi',
  'selling_points_vi',
  'description_vi',
  'name_zh',
  'selling_points_zh',
  'description_zh',
  'name_en',
  'selling_points_en',
  'description_en',
  'sku_code',
  'sku_status',
  'barcode',
  'sale_price_vnd',
  'market_price_vnd',
  'weight_grams',
  'sku_options',
  'updated_at',
] as const;

export type ProductExportColumn = (typeof PRODUCT_EXPORT_COLUMNS)[number];
export type ProductExportRow = Record<ProductExportColumn, boolean | number | string | null>;

type ZipEntry = {
  compressedSize: number;
  compressionMethod: number;
  flags: number;
  localOffset: number;
  name: string;
  uncompressedSize: number;
};

function workbookError(
  code: ProductImportFileError['code'],
  message: string,
): ProductImportFileError {
  return new ProductImportFileError(code, message);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.byteLength - 65_557);
  for (let offset = buffer.byteLength - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_SIGNATURE) return offset;
  }
  throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP end record is missing');
}

function decodeZipName(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP entry name is not valid UTF-8');
  }
}

function validateZipPath(name: string): void {
  const segments = name.split('/');
  if (
    name.length === 0 ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    segments.some(
      (segment, index) =>
        segment === '.' || segment === '..' || (segment === '' && index !== segments.length - 1),
    )
  ) {
    throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP contains an unsafe entry path');
  }
}

function inspectZipEntries(buffer: Buffer, maxBytes: number): Map<string, ZipEntry> {
  if (buffer.byteLength === 0) {
    throw workbookError('FILE_EMPTY', 'XLSX file is empty');
  }
  if (buffer.byteLength > maxBytes) {
    throw workbookError('FILE_TOO_LARGE', 'XLSX file exceeds the size limit');
  }
  if (buffer.byteLength < 22 || buffer.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
    throw workbookError('WORKBOOK_INVALID', 'File is not an XLSX ZIP workbook');
  }

  const endOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    endOffset + 22 + commentLength !== buffer.byteLength
  ) {
    throw workbookError('WORKBOOK_INVALID', 'Split or ZIP64 XLSX workbooks are not supported');
  }
  if (entryCount === 0 || entryCount > ZIP_MAX_ENTRIES) {
    throw workbookError('ZIP_LIMIT_EXCEEDED', 'XLSX ZIP entry limit exceeded');
  }
  if (centralOffset + centralSize !== endOffset) {
    throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP central directory is inconsistent');
  }

  const entries = new Map<string, ZipEntry>();
  let totalUncompressed = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
      throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP central entry is invalid');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const startDisk = buffer.readUInt16LE(offset + 34);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (entryEnd > endOffset) {
      throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP central entry is truncated');
    }
    const name = decodeZipName(buffer.subarray(offset + 46, offset + 46 + nameLength));
    validateZipPath(name);
    if (
      (flags & (0x1 | 0x40 | 0x2000)) !== 0 ||
      startDisk !== 0 ||
      localOffset === 0xffffffff ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      ![0, 8].includes(compressionMethod)
    ) {
      throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP uses an unsupported entry format');
    }
    if (entries.has(name)) {
      throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP contains duplicate entry paths');
    }
    if (uncompressedSize > ZIP_MAX_ENTRY_BYTES) {
      throw workbookError('ZIP_LIMIT_EXCEEDED', 'XLSX ZIP entry is too large');
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > ZIP_MAX_TOTAL_BYTES) {
      throw workbookError('ZIP_LIMIT_EXCEEDED', 'XLSX ZIP expanded size limit exceeded');
    }
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 || uncompressedSize / compressedSize > ZIP_MAX_COMPRESSION_RATIO)
    ) {
      throw workbookError('ZIP_LIMIT_EXCEEDED', 'XLSX ZIP compression ratio limit exceeded');
    }
    entries.set(name, {
      compressedSize,
      compressionMethod,
      flags,
      localOffset,
      name,
      uncompressedSize,
    });
    offset = entryEnd;
  }
  if (offset !== endOffset) {
    throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP central directory has trailing data');
  }
  return entries;
}

function extractZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.byteLength || buffer.readUInt32LE(offset) !== ZIP_LOCAL_SIGNATURE) {
    throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP local entry is invalid');
  }
  const flags = buffer.readUInt16LE(offset + 6);
  const method = buffer.readUInt16LE(offset + 8);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.byteLength || flags !== entry.flags || method !== entry.compressionMethod) {
    throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP local entry metadata is inconsistent');
  }
  const localName = decodeZipName(buffer.subarray(offset + 30, offset + 30 + nameLength));
  if (localName !== entry.name) {
    throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP local entry path is inconsistent');
  }
  const compressed = buffer.subarray(dataStart, dataEnd);
  let output: Buffer;
  try {
    output =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: ZIP_MAX_ENTRY_BYTES });
  } catch {
    throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP entry cannot be expanded safely');
  }
  if (output.byteLength !== entry.uncompressedSize) {
    throw workbookError('WORKBOOK_INVALID', 'XLSX ZIP entry size is inconsistent');
  }
  return output;
}

function decodeXml(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw workbookError('WORKBOOK_INVALID', 'XLSX XML is not valid UTF-8');
  }
}

export function preflightProductImportXlsx(
  buffer: Buffer,
  sheetName = 'products',
  maxBytes = PRODUCT_IMPORT_MAX_BYTES,
): void {
  const entries = inspectZipEntries(buffer, maxBytes);
  for (const required of ['[Content_Types].xml', 'xl/workbook.xml']) {
    if (!entries.has(required)) {
      throw workbookError('WORKBOOK_INVALID', 'XLSX is missing a required workbook entry');
    }
  }
  if (
    [...entries.keys()].some((name) => {
      const normalized = name.toLowerCase();
      return (
        normalized.includes('vbaproject') ||
        normalized.startsWith('xl/activex/') ||
        normalized.startsWith('xl/charts/') ||
        normalized.startsWith('xl/drawings/') ||
        normalized.startsWith('xl/embeddings/') ||
        normalized.startsWith('xl/externallinks/') ||
        normalized.startsWith('xl/media/')
      );
    })
  ) {
    throw workbookError('WORKBOOK_INVALID', 'Macros and external workbook links are not allowed');
  }

  const contentTypes = decodeXml(extractZipEntry(buffer, entries.get('[Content_Types].xml')!));
  if (/macroEnabled|vbaProject/i.test(contentTypes)) {
    throw workbookError('WORKBOOK_INVALID', 'Macro-enabled workbooks are not allowed');
  }
  const workbook = decodeXml(extractZipEntry(buffer, entries.get('xl/workbook.xml')!));
  const sheetTags = workbook.match(/<(?:\w+:)?sheet\b[^>]*>/gi) ?? [];
  if (sheetTags.length !== 1) {
    throw workbookError('WORKSHEET_INVALID', 'XLSX must contain exactly one worksheet');
  }
  const sheetTag = sheetTags[0];
  const escapedSheetName = sheetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    !new RegExp(`\\bname=(['"])${escapedSheetName}\\1`, 'i').test(sheetTag) ||
    /\bstate=(['"])(?!visible\1)[^'"]+\1/i.test(sheetTag)
  ) {
    throw workbookError(
      'WORKSHEET_INVALID',
      `The only visible worksheet must be named ${sheetName}`,
    );
  }

  for (const [name, entry] of entries) {
    if (!name.endsWith('.rels') && !name.endsWith('.xml')) continue;
    const xml = decodeXml(extractZipEntry(buffer, entry));
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
      throw workbookError('WORKBOOK_INVALID', 'DTD and XML entity declarations are not allowed');
    }
    if (/TargetMode\s*=\s*(['"])External\1/i.test(xml)) {
      throw workbookError('WORKBOOK_INVALID', 'External workbook relationships are not allowed');
    }
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name) && /<(?:\w+:)?f(?:\s|>)/i.test(xml)) {
      throw workbookError('FORMULA_NOT_ALLOWED', 'Formula cells are not allowed');
    }
    if (
      /^xl\/worksheets\/[^/]+\.xml$/i.test(name) &&
      /<(?:\w+:)?c\b[^>]*\bt=(['"])e\1/i.test(xml)
    ) {
      throw workbookError('CELL_INVALID', 'Spreadsheet error cells are not allowed');
    }
  }
}

function xlsxCellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    if (value.length > PRODUCT_IMPORT_MAX_CELL_CHARACTERS || value.includes('\0')) {
      throw workbookError('CELL_INVALID', 'XLSX contains an invalid or oversized text cell');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw workbookError('CELL_INVALID', 'XLSX numeric cells must be safe integers');
    }
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  throw workbookError('CELL_INVALID', 'XLSX contains an unsupported cell type');
}

export async function readStrictXlsxRecords(input: {
  buffer: Buffer;
  columns: readonly string[];
  maxBytes: number;
  maxRows: number;
  sheet: string;
}): Promise<ProductImportRecord[]> {
  preflightProductImportXlsx(input.buffer, input.sheet, input.maxBytes);
  try {
    const sheets = await readXlsxFile(input.buffer, { trim: false });
    if (sheets.length !== 1 || sheets[0]?.sheet !== input.sheet) {
      throw workbookError('WORKSHEET_INVALID', `The only worksheet must be named ${input.sheet}`);
    }
    if (sheets[0].data.length > input.maxRows + 1) {
      throw workbookError('ROW_LIMIT_EXCEEDED', `XLSX exceeds ${input.maxRows} data rows`);
    }
    return sheets[0].data.map((row, index) => {
      if (row.length > input.columns.length) {
        throw workbookError('COLUMN_LIMIT_EXCEEDED', 'XLSX exceeds the fixed column limit');
      }
      return { line: index + 1, values: row.map(xlsxCellToText) };
    });
  } catch (error) {
    if (error instanceof ProductImportFileError) throw error;
    throw workbookError('WORKBOOK_INVALID', 'XLSX workbook cannot be parsed');
  }
}

export async function parseProductImportXlsx(buffer: Buffer): Promise<ParsedProductImportRow[]> {
  const records = await readStrictXlsxRecords({
    buffer,
    columns: PRODUCT_IMPORT_COLUMNS,
    maxBytes: PRODUCT_IMPORT_MAX_BYTES,
    maxRows: PRODUCT_IMPORT_MAX_ROWS,
    sheet: 'products',
  });
  return parseProductImportRecords(records, 'XLSX');
}

function headerCell(value: string): Cell {
  return {
    backgroundColor: '#17324D',
    fontWeight: 'bold',
    textColor: '#FFFFFF',
    type: String,
    value,
  };
}

function safeSpreadsheetText(value: string): string {
  return /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function exportCell(value: ProductExportRow[ProductExportColumn]): Cell {
  if (value === null) return { type: String, value: '' };
  if (typeof value === 'string') return { type: String, value: safeSpreadsheetText(value) };
  if (typeof value === 'boolean') return { type: Boolean, value };
  return { format: '#,##0', type: Number, value };
}

const importColumnWidths = PRODUCT_IMPORT_COLUMNS.map((column) => ({
  width: column.includes('description') ? 36 : column.includes('name_') ? 24 : 20,
}));
const exportColumnWidths = PRODUCT_EXPORT_COLUMNS.map((column) => ({
  width: column.includes('description') ? 36 : column.includes('name_') ? 24 : 20,
}));

export async function productImportTemplateXlsx(): Promise<Buffer> {
  const sheetData: SheetData = [PRODUCT_IMPORT_COLUMNS.map(headerCell)];
  return writeXlsxFile(sheetData, {
    columns: importColumnWidths,
    sheet: 'products',
    stickyRowsCount: 1,
  }).toBuffer();
}

export async function productExportXlsx(rows: ProductExportRow[]): Promise<Buffer> {
  if (rows.length > PRODUCT_EXPORT_MAX_ROWS) {
    throw new RangeError(`Product export exceeds ${PRODUCT_EXPORT_MAX_ROWS} SKU rows`);
  }
  const sheetData: SheetData = [
    PRODUCT_EXPORT_COLUMNS.map(headerCell),
    ...rows.map((row) => PRODUCT_EXPORT_COLUMNS.map((column) => exportCell(row[column]))),
  ];
  const buffer = await writeXlsxFile(sheetData, {
    columns: exportColumnWidths,
    sheet: 'products',
    stickyRowsCount: 1,
  }).toBuffer();
  if (buffer.byteLength > PRODUCT_EXPORT_MAX_BYTES) {
    throw new RangeError('Product export exceeds the response size limit');
  }
  return buffer;
}

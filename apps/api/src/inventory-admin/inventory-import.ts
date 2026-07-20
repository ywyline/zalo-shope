import { catalogCodeSchema, warehouseCodeSchema } from '@zalo-shop/contracts';
import { MAX_INVENTORY_QUANTITY } from '@zalo-shop/domain';

import {
  ProductImportFileError,
  parseCsvRecords,
  readUtf8ImportFile,
  type ProductImportRecord,
} from '../catalog-admin/product-import';
import { readStrictXlsxRecords } from '../catalog-admin/product-xlsx';

export const INVENTORY_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const INVENTORY_IMPORT_MAX_ROWS = 5_000;
export const INVENTORY_IMPORT_COLUMNS = ['warehouse_code', 'sku_code', 'quantity', 'note'] as const;

export type ParsedInventoryImportRow = Readonly<{
  issue?: string;
  line: number;
  note: string | null;
  quantity: number;
  skuCode: string;
  warehouseCode: string;
}>;

function parseRows(records: ProductImportRecord[], format: 'CSV' | 'XLSX') {
  const header = records[0];
  if (!header) throw new ProductImportFileError('FILE_EMPTY', `${format} file has no header`);
  if (
    header.values.length !== INVENTORY_IMPORT_COLUMNS.length ||
    header.values.some((value, index) => value.trim() !== INVENTORY_IMPORT_COLUMNS[index])
  ) {
    throw new ProductImportFileError(
      'HEADER_INVALID',
      `${format} header does not match the inventory template`,
    );
  }
  const rows = records.slice(1);
  if (rows.length === 0) {
    throw new ProductImportFileError('FILE_EMPTY', `${format} file has no data rows`);
  }
  if (rows.length > INVENTORY_IMPORT_MAX_ROWS) {
    throw new ProductImportFileError(
      'ROW_LIMIT_EXCEEDED',
      `${format} exceeds ${INVENTORY_IMPORT_MAX_ROWS} data rows`,
    );
  }
  return rows.map((record): ParsedInventoryImportRow => {
    if (record.values.length !== INVENTORY_IMPORT_COLUMNS.length) {
      return {
        issue: 'COLUMN_COUNT_INVALID',
        line: record.line,
        note: null,
        quantity: 0,
        skuCode: '',
        warehouseCode: '',
      };
    }
    const [warehouseRaw = '', skuRaw = '', quantityRaw = '', noteRaw = ''] = record.values;
    const warehouse = warehouseCodeSchema.safeParse(warehouseRaw);
    const sku = catalogCodeSchema.safeParse(skuRaw);
    const quantityText = quantityRaw.trim();
    const quantity = /^(0|[1-9]\d*)$/.test(quantityText) ? Number(quantityText) : Number.NaN;
    const note = noteRaw.trim() || null;
    const issue = !warehouse.success
      ? 'WAREHOUSE_CODE_INVALID'
      : !sku.success
        ? 'SKU_CODE_INVALID'
        : !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > MAX_INVENTORY_QUANTITY
          ? 'QUANTITY_INVALID'
          : note !== null && note.length > 500
            ? 'NOTE_TOO_LONG'
            : undefined;
    return {
      ...(issue === undefined ? {} : { issue }),
      line: record.line,
      note,
      quantity: Number.isSafeInteger(quantity) ? quantity : 0,
      skuCode: sku.success ? sku.data : skuRaw.trim(),
      warehouseCode: warehouse.success ? warehouse.data : warehouseRaw.trim(),
    };
  });
}

export function parseInventoryImportCsv(buffer: Buffer): ParsedInventoryImportRow[] {
  return parseRows(parseCsvRecords(readUtf8ImportFile(buffer, INVENTORY_IMPORT_MAX_BYTES)), 'CSV');
}

export async function parseInventoryImportXlsx(
  buffer: Buffer,
): Promise<ParsedInventoryImportRow[]> {
  const records = await readStrictXlsxRecords({
    buffer,
    columns: INVENTORY_IMPORT_COLUMNS,
    maxBytes: INVENTORY_IMPORT_MAX_BYTES,
    maxRows: INVENTORY_IMPORT_MAX_ROWS,
    sheet: 'inventory',
  });
  return parseRows(records, 'XLSX');
}

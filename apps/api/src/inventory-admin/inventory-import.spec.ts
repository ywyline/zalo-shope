import { describe, expect, it } from 'vitest';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';

import { ProductImportFileError } from '../catalog-admin/product-import';
import {
  INVENTORY_IMPORT_COLUMNS,
  parseInventoryImportCsv,
  parseInventoryImportXlsx,
} from './inventory-import';

describe('M3.3 inventory initial-load CSV parser', () => {
  it('normalizes warehouse and SKU codes while preserving Vietnamese notes', () => {
    const rows = parseInventoryImportCsv(
      Buffer.from(
        '\uFEFFwarehouse_code,sku_code,quantity,note\r\nLOCAL-DEFAULT,SKU-MOI,12,"Kiểm kê đầu kỳ, đã duyệt"\r\n',
        'utf8',
      ),
    );

    expect(rows).toEqual([
      {
        line: 2,
        note: 'Kiểm kê đầu kỳ, đã duyệt',
        quantity: 12,
        skuCode: 'sku-moi',
        warehouseCode: 'local-default',
      },
    ]);
  });

  it('returns row-level issues without accepting zero, negative or duplicate columns', () => {
    const rows = parseInventoryImportCsv(
      Buffer.from(
        'warehouse_code,sku_code,quantity,note\ninvalid code,sku-ok,0,\nlocal-default,sku-ok,-2,\n',
      ),
    );
    expect(rows.map((row) => row.issue)).toEqual(['WAREHOUSE_CODE_INVALID', 'QUANTITY_INVALID']);
  });

  it('rejects template drift, invalid UTF-8 and files over the fixed limit', () => {
    expect(() =>
      parseInventoryImportCsv(Buffer.from('warehouse,sku,quantity,note\na,b,1,\n')),
    ).toThrowError(ProductImportFileError);
    expect(() => parseInventoryImportCsv(Buffer.from([0xff, 0xfe]))).toThrowError(
      ProductImportFileError,
    );
    expect(() => parseInventoryImportCsv(Buffer.alloc(5 * 1024 * 1024 + 1, 65))).toThrowError(
      ProductImportFileError,
    );
  });

  it('accepts only the frozen inventory XLSX worksheet contract', async () => {
    const valid = await writeXlsxFile(
      [
        [...INVENTORY_IMPORT_COLUMNS],
        ['LOCAL-DEFAULT', 'SKU-MOI', 9, 'Kiểm kê ban đầu'],
      ] as SheetData,
      { sheet: 'inventory' },
    ).toBuffer();
    await expect(parseInventoryImportXlsx(valid)).resolves.toEqual([
      expect.objectContaining({
        line: 2,
        note: 'Kiểm kê ban đầu',
        quantity: 9,
        skuCode: 'sku-moi',
        warehouseCode: 'local-default',
      }),
    ]);

    const drifted = await writeXlsxFile(
      [[...INVENTORY_IMPORT_COLUMNS], ['local-default', 'sku-moi', 9, '']] as SheetData,
      { sheet: 'stock' },
    ).toBuffer();
    await expect(parseInventoryImportXlsx(drifted)).rejects.toBeInstanceOf(ProductImportFileError);
  });
});

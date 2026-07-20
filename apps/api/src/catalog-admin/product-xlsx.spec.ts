import readXlsxFile from 'read-excel-file/node';
import { describe, expect, it } from 'vitest';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';

import {
  PRODUCT_IMPORT_COLUMNS,
  ProductImportFileError,
  parseProductImportCsv,
} from './product-import';
import {
  PRODUCT_EXPORT_COLUMNS,
  PRODUCT_EXPORT_MAX_ROWS,
  parseProductImportXlsx,
  preflightProductImportXlsx,
  productExportXlsx,
  productImportTemplateXlsx,
  type ProductExportRow,
} from './product-xlsx';

const validValues: Record<(typeof PRODUCT_IMPORT_COLUMNS)[number], string | number | null> = {
  barcode: '893000000001',
  brand_code: 'lotus',
  cost_price_vnd: 90_000,
  description_en: null,
  description_vi: 'Mô tả dịu nhẹ',
  description_zh: null,
  main_category_code: 'serum',
  market_price_vnd: 150_000,
  name_en: null,
  name_vi: 'Tinh chất',
  name_zh: null,
  product_code: 'serum-01',
  sale_price_vnd: 120_000,
  secondary_category_codes: null,
  selling_points_en: null,
  selling_points_vi: 'Không hương liệu',
  selling_points_zh: null,
  sku_code: 'serum-01-30ml',
  sku_options: 'capacity=ml30',
  weight_grams: 120,
};

async function workbook(
  rows: Array<Array<boolean | number | string | null>>,
  sheet = 'products',
): Promise<Buffer> {
  return writeXlsxFile(rows as SheetData, { sheet }).toBuffer();
}

function csvEscape(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return text.includes(',') || text.includes('"') ? `"${text.replaceAll('"', '""')}"` : text;
}

function storedZip(entries: Array<{ content: string; name: string; size?: number }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content, 'utf8');
    const declaredSize = entry.size ?? content.byteLength;
    const local = Buffer.alloc(30 + name.byteLength + content.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(content.byteLength, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.byteLength, 26);
    name.copy(local, 30);
    content.copy(local, 30 + name.byteLength);

    const central = Buffer.alloc(46 + name.byteLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(content.byteLength, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);

    localParts.push(local);
    centralParts.push(central);
    localOffset += local.byteLength;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function workbookSkeleton(workbookXml: string, sheetXml = '<worksheet/>'): Buffer {
  return storedZip([
    { content: '<Types/>', name: '[Content_Types].xml' },
    { content: workbookXml, name: 'xl/workbook.xml' },
    { content: sheetXml, name: 'xl/worksheets/sheet1.xml' },
  ]);
}

function expectFileCode(error: unknown, code: ProductImportFileError['code']): void {
  expect(error).toBeInstanceOf(ProductImportFileError);
  expect((error as ProductImportFileError).code).toBe(code);
}

function expectPreflightCode(buffer: Buffer, code: ProductImportFileError['code']): void {
  try {
    preflightProductImportXlsx(buffer);
    expect.fail(`Expected ${code}`);
  } catch (error) {
    expectFileCode(error, code);
  }
}

describe('M2.8.3 product XLSX import and export', () => {
  it('generates a frozen single-sheet template with the same columns as CSV', async () => {
    const template = await productImportTemplateXlsx();
    preflightProductImportXlsx(template);
    const sheets = await readXlsxFile(template);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]).toMatchObject({ sheet: 'products', data: [[...PRODUCT_IMPORT_COLUMNS]] });
    await expect(parseProductImportXlsx(template)).rejects.toMatchObject({ code: 'FILE_EMPTY' });
  });

  it('parses XLSX rows through the same frozen domain conversion as CSV', async () => {
    const values = PRODUCT_IMPORT_COLUMNS.map((column) => validValues[column]);
    const xlsx = await parseProductImportXlsx(
      await workbook([[...PRODUCT_IMPORT_COLUMNS], values]),
    );
    const csv = parseProductImportCsv(
      Buffer.from(`${PRODUCT_IMPORT_COLUMNS.join(',')}\r\n${values.map(csvEscape).join(',')}\r\n`),
    );
    expect(xlsx).toEqual(csv);
  });

  it('rejects formulas, hidden or extra worksheets and non-integer cells', async () => {
    const formulaData: SheetData = [
      [...PRODUCT_IMPORT_COLUMNS],
      PRODUCT_IMPORT_COLUMNS.map((column) =>
        column === 'name_vi' ? { type: 'Formula', value: '=1+1' } : validValues[column],
      ),
    ];
    const formula = await writeXlsxFile(formulaData, { sheet: 'products' }).toBuffer();
    expectPreflightCode(formula, 'FORMULA_NOT_ALLOWED');

    const hidden = workbookSkeleton(
      '<workbook><sheets><sheet name="products" state="hidden"/></sheets></workbook>',
    );
    expectPreflightCode(hidden, 'WORKSHEET_INVALID');

    const multi = await writeXlsxFile([
      { data: [[...PRODUCT_IMPORT_COLUMNS]], sheet: 'products' },
      { data: [['unexpected']], sheet: 'other' },
    ]).toBuffer();
    expectPreflightCode(multi, 'WORKSHEET_INVALID');

    const decimal = await workbook([
      [...PRODUCT_IMPORT_COLUMNS],
      PRODUCT_IMPORT_COLUMNS.map((column) =>
        column === 'sale_price_vnd' ? 1.5 : validValues[column],
      ),
    ]);
    await expect(parseProductImportXlsx(decimal)).rejects.toMatchObject({ code: 'CELL_INVALID' });
  });

  it('rejects external relationships, unsafe ZIP paths and expanded-size abuse', () => {
    const external = storedZip([
      { content: '<Types/>', name: '[Content_Types].xml' },
      {
        content: '<workbook><sheets><sheet name="products"/></sheets></workbook>',
        name: 'xl/workbook.xml',
      },
      { content: '<worksheet/>', name: 'xl/worksheets/sheet1.xml' },
      {
        content: '<Relationship TargetMode="External" Target="https://invalid.example"/>',
        name: 'xl/_rels/workbook.xml.rels',
      },
    ]);
    expectPreflightCode(external, 'WORKBOOK_INVALID');

    const entityDeclaration = workbookSkeleton(
      '<!DOCTYPE workbook [<!ENTITY x "unsafe">]><workbook><sheets><sheet name="products"/></sheets></workbook>',
    );
    expectPreflightCode(entityDeclaration, 'WORKBOOK_INVALID');

    const errorCell = workbookSkeleton(
      '<workbook><sheets><sheet name="products"/></sheets></workbook>',
      '<worksheet><sheetData><row><c t="e"><v>#N/A</v></c></row></sheetData></worksheet>',
    );
    expectPreflightCode(errorCell, 'CELL_INVALID');

    const embedded = storedZip([
      { content: '<Types/>', name: '[Content_Types].xml' },
      {
        content: '<workbook><sheets><sheet name="products"/></sheets></workbook>',
        name: 'xl/workbook.xml',
      },
      { content: '<worksheet/>', name: 'xl/worksheets/sheet1.xml' },
      { content: 'untrusted', name: 'xl/embeddings/object.bin' },
    ]);
    expectPreflightCode(embedded, 'WORKBOOK_INVALID');

    try {
      preflightProductImportXlsx(storedZip([{ content: '', name: '../escape.xml' }]));
      expect.fail('Expected unsafe ZIP path rejection');
    } catch (error) {
      expectFileCode(error, 'WORKBOOK_INVALID');
    }

    try {
      preflightProductImportXlsx(
        storedZip([{ content: '', name: 'xl/oversized.xml', size: 8 * 1024 * 1024 + 1 }]),
      );
      expect.fail('Expected expanded-size rejection');
    } catch (error) {
      expectFileCode(error, 'ZIP_LIMIT_EXCEEDED');
    }
  });

  it('exports a stable redacted worksheet and neutralizes formula-like text', async () => {
    const row = Object.fromEntries(
      PRODUCT_EXPORT_COLUMNS.map((column) => [column, '']),
    ) as ProductExportRow;
    Object.assign(row, {
      brand_code: 'lotus',
      description_vi: '=WEBSERVICE("https://invalid.example")',
      main_category_code: 'serum',
      name_vi: '+Tên nguy hiểm',
      product_code: 'serum-01',
      product_enabled: true,
      product_status: 'DRAFT',
      sale_price_vnd: 120_000,
      sku_code: 'serum-01-30ml',
      sku_status: 'ACTIVE',
      updated_at: '2026-07-19T00:00:00.000Z',
    });
    const buffer = await productExportXlsx([row]);
    const [sheet] = await readXlsxFile(buffer);
    expect(sheet?.sheet).toBe('products');
    expect(sheet?.data[0]).toEqual([...PRODUCT_EXPORT_COLUMNS]);
    expect(sheet?.data[0]).not.toContain('cost_price_vnd');
    const output = Object.fromEntries(
      PRODUCT_EXPORT_COLUMNS.map((column, index) => [column, sheet?.data[1]?.[index]]),
    );
    expect(output).toMatchObject({
      description_vi: '\'=WEBSERVICE("https://invalid.example")',
      name_vi: "'+Tên nguy hiểm",
      sale_price_vnd: 120_000,
    });
  });

  it('refuses to silently truncate exports beyond the synchronous row bound', async () => {
    const row = Object.fromEntries(
      PRODUCT_EXPORT_COLUMNS.map((column) => [column, '']),
    ) as ProductExportRow;
    await expect(
      productExportXlsx(Array.from({ length: PRODUCT_EXPORT_MAX_ROWS + 1 }, () => row)),
    ).rejects.toThrow(`exceeds ${PRODUCT_EXPORT_MAX_ROWS}`);
  });
});

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

const CUSTOMER_MASTER_SHEET = 'Customer Master';
const READY_STATUS = 'พร้อมใช้';
const REVIEW_STATUS = 'ตรวจสอบ';
const EXPECTED_HEADERS = [
  'ชื่อบริษัท',
  'Tax ID',
  'สาขา/สำนักงาน',
  'ที่อยู่',
  'โทรศัพท์',
  'อีเมล',
  'สถานะ',
  'หมายเหตุ',
] as const;

type XmlNode = Record<string, unknown>;

export type CustomerImportDocument = {
  customerCode: string;
  displayName: string;
  phoneNumber?: string;
  phoneNumbers: string[];
  email?: string;
  taxId: string;
  companyName: string;
  address?: string;
  branchType?: string;
  active: true;
};

export type PreparedCustomerImportRow = {
  sourceRow: number;
  identityKey: string;
  document: CustomerImportDocument;
};

export type CustomerWorkbookImport = {
  sourceSha256: string;
  sourceRows: number;
  readyRows: PreparedCustomerImportRow[];
  reviewRows: number[];
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function asObject(value: unknown, context: string): XmlNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid Excel XML at ${context}.`);
  }
  return value as XmlNode;
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value === 'object') {
    const node = value as XmlNode;
    if ('t' in node) return text(node.t);
    if ('#text' in node) return text(node['#text']);
    if ('r' in node) return text(node.r);
  }
  return '';
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function optionalValue(value: string): string | undefined {
  const normalized = normalizeWhitespace(value);
  return normalized || undefined;
}

export function splitPhoneNumbers(value: string): string[] {
  return value
    .split(/[,;\r\n]+/)
    .map(normalizeWhitespace)
    .filter((phone, index, phones) => phone && phones.indexOf(phone) === index);
}

export function isValidThaiTaxId(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  const sum = [...value.slice(0, 12)].reduce(
    (total, digit, index) => total + Number(digit) * (13 - index),
    0,
  );
  return (11 - (sum % 11)) % 10 === Number(value[12]);
}

export function customerIdentityKey(input: {
  taxId: string;
  branchType?: string;
  address?: string;
}): string {
  return [input.taxId, input.branchType ?? '', input.address ?? '']
    .map((value) => normalizeWhitespace(value).toLocaleLowerCase('th-TH'))
    .join('|');
}

function customerCodeFor(identityKey: string): string {
  return `CUS-${createHash('sha256').update(identityKey).digest('hex').slice(0, 10).toUpperCase()}`;
}

function columnName(cellReference: string): string {
  const match = /^[A-Z]+/.exec(cellReference);
  if (!match)
    throw new TypeError(`Invalid Excel cell reference ${cellReference}.`);
  return match[0];
}

function parseSharedStrings(zipContent: Map<string, string>): string[] {
  const xml = zipContent.get('xl/sharedStrings.xml');
  if (!xml) return [];
  const parsed = asObject(xmlParser.parse(xml), 'sharedStrings');
  if (!parsed.sst || typeof parsed.sst !== 'object') return [];
  const sst = asObject(parsed.sst, 'sharedStrings.sst');
  return asArray(sst.si).map(text);
}

function readCell(cell: XmlNode, sharedStrings: string[]): string {
  const cellType = text(cell.t);
  if (cellType === 's') {
    const index = Number(text(cell.v));
    if (!Number.isInteger(index) || sharedStrings[index] === undefined) {
      throw new TypeError(`Invalid shared string index ${text(cell.v)}.`);
    }
    return sharedStrings[index];
  }
  if (cellType === 'inlineStr') return text(cell.is);
  return text(cell.v);
}

function worksheetRows(
  xml: string,
  sharedStrings: string[],
): Map<string, string>[] {
  const parsed = asObject(xmlParser.parse(xml), 'worksheet');
  const worksheet = asObject(parsed.worksheet, 'worksheet.root');
  const sheetData = asObject(worksheet.sheetData, 'worksheet.sheetData');
  return asArray(sheetData.row).map((rawRow) => {
    const row = asObject(rawRow, 'worksheet.row');
    const values = new Map<string, string>();
    for (const rawCell of asArray(row.c)) {
      const cell = asObject(rawCell, 'worksheet.cell');
      const reference = text(cell.r);
      values.set(columnName(reference), readCell(cell, sharedStrings));
    }
    values.set('__row', text(row.r));
    return values;
  });
}

function validateHeaders(row: Map<string, string>): void {
  EXPECTED_HEADERS.forEach((expected, index) => {
    const column = String.fromCharCode('A'.charCodeAt(0) + index);
    if (normalizeWhitespace(row.get(column) ?? '') !== expected) {
      throw new TypeError(
        `Unexpected Customer Master header in ${column}1; expected ${expected}.`,
      );
    }
  });
}

export function prepareCustomerRows(
  rows: Map<string, string>[],
): Pick<CustomerWorkbookImport, 'sourceRows' | 'readyRows' | 'reviewRows'> {
  const [header, ...dataRows] = rows;
  if (!header) throw new TypeError('Customer Master is empty.');
  validateHeaders(header);

  const readyRows: PreparedCustomerImportRow[] = [];
  const reviewRows: number[] = [];
  const identities = new Set<string>();

  for (const row of dataRows) {
    const sourceRow = Number(row.get('__row'));
    const displayName = normalizeWhitespace(row.get('A') ?? '');
    const taxId = normalizeWhitespace(row.get('B') ?? '');
    const branchType = optionalValue(row.get('C') ?? '');
    const address = optionalValue(row.get('D') ?? '');
    const phoneNumbers = splitPhoneNumbers(row.get('E') ?? '');
    const email = optionalValue(row.get('F') ?? '');
    const status = normalizeWhitespace(row.get('G') ?? '');

    if (status === REVIEW_STATUS) {
      reviewRows.push(sourceRow);
      continue;
    }
    if (status !== READY_STATUS) {
      throw new TypeError(
        `Unknown customer status ${status || '(blank)'} at row ${sourceRow}.`,
      );
    }
    if (!displayName)
      throw new TypeError(`Missing customer name at row ${sourceRow}.`);
    if (!isValidThaiTaxId(taxId)) {
      throw new TypeError(`Invalid Thai Tax ID at ready row ${sourceRow}.`);
    }
    for (const phoneNumber of phoneNumbers) {
      if (phoneNumber.length > 20) {
        throw new TypeError(
          `Phone number exceeds 20 characters at row ${sourceRow}.`,
        );
      }
    }

    const identityKey = customerIdentityKey({ taxId, branchType, address });
    if (identities.has(identityKey)) {
      throw new TypeError(
        `Duplicate customer identity in source at row ${sourceRow}.`,
      );
    }
    identities.add(identityKey);

    readyRows.push({
      sourceRow,
      identityKey,
      document: {
        customerCode: customerCodeFor(identityKey),
        displayName,
        phoneNumbers,
        ...(phoneNumbers[0] ? { phoneNumber: phoneNumbers[0] } : {}),
        ...(email ? { email } : {}),
        taxId,
        companyName: displayName,
        ...(address ? { address } : {}),
        ...(branchType ? { branchType } : {}),
        active: true,
      },
    });
  }

  return { sourceRows: dataRows.length, readyRows, reviewRows };
}

async function readZipXml(filePath: string): Promise<Map<string, string>> {
  const buffer = await readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const content = new Map<string, string>();
  await Promise.all(
    Object.entries(zip.files).map(async ([name, entry]) => {
      if (!entry.dir && (name.endsWith('.xml') || name.endsWith('.rels'))) {
        content.set(name, await entry.async('string'));
      }
    }),
  );
  return content;
}

export async function loadCustomerWorkbook(
  filePath: string,
): Promise<CustomerWorkbookImport> {
  const [buffer, zipContent] = await Promise.all([
    readFile(filePath),
    readZipXml(filePath),
  ]);
  const workbookXml = zipContent.get('xl/workbook.xml');
  const relationshipsXml = zipContent.get('xl/_rels/workbook.xml.rels');
  if (!workbookXml || !relationshipsXml) {
    throw new TypeError('Excel workbook metadata is incomplete.');
  }

  const workbookRoot = asObject(xmlParser.parse(workbookXml), 'workbook');
  const workbook = asObject(workbookRoot.workbook, 'workbook.root');
  const sheets = asObject(workbook.sheets, 'workbook.sheets');
  const sheet = asArray(sheets.sheet)
    .map((value) => asObject(value, 'workbook.sheet'))
    .find((value) => text(value.name) === CUSTOMER_MASTER_SHEET);
  if (!sheet) throw new TypeError(`Missing ${CUSTOMER_MASTER_SHEET} sheet.`);

  const relationshipsRoot = asObject(
    xmlParser.parse(relationshipsXml),
    'relationships',
  );
  const relationships = asObject(
    relationshipsRoot.Relationships,
    'relationships.root',
  );
  const relationship = asArray(relationships.Relationship)
    .map((value) => asObject(value, 'relationship'))
    .find((value) => text(value.Id) === text(sheet.id));
  if (!relationship)
    throw new TypeError('Customer Master relationship is missing.');

  const sheetPath = text(relationship.Target).replace(/^\//, '');
  const sheetXml = zipContent.get(sheetPath);
  if (!sheetXml) throw new TypeError(`Missing worksheet content ${sheetPath}.`);
  const sharedStrings = parseSharedStrings(zipContent);
  const prepared = prepareCustomerRows(worksheetRows(sheetXml, sharedStrings));

  return {
    sourceSha256: createHash('sha256').update(buffer).digest('hex'),
    ...prepared,
  };
}

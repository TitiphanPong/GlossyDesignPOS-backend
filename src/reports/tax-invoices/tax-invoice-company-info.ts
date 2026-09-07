export type TaxInvoiceCompanyInfo = {
  thaiName: string;
  englishName: string;
  branchLabel: string;
  taxId: string;
  address: string;
  phone: string;
};

const DEFAULT_COMPANY_INFO = {
  thaiName: 'กรอสซี่ ปริ้น แอนด์ พรีเมี่ยม',
  englishName: 'GLOSSY PRINT AND PREMIUM',
  branch: 'สำนักงานใหญ่',
  taxId: '3160100252587',
  address: '55 ถนนศรีนครินทร์ แขวงหนองบอน เขตประเวศ จังหวัดกรุงเทพฯ 10250',
  phone: '081-555-2929',
} as const;

function resolveValue(
  env: NodeJS.ProcessEnv,
  key: string,
  publicKey: string,
  fallback: string,
): string {
  return env[key]?.trim() || env[publicKey]?.trim() || fallback;
}

export function formatCompanyBranchLabel(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized === '-' || normalized === 'สำนักงานใหญ่') {
    return 'สำนักงานใหญ่';
  }
  if (/^สาขา\s*/u.test(normalized)) return normalized;
  return `สาขา ${normalized}`;
}

export function resolveTaxInvoiceCompanyInfo(
  env: NodeJS.ProcessEnv = process.env,
): TaxInvoiceCompanyInfo {
  return {
    thaiName: resolveValue(
      env,
      'COMPANY_THAI_NAME',
      'NEXT_PUBLIC_COMPANY_THAI_NAME',
      DEFAULT_COMPANY_INFO.thaiName,
    ),
    englishName: resolveValue(
      env,
      'COMPANY_ENGLISH_NAME',
      'NEXT_PUBLIC_COMPANY_ENGLISH_NAME',
      DEFAULT_COMPANY_INFO.englishName,
    ),
    branchLabel: formatCompanyBranchLabel(
      resolveValue(
        env,
        'COMPANY_BRANCH_NO',
        'NEXT_PUBLIC_COMPANY_BRANCH_NO',
        DEFAULT_COMPANY_INFO.branch,
      ),
    ),
    taxId: resolveValue(
      env,
      'COMPANY_TAX_ID',
      'NEXT_PUBLIC_COMPANY_TAX_ID',
      DEFAULT_COMPANY_INFO.taxId,
    ),
    address: resolveValue(
      env,
      'COMPANY_ADDRESS',
      'NEXT_PUBLIC_COMPANY_ADDRESS',
      DEFAULT_COMPANY_INFO.address,
    ),
    phone: resolveValue(
      env,
      'COMPANY_PHONE',
      'NEXT_PUBLIC_COMPANY_PHONE',
      DEFAULT_COMPANY_INFO.phone,
    ),
  };
}

export function buildCompanyTaxMetaLine(info: TaxInvoiceCompanyInfo): string {
  return `เลขประจำตัวผู้เสียภาษี ${info.taxId} · ${info.branchLabel} · โทร ${info.phone}`;
}

import {
  buildCompanyTaxMetaLine,
  formatCompanyBranchLabel,
  resolveTaxInvoiceCompanyInfo,
} from './tax-invoice-company-info';

describe('tax invoice company info', () => {
  it('uses the Glossy public business identity when runtime env is missing', () => {
    const info = resolveTaxInvoiceCompanyInfo({});

    expect(info).toEqual({
      thaiName: 'กรอสซี่ ปริ้น แอนด์ พรีเมี่ยม',
      englishName: 'GLOSSY PRINT AND PREMIUM',
      branchLabel: 'สำนักงานใหญ่',
      taxId: '3160100252587',
      address: '55 ถนนศรีนครินทร์ แขวงหนองบอน เขตประเวศ จังหวัดกรุงเทพฯ 10250',
      phone: '081-555-2929',
    });
  });

  it('prefers backend COMPANY_* values and accepts the existing NEXT_PUBLIC_* compatibility names', () => {
    const info = resolveTaxInvoiceCompanyInfo({
      COMPANY_THAI_NAME: 'Backend Thai',
      NEXT_PUBLIC_COMPANY_THAI_NAME: 'Frontend Thai',
      NEXT_PUBLIC_COMPANY_ENGLISH_NAME: 'Frontend English',
      NEXT_PUBLIC_COMPANY_BRANCH_NO: '00001',
      NEXT_PUBLIC_COMPANY_TAX_ID: '1234567890123',
      NEXT_PUBLIC_COMPANY_ADDRESS: 'Bangkok',
      NEXT_PUBLIC_COMPANY_PHONE: '020000000',
    });

    expect(info).toMatchObject({
      thaiName: 'Backend Thai',
      englishName: 'Frontend English',
      branchLabel: 'สาขา 00001',
      taxId: '1234567890123',
      address: 'Bangkok',
      phone: '020000000',
    });
  });

  it('does not duplicate the head-office label and formats branch numbers clearly', () => {
    expect(formatCompanyBranchLabel('สำนักงานใหญ่')).toBe('สำนักงานใหญ่');
    expect(formatCompanyBranchLabel('-')).toBe('สำนักงานใหญ่');
    expect(formatCompanyBranchLabel('00001')).toBe('สาขา 00001');
    expect(formatCompanyBranchLabel('สาขา 00002')).toBe('สาขา 00002');
  });

  it('builds the tax metadata line without placeholder dashes', () => {
    const line = buildCompanyTaxMetaLine(resolveTaxInvoiceCompanyInfo({}));

    expect(line).toBe(
      'เลขประจำตัวผู้เสียภาษี 3160100252587 · สำนักงานใหญ่ · โทร 081-555-2929',
    );
    expect(line).not.toContain(' - ');
  });
});

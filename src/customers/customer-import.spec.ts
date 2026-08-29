import {
  customerIdentityKey,
  prepareCustomerRows,
  splitPhoneNumbers,
} from './customer-import';

function row(rowNumber: number, values: Record<string, string>) {
  return new Map<string, string>([
    ['__row', String(rowNumber)],
    ...Object.entries(values),
  ]);
}

const header = row(1, {
  A: 'ชื่อบริษัท',
  B: 'Tax ID',
  C: 'สาขา/สำนักงาน',
  D: 'ที่อยู่',
  E: 'โทรศัพท์',
  F: 'อีเมล',
  G: 'สถานะ',
  H: 'หมายเหตุ',
});

describe('customer Excel import preparation', () => {
  it('splits and de-duplicates multiple phone numbers', () => {
    expect(splitPhoneNumbers('02-7385801, 02-31660369\n02-7385801')).toEqual([
      '02-7385801',
      '02-31660369',
    ]);
  });

  it('maps ready rows, preserves blank optional fields, and skips review rows', () => {
    const result = prepareCustomerRows([
      header,
      row(2, {
        A: 'บริษัท ทดสอบ จำกัด',
        B: '0105567177975',
        C: 'สำนักงานใหญ่',
        D: '1 ถนนทดสอบ กรุงเทพฯ 10000',
        E: '02-7385801, 02-31660369',
        F: '',
        G: 'พร้อมใช้',
      }),
      row(3, {
        A: 'รายการรอตรวจสอบ',
        B: '',
        G: 'ตรวจสอบ',
      }),
    ]);

    expect(result.sourceRows).toBe(2);
    expect(result.reviewRows).toEqual([3]);
    expect(result.includedReviewRows).toEqual([]);
    expect(result.importRows).toHaveLength(1);
    expect(result.importRows[0].document).toEqual(
      expect.objectContaining({
        displayName: 'บริษัท ทดสอบ จำกัด',
        phoneNumber: '02-7385801',
        phoneNumbers: ['02-7385801', '02-31660369'],
        taxId: '0105567177975',
        active: true,
      }),
    );
    expect(result.importRows[0].document).not.toHaveProperty('email');
  });

  it('can include review rows while leaving invalid or missing tax IDs blank', () => {
    const result = prepareCustomerRows(
      [
        header,
        row(2, {
          A: 'ลูกค้ารอตรวจสอบ',
          B: '0000000000000',
          D: '1 ถนนทดสอบ',
          G: 'ตรวจสอบ',
        }),
      ],
      { includeReview: true },
    );

    expect(result.reviewRows).toEqual([2]);
    expect(result.includedReviewRows).toEqual([2]);
    expect(result.importRows).toHaveLength(1);
    expect(result.importRows[0].document).not.toHaveProperty('taxId');
  });

  it('uses tax ID, branch, and address as the stable import identity', () => {
    expect(
      customerIdentityKey({
        taxId: '0105567177975',
        branchType: ' สำนักงานใหญ่ ',
        address: '1  ถนนทดสอบ',
      }),
    ).toBe('0105567177975|สำนักงานใหญ่|1 ถนนทดสอบ');
  });
});

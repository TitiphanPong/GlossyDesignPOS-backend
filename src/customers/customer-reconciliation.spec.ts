import {
  buildInvoiceCustomerReconciliationPlan,
  normalizeBranchNo,
  normalizeTaxId,
} from './customer-reconciliation';

describe('customer reconciliation', () => {
  it('normalizes formatted Thai tax ids to 13 digits', () => {
    expect(normalizeTaxId('0-1055-68206-27-8')).toBe('0105568206278');
    expect(normalizeTaxId('099-4000160623')).toBe('0994000160623');
  });

  it('normalizes headquarters and numbered branch identities', () => {
    expect(
      normalizeBranchNo({ customerName: 'บริษัท เอ จำกัด (สำนักงานใหญ่)' }),
    ).toBe('00000');
    expect(normalizeBranchNo({ customerName: 'บริษัท เอ จำกัด (สาขา1)' })).toBe(
      '00001',
    );
    expect(
      normalizeBranchNo({ address: 'สาขาศรีราชา (00003) 789/27 หมู่ 1' }),
    ).toBe('00003');
  });

  it('links a single compatible customer by normalized tax id', () => {
    const plan = buildInvoiceCustomerReconciliationPlan(
      [
        {
          id: 'customer-1',
          taxId: '0105566175855',
          branchType: 'สำนักงานใหญ่',
          active: true,
        },
      ],
      [
        {
          id: 'order-1',
          invoiceNumber: 'INV-1',
          taxId: '0105566175855',
          customerName: 'บริษัท ตัวอย่าง จำกัด (สำนักงานใหญ่)',
        },
      ],
    );

    expect(plan[0]).toMatchObject({
      action: 'link_existing',
      customerId: 'customer-1',
      branchNo: '00000',
      reason: 'single_tax_id_match',
    });
  });

  it('does not link a single tax-id match when the explicit branch conflicts', () => {
    const plan = buildInvoiceCustomerReconciliationPlan(
      [
        {
          id: 'customer-1',
          taxId: '0105526048623',
          branchNo: '00024',
          active: true,
        },
      ],
      [
        {
          id: 'order-1',
          invoiceNumber: 'INV-1',
          taxId: '0105526048623',
          branchNo: '00025',
        },
      ],
    );

    expect(plan[0]).toMatchObject({
      action: 'review',
      reason: 'single_tax_id_match_has_conflicting_branch',
    });
  });

  it('chooses the only active duplicate when all records represent one branch', () => {
    const plan = buildInvoiceCustomerReconciliationPlan(
      [
        {
          id: 'inactive',
          taxId: '0105563043460',
          active: false,
        },
        {
          id: 'active',
          taxId: '0105563043460',
          active: true,
        },
      ],
      [
        {
          id: 'order-1',
          invoiceNumber: 'INV-1',
          taxId: '0105563043460',
        },
      ],
    );

    expect(plan[0]).toMatchObject({
      action: 'link_existing',
      customerId: 'active',
      reason: 'unique_active_same_branch_match',
    });
  });

  it('chooses a unique exact branch from duplicate tax ids', () => {
    const plan = buildInvoiceCustomerReconciliationPlan(
      [
        {
          id: 'hq',
          taxId: '0105526048623',
          branchNo: '00000',
          active: true,
        },
        {
          id: 'seacon',
          taxId: '0105526048623',
          branchNo: '00024',
          active: true,
        },
      ],
      [
        {
          id: 'order-1',
          invoiceNumber: 'INV-1',
          taxId: '0105526048623',
          branchType: 'สาขาที่ 00024',
        },
      ],
    );

    expect(plan[0]).toMatchObject({
      action: 'link_existing',
      customerId: 'seacon',
      reason: 'unique_tax_id_branch_match',
    });
  });

  it('creates a missing-customer action using tax id plus branch identity', () => {
    const plan = buildInvoiceCustomerReconciliationPlan(
      [],
      [
        {
          id: 'order-1',
          invoiceNumber: 'INV-1',
          taxId: '0265546000170',
          customerName: 'บริษัท พิมานไรซ์ จำกัด (สาขา1)',
        },
      ],
    );

    expect(plan[0]).toMatchObject({
      action: 'create_customer',
      normalizedTaxId: '0265546000170',
      branchNo: '00001',
      identityKey: '0265546000170|00001',
    });
  });

  it('routes invalid tax ids to review instead of creating a customer', () => {
    const plan = buildInvoiceCustomerReconciliationPlan(
      [],
      [
        {
          id: 'order-1',
          invoiceNumber: 'INV-1',
          taxId: '0123456789012',
        },
      ],
    );

    expect(plan[0]).toMatchObject({
      action: 'review',
      reason: 'invalid_thai_tax_id',
    });
  });
});

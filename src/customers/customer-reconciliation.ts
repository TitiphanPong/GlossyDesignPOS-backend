import { isValidThaiTaxId } from './customer-import';

export type CustomerIdentitySource = {
  taxId?: string | null;
  branchNo?: string | null;
  branchType?: string | null;
  customerBranch?: string | null;
  branch?: string | null;
  customerName?: string | null;
  displayName?: string | null;
  companyName?: string | null;
  customerAddress?: string | null;
  address?: string | null;
};

export type ReconciliationCustomer = CustomerIdentitySource & {
  id: string;
  customerCode?: string;
  active?: boolean;
};

export type ReconciliationOrder = CustomerIdentitySource & {
  id: string;
  orderNumber?: string;
  invoiceNumber?: string;
  customerId?: string | null;
  customerTaxId?: string | null;
  status?: string;
};

export type ReconciliationAction = {
  orderId: string;
  orderNumber?: string;
  invoiceNumber?: string;
  normalizedTaxId?: string;
  branchNo?: string;
  identityKey?: string;
  action:
    | 'skip_linked'
    | 'skip_no_tax_id'
    | 'link_existing'
    | 'create_customer'
    | 'review';
  customerId?: string;
  reason: string;
};

export function normalizeTaxId(value?: string | null): string | undefined {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits || undefined;
}

function normalizeWhitespace(value?: string | null): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeExplicitBranchNo(value?: string | null): string | undefined {
  const text = normalizeWhitespace(value);
  if (!text) return undefined;
  const digits = text.replace(/\D/g, '');
  if (!digits || digits.length > 5) return undefined;
  return digits.padStart(5, '0');
}

export function normalizeBranchNo(
  input: CustomerIdentitySource,
): string | undefined {
  const explicit = normalizeExplicitBranchNo(input.branchNo);
  if (explicit) return explicit;

  const candidates = [
    input.branchType,
    input.customerBranch,
    input.branch,
    input.customerName,
    input.displayName,
    input.companyName,
    input.customerAddress,
    input.address,
  ];

  for (const raw of candidates) {
    const value = normalizeWhitespace(raw);
    if (!value) continue;

    const numericBranch = /(?:สาขา(?:ที่)?\s*|branch\s*)(\d{1,5})/i.exec(value);
    if (numericBranch) return numericBranch[1].padStart(5, '0');

    if (/สำนักงานใหญ่|head\s*office|headquarters/i.test(value)) {
      return '00000';
    }

    if (/สาขา/i.test(value)) {
      const parenthesized = /\((\d{1,5})\)/.exec(value);
      if (parenthesized) return parenthesized[1].padStart(5, '0');
    }
  }

  return undefined;
}

export function customerReconciliationIdentityKey(
  taxId: string,
  branchNo?: string,
): string {
  return `${taxId}|${branchNo ?? 'UNKNOWN'}`;
}

function chooseExistingCustomer(
  order: ReconciliationOrder,
  candidates: ReconciliationCustomer[],
): { customer?: ReconciliationCustomer; reason: string } {
  const orderBranch = normalizeBranchNo(order);
  if (candidates.length === 1) {
    const only = candidates[0];
    const customerBranch = normalizeBranchNo(only);
    if (orderBranch && customerBranch && orderBranch !== customerBranch) {
      return { reason: 'single_tax_id_match_has_conflicting_branch' };
    }
    return { customer: only, reason: 'single_tax_id_match' };
  }

  if (orderBranch) {
    const exactBranch = candidates.filter(
      (candidate) => normalizeBranchNo(candidate) === orderBranch,
    );
    if (exactBranch.length === 1) {
      return { customer: exactBranch[0], reason: 'unique_tax_id_branch_match' };
    }
    const activeExact = exactBranch.filter(
      (candidate) => candidate.active !== false,
    );
    if (exactBranch.length > 1 && activeExact.length === 1) {
      return {
        customer: activeExact[0],
        reason: 'unique_active_tax_id_branch_match',
      };
    }
  }

  const candidateBranches = new Set(
    candidates.map((candidate) => normalizeBranchNo(candidate) ?? 'UNKNOWN'),
  );
  const active = candidates.filter((candidate) => candidate.active !== false);
  if (candidateBranches.size === 1 && active.length === 1) {
    return { customer: active[0], reason: 'unique_active_same_branch_match' };
  }

  return { reason: 'duplicate_tax_id_requires_review' };
}

export function buildInvoiceCustomerReconciliationPlan(
  customers: ReconciliationCustomer[],
  orders: ReconciliationOrder[],
): ReconciliationAction[] {
  const customersByTaxId = new Map<string, ReconciliationCustomer[]>();
  for (const customer of customers) {
    const normalizedTaxId = normalizeTaxId(customer.taxId);
    if (!normalizedTaxId) continue;
    const group = customersByTaxId.get(normalizedTaxId) ?? [];
    group.push(customer);
    customersByTaxId.set(normalizedTaxId, group);
  }

  return orders.map((order) => {
    if (order.customerId) {
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        invoiceNumber: order.invoiceNumber,
        action: 'skip_linked',
        reason: 'order_already_has_customer_id',
      };
    }

    const normalizedTaxId = normalizeTaxId(order.customerTaxId ?? order.taxId);
    if (!normalizedTaxId) {
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        invoiceNumber: order.invoiceNumber,
        action: 'skip_no_tax_id',
        reason: 'invoice_has_no_tax_id',
      };
    }

    const branchNo = normalizeBranchNo(order);
    if (!isValidThaiTaxId(normalizedTaxId)) {
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        invoiceNumber: order.invoiceNumber,
        normalizedTaxId,
        branchNo,
        action: 'review',
        reason: 'invalid_thai_tax_id',
      };
    }

    const matches = customersByTaxId.get(normalizedTaxId) ?? [];
    if (matches.length === 0) {
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        invoiceNumber: order.invoiceNumber,
        normalizedTaxId,
        branchNo,
        identityKey: customerReconciliationIdentityKey(
          normalizedTaxId,
          branchNo,
        ),
        action: 'create_customer',
        reason: 'tax_id_branch_missing_from_customer_master',
      };
    }

    const selection = chooseExistingCustomer(order, matches);
    if (!selection.customer) {
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        invoiceNumber: order.invoiceNumber,
        normalizedTaxId,
        branchNo,
        action: 'review',
        reason: selection.reason,
      };
    }

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      invoiceNumber: order.invoiceNumber,
      normalizedTaxId,
      branchNo,
      action: 'link_existing',
      customerId: selection.customer.id,
      reason: selection.reason,
    };
  });
}

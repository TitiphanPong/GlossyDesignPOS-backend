export type TaxInvoiceReviewCode =
  | 'missing_invoice_number'
  | 'missing_book_number'
  | 'missing_invoice_sequence'
  | 'invoice_identity_without_tax_invoice_flag'
  | 'missing_invoice_period_fallback_sale_date'
  | 'missing_invoice_period_fallback_created_at'
  | 'cancelled_requires_corrective_document';

export type TaxInvoiceReviewReason = {
  code: TaxInvoiceReviewCode;
  label: string;
};

export type TaxInvoiceReportItem = {
  id: string;
  orderId: string;
  orderNumber: string;
  documentDate: string;
  invoicePeriod: string;
  invoicePeriodSource: 'invoicePeriod' | 'saleDate' | 'createdAt';
  invoiceNumber: string;
  bookNo: string;
  invoiceSequence: string;
  customerName: string;
  customerAddress: string;
  taxId: string;
  branch: string;
  subtotal: number;
  discount: number;
  taxableBase: number;
  vatAmount: number;
  grandTotal: number;
  paymentMethod: string;
  note: string;
  status: string;
  reportStatus: 'issued' | 'needs_review' | 'cancelled_review';
  reviewReasons: TaxInvoiceReviewReason[];
  cancellation?: {
    cancelledAt: string;
    reason: string;
    correctiveDocumentRequired: boolean;
    correctiveDocumentStatus: 'not_required' | 'required';
  };
  items: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
};

export type CrossPeriodCancellation = {
  id: string;
  orderId: string;
  orderNumber: string;
  invoicePeriod: string;
  invoiceNumber: string;
  bookNo: string;
  invoiceSequence: string;
  customerName: string;
  taxId: string;
  branch: string;
  taxableBase: number;
  vatAmount: number;
  grandTotal: number;
  cancellation: {
    cancelledAt: string;
    reason: string;
    correctiveDocumentRequired: boolean;
    correctiveDocumentStatus: 'not_required' | 'required';
  };
};

export type TaxInvoiceMonthlyReport = {
  period: string;
  periodLabel: string;
  generatedAt: string;
  timezone: 'Asia/Bangkok';
  summary: {
    documentCount: number;
    taxableBase: number;
    vatAmount: number;
    grandTotal: number;
    cancelledCount: number;
    cancelledOriginalTotals: {
      taxableBase: number;
      vatAmount: number;
      grandTotal: number;
    };
    reviewCount: number;
    crossPeriodCancellationCount: number;
  };
  documents: TaxInvoiceReportItem[];
  crossPeriodCancellations: CrossPeriodCancellation[];
};

export type TaxInvoiceExportResult = {
  buffer: Buffer;
  contentType: string;
  filename: string;
  count: number;
  reviewCount: number;
};

export type TaxInvoiceRenderFailure = {
  orderId: string;
  invoiceNumber: string;
  reasons: string[];
};

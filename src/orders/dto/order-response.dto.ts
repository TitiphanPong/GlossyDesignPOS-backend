import {
  OrderEntryMode,
  OrderStatus,
  OrderType,
  OrderWorkflowStatus,
  PaymentMethod,
} from '../orders.schema';

type OrderPaymentDto = {
  amount: number;
  method: PaymentMethod;
  note?: string;
  paidAt: Date;
};

type OrderFinancialAdjustmentDto = {
  type: 'refund';
  amount: number;
  method: PaymentMethod;
  reason: string;
  occurredAt: Date;
  changedBy: string;
  sourcePaymentIdempotencyKey?: string;
};

type OrderCartItemDto = {
  key?: string;
  productId?: string;
  productCode?: string;
  typeCode?: string;
  name: string;
  category?: string;
  variantName?: string;
  variant?: Record<string, unknown>;
  sides?: string;
  material?: string;
  colorMode?: string;
  type?: string;
  typePremium?: string;
  shape?: string;
  size?: string;
  setCount?: number;
  inkjetType?: string;
  sizeFlex?: { height: string; width: string }[];
  stickerPVCType?: string;
  plotPlanType?: string;
  qty: number;
  unitPrice: number;
  totalPrice: number;
  lineTotal?: number;
  productNote?: string;
  note?: string;
  deposit?: number;
  remaining?: number;
  fullPayment?: boolean;
};

export class OrderResponseDto {
  orderType!: OrderType;
  _id!: string;
  clientDraftId?: string;
  idempotencyKey?: string;
  orderId!: string;
  saleDate?: Date;
  entryMode!: OrderEntryMode;
  isBackdated!: boolean;
  backdatedReason?: string;
  orderNumber?: string;
  invoiceNumber?: string;
  bookNo?: string;
  invoiceSequence?: string;
  invoicePeriod?: string;
  customerName!: string;
  companyName?: string;
  phoneNumber!: string;
  email?: string;
  customerEmail?: string;
  address?: string;
  customerAddress?: string;
  taxId?: string;
  customerTaxId?: string;
  branch?: string;
  customerBranch?: string;
  branchType?: string;
  branchNo?: string;
  subDistrict?: string;
  district?: string;
  province?: string;
  postalCode?: string;
  shippingAddress?: string;
  note!: string;
  salesChannel?: string;
  total!: number;
  subtotal!: number;
  discount!: number;
  depositTotal!: number;
  paidAmount!: number;
  remainingTotal!: number;
  payment!: PaymentMethod;
  paymentMethod!: PaymentMethod;
  status!: OrderStatus;
  workflowStatus!: OrderWorkflowStatus;
  taxInvoice!: 'yes' | 'no';
  vatAmount!: number;
  grandTotal!: number;
  receivedAmount?: number;
  changeAmount?: number;
  payments!: OrderPaymentDto[];
  financialAdjustments!: OrderFinancialAdjustmentDto[];
  cancellation?: {
    reason: string;
    cancelledAt: Date;
    cancelledBy: string;
    refundedAmount: number;
    correctiveDocumentRequired: boolean;
    correctiveDocumentStatus: 'not_required' | 'required';
  };
  statusHistory!: {
    status: OrderStatus;
    note?: string;
    changedAt: Date;
    changedBy?: string;
  }[];
  cart!: OrderCartItemDto[];
  createdAt?: Date;
  updatedAt?: Date;
}

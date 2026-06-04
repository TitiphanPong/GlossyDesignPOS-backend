import { OrderStatus, PaymentMethod } from '../orders.schema';

type OrderPaymentDto = {
  amount: number;
  method: PaymentMethod;
  note?: string;
  paidAt: Date;
};

type OrderCartItemDto = {
  productId?: string;
  productCode?: string;
  typeCode?: string;
  name: string;
  category?: string;
  variantName?: string;
  variant?: Record<string, unknown>;
  sides?: number;
  material?: string;
  colorMode?: string;
  type?: string;
  shape?: string;
  size?: string;
  setCount?: number;
  inkjetType?: string;
  sizeFlex?: { height: string; width: string }[];
  stickerPVCType?: string;
  qty: number;
  unitPrice: number;
  totalPrice: number;
  productNote?: string;
  note?: string;
  deposit?: number;
  remaining?: number;
  fullPayment?: boolean;
};

export class OrderResponseDto {
  _id!: string;
  clientDraftId?: string;
  idempotencyKey?: string;
  orderId!: string;
  orderNumber?: string;
  customerName!: string;
  phoneNumber!: string;
  email?: string;
  address?: string;
  customerAddress?: string;
  taxId?: string;
  customerTaxId?: string;
  branch?: string;
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
  taxInvoice!: 'yes' | 'no';
  vatAmount!: number;
  grandTotal!: number;
  payments!: OrderPaymentDto[];
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

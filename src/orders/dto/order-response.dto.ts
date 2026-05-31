import { OrderStatus, PaymentMethod } from '../orders.schema';

type OrderPaymentDto = {
  amount: number;
  method: PaymentMethod;
  paidAt: Date;
};

type OrderCartItemDto = {
  name: string;
  category?: string;
  variant?: Record<string, unknown>;
  sides?: string;
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
  discount!: number;
  depositTotal!: number;
  remainingTotal!: number;
  payment!: PaymentMethod;
  status!: OrderStatus;
  taxInvoice!: 'yes' | 'no';
  vatAmount!: number;
  grandTotal!: number;
  payments!: OrderPaymentDto[];
  cart!: OrderCartItemDto[];
  createdAt?: Date;
  updatedAt?: Date;
}

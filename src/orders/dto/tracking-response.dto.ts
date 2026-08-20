import { OrderStatus, OrderType } from '../orders.schema';

type TrackingVariantDto = {
  id?: string;
  _id?: string;
  name: string;
  price?: number;
  note?: string;
  material?: string;
  sides?: string;
  size?: string;
  active?: boolean;
  custom?: boolean;
  width?: number;
  height?: number;
};

export type TrackingCartItemDto = {
  name: string;
  category?: string;
  variantName?: string;
  variant?: TrackingVariantDto;
  qty: number;
  quantity: number;
  price: number;
  unitPrice: number;
  totalPrice: number;
  lineTotal: number;
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
  deposit?: number;
  remaining?: number;
  fullPayment?: boolean;
  note?: string;
  productNote?: string;
};

export type TrackingItemSummaryDto = {
  name: string;
  category?: string;
  variantName?: string;
  qty: number;
};

export class TrackingOrderResponseDto {
  orderType!: OrderType;
  _id!: string;
  orderId!: string;
  orderNumber?: string;
  invoiceNumber?: string;
  status!: OrderStatus;
  customerName!: string;
  phoneNumber?: string;
  phone?: string;
  total!: number;
  createdAt?: Date;
  updatedAt?: Date;
  cart!: TrackingCartItemDto[];
  items!: TrackingItemSummaryDto[];
  grandTotal!: number;
  paidAmount!: number;
  remainingTotal!: number;
  statusHistory!: {
    status: OrderStatus;
    note?: string;
    changedAt: Date;
    changedBy?: string;
  }[];
  estimatedReadyAt?: Date;
}

export type TrackingSearchResponseDto = {
  data: TrackingOrderResponseDto[];
  total: number;
};

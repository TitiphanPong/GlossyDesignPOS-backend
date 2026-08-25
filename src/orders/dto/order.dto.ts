import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ORDER_ENTRY_MODES,
  ORDER_STATUSES,
  ORDER_TYPES,
  PAYMENT_METHODS,
} from '../orders.schema';
import type { OrderStatus, OrderType, PaymentMethod } from '../orders.schema';
import { transformOptionalString } from '../../common/transforms/optional-string.transform';

export class PriceOverrideDto {
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0.01)
  unitPrice!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  reason!: string;
}

export class OrderDiscountDto {
  @IsIn(['amount', 'percent'])
  type!: 'amount' | 'percent';

  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(100_000_000)
  value!: number;
}

export class InitialPaymentDto {
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0.01)
  amount!: number;

  @IsIn(PAYMENT_METHODS)
  method!: PaymentMethod;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  receivedAmount?: number;
}

export class OrderItemSizeFlexDto {
  @IsString()
  height!: string;

  @IsString()
  width!: string;
}

export class OrderItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  productId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  productCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  typeCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  variantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  variantName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  customName?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => PriceOverrideDto)
  priceOverride?: PriceOverrideDto;

  @IsOptional()
  @IsString()
  material?: string;

  @IsOptional()
  @IsString()
  colorMode?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  typePremium?: string;

  @IsOptional()
  @IsString()
  shape?: string;

  @IsOptional()
  @IsString()
  size?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  setCount?: number;

  @IsOptional()
  @IsString()
  inkjetType?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemSizeFlexDto)
  sizeFlex?: OrderItemSizeFlexDto[];

  @IsOptional()
  @IsString()
  stickerPVCType?: string;

  @IsOptional()
  @IsString()
  plotPlanType?: string;

  @IsOptional()
  @Transform(transformOptionalString)
  @IsString()
  sides?: string;

  @IsOptional()
  @IsString()
  productNote?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  fullPayment?: boolean;
}

export class CreateOrderDto {
  @IsOptional()
  @IsIn(ORDER_TYPES)
  orderType?: OrderType;

  @IsOptional()
  @IsIn(ORDER_ENTRY_MODES)
  entryMode?: 'normal' | 'backdated';

  @IsOptional()
  @IsDateString()
  saleDate?: string;

  @IsOptional()
  @IsString()
  backdatedReason?: string;

  @IsOptional()
  @IsString()
  clientDraftId?: string;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  customerEmail?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  customerAddress?: string;

  @IsOptional()
  @IsString()
  taxId?: string;

  @IsOptional()
  @IsString()
  customerTaxId?: string;

  @IsOptional()
  @IsString()
  branch?: string;

  @IsOptional()
  @IsString()
  customerBranch?: string;

  @IsOptional()
  @IsString()
  branchType?: string;

  @IsOptional()
  @IsString()
  branchNo?: string;

  @IsOptional()
  @IsString()
  subDistrict?: string;

  @IsOptional()
  @IsString()
  district?: string;

  @IsOptional()
  @IsString()
  province?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsString()
  shippingAddress?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  salesChannel?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OrderDiscountDto)
  discount?: OrderDiscountDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => InitialPaymentDto)
  initialPayment?: InitialPaymentDto;

  @IsOptional()
  @IsIn(['yes', 'no'])
  taxInvoice?: 'yes' | 'no';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  cart!: OrderItemDto[];
}

export class UpdateOrderStatusDto {
  @IsIn(ORDER_STATUSES)
  status!: OrderStatus;

  @IsOptional()
  @IsString()
  statusNote?: string;
}

export class AddPaymentDto {
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0.01)
  amount!: number;

  @IsIn(PAYMENT_METHODS)
  method!: PaymentMethod;

  @IsOptional()
  @IsString()
  note?: string;
}

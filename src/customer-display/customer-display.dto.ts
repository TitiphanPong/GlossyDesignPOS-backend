import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CustomerDisplayCartItemDto {
  @IsString()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsNumber()
  @Min(0)
  qty!: number;

  @IsNumber()
  @Min(0)
  totalPrice!: number;

  @IsOptional()
  @IsBoolean()
  fullPayment?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  deposit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  remaining?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  material?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  variantName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  size?: string;
}

export class CustomerDisplayStateDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  orderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  orderNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  clientDraftId?: string;

  @IsNumber()
  @Min(0)
  total!: number;

  @IsNumber()
  @Min(0)
  discount!: number;

  @IsNumber()
  @Min(0)
  grandTotal!: number;

  @IsIn(['cash', 'promptpay'])
  payment!: 'cash' | 'promptpay';

  @IsIn([
    'pending',
    'awaiting_payment',
    'partial',
    'paid',
    'producing',
    'ready_for_pickup',
    'delivered',
    'cancelled',
  ])
  status!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerDisplayCartItemDto)
  cart!: CustomerDisplayCartItemDto[];

  @IsOptional()
  @IsIn(['yes', 'no'])
  taxInvoice?: 'yes' | 'no';

  @IsOptional()
  @IsNumber()
  @Min(0)
  vatAmount?: number;

  @IsNumber()
  @Min(0)
  remainingTotal!: number;

  @IsOptional()
  @IsIn(['pending', 'submitting', 'submitted'])
  orderSyncStatus?: 'pending' | 'submitting' | 'submitted';
}

export class UpdateCustomerDisplayStateDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerDisplayStateDto)
  state?: CustomerDisplayStateDto | null;
}

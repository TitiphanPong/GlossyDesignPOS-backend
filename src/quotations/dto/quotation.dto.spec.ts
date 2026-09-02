import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  ApproveQuotationDto,
  CreateQuotationDto,
  UpdateQuotationDto,
} from './quotation.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function transformCreate(value: unknown): Promise<CreateQuotationDto> {
  const transformed: unknown = await pipe.transform(value, {
    type: 'body',
    metatype: CreateQuotationDto,
  });
  return transformed as CreateQuotationDto;
}

async function transformUpdate(value: unknown): Promise<UpdateQuotationDto> {
  const transformed: unknown = await pipe.transform(value, {
    type: 'body',
    metatype: UpdateQuotationDto,
  });
  return transformed as UpdateQuotationDto;
}

async function transformApprove(value: unknown): Promise<ApproveQuotationDto> {
  const transformed: unknown = await pipe.transform(value, {
    type: 'body',
    metatype: ApproveQuotationDto,
  });
  return transformed as ApproveQuotationDto;
}

describe('Quotation DTO security boundary', () => {
  it('rejects oversized quotation item and size-flex collections before persistence', async () => {
    await expect(
      transformCreate({
        items: Array.from({ length: 251 }, () => ({
          customName: 'Bounded quotation item',
          quantity: 1,
        })),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      transformCreate({
        items: [
          {
            customName: 'Bounded flexible-size item',
            quantity: 1,
            sizeFlex: Array.from({ length: 251 }, () => ({
              height: '1',
              width: '1',
            })),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['status', 'subtotal', 'discountValue', 'vatAmount', 'grandTotal'])(
    'rejects generic PATCH field %s',
    async (field) => {
      await expect(
        transformUpdate({
          version: 0,
          [field]: field === 'status' ? 'APPROVED' : 1,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('requires a note when staff records customer approval', async () => {
    await expect(transformApprove({ version: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    await expect(
      transformApprove({
        version: 0,
        reason: 'ลูกค้ายืนยันราคาทาง LINE โดยพนักงานบันทึกแทน',
      }),
    ).resolves.toMatchObject({ version: 0 });
  });

  it('accepts editable Draft fields plus optimistic concurrency version', async () => {
    const value = await transformUpdate({
      version: 3,
      subject: 'งานพิมพ์นามบัตร',
      taxInvoiceRequested: true,
      discount: { type: 'percent', value: 10 },
    });

    expect(value).toMatchObject({
      version: 3,
      subject: 'งานพิมพ์นามบัตร',
      taxInvoiceRequested: true,
      discount: { type: 'percent', value: 10 },
    });
  });
});

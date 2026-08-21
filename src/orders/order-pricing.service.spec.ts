import { BadRequestException } from '@nestjs/common';
import { Model } from 'mongoose';
import { ProductDocument } from '../products/product.schema';
import { QuickProductDocument } from '../quick-products/quick-product.schema';
import { OrderPricingService } from './order-pricing.service';

type ModelLike = {
  findOne: jest.Mock;
};

function queryResult(value: unknown) {
  return { exec: jest.fn().mockResolvedValue(value) };
}

describe('OrderPricingService', () => {
  const product = {
    _id: { toString: () => '61a1c287e53a7024d4ab8142' },
    name: 'A4 Print',
    code: 'A4',
    typeCode: 'document-print',
    category: 'Document',
    active: true,
    variants: [
      {
        _id: { toString: () => '61a1c287e53a7024d4ab8143' },
        name: 'Default',
        price: 2.5,
        active: true,
      },
    ],
  };

  let productModel: ModelLike;
  let quickProductModel: ModelLike;
  let service: OrderPricingService;

  beforeEach(() => {
    productModel = { findOne: jest.fn().mockReturnValue(queryResult(product)) };
    quickProductModel = {
      findOne: jest.fn().mockReturnValue(queryResult(product)),
    };
    service = new OrderPricingService(
      productModel as unknown as Model<ProductDocument>,
      quickProductModel as unknown as Model<QuickProductDocument>,
    );
  });

  it('resolves catalog identity and snapshots the server-owned variant price', async () => {
    const [line] = await service.resolveCart('QUICK_SALE', [
      { productCode: 'A4', quantity: 3 },
    ]);

    expect(quickProductModel.findOne).toHaveBeenCalledWith({
      active: true,
      $or: [{ code: 'A4' }],
    });
    expect(line).toEqual(
      expect.objectContaining({
        productCode: 'A4',
        name: 'A4 Print',
        qty: 3,
        unitPrice: 2.5,
        totalPrice: 7.5,
      }),
    );
  });

  it('requires an explicit reason for custom/manual pricing at the DTO boundary', async () => {
    const [line] = await service.resolveCart(
      'NORMAL',
      [
        {
          customName: 'Custom artwork',
          quantity: 2,
          priceOverride: { unitPrice: 125.55, reason: 'approved quote Q-100' },
        },
      ],
      'manager',
    );

    expect(productModel.findOne).not.toHaveBeenCalled();
    expect(line).toEqual(
      expect.objectContaining({
        name: 'Custom artwork',
        qty: 2,
        unitPrice: 125.55,
        totalPrice: 251.1,
      }),
    );
  });

  it('rejects missing/unavailable identities and zero prices', async () => {
    productModel.findOne.mockReturnValue(queryResult(null));
    await expect(
      service.resolveCart('NORMAL', [{ productCode: 'missing', quantity: 1 }]),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.resolveCart(
        'NORMAL',
        [
          {
            customName: 'Free item',
            quantity: 1,
            priceOverride: { unitPrice: 0, reason: 'tampered' },
          },
        ],
        'admin',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects price overrides without manager/admin authorization', async () => {
    await expect(
      service.resolveCart(
        'NORMAL',
        [
          {
            customName: 'Unapproved custom item',
            quantity: 1,
            priceOverride: { unitPrice: 100, reason: 'self approved' },
          },
        ],
        'staff',
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

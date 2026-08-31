import { BadRequestException } from '@nestjs/common';
import { Model } from 'mongoose';
import { StockItemDocument } from '../inventory/schemas/stock-item.schema';
import { ProductDocument } from './product.schema';
import { ProductService } from './product.service';

const stockItemId = '64b000000000000000000010';

function makeService(stockUnit = 'sheet') {
  const create = jest.fn().mockResolvedValue({ _id: 'created' });
  const productModel = { create } as unknown as Model<ProductDocument>;
  const stockExec = jest
    .fn()
    .mockResolvedValue([{ _id: stockItemId, unit: stockUnit }]);
  const lean = jest.fn().mockReturnValue({ exec: stockExec });
  const select = jest.fn().mockReturnValue({ lean });
  const find = jest.fn().mockReturnValue({ select });
  const stockItemModel = { find } as unknown as Model<StockItemDocument>;

  return {
    service: new ProductService(productModel, stockItemModel),
    create,
    find,
  };
}

describe('ProductService material recipes', () => {
  it('validates canonical stock items and normalizes product and variant recipes', async () => {
    const { service, create, find } = makeService('sheet');

    await service.create({
      name: 'A4 Print',
      code: 'A4 PRINT',
      category: 'Document',
      recipe: [
        {
          stockItemId: ` ${stockItemId} `,
          quantity: 2,
          unit: ' sheet ',
        },
      ],
      variants: [
        {
          name: 'Color',
          price: 10,
          recipe: [
            {
              stockItemId,
              quantity: 1,
              unit: 'sheet',
            },
          ],
        },
      ],
    });

    expect(find).toHaveBeenCalledWith({
      _id: { $in: [stockItemId] },
      active: { $ne: false },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'a4-print',
        recipe: [
          {
            stockItemId,
            quantity: 2,
            unit: 'sheet',
            conversionFactor: undefined,
          },
        ],
        variants: [
          expect.objectContaining({
            name: 'Color',
            active: true,
            recipe: [
              {
                stockItemId,
                quantity: 1,
                unit: 'sheet',
                conversionFactor: undefined,
              },
            ],
          }),
        ],
      }),
    );
  });

  it('rejects a recipe unit mismatch without an explicit conversion factor', async () => {
    const { service, create } = makeService('m');

    await expect(
      service.create({
        name: 'Sticker',
        category: 'Sticker',
        recipe: [
          {
            stockItemId,
            quantity: 50,
            unit: 'cm',
          },
        ],
        variants: [{ name: 'Default', price: 100 }],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts a recipe unit mismatch when an explicit conversion factor is provided', async () => {
    const { service, create } = makeService('m');

    await expect(
      service.create({
        name: 'Sticker',
        category: 'Sticker',
        recipe: [
          {
            stockItemId,
            quantity: 50,
            unit: 'cm',
            conversionFactor: 0.01,
          },
        ],
        variants: [{ name: 'Default', price: 100 }],
      }),
    ).resolves.toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

import { Model } from 'mongoose';
import { QuickProductDocument } from './quick-product.schema';
import { QuickProductService } from './quick-product.service';

describe('QuickProductService', () => {
  const storedProducts = [
    { id: 'b', name: 'B', quickSaleSortOrder: 0 },
    { id: 'a', name: 'A', quickSaleSortOrder: 1 },
  ];
  const exec = jest.fn(() => Promise.resolve(storedProducts));
  const sort = jest.fn(() => ({ exec }));
  const find = jest.fn(() => ({ sort }));
  const bulkWrite = jest.fn(() => Promise.resolve({}));
  const quickProductModel = {
    find,
    bulkWrite,
  } as unknown as Model<QuickProductDocument>;

  const service = new QuickProductService(quickProductModel);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reorder writes each sort order in one unordered bulkWrite', async () => {
    await service.reorder([
      { id: '64b000000000000000000001', quickSaleSortOrder: 0 },
      { id: '64b000000000000000000002', quickSaleSortOrder: 1 },
    ]);

    expect(bulkWrite).toHaveBeenCalledTimes(1);
    expect(bulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: { _id: '64b000000000000000000001' },
            update: { $set: { quickSaleSortOrder: 0 } },
          },
        },
        {
          updateOne: {
            filter: { _id: '64b000000000000000000002' },
            update: { $set: { quickSaleSortOrder: 1 } },
          },
        },
      ],
      { ordered: false },
    );
  });

  it('reorder returns the full re-sorted list including inactive items', async () => {
    const result = await service.reorder([
      { id: '64b000000000000000000001', quickSaleSortOrder: 0 },
    ]);

    expect(find).toHaveBeenCalledWith({});
    expect(sort).toHaveBeenCalledWith({ quickSaleSortOrder: 1, name: 1 });
    expect(result).toBe(storedProducts);
  });
});

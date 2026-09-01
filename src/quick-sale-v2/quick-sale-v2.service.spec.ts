import { BadRequestException } from '@nestjs/common';
import type { Model } from 'mongoose';
import type { QuickProductDocument } from '../quick-products/quick-product.schema';
import type { QuickSaleV2ConfigDocument } from './quick-sale-v2.schema';
import { QuickSaleV2Service } from './quick-sale-v2.service';

const productIdA = '61a1c287e53a7024d4ab8150';
const productIdB = '61a1c287e53a7024d4ab8151';
const defaults = {
  workType: 'print' as const,
  size: 'A4' as const,
  colorMode: 'bw' as const,
  quantity: 10,
};

function serviceWith({
  count = 0,
  findOneValue = null,
  updatedValue = null,
}: { count?: number; findOneValue?: unknown; updatedValue?: unknown } = {}) {
  const execFindOne = jest.fn().mockResolvedValue(findOneValue);
  const leanFindOne = jest.fn().mockReturnValue({ exec: execFindOne });
  const findOne = jest.fn().mockReturnValue({ lean: leanFindOne });

  const execUpdate = jest.fn().mockResolvedValue(updatedValue);
  const leanUpdate = jest.fn().mockReturnValue({ exec: execUpdate });
  const updates: unknown[] = [];
  const findOneAndUpdate = jest.fn((filter: unknown, update: unknown) => {
    void filter;
    updates.push(update);
    return { lean: leanUpdate };
  });

  const execCount = jest.fn().mockResolvedValue(count);
  const countDocuments = jest.fn().mockReturnValue({ exec: execCount });

  return {
    service: new QuickSaleV2Service(
      {
        findOne,
        findOneAndUpdate,
      } as unknown as Model<QuickSaleV2ConfigDocument>,
      { countDocuments } as unknown as Model<QuickProductDocument>,
    ),
    findOneAndUpdate,
    updates,
    countDocuments,
  };
}

describe('QuickSaleV2Service', () => {
  it('rejects duplicate option combinations instead of allowing ambiguous SKU resolution', async () => {
    const { service } = serviceWith();

    await expect(
      service.updateDraft(
        [
          {
            workType: 'print',
            size: 'A4',
            colorMode: 'bw',
            quickProductId: productIdA,
          },
          {
            workType: 'print',
            size: 'A4',
            colorMode: 'bw',
            quickProductId: productIdB,
          },
        ],
        defaults,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a draft mapping that references a missing Quick Product', async () => {
    const { service, countDocuments } = serviceWith({ count: 0 });

    await expect(
      service.updateDraft(
        [
          {
            workType: 'print',
            size: 'A4',
            colorMode: 'bw',
            quickProductId: productIdA,
          },
        ],
        defaults,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(countDocuments).toHaveBeenCalledTimes(1);
  });

  it('saves document defaults separately with the draft mappings', async () => {
    const stored = {
      key: 'default',
      draftMappings: [
        {
          workType: 'print',
          size: 'A4',
          colorMode: 'bw',
          quickProductId: productIdA,
        },
      ],
      draftDefaults: defaults,
      publishedVersion: 2,
      updatedAt: new Date('2026-09-01T06:00:00.000Z'),
    };
    const { service, findOneAndUpdate, updates } = serviceWith({
      count: 1,
      updatedValue: stored,
    });

    const result = await service.updateDraft(
      [
        {
          workType: 'print',
          size: 'A4',
          colorMode: 'bw',
          quickProductId: productIdA,
        },
      ],
      defaults,
    );

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(updates[0]).toMatchObject({ $set: { draftDefaults: defaults } });
    expect(result.defaults).toEqual(defaults);
  });

  it('rejects publish when the configured default combination has no explicit mapping', async () => {
    const { service, countDocuments } = serviceWith({
      count: 1,
      findOneValue: {
        draftMappings: [
          {
            workType: 'copy',
            size: 'A3',
            colorMode: 'color',
            quickProductId: productIdA,
          },
        ],
        draftDefaults: defaults,
        publishedVersion: 2,
      },
    });

    await expect(service.publish()).rejects.toBeInstanceOf(BadRequestException);
    expect(countDocuments).not.toHaveBeenCalled();
  });

  it('publishes mappings and defaults only after revalidating every mapped Quick Product', async () => {
    const draft = [
      {
        workType: 'print' as const,
        size: 'A4' as const,
        colorMode: 'bw' as const,
        quickProductId: productIdA,
      },
    ];
    const published = {
      key: 'default',
      draftMappings: draft,
      draftDefaults: defaults,
      publishedMappings: draft,
      publishedDefaults: defaults,
      publishedVersion: 3,
      updatedAt: new Date('2026-09-01T06:00:00.000Z'),
    };
    const { service, countDocuments, findOneAndUpdate, updates } = serviceWith({
      count: 1,
      findOneValue: { ...published, publishedVersion: 2 },
      updatedValue: published,
    });

    const result = await service.publish();

    expect(countDocuments).toHaveBeenCalledTimes(1);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(updates[0]).toMatchObject({
      $set: { publishedDefaults: defaults },
      $inc: { publishedVersion: 1 },
    });
    expect(result.version).toBe(3);
    expect(result.defaults).toEqual(defaults);
    expect(result.mappings[0]?.quickProductId).toBe(productIdA);
  });
});

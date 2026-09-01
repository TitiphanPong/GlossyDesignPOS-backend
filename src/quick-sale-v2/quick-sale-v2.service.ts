import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  QuickProduct,
  QuickProductDocument,
} from '../quick-products/quick-product.schema';
import { QuickSaleV2DocumentMappingDto } from './quick-sale-v2.dto';
import {
  QuickSaleV2Config,
  QuickSaleV2ConfigDocument,
} from './quick-sale-v2.schema';

const CONFIG_KEY = 'default';

type MappingResponse = QuickSaleV2DocumentMappingDto;

type ConfigResponse = {
  mappings: MappingResponse[];
  version: number;
  updatedAt: string | null;
};

@Injectable()
export class QuickSaleV2Service {
  constructor(
    @InjectModel(QuickSaleV2Config.name)
    private readonly configModel: Model<QuickSaleV2ConfigDocument>,
    @InjectModel(QuickProduct.name)
    private readonly quickProductModel: Model<QuickProductDocument>,
  ) {}

  async getPublished(): Promise<ConfigResponse> {
    const config = await this.configModel
      .findOne({ key: CONFIG_KEY })
      .lean()
      .exec();
    return this.toResponse(
      config?.publishedMappings ?? [],
      config?.publishedVersion ?? 0,
      config?.updatedAt,
    );
  }

  async getDraft(): Promise<ConfigResponse> {
    const config = await this.configModel
      .findOne({ key: CONFIG_KEY })
      .lean()
      .exec();
    return this.toResponse(
      config?.draftMappings ?? [],
      config?.publishedVersion ?? 0,
      config?.updatedAt,
    );
  }

  async updateDraft(
    mappings: QuickSaleV2DocumentMappingDto[],
  ): Promise<ConfigResponse> {
    this.assertUniqueCombinations(mappings);
    await this.assertQuickProductsExist(mappings, false);

    const draftMappings = mappings.map((mapping) => ({
      ...mapping,
      quickProductId: new Types.ObjectId(mapping.quickProductId),
    }));

    const config = await this.configModel
      .findOneAndUpdate(
        { key: CONFIG_KEY },
        { $set: { draftMappings }, $setOnInsert: { key: CONFIG_KEY } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();

    return this.toResponse(
      config?.draftMappings ?? [],
      config?.publishedVersion ?? 0,
      config?.updatedAt,
    );
  }

  async publish(): Promise<ConfigResponse> {
    const config = await this.configModel
      .findOne({ key: CONFIG_KEY })
      .lean()
      .exec();
    const draftMappings = config?.draftMappings ?? [];
    const dtoMappings = draftMappings.map((mapping) => ({
      workType: mapping.workType,
      size: mapping.size,
      colorMode: mapping.colorMode,
      quickProductId: mapping.quickProductId.toString(),
    }));

    this.assertUniqueCombinations(dtoMappings);
    await this.assertQuickProductsExist(dtoMappings, true);

    const published = await this.configModel
      .findOneAndUpdate(
        { key: CONFIG_KEY },
        {
          $set: { publishedMappings: draftMappings },
          $inc: { publishedVersion: 1 },
          $setOnInsert: { key: CONFIG_KEY },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();

    return this.toResponse(
      published?.publishedMappings ?? [],
      published?.publishedVersion ?? 0,
      published?.updatedAt,
    );
  }

  private assertUniqueCombinations(
    mappings: QuickSaleV2DocumentMappingDto[],
  ): void {
    const keys = mappings.map(
      (mapping) => `${mapping.workType}:${mapping.size}:${mapping.colorMode}`,
    );
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException(
        'Quick Sale V2 contains duplicate document option mappings',
      );
    }
  }

  private async assertQuickProductsExist(
    mappings: QuickSaleV2DocumentMappingDto[],
    requireSellable: boolean,
  ): Promise<void> {
    const ids = [...new Set(mappings.map((mapping) => mapping.quickProductId))];
    if (ids.length === 0) return;

    const filter: Record<string, unknown> = {
      _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    };
    if (requireSellable) {
      filter.active = true;
      filter.quickSaleEnabled = true;
    }

    const count = await this.quickProductModel.countDocuments(filter).exec();
    if (count !== ids.length) {
      throw new BadRequestException(
        requireSellable
          ? 'Every published Quick Sale V2 mapping must reference an active Quick Product enabled for Quick Sale'
          : 'Every Quick Sale V2 mapping must reference an existing Quick Product',
      );
    }
  }

  private toResponse(
    mappings: Array<{
      workType: 'print' | 'copy' | 'scan';
      size: 'A4' | 'A3';
      colorMode: 'bw' | 'color';
      quickProductId: Types.ObjectId;
    }>,
    version: number,
    updatedAt?: Date,
  ): ConfigResponse {
    return {
      mappings: mappings.map((mapping) => ({
        workType: mapping.workType,
        size: mapping.size,
        colorMode: mapping.colorMode,
        quickProductId: mapping.quickProductId.toString(),
      })),
      version,
      updatedAt: updatedAt ? updatedAt.toISOString() : null,
    };
  }
}

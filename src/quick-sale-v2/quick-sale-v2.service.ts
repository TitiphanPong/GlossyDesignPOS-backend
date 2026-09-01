import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  QuickProduct,
  QuickProductDocument,
} from '../quick-products/quick-product.schema';
import {
  QuickSaleV2DocumentDefaultsDto,
  QuickSaleV2DocumentMappingDto,
} from './quick-sale-v2.dto';
import {
  QuickSaleV2Config,
  QuickSaleV2ConfigDocument,
} from './quick-sale-v2.schema';

const CONFIG_KEY = 'default';
const DEFAULT_DOCUMENT_DEFAULTS: QuickSaleV2DocumentDefaultsDto = {
  workType: 'print',
  size: 'A4',
  colorMode: 'bw',
  quantity: 1,
};

type MappingResponse = QuickSaleV2DocumentMappingDto;

type ConfigResponse = {
  mappings: MappingResponse[];
  defaults: QuickSaleV2DocumentDefaultsDto;
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
      config?.publishedDefaults ?? DEFAULT_DOCUMENT_DEFAULTS,
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
      config?.draftDefaults ?? DEFAULT_DOCUMENT_DEFAULTS,
      config?.publishedVersion ?? 0,
      config?.updatedAt,
    );
  }

  async updateDraft(
    mappings: QuickSaleV2DocumentMappingDto[],
    defaults: QuickSaleV2DocumentDefaultsDto,
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
        {
          $set: { draftMappings, draftDefaults: defaults },
          $inc: { draftRevision: 1 },
          $setOnInsert: { key: CONFIG_KEY },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();

    return this.toResponse(
      config?.draftMappings ?? [],
      config?.draftDefaults ?? defaults,
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
    const draftDefaults = config?.draftDefaults ?? DEFAULT_DOCUMENT_DEFAULTS;
    const draftRevision = config?.draftRevision ?? 0;
    const dtoMappings = draftMappings.map((mapping) => ({
      workType: mapping.workType,
      size: mapping.size,
      colorMode: mapping.colorMode,
      quickProductId: mapping.quickProductId.toString(),
    }));

    this.assertUniqueCombinations(dtoMappings);
    this.assertDefaultCombinationMapped(dtoMappings, draftDefaults);
    await this.assertQuickProductsExist(dtoMappings, true);

    const published = await this.configModel
      .findOneAndUpdate(
        {
          key: CONFIG_KEY,
          $or:
            draftRevision === 0
              ? [{ draftRevision: 0 }, { draftRevision: { $exists: false } }]
              : [{ draftRevision }],
        },
        {
          $set: {
            publishedMappings: draftMappings,
            publishedDefaults: draftDefaults,
          },
          $inc: { publishedVersion: 1 },
        },
        { new: true },
      )
      .lean()
      .exec();

    if (!published) {
      throw new ConflictException(
        'Quick Sale V2 draft changed during publish; reload and publish the latest draft',
      );
    }

    return this.toResponse(
      published.publishedMappings ?? [],
      published?.publishedDefaults ?? draftDefaults,
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

  private assertDefaultCombinationMapped(
    mappings: QuickSaleV2DocumentMappingDto[],
    defaults: QuickSaleV2DocumentDefaultsDto,
  ): void {
    const defaultKey = `${defaults.workType}:${defaults.size}:${defaults.colorMode}`;
    const mapped = mappings.some(
      (mapping) =>
        `${mapping.workType}:${mapping.size}:${mapping.colorMode}` ===
        defaultKey,
    );
    if (!mapped) {
      throw new BadRequestException(
        'Quick Sale V2 document defaults must reference a mapped option combination before publish',
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
    defaults: {
      workType: 'print' | 'copy' | 'scan';
      size: 'A4' | 'A3';
      colorMode: 'bw' | 'color';
      quantity: number;
    },
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
      defaults: {
        workType: defaults.workType,
        size: defaults.size,
        colorMode: defaults.colorMode,
        quantity: defaults.quantity,
      },
      version,
      updatedAt: updatedAt ? updatedAt.toISOString() : null,
    };
  }
}

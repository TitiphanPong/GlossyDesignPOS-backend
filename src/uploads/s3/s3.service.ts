import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly kmsKeyId?: string;

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.get<string>('AWS_REGION');
    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>(
      'AWS_SECRET_ACCESS_KEY',
    );
    const bucket = this.configService.get<string>('AWS_S3_BUCKET_PRIVATE');

    if (!region || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error(
        'Missing AWS config. Required: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET_PRIVATE',
      );
    }

    this.bucket = bucket;
    const rawKmsKeyId = this.configService.get<string>('AWS_S3_KMS_KEY_ID');
    this.kmsKeyId = rawKmsKeyId?.trim() ? rawKmsKeyId.trim() : undefined;

    this.s3Client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async uploadPrivateObject(params: {
    key: string;
    body: Buffer;
    contentType: string;
    contentLength: number;
    metadata: Record<string, string>;
  }): Promise<void> {
    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: params.key,
          Body: params.body,
          ContentType: params.contentType,
          ContentLength: params.contentLength,
          Metadata: params.metadata,
          ...(this.kmsKeyId
            ? { ServerSideEncryption: ServerSideEncryption.aws_kms }
            : {}),
          ...(this.kmsKeyId ? { SSEKMSKeyId: this.kmsKeyId } : {}),
        }),
      );
    } catch (error) {
      this.logger.error(
        `Failed to upload S3 key ${params.key}`,
        error as Error,
      );
      throw new InternalServerErrorException('Failed to upload file');
    }
  }

  async createSignedDownloadUrl(
    key: string,
    expiresInSeconds = 300,
  ): Promise<string> {
    return getSignedUrl(
      this.s3Client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
    } catch (error) {
      this.logger.error(`Failed to delete S3 key ${key}`, error as Error);
      throw new InternalServerErrorException('Failed to delete file');
    }
  }
}

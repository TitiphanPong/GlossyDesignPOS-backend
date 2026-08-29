import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { S3Service } from './uploads/s3/s3.service';

const READINESS_TIMEOUT_MS = 2_500;

export type ReadinessDependencyStatus = 'ready' | 'unready';

export type ReadinessDetails = {
  status: 'ready' | 'unready';
  checkedAt: string;
  dependencies: {
    database: ReadinessDependencyStatus;
    objectStorage: ReadinessDependencyStatus;
  };
};

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly s3Service: S3Service,
  ) {}

  async isReady(): Promise<boolean> {
    const details = await this.getReadinessDetails();
    return details.status === 'ready';
  }

  async getReadinessDetails(): Promise<ReadinessDetails> {
    const mongoCheck = this.connection.db
      ? this.connection.db
          .admin()
          .ping()
          .then(() => undefined)
      : Promise.reject(new Error('MongoDB connection is not initialized'));

    const [mongo, s3] = await Promise.allSettled([
      this.withTimeout(
        mongoCheck,
        READINESS_TIMEOUT_MS,
        'MongoDB readiness check timed out',
      ),
      this.s3Service.checkReadiness(READINESS_TIMEOUT_MS),
    ]);

    if (mongo.status === 'rejected') {
      this.logger.warn('Readiness check failed: MongoDB unavailable');
    }

    if (s3.status === 'rejected') {
      this.logger.warn('Readiness check failed: S3 unavailable');
    }

    const database: ReadinessDependencyStatus =
      mongo.status === 'fulfilled' ? 'ready' : 'unready';
    const objectStorage: ReadinessDependencyStatus =
      s3.status === 'fulfilled' ? 'ready' : 'unready';

    return {
      status:
        database === 'ready' && objectStorage === 'ready' ? 'ready' : 'unready',
      checkedAt: new Date().toISOString(),
      dependencies: {
        database,
        objectStorage,
      },
    };
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Throttle } from '@nestjs/throttler';
import { UploadsService } from './uploads.service';
import { CreateUploadDto } from './dto/create-upload.dto';
import { UploadResponseDto } from './dto/upload-response.dto';
import {
  MAX_FILE_SIZE_BYTES,
  validateUploadedFiles,
} from './validators/upload-file.validator';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: memoryStorage(),
      limits: {
        files: 10,
        fileSize: MAX_FILE_SIZE_BYTES,
      },
    }),
  )
  async createUpload(
    @Body() dto: CreateUploadDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ): Promise<UploadResponseDto> {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    validateUploadedFiles(files);
    return this.uploadsService.createUpload(dto, files);
  }
}

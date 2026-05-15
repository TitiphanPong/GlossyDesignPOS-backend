import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
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
import { ListUploadsQueryDto } from './dto/list-uploads-query.dto';
import { UpdateUploadDto } from './dto/update-upload.dto';
import {
  MAX_FILE_SIZE_BYTES,
  validateUploadedFiles,
} from './validators/upload-file.validator';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Get()
  async listUploads(@Query() query: ListUploadsQueryDto) {
    return this.uploadsService.listUploads(query);
  }

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

  @Patch(':id')
  async updateUpload(@Param('id') id: string, @Body() dto: UpdateUploadDto) {
    const updated = await this.uploadsService.updateUploadById(id, dto);
    if (!updated) {
      throw new NotFoundException('Upload not found');
    }
    return updated;
  }

  @Delete(':id')
  async deleteUpload(@Param('id') id: string) {
    const deleted = await this.uploadsService.deleteUploadById(id);
    if (!deleted) {
      throw new NotFoundException('Upload not found');
    }
    return { message: 'Upload deleted' };
  }
}

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
  Request,
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
import { Public, Roles } from '../auth/auth.decorators';
import { AuditService } from '../auth/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';

type AuthRequest = { user?: AuthenticatedUser };

@Controller(['uploads', 'upload'])
export class UploadsController {
  constructor(
    private readonly uploadsService: UploadsService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  async listUploads(@Query() query: ListUploadsQueryDto) {
    return this.uploadsService.listUploads(query);
  }

  @Post()
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: memoryStorage(), // NOSONAR: file count, size, and request rate are capped.
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

  @Get(':id/signed-url')
  async getSignedUrl(@Param('id') id: string) {
    const signed = await this.uploadsService.getSignedUrlById(id);
    if (!signed) {
      throw new NotFoundException('Upload not found');
    }
    return signed;
  }

  @Patch(':id')
  async updateUpload(
    @Param('id') id: string,
    @Body() dto: UpdateUploadDto,
    @Request() request: AuthRequest,
  ) {
    const updated = await this.uploadsService.updateUploadById(id, dto);
    if (!updated) {
      throw new NotFoundException('Upload not found');
    }
    await this.auditService.record(request.user ?? null, 'upload.update', {
      type: 'upload',
      id,
    });
    return updated;
  }

  @Delete(':id')
  @Roles('manager', 'admin')
  async deleteUpload(@Param('id') id: string, @Request() request: AuthRequest) {
    const deleted = await this.uploadsService.deleteUploadById(id);
    if (!deleted) {
      throw new NotFoundException('Upload not found');
    }
    await this.auditService.record(request.user ?? null, 'upload.delete', {
      type: 'upload',
      id,
    });
    return { message: 'Upload deleted' };
  }
}

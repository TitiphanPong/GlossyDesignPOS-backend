import {
  Controller,
  Post,
  UploadedFiles,
  UseInterceptors,
  Body,
  Get,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';
import { uploadConfig } from './upload.config';

@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  // ✅ ดึงข้อมูลทั้งหมด
  @Get()
  async getAllUploads() {
    return this.uploadService.getAllUploads();
  }

  // ✅ แก้สถานะ
  @Patch(':id/complete')
  async markComplete(@Param('id') id: string) {
    return this.uploadService.markAsCompleted(id);
  }

  @Patch(':id')
  async updateUpload(
    @Param('id') id: string,
    @Body()
    body: {
      customerName?: string;
      phone?: string;
      status?: string;
      note?: string;
    },
  ) {
    return this.uploadService.updateUpload(id, body);
  }

  @Delete(':id')
  async deleteUpload(@Param('id') id: string) {
    return this.uploadService.deleteUpload(id);
  }

  // ✅ อัปโหลดไฟล์แบบใช้ diskStorage
  @Post()
  @UseInterceptors(FilesInterceptor('files', 10, uploadConfig)) // ✅ ใส่ config และ limit
  async handleUpload(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: any,
  ) {
    return this.uploadService.uploadToGoogleDrive(files, body);
  }
}

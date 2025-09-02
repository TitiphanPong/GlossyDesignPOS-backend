import {
  Controller,
  Post,
  UploadedFiles,
  UseInterceptors,
  Body,
  Get,
  Patch,
  Param,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';
import { uploadConfig } from '../modules/uploads/upload.config';

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

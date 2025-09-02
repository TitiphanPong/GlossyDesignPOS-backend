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

@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  // ✅ ดึงข้อมูลทั้งหมด
  @Get()
  async getAllUploads() {
    return this.uploadService.getAllUploads(); // 🔁 เรียกผ่าน service
  }

  @Patch(':id/complete')
async markComplete(@Param('id') id: string) {
  return this.uploadService.markAsCompleted(id);
}

  // ✅ อัปโหลดไฟล์
  @Post()
  @UseInterceptors(FilesInterceptor('files'))
  async handleUpload(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: any,
  ) {
    return this.uploadService.uploadToGoogleDrive(files, body);
  }
}

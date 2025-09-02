import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import * as stream from 'stream';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Upload, UploadDocument } from './schemas/upload.schema';

@Injectable()
export class UploadService {
  private oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );

  constructor(
    @InjectModel(Upload.name) private uploadModel: Model<UploadDocument>,
  ) {
    this.oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
  }

  async markAsCompleted(id: string) {
  return this.uploadModel.findByIdAndUpdate(
    id,
    { status: 'completed' },
    { new: true }
  );
}

    async getAllUploads() {
    return this.uploadModel.find().sort({ createdAt: -1 });
  }

  async uploadToGoogleDrive(files: Express.Multer.File[], body: any) {
    const drive = google.drive({ version: 'v3', auth: this.oauth2Client });



    // ✅ แผนที่ Category → Google Drive Folder ID
    const categoryToFolderMap: Record<string, string> = {
      'นามบัตร': '14Vsoxz_nkrUYiezn2L-rb3tMg8X9uiRN',
      'ตรายาง': '1ciFV6wByfkfrCaC5QSvhCW69oTv1AD_m',
      'ถ่ายเอกสาร & ปริ้นงาน': '1FtRO5cB1JZ4E58-ed9YqP2icxuGtYsZk',
      'สติ๊กเกอร์': '1J4zSdqGiZowBlCTnYm48d9QweoDAj5ZY',
      'อื่นๆ': '1Oo4ipak91vDKiXzKhIxGzxkDYr0RD9pE',
    };

    // ✅ หา folder ID ตาม category ที่ลูกค้าเลือก
    const targetFolderId =
      categoryToFolderMap[body.category] || process.env.GOOGLE_FOLDER_ID!;

    const uploadedFiles = await Promise.all(
      files.map(async (file) => {
        const bufferStream = new stream.PassThrough();
        bufferStream.end(file.buffer);

        const response = await drive.files.create({
          requestBody: {
            name: file.originalname,
            parents: [targetFolderId], // ✅ ใช้ folder ตาม category
          },
          media: {
            mimeType: file.mimetype,
            body: bufferStream,
          },
          fields: 'id, name',
        });

        // ✅ แชร์ให้ anyone ดาวน์โหลดได้
        await drive.permissions.create({
          fileId: response.data.id!,
          requestBody: {
            role: 'reader',
            type: 'anyone',
          },
        });

        const publicUrl = `https://drive.google.com/uc?id=${response.data.id}&export=download`;

        return {
          fileId: response.data.id,
          name: response.data.name,
          downloadUrl: publicUrl,
        };
      }),
    );

    // ✅ บันทึกลง MongoDB
    await this.uploadModel.create({
      customerName: body.customerName,
      phone: body.phone,
      note: body.note,
      category: body.category,
      files: uploadedFiles,
    });

    // ✅ ส่งกลับไปให้ frontend
    return {
      message: 'Upload success',
      customerName: body.customerName,
      phone: body.phone,
      note: body.note,
      category: body.category,
      files: uploadedFiles,
    };
  }
}
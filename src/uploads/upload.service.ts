import { Injectable } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';
import * as fs from 'fs';
import { promisify } from 'util';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Upload, UploadDocument } from './schemas/upload.schema';

const unlinkAsync = promisify(fs.unlink); // สำหรับลบไฟล์หลัง upload

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

  async getDriveQuota() {
    const drive = google.drive({ version: 'v3', auth: this.oauth2Client });
    const res = await drive.about.get({ fields: 'storageQuota' });
    return res.data.storageQuota;
  }

  async markAsCompleted(id: string) {
    return this.uploadModel.findByIdAndUpdate(
      id,
      { status: 'completed' },
      { new: true },
    );
  }

  async getAllUploads() {
    return this.uploadModel.find().sort({ createdAt: -1 });
  }

  async updateUpload(id: string, updateData: Partial<Upload>) {
    return this.uploadModel.findByIdAndUpdate(id, updateData, { new: true });
  }

  async deleteUpload(id: string) {
    return this.uploadModel.findByIdAndDelete(id);
  }

  async uploadToGoogleDrive(files: Express.Multer.File[], body: any) {
    const drive = google.drive({ version: 'v3', auth: this.oauth2Client });

    // ✅ แผนที่ Category → Google Drive Folder ID
    const categoryToFolderMap: Record<string, string> = {
      นามบัตร: '14Vsoxz_nkrUYiezn2L-rb3tMg8X9uiRN',
      ตรายาง: '1ciFV6wByfkfrCaC5QSvhCW69oTv1AD_m',
      'ถ่ายเอกสาร & ปริ้นงาน': '1FtRO5cB1JZ4E58-ed9YqP2icxuGtYsZk',
      สติ๊กเกอร์: '1J4zSdqGiZowBlCTnYm48d9QweoDAj5ZY',
      อื่นๆ: '1Oo4ipak91vDKiXzKhIxGzxkDYr0RD9pE',
    };

    const targetFolderId =
      categoryToFolderMap[body.category] || process.env.GOOGLE_FOLDER_ID!;

    const uploadedFiles = await Promise.all(
      files.map(async (file) => {
        const filePath = file.path; // ← ได้จาก multer.diskStorage
        const fileStream = fs.createReadStream(filePath); // ✅ ใช้ stream แทน buffer

        const response = await drive.files.create({
          requestBody: {
            name: file.originalname,
            parents: [targetFolderId],
          },
          media: {
            mimeType: file.mimetype,
            body: fileStream,
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

        // ✅ ลบไฟล์ออกจาก disk หลังอัปโหลดเสร็จ
        await unlinkAsync(filePath);

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

    return {
      message: 'Upload success',
      customerName: body.customerName,
      phone: body.phone,
      note: body.note,
      category: body.category,
      files: uploadedFiles,
    };
  }

  async getFolderUsage(folderId: string) {
    const drive = google.drive({ version: 'v3', auth: this.oauth2Client });

    let pageToken: string | undefined = undefined;
    let totalSize = 0;

    do {
      const res: drive_v3.Schema$FileList = (
        await drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, size)',
          pageSize: 1000,
          pageToken,
        })
      ).data;

      res.files?.forEach((file: drive_v3.Schema$File) => {
        if (file.size) totalSize += Number(file.size);
      });

      pageToken = res.nextPageToken || undefined;
    } while (pageToken);

    return totalSize; // bytes
  }

  async getUsageByCategory() {
    const categoryToFolderMap: Record<string, string> = {
      นามบัตร: '14Vsoxz_nkrUYiezn2L-rb3tMg8X9uiRN',
      ตรายาง: '1ciFV6wByfkfrCaC5QSvhCW69oTv1AD_m',
      'ถ่ายเอกสาร & ปริ้นงาน': '1FtRO5cB1JZ4E58-ed9YqP2icxuGtYsZk',
      สติ๊กเกอร์: '1J4zSdqGiZowBlCTnYm48d9QweoDAj5ZY',
      อื่นๆ: '1Oo4ipak91vDKiXzKhIxGzxkDYr0RD9pE',
    };

    const result: Record<string, any> = {};

    for (const [category, folderId] of Object.entries(categoryToFolderMap)) {
      const sizeBytes = await this.getFolderUsage(folderId);
      result[category] = {
        size: sizeBytes,
        sizeGB: (sizeBytes / 1024 ** 2).toFixed(2) + ' MB',
      };
    }

    return result;
  }
}

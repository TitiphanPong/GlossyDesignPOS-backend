export class UploadResponseDto {
  id!: string;
  uploadId!: string;
  orderCode!: string;
  originalName!: string;
  size!: number;
  mimeType!: string;
  createdAt!: string;
  signedUrl!: string;
  expiresIn!: number;
  message!: string;
}

export enum JobType {
  DOCUMENT_PRINTING = 'Document Printing',
  PHOTOCOPY = 'Photocopy',
  STICKER = 'Sticker',
  BUSINESS_CARD = 'Business Card',
  POSTER = 'Poster',
  VINYL_BANNER = 'Vinyl Banner',
  PACKAGING = 'Packaging',
  OTHER = 'Other',
}

export enum UploadStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
}

export enum UploadStage {
  WAITING_DOWNLOAD = 'waiting-download',
  PENDING = 'pending',
  COMPLETED = 'completed',
}

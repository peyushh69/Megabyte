export type FileCategory =
  | 'photo'
  | 'audio'
  | 'pdf'
  | 'csv'
  | 'video'
  | 'archive'
  | 'other';

export type TransferMode = 'Wi-Fi Direct' | 'Room Vault' | 'Bluetooth Beam';

export interface SharedFileItem {
  id: string;
  roomId: string;
  name: string;
  size: number;
  uploadedBytes: number;
  mimeType: string;
  category: FileCategory;
  senderDeviceName: string;
  senderDeviceType: 'PC' | 'Mobile';
  transferMode: TransferMode;
  speedMbps: number;
  status: 'uploading' | 'completed' | 'error';
  createdAt: string;
  retentionHours: number;
  expiresAt: string;
}

export interface ConnectedDevice {
  id: string;
  roomId: string;
  name: string;
  deviceType: 'PC' | 'Mobile';
  platform: string;
  transport: 'Wi-Fi / High-Speed Relay' | 'WebRTC P2P' | 'Bluetooth Paired';
  joinedAt: string;
}

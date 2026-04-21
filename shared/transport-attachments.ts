export interface TransportAttachment {
  id: string;
  daemonPath: string;
  originalName?: string;
  mime?: string;
  size?: number;
  type?: 'file' | 'image';
}

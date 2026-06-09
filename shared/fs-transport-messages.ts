export const FS_TRANSPORT_MSG = {
  RENAME: 'fs.rename',
  RENAME_RESPONSE: 'fs.rename_response',
  DELETE: 'fs.delete',
  DELETE_RESPONSE: 'fs.delete_response',
} as const;

export type FsTransportMessageType = (typeof FS_TRANSPORT_MSG)[keyof typeof FS_TRANSPORT_MSG];

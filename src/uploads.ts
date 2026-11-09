// Stopgap for observed in-app browser transport failures, not a WordPress limit.
export const maximumUploadBytes = 5 * 1024 * 1024;
export const uploadLimitHint =
  'Decoded uploads must contain 1 byte to 5 MiB. Resize or recompress the image, then base64-encode the smaller file and prepare again. No upload was sent.';

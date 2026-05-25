declare const __BUILD_TIME__: string;

/**
 * Compile-time push channel selector, set by vite.config.ts based on the
 * VITE_REGION env var. 'china' triggers the JPush registration path on
 * Android; 'global' uses FCM via @capacitor/push-notifications. iOS ignores
 * this entirely and always uses APNs.
 */
declare const __PUSH_REGION__: 'china' | 'global';

// Vite ?url suffix — returns the asset URL as a string
declare module '*?url' {
  const src: string;
  export default src;
}

// Vite ?raw suffix — returns file content as a string
declare module '*?raw' {
  const src: string;
  export default src;
}

declare module 'pdfjs-dist' {
  export function getDocument(src: unknown): { promise: Promise<any> };
  export const GlobalWorkerOptions: { workerSrc: string };
  const pdfjs: {
    getDocument: typeof getDocument;
    GlobalWorkerOptions: typeof GlobalWorkerOptions;
  };
  export default pdfjs;
}

declare module 'docx-preview' {
  export function renderAsync(
    data: Blob | ArrayBuffer | Uint8Array,
    bodyContainer: HTMLElement,
    styleContainer?: HTMLElement,
    options?: Record<string, unknown>,
  ): Promise<void>;
}

declare module 'xlsx' {
  export function read(data: string | ArrayBuffer, opts?: Record<string, unknown>): any;
  export const utils: {
    sheet_to_html(sheet: unknown, opts?: Record<string, unknown>): string;
  };
}

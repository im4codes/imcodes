declare const __BUILD_TIME__: string;
declare const __WEB_BUILD_ID__: string;

/**
 * Compile-time push configuration macros injected by vite.config.ts.
 * `__PUSH_FCM__` enables Android FCM registration (false for the pure without-fcm build).
 * `__PUSH_REGION__` is retained for inline test/build harness compatibility.
 * iOS ignores both and always uses APNs.
 */
declare const __PUSH_REGION__: 'china' | 'global';
declare const __PUSH_FCM__: boolean;

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

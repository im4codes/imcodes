declare const __BUILD_TIME__: string;

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

// pdfjs worker module — loaded via dynamic import for globalThis.pdfjsWorker bypass
declare module 'pdfjs-dist/build/pdf.worker.min.mjs' {
  const WorkerMessageHandler: unknown;
  export { WorkerMessageHandler };
}

declare module 'pdfjs-dist' {
  export function getDocument(src: unknown): { promise: Promise<any> };
  const pdfjs: {
    getDocument: typeof getDocument;
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

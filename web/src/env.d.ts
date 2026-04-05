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

/**
 * `import text from './file?raw'`: a file's contents as a string. Vite
 * (tests) supports it natively; the controlled-node esbuild bundle maps it to
 * the text loader (scripts/build-node-exe.mjs). The tsc-built daemon never
 * loads a module that uses it.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}

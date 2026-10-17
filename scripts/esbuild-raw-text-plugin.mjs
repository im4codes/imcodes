// `import text from './file?raw'` -- the same syntax Vite gives the tests --
// bundled as the file's contents, inlined as a string. Used by every esbuild
// pass over the controlled-node entry (build and dependency guard), so both
// see the same module graph. The Linux desktop installer ships inside the
// node this way: one recipe for the operator script and the node.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const rawTextImportsPlugin = {
  name: 'raw-text-imports',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
      namespace: 'raw-text',
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

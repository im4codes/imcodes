import { render } from 'preact';
import { marked } from 'marked';
import { App } from './app.js';
import './styles.css';
import './i18n/index.js';
// JetBrains Mono — bundled webfont (OFL 1.1). Used as the default chat
// font and always available regardless of the user's installed system
// fonts. Only regular + bold weights are loaded to keep the bundle small
// (~120KB total, gzipped ~70KB). Italic / other weights are not needed.
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';

// Global marked config: all links open in new tab
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${title}"` : '';
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

render(<App />, document.getElementById('app')!);

import { render } from 'preact';
import { marked } from 'marked';
import { App } from './app.js';
import { applyNativePlatformClasses } from './native-platform.js';
import './styles.css';
import './i18n/index.js';
// Bundled programmer webfonts (OFL 1.1). JetBrains Mono is the default;
// Cascadia Mono is available in the chat font picker even when it is not
// installed on the user's machine. Only regular + bold weights are loaded
// because italic / other weights are not needed for chat rendering.
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/cascadia-mono/latin-400.css';
import '@fontsource/cascadia-mono/latin-700.css';

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

applyNativePlatformClasses();

render(<App />, document.getElementById('app')!);

import { render } from 'preact';
import { marked } from 'marked';
import { App } from './app.js';
import './styles.css';
import './i18n/index.js';

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

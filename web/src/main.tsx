import { render } from 'preact';
import { App } from './app.js';
import './styles.css';
import './i18n/index.js';

render(<App />, document.getElementById('app')!);

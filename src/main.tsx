import { render } from 'preact';
import { App } from './app';
import { init } from './store';
import './style.css';

void init();
render(<App />, document.getElementById('app')!);

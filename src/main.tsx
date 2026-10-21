import { render } from 'preact';
import { App } from './app';
import { init } from './store';
import { startSync } from './sync';
import './style.css';

void init().then(startSync);
render(<App />, document.getElementById('app')!);

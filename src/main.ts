import './style.css';
import { mountApp } from './app';

const appRoot = document.querySelector<HTMLElement>('#app');
if (!appRoot) {
  throw new Error('Missing #app root element.');
}

mountApp(appRoot);

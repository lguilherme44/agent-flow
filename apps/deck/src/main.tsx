import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/deck.css';
import './styles/run.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Deck needs a #root to mount on');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

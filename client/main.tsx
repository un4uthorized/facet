import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme.css';
import './admin.css';
import './content/markdown.css';
import './loading.css';

try {
  document.documentElement.dataset.theme = localStorage.getItem('facet-theme') === 'dark' ? 'dark' : 'light';
} catch {
  document.documentElement.dataset.theme = 'light';
}

createRoot(document.getElementById('root')!).render(<App />);

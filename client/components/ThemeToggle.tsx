import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');

  function toggle() {
    const next = !dark;
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    try { localStorage.setItem('facet-theme', next ? 'dark' : 'light'); } catch { /* Theme also works without storage. */ }
    setDark(next);
  }

  return (
    <button className="workspace-icon-button" type="button" onClick={toggle} aria-label={dark ? 'Ativar tema claro' : 'Ativar tema escuro'} title={dark ? 'Ativar tema claro' : 'Ativar tema escuro'}>
      {dark ? <Sun /> : <Moon />}
    </button>
  );
}

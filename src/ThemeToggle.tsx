import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark';
const storageKey = 'issue-note-theme';

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111111' : '#f9f9f9');
    try { localStorage.setItem(storageKey, theme); } catch { /* Switching still works when browser storage is unavailable. */ }
  }, [theme]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) setTheme(event.newValue === 'dark' ? 'dark' : 'light');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const nextLabel = theme === 'light' ? '深色' : '浅色';
  return <button className="theme-toggle" type="button" aria-label={`切换为${nextLabel}主题`} title={`切换为${nextLabel}主题`} aria-pressed={theme === 'dark'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
    {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}<span>{nextLabel}</span>
  </button>;
}

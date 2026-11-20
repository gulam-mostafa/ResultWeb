import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { readJSON, writeJSON } from '../services/storageService.js';

/**
 * ThemeContext — light / dark / system theme with localStorage persistence.
 *
 * Tailwind is configured with `darkMode: 'class'`, so the provider only needs to
 * toggle the `dark` class on <html>. Documents always print on white paper,
 * which is handled by styles/print.css.
 */

const ThemeContext = createContext(null);
const THEME_KEY = 'resultweb:theme:v1';

const systemPrefersDark = () =>
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-color-scheme: dark)').matches;

const resolveTheme = (mode) => (mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode);

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(() => {
    const stored = readJSON(THEME_KEY, null);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'light';
  });
  const [resolved, setResolved] = useState(() => resolveTheme(readJSON(THEME_KEY, 'light')));

  // Apply the resolved theme to <html> and remember the explicit choice.
  useEffect(() => {
    const next = resolveTheme(mode);
    setResolved(next);
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', next === 'dark');
      document.documentElement.dataset.theme = next;
      document.documentElement.style.colorScheme = next;
    }
    writeJSON(THEME_KEY, mode);
  }, [mode]);

  // Follow the OS preference while the user is on "system".
  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const next = query.matches ? 'dark' : 'light';
      setResolved(next);
      document.documentElement.classList.toggle('dark', next === 'dark');
    };
    query.addEventListener?.('change', handler);
    return () => query.removeEventListener?.('change', handler);
  }, [mode]);

  const toggleTheme = useCallback(() => {
    setMode((prev) => (resolveTheme(prev) === 'dark' ? 'light' : 'dark'));
  }, []);

  const value = useMemo(
    () => ({ mode, theme: resolved, isDark: resolved === 'dark', setMode, toggleTheme }),
    [mode, resolved, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>.');
  return context;
}

export default ThemeContext;

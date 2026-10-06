import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, ReactNode } from 'react';

type Theme = 'dark' | 'light';
const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: 'light', toggle: () => {} });
const KEY = 'or_theme';

function stored(): Theme {
  try { const s = localStorage.getItem(KEY); if (s === 'dark' || s === 'light') return s; } catch { /* ignore */ }
  return 'light'; // light is the default; dark only when the user has chosen it
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(stored);
  // applied before paint so a stored dark theme never flashes light
  useLayoutEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); }, [theme]);
  useEffect(() => { try { localStorage.setItem(KEY, theme); } catch { /* ignore */ } }, [theme]);
  // another tab changed the theme
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === KEY && (e.newValue === 'dark' || e.newValue === 'light')) setTheme(e.newValue); };
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, []);
  const toggle = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), []);
  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

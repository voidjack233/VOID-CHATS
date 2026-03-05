// src/Services/hooks/Settings/useTheme.ts
import { useState, useEffect } from 'react';
import { fetchWithAuth } from '../../Auth/authServiceApi';

export type Theme = 'void' | 'ocean' | 'forest' | 'sunset' | 'midnight';

export interface ThemePreferences {
  accent_color: string;
  bg_color: string;
  theme: Theme;
}

interface UseThemeReturn {
  accentColor: string;
  bgColor: string;
  textColor: string;
  loading: boolean;
  setTheme: (theme: Theme) => void;
  setCustomColors: (accent: string, bg: string) => void;
  savePreferences: () => Promise<void>;
  resetToDefaults: () => void;
}

// Theme preset colors - ALL DARK THEMES
const THEME_PRESETS: Record<Theme, { accent: string; bg: string }> = {
  void: { accent: '#6366f1', bg: '#111827' },
  ocean: { accent: '#0ea5e9', bg: '#0f172a' },
  forest: { accent: '#10b981', bg: '#0c1f1c' },
  sunset: { accent: '#f97316', bg: '#1e1b2e' },
  midnight: { accent: '#8b5cf6', bg: '#030712' },
};

// Default to VOID
const DEFAULT_THEME: Theme = 'void';
const DEFAULT_ACCENT = THEME_PRESETS.void.accent;
const DEFAULT_BG = THEME_PRESETS.void.bg;
const DEFAULT_TEXT = '#f3f4f6';

// Helper to adjust color brightness
const adjustColor = (hex: string, percent: number): string => {
  if (!hex) return DEFAULT_ACCENT;
  
  try {
    let cleanHex = hex.replace('#', '');
    
    if (cleanHex.length === 3) {
      cleanHex = cleanHex.split('').map(c => c + c).join('');
    }
    
    const r = parseInt(cleanHex.substring(0, 2), 16);
    const g = parseInt(cleanHex.substring(2, 4), 16);
    const b = parseInt(cleanHex.substring(4, 6), 16);
    
    const adjust = (color: number) => {
      return Math.max(0, Math.min(255, color + percent));
    };
    
    const toHex = (n: number) => {
      const hex = adjust(n).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };
    
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  } catch (e) {
    return hex;
  }
};

// Apply theme to DOM
const applyColorsToDOM = (accent: string, bg: string) => {
  const root = document.documentElement;
  
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-hover', adjustColor(accent, -20));
  root.style.setProperty('--bg-main', bg);
  root.style.setProperty('--bg-sec', adjustColor(bg, 15));
  root.style.setProperty('--bg-hover', adjustColor(bg, 30));
  root.style.setProperty('--text-main', DEFAULT_TEXT);
  root.style.setProperty('--scrollbar-thumb', adjustColor(bg, 40));
  root.style.setProperty('--scrollbar-thumb-hover', adjustColor(bg, 60));
  
  // Update data-theme attribute
  const matchingTheme = Object.entries(THEME_PRESETS).find(
    ([_, colors]) => colors.accent === accent && colors.bg === bg
  );
  
  if (matchingTheme) {
    root.setAttribute('data-theme', matchingTheme[0]);
  }
};

export const useTheme = (): UseThemeReturn => {
  const [loading, setLoading] = useState(true);
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT);
  const [bgColor, setBgColor] = useState(DEFAULT_BG);
  const textColor = DEFAULT_TEXT; // Remove setTextColor, just use constant

  // Apply VOID theme on mount (before any loading)
useEffect(() => {
  const root = document.documentElement;
  root.setAttribute('data-theme', DEFAULT_THEME);
  applyColorsToDOM(DEFAULT_ACCENT, DEFAULT_BG);
}, []);

  // Then try to load saved preferences
  useEffect(() => {
    const loadPreferences = async () => {
      try {
        // Check localStorage first
        const savedTheme = localStorage.getItem('theme') as Theme | null;
        
        if (savedTheme && THEME_PRESETS[savedTheme]) {
          // Use saved theme
          const preset = THEME_PRESETS[savedTheme];
          setThemeState(savedTheme);
          setAccentColor(preset.accent);
          setBgColor(preset.bg);
          applyColorsToDOM(preset.accent, preset.bg);
        }
        
        // Try to load from server (if user is logged in)
        try {
          const res = await fetchWithAuth('/api/users/preferences');
          const data = await res.json();
          
          if (data.success && data.preferences) {
            const { accent_color, bg_color, theme: savedThemeFromServer } = data.preferences;
            
            // Only use server data if it exists and is valid
            if (accent_color && bg_color) {
              setAccentColor(accent_color);
              setBgColor(bg_color);
              applyColorsToDOM(accent_color, bg_color);
            }
            
            if (savedThemeFromServer && THEME_PRESETS[savedThemeFromServer as Theme]) {
              setThemeState(savedThemeFromServer as Theme);
              localStorage.setItem('theme', savedThemeFromServer);
            }
          }
        } catch (err) {
          // Silently fail - user might not be logged in
          console.log('No server preferences yet (new user or not logged in)');
        }
        
      } catch (err) {
        console.error('Error loading preferences', err);
      } finally {
        setLoading(false);
      }
    };

    loadPreferences();
  }, []);

  const setTheme = (newTheme: Theme) => {
    const safeTheme = THEME_PRESETS[newTheme] ? newTheme : DEFAULT_THEME;
    const preset = THEME_PRESETS[safeTheme];
    
    setThemeState(safeTheme);
    setAccentColor(preset.accent);
    setBgColor(preset.bg);
    
    applyColorsToDOM(preset.accent, preset.bg);
    localStorage.setItem('theme', safeTheme);
  };

  const setCustomColors = (accent: string, bg: string) => {
    setThemeState(DEFAULT_THEME);
    setAccentColor(accent);
    setBgColor(bg);
    
    applyColorsToDOM(accent, bg);
  };

  const savePreferences = async () => {
    try {
      await fetchWithAuth('/api/users/preferences', {
        method: 'PUT',
        body: JSON.stringify({
          accent_color: accentColor,
          bg_color: bgColor,
          theme: theme,
        }),
      });
      
      localStorage.setItem('theme', theme);
    } catch (err) {
      console.error('Failed to save preferences', err);
      throw err;
    }
  };

  const resetToDefaults = () => {
    setThemeState(DEFAULT_THEME);
    setAccentColor(DEFAULT_ACCENT);
    setBgColor(DEFAULT_BG);
    
    applyColorsToDOM(DEFAULT_ACCENT, DEFAULT_BG);
    localStorage.setItem('theme', DEFAULT_THEME);
  };

  return {
    accentColor,
    bgColor,
    textColor, // This is now a constant, not state
    loading,
    setTheme,
    setCustomColors,
    savePreferences,
    resetToDefaults,
  };
};
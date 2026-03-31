// src/Services/hooks/Settings/useTheme.ts
import { useState, useEffect, useCallback, createContext, useContext } from 'react';

const NOTIFICATION_ENABLED_KEY = 'void_message_notifications_enabled';
import { fetchWithAuth } from '../../Auth/authServiceApi';

export type Theme = 'void' | 'ocean' | 'forest' | 'sunset' | 'midnight';
export type MessageGroupSpacing = 0 | 4 | 8 | 16 | 24;
export type ChatFontScale = 12 | 14 | 15 | 16 | 18 | 20 | 24;

export interface ThemePreferences {
  accent_color: string;
  bg_color: string;
  text_color: string;   // <-- Added
  hover_color: string;  // <-- Added
  theme: Theme;
  density?: Density;
  message_group_spacing?: MessageGroupSpacing;
  chat_font_scale?: ChatFontScale;
}

export type Density = 'comfortable' | 'compact';

const MESSAGE_GROUP_SPACING_OPTIONS = [0, 4, 8, 16, 24] as const;
const CHAT_FONT_SCALE_OPTIONS = [12, 14, 15, 16, 18, 20, 24] as const;

interface ThemeContextValue {
  accentColor: string;
  bgColor: string;
  textColor: string;
  hoverColor: string;
  currentTheme: Theme;
  density: Density;
  messageGroupSpacing: MessageGroupSpacing;
  chatFontScale: ChatFontScale;
  loading: boolean;
  savedAccent: string;
  savedBg: string;
  savedText: string;
  savedHover: string;
  savedTheme: Theme;
  hasChanges: boolean;
  setTheme: (theme: Theme) => void;
  setCustomColors: (accent: string, bg: string, text: string, hover: string) => void;
  setDensity: (d: Density) => void;
  setMessageGroupSpacing: (spacing: MessageGroupSpacing) => void;
  setChatFontScale: (fontScale: ChatFontScale) => void;
  messageNotificationsEnabled: boolean;
  setMessageNotificationsEnabled: (enabled: boolean) => Promise<void>;
  savePreferences: () => Promise<void>;
  resetToDefaults: () => void;
  revertChanges: () => void;
}

// Added text and hover to the presets so they switch perfectly!
export const THEME_PRESETS: Record<Theme, { accent: string; bg: string; text: string; hover: string }> = {
  void: { accent: '#6366f1', bg: '#111827', text: '#f3f4f6', hover: '#374151' },
  ocean: { accent: '#0ea5e9', bg: '#0f172a', text: '#f8fafc', hover: '#334155' },
  forest: { accent: '#10b981', bg: '#0c1f1c', text: '#ecfdf5', hover: '#2d4a43' },
  sunset: { accent: '#f97316', bg: '#1e1b2e', text: '#fff7ed', hover: '#3f3b5c' },
  midnight: { accent: '#8b5cf6', bg: '#030712', text: '#f5f3ff', hover: '#1f2937' },
};

const DEFAULT_THEME: Theme = 'void';
const DEFAULT_ACCENT = THEME_PRESETS.void.accent;
const DEFAULT_BG = THEME_PRESETS.void.bg;
const DEFAULT_TEXT = THEME_PRESETS.void.text;
const DEFAULT_HOVER = THEME_PRESETS.void.hover;
const DEFAULT_MESSAGE_GROUP_SPACING: MessageGroupSpacing = 8;
const DEFAULT_CHAT_FONT_SCALE: ChatFontScale = 16;

function parseMessageGroupSpacing(value: string | null): MessageGroupSpacing {
  const parsed = Number(value);
  return (MESSAGE_GROUP_SPACING_OPTIONS as readonly number[]).includes(parsed)
    ? (parsed as MessageGroupSpacing)
    : DEFAULT_MESSAGE_GROUP_SPACING;
}

function parseChatFontScale(value: string | null): ChatFontScale {
  const parsed = Number(value);
  return (CHAT_FONT_SCALE_OPTIONS as readonly number[]).includes(parsed)
    ? (parsed as ChatFontScale)
    : DEFAULT_CHAT_FONT_SCALE;
}

export const adjustColor = (hex: string, percent: number): string => {
  if (!hex) return '#1f2937';
  try {
    let cleanHex = hex.replace('#', '');
    if (cleanHex.length === 3) {
      cleanHex = cleanHex.split('').map(c => c + c).join('');
    }
    const r = parseInt(cleanHex.substring(0, 2), 16);
    const g = parseInt(cleanHex.substring(2, 4), 16);
    const b = parseInt(cleanHex.substring(4, 6), 16);
    const adjust = (color: number) => Math.max(0, Math.min(255, color + percent));
    const toHex = (n: number) => {
      const hex = adjust(n).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  } catch {
    return hex;
  }
};

const applyColorsToDOM = (accent: string, bg: string, text: string, hover: string) => {
  const root = document.documentElement;

  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-hover', adjustColor(accent, -20));
  root.style.setProperty('--bg-main', bg);
  root.style.setProperty('--bg-hover', hover);
  root.style.setProperty('--text-main', text);
  
  // Keep these auto-calculated so the user doesn't have to pick 8 different colors
  root.style.setProperty('--bg-sec', adjustColor(bg, 10)); 
  root.style.setProperty('--scrollbar-thumb', adjustColor(bg, 40));
  root.style.setProperty('--scrollbar-thumb-hover', adjustColor(bg, 60));

  const matchingTheme = Object.entries(THEME_PRESETS).find(
    ([_, colors]) => colors.accent === accent && colors.bg === bg && colors.text === text && colors.hover === hover
  );

  if (matchingTheme) {
    root.setAttribute('data-theme', matchingTheme[0]);
  } else {
    root.removeAttribute('data-theme');
  }
};

// Apply defaults immediately
applyColorsToDOM(DEFAULT_ACCENT, DEFAULT_BG, DEFAULT_TEXT, DEFAULT_HOVER);
document.documentElement.setAttribute('data-theme', DEFAULT_THEME);

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const ThemeProvider = ThemeContext.Provider;

export function useThemeProvider(): ThemeContextValue {
  const [loading, setLoading] = useState(true);
  const [currentTheme, setCurrentTheme] = useState<Theme>(DEFAULT_THEME);
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT);
  const [bgColor, setBgColor] = useState(DEFAULT_BG);
  const [textColor, setTextColor] = useState(DEFAULT_TEXT);
  const [hoverColor, setHoverColor] = useState(DEFAULT_HOVER);

  const [density, setDensityState] = useState<Density>(() => {
    const saved = localStorage.getItem('void_density');
    return saved === 'comfortable' ? 'comfortable' : 'compact';
  });
  const [messageGroupSpacing, setMessageGroupSpacingState] = useState<MessageGroupSpacing>(() =>
    parseMessageGroupSpacing(localStorage.getItem('void_message_group_spacing'))
  );
  const [chatFontScale, setChatFontScaleState] = useState<ChatFontScale>(() =>
    parseChatFontScale(localStorage.getItem('void_chat_font_scale'))
  );

  const [messageNotificationsEnabled, setMessageNotificationsEnabledState] = useState<boolean>(
    () => typeof window !== 'undefined' ? localStorage.getItem(NOTIFICATION_ENABLED_KEY) !== 'false' : true
  );

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
  }, []);
  const setMessageGroupSpacing = useCallback((spacing: MessageGroupSpacing) => {
    setMessageGroupSpacingState(spacing);
  }, []);
  const setChatFontScale = useCallback((fontScale: ChatFontScale) => {
    setChatFontScaleState(fontScale);
  }, []);

  const setMessageNotificationsEnabled = useCallback(async (enabled: boolean) => {
    setMessageNotificationsEnabledState(enabled);
    localStorage.setItem(NOTIFICATION_ENABLED_KEY, enabled ? 'true' : 'false');
  }, []);

  const [savedTheme, setSavedTheme] = useState<Theme>(DEFAULT_THEME);
  const [savedAccent, setSavedAccent] = useState(DEFAULT_ACCENT);
  const [savedBg, setSavedBg] = useState(DEFAULT_BG);
  const [savedText, setSavedText] = useState(DEFAULT_TEXT);
  const [savedHover, setSavedHover] = useState(DEFAULT_HOVER);
  const [savedDensity, setSavedDensity] = useState<Density>(() => {
    const saved = localStorage.getItem('void_density');
    return saved === 'comfortable' ? 'comfortable' : 'compact';
  });
  const [savedMessageGroupSpacing, setSavedMessageGroupSpacing] = useState<MessageGroupSpacing>(() =>
    parseMessageGroupSpacing(localStorage.getItem('void_message_group_spacing'))
  );
  const [savedChatFontScale, setSavedChatFontScale] = useState<ChatFontScale>(() =>
    parseChatFontScale(localStorage.getItem('void_chat_font_scale'))
  );

  const hasChanges =
    accentColor !== savedAccent ||
    bgColor !== savedBg ||
    textColor !== savedText ||
    hoverColor !== savedHover ||
    currentTheme !== savedTheme ||
    density !== savedDensity ||
    messageGroupSpacing !== savedMessageGroupSpacing ||
    chatFontScale !== savedChatFontScale;

  const loadPreferences = useCallback(async () => {
    try {
      const localTheme = localStorage.getItem('void_theme') as Theme | null;
      const localAccent = localStorage.getItem('void_accent');
      const localBg = localStorage.getItem('void_bg');
      const localText = localStorage.getItem('void_text');
      const localHover = localStorage.getItem('void_hover');
      const localMessageGroupSpacing = parseMessageGroupSpacing(localStorage.getItem('void_message_group_spacing'));
      const localChatFontScale = parseChatFontScale(localStorage.getItem('void_chat_font_scale'));

      if (localTheme && THEME_PRESETS[localTheme]) {
        const preset = THEME_PRESETS[localTheme];
        const accent = localAccent || preset.accent;
        const bg = localBg || preset.bg;
        const text = localText || preset.text;
        const hover = localHover || preset.hover;

        setCurrentTheme(localTheme);
        setAccentColor(accent);
        setBgColor(bg);
        setTextColor(text);
        setHoverColor(hover);

        setSavedTheme(localTheme);
        setSavedAccent(accent);
        setSavedBg(bg);
        setSavedText(text);
        setSavedHover(hover);

        const localDensity = localStorage.getItem('void_density');
        if (localDensity === 'comfortable' || localDensity === 'compact') {
          setDensityState(localDensity);
          setSavedDensity(localDensity);
        }
        setMessageGroupSpacingState(localMessageGroupSpacing);
        setSavedMessageGroupSpacing(localMessageGroupSpacing);
        setChatFontScaleState(localChatFontScale);
        setSavedChatFontScale(localChatFontScale);

        applyColorsToDOM(accent, bg, text, hover);
      }

      try {
        const res = await fetchWithAuth('/api/users/preferences');
        const data = await res.json();

        if (data.success && data.preferences) {
          const {
            accent_color,
            bg_color,
            text_color,
            hover_color,
            theme,
            density: serverDensityRaw,
            message_group_spacing: serverMessageGroupSpacingRaw,
            chat_font_scale: serverChatFontScaleRaw,
          } = data.preferences;
          const serverTheme = (theme && THEME_PRESETS[theme as Theme]) ? theme as Theme : DEFAULT_THEME;
          const serverAccent = accent_color || THEME_PRESETS[serverTheme].accent;
          const serverBg = bg_color || THEME_PRESETS[serverTheme].bg;
          const serverText = text_color || THEME_PRESETS[serverTheme].text;
          const serverHover = hover_color || THEME_PRESETS[serverTheme].hover;
          const serverDensity: Density = (serverDensityRaw === 'comfortable' || serverDensityRaw === 'compact') ? serverDensityRaw : 'compact';
          const serverMessageGroupSpacing = parseMessageGroupSpacing(
            serverMessageGroupSpacingRaw != null ? String(serverMessageGroupSpacingRaw) : localStorage.getItem('void_message_group_spacing')
          );
          const serverChatFontScale = parseChatFontScale(
            serverChatFontScaleRaw != null ? String(serverChatFontScaleRaw) : localStorage.getItem('void_chat_font_scale')
          );

          setCurrentTheme(serverTheme);
          setAccentColor(serverAccent);
          setBgColor(serverBg);
          setTextColor(serverText);
          setHoverColor(serverHover);
          setDensityState(serverDensity);

          setSavedTheme(serverTheme);
          setSavedAccent(serverAccent);
          setSavedBg(serverBg);
          setSavedText(serverText);
          setSavedHover(serverHover);
          setSavedDensity(serverDensity);
          setMessageGroupSpacingState(serverMessageGroupSpacing);
          setSavedMessageGroupSpacing(serverMessageGroupSpacing);
          setChatFontScaleState(serverChatFontScale);
          setSavedChatFontScale(serverChatFontScale);

          applyColorsToDOM(serverAccent, serverBg, serverText, serverHover);

          localStorage.setItem('void_theme', serverTheme);
          localStorage.setItem('void_accent', serverAccent);
          localStorage.setItem('void_bg', serverBg);
          localStorage.setItem('void_text', serverText);
          localStorage.setItem('void_hover', serverHover);
          localStorage.setItem('void_density', serverDensity);
          localStorage.setItem('void_message_group_spacing', String(serverMessageGroupSpacing));
          localStorage.setItem('void_chat_font_scale', String(serverChatFontScale));
        }
      } catch {
        // Server down, rely on localStorage
      }
    } catch (err) {
      console.error('Error loading preferences', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPreferences();

    window.addEventListener('user-login', loadPreferences);
    return () => window.removeEventListener('user-login', loadPreferences);
  }, [loadPreferences]);

  const setTheme = useCallback((newTheme: Theme) => {
    const safeTheme = THEME_PRESETS[newTheme] ? newTheme : DEFAULT_THEME;
    const preset = THEME_PRESETS[safeTheme];

    setCurrentTheme(safeTheme);
    setAccentColor(preset.accent);
    setBgColor(preset.bg);
    setTextColor(preset.text);
    setHoverColor(preset.hover);
    
    applyColorsToDOM(preset.accent, preset.bg, preset.text, preset.hover);
  }, []);

  const setCustomColors = useCallback((accent: string, bg: string, text: string, hover: string) => {
    setAccentColor(accent);
    setBgColor(bg);
    setTextColor(text);
    setHoverColor(hover);
    
    applyColorsToDOM(accent, bg, text, hover);

    const match = Object.entries(THEME_PRESETS).find(
      ([_, colors]) => colors.accent === accent && colors.bg === bg && colors.text === text && colors.hover === hover
    );
    if (match) {
      setCurrentTheme(match[0] as Theme);
    }
  }, []);

  const savePreferences = useCallback(async () => {
    await fetchWithAuth('/api/users/preferences', {
      method: 'PUT',
      body: JSON.stringify({
        accent_color: accentColor,
        bg_color: bgColor,
        text_color: textColor,
        hover_color: hoverColor,
        theme: currentTheme,
        density,
        message_group_spacing: messageGroupSpacing,
        chat_font_scale: chatFontScale,
      }),
    });

    setSavedTheme(currentTheme);
    setSavedAccent(accentColor);
    setSavedBg(bgColor);
    setSavedText(textColor);
    setSavedHover(hoverColor);
    setSavedDensity(density);
    setSavedMessageGroupSpacing(messageGroupSpacing);
    setSavedChatFontScale(chatFontScale);

    localStorage.setItem('void_theme', currentTheme);
    localStorage.setItem('void_accent', accentColor);
    localStorage.setItem('void_bg', bgColor);
    localStorage.setItem('void_text', textColor);
    localStorage.setItem('void_hover', hoverColor);
    localStorage.setItem('void_density', density);
    localStorage.setItem('void_message_group_spacing', String(messageGroupSpacing));
    localStorage.setItem('void_chat_font_scale', String(chatFontScale));
  }, [accentColor, bgColor, textColor, hoverColor, currentTheme, density, messageGroupSpacing, chatFontScale]);

  const resetToDefaults = useCallback(() => {
    setCurrentTheme(DEFAULT_THEME);
    setAccentColor(DEFAULT_ACCENT);
    setBgColor(DEFAULT_BG);
    setTextColor(DEFAULT_TEXT);
    setHoverColor(DEFAULT_HOVER);
    setDensityState('compact');
    setMessageGroupSpacingState(DEFAULT_MESSAGE_GROUP_SPACING);
    setChatFontScaleState(DEFAULT_CHAT_FONT_SCALE);
    applyColorsToDOM(DEFAULT_ACCENT, DEFAULT_BG, DEFAULT_TEXT, DEFAULT_HOVER);
  }, []);

  const revertChanges = useCallback(() => {
    setCurrentTheme(savedTheme);
    setAccentColor(savedAccent);
    setBgColor(savedBg);
    setTextColor(savedText);
    setHoverColor(savedHover);
    setDensityState(savedDensity);
    setMessageGroupSpacingState(savedMessageGroupSpacing);
    setChatFontScaleState(savedChatFontScale);
    applyColorsToDOM(savedAccent, savedBg, savedText, savedHover);
  }, [savedTheme, savedAccent, savedBg, savedText, savedHover, savedDensity, savedMessageGroupSpacing, savedChatFontScale]);

  return {
    accentColor,
    bgColor,
    textColor,
    hoverColor,
    currentTheme,
    density,
    messageGroupSpacing,
    chatFontScale,
    loading,
    savedAccent,
    savedBg,
    savedText,
    savedHover,
    savedTheme,
    hasChanges,
    messageNotificationsEnabled,
    setMessageNotificationsEnabled,
    setTheme,
    setCustomColors,
    setDensity,
    setMessageGroupSpacing,
    setChatFontScale,
    savePreferences,
    resetToDefaults,
    revertChanges,
  };
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

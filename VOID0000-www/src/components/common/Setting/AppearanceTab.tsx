// src/components/common/Setting/AppearanceTab.tsx
import { useState, useEffect } from 'react';
import { useTheme, Theme } from '../../../Services/hooks/Settings/useTheme';
import { Check, Save, Sun, Moon, Sparkles } from 'lucide-react';

// Theme presets data - VOID is first (default)
const themePresets = [
  { id: 'void', name: 'Void', description: 'Dark and mysterious (default)', colors: ['#111827', '#6366f1'] },
  { id: 'ocean', name: 'Ocean', description: 'Deep blue waters', colors: ['#0f172a', '#0ea5e9'] },
  { id: 'forest', name: 'Forest', description: 'Rich green canopies', colors: ['#0c1f1c', '#10b981'] },
  { id: 'sunset', name: 'Sunset', description: 'Warm evening glow', colors: ['#1e1b2e', '#f97316'] },
  { id: 'midnight', name: 'Midnight', description: 'Deep purple night', colors: ['#030712', '#8b5cf6'] },
] as const;

// Helper to check if background is dark
const isDarkBackground = (bgColor: string): boolean => {
  if (!bgColor) return true;
  
  try {
    const hex = bgColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    
    const luminance = (r * 0.299 + g * 0.587 + b * 0.114);
    return luminance < 128;
  } catch {
    return true;
  }
};

const AppearanceTab = () => {
  const { 
    accentColor,
    bgColor,
    textColor,
    loading,
    setTheme,
    setCustomColors,
    savePreferences,
    resetToDefaults
  } = useTheme();
  
  const [localAccent, setLocalAccent] = useState(accentColor);
  const [localBg, setLocalBg] = useState(bgColor);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setLocalAccent(accentColor);
    setLocalBg(bgColor);
  }, [accentColor, bgColor]);

  const handleAccentChange = (value: string) => {
    setLocalAccent(value);
    setCustomColors(value, localBg);
  };

  const handleBgChange = (value: string) => {
    setLocalBg(value);
    setCustomColors(localAccent, value);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await savePreferences();
    } catch (error) {
      console.error('Failed to save:', error);
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-pulse text-gray-400">Loading preferences...</div>
      </div>
    );
  }

  const isDark = isDarkBackground(localBg);
  const isVoid = document.documentElement.getAttribute('data-theme') === 'void';

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-bold text-void-text mb-4">Appearance</h2>
        <p className="text-sm text-gray-400 mb-6">Customize how Void looks and feels</p>
      </div>

      {/* Default VOID badge */}
      {isVoid && (
        <div className="flex items-center gap-2 bg-void-accent/20 text-void-accent px-4 py-2 rounded-lg">
          <Sparkles className="w-4 h-4" />
          <span className="text-sm font-medium">You're using the default VOID theme</span>
        </div>
      )}

      {/* Theme Presets Section */}
      <div className="space-y-4">
        <h3 className="text-md font-semibold text-void-text flex items-center gap-2">
          <span className="w-1 h-4 bg-void-accent rounded-full" />
          Theme Presets
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {themePresets.map((preset) => {
            const isSelected = preset.colors[0] === bgColor && preset.colors[1] === accentColor;
            const presetIsDark = isDarkBackground(preset.colors[0]);
            const isVoidPreset = preset.id === 'void';
            
            return (
              <button
                key={preset.id}
                onClick={() => setTheme(preset.id as Theme)}
                className={`relative p-4 rounded-lg border-2 transition-all ${
                  isSelected
                    ? 'border-void-accent bg-void-bg-hover'
                    : 'border-void-bg-sec hover:border-void-accent/50 bg-void-bg-main'
                } ${isVoidPreset && !isSelected ? 'ring-1 ring-void-accent/30' : ''}`}
              >
                {isSelected && (
                  <div className="absolute top-2 right-2">
                    <Check className="w-4 h-4 text-void-accent" />
                  </div>
                )}
                
                {isVoidPreset && !isSelected && (
                  <div className="absolute top-2 right-2">
                    <span className="text-xs text-void-accent/50">default</span>
                  </div>
                )}
                
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex -space-x-2">
                    <div 
                      className="w-6 h-6 rounded-full border-2 border-void-bg-sec" 
                      style={{ backgroundColor: preset.colors[0] }}
                    />
                    <div 
                      className="w-6 h-6 rounded-full border-2 border-void-bg-sec" 
                      style={{ backgroundColor: preset.colors[1] }}
                    />
                  </div>
                  <span className="font-medium text-void-text">{preset.name}</span>
                  {presetIsDark ? (
                    <Moon className="w-3 h-3 text-gray-400" />
                  ) : (
                    <Sun className="w-3 h-3 text-yellow-500" />
                  )}
                </div>
                
                <p className="text-xs text-gray-400 text-left">{preset.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Divider */}
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-void-bg-sec"></div>
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="px-2 bg-void-bg-main text-gray-400">or customize</span>
        </div>
      </div>

      {/* Custom Colors Section */}
      <div className="space-y-4">
        <h3 className="text-md font-semibold text-void-text flex items-center gap-2">
          <span className="w-1 h-4 bg-void-accent rounded-full" />
          Custom Colors
        </h3>
        
        <div className="space-y-3">
          {/* Accent Color Picker */}
          <div className="flex items-center justify-between bg-void-bg-sec p-4 rounded-lg">
            <div>
              <h4 className="text-void-text font-medium">Accent Color</h4>
              <p className="text-xs text-gray-400">Buttons, links, and highlights</p>
            </div>
            <input 
              type="color" 
              value={localAccent}
              onChange={(e) => handleAccentChange(e.target.value)}
              className="w-10 h-10 rounded cursor-pointer bg-transparent border-0"
            />
          </div>

          {/* Background Color Picker */}
          <div className="flex items-center justify-between bg-void-bg-sec p-4 rounded-lg">
            <div>
              <h4 className="text-void-text font-medium">Background</h4>
              <p className="text-xs text-gray-400">Main app background</p>
            </div>
            <input 
              type="color" 
              value={localBg}
              onChange={(e) => handleBgChange(e.target.value)}
              className="w-10 h-10 rounded cursor-pointer bg-transparent border-0"
            />
          </div>
        </div>
      </div>

      {/* Live Preview Card */}
      <div 
        className="p-6 rounded-lg border-2 transition-all"
        style={{ 
          backgroundColor: localBg,
          borderColor: localAccent,
        }}
      >
        <h4 className="text-sm font-medium mb-3" style={{ color: textColor }}>Live Preview</h4>
        
        {/* Sample UI Elements */}
        <div className="space-y-4">
          {/* Button Example */}
          <button 
            className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
            style={{ 
              backgroundColor: localAccent,
              color: isDarkBackground(localAccent) ? '#f3f4f6' : '#111827'
            }}
          >
            Sample Button
          </button>

          {/* Text Example */}
          <div className="space-y-1">
            <p className="text-sm" style={{ color: textColor }}>Primary Text</p>
            <p className="text-sm opacity-70" style={{ color: textColor }}>Secondary Text (70% opacity)</p>
          </div>

          {/* Background Layers Example */}
          <div className="space-y-2">
            <div className="p-2 rounded" style={{ backgroundColor: adjustColor(localBg, 15) }}>
              <p className="text-xs" style={{ color: textColor }}>Secondary Background</p>
            </div>
            <div className="p-2 rounded" style={{ backgroundColor: adjustColor(localBg, 30) }}>
              <p className="text-xs" style={{ color: textColor }}>Hover Background</p>
            </div>
          </div>

          {/* Contrast Info */}
          <div className="flex items-center gap-2 pt-2 border-t" style={{ borderColor: adjustColor(localBg, 30) }}>
            {isDark ? (
              <Moon className="w-4 h-4" style={{ color: textColor }} />
            ) : (
              <Sun className="w-4 h-4 text-yellow-500" />
            )}
            <span className="text-xs" style={{ color: textColor }}>
              {isDark ? 'Dark mode' : 'Light mode'} - 
              {isVoid ? ' Default VOID theme' : ' Custom theme'}
            </span>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <button 
        onClick={handleSave}
        disabled={isSaving}
        className="w-full py-3 bg-void-accent hover:bg-void-accent-hover text-white rounded-lg font-bold transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {isSaving ? (
          <>Saving...</>
        ) : (
          <>
            <Save className="w-4 h-4" />
            Save Appearance
          </>
        )}
      </button>

      {/* Reset to VOID defaults link */}
      {!isVoid && (
        <div className="text-center">
          <button 
            onClick={resetToDefaults}
            className="text-xs text-gray-400 hover:text-void-accent transition-colors"
          >
            Reset to VOID defaults
          </button>
        </div>
      )}
    </div>
  );
};

// Helper function
const adjustColor = (hex: string, percent: number): string => {
  if (!hex) return '#1f2937';
  
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

export default AppearanceTab;
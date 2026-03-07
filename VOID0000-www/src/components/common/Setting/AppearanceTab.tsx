// src/components/common/Setting/AppearanceTab.tsx
import { useState } from 'react';
import { useTheme, Theme, THEME_PRESETS } from '../../../Services/hooks/Settings/useTheme';
import { Check, Save, Moon, Sun, Sparkles, RotateCcw } from 'lucide-react';

const themePresets = [
  { id: 'void' as Theme, name: 'Void', description: 'Dark and mysterious (default)', colors: ['#111827', '#6366f1'] },
  { id: 'ocean' as Theme, name: 'Ocean', description: 'Deep blue waters', colors: ['#0f172a', '#0ea5e9'] },
  { id: 'forest' as Theme, name: 'Forest', description: 'Rich green canopies', colors: ['#0c1f1c', '#10b981'] },
  { id: 'sunset' as Theme, name: 'Sunset', description: 'Warm evening glow', colors: ['#1e1b2e', '#f97316'] },
  { id: 'midnight' as Theme, name: 'Midnight', description: 'Deep purple night', colors: ['#030712', '#8b5cf6'] },
] as const;

const isDarkBackground = (bgColor: string): boolean => {
  if (!bgColor) return true;
  try {
    const hex = bgColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return (r * 0.299 + g * 0.587 + b * 0.114) < 128;
  } catch {
    return true;
  }
};

const AppearanceTab = () => {
  const {
    accentColor,
    bgColor,
    textColor,
    hoverColor,
    currentTheme,
    density,
    loading,
    hasChanges,
    setTheme,
    setCustomColors,
    setDensity,
    savePreferences,
    resetToDefaults,
  } = useTheme();

  const [isSaving, setIsSaving] = useState(false);

  const handleAccentChange = (value: string) => {
    setCustomColors(value, bgColor, textColor, hoverColor);
  };

  const handleBgChange = (value: string) => {
    setCustomColors(accentColor, value, textColor, hoverColor);
  };

  const handleTextChange = (value: string) => {
    setCustomColors(accentColor, bgColor, value, hoverColor);
  };

  const handleHoverChange = (value: string) => {
    setCustomColors(accentColor, bgColor, textColor, value);
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
        <div className="animate-pulse text-void-text-muted">Loading preferences...</div>
      </div>
    );
  }

  const isDark = isDarkBackground(bgColor);
  const isVoid = 
    currentTheme === 'void' && 
    accentColor === THEME_PRESETS.void.accent && 
    bgColor === THEME_PRESETS.void.bg &&
    textColor === THEME_PRESETS.void.text &&
    hoverColor === THEME_PRESETS.void.hover;

  return (
    <div className="space-y-8 pb-24">
      <div>
        <h2 className="text-lg font-bold text-void-text mb-4">Appearance</h2>
        <p className="text-sm text-void-text-muted mb-6">Customize how Void looks and feels</p>
      </div>

      {isVoid && (
        <div className="flex items-center gap-2 bg-void-accent/20 text-void-accent px-4 py-2 rounded-lg">
          <Sparkles className="w-4 h-4" />
          <span className="text-sm font-medium">You're using the default VOID theme</span>
        </div>
      )}

      {/* Theme Presets */}
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
                onClick={() => setTheme(preset.id)}
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
                    <Moon className="w-3 h-3 text-void-text-muted" />
                  ) : (
                    <Sun className="w-3 h-3 text-yellow-500" />
                  )}
                </div>

                <p className="text-xs text-void-text-muted text-left">{preset.description}</p>
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
          <span className="px-2 bg-void-bg-main text-void-text-muted">or customize</span>
        </div>
      </div>

      {/* Custom Colors */}
      <div className="space-y-4">
        <h3 className="text-md font-semibold text-void-text flex items-center gap-2">
          <span className="w-1 h-4 bg-void-accent rounded-full" />
          Custom Colors
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="flex items-center justify-between bg-void-bg-sec p-4 rounded-lg">
            <div>
              <h4 className="text-void-text font-medium text-sm">Accent</h4>
              <p className="text-xs text-void-text-muted">Buttons & highlights</p>
            </div>
            <input
              type="color"
              value={accentColor}
              onChange={(e) => handleAccentChange(e.target.value)}
              className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
            />
          </div>

          <div className="flex items-center justify-between bg-void-bg-sec p-4 rounded-lg">
            <div>
              <h4 className="text-void-text font-medium text-sm">Text Color</h4>
              <p className="text-xs text-void-text-muted">Primary typography</p>
            </div>
            <input
              type="color"
              value={textColor}
              onChange={(e) => handleTextChange(e.target.value)}
              className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
            />
          </div>

          <div className="flex items-center justify-between bg-void-bg-sec p-4 rounded-lg">
            <div>
              <h4 className="text-void-text font-medium text-sm">Background</h4>
              <p className="text-xs text-void-text-muted">Main app base</p>
            </div>
            <input
              type="color"
              value={bgColor}
              onChange={(e) => handleBgChange(e.target.value)}
              className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
            />
          </div>

          <div className="flex items-center justify-between bg-void-bg-sec p-4 rounded-lg">
            <div>
              <h4 className="text-void-text font-medium text-sm">Hover State</h4>
              <p className="text-xs text-void-text-muted">Menus & active items</p>
            </div>
            <input
              type="color"
              value={hoverColor}
              onChange={(e) => handleHoverChange(e.target.value)}
              className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
            />
          </div>
        </div>
      </div>

      {/* Chat Density */}
      <div className="space-y-4">
        <h3 className="text-md font-semibold text-void-text flex items-center gap-2">
          <span className="w-1 h-4 bg-void-accent rounded-full" />
          Chat Density
        </h3>
        <div className="grid grid-cols-2 gap-3">
          {([
            { id: 'compact', label: 'Compact', desc: 'More messages on screen' },
            { id: 'comfortable', label: 'Comfortable', desc: 'More breathing room' },
          ] as const).map(({ id, label, desc }) => (
            <button
              key={id}
              onClick={() => setDensity(id)}
              className={`p-4 rounded-lg border-2 text-left transition-all ${
                density === id
                  ? 'border-void-accent bg-void-bg-hover'
                  : 'border-void-bg-sec hover:border-void-accent/50 bg-void-bg-main'
              }`}
            >
              {density === id && (
                <div className="float-right">
                  <Check className="w-4 h-4 text-void-accent" />
                </div>
              )}
              <p className="font-medium text-sm text-void-text">{label}</p>
              <p className="text-xs text-void-text-muted mt-0.5">{desc}</p>
              <div className="mt-3 flex flex-col" style={{ gap: id === 'compact' ? '4px' : '8px' }}>
                {[70, 50, 85].map((w, i) => (
                  <div key={i} className="h-1.5 rounded-full bg-void-accent/30" style={{ width: `${w}%` }} />
                ))}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ✨ RESTRUCTURED LIVE PREVIEW ✨ */}
      <div
        className="p-6 rounded-lg border-2 transition-all shadow-md overflow-hidden"
        style={{
          backgroundColor: bgColor,
          borderColor: `color-mix(in srgb, ${textColor} 15%, ${bgColor})`
        }}
      >
        <h4 className="text-sm font-bold mb-4" style={{ color: textColor }}>Live Chat Preview</h4>

        <div className="w-full">
          {density === 'compact' ? (
            /* COMPACT PREVIEW: Name above, Avatar + Bubble below */
            <div className="flex flex-col gap-4 w-full">
              {/* Other Person */}
              <div className="flex flex-col items-start w-full">
                <span className="text-[10px] font-semibold px-1 ml-10 mb-1" style={{ color: accentColor }}>Alice</span>
                <div className="flex items-end gap-2 w-full">
                  <div 
                    className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold" 
                    style={{ backgroundColor: `color-mix(in srgb, ${accentColor} 30%, ${bgColor})`, color: textColor }}
                  >
                    A
                  </div>
                  <div className="rounded-2xl rounded-bl-sm text-xs px-3 py-1.5" style={{ backgroundColor: hoverColor, color: textColor }}>
                    Hey! Did you see the new update?
                  </div>
                </div>
              </div>
              
              {/* You */}
              <div className="flex flex-col items-start w-full">
                <span className="text-[10px] font-semibold px-1 ml-10 mb-1" style={{ color: accentColor }}>You</span>
                <div className="flex items-end gap-2 w-full">
                  <div 
                    className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold shadow-sm" 
                    style={{ backgroundColor: accentColor, color: isDarkBackground(accentColor) ? '#f3f4f6' : '#111827' }}
                  >
                    Y
                  </div>
                  <div 
                    className="rounded-2xl rounded-bl-sm text-xs px-3 py-1.5 font-medium shadow-sm" 
                    style={{ backgroundColor: accentColor, color: isDarkBackground(accentColor) ? '#f3f4f6' : '#111827' }}
                  >
                    Yes! The compact layout is perfect now 🎉
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* COMFORTABLE PREVIEW: Right aligned for you, left for them */
            <div className="flex flex-col gap-5 w-full">
              {/* Other Person */}
              <div className="flex flex-col items-start w-full">
                <span className="text-[10px] font-semibold px-1 ml-10 mb-1" style={{ color: accentColor }}>Alice</span>
                <div className="flex items-end gap-2 w-full">
                  <div 
                    className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold" 
                    style={{ backgroundColor: `color-mix(in srgb, ${accentColor} 30%, ${bgColor})`, color: textColor }}
                  >
                    A
                  </div>
                  <div className="flex flex-col items-start gap-1 w-full max-w-[80%]">
                    <div className="rounded-2xl rounded-bl-sm text-sm px-4 py-2.5 shadow-sm" style={{ backgroundColor: hoverColor, color: textColor }}>
                      Hey! Did you see the new update?
                    </div>
                  </div>
                </div>
              </div>

              {/* You */}
              <div className="flex flex-col items-end w-full">
                {/* No name shown for your own messages in comfortable mode */}
                <div className="flex items-end flex-row-reverse w-full">
                  <div className="flex flex-col items-end gap-1 w-full max-w-[80%]">
                    <div 
                      className="rounded-2xl rounded-br-sm text-sm font-medium px-4 py-2.5 shadow-sm" 
                      style={{ backgroundColor: accentColor, color: isDarkBackground(accentColor) ? '#f3f4f6' : '#111827' }}
                    >
                      Yes! Comfortable mode is super clean without avatars 🎉
                    </div>
                    <span className="text-[10px] px-1 font-medium" style={{ color: `color-mix(in srgb, ${textColor} 40%, transparent)` }}>10:42 AM</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-4 mt-4 border-t" style={{ borderColor: `color-mix(in srgb, ${textColor} 15%, ${bgColor})` }}>
          {isDark ? (
            <Moon className="w-4 h-4" style={{ color: textColor }} />
          ) : (
            <Sun className="w-4 h-4 text-yellow-500" />
          )}
          <span className="text-xs" style={{ color: textColor }}>
            {isDark ? 'Dark mode' : 'Light mode'} · {density === 'compact' ? 'Compact' : 'Comfortable'}
          </span>
        </div>
      </div>

      {!isVoid && (
        <div className="text-center">
          <button
            onClick={resetToDefaults}
            className="inline-flex items-center gap-1.5 text-xs text-void-text-muted hover:text-void-accent transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            Reset to VOID defaults
          </button>
        </div>
      )}

      <div className="absolute bottom-6 right-6 md:right-8 md:bottom-8 z-50">
        <button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className={`flex items-center gap-2 px-5 py-3 rounded-xl font-bold text-sm shadow-lg transition-all ${
            hasChanges
              ? 'bg-void-accent hover:bg-void-accent-hover text-white shadow-void-accent/25'
              : 'bg-void-bg-hover text-void-text-muted cursor-not-allowed'
          }`}
        >
          <Save className="w-4 h-4" />
          {isSaving ? 'Saving...' : hasChanges ? 'Save Changes' : 'No Changes'}
        </button>
      </div>
    </div>
  );
};

export default AppearanceTab;
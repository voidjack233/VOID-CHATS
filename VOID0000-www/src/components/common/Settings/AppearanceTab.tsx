// src/components/common/Settings/AppearanceTab.tsx
import { useState } from 'react';
import { useTheme, Theme, THEME_PRESETS } from '../../../Services/hooks/Settings/useTheme';
import { Check, Save, Moon, Sun, Sparkles, RotateCcw, Pipette } from 'lucide-react';
import { AppearanceTabSkeleton } from '../Skeleton';

const themePresets = [
  { id: 'void' as Theme, name: 'Void', description: 'Dark and mysterious (default)', colors: ['#111827', '#6366f1'] },
  { id: 'ocean' as Theme, name: 'Ocean', description: 'Deep blue waters', colors: ['#0f172a', '#0ea5e9'] },
  { id: 'forest' as Theme, name: 'Forest', description: 'Rich green canopies', colors: ['#0c1f1c', '#10b981'] },
  { id: 'sunset' as Theme, name: 'Sunset', description: 'Warm evening glow', colors: ['#1e1b2e', '#f97316'] },
  { id: 'midnight' as Theme, name: 'Midnight', description: 'Deep purple night', colors: ['#030712', '#8b5cf6'] },
] as const;

const messageGroupSpacingOptions = [0, 4, 8, 16, 24] as const;
const chatFontScaleOptions = [12, 14, 15, 16, 18, 20, 24] as const;

function NativeColorRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-lg bg-void-bg-sec p-4">
      <div>
        <h4 className="text-sm font-medium text-void-text">{label}</h4>
        <p className="text-xs text-void-text-muted">{description}</p>
      </div>

      <div className="flex items-center gap-3">
        <span className="rounded-full border border-void-bg-hover bg-void-bg-main px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-void-text-muted">
          {value}
        </span>

        <div className="relative h-10 w-10 overflow-hidden rounded-full border border-void-bg-hover bg-void-bg-main shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label={`${label} color picker`}
          />
          <div
            className="absolute inset-[5px] rounded-full"
            style={{ backgroundColor: value }}
          />
          <div className="absolute inset-0 flex items-center justify-center text-white/90 mix-blend-difference pointer-events-none">
            <Pipette className="h-4 w-4" />
          </div>
        </div>
      </div>
    </label>
  );
}

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
    messageGroupSpacing,
    chatFontScale,
    loading,
    hasChanges,
    setTheme,
    setCustomColors,
    setDensity,
    setMessageGroupSpacing,
    setChatFontScale,
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

  if (loading) return <AppearanceTabSkeleton />;

  const isDark = isDarkBackground(bgColor);
  const isVoid =
    currentTheme === 'void' &&
    accentColor === THEME_PRESETS.void.accent &&
    bgColor === THEME_PRESETS.void.bg &&
    textColor === THEME_PRESETS.void.text &&
    hoverColor === THEME_PRESETS.void.hover;
  const compactPreviewGap = Math.max(8, messageGroupSpacing + 8);
  const comfortablePreviewGap = Math.max(12, messageGroupSpacing + 12);
  const previewNameSize = Math.max(10, chatFontScale - 5);
  const previewMetaSize = Math.max(10, chatFontScale - 5);
  const previewBubbleCompact = Math.max(12, chatFontScale - 2);
  const previewBubbleComfortable = Math.max(13, chatFontScale);
  const selectedMessageSpacingIndex = messageGroupSpacingOptions.indexOf(messageGroupSpacing);
  const selectedChatFontScaleIndex = chatFontScaleOptions.indexOf(chatFontScale);

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
            const isSelected =
              accentColor === THEME_PRESETS[preset.id].accent &&
              bgColor === THEME_PRESETS[preset.id].bg &&
              textColor === THEME_PRESETS[preset.id].text &&
              hoverColor === THEME_PRESETS[preset.id].hover;
            const presetIsDark = isDarkBackground(preset.colors[0]);
            const isVoidPreset = preset.id === 'void';
            return (
              <button
                key={preset.id}
                onClick={() => setTheme(preset.id)}
                className={`relative p-4 rounded-lg border-2 transition-all ${isSelected
                  ? 'border-void-accent bg-void-bg-hover'
                  : 'border-void-bg-sec hover:border-void-accent/50 bg-void-bg-main'
                  }`}
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
          <NativeColorRow
            label="Accent"
            description="Buttons & highlights"
            value={accentColor}
            onChange={handleAccentChange}
          />

          <NativeColorRow
            label="Text Color"
            description="Primary typography"
            value={textColor}
            onChange={handleTextChange}
          />

          <NativeColorRow
            label="Background"
            description="Main app base"
            value={bgColor}
            onChange={handleBgChange}
          />

          <NativeColorRow
            label="Hover State"
            description="Menus & active items"
            value={hoverColor}
            onChange={handleHoverChange}
          />
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
              className={`p-4 rounded-lg border-2 text-left transition-all ${density === id
                ? 'border-void-accent bg-void-bg-hover'
                : 'border-void-bg-sec hover:border-void-accent/50 bg-void-bg-main'
                }`}
            >
              <div className="flex items-center justify-between mb-1">
                <p className="font-medium text-sm text-void-text">{label}</p>
                {density === id && <Check className="w-4 h-4 text-void-accent" />}
              </div>
              <p className="text-xs text-void-text-muted mb-3">{desc}</p>

              {/* Mini chat preview (Ghost Elements) */}
              <div className="flex flex-col w-full mt-2" style={{ gap: id === 'compact' ? '4px' : '8px' }}>
                {id === 'compact' ? (
                  /* COMPACT GHOST: All left aligned. Middle message is consecutive (no avatar space). */
                  <>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-void-accent/40 flex-shrink-0" />
                      <div className="h-2.5 rounded-full bg-void-accent/20 w-[65%]" />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 flex-shrink-0" /> {/* Avatar offset for consecutive message */}
                      <div className="h-2.5 rounded-full bg-void-accent/20 w-[45%]" />
                    </div>
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <div className="w-3 h-3 rounded-full bg-void-accent/40 flex-shrink-0" />
                      <div className="h-2.5 rounded-full bg-void-accent/60 w-[55%]" /> {/* "You" message */}
                    </div>
                  </>
                ) : (
                  /* COMFORTABLE GHOST: Alternating left/right. Right side has no avatar. */
                  <>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-void-accent/40 flex-shrink-0" />
                      <div className="h-2.5 rounded-full bg-void-accent/20 w-[65%]" />
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      <div className="h-2.5 rounded-full bg-void-accent/60 w-[55%]" /> {/* "You" message right aligned */}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-void-accent/40 flex-shrink-0" />
                      <div className="h-2.5 rounded-full bg-void-accent/20 w-[40%]" />
                    </div>
                  </>
                )}
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
            <div className="flex flex-col w-full" style={{ gap: `${compactPreviewGap}px` }}>
              {/* Other Person */}
              <div className="flex flex-col items-start w-full">
                <span
                  className="font-semibold px-1 ml-10 mb-1"
                  style={{ color: accentColor, fontSize: `${previewNameSize}px` }}
                >
                  Alice
                </span>
                <div className="flex items-end gap-2 w-full">
                  <div
                    className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold"
                    style={{ backgroundColor: `color-mix(in srgb, ${accentColor} 30%, ${bgColor})`, color: textColor }}
                  >
                    A
                  </div>
                  <div
                    className="rounded-2xl rounded-bl-sm px-3 py-1.5"
                    style={{ backgroundColor: hoverColor, color: textColor, fontSize: `${previewBubbleCompact}px` }}
                  >
                    Hey! Did you see the new update?
                  </div>
                </div>
              </div>

              {/* You */}
              <div className="flex flex-col items-start w-full">
                <span
                  className="font-semibold px-1 ml-10 mb-1"
                  style={{ color: accentColor, fontSize: `${previewNameSize}px` }}
                >
                  You
                </span>
                <div className="flex items-end gap-2 w-full">
                  <div
                    className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold shadow-sm"
                    style={{ backgroundColor: accentColor, color: isDarkBackground(accentColor) ? '#f3f4f6' : '#111827' }}
                  >
                    Y
                  </div>
                  <div
                    className="rounded-2xl rounded-bl-sm px-3 py-1.5 font-medium shadow-sm"
                    style={{
                      backgroundColor: accentColor,
                      color: isDarkBackground(accentColor) ? '#f3f4f6' : '#111827',
                      fontSize: `${previewBubbleCompact}px`,
                    }}
                  >
                    Yes! The compact layout is perfect 🎉
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* COMFORTABLE PREVIEW: Right aligned for you, left for them */
            <div className="flex flex-col w-full" style={{ gap: `${comfortablePreviewGap}px` }}>
              {/* Other Person */}
              <div className="flex flex-col items-start w-full">
                <span
                  className="font-semibold px-1 ml-10 mb-1"
                  style={{ color: accentColor, fontSize: `${previewNameSize}px` }}
                >
                  Alice
                </span>
                <div className="flex items-end gap-2 w-full">
                  <div
                    className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold"
                    style={{ backgroundColor: `color-mix(in srgb, ${accentColor} 30%, ${bgColor})`, color: textColor }}
                  >
                    A
                  </div>
                  <div className="flex flex-col items-start gap-1 w-full max-w-[80%]">
                    <div
                      className="rounded-2xl rounded-bl-sm px-4 py-2.5 shadow-sm"
                      style={{ backgroundColor: hoverColor, color: textColor, fontSize: `${previewBubbleComfortable}px` }}
                    >
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
                      className="rounded-2xl rounded-br-sm font-medium px-4 py-2.5 shadow-sm"
                      style={{
                        backgroundColor: accentColor,
                        color: isDarkBackground(accentColor) ? '#f3f4f6' : '#111827',
                        fontSize: `${previewBubbleComfortable}px`,
                      }}
                    >
                      Yes! Comfortable layout is perfect 🎉
                    </div>
                    <span
                      className="px-1 font-medium"
                      style={{
                        color: `color-mix(in srgb, ${textColor} 40%, transparent)`,
                        fontSize: `${previewMetaSize}px`,
                      }}
                    >
                      10:42 AM
                    </span>
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

      <div className="space-y-5 rounded-lg border border-void-bg-sec bg-void-bg-sec/40 p-5">
        <div>
          <h3 className="text-md font-semibold text-void-text flex items-center gap-2">
            <span className="w-1 h-4 bg-void-accent rounded-full" />
            Chat Layout Controls
          </h3>
          <p className="mt-1 text-xs text-void-text-muted">
            Adjust message group spacing and chat font size for both the preview and your chat view.
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-void-text">Space Between Message Groups</p>
              <p className="text-xs text-void-text-muted">Controls the vertical gap between separated message clusters.</p>
            </div>
            <span className="rounded-full bg-void-bg-main px-3 py-1 text-xs font-semibold text-void-text">
              {messageGroupSpacing}px
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={messageGroupSpacingOptions.length - 1}
            step={1}
            value={selectedMessageSpacingIndex}
            onChange={(e) => setMessageGroupSpacing(messageGroupSpacingOptions[Number(e.target.value)] ?? 8)}
            className="w-full accent-void-accent"
          />

          <div className="flex justify-between text-[11px] text-void-text-muted">
            {messageGroupSpacingOptions.map((value) => (
              <span key={value}>{value}px</span>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-void-text">Chat Font Scaling</p>
              <p className="text-xs text-void-text-muted">Scales message text in both the preview and the actual chat view.</p>
            </div>
            <span className="rounded-full bg-void-bg-main px-3 py-1 text-xs font-semibold text-void-text">
              {chatFontScale}px
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={chatFontScaleOptions.length - 1}
            step={1}
            value={selectedChatFontScaleIndex}
            onChange={(e) => setChatFontScale(chatFontScaleOptions[Number(e.target.value)] ?? 16)}
            className="w-full accent-void-accent"
          />

          <div className="flex justify-between text-[11px] text-void-text-muted">
            {chatFontScaleOptions.map((value) => (
              <span key={value}>{value}px</span>
            ))}
          </div>
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
          className={`flex items-center gap-2 px-5 py-3 rounded-xl font-bold text-sm shadow-lg transition-all ${hasChanges
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

import { ArrowDown } from 'lucide-react';

interface JumpToPresentButtonProps {
  visible: boolean;
  disabledByKeyboard: boolean;
  onJump: () => void;
}

export default function JumpToPresentButton({
  visible,
  disabledByKeyboard,
  onJump,
}: JumpToPresentButtonProps) {
  if (!visible || disabledByKeyboard) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-4 sm:bottom-4">
      <button
        onClick={onJump}
        className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-void-accent px-4 py-2 text-xs font-bold text-white shadow-lg transition-colors hover:bg-void-accent-hover"
      >
        <ArrowDown className="h-3.5 w-3.5" />
        Jump to Present
      </button>
    </div>
  );
}

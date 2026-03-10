import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderPlus, X } from 'lucide-react';

interface CreateCategoryModalProps {
  groupName?: string | null;
  existingNames: string[];
  onClose: () => void;
  onCreated: (name: string) => Promise<void> | void;
}

export default function CreateCategoryModal({
  groupName,
  existingNames,
  onClose,
  onCreated,
}: CreateCategoryModalProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const normalizedExistingNames = useMemo(
    () => new Set(existingNames.map((item) => item.trim().toLowerCase())),
    [existingNames]
  );

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Category name is required');
      return;
    }

    if (normalizedExistingNames.has(trimmed.toLowerCase())) {
      setError('That category already exists');
      return;
    }

    setCreating(true);
    setError('');

    try {
      await onCreated(trimmed);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to create category');
    } finally {
      setCreating(false);
    }
  };

  const modal = (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-void-border bg-void-bg-sec shadow-2xl">
        <div className="flex items-center justify-between border-b border-void-border px-5 py-4">
          <div className="flex items-center gap-2">
            <FolderPlus className="h-4 w-4 text-void-accent" />
            <h2 className="text-base font-semibold text-void-text">Create Category</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div>
            <label className="mb-1 block text-sm text-void-text-muted">Category Name</label>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError('');
              }}
              placeholder="INFO"
              maxLength={100}
              className="w-full rounded-lg bg-void-bg-hover px-3 py-2 text-sm text-void-text placeholder-void-text-muted focus:outline-none focus:ring-2 focus:ring-void-accent"
            />
            <p className="mt-2 text-xs text-void-text-muted">
              This adds a channel category in <span className="font-semibold text-void-text">{groupName || 'this group'}</span>.
            </p>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-void-border px-5 py-4">
          <button
            onClick={onClose}
            disabled={creating}
            className="px-4 py-2 text-sm text-void-text-muted transition-colors hover:text-void-text"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="rounded-lg bg-void-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-void-accent-hover disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Category'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

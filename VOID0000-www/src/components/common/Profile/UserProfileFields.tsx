import React from 'react';
import { AlertCircle } from 'lucide-react';
import { UserProfileFieldsProps } from './types';

const UserProfileFields: React.FC<UserProfileFieldsProps> = ({
  displayProfile,
  isEditing,
  bioError,
  error,
  uploadError,
  handleBioChange,
}) => {
  return (
    <>
      {/* Bio */}
      <div className="mb-2">
        <label className="block text-[11px] font-semibold text-void-text-muted uppercase tracking-wide mb-1.5">
          About Me
        </label>
        {isEditing ? (
          <div>
            <textarea
              value={displayProfile.bio || ''}
              onChange={handleBioChange}
              maxLength={200}
              placeholder="Tell us about yourself..."
              className={`w-full bg-gray-900 border rounded-lg px-3 py-2 text-void-text text-sm resize-none focus:outline-none transition-colors ${
                bioError
                  ? 'border-red-500 focus:border-red-500'
                  : 'border-void-border focus:border-blue-500'
              }`}
              rows={3}
            />
            <div className="flex justify-between mt-1">
              <span className={`text-[11px] ${bioError ? 'text-red-400' : 'text-void-text-muted'}`}>
                {displayProfile.bio?.length || 0}/200
              </span>
              {bioError && (
                <span className="text-[11px] text-red-400">{bioError}</span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-void-text leading-relaxed">
            {displayProfile.bio || (
              <span className="text-void-text-muted italic">No bio yet</span>
            )}
          </p>
        )}
      </div>

      {/* Error */}
      {error && !bioError && !uploadError && (
        <div className="mt-3 p-2.5 bg-red-900/50 border border-red-700 rounded-lg flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}
    </>
  );
};

export default UserProfileFields;
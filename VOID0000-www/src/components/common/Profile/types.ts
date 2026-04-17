import { RefObject, ChangeEvent } from 'react';
import { ProfileRecord as ProfileType } from '../../../Services/hooks/profile/useProfileRecord';

export interface UserProfileProps {
  profileId: string;
  onClose: () => void;
}

export interface UserProfileHeaderProps {
  displayProfile: ProfileType;
  // New props for Unified Edit Mode
  previewUrl: string | null;
  isEditing: boolean;
  isUploading: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileSelect: (event: ChangeEvent<HTMLInputElement>) => void;
  uploadError: string | null;
  allowUpload?: boolean;
}

export interface UserProfileFieldsProps {
  displayProfile: ProfileType;
  draftProfile: ProfileType;
  isEditing: boolean;
  bioError: string | null;
  error: string | null;
  uploadError: string | null;
  setDraftProfile: (profile: ProfileType) => void;
  handleBioChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
}

export interface UserProfileActionsProps {
  isEditing: boolean;
  isUploading: boolean;
  bioError: string | null;
  setIsEditing: (editing: boolean) => void;
  handleSave: () => Promise<void>;
  handleCancel: () => void;
}

export interface UserProfileStatusProps {
  created_at: string;
}

export interface UserProfileErrorProps {
  error: string;
  onClose: () => void;
}

export interface UserProfileEmptyProps {
  onClose: () => void;
}

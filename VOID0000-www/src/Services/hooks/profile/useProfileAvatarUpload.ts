import { useState, useRef, useCallback } from "react";
import { ensureCSRFToken } from '../../Auth/authServiceApi'; // CRITICAL FOR FIXING 403
import { API_URL } from '../../config';

interface UseProfileAvatarUploadReturn {
  uploadError: string | null;
  isUploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  validateFile: (file: File) => string | null;
  uploadProfileAvatar: (file: File) => Promise<string>;
  clearError: () => void;
}

const VALID_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"] as const;
// Your server has a 10MB limit. Base64 adds ~33% overhead.
// Safety limit: 7MB to be safe.
const MAX_FILE_SIZE = 7 * 1024 * 1024; 

const ERROR_MESSAGES = {
  INVALID_FILE_TYPE: "Please select a valid image file (JPEG, PNG, GIF, WebP)",
  FILE_TOO_LARGE: "Image is too large. Please choose an image under 7MB.",
  UPLOAD_FAILED: "Avatar upload failed",
  FILE_READ_ERROR: "Failed to read image file",
  CSRF_MISSING: "Security token missing. Please refresh the page.",
} as const;

export const useProfileAvatarUpload = (): UseProfileAvatarUploadReturn => {
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const clearError = useCallback(() => setUploadError(null), []);

  // 1. Validation Logic
  const validateFile = useCallback((file: File): string | null => {
    if (!VALID_IMAGE_TYPES.includes(file.type as any)) {
      return ERROR_MESSAGES.INVALID_FILE_TYPE;
    }
    if (file.size > MAX_FILE_SIZE) {
      return ERROR_MESSAGES.FILE_TOO_LARGE;
    }
    return null;
  }, []);

  // 2. Helper: Convert File to Base64
  const readFileAsDataURL = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (reader.result && typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error(ERROR_MESSAGES.FILE_READ_ERROR));
        }
      };
      reader.onerror = () => reject(new Error(ERROR_MESSAGES.FILE_READ_ERROR));
      reader.readAsDataURL(file);
    });
  };

  // 3. Upload Logic (Manual Trigger)
  const uploadProfileAvatar = useCallback(async (file: File): Promise<string> => {
    setIsUploading(true);
    setUploadError(null);

    try {
      // Step A: Get CSRF Token (Fixes 403)
      const csrfToken = await ensureCSRFToken();
      if (!csrfToken) {
        throw new Error(ERROR_MESSAGES.CSRF_MISSING);
      }

      // Step B: Convert to Base64
      const base64Image = await readFileAsDataURL(file);

      // Step C: Fetch
      const response = await fetch(`${API_URL}/api/users/profile/avatar`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken, // <--- THE KEY TO FIXING 403
        },
        credentials: "include",
        body: JSON.stringify({ avatar: base64Image }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        
        // Handle specific server errors
        if (response.status === 413) throw new Error("File is too large for the server.");
        if (response.status === 403) throw new Error("Permission denied. Try refreshing the page.");
        
        throw new Error(data.error || ERROR_MESSAGES.UPLOAD_FAILED);
      }

      const data = await response.json();
      return data.avatar_url;

    } catch (error: any) {
      console.error("Avatar upload error:", error);
      const msg = error.message || ERROR_MESSAGES.UPLOAD_FAILED;
      setUploadError(msg);
      throw new Error(msg);
    } finally {
      setIsUploading(false);
    }
  }, []);

  return {
    uploadError,
    isUploading,
    fileInputRef,
    validateFile,
    uploadProfileAvatar,
    clearError,
  };
};

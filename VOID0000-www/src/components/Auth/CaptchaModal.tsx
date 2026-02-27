import { useState, useEffect } from 'react';
import { API_URL } from '../../Services/config';

interface CaptchaModalProps {
  isOpen: boolean;
  onVerified: (captchaId: string, captchaAnswer: string) => void;
  onClose: () => void;
}

export default function CaptchaModal({ isOpen, onVerified, onClose }: CaptchaModalProps) {
  const [image, setImage] = useState<string | null>(null);
  const [captchaId, setCaptchaId] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchCaptcha = async () => {
    setLoading(true);
    setAnswer('');
    setError('');

    try {
      const response = await fetch(`${API_URL}/api/captcha/generate`);
      const data = await response.json();

      if (data.success) {
        setImage(data.image);
        setCaptchaId(data.captchaId);
      } else {
        setError('Failed to load captcha');
      }
    } catch (err) {
      setError('Failed to load captcha');
    } finally {
      setLoading(false);
    }
  };

  // Fetch captcha when modal opens
  useEffect(() => {
    if (isOpen) {
      fetchCaptcha();
      setAnswer('');
      setError('');
    }
  }, [isOpen]);

  const handleSubmit = () => {
    if (!captchaId || !answer.trim()) {
      setError('Please enter the characters');
      return;
    }

    onVerified(captchaId, answer.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
    if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-gray-800 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
        
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">Security Check</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        {/* Captcha Display & Refresh Button Container */}
        <div className="flex items-center gap-3 mb-4">
          {/* Captcha Image Wrapper */}
          <div className="relative flex-1 overflow-hidden rounded-lg border border-gray-600 bg-gray-700/50">
            {loading ? (
              <div className="flex h-[80px] items-center justify-center">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
              </div>
            ) : image ? (
              <img
                src={image}
                alt="Captcha"
                className="w-full h-[80px] object-contain"
                draggable={false}
              />
            ) : (
              <div className="flex h-[80px] items-center justify-center">
                <p className="text-gray-400 text-sm">Failed to load</p>
              </div>
            )}
          </div>

          {/* Refresh Button - Positioned beside the image */}
          <button
            type="button"
            onClick={fetchCaptcha}
            disabled={loading}
            className="flex shrink-0 h-[80px] w-[50px] items-center justify-center rounded-lg border border-gray-600 bg-gray-700/50 text-gray-400 hover:bg-gray-600 hover:text-white disabled:opacity-50 transition-all"
            title="Refresh captcha"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
              />
            </svg>
          </button>
        </div>

        {/* Input */}
        <input
          type="text"
          value={answer}
          onChange={(e) => {
            setAnswer(e.target.value);
            setError('');
          }}
          onKeyDown={handleKeyDown}
          placeholder="Enter the characters above"
          className="w-full px-4 py-2.5 bg-gray-700/50 border border-gray-600 rounded-xl text-white text-center text-lg tracking-widest placeholder:text-sm placeholder:tracking-normal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent mb-4"
          autoComplete="off"
          autoFocus
        />

        {/* Error */}
        {error && (
          <p className="text-red-500 text-sm text-center mb-4">{error}</p>
        )}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={loading || !answer.trim()}
          className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          Verify
        </button>
      </div>
    </div>
  );
}
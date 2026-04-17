// src/components/common/BlurImage.tsx
// Image with blurhash canvas placeholder that fades out once the image loads.

import { useEffect, useRef, useState } from 'react';
import { decode } from 'blurhash';

interface BlurImageProps {
  src: string;
  blurhash?: string;
  alt?: string;
  className?: string;
  onLoad?: (image: HTMLImageElement) => void;
  loading?: 'eager' | 'lazy';
}

const THUMB = 32; // decode resolution — small for perf, upscaled via CSS

interface BlurhashPlaceholderProps {
  blurhash?: string;
  className?: string;
}

export const BlurhashPlaceholder = ({
  blurhash,
  className = '',
}: BlurhashPlaceholderProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!blurhash || !canvasRef.current) return;
    try {
      const pixels = decode(blurhash, THUMB, THUMB);
      const ctx = canvasRef.current.getContext('2d');
      if (!ctx) return;
      const imageData = ctx.createImageData(THUMB, THUMB);
      imageData.data.set(pixels);
      ctx.putImageData(imageData, 0, 0);
    } catch {
      // invalid hash — canvas stays blank
    }
  }, [blurhash]);

  if (!blurhash) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      width={THUMB}
      height={THUMB}
      className={className}
    />
  );
};

const BlurImage = ({
  src,
  blurhash,
  alt = '',
  className = '',
  onLoad,
  loading = 'lazy',
}: BlurImageProps) => {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="relative w-full h-full">
      {blurhash && !loaded && (
        <BlurhashPlaceholder
          blurhash={blurhash}
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
      <img
        src={src}
        alt={alt}
        loading={loading}
        decoding="async"
        onLoad={(event) => {
          setLoaded(true);
          onLoad?.(event.currentTarget);
        }}
        className={`${className} transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  );
};

export default BlurImage;

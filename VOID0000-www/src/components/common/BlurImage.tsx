// src/components/common/BlurImage.tsx
// Image with blurhash canvas placeholder that fades out once the image loads.

import { useEffect, useRef, useState } from 'react';
import { decode } from 'blurhash';

interface BlurImageProps {
  src: string;
  blurhash?: string;
  alt?: string;
  className?: string;
}

const THUMB = 32; // decode resolution — small for perf, upscaled via CSS

const BlurImage = ({ src, blurhash, alt = '', className = '' }: BlurImageProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);

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
      // invalid hash — canvas stays blank, image still shows
    }
  }, [blurhash]);

  return (
    <div className="relative w-full h-full">
      {blurhash && !loaded && (
        <canvas
          ref={canvasRef}
          width={THUMB}
          height={THUMB}
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        className={`${className} transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  );
};

export default BlurImage;

interface PresenceDotProps {
  status: 'online' | 'idle' | 'offline';
  size?: 'sm' | 'md';
}

const colors = {
  online: 'bg-green-500',
  idle: 'bg-yellow-500',
  offline: 'bg-gray-500',
};

const sizes = {
  sm: 'w-2.5 h-2.5',
  md: 'w-3 h-3',
};

export default function PresenceDot({ status, size = 'sm' }: PresenceDotProps) {
  return (
    <span
      className={`${colors[status]} ${sizes[size]} rounded-full inline-block ring-2 ring-void-bg-secondary`}
      title={status.charAt(0).toUpperCase() + status.slice(1)}
    />
  );
}
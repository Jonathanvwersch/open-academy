import { useRouter } from '@tanstack/react-router';
import { Button } from './ui/button.js';

export function RouteLoadError({
  message,
  className,
  role,
}: {
  message: string;
  className?: string;
  role?: 'alert';
}) {
  const router = useRouter();
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border p-4">
      <p className={`text-sm ${className ?? ''}`} role={role}>
        {message}
      </p>
      <Button variant="outline" size="sm" type="button" onClick={() => void router.invalidate()}>
        Retry
      </Button>
    </div>
  );
}

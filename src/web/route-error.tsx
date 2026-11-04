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
    <div className="space-y-2">
      <p className={className} role={role}>
        {message}
      </p>
      <Button variant="outline" size="sm" type="button" onClick={() => void router.invalidate()}>
        Retry
      </Button>
    </div>
  );
}

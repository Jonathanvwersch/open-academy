import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from './ui/button.js';
import { Card, CardContent } from './ui/card.js';

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
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await router.invalidate();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <Card data-layout-error>
      <CardContent className="flex flex-col items-start gap-4">
        <p className={`text-sm ${className ?? ''}`} role={role}>
          {message}
        </p>
        <Button variant="outline" size="sm" type="button" loading={retrying} onClick={retry}>
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

import { useRouter } from '@tanstack/react-router';

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
      <button
        type="button"
        onClick={() => void router.invalidate()}
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
      >
        Retry
      </button>
    </div>
  );
}

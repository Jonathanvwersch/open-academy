import { AcademyMascot } from '../../components/academy-mascot.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { XpGoalBar } from './xp-goal-bar.js';
export function SessionCompletion({
  xp,
  onFinish,
  finishing,
  error,
}: {
  xp: { session: number; today: number; goal: number };
  onFinish: () => void;
  finishing: boolean;
  error?: string;
}) {
  return (
    <section className="space-y-4">
      <AcademyMascot celebrating className="size-28" />
      <h1 className="text-3xl font-semibold">Session complete</h1>
      <p className="text-4xl font-bold">+{xp.session} XP</p>
      <p className="text-muted-foreground">
        Today: {xp.today} / {xp.goal} XP
      </p>
      <XpGoalBar today={xp.today} goal={xp.goal} previousToday={xp.today - xp.session} />
      {xp.today >= xp.goal ? <p className="font-medium">Daily goal reached</p> : null}
      <p className="text-muted-foreground">Your progress has been saved.</p>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="button" onClick={onFinish} loading={finishing}>
        Finish session
      </Button>
    </section>
  );
}

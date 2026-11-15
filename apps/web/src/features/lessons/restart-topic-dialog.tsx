import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog.js';

export function RestartTopicDialog({
  open,
  topicTitle,
  isPending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  topicTitle: string;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent aria-describedby="restart-topic-description">
        <div className="space-y-2">
          <DialogTitle>Restart {topicTitle}?</DialogTitle>
          <p id="restart-topic-description" className="text-sm text-muted-foreground">
            Your progress and reviews for this topic are cleared and it goes back to not started. XP
            you&apos;ve earned stays.
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button type="button" variant="destructive" loading={isPending} onClick={onConfirm}>
            Restart topic
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

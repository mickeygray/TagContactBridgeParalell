import * as React from "react";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import type { DeployAction, DeployTarget } from "@/lib/api/types";

const ACTION_LABEL: Record<DeployAction, string> = {
  full: "Deploy",
  content: "Content push",
  restart: "Restart",
};

interface ConfirmDeployDialogProps {
  target: DeployTarget | null;
  action: DeployAction | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (args: { confirm: string; note: string }) => Promise<void> | void;
  isPending?: boolean;
}

export function ConfirmDeployDialog({
  target,
  action,
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: ConfirmDeployDialogProps) {
  const [confirmText, setConfirmText] = React.useState("");
  const [note, setNote] = React.useState("");

  // Reset both fields when the target/action changes or the dialog closes.
  React.useEffect(() => {
    if (!open) {
      setConfirmText("");
      setNote("");
    }
  }, [open, target?.key, action]);

  if (!target || !action) return null;

  const matches = confirmText.trim() === target.key;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Confirm {ACTION_LABEL[action].toLowerCase()}
          </DialogTitle>
          <DialogDescription>
            You're about to dispatch{" "}
            <span className="font-mono text-xs">{action}</span> on{" "}
            <span className="font-semibold">{target.label}</span> ({target.key}).
            This will run <span className="font-mono text-xs">{target.workflow}</span>{" "}
            on <span className="font-mono text-xs">{target.ref}</span> in{" "}
            <span className="font-mono text-xs">{target.company ?? "—"}</span>.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!matches) return;
            await onConfirm({ confirm: confirmText.trim(), note: note.trim() });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="confirm-target">
              Type{" "}
              <span className="font-mono text-xs font-semibold text-foreground">
                {target.key}
              </span>{" "}
              to confirm
            </Label>
            <Input
              id="confirm-target"
              autoFocus
              autoComplete="off"
              placeholder={target.key}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirm-note">Note (optional)</Label>
            <Input
              id="confirm-note"
              placeholder="e.g. pushing compliance banner update"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Recorded on the workflow stage alongside your email.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={action === "full" ? "primary" : "destructive"}
              disabled={!matches || isPending}
              isLoading={isPending}
            >
              {ACTION_LABEL[action]} {target.label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

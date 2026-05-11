import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toaster";
import { useUpdateAccount } from "@/lib/api/queries/accounts";
import type { AccountRecord } from "@/lib/api/types";
import { UserForm } from "./UserForm";

interface EditUserDialogProps {
  account: AccountRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditUserDialog({ account, open, onOpenChange }: EditUserDialogProps) {
  const update = useUpdateAccount();

  if (!account) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[82vh] max-w-lg overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 pb-3 pt-5">
          <DialogTitle>Edit account</DialogTitle>
          <DialogDescription>
            {account.isSeed
              ? "Seed admin — role and audience stay locked to admin."
              : account.isHardened
                ? "Hardened user — role and audience stay locked to the internal-agent shell."
              : "Update fields below. Extension changes re-pair immediately."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[calc(82vh-92px)] overflow-y-auto px-5 pb-5 pt-4">
        <UserForm
          initial={account}
          lockEmail
          includeCurrentExtension={
            account.extensionId
              ? {
                  extensionId: account.extensionId,
                  name: account.name,
                }
              : null
          }
          onSubmit={async (payload) => {
            try {
              // Seed admins cannot change role/audience on the backend; do it
              // client-side too so the form doesn't flash bad values.
              const safePayload = account.isSeed
                ? { ...payload, role: "admin" as const, audience: "admin" as const }
                : account.isHardened
                  ? {
                      ...payload,
                      role: "internal-agent" as const,
                      audience: "user" as const,
                    }
                  : payload;
              const updated = await update.mutateAsync({
                id: account.id,
                patch: safePayload,
              });
              toast.success("Account updated", { description: updated.email });
              onOpenChange(false);
            } catch (err) {
              toast.error("Update failed", {
                description: (err as Error).message,
              });
            }
          }}
          footer={({ submit, isSubmitting, isDirty }) => (
            <DialogFooter className="sticky bottom-0 -mx-5 bg-card/95 px-5 pb-1 pt-3 backdrop-blur">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={submit}
                isLoading={isSubmitting}
                disabled={!isDirty}
              >
                Save changes
              </Button>
            </DialogFooter>
          )}
        />
        </div>
      </DialogContent>
    </Dialog>
  );
}

import * as React from "react";
import { Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toaster";
import { useCreateAccount } from "@/lib/api/queries/accounts";
import { useDomainStore } from "@/lib/domain/domainStore";
import { COMPANY_OPTIONS, UserForm } from "./UserForm";

export function CreateUserDialog() {
  const [open, setOpen] = React.useState(false);
  const defaultDomain = useDomainStore((s) => s.domain);
  const createAccount = useCreateAccount();

  const company = COMPANY_OPTIONS.includes(
    defaultDomain as (typeof COMPANY_OPTIONS)[number],
  )
    ? (defaultDomain as (typeof COMPANY_OPTIONS)[number])
    : "TAG";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" />
          Add user
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[82vh] max-w-xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 pb-3 pt-5">
          <DialogTitle>Add user or agent</DialogTitle>
          <DialogDescription>
            New accounts start invited; run the EX/CX lookup before creating
            to pair extension, RingCX username, and OAuth readiness metadata.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[calc(82vh-92px)] overflow-y-auto px-5 pb-5 pt-4">
        <UserForm
          defaultCompany={company}
          onSubmit={async (payload) => {
            try {
              const account = await createAccount.mutateAsync({
                ...payload,
                status: "invited",
              });
              toast.success("Account created", {
                description: `${account.email} can now request a login code.`,
              });
              setOpen(false);
            } catch (err) {
              toast.error("Could not create account", {
                description: (err as Error).message,
              });
            }
          }}
          footer={({ submit, isSubmitting }) => (
            <DialogFooter className="sticky bottom-0 -mx-5 bg-card/95 px-5 pb-1 pt-3 backdrop-blur">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="button" onClick={submit} isLoading={isSubmitting}>
                Create & invite
              </Button>
            </DialogFooter>
          )}
        />
        </div>
      </DialogContent>
    </Dialog>
  );
}

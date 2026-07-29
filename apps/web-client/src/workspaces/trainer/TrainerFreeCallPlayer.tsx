import { PhoneCall } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface TrainerFreeCallPlayerProps {
  onOpenLegacyPractice: () => void;
}

export function TrainerFreeCallPlayer({
  onOpenLegacyPractice,
}: TrainerFreeCallPlayerProps) {
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-5">
      <PhoneCall className="h-6 w-6 text-primary" />
      <h2 className="mt-3 font-semibold">Free Call</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Practice the full conversation naturally. Free Call does not use
        Targeted Talk nodes, phase locks, or artificial advancement gates.
      </p>
      <Button className="mt-4" onClick={onOpenLegacyPractice}>
        Open Free Call cockpit
      </Button>
    </div>
  );
}

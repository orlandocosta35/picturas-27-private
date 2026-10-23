"use client";

import { Film, Images, Layers, Scissors, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export type VideoOperation = "trim" | "resize" | "audio" | "concat" | "frames";

const OPERATIONS: Array<{
  value: VideoOperation;
  label: string;
  icon: typeof Film;
}> = [
  { value: "trim", label: "Trim", icon: Scissors },
  { value: "resize", label: "Resize", icon: Film },
  { value: "audio", label: "Manage audio", icon: Volume2 },
  { value: "concat", label: "Join", icon: Layers },
  { value: "frames", label: "Extract frames", icon: Images },
];

// One navigation for every video operation, shown above whichever screen is open.
export function VideoOperationTabs({
  value,
  onChange,
}: {
  value: VideoOperation;
  onChange: (operation: VideoOperation) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Video operation"
      className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-2 sm:grid-cols-5"
    >
      {OPERATIONS.map(({ value: operation, label, icon: Icon }) => (
        <Button
          key={operation}
          role="tab"
          aria-selected={value === operation}
          variant={value === operation ? "default" : "outline"}
          className="h-auto justify-start gap-2 py-3"
          onClick={() => onChange(operation)}
        >
          <Icon className="size-4" />
          {label}
        </Button>
      ))}
    </div>
  );
}

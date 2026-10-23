"use client";

import { useRef, type ComponentProps } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type NumberInputProps<T extends number | "" = number> = Omit<
  ComponentProps<typeof Input>,
  "type" | "value" | "onChange" | "min" | "max" | "step"
> & {
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  allowEmpty?: boolean;
  min?: number;
  max?: number;
  step?: number | "any";
};

export function NumberInput<T extends number | "" = number>({
  label, value, onValueChange, min, max, step = 1,
  disabled, readOnly, className, allowEmpty = false, ...props
}: NumberInputProps<T>) {
  const input = useRef<HTMLInputElement>(null);

  function change(direction: "up" | "down") {
    if (!input.current) return;
    if (step === "any") {
      const next = Number(value || 0) + (direction === "up" ? 1 : -1);
      onValueChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next)) as T);
      return;
    }
    if (direction === "up") input.current.stepUp();
    else input.current.stepDown();
    if (Number.isFinite(input.current.valueAsNumber)) {
      onValueChange(input.current.valueAsNumber as T);
    }
  }

  return (
    <div className={cn("flex h-9 items-center rounded-md border border-input bg-transparent shadow-sm focus-within:ring-1 focus-within:ring-ring", className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-full w-9 shrink-0 rounded-r-none border-r border-input"
        aria-label={`Decrease ${label}`}
        aria-controls={props.id}
        disabled={disabled || readOnly || (min !== undefined && Number(value) <= min)}
        onClick={() => change("down")}
      >
        <Minus aria-hidden="true" />
      </Button>
      <Input
        {...props}
        ref={input}
        type="number"
        aria-label={props["aria-label"] ?? label}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(event) => onValueChange((allowEmpty && event.target.value === "" ? "" : Number(event.target.value)) as T)}
        className="h-full min-w-0 rounded-none border-0 text-center tabular-nums shadow-none focus-visible:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-full w-9 shrink-0 rounded-l-none border-l border-input"
        aria-label={`Increase ${label}`}
        aria-controls={props.id}
        disabled={disabled || readOnly || (max !== undefined && Number(value) >= max)}
        onClick={() => change("up")}
      >
        <Plus aria-hidden="true" />
      </Button>
    </div>
  );
}

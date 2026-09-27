"use client";

import { type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import ui from "./WorkflowNative.module.css";

export function WorkflowHelp({ label, children }: { label: string; children: ReactNode }) {
  return <Popover.Root><Popover.Trigger asChild><button type="button" className={ui.helpButton} aria-label={label} title={label}>?</button></Popover.Trigger><Popover.Portal><Popover.Content className={ui.helpPopover} sideOffset={8} collisionPadding={16} aria-label={label}><h4>{label}</h4>{children}<Popover.Arrow className={ui.popoverArrow} /></Popover.Content></Popover.Portal></Popover.Root>;
}

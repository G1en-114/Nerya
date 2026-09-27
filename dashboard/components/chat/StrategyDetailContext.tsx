"use client";
import { createContext } from "react";
import type { StrategyDetailTarget } from "../../lib/strategyDetail";

/** Shared by ordinary chat, external calls, child agents and result cards. */
export const StrategyDetailContext = createContext<{
  open: (target: StrategyDetailTarget) => void;
  active: string;
} | null>(null);

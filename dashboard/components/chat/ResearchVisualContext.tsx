"use client";
import { createContext } from "react";
import type { ChartBlockShape } from "../../lib/chartBlock";
import type { ResearchInstrument } from "../../lib/researchVisuals";

/** UI navigation only; the Agent execution protocol is unchanged. */
export const ResearchVisualContext = createContext<((block: ChartBlockShape) => void) | null>(null);
export const ResearchInstrumentContext = createContext<((instrument: ResearchInstrument, charts: ChartBlockShape[]) => void) | null>(null);

"use client";

import { createContext, useContext } from "react";

export const LandingContext = createContext({ language: "zh" as "zh" | "en", dark: false, paused: false });
export const useLanding = () => useContext(LandingContext);

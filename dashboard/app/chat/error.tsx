"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";

export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("chatError");
  useEffect(() => {
    console.error("[chat-error]", error);
  }, [error]);

  const reload = () => {
    try {
      window.location.reload();
    } catch {
      reset();
    }
  };

  return (
    <div className="h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-lg rounded-lg border border-danger/30 bg-danger/[0.06] p-5">
        <div className="text-[12px] font-medium text-rose-300">
          {t("label")}
        </div>
        <h2 className="mt-2 text-[17px] font-medium text-ink-100">
          {t("title")}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-300">
          {error.message || t("unexpected")}
        </p>
        {error.digest ? (
          <div className="mt-3 font-mono text-[11px] text-ink-500">
            {error.digest}
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-md border border-accent-400/50 bg-accent-400/10 px-3 py-1.5 text-sm text-accent-300 hover:bg-accent-400/20"
          >
            {t("retry")}
          </button>
          <button
            type="button"
            onClick={reload}
            className="rounded-md border border-ink-500/40 bg-white/[0.04] px-3 py-1.5 text-sm text-ink-200 hover:bg-white/[0.08]"
          >
            {t("reload")}
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  useEffect(() => {
    console.error("[chat-error]", error);
    // localStorage 里如果残留缺字段的 ChatThread，全局错误依然会出现。
    // 暴露一个手动清理入口，避免用户卡在死路。
    try {
      const marker = "nerya.chat.threads:workspace:";
      const drop = Object.keys(localStorage).filter((key) => key.includes(marker));
      if (drop.length) console.info("[chat-error] localStorage 线程键：", drop);
    } catch {
      /* noop */
    }
  }, [error]);

  const reload = () => {
    try {
      window.location.reload();
    } catch {
      reset();
    }
  };

  const nukeThreads = () => {
    try {
      const prefix = "nerya.chat.threads:workspace:";
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(prefix)) localStorage.removeItem(key);
      }
    } catch {
      /* noop */
    }
    reload();
  };

  return (
    <div className="h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-lg rounded-lg border border-danger/30 bg-danger/[0.06] p-5">
        <div className="text-[12px] font-medium text-rose-300">
          Chat error
        </div>
        <h2 className="mt-2 text-[17px] font-medium text-ink-100">
          Chat view could not render.
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-300">
          {error.message || "Unexpected chat error."}
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
            Retry
          </button>
          <button
            type="button"
            onClick={reload}
            className="rounded-md border border-ink-500/40 bg-white/[0.04] px-3 py-1.5 text-sm text-ink-200 hover:bg-white/[0.08]"
          >
            Reload page
          </button>
          <button
            type="button"
            onClick={() => router.push("/chat")}
            className="rounded-md border border-ink-500/40 bg-white/[0.04] px-3 py-1.5 text-sm text-ink-200 hover:bg-white/[0.08]"
          >
            新建对话
          </button>
          <button
            type="button"
            onClick={nukeThreads}
            className="rounded-md border border-danger/50 bg-danger/[0.08] px-3 py-1.5 text-sm text-rose-300 hover:bg-danger/[0.16]"
            title="清理本地损坏的会话缓存，然后刷新页面"
          >
            清理损坏的会话缓存
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { NOD_BURST, nodError, nodIntent, type NodIntentProof } from "../../lib/nodIntent";

/**
 * Optional confirmation-intent capture for one approval card.
 *
 * The camera only runs while this component is mounted and the user opened it
 * on purpose. A nod mints a one-use receipt bound to the exact approval
 * content; it proves no identity and never submits the approval by itself.
 */
export function NodIntentCapture({
  approvalId,
  busy,
  onIntent,
  onReset,
  confirmed,
}: {
  approvalId: string;
  busy: boolean;
  onIntent: (proof: NodIntentProof) => void;
  onReset: () => void;
  confirmed: boolean;
}) {
  const zh = useLocale().startsWith("zh");
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<"idle" | "opening" | "nod" | "checking">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (stream.current) {
        stream.current.getTracks().forEach((track) => track.stop());
        void nodIntent.session("close");
      }
    };
  }, []);

  function stop() {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    // Camera closed: release the warm model worker server-side.
    void nodIntent.session("close");
    setReady(false);
    setPhase("idle");
    setProgress(0);
  }

  async function start() {
    if (running.current) return;
    running.current = true;
    setPhase("opening");
    setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("camera_unavailable");
      const incoming = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      if (!mounted.current) {
        incoming.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = incoming;
      if (video.current) {
        video.current.srcObject = incoming;
        await video.current.play();
      }
      // Camera is live: ask the backend to warm the nod model for this
      // session. It is released when the camera closes (or on idle timeout).
      void nodIntent.session("open");
      setReady(true);
      setPhase("nod");
    } catch (e) {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      if (mounted.current) {
        setPhase("idle");
        setError(nodError(e, zh));
      }
    } finally {
      running.current = false;
    }
  }

  async function collect() {
    const element = video.current;
    if (!element?.videoWidth || !ready || phase !== "nod") return;
    setPhase("checking");
    const frames: string[] = [];
    for (let i = 0; i < NOD_BURST.frames; i++) {
      if (!mounted.current) return;
      const canvas = document.createElement("canvas");
      canvas.width = NOD_BURST.width;
      canvas.height = Math.round((element.videoHeight * NOD_BURST.width) / element.videoWidth);
      const context = canvas.getContext("2d");
      if (!context) break;
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.7));
      setProgress(i + 1);
      await new Promise((resolve) => setTimeout(resolve, NOD_BURST.intervalMs));
    }
    if (!mounted.current) return;
    try {
      const proof = await nodIntent.capture(approvalId, frames);
      if (!mounted.current) return;
      onIntent(proof);
      stop();
    } catch (e) {
      if (mounted.current) {
        const payload = e && typeof e === "object" && "payload" in (e as object)
          ? (e as { payload?: { detail?: { amplitude?: number } } }).payload
          : undefined;
        setError(nodError(e, zh, payload?.detail));
        setPhase("nod");
        setProgress(0);
      }
    }
  }

  const label = {
    idle: zh ? "打开摄像头点头确认" : "Open camera to nod",
    opening: zh ? "正在打开…" : "Opening…",
    nod: zh ? "请正对摄像头，自然点头" : "Face the camera and nod naturally",
    checking: zh ? "正在识别…" : "Detecting…",
  }[phase];

  return (
    <div className="space-y-2 rounded-md border border-white/10 bg-black/15 p-2">
      {confirmed ? (
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className="text-xs font-medium text-fluid-300">
            {zh ? "已识别确认意向 ✓" : "Confirmation intent recognized ✓"}
          </span>
          <span className="text-[11px] text-ink-400">
            {zh
              ? "仅表示交互意向，不证明身份，也不会自动提交审批。"
              : "Interaction intent only. It proves no identity and never submits the approval."}
          </span>
          <button type="button" className="btn btn-ghost !px-2 !py-0.5 text-xs" disabled={busy} onClick={onReset}>
            {zh ? "重新确认" : "Redo"}
          </button>
        </div>
      ) : (
        <>
          <div className="relative mx-auto aspect-[4/3] w-full max-h-48 overflow-hidden rounded-md bg-black">
            <video
              ref={video}
              autoPlay
              playsInline
              muted
              aria-label={zh ? "点头确认摄像头预览" : "Nod confirmation camera preview"}
              className="h-full w-full object-contain [transform:scaleX(-1)]"
            />
            {!ready && (
              <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-ink-300">
                {zh ? "点头只表达确认意向，最终仍需点击批准提交。" : "A nod expresses intent; you still submit by clicking approve."}
              </div>
            )}
            {phase === "checking" && (
              <div className="absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1 text-center text-[11px] text-ink-100">
                {zh ? `正在采样 ${progress}/${NOD_BURST.frames}` : `Capturing ${progress}/${NOD_BURST.frames}`}
              </div>
            )}
          </div>
          {phase === "nod" && ready && (
            <p className="text-[11px] text-ink-300">{label}</p>
          )}
          {error && (
            <p role="alert" className="text-xs leading-5 text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!ready ? (
              <button type="button" className="btn btn-ghost !px-2 !py-0.5 text-xs" disabled={busy} onClick={() => void start()}>
                {label}
              </button>
            ) : (
              <button type="button" className="btn btn-primary !px-2 !py-0.5 text-xs" disabled={busy || phase !== "nod"} onClick={() => void collect()}>
                {phase === "checking" ? label : zh ? "开始点头确认" : "Start nod"}
              </button>
            )}
            {ready && (
              <button type="button" className="btn btn-ghost !px-2 !py-0.5 text-xs" onClick={stop}>
                {zh ? "关闭摄像头" : "Close camera"}
              </button>
            )}
          </div>
          <p className="text-[11px] leading-4 text-ink-400">
            {zh
              ? "演示能力：点头识别可能失败；摄像头不可用时直接点击批准按钮，审批不受影响。"
              : "Demo capability: nod detection can fail. If the camera is unavailable, use the approve button; the approval is unaffected."}
          </p>
        </>
      )}
    </div>
  );
}

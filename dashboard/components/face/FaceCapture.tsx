"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { faceError } from "../../lib/faceAuthorization";

export function FaceCapture({ onCapture, busy, label }: { onCapture: (image: string) => Promise<void>; busy: boolean; label: string }) {
  const zh = useLocale().startsWith("zh");
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const opening = useRef(false);
  const capturing = useRef(false);
  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stream.current?.getTracks().forEach(track => track.stop()); };
  }, []);

  async function start() {
    if (opening.current) return;
    opening.current = true;
    setStarting(true); setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("camera_unavailable");
      const incoming = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (!mounted.current) { incoming.getTracks().forEach(track => track.stop()); return; }
      stream.current?.getTracks().forEach(track => track.stop());
      stream.current = incoming;
      if (video.current) { video.current.srcObject = incoming; await video.current.play(); }
    } catch (e) {
      stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
      if (mounted.current) setError(faceError(e, zh));
    } finally { opening.current = false; if (mounted.current) setStarting(false); }
  }

  async function capture() {
    const element = video.current;
    if (!element?.videoWidth || !ready || busy || capturing.current) return;
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(640, element.videoWidth);
    canvas.height = Math.round(element.videoHeight * canvas.width / element.videoWidth);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    setError("");
    capturing.current = true;
    try { await onCapture(canvas.toDataURL("image/jpeg", 0.85)); }
    catch (e) { if (mounted.current) setError(faceError(e, zh)); }
    finally { capturing.current = false; }
  }

  return <div className="space-y-3">
    <div className="relative overflow-hidden rounded-lg bg-black aspect-[4/3] max-h-64 mx-auto w-full">
      <video ref={video} autoPlay playsInline muted aria-label={zh ? "人脸验证摄像头预览" : "Face verification camera preview"}
        onLoadedData={() => setReady(true)} className="h-full w-full object-contain [transform:scaleX(-1)]" />
      {!ready && <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-ink-300">
        {zh ? "打开摄像头，将脸置于画面中央" : "Open the camera and center your face"}
      </div>}
    </div>
    <p className="text-xs leading-5 text-ink-300">{zh ? "保持正面、光线充足，画面中只出现一张脸。仅在点击拍摄时发送一帧，不录制视频。" : "Face the camera in good lighting with only one face visible. One frame is sent when you capture; no video is recorded."}</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {!ready && <button type="button" className="btn btn-ghost" disabled={starting || busy} onClick={() => void start()}>
        {starting ? (zh ? "正在打开…" : "Opening…") : (zh ? "打开摄像头" : "Open camera")}
      </button>}
      <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={() => void capture()}>
        {busy ? (zh ? "正在检测，请稍候…" : "Checking, please wait…") : label}
      </button>
    </div>
  </div>;
}

const invoke = window.__TAURI__.core.invoke;
document.getElementById("quit").onclick = () => invoke("desktop_quit");
async function tick() {
  try {
    const state = await invoke("desktop_status");
    if (state.phase === "failed") {
      document.getElementById("status").textContent = "Nerya could not start. / Nerya 启动失败。";
      document.getElementById("error").textContent = `${state.error || "runtime_unavailable"} — Check desktop-runtime.log in the application data folder, then reopen Nerya. / 请检查应用数据目录中的 desktop-runtime.log 后重新打开。`;
      document.querySelector("progress").hidden = true;
      document.getElementById("quit").hidden = false;
      return;
    }
  } catch (error) {
    document.getElementById("error").textContent = String(error);
    document.getElementById("quit").hidden = false;
  }
  setTimeout(tick, 500);
}
tick();

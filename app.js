(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  const els = {
    landingView: $("#landingView"),
    hostSetupView: $("#hostSetupView"),
    joinView: $("#joinView"),
    hostLiveView: $("#hostLiveView"),
    viewerView: $("#viewerView"),
    siteFooter: $("#siteFooter"),

    openHostSetupBtn: $("#openHostSetupBtn"),
    openJoinBtn: $("#openJoinBtn"),
    startShareBtn: $("#startShareBtn"),
    joinForm: $("#joinForm"),
    roomInput: $("#roomInput"),

    qualitySelect: $("#qualitySelect"),
    fpsSelect: $("#fpsSelect"),
    bitrateSelect: $("#bitrateSelect"),
    deliveryModeInputs: $$("input[name='deliveryMode']"),
    systemAudioToggle: $("#systemAudioToggle"),
    micToggle: $("#micToggle"),

    hostVideo: $("#hostVideo"),
    roomCodeButton: $("#roomCodeButton"),
    shareLinkInput: $("#shareLinkInput"),
    copyLinkBtn: $("#copyLinkBtn"),
    copyLinkIconBtn: $("#copyLinkIconBtn"),
    stopShareBtn: $("#stopShareBtn"),
    streamStats: $("#streamStats"),
    viewerCountBadge: $("#viewerCountBadge"),
    audienceEmpty: $("#audienceEmpty"),
    audienceList: $("#audienceList"),
    peerStatus: $("#peerStatus"),
    deliveryModeStatus: $("#deliveryModeStatus"),
    bitrateStatus: $("#bitrateStatus"),
    encoderStatus: $("#encoderStatus"),
    systemAudioStatus: $("#systemAudioStatus"),
    micStatus: $("#micStatus"),

    viewerVideo: $("#viewerVideo"),
    viewerWaiting: $("#viewerWaiting"),
    viewerError: $("#viewerError"),
    viewerErrorText: $("#viewerErrorText"),
    viewerLiveState: $("#viewerLiveState"),
    viewerTitle: $("#viewerTitle"),
    viewerStatusText: $("#viewerStatusText"),
    viewerSoundBtn: $("#viewerSoundBtn"),
    fullscreenBtn: $("#fullscreenBtn"),
    viewerStage: $("#viewerStage"),
    installAppBtn: $("#installAppBtn"),
    toast: $("#toast")
  };

  let role = null;
  let roomId = null;
  let peer = null;
  let displayStream = null;
  let micStream = null;
  let outgoingStream = null;
  const viewerConnections = new Map();
  const viewerCalls = new Map();
  const bufferedRecorders = new Map();
  let viewerBufferedState = null;
  let toastTimer = null;
  let deferredInstallPrompt = null;
  let isInstalled = false;
  let encoderStatsTimer = null;
  let lastEncoderStats = null;
  const PWA_INSTALL_STORAGE_KEY = "espelha-pwa-installed";

  const PEER_PREFIX = "espelha-room-";
  const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const SELECT_META = {
    qualitySelect: {
      triggerCaption: "Resolução desejada",
      optionCaptions: {
        "1080": "Full HD, mais nitidez",
        "720": "Mais leve para rede e CPU",
        auto: "Deixa o navegador ajustar"
      }
    },
    fpsSelect: {
      triggerCaption: "Taxa de quadros",
      optionCaptions: {
        "120": "Máxima fluidez quando suportado",
        "60": "Fluido para jogos e movimento",
        "30": "Mais leve e estável"
      }
    },
    bitrateSelect: {
      triggerCaption: "Limite de vídeo",
      optionCaptions: {
        auto: "WebRTC decide dinamicamente",
        "4": "Leve para conexões mais lentas",
        "8": "Bom equilíbrio para 1080p",
        "12": "Alta qualidade para 1080p60",
        "20": "Alta qualidade / 120 FPS",
        "35": "Muito alto, exige bastante upload",
        "50": "Máximo, recomendado só em rede forte"
      }
    }
  };

  function showView(viewId) {
    ["landingView", "hostSetupView", "joinView", "hostLiveView", "viewerView"].forEach((id) => {
      els[id].classList.toggle("hidden", id !== viewId);
    });
    els.siteFooter?.classList.toggle("hidden", viewId === "hostLiveView" || viewId === "viewerView");
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function toast(message, type = "ok") {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.className = `toast show${type === "error" ? " error" : ""}`;
    toastTimer = setTimeout(() => {
      els.toast.className = "toast";
    }, 2300);
  }

  function randomRoomId(length = 6) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return [...bytes].map((n) => ROOM_ALPHABET[n % ROOM_ALPHABET.length]).join("");
  }

  function normalizeRoom(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
  }

  function roomPeerId(id) {
    return `${PEER_PREFIX}${id.toLowerCase()}`;
  }

  function currentBaseUrl() {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  function shareUrl(id) {
    const url = new URL(currentBaseUrl());
    url.searchParams.set("room", id);
    return url.toString();
  }

  async function copyText(text, successMessage = "Copiado") {
    try {
      await navigator.clipboard.writeText(text);
      toast(successMessage);
    } catch {
      const tmp = document.createElement("textarea");
      tmp.value = text;
      tmp.style.position = "fixed";
      tmp.style.opacity = "0";
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand("copy");
      tmp.remove();
      toast(successMessage);
    }
  }

  function closeCustomSelect(root) {
    if (!root) return;
    root.classList.remove("open");
    const trigger = root.querySelector("[data-select-trigger]");
    const menu = root.querySelector("[data-select-menu]");
    trigger?.setAttribute("aria-expanded", "false");
    menu?.classList.add("hidden");
  }

  function closeAllCustomSelects(exceptRoot = null) {
    $$("[data-custom-select]").forEach((root) => {
      if (root !== exceptRoot) closeCustomSelect(root);
    });
  }

  function initCustomSelects() {
    $$("[data-custom-select]").forEach((root, index) => {
      const select = root.querySelector("select");
      const trigger = root.querySelector("[data-select-trigger]");
      const menu = root.querySelector("[data-select-menu]");
      const valueEl = root.querySelector("[data-select-value]");
      const captionEl = root.querySelector("[data-select-caption]");
      if (!select || !trigger || !menu || !valueEl || !captionEl) return;

      const selectId = select.id || `custom-select-${index + 1}`;
      if (!select.id) select.id = selectId;
      const menuId = `${selectId}-menu`;
      menu.id = menuId;
      trigger.setAttribute("aria-controls", menuId);

      const meta = SELECT_META[selectId] || { triggerCaption: "Selecionar", optionCaptions: {} };

      const sync = () => {
        const options = [...select.options];
        const selectedOption = options.find((option) => option.selected) || options[select.selectedIndex] || options[0];
        if (!selectedOption) return;

        valueEl.textContent = selectedOption.textContent;
        captionEl.textContent = meta.optionCaptions[selectedOption.value] || meta.triggerCaption || "Selecionar";

        menu.innerHTML = options.map((option) => {
          const selected = option.value === select.value;
          return `
            <button
              type="button"
              class="select-option${selected ? " is-selected" : ""}"
              data-select-option
              data-value="${escapeHtml(option.value)}"
              role="option"
              aria-selected="${selected ? "true" : "false"}"
            >
              <span class="select-option-copy">
                <strong>${escapeHtml(option.textContent)}</strong>
                <small>${escapeHtml(meta.optionCaptions[option.value] || "")}</small>
              </span>
              <span class="select-option-mark" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none">
                  <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
            </button>
          `;
        }).join("");
      };

      const openMenu = () => {
        closeAllCustomSelects(root);
        root.classList.add("open");
        menu.classList.remove("hidden");
        trigger.setAttribute("aria-expanded", "true");
      };

      const toggleMenu = () => {
        if (root.classList.contains("open")) {
          closeCustomSelect(root);
        } else {
          openMenu();
        }
      };

      trigger.addEventListener("click", (event) => {
        event.preventDefault();
        toggleMenu();
      });

      trigger.addEventListener("keydown", (event) => {
        if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          openMenu();
          menu.querySelector(`.select-option[data-value="${CSS.escape(select.value)}"]`)?.focus();
        }
      });

      menu.addEventListener("click", (event) => {
        const optionButton = event.target.closest("[data-select-option]");
        if (!optionButton) return;
        select.value = optionButton.dataset.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
        closeCustomSelect(root);
        trigger.focus();
      });

      menu.addEventListener("keydown", (event) => {
        const current = event.target.closest("[data-select-option]");
        if (!current) return;
        const options = [...menu.querySelectorAll("[data-select-option]")];
        const index = options.indexOf(current);

        if (event.key === "Escape") {
          event.preventDefault();
          closeCustomSelect(root);
          trigger.focus();
          return;
        }

        if (event.key === "ArrowDown") {
          event.preventDefault();
          options[(index + 1) % options.length]?.focus();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          options[(index - 1 + options.length) % options.length]?.focus();
        } else if (event.key === "Home") {
          event.preventDefault();
          options[0]?.focus();
        } else if (event.key === "End") {
          event.preventDefault();
          options[options.length - 1]?.focus();
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          current.click();
        }
      });

      select.addEventListener("change", sync);
      sync();
    });

    document.addEventListener("click", (event) => {
      const root = event.target.closest("[data-custom-select]");
      if (!root) closeAllCustomSelects();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAllCustomSelects();
    });
  }

  function isStandaloneMode() {
    return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
  }

  function isIosDevice() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent || "");
  }

  function updateInstallButton() {
    const button = els.installAppBtn;
    if (!button) return;

    if (isInstalled || isStandaloneMode()) {
      button.disabled = true;
      button.classList.add("is-installed");
      button.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 12.5 4 4 8-9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Já instalado
      `;
      return;
    }

    button.disabled = false;
    button.classList.remove("is-installed");
    button.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 17.5v.7A1.8 1.8 0 0 0 6.8 20h10.4A1.8 1.8 0 0 0 19 18.2v-.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      Instalar
    `;
  }

  async function installApp() {
    if (isInstalled || isStandaloneMode()) {
      toast("O app já está instalado.");
      return;
    }

    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const outcome = await deferredInstallPrompt.userChoice.catch(() => null);
      if (outcome?.outcome === "accepted") {
        toast("Instalação iniciada.");
      }
      deferredInstallPrompt = null;
      updateInstallButton();
      return;
    }

    if (isIosDevice()) {
      toast("No iPhone/iPad: Compartilhar → Adicionar à Tela de Início.");
      return;
    }

    toast("Abra o menu do navegador e use a opção “Instalar app”.");
  }

  async function detectInstalledPwa() {
    if (isStandaloneMode()) return true;

    try {
      if (typeof navigator.getInstalledRelatedApps === "function") {
        const relatedApps = await navigator.getInstalledRelatedApps();
        if (relatedApps.some((app) => app.platform === "webapp")) {
          return true;
        }
      }
    } catch (error) {
      console.warn("Installed PWA detection failed:", error);
    }

    try {
      return localStorage.getItem(PWA_INSTALL_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  async function registerPwa() {
    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("./sw.js");
      } catch (error) {
        console.warn("SW register failed:", error);
      }
    }

    isInstalled = await detectInstalledPwa();
    updateInstallButton();

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;

      // Se o navegador voltou a oferecer instalação, tratamos como não instalado.
      isInstalled = false;
      try { localStorage.removeItem(PWA_INSTALL_STORAGE_KEY); } catch {}
      updateInstallButton();
    });

    window.addEventListener("appinstalled", () => {
      isInstalled = true;
      deferredInstallPrompt = null;
      try { localStorage.setItem(PWA_INSTALL_STORAGE_KEY, "1"); } catch {}
      updateInstallButton();
      toast("App instalado com sucesso.");
    });
  }

  function selectedBitrateBps() {
    const value = els.bitrateSelect?.value;
    if (!value || value === "auto") return null;
    const mbps = Number(value);
    return Number.isFinite(mbps) && mbps > 0 ? Math.round(mbps * 1_000_000) : null;
  }

  function selectedDeliveryMode() {
    return els.deliveryModeInputs?.find((input) => input.checked)?.value === "quality" ? "quality" : "latency";
  }

  function deliveryModeLabel(mode = selectedDeliveryMode()) {
    return mode === "quality" ? "Alta qualidade" : "Baixa latência";
  }

  // O modo de alta qualidade trabalha deliberadamente atrás do tempo real.
  // Mantemos um alvo maior que o pré-carregamento inicial para dar margem a oscilações.
  const HIGH_QUALITY_BUFFER_MS = 7000;
  const HIGH_QUALITY_PREROLL_MS = 5500;

  async function configureReceiverBuffer(call, mode) {
    const highQuality = mode === "quality";
    const targetMs = highQuality ? HIGH_QUALITY_BUFFER_MS : 0;
    const targetSeconds = targetMs / 1000;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const receivers = call?.peerConnection?.getReceivers?.().filter((receiver) => receiver.track && ["video", "audio"].includes(receiver.track.kind)) || [];
      if (receivers.length) {
        for (const receiver of receivers) {
          try {
            if ("jitterBufferTarget" in receiver) {
              receiver.jitterBufferTarget = targetMs;
            }
            if ("playoutDelayHint" in receiver) {
              receiver.playoutDelayHint = targetSeconds;
            }
          } catch (error) {
            console.warn("Não foi possível ajustar o buffer do receptor:", error);
          }
        }
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async function waitForQualityPreroll() {
    const startedAt = performance.now();
    let lastSecond = null;

    while (true) {
      const elapsed = performance.now() - startedAt;
      const remaining = Math.max(0, HIGH_QUALITY_PREROLL_MS - elapsed);
      const seconds = Math.ceil(remaining / 1000);

      if (seconds !== lastSecond) {
        lastSecond = seconds;
        if (els.viewerStatusText) {
          els.viewerStatusText.textContent = seconds > 0
            ? `Alta qualidade · carregando ${seconds}s antes de reproduzir`
            : "Alta qualidade · buffer pronto";
        }
      }

      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
  }

  function preferH264Sdp(sdp) {
    if (!sdp || typeof sdp !== "string") return sdp;

    const lines = sdp.split(/\r?\n/);
    const h264Pts = [];
    const rtxByPrimary = new Map();

    for (const line of lines) {
      let match = line.match(/^a=rtpmap:(\d+)\s+H264\/90000/i);
      if (match) h264Pts.push(match[1]);

      match = line.match(/^a=fmtp:(\d+)\s+.*\bapt=(\d+)\b/i);
      if (match) {
        const [, rtxPt, primaryPt] = match;
        if (!rtxByPrimary.has(primaryPt)) rtxByPrimary.set(primaryPt, []);
        rtxByPrimary.get(primaryPt).push(rtxPt);
      }
    }

    if (!h264Pts.length) return sdp;

    const preferred = [];
    for (const pt of h264Pts) {
      if (!preferred.includes(pt)) preferred.push(pt);
      for (const rtxPt of rtxByPrimary.get(pt) || []) {
        if (!preferred.includes(rtxPt)) preferred.push(rtxPt);
      }
    }

    const videoIndex = lines.findIndex((line) => line.startsWith("m=video "));
    if (videoIndex === -1) return sdp;

    const parts = lines[videoIndex].trim().split(/\s+/);
    if (parts.length < 4) return sdp;

    const currentPayloads = parts.slice(3);
    const orderedPayloads = [
      ...preferred.filter((pt) => currentPayloads.includes(pt)),
      ...currentPayloads.filter((pt) => !preferred.includes(pt))
    ];

    lines[videoIndex] = [...parts.slice(0, 3), ...orderedPayloads].join(" ");
    return lines.join("\r\n");
  }

  async function findVideoSender(call, maxAttempts = 30) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const pc = call?.peerConnection;
      const sender = pc?.getSenders?.().find((item) => item.track?.kind === "video");
      if (sender) return sender;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  async function configureVideoSender(call) {
    try {
      const sender = await findVideoSender(call);
      if (!sender) return;

      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];

      const bitrate = selectedBitrateBps();
      const fps = Number(els.fpsSelect?.value) || 60;

      if (bitrate) {
        params.encodings[0].maxBitrate = bitrate;
      } else {
        delete params.encodings[0].maxBitrate;
      }

      params.encodings[0].maxFramerate = fps;
      const deliveryMode = selectedDeliveryMode();
      if ("degradationPreference" in params || typeof params.degradationPreference === "string") {
        params.degradationPreference = deliveryMode === "quality" ? "maintain-resolution" : "maintain-framerate";
      }

      await sender.setParameters(params);
      startEncoderStats(call, sender);
    } catch (error) {
      console.warn("Não foi possível aplicar parâmetros avançados do encoder:", error);
    }
  }

  async function readEncoderStats(call, sender) {
    try {
      const report = await sender.getStats();
      let outbound = null;
      let codec = null;

      report.forEach((stat) => {
        if (stat.type === "outbound-rtp" && stat.kind === "video" && !stat.isRemote) outbound = stat;
      });

      if (outbound?.codecId) codec = report.get(outbound.codecId);

      let measuredMbps = null;
      if (outbound?.bytesSent != null && outbound?.timestamp != null && lastEncoderStats) {
        const byteDelta = outbound.bytesSent - lastEncoderStats.bytesSent;
        const timeDelta = outbound.timestamp - lastEncoderStats.timestamp;
        if (byteDelta >= 0 && timeDelta > 0) measuredMbps = (byteDelta * 8) / (timeDelta * 1000);
      }

      if (outbound?.bytesSent != null && outbound?.timestamp != null) {
        lastEncoderStats = { bytesSent: outbound.bytesSent, timestamp: outbound.timestamp };
      }

      const implementation = outbound?.encoderImplementation || outbound?.encoder || "";
      const codecName = codec?.mimeType?.replace(/^video\//i, "") || "H.264 pref.";
      const implementationLower = String(implementation).toLowerCase();
      const isNvenc = implementationLower.includes("nvenc") || implementationLower.includes("nvidia");
      const hardware = outbound?.powerEfficientEncoder === true;

      if (els.encoderStatus) {
        if (isNvenc) {
          els.encoderStatus.textContent = `${codecName} · NVENC`;
        } else if (implementation) {
          els.encoderStatus.textContent = `${codecName} · ${implementation}`;
        } else if (hardware) {
          els.encoderStatus.textContent = `${codecName} · Hardware`;
        } else {
          els.encoderStatus.textContent = `${codecName} · Navegador`;
        }
      }

      const configured = els.bitrateSelect?.value;
      if (els.bitrateStatus) {
        if (measuredMbps != null && Number.isFinite(measuredMbps)) {
          const suffix = configured === "auto" ? "auto" : `máx. ${configured}`;
          els.bitrateStatus.textContent = `${measuredMbps.toFixed(1)} Mbps · ${suffix}`;
        } else {
          els.bitrateStatus.textContent = configured === "auto" ? "Automático" : `Máx. ${configured} Mbps`;
        }
      }
    } catch (error) {
      console.debug("Stats do encoder indisponíveis:", error);
    }
  }

  function startEncoderStats(call, sender) {
    if (encoderStatsTimer) clearInterval(encoderStatsTimer);
    lastEncoderStats = null;
    readEncoderStats(call, sender);
    encoderStatsTimer = setInterval(() => readEncoderStats(call, sender), 2000);
  }

  function stopEncoderStats() {
    if (encoderStatsTimer) clearInterval(encoderStatsTimer);
    encoderStatsTimer = null;
    lastEncoderStats = null;
  }

  function buildDisplayConstraints() {
    const quality = els.qualitySelect.value;
    const fps = Number(els.fpsSelect.value) || 60;
    const video = { frameRate: { ideal: fps, max: fps } };

    if (quality === "1080") {
      video.width = { ideal: 1920 };
      video.height = { ideal: 1080 };
    } else if (quality === "720") {
      video.width = { ideal: 1280 };
      video.height = { ideal: 720 };
    }

    return {
      video,
      audio: els.systemAudioToggle.checked
    };
  }

  async function captureForHost() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Seu navegador não oferece suporte ao compartilhamento de tela.");
    }

    displayStream = await navigator.mediaDevices.getDisplayMedia(buildDisplayConstraints());

    if (els.micToggle.checked) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (error) {
        micStream = null;
        toast("Tela iniciada, mas o microfone não foi liberado.", "error");
      }
    }

    outgoingStream = new MediaStream();
    displayStream.getVideoTracks().forEach((track) => outgoingStream.addTrack(track));
    displayStream.getAudioTracks().forEach((track) => outgoingStream.addTrack(track));
    micStream?.getAudioTracks().forEach((track) => outgoingStream.addTrack(track));

    const screenTrack = displayStream.getVideoTracks()[0];
    if (screenTrack) {
      const fps = Number(els.fpsSelect.value) || 60;
      const deliveryMode = selectedDeliveryMode();
      try { screenTrack.contentHint = deliveryMode === "quality" ? "detail" : "motion"; } catch {}
      try {
        await screenTrack.applyConstraints({ frameRate: { ideal: fps, max: fps } });
      } catch (error) {
        console.debug("O navegador limitou a taxa de quadros da captura:", error);
      }
    }
    screenTrack?.addEventListener("ended", () => stopHost(true), { once: true });

    els.hostVideo.srcObject = displayStream;
    await els.hostVideo.play().catch(() => {});

    updateStreamUi();
  }

  function updateStreamUi() {
    const track = displayStream?.getVideoTracks()[0];
    const settings = track?.getSettings?.() || {};
    const width = settings.width;
    const height = settings.height;
    const frameRate = settings.frameRate ? Math.round(settings.frameRate) : Number(els.fpsSelect.value);
    const res = height ? `${height}p` : (els.qualitySelect.value === "auto" ? "Auto" : `${els.qualitySelect.value}p`);
    const bitrateLabel = els.bitrateSelect?.value === "auto" ? "Auto" : `${els.bitrateSelect?.value || "—"} Mbps`;
    const deliveryMode = selectedDeliveryMode();
    els.streamStats.textContent = `${res} · ${frameRate || "—"} FPS · ${bitrateLabel}`;
    if (els.deliveryModeStatus) els.deliveryModeStatus.textContent = deliveryModeLabel(deliveryMode);
    if (els.bitrateStatus) els.bitrateStatus.textContent = els.bitrateSelect?.value === "auto" ? "Automático" : `Máx. ${els.bitrateSelect?.value} Mbps`;
    if (els.encoderStatus) els.encoderStatus.textContent = deliveryMode === "quality" ? "Bufferizado (MediaRecorder)" : "H.264 preferido";
    els.systemAudioStatus.textContent = displayStream?.getAudioTracks().length ? "Ativo" : "Sem áudio";
    els.micStatus.textContent = micStream?.getAudioTracks().length ? "Ativo" : "Desligado";
  }

  function chooseBufferedMimeType() {
    if (typeof MediaRecorder === "undefined" || typeof MediaSource === "undefined") return null;

    const hasAudio = Boolean(outgoingStream?.getAudioTracks?.().length);
    const candidates = hasAudio
      ? [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm"
        ]
      : [
          "video/webm;codecs=vp9",
          "video/webm;codecs=vp8",
          "video/webm"
        ];

    return candidates.find((type) => {
      try {
        return MediaRecorder.isTypeSupported(type) && MediaSource.isTypeSupported(type);
      } catch {
        return false;
      }
    }) || null;
  }

  function bufferedBitrateBps() {
    const selected = selectedBitrateBps();
    // MediaRecorder precisa de um valor concreto; 12 Mbps é o padrão quando o usuário deixa automático.
    return selected || 12_000_000;
  }

  function stopBufferedRecorder(peerId) {
    const state = bufferedRecorders.get(peerId);
    if (!state) return;
    try {
      if (state.recorder?.state !== "inactive") state.recorder.stop();
    } catch {}
    bufferedRecorders.delete(peerId);
  }

  function stopAllBufferedRecorders() {
    [...bufferedRecorders.keys()].forEach(stopBufferedRecorder);
  }

  function startBufferedStreamToViewer(viewerPeerId) {
    if (!outgoingStream || bufferedRecorders.has(viewerPeerId)) return false;
    const viewer = viewerConnections.get(viewerPeerId);
    const conn = viewer?.conn;
    if (!conn?.open) return false;

    const mimeType = chooseBufferedMimeType();
    if (!mimeType) return false;

    let recorder;
    try {
      const recorderOptions = {
        mimeType,
        videoBitsPerSecond: bufferedBitrateBps()
      };
      if (outgoingStream.getAudioTracks().length) recorderOptions.audioBitsPerSecond = 160_000;
      recorder = new MediaRecorder(outgoingStream, recorderOptions);
    } catch (error) {
      console.warn("MediaRecorder bufferizado indisponível:", error);
      return false;
    }

    const state = {
      recorder,
      sequence: 0,
      startedAt: Date.now(),
      mimeType
    };
    bufferedRecorders.set(viewerPeerId, state);

    try {
      conn.send({
        type: "buffered-start",
        roomId,
        mimeType,
        targetBufferSeconds: 6,
        minimumStartBufferSeconds: 5
      });
    } catch (error) {
      console.warn("Falha ao iniciar modo bufferizado:", error);
      bufferedRecorders.delete(viewerPeerId);
      return false;
    }

    recorder.addEventListener("dataavailable", async (event) => {
      if (!event.data?.size || !conn.open || bufferedRecorders.get(viewerPeerId) !== state) return;
      try {
        const data = await event.data.arrayBuffer();
        if (!conn.open || bufferedRecorders.get(viewerPeerId) !== state) return;
        conn.send({
          type: "buffered-media",
          sequence: state.sequence++,
          data
        });
      } catch (error) {
        console.warn("Falha ao enviar chunk bufferizado:", error);
      }
    });

    recorder.addEventListener("error", (event) => {
      console.warn("Erro no MediaRecorder bufferizado:", event.error || event);
      try { conn.send({ type: "buffered-error" }); } catch {}
      stopBufferedRecorder(viewerPeerId);
    });

    recorder.addEventListener("stop", () => {
      try {
        if (conn.open) conn.send({ type: "buffered-end" });
      } catch {}
    });

    // Chunks curtos diminuem o tempo para o SourceBuffer começar a montar os 5+ segundos à frente.
    recorder.start(500);
    return true;
  }

  function cleanupBufferedViewerState() {
    const state = viewerBufferedState;
    viewerBufferedState = null;
    if (!state) return;

    if (state.monitorTimer) clearInterval(state.monitorTimer);
    if (state.cleanupTimer) clearInterval(state.cleanupTimer);
    state.queue.length = 0;
    try {
      if (state.mediaSource?.readyState === "open") state.mediaSource.endOfStream();
    } catch {}
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  }

  function bufferedSecondsAhead(video = els.viewerVideo) {
    try {
      if (!video?.buffered?.length) return 0;
      let end = 0;
      for (let index = 0; index < video.buffered.length; index += 1) {
        const start = video.buffered.start(index);
        const rangeEnd = video.buffered.end(index);
        if (video.currentTime >= start - 0.05 && video.currentTime <= rangeEnd + 0.05) {
          end = rangeEnd;
          break;
        }
        if (rangeEnd > end) end = rangeEnd;
      }
      return Math.max(0, end - video.currentTime);
    } catch {
      return 0;
    }
  }

  function maybeStartBufferedPlayback() {
    const state = viewerBufferedState;
    if (!state || state.startedPlayback || !state.sourceBuffer) return;
    const ahead = bufferedSecondsAhead();
    const target = state.minimumStartBufferSeconds;
    if (els.viewerStatusText) {
      els.viewerStatusText.textContent = `Alta qualidade · buffer ${ahead.toFixed(1)} / ${target.toFixed(0)} s`;
    }
    if (ahead + 0.05 < target) return;

    state.startedPlayback = true;
    state.rebuffering = false;
    els.viewerWaiting.classList.add("hidden");
    els.viewerStatusText.textContent = `Alta qualidade · ${ahead.toFixed(1)} s carregados à frente`;
    els.viewerVideo.play().catch(async () => {
      els.viewerVideo.muted = true;
      els.viewerSoundBtn.textContent = "Ativar som";
      toast("Clique em “Ativar som” para ouvir a transmissão.");
      await els.viewerVideo.play().catch(() => {});
    });
  }

  function monitorBufferedPlayback() {
    const state = viewerBufferedState;
    if (!state?.startedPlayback) {
      maybeStartBufferedPlayback();
      return;
    }

    const ahead = bufferedSecondsAhead();
    if (!state.rebuffering && ahead < 1.5 && !els.viewerVideo.paused) {
      state.rebuffering = true;
      els.viewerVideo.pause();
      els.viewerWaiting.classList.remove("hidden");
      els.viewerStatusText.textContent = `Alta qualidade · recarregando buffer (${ahead.toFixed(1)} s)`;
      return;
    }

    if (state.rebuffering) {
      if (els.viewerStatusText) {
        els.viewerStatusText.textContent = `Alta qualidade · recarregando ${ahead.toFixed(1)} / ${state.targetBufferSeconds.toFixed(0)} s`;
      }
      if (ahead >= state.targetBufferSeconds) {
        state.rebuffering = false;
        els.viewerWaiting.classList.add("hidden");
        els.viewerStatusText.textContent = `Alta qualidade · ${ahead.toFixed(1)} s carregados à frente`;
        els.viewerVideo.play().catch(() => {});
      }
    } else if (els.viewerStatusText) {
      els.viewerStatusText.textContent = `Alta qualidade · ${ahead.toFixed(1)} s carregados à frente`;
    }
  }

  function processBufferedQueue() {
    const state = viewerBufferedState;
    if (!state?.sourceBuffer || state.sourceBuffer.updating || !state.queue.length) return;
    const next = state.queue.shift();
    try {
      state.sourceBuffer.appendBuffer(next);
    } catch (error) {
      console.warn("Falha ao anexar chunk ao buffer:", error);
      // Se o buffer estiver momentaneamente cheio, devolve o chunk à fila.
      state.queue.unshift(next);
      setTimeout(processBufferedQueue, 100);
    }
  }

  function initBufferedViewer(data) {
    cleanupBufferedViewerState();
    els.viewerVideo.pause();
    els.viewerVideo.srcObject = null;
    els.viewerVideo.removeAttribute("src");
    els.viewerVideo.load();

    const mimeType = data?.mimeType;
    if (!mimeType || typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(mimeType)) {
      return false;
    }

    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    const state = {
      mediaSource,
      objectUrl,
      sourceBuffer: null,
      queue: [],
      startedPlayback: false,
      rebuffering: false,
      targetBufferSeconds: Math.max(5, Number(data.targetBufferSeconds) || 6),
      minimumStartBufferSeconds: Math.max(5, Number(data.minimumStartBufferSeconds) || 5),
      monitorTimer: null,
      cleanupTimer: null
    };
    viewerBufferedState = state;
    els.viewerVideo.src = objectUrl;
    els.viewerWaiting.classList.remove("hidden");
    els.viewerStatusText.textContent = "Alta qualidade · carregando pelo menos 5 s antes de reproduzir";
    els.viewerLiveState.className = "live-state";
    els.viewerLiveState.innerHTML = "<i></i> BUFFERIZANDO";

    mediaSource.addEventListener("sourceopen", () => {
      if (viewerBufferedState !== state) return;
      try {
        const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        state.sourceBuffer = sourceBuffer;
        try { sourceBuffer.mode = "sequence"; } catch {}
        sourceBuffer.addEventListener("updateend", () => {
          if (viewerBufferedState !== state) return;
          processBufferedQueue();
          maybeStartBufferedPlayback();
        });
        processBufferedQueue();

        state.monitorTimer = setInterval(monitorBufferedPlayback, 250);
        state.cleanupTimer = setInterval(() => {
          if (viewerBufferedState !== state || !state.sourceBuffer || state.sourceBuffer.updating) return;
          try {
            const cutoff = els.viewerVideo.currentTime - 20;
            if (cutoff > 0 && state.sourceBuffer.buffered.length && state.sourceBuffer.buffered.start(0) < cutoff) {
              state.sourceBuffer.remove(0, cutoff);
            }
          } catch {}
        }, 5000);
      } catch (error) {
        console.error("Não foi possível criar SourceBuffer:", error);
        cleanupBufferedViewerState();
      }
    }, { once: true });

    return true;
  }

  function appendBufferedViewerChunk(data) {
    const state = viewerBufferedState;
    if (!state || !(data instanceof ArrayBuffer)) return;
    state.queue.push(new Uint8Array(data));
    processBufferedQueue();
  }

  function createPeer(id) {
    if (typeof Peer === "undefined") {
      throw new Error("A biblioteca de conexão não carregou. Verifique sua internet.");
    }
    return new Peer(id, {
      debug: 1,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" }
        ],
        sdpSemantics: "unified-plan"
      }
    });
  }

  async function startHost() {
    els.startShareBtn.disabled = true;
    els.startShareBtn.textContent = "Abrindo seletor...";

    try {
      await captureForHost();
      role = "host";
      roomId = randomRoomId();
      showView("hostLiveView");
      fillHostRoomUi();
      connectHostPeer();
    } catch (error) {
      if (error?.name !== "NotAllowedError") {
        toast(error.message || "Não foi possível iniciar a transmissão.", "error");
      } else {
        toast("Você cancelou o compartilhamento da tela.", "error");
      }
    } finally {
      els.startShareBtn.disabled = false;
      els.startShareBtn.textContent = "Escolher tela e iniciar";
    }
  }

  function fillHostRoomUi() {
    const url = shareUrl(roomId);
    els.roomCodeButton.textContent = roomId;
    els.shareLinkInput.value = url;
    els.peerStatus.textContent = "Conectando...";
  }

  function connectHostPeer() {
    const hostId = roomPeerId(roomId);
    peer = createPeer(hostId);

    peer.on("open", () => {
      els.peerStatus.textContent = "Online";
      history.replaceState(null, "", `?host=${roomId}`);
    });

    peer.on("connection", (conn) => {
      conn.on("open", () => {
        const viewerName = conn.metadata?.name || `Visitante ${String(conn.peer).slice(-4).toUpperCase()}`;
        viewerConnections.set(conn.peer, { conn, viewerName, joinedAt: Date.now() });
        renderAudience();
        conn.send({ type: "host-ready", roomId, deliveryMode: selectedDeliveryMode() });
        if (selectedDeliveryMode() === "quality") {
          const bufferedStarted = startBufferedStreamToViewer(conn.peer);
          if (!bufferedStarted) {
            // Fallback: se MediaRecorder/MSE não forem compatíveis, mantém o WebRTC tradicional.
            sendStreamToViewer(conn.peer);
          }
        } else {
          sendStreamToViewer(conn.peer);
        }
      });

      conn.on("close", () => removeViewer(conn.peer));
      conn.on("error", () => removeViewer(conn.peer));
    });

    peer.on("error", (error) => {
      console.error("Peer host error:", error);
      if (error.type === "unavailable-id") {
        // Extremely rare room collision; rebuild with another code.
        roomId = randomRoomId();
        fillHostRoomUi();
        peer.destroy();
        connectHostPeer();
        return;
      }
      els.peerStatus.textContent = "Erro";
      toast("Falha na sinalização WebRTC.", "error");
    });

    peer.on("disconnected", () => {
      els.peerStatus.textContent = "Reconectando...";
      if (!peer.destroyed) peer.reconnect();
    });
  }

  function sendStreamToViewer(viewerPeerId) {
    if (!peer || !outgoingStream || viewerCalls.has(viewerPeerId)) return;

    const call = peer.call(viewerPeerId, outgoingStream, {
      metadata: { roomId, kind: "screen", deliveryMode: selectedDeliveryMode() },
      sdpTransform: preferH264Sdp
    });

    if (!call) return;
    viewerCalls.set(viewerPeerId, call);
    configureVideoSender(call);

    call.on("close", () => {
      viewerCalls.delete(viewerPeerId);
    });

    call.on("error", () => {
      viewerCalls.delete(viewerPeerId);
    });
  }

  function removeViewer(peerId) {
    viewerConnections.delete(peerId);
    stopBufferedRecorder(peerId);
    const call = viewerCalls.get(peerId);
    if (call) {
      try { call.close(); } catch {}
      viewerCalls.delete(peerId);
    }
    renderAudience();
  }

  function renderAudience() {
    const viewers = [...viewerConnections.entries()];
    els.viewerCountBadge.textContent = String(viewers.length);
    els.audienceEmpty.classList.toggle("hidden", viewers.length > 0);
    els.audienceList.classList.toggle("hidden", viewers.length === 0);
    els.audienceList.innerHTML = viewers.map(([id, info], index) => {
      const label = info.viewerName;
      const initial = label.trim().charAt(0).toUpperCase() || String(index + 1);
      return `<div class="audience-item" data-peer="${escapeHtml(id)}">
        <span class="audience-avatar">${escapeHtml(initial)}</span>
        <div><strong>${escapeHtml(label)}</strong><small>Conexão P2P ativa</small></div>
        <span class="audience-online" title="online"></span>
      </div>`;
    }).join("");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    }[char]));
  }

  function cleanupStreams() {
    stopEncoderStats();
    stopAllBufferedRecorders();
    displayStream?.getTracks().forEach((track) => track.stop());
    micStream?.getTracks().forEach((track) => track.stop());
    displayStream = null;
    micStream = null;
    outgoingStream = null;
    els.hostVideo.srcObject = null;
  }

  function stopHost(fromBrowserStop = false) {
    if (role !== "host") return;

    viewerConnections.forEach(({ conn }) => {
      try { conn.send({ type: "host-ended" }); } catch {}
      try { conn.close(); } catch {}
    });
    viewerCalls.forEach((call) => { try { call.close(); } catch {} });
    viewerConnections.clear();
    viewerCalls.clear();

    if (peer) {
      try { peer.destroy(); } catch {}
      peer = null;
    }

    cleanupStreams();
    role = null;
    roomId = null;
    history.replaceState(null, "", currentBaseUrl());
    showView("landingView");
    if (!fromBrowserStop) toast("Transmissão encerrada.");
  }

  function startViewer(id) {
    roomId = normalizeRoom(id);
    if (!roomId) {
      toast("Digite um código de sala válido.", "error");
      return;
    }

    role = "viewer";
    showView("viewerView");
    els.viewerTitle.textContent = `Sala ${roomId}`;
    els.viewerStatusText.textContent = "Procurando transmissão...";
    cleanupBufferedViewerState();
    els.viewerWaiting.classList.remove("hidden");
    els.viewerError.classList.add("hidden");
    els.viewerVideo.pause();
    els.viewerVideo.srcObject = null;
    els.viewerVideo.removeAttribute("src");
    els.viewerLiveState.className = "live-state waiting";
    els.viewerLiveState.innerHTML = "<i></i> CONECTANDO";
    history.replaceState(null, "", `?room=${roomId}`);

    const viewerPeer = createPeer();
    peer = viewerPeer;

    let gotStream = false;
    let connectionOpened = false;
    let failTimer = null;

    const fail = (message) => {
      if (gotStream) return;
      clearTimeout(failTimer);
      els.viewerWaiting.classList.add("hidden");
      els.viewerError.classList.remove("hidden");
      els.viewerErrorText.textContent = message;
      els.viewerStatusText.textContent = "Não conectado";
      els.viewerLiveState.innerHTML = "<i></i> OFFLINE";
    };

    viewerPeer.on("open", () => {
      const name = `Visitante ${String(viewerPeer.id).slice(-4).toUpperCase()}`;
      const conn = viewerPeer.connect(roomPeerId(roomId), {
        reliable: true,
        metadata: { role: "viewer", name }
      });

      conn.on("open", () => {
        connectionOpened = true;
        els.viewerStatusText.textContent = "Sala encontrada. Recebendo vídeo...";
        conn.send({ type: "viewer-ready" });
        failTimer = setTimeout(() => fail("A sala foi encontrada, mas o vídeo não chegou. Tente recarregar a página."), 12000);
      });

      conn.on("data", (data) => {
        if (data?.type === "buffered-start") {
          const initialized = initBufferedViewer(data);
          if (!initialized) {
            fail("Seu navegador não conseguiu iniciar o modo de alta qualidade bufferizado.");
            return;
          }
          gotStream = true;
          clearTimeout(failTimer);
          return;
        }

        if (data?.type === "buffered-media") {
          appendBufferedViewerChunk(data.data);
          return;
        }

        if (data?.type === "buffered-end") {
          const state = viewerBufferedState;
          try {
            if (state?.mediaSource?.readyState === "open" && !state.sourceBuffer?.updating) state.mediaSource.endOfStream();
          } catch {}
          els.viewerStatusText.textContent = "Transmissão encerrada";
          els.viewerLiveState.innerHTML = "<i></i> ENCERRADA";
          return;
        }

        if (data?.type === "buffered-error") {
          fail("A transmissão bufferizada foi interrompida no computador de origem.");
          return;
        }

        if (data?.type === "host-ended") {
          cleanupBufferedViewerState();
          fail("A transmissão foi encerrada por quem estava compartilhando.");
          els.viewerVideo.srcObject = null;
        }
      });

      conn.on("close", () => {
        if (gotStream) {
          els.viewerStatusText.textContent = "Transmissão encerrada";
          els.viewerLiveState.innerHTML = "<i></i> ENCERRADA";
          if (viewerBufferedState) {
            els.viewerVideo.pause();
          }
        } else if (connectionOpened) {
          fail("A transmissão foi encerrada antes do vídeo começar.");
        }
      });

      conn.on("error", () => fail("Não foi possível conectar à sala."));
    });

    viewerPeer.on("call", (call) => {
      if (call.metadata?.roomId && normalizeRoom(call.metadata.roomId) !== roomId) {
        call.close();
        return;
      }

      const deliveryMode = call.metadata?.deliveryMode === "quality" ? "quality" : "latency";
      // Uma chamada WebRTC recebida em alta qualidade aqui é somente fallback para navegadores
      // sem suporte ao transporte bufferizado por MediaRecorder + MediaSource.
      cleanupBufferedViewerState();
      call.answer(undefined, { sdpTransform: preferH264Sdp });
      call.on("stream", async (stream) => {
        gotStream = true;
        clearTimeout(failTimer);

        // O vídeo do espectador não usa autoplay. No modo de alta qualidade,
        // o RTP continua chegando enquanto a reprodução fica pausada, permitindo
        // que o jitter buffer acumule mídia antes do primeiro frame ser exibido.
        els.viewerVideo.pause();
        els.viewerVideo.srcObject = stream;
        els.viewerError.classList.add("hidden");
        els.viewerLiveState.className = "live-state";
        els.viewerLiveState.innerHTML = "<i></i> AO VIVO";

        await configureReceiverBuffer(call, deliveryMode);

        if (deliveryMode === "quality") {
          await waitForQualityPreroll();
          els.viewerStatusText.textContent = "Alta qualidade · ~7 s atrás do tempo real";
        } else {
          els.viewerStatusText.textContent = "Baixa latência · buffer mínimo";
        }

        els.viewerWaiting.classList.add("hidden");
        try {
          await els.viewerVideo.play();
        } catch {
          els.viewerVideo.muted = true;
          els.viewerSoundBtn.textContent = "Ativar som";
          toast("Clique em “Ativar som” para ouvir a transmissão.");
          await els.viewerVideo.play().catch(() => {});
        }
      });

      call.on("close", () => {
        if (gotStream) {
          els.viewerStatusText.textContent = "Transmissão encerrada";
          els.viewerLiveState.innerHTML = "<i></i> ENCERRADA";
          els.viewerVideo.srcObject = null;
          fail("A transmissão foi encerrada.");
        }
      });
    });

    viewerPeer.on("error", (error) => {
      console.error("Peer viewer error:", error);
      if (error.type === "peer-unavailable") {
        fail("Essa sala não existe ou a transmissão já foi encerrada.");
      } else if (error.type === "network" || error.type === "server-error" || error.type === "socket-error") {
        fail("Falha ao acessar o serviço de sinalização. Verifique sua conexão e tente novamente.");
      } else {
        fail("Não foi possível estabelecer a conexão WebRTC.");
      }
    });

    failTimer = setTimeout(() => {
      if (!connectionOpened && !gotStream) {
        fail("A sala demorou demais para responder. Confira o código e tente novamente.");
      }
    }, 10000);
  }

  function leaveViewer() {
    if (role !== "viewer") return;
    cleanupBufferedViewerState();
    if (peer) {
      try { peer.destroy(); } catch {}
      peer = null;
    }
    els.viewerVideo.srcObject = null;
    role = null;
  }

  initCustomSelects();
  registerPwa();

  // Navigation
  els.openHostSetupBtn.addEventListener("click", () => showView("hostSetupView"));
  els.installAppBtn?.addEventListener("click", installApp);
  els.openJoinBtn.addEventListener("click", () => showView("joinView"));
  $$('[data-back]').forEach((button) => button.addEventListener("click", () => showView(button.dataset.back)));
  els.startShareBtn.addEventListener("click", startHost);

  els.joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = normalizeRoom(els.roomInput.value);
    els.roomInput.value = id;
    startViewer(id);
  });

  els.roomInput.addEventListener("input", () => {
    const pos = els.roomInput.selectionStart;
    els.roomInput.value = normalizeRoom(els.roomInput.value);
    try { els.roomInput.setSelectionRange(pos, pos); } catch {}
  });

  els.copyLinkBtn.addEventListener("click", () => copyText(shareUrl(roomId), "Link copiado"));
  els.copyLinkIconBtn.addEventListener("click", () => copyText(shareUrl(roomId), "Link copiado"));
  els.roomCodeButton.addEventListener("click", () => copyText(roomId, "Código copiado"));
  els.stopShareBtn.addEventListener("click", () => stopHost(false));

  els.viewerSoundBtn.addEventListener("click", async () => {
    els.viewerVideo.muted = !els.viewerVideo.muted;
    if (!els.viewerVideo.muted) {
      await els.viewerVideo.play().catch(() => {});
    }
    els.viewerSoundBtn.textContent = els.viewerVideo.muted ? "Ativar som" : "Som: ligado";
  });

  els.fullscreenBtn.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) {
        await els.viewerStage.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      toast("Seu navegador bloqueou a tela cheia.", "error");
    }
  });

  document.addEventListener("fullscreenchange", () => {
    els.fullscreenBtn.textContent = document.fullscreenElement ? "Sair da tela cheia" : "Tela cheia";
  });

  window.addEventListener("beforeunload", () => {
    if (role === "host") {
      viewerConnections.forEach(({ conn }) => {
        try { conn.send({ type: "host-ended" }); } catch {}
      });
      cleanupStreams();
    } else if (role === "viewer") {
      leaveViewer();
    }
  });

  // Deep link: ?room=ABC123 opens directly as viewer.
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = normalizeRoom(params.get("room"));
  if (roomFromUrl) {
    startViewer(roomFromUrl);
  } else {
    showView("landingView");
  }
})();

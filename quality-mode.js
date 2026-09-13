(() => {
  "use strict";

  const TARGET_DELAY_MS = 10_000;
  const RESUME_BUFFER_MS = 5_000;
  const MIN_BUFFER_MS = 900;
  const DECODE_AHEAD_MS = 300;
  const KEYFRAME_INTERVAL_MS = 2_000;
  const DATA_HIGH_WATER = 2 * 1024 * 1024;
  const DATA_LOW_WATER = 384 * 1024;
  const MAX_ENCODED_BYTES = 96 * 1024 * 1024;
  const MAX_DECODED_FRAMES = 8;
  const DATA_FRAGMENT_BYTES = 48 * 1024;
  const MAX_FRAGMENT_ASSEMBLIES = 8;
  const HQ_STARTUP_TIMEOUT_MS = 22_000;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function hostSupported() {
    return typeof VideoEncoder !== "undefined" &&
      typeof VideoFrame !== "undefined" &&
      typeof MediaStreamTrackProcessor !== "undefined";
  }

  function viewerSupported() {
    return typeof VideoDecoder !== "undefined" &&
      typeof EncodedVideoChunk !== "undefined";
  }

  function safeSend(conn, payload) {
    try {
      if (!conn?.open) return false;
      conn.send(payload);
      return true;
    } catch (error) {
      console.warn("Espelha HQ: falha ao enviar pacote", error);
      return false;
    }
  }

  function dataChannelOf(conn) {
    return conn?.dataChannel || conn?._dc || null;
  }

  function decoderConfigFromEncoder(config) {
    return {
      codec: config.codec,
      codedWidth: config.width,
      codedHeight: config.height,
      optimizeForLatency: true
    };
  }

  async function chooseEncoderConfig(track, bitrate, fps) {
    const settings = track.getSettings?.() || {};
    const width = Math.max(2, Number(settings.width) || 1920);
    const height = Math.max(2, Number(settings.height) || 1080);
    const targetBitrate = Math.max(500_000, Number(bitrate) || 12_000_000);

    // O modo HQ usa um caminho conservador. 120 FPS continua disponível no
    // WebRTC de baixa latência, mas aqui limitamos a 60 para evitar derrubar
    // o processo de vídeo/GPU do Chromium em alguns drivers do Windows.
    const targetFps = Math.max(1, Math.min(60, Number(fps) || 60));

    // Evitamos H.264 + prefer-hardware neste modo. Há combinações de
    // Chromium/Windows/driver que podem derrubar o renderer/GPU process em vez
    // de retornar uma exceção JavaScript. Software VP8 é o primeiro caminho.
    const candidates = [
      {
        codec: "vp8",
        width,
        height,
        bitrate: targetBitrate,
        framerate: targetFps,
        latencyMode: "realtime",
        hardwareAcceleration: "prefer-software"
      },
      {
        codec: "vp09.00.10.08",
        width,
        height,
        bitrate: targetBitrate,
        framerate: targetFps,
        latencyMode: "realtime",
        hardwareAcceleration: "prefer-software"
      },
      {
        codec: "avc1.42E02A",
        width,
        height,
        bitrate: targetBitrate,
        framerate: targetFps,
        latencyMode: "realtime",
        hardwareAcceleration: "prefer-software",
        avc: { format: "annexb" }
      }
    ];

    for (const candidate of candidates) {
      try {
        const result = await VideoEncoder.isConfigSupported(candidate);
        if (result?.supported) return result.config || candidate;
      } catch (error) {
        console.debug("Espelha HQ: encoder não suportado", candidate.codec, error);
      }
    }

    return null;
  }

  class QualityHost {
    constructor(options) {
      this.getStream = options.getStream;
      this.getBitrateBps = options.getBitrateBps;
      this.getFps = options.getFps;
      this.onStatus = options.onStatus || (() => {});
      this.onStats = options.onStats || (() => {});

      this.encoder = null;
      this.reader = null;
      this.encoderConfig = null;
      this.decoderConfig = null;
      this.viewers = new Map();
      this.running = false;
      this.pumpPromise = null;
      this.epochMs = 0;
      this.lastPtsUs = -1;
      this.lastOutputTimelineUs = -1;
      this.lastKeyframeAt = 0;
      this.forceKeyframe = false;
      this.sequence = 0;
      this.framesEncoded = 0;
      this.framesDroppedByEncoder = 0;
      this.bytesEncoded = 0;
      this.statsStartedAt = 0;
      this.lastStatsAt = 0;
      this.lastStatsBytes = 0;
      this.lastStatsFrames = 0;
    }

    async ensureStarted() {
      if (this.running && this.encoder) return true;
      if (!hostSupported()) return false;

      const stream = this.getStream?.();
      const track = stream?.getVideoTracks?.()[0];
      if (!track) return false;

      const config = await chooseEncoderConfig(
        track,
        this.getBitrateBps?.() || 12_000_000,
        this.getFps?.() || 60
      );
      if (!config) return false;

      this.encoderConfig = config;
      this.decoderConfig = decoderConfigFromEncoder(config);
      this.epochMs = performance.now();
      this.lastPtsUs = -1;
      this.lastOutputTimelineUs = -1;
      this.lastKeyframeAt = 0;
      this.sequence = 0;
      this.statsStartedAt = performance.now();
      this.lastStatsAt = this.statsStartedAt;
      this.lastStatsBytes = 0;
      this.lastStatsFrames = 0;

      this.encoder = new VideoEncoder({
        output: (chunk, metadata) => this.handleEncodedChunk(chunk, metadata),
        error: (error) => {
          console.error("Espelha HQ: VideoEncoder", error);
          this.onStatus(`Erro no encoder: ${error?.message || "desconhecido"}`);
        }
      });

      try {
        this.encoder.configure(config);
      } catch (error) {
        console.error("Espelha HQ: configure falhou", error);
        try { this.encoder.close(); } catch {}
        this.encoder = null;
        return false;
      }

      let processor;
      try {
        processor = new MediaStreamTrackProcessor({ track });
        this.reader = processor.readable.getReader();
      } catch (error) {
        console.error("Espelha HQ: MediaStreamTrackProcessor", error);
        try { this.encoder.close(); } catch {}
        this.encoder = null;
        return false;
      }

      this.running = true;
      const codecLabel = config.codec.startsWith("avc1") ? "H.264" : config.codec.startsWith("vp09") ? "VP9" : "VP8";
      this.onStatus(`${codecLabel} · WebCodecs · 1 encoder`);
      this.pumpPromise = this.pumpFrames();
      return true;
    }

    async addViewer(peerId, conn) {
      if (!hostSupported()) return false;
      const started = await this.ensureStarted();
      if (!started) return false;

      const dc = dataChannelOf(conn);
      const state = {
        conn,
        dc,
        congested: false,
        waitingForKeyframe: true,
        droppedFrames: 0,
        sentFrames: 0,
        lastBufferedAmount: 0,
        lowHandler: null
      };

      if (dc) {
        try {
          dc.bufferedAmountLowThreshold = DATA_LOW_WATER;
          state.lowHandler = () => {
            state.congested = false;
            state.waitingForKeyframe = true;
            this.forceKeyframe = true;
          };
          dc.addEventListener("bufferedamountlow", state.lowHandler);
        } catch {}
      }

      this.viewers.set(peerId, state);
      safeSend(conn, {
        type: "hq-start",
        targetDelayMs: TARGET_DELAY_MS,
        resumeBufferMs: RESUME_BUFFER_MS,
        minBufferMs: MIN_BUFFER_MS
      });
      if (this.decoderConfig) safeSend(conn, { type: "hq-config", config: this.decoderConfig });
      this.forceKeyframe = true;
      return true;
    }

    removeViewer(peerId) {
      const state = this.viewers.get(peerId);
      if (state?.dc && state.lowHandler) {
        try { state.dc.removeEventListener("bufferedamountlow", state.lowHandler); } catch {}
      }
      this.viewers.delete(peerId);
      if (!this.viewers.size) this.stopEncoderOnly();
    }

    handleEncodedChunk(chunk, metadata) {
      if (!this.running) return;

      if (metadata?.decoderConfig) {
        const dc = metadata.decoderConfig;
        this.decoderConfig = {
          codec: dc.codec || this.encoderConfig?.codec,
          codedWidth: dc.codedWidth || this.encoderConfig?.width,
          codedHeight: dc.codedHeight || this.encoderConfig?.height,
          optimizeForLatency: true
        };
        for (const { conn } of this.viewers.values()) {
          safeSend(conn, { type: "hq-config", config: this.decoderConfig });
        }
      }

      const data = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(data);

      // Timeline lógico próprio do Espelha. Ele NÃO depende do timestamp que o
      // capturador/codec resolveu usar. Isso evita o pré-buffer ficar preso em
      // 0-2 s em capturas de tela que reduzem a cadência quando a imagem está
      // estática, e mantém o relógio de reprodução em 1x.
      const outputTimelineUs = Math.max(
        this.lastOutputTimelineUs + 1,
        Math.round((performance.now() - this.epochMs) * 1000)
      );
      this.lastOutputTimelineUs = outputTimelineUs;

      const packet = {
        frameType: chunk.type,
        timestamp: Number(chunk.timestamp),
        timelineUs: outputTimelineUs,
        duration: Number(chunk.duration || 0),
        sequence: this.sequence++,
        data
      };

      this.framesEncoded += 1;
      this.bytesEncoded += chunk.byteLength;

      for (const [peerId, state] of this.viewers.entries()) {
        this.sendChunkToViewer(peerId, state, packet);
      }

      this.emitStats();
    }

    sendChunkToViewer(peerId, state, packet) {
      const { conn, dc } = state;
      if (!conn?.open) return;

      const bufferedAmount = Number(dc?.bufferedAmount || 0);
      state.lastBufferedAmount = bufferedAmount;

      // Não colocamos um frame inteiro na fila se o DataChannel já está cheio.
      // Isso evita uma cauda confiável/ordenada crescer indefinidamente.
      if (bufferedAmount > DATA_HIGH_WATER) {
        state.congested = true;
        state.waitingForKeyframe = true;
        state.droppedFrames += 1;
        this.forceKeyframe = true;
        return;
      }

      if (state.congested) {
        state.droppedFrames += 1;
        return;
      }

      if (state.waitingForKeyframe && packet.frameType !== "key") {
        state.droppedFrames += 1;
        this.forceKeyframe = true;
        return;
      }

      if (packet.frameType === "key") state.waitingForKeyframe = false;

      // EncodedVideoChunk pode ser muito maior que o tamanho seguro de uma
      // mensagem SCTP. Mandamos blocos pequenos e remontamos no viewer.
      const bytes = new Uint8Array(packet.data);
      const fragmentCount = Math.max(1, Math.ceil(bytes.byteLength / DATA_FRAGMENT_BYTES));

      for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
        const begin = fragmentIndex * DATA_FRAGMENT_BYTES;
        const finish = Math.min(bytes.byteLength, begin + DATA_FRAGMENT_BYTES);
        const fragment = bytes.slice(begin, finish).buffer;

        const ok = safeSend(conn, {
          type: "hq-video-fragment",
          frameType: packet.frameType,
          timestamp: packet.timestamp,
          timelineUs: packet.timelineUs,
          duration: packet.duration,
          sequence: packet.sequence,
          fragmentIndex,
          fragmentCount,
          data: fragment
        });

        if (!ok) {
          state.waitingForKeyframe = true;
          state.congested = true;
          this.forceKeyframe = true;
          return;
        }
      }

      state.sentFrames += 1;
    }

    async pumpFrames() {
      const fps = Math.max(1, Math.min(120, Number(this.getFps?.()) || 60));
      const minIntervalMs = 1000 / fps;
      let lastAcceptedAt = 0;

      while (this.running && this.reader && this.encoder && this.encoder.state !== "closed") {
        let result;
        try {
          result = await this.reader.read();
        } catch (error) {
          if (this.running) console.warn("Espelha HQ: leitura de frames terminou", error);
          break;
        }
        if (!result || result.done) break;
        const sourceFrame = result.value;
        if (!sourceFrame) continue;

        const now = performance.now();
        if (now - lastAcceptedAt < minIntervalMs * 0.82) {
          sourceFrame.close();
          continue;
        }
        lastAcceptedAt = now;

        if (this.encoder.encodeQueueSize > 3) {
          this.framesDroppedByEncoder += 1;
          sourceFrame.close();
          continue;
        }

        // O TrackProcessor já entrega VideoFrame com timestamp monotônico.
        // Codificamos o frame original diretamente para evitar uma cópia extra
        // de superfície GPU a cada quadro.
        const sourceTimestamp = Number(sourceFrame.timestamp);
        this.lastPtsUs = Number.isFinite(sourceTimestamp)
          ? Math.max(this.lastPtsUs + 1, sourceTimestamp)
          : Math.max(this.lastPtsUs + 1, Math.round((now - this.epochMs) * 1000));

        try {
          const periodicKey = now - this.lastKeyframeAt >= KEYFRAME_INTERVAL_MS;
          const viewerNeedsKey = [...this.viewers.values()].some((state) => state.waitingForKeyframe);
          const keyFrame = this.forceKeyframe || periodicKey || viewerNeedsKey;
          if (keyFrame) {
            this.lastKeyframeAt = now;
            this.forceKeyframe = false;
          }
          this.encoder.encode(sourceFrame, { keyFrame });
        } catch (error) {
          console.warn("Espelha HQ: encode de frame falhou", error);
        } finally {
          try { sourceFrame.close(); } catch {}
        }
      }
    }

    emitStats() {
      const now = performance.now();
      if (now - this.lastStatsAt < 1000) return;
      const dt = Math.max(1, now - this.lastStatsAt);
      const bytesDelta = this.bytesEncoded - this.lastStatsBytes;
      const framesDelta = this.framesEncoded - this.lastStatsFrames;
      let maxBuffered = 0;
      let droppedNetwork = 0;
      for (const state of this.viewers.values()) {
        maxBuffered = Math.max(maxBuffered, state.lastBufferedAmount || 0);
        droppedNetwork += state.droppedFrames || 0;
      }
      this.onStats({
        mbps: (bytesDelta * 8) / (dt * 1000),
        fps: (framesDelta * 1000) / dt,
        encodeQueueSize: this.encoder?.encodeQueueSize || 0,
        maxBufferedBytes: maxBuffered,
        droppedEncoder: this.framesDroppedByEncoder,
        droppedNetwork
      });
      this.lastStatsAt = now;
      this.lastStatsBytes = this.bytesEncoded;
      this.lastStatsFrames = this.framesEncoded;
    }

    stopEncoderOnly() {
      this.running = false;
      if (this.reader) {
        try { this.reader.cancel(); } catch {}
        this.reader = null;
      }
      if (this.encoder) {
        try { this.encoder.close(); } catch {}
        this.encoder = null;
      }
      this.encoderConfig = null;
      this.decoderConfig = null;
      this.forceKeyframe = false;
    }

    stop() {
      for (const [peerId] of this.viewers) this.removeViewer(peerId);
      this.viewers.clear();
      this.stopEncoderOnly();
    }
  }

  class QualityViewer {
    constructor(options) {
      this.canvas = options.canvas;
      this.ctx = this.canvas?.getContext?.("2d", { alpha: false }) || this.canvas?.getContext?.("2d");
      this.onStatus = options.onStatus || (() => {});
      this.onReady = options.onReady || (() => {});
      this.onUnsupported = options.onUnsupported || (() => {});
      this.onDelayChange = options.onDelayChange || (() => {});
      this.onStartupTimeout = options.onStartupTimeout || (() => {});

      this.decoder = null;
      this.decoderConfig = null;
      this.decoderReady = false;
      this.active = false;
      this.started = false;
      this.buffering = false;
      this.waitingForKeyframe = true;
      this.encodedQueue = [];
      this.decodedQueue = [];
      this.encodedBytes = 0;
      this.firstTimestampUs = null;
      this.latestReceivedUs = null;
      this.firstTimelineUs = null;
      this.latestTimelineUs = null;
      this.firstFrameReceivedAtMs = null;
      this.lastSequence = null;
      this.playheadUs = null;
      this.playheadTimelineUs = null;
      this.lastTickMs = null;
      this.raf = null;
      this.targetDelayUs = TARGET_DELAY_MS * 1000;
      this.resumeBufferUs = RESUME_BUFFER_MS * 1000;
      this.minBufferUs = MIN_BUFFER_MS * 1000;
      this.decodeAheadUs = DECODE_AHEAD_MS * 1000;
      this.extraDelayMs = 0;
      this.stallStartedAt = null;
      this.stalls = 0;
      this.lastStatusAt = 0;
      this.lastRenderedTimestampUs = null;
      this.decodedFramesDropped = 0;
      this.fragmentAssemblies = new Map();
      this.timelineByTimestamp = new Map();
      this.startupTimer = null;
    }

    supported() {
      return viewerSupported() && Boolean(this.ctx);
    }

    start(data = {}) {
      this.stop();
      if (!this.supported()) {
        this.onUnsupported();
        return false;
      }

      this.active = true;
      this.targetDelayUs = Math.max(5_000_000, Number(data.targetDelayMs || TARGET_DELAY_MS) * 1000);
      this.resumeBufferUs = Math.max(2_000_000, Number(data.resumeBufferMs || RESUME_BUFFER_MS) * 1000);
      this.minBufferUs = Math.max(300_000, Number(data.minBufferMs || MIN_BUFFER_MS) * 1000);
      this.onStatus(`Alta qualidade · preparando buffer de ${(this.targetDelayUs / 1_000_000).toFixed(0)} s`);
      this.startupTimer = setTimeout(() => {
        if (!this.active || this.started) return;
        this.onStatus("Alta qualidade demorou demais · alternando para WebRTC");
        this.onStartupTimeout();
      }, HQ_STARTUP_TIMEOUT_MS);
      this.renderLoop();
      return true;
    }

    async configure(config) {
      if (!this.active || !config?.codec) return false;
      try {
        const normalized = {
          codec: config.codec,
          codedWidth: config.codedWidth,
          codedHeight: config.codedHeight,
          optimizeForLatency: true
        };
        const support = await VideoDecoder.isConfigSupported(normalized);
        if (!support?.supported) throw new Error(`Codec ${config.codec} não suportado`);

        if (this.decoder) {
          try { this.decoder.close(); } catch {}
        }
        this.decoder = new VideoDecoder({
          output: (frame) => this.handleDecodedFrame(frame),
          error: (error) => {
            console.warn("Espelha HQ: VideoDecoder", error);
            this.waitingForKeyframe = true;
          }
        });
        this.decoder.configure(support.config || normalized);
        this.decoderConfig = support.config || normalized;
        this.decoderReady = true;
        this.feedDecoder();
        return true;
      } catch (error) {
        console.error("Espelha HQ: decoder não configurou", error);
        this.onUnsupported(error);
        return false;
      }
    }

    handleMessage(data) {
      if (!data?.type) return false;
      if (data.type === "hq-start") return this.start(data);
      if (!this.active) return false;
      if (data.type === "hq-config") {
        this.configure(data.config);
        return true;
      }
      if (data.type === "hq-video") {
        this.handleChunk(data);
        return true;
      }
      if (data.type === "hq-video-fragment") {
        this.handleFragment(data);
        return true;
      }
      if (data.type === "hq-end") {
        this.onStatus("Transmissão encerrada");
        return true;
      }
      return false;
    }

    handleFragment(packet) {
      const sequence = Number(packet.sequence);
      const fragmentIndex = Number(packet.fragmentIndex);
      const fragmentCount = Number(packet.fragmentCount);

      if (
        !Number.isFinite(sequence) ||
        !Number.isInteger(fragmentIndex) ||
        !Number.isInteger(fragmentCount) ||
        fragmentIndex < 0 ||
        fragmentCount < 1 ||
        fragmentIndex >= fragmentCount ||
        fragmentCount > 512 ||
        !(packet.data instanceof ArrayBuffer)
      ) {
        return;
      }

      let assembly = this.fragmentAssemblies.get(sequence);
      if (!assembly) {
        if (this.fragmentAssemblies.size >= MAX_FRAGMENT_ASSEMBLIES) {
          const oldestKey = this.fragmentAssemblies.keys().next().value;
          this.fragmentAssemblies.delete(oldestKey);
          this.waitingForKeyframe = true;
        }

        assembly = {
          frameType: packet.frameType,
          timestamp: Number(packet.timestamp),
          timelineUs: Number(packet.timelineUs),
          duration: Number(packet.duration || 0),
          fragmentCount,
          parts: new Array(fragmentCount),
          received: 0,
          totalBytes: 0
        };
        this.fragmentAssemblies.set(sequence, assembly);
      }

      if (
        assembly.fragmentCount !== fragmentCount ||
        assembly.parts[fragmentIndex]
      ) {
        return;
      }

      const part = new Uint8Array(packet.data);
      assembly.parts[fragmentIndex] = part;
      assembly.received += 1;
      assembly.totalBytes += part.byteLength;

      if (assembly.received !== assembly.fragmentCount) return;

      const merged = new Uint8Array(assembly.totalBytes);
      let offset = 0;
      for (const item of assembly.parts) {
        if (!item) {
          this.fragmentAssemblies.delete(sequence);
          this.waitingForKeyframe = true;
          return;
        }
        merged.set(item, offset);
        offset += item.byteLength;
      }

      this.fragmentAssemblies.delete(sequence);
      this.handleChunk({
        type: "hq-video",
        frameType: assembly.frameType,
        timestamp: assembly.timestamp,
        timelineUs: assembly.timelineUs,
        duration: assembly.duration,
        sequence,
        data: merged.buffer
      });
    }

    clearQueues() {
      this.fragmentAssemblies.clear();
      this.timelineByTimestamp.clear();
      this.encodedQueue = [];
      this.encodedBytes = 0;
      for (const item of this.decodedQueue) {
        try { item.frame.close(); } catch {}
      }
      this.decodedQueue = [];
    }

    handleChunk(packet) {
      const timestamp = Number(packet.timestamp);
      const sequence = Number(packet.sequence);
      const isKey = packet.frameType === "key";
      if (!Number.isFinite(timestamp) || !(packet.data instanceof ArrayBuffer)) return;

      // timelineUs é um relógio monotônico criado pelo host no momento em que o
      // frame codificado sai do encoder. Se estivermos falando com uma versão
      // antiga, usamos o timestamp do codec apenas como fallback.
      const suppliedTimeline = Number(packet.timelineUs);
      const timelineUs = Number.isFinite(suppliedTimeline) ? suppliedTimeline : timestamp;

      let discontinuity = false;
      if (this.lastSequence != null && Number.isFinite(sequence) && sequence !== this.lastSequence + 1) {
        this.waitingForKeyframe = true;
        discontinuity = true;
      }
      if (Number.isFinite(sequence)) this.lastSequence = sequence;

      if (this.waitingForKeyframe && !isKey) return;

      if (isKey && this.waitingForKeyframe) {
        if (!this.started) {
          this.clearQueues();
          this.firstTimestampUs = timestamp;
          this.latestReceivedUs = timestamp;
          this.firstTimelineUs = timelineUs;
          this.latestTimelineUs = timelineUs;
          this.firstFrameReceivedAtMs = performance.now();
        }
        this.waitingForKeyframe = false;
        discontinuity = true;
      }

      if (this.firstTimestampUs == null) this.firstTimestampUs = timestamp;
      this.latestReceivedUs = this.latestReceivedUs == null ? timestamp : Math.max(this.latestReceivedUs, timestamp);
      if (this.firstTimelineUs == null) this.firstTimelineUs = timelineUs;
      this.latestTimelineUs = this.latestTimelineUs == null ? timelineUs : Math.max(this.latestTimelineUs, timelineUs);
      if (this.firstFrameReceivedAtMs == null) this.firstFrameReceivedAtMs = performance.now();

      const item = {
        frameType: packet.frameType,
        timestamp,
        timelineUs,
        duration: Number(packet.duration || 0),
        sequence,
        data: packet.data,
        resetBefore: discontinuity && isKey
      };
      this.encodedQueue.push(item);
      this.encodedBytes += packet.data.byteLength;

      if (this.encodedBytes > MAX_ENCODED_BYTES) this.trimEncodedMemory();
      this.maybeStart();
      this.feedDecoder();
      this.updateStatus();
    }

    trimEncodedMemory() {
      if (!this.started) {
        // Antes do início, reinicia no keyframe mais recente que ainda deixa margem de buffer.
        let candidate = -1;
        const cutoff = (this.latestTimelineUs || 0) - this.targetDelayUs;
        for (let i = 0; i < this.encodedQueue.length; i += 1) {
          const item = this.encodedQueue[i];
          if (item.frameType === "key" && item.timelineUs >= cutoff) candidate = i;
        }
        if (candidate > 0) {
          const removed = this.encodedQueue.splice(0, candidate);
          for (const item of removed) this.encodedBytes -= item.data.byteLength;
          this.firstTimestampUs = this.encodedQueue[0]?.timestamp ?? this.firstTimestampUs;
          this.firstTimelineUs = this.encodedQueue[0]?.timelineUs ?? this.firstTimelineUs;
        }
        return;
      }

      while (this.encodedBytes > MAX_ENCODED_BYTES && this.encodedQueue.length > 1) {
        const item = this.encodedQueue[0];
        if (item.timelineUs > (this.playheadTimelineUs || 0)) break;
        this.encodedQueue.shift();
        this.encodedBytes -= item.data.byteLength;
      }
    }

    maybeStart() {
      if (!this.active || this.started || !this.decoderReady || this.firstFrameReceivedAtMs == null || !this.encodedQueue.length) return;

      // O pré-buffer é deliberadamente medido em TEMPO DE PAREDE desde que o
      // primeiro keyframe completo chegou. Screen sharing pode reduzir a taxa
      // de frames quando a tela fica estática; exigir 10 s de timestamps de
      // mídia fazia o viewer nunca sair de "carregando" nesses casos.
      const elapsedMs = performance.now() - this.firstFrameReceivedAtMs;
      if (elapsedMs * 1000 < this.targetDelayUs) return;

      this.started = true;
      this.buffering = false;
      this.playheadUs = this.firstTimestampUs;
      this.playheadTimelineUs = this.firstTimelineUs ?? 0;
      this.lastTickMs = performance.now();
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = null;
      this.onReady();
      this.onStatus(`Alta qualidade · ${(elapsedMs / 1000).toFixed(1)} s pré-carregados · velocidade fixa`);
      this.feedDecoder();
    }

    feedDecoder() {
      if (!this.active || !this.started || !this.decoderReady || !this.decoder || this.decoder.state !== "configured") return;
      if (this.buffering) return;

      const horizon = (this.playheadTimelineUs || 0) + this.decodeAheadUs;
      while (
        this.encodedQueue.length &&
        this.encodedQueue[0].timelineUs <= horizon &&
        this.decoder.decodeQueueSize < 5 &&
        this.decodedQueue.length < MAX_DECODED_FRAMES
      ) {
        const item = this.encodedQueue.shift();
        this.encodedBytes -= item.data.byteLength;

        try {
          if (item.resetBefore && item.frameType === "key") {
            this.decoder.reset();
            this.decoder.configure(this.decoderConfig);
          }
          this.timelineByTimestamp.set(item.timestamp, item.timelineUs);
          const chunk = new EncodedVideoChunk({
            type: item.frameType,
            timestamp: item.timestamp,
            duration: item.duration || undefined,
            data: item.data
          });
          this.decoder.decode(chunk);
        } catch (error) {
          console.warn("Espelha HQ: decode rejeitado", error);
          this.waitingForKeyframe = true;
          break;
        }
      }
    }

    handleDecodedFrame(frame) {
      if (!this.active) {
        frame.close();
        return;
      }
      const timestamp = Number(frame.timestamp);
      const timelineUs = this.timelineByTimestamp.get(timestamp) ?? timestamp;
      this.timelineByTimestamp.delete(timestamp);
      this.decodedQueue.push({ timestamp, timelineUs, frame });
      this.decodedQueue.sort((a, b) => a.timelineUs - b.timelineUs);
      while (this.decodedQueue.length > MAX_DECODED_FRAMES) {
        const dropped = this.decodedQueue.shift();
        try { dropped.frame.close(); } catch {}
        this.decodedFramesDropped += 1;
      }
    }

    bufferAheadUs() {
      if (this.playheadTimelineUs == null || this.latestTimelineUs == null) return 0;
      return Math.max(0, this.latestTimelineUs - this.playheadTimelineUs);
    }

    renderLoop() {
      const tick = (now) => {
        if (!this.active) return;
        this.raf = requestAnimationFrame(tick);
        if (!this.started) {
          this.maybeStart();
          this.updateStatus(now);
          return;
        }
        if (this.playheadTimelineUs == null) return;

        const rawDelta = this.lastTickMs == null ? 0 : Math.max(0, now - this.lastTickMs);
        this.lastTickMs = now;
        const clampedDelta = Math.min(rawDelta, 50);
        if (rawDelta > clampedDelta) this.extraDelayMs += rawDelta - clampedDelta;

        const ahead = this.bufferAheadUs();
        if (!this.buffering && ahead < this.minBufferUs) {
          this.buffering = true;
          this.stalls += 1;
          this.stallStartedAt = now;
          this.onStatus(`Alta qualidade · rede não acompanhou · segurando imagem (${(ahead / 1_000_000).toFixed(1)} s)`);
          return;
        }

        if (this.buffering) {
          if (ahead >= this.resumeBufferUs) {
            this.buffering = false;
            if (this.stallStartedAt != null) this.extraDelayMs += Math.max(0, now - this.stallStartedAt);
            this.stallStartedAt = null;
            this.lastTickMs = now;
            this.onDelayChange(this.extraDelayMs);
            this.onStatus(`Alta qualidade · retomada sem acelerar · atraso extra ${(this.extraDelayMs / 1000).toFixed(1)} s`);
            this.feedDecoder();
          }
          return;
        }

        // O relógio de reprodução é próprio. Nunca usamos "latest - delay" e nunca
        // avançamos vários segundos de uma vez para alcançar o host.
        this.playheadUs = (this.playheadUs || 0) + clampedDelta * 1000;
        this.playheadTimelineUs += clampedDelta * 1000;
        this.feedDecoder();

        let chosen = null;
        while (this.decodedQueue.length && this.decodedQueue[0].timelineUs <= this.playheadTimelineUs) {
          const current = this.decodedQueue.shift();
          if (chosen) {
            try { chosen.frame.close(); } catch {}
          }
          chosen = current;
        }

        if (chosen) {
          this.drawFrame(chosen.frame);
          this.lastRenderedTimestampUs = chosen.timestamp;
          try { chosen.frame.close(); } catch {}
        }

        this.onDelayChange(this.extraDelayMs);
        this.updateStatus(now);
      };
      this.raf = requestAnimationFrame(tick);
    }

    drawFrame(frame) {
      if (!this.ctx || !this.canvas) return;
      const width = frame.displayWidth || frame.codedWidth || 1;
      const height = frame.displayHeight || frame.codedHeight || 1;
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      try {
        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
      } catch (error) {
        console.debug("Espelha HQ: drawImage", error);
      }
    }

    updateStatus(now = performance.now()) {
      if (now - this.lastStatusAt < 500 || !this.active) return;
      this.lastStatusAt = now;
      if (!this.started) {
        if (this.firstFrameReceivedAtMs == null) {
          this.onStatus("Alta qualidade · aguardando primeiro keyframe...");
          return;
        }
        const elapsed = Math.max(0, now - this.firstFrameReceivedAtMs);
        const targetMs = this.targetDelayUs / 1000;
        const transportSpanUs = this.firstTimelineUs != null && this.latestTimelineUs != null
          ? Math.max(0, this.latestTimelineUs - this.firstTimelineUs)
          : 0;
        this.onStatus(`Alta qualidade · pré-buffer ${(Math.min(elapsed, targetMs) / 1000).toFixed(1)} / ${(targetMs / 1000).toFixed(0)} s · mídia ${(transportSpanUs / 1_000_000).toFixed(1)} s`);
        return;
      }
      if (this.started && !this.buffering) {
        this.onStatus(`Alta qualidade · buffer ${(this.bufferAheadUs() / 1_000_000).toFixed(1)} s · 1x fixo · ${this.stalls} interrupção(ões)`);
      }
    }

    stop() {
      this.active = false;
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = null;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
      if (this.decoder) {
        try { this.decoder.close(); } catch {}
      }
      this.decoder = null;
      this.decoderReady = false;
      this.decoderConfig = null;
      this.clearQueues();
      this.started = false;
      this.buffering = false;
      this.waitingForKeyframe = true;
      this.firstTimestampUs = null;
      this.latestReceivedUs = null;
      this.firstTimelineUs = null;
      this.latestTimelineUs = null;
      this.firstFrameReceivedAtMs = null;
      this.lastSequence = null;
      this.playheadUs = null;
      this.playheadTimelineUs = null;
      this.lastTickMs = null;
      this.extraDelayMs = 0;
      this.stallStartedAt = null;
      this.lastRenderedTimestampUs = null;
      if (this.canvas && this.ctx) {
        try { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); } catch {}
      }
    }
  }

  window.EspelhaQuality = {
    TARGET_DELAY_MS,
    hostSupported,
    viewerSupported,
    createHost: (options) => new QualityHost(options),
    createViewer: (options) => new QualityViewer(options)
  };
})();

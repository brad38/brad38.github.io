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
  const MAX_DECODED_FRAMES = 18;

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
    const targetFps = Math.max(1, Math.min(120, Number(fps) || 60));

    const candidates = [
      {
        codec: "avc1.640033",
        width,
        height,
        bitrate: targetBitrate,
        framerate: targetFps,
        latencyMode: "realtime",
        hardwareAcceleration: "prefer-hardware",
        avc: { format: "annexb" }
      },
      {
        codec: "vp09.00.10.08",
        width,
        height,
        bitrate: targetBitrate,
        framerate: targetFps,
        latencyMode: "realtime",
        hardwareAcceleration: "prefer-hardware"
      },
      {
        codec: "vp8",
        width,
        height,
        bitrate: targetBitrate,
        framerate: targetFps,
        latencyMode: "realtime",
        hardwareAcceleration: "prefer-hardware"
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
        // Com Annex-B/VPx a config básica já é suficiente, mas atualizamos dimensões/codec
        // caso o encoder reporte uma mudança.
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
      const packet = {
        type: "hq-video",
        frameType: chunk.type,
        timestamp: Number(chunk.timestamp),
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

      if (safeSend(conn, packet)) {
        state.sentFrames += 1;
      } else {
        state.waitingForKeyframe = true;
        this.forceKeyframe = true;
      }
    }

    async pumpFrames() {
      const fps = Math.max(1, Math.min(120, Number(this.getFps?.()) || 60));
      const minIntervalMs = 1000 / fps;
      const nominalDurationUs = Math.round(1_000_000 / fps);
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

        const ptsUs = Math.max(this.lastPtsUs + 1, Math.round((now - this.epochMs) * 1000));
        this.lastPtsUs = ptsUs;

        let timedFrame = null;
        try {
          timedFrame = new VideoFrame(sourceFrame, {
            timestamp: ptsUs,
            duration: nominalDurationUs
          });
          const periodicKey = now - this.lastKeyframeAt >= KEYFRAME_INTERVAL_MS;
          const viewerNeedsKey = [...this.viewers.values()].some((state) => state.waitingForKeyframe);
          const keyFrame = this.forceKeyframe || periodicKey || viewerNeedsKey;
          if (keyFrame) {
            this.lastKeyframeAt = now;
            this.forceKeyframe = false;
          }
          this.encoder.encode(timedFrame, { keyFrame });
        } catch (error) {
          console.warn("Espelha HQ: encode de frame falhou", error);
        } finally {
          try { timedFrame?.close(); } catch {}
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
      this.ctx = this.canvas?.getContext?.("2d", { alpha: false, desynchronized: true }) || this.canvas?.getContext?.("2d");
      this.onStatus = options.onStatus || (() => {});
      this.onReady = options.onReady || (() => {});
      this.onUnsupported = options.onUnsupported || (() => {});
      this.onDelayChange = options.onDelayChange || (() => {});

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
      this.lastSequence = null;
      this.playheadUs = null;
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
      this.onStatus(`Alta qualidade · carregando ${(this.targetDelayUs / 1_000_000).toFixed(0)} s antes de iniciar`);
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
      if (data.type === "hq-end") {
        this.onStatus("Transmissão encerrada");
        return true;
      }
      return false;
    }

    clearQueues() {
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
        }
        this.waitingForKeyframe = false;
        discontinuity = true;
      }

      if (this.firstTimestampUs == null) this.firstTimestampUs = timestamp;
      this.latestReceivedUs = this.latestReceivedUs == null ? timestamp : Math.max(this.latestReceivedUs, timestamp);

      const item = {
        frameType: packet.frameType,
        timestamp,
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
        const cutoff = (this.latestReceivedUs || 0) - this.targetDelayUs;
        for (let i = 0; i < this.encodedQueue.length; i += 1) {
          const item = this.encodedQueue[i];
          if (item.frameType === "key" && item.timestamp >= cutoff) candidate = i;
        }
        if (candidate > 0) {
          const removed = this.encodedQueue.splice(0, candidate);
          for (const item of removed) this.encodedBytes -= item.data.byteLength;
          this.firstTimestampUs = this.encodedQueue[0]?.timestamp ?? this.firstTimestampUs;
        }
        return;
      }

      while (this.encodedBytes > MAX_ENCODED_BYTES && this.encodedQueue.length > 1) {
        const item = this.encodedQueue[0];
        if (item.timestamp > (this.playheadUs || 0)) break;
        this.encodedQueue.shift();
        this.encodedBytes -= item.data.byteLength;
      }
    }

    maybeStart() {
      if (!this.active || this.started || !this.decoderReady || this.firstTimestampUs == null || this.latestReceivedUs == null) return;
      const span = this.latestReceivedUs - this.firstTimestampUs;
      if (span < this.targetDelayUs) return;

      this.started = true;
      this.buffering = false;
      this.playheadUs = this.firstTimestampUs;
      this.lastTickMs = performance.now();
      this.onReady();
      this.onStatus(`Alta qualidade · ${(span / 1_000_000).toFixed(1)} s carregados · velocidade fixa`);
      this.feedDecoder();
    }

    feedDecoder() {
      if (!this.active || !this.started || !this.decoderReady || !this.decoder || this.decoder.state !== "configured") return;
      if (this.buffering) return;

      const horizon = (this.playheadUs || 0) + this.decodeAheadUs;
      while (
        this.encodedQueue.length &&
        this.encodedQueue[0].timestamp <= horizon &&
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
      this.decodedQueue.push({ timestamp: Number(frame.timestamp), frame });
      this.decodedQueue.sort((a, b) => a.timestamp - b.timestamp);
      while (this.decodedQueue.length > MAX_DECODED_FRAMES) {
        const dropped = this.decodedQueue.shift();
        try { dropped.frame.close(); } catch {}
        this.decodedFramesDropped += 1;
      }
    }

    bufferAheadUs() {
      if (this.playheadUs == null || this.latestReceivedUs == null) return 0;
      return Math.max(0, this.latestReceivedUs - this.playheadUs);
    }

    renderLoop() {
      const tick = (now) => {
        if (!this.active) return;
        this.raf = requestAnimationFrame(tick);
        if (!this.started || this.playheadUs == null) return;

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
        this.playheadUs += clampedDelta * 1000;
        this.feedDecoder();

        let chosen = null;
        while (this.decodedQueue.length && this.decodedQueue[0].timestamp <= this.playheadUs) {
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
      if (!this.started && this.firstTimestampUs != null && this.latestReceivedUs != null) {
        const span = Math.max(0, this.latestReceivedUs - this.firstTimestampUs);
        this.onStatus(`Alta qualidade · carregando ${(span / 1_000_000).toFixed(1)} / ${(this.targetDelayUs / 1_000_000).toFixed(0)} s`);
        return;
      }
      if (this.started && !this.buffering) {
        this.onStatus(`Alta qualidade · buffer ${(this.bufferAheadUs() / 1_000_000).toFixed(1)} s · 1x fixo · ${this.stalls} interrupção(ões)`);
      }
    }

    stop() {
      this.active = false;
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
      this.lastSequence = null;
      this.playheadUs = null;
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

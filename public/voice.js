// Peer-to-peer voice chat (WebRTC mesh). The server only introduces players and
// relays connection setup messages; the audio itself goes straight between
// devices. The microphone stays off until join() is called.
const LEVEL_ON = 0.035; // volume (0..1) above which someone counts as speaking
const LEVEL_OFF = 0.02;

export class VoiceChat {
  /** @param socket socket.io client; @param onChange called whenever the UI should refresh */
  constructor(socket, onChange) {
    this.socket = socket;
    this.onChange = onChange;
    this.joined = false;
    this.connecting = false;
    this.muted = false;
    this.error = '';
    this.myId = null;
    this.members = []; // [{id, name, seat, muted}] as last announced by the server
    this.peers = new Map(); // voice id -> {pc, audio, analyser, speaking, localMuted, state}
    this.stream = null;
    this.ice = [];
    this.audioCtx = null;
    this.local = { analyser: null, speaking: false };
    this.timer = null;
    this.wanted = false; // joined by choice: rejoin automatically after a reconnect

    socket.on('voice', ({ members }) => this.#onMembers(members));
    socket.on('voiceSignal', (msg) => this.#onSignal(msg));
    socket.on('connect', () => { if (this.wanted && this.stream && !this.joined) this.#register(); });
    socket.on('disconnect', () => this.#teardownPeers(true));
  }

  speaking(id) { return id === this.myId ? this.local.speaking && !this.muted : !!this.peers.get(id)?.speaking; }
  isLocalMuted(id) { return !!this.peers.get(id)?.localMuted; }
  stateOf(id) { return this.peers.get(id)?.state ?? ''; }

  async join() {
    if (this.joined || this.connecting) return;
    this.error = '';
    this.connecting = true;
    this.onChange();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Voice chat is not supported on this device.');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      this.connecting = false;
      this.error = e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
        ? 'Microphone access was blocked. Allow it in your browser or phone settings and try again.'
        : e?.name === 'NotFoundError' ? 'No microphone found.' : (e?.message || 'Could not start the microphone.');
      this.onChange();
      return;
    }
    this.wanted = true;
    this.muted = false;
    await this.#register();
  }

  async #register() {
    const res = await new Promise((resolve) => this.socket.emit('voiceJoin', null, resolve));
    this.connecting = false;
    if (!res?.ok) {
      this.error = res?.error || 'Could not join voice chat.';
      this.#stopStream();
      this.wanted = false;
      this.onChange();
      return;
    }
    this.joined = true;
    this.myId = res.id;
    this.ice = res.ice || [];
    this.#startLevels();
    // Newcomers call everyone already here, so exactly one side makes each offer.
    for (const m of res.members) await this.#call(m.id);
    this.onChange();
  }

  leave() {
    this.wanted = false;
    if (this.joined) this.socket.emit('voiceLeave');
    this.#teardownPeers(true);
    this.#stopStream();
    this.joined = false;
    this.connecting = false;
    this.myId = null;
    this.onChange();
  }

  setMuted(muted) {
    this.muted = !!muted;
    this.stream?.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    if (this.joined) this.socket.emit('voiceMute', { muted: this.muted });
    this.onChange();
  }

  setLocalMute(id, muted) {
    const p = this.peers.get(id);
    if (!p) return;
    p.localMuted = !!muted;
    p.audio.muted = !!muted;
    this.onChange();
  }

  // ---------------------------------------------------------------- internals
  #stopStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    clearInterval(this.timer);
    this.timer = null;
    this.local = { analyser: null, speaking: false };
    try { this.audioCtx?.close(); } catch {}
    this.audioCtx = null;
  }

  #teardownPeers(all) {
    for (const [id, p] of this.peers) {
      try { p.pc.close(); } catch {}
      p.audio.srcObject = null;
      p.audio.remove();
      this.peers.delete(id);
    }
    if (all) this.joined = false;
  }

  #onMembers(members) {
    this.members = members;
    // Drop connections to people who have left voice chat.
    const ids = new Set(members.map((m) => m.id));
    for (const [id, p] of [...this.peers]) {
      if (ids.has(id)) continue;
      try { p.pc.close(); } catch {}
      p.audio.srcObject = null;
      p.audio.remove();
      this.peers.delete(id);
    }
    this.onChange();
  }

  #makePeer(id) {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.style.display = 'none';
    document.body.append(audio);
    const peer = { pc, audio, analyser: null, speaking: false, localMuted: false, state: 'connecting', pending: [] };
    this.peers.set(id, peer);
    for (const t of this.stream.getTracks()) pc.addTrack(t, this.stream);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket.emit('voiceSignal', { to: id, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0];
      audio.play().catch(() => {});
      this.#watch(peer, e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState;
      if (pc.connectionState === 'failed') this.error = 'Could not connect audio to one of the players (their network may block voice).';
      this.onChange();
    };
    return peer;
  }

  async #call(id) {
    const peer = this.#makePeer(id);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.socket.emit('voiceSignal', { to: id, data: { sdp: peer.pc.localDescription } });
  }

  async #onSignal({ from, data }) {
    if (!this.joined || !this.stream) return;
    try {
      let peer = this.peers.get(from);
      if (data.sdp) {
        if (data.sdp.type === 'offer') {
          if (peer) { try { peer.pc.close(); } catch {} peer.audio.remove(); this.peers.delete(from); }
          peer = this.#makePeer(from);
          await peer.pc.setRemoteDescription(data.sdp);
          await this.#flush(peer);
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          this.socket.emit('voiceSignal', { to: from, data: { sdp: peer.pc.localDescription } });
        } else if (peer) {
          await peer.pc.setRemoteDescription(data.sdp);
          await this.#flush(peer);
        }
      } else if (data.candidate && peer) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pending.push(data.candidate);
      }
    } catch (e) {
      console.warn('voice signal error', e);
    }
  }

  async #flush(peer) {
    for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  // -------------------------------------------------- who is speaking (levels)
  #ctx() {
    if (!this.audioCtx) {
      const C = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = C ? new C() : null;
    }
    this.audioCtx?.resume?.();
    return this.audioCtx;
  }

  #analyserFor(stream) {
    const ctx = this.#ctx();
    if (!ctx) return null;
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    return an;
  }

  #watch(peer, stream) {
    peer.analyser = this.#analyserFor(stream);
  }

  #startLevels() {
    this.local.analyser = this.stream ? this.#analyserFor(this.stream) : null;
    const buf = new Uint8Array(512);
    const level = (an) => {
      if (!an) return 0;
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
      return Math.sqrt(sum / buf.length);
    };
    const update = (obj, an) => {
      const l = level(an);
      const next = obj.speaking ? l > LEVEL_OFF : l > LEVEL_ON;
      if (next === obj.speaking) return false;
      obj.speaking = next;
      return true;
    };
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      let changed = update(this.local, this.local.analyser);
      for (const p of this.peers.values()) changed = update(p, p.analyser) || changed;
      if (changed) this.onChange();
    }, 120);
  }
}

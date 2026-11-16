// Night ambience: procedural wind (no files needed) plus occasional owls and
// wolves. Drop recordings into src/assets/sounds/owl/ and src/assets/sounds/wolf/
// and they're used automatically; until then, synthesised stand-ins play.
//
// Browsers block audio until the user interacts, so nothing plays until
// setEnabled(true) is called from a click.

type SoundCategory = 'owl' | 'wolf';

const sampleFiles = import.meta.glob<string>('../assets/sounds/*/*.{mp3,ogg,wav,m4a,webm}', {
  query: '?url', import: 'default', eager: true,
});
/** Sample URLs by category (the folder name). */
const sampleUrls: Record<string, string[]> = {};
for (const [path, url] of Object.entries(sampleFiles)) {
  const category = path.split('/').at(-2) ?? 'misc';
  (sampleUrls[category] ??= []).push(url);
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Smooth 1D value noise for gusts. */
function smoothNoise(seed = Math.random() * 1000) {
  const h = (i: number) => { const x = Math.sin((i + seed) * 127.1) * 43758.5453; return x - Math.floor(x); };
  return (t: number) => {
    const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
    return h(i) * (1 - u) + h(i + 1) * u;
  };
}

/** The audio graph, built on the first setEnabled(true). */
interface Graph {
  ctx: AudioContext;
  master: GainNode;
  reverb: ConvolverNode;
  dry: GainNode;
}

export interface Ambience {
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
  /** Flips sound on/off; returns the new state. */
  toggle(): boolean;
  /** Play an owl call now (e.g. from a click in the scene). */
  owl(): void;
  /** Play a wolf howl now. */
  wolves(): void;
  dispose(): void;
}

export function createAmbience({ volume = 0.8 } = {}): Ambience {
  let graph: Graph | null = null;
  let enabled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let gustTimer: ReturnType<typeof setInterval> | undefined;
  const buffers: Partial<Record<string, AudioBuffer[]>> = {};

  function init(): Graph {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // Big outdoor space: a long generated reverb tail.
    const reverb = ctx.createConvolver();
    reverb.buffer = impulseResponse(ctx, 4.5, 2.8);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    reverb.connect(wet).connect(master);
    const dry = ctx.createGain();
    dry.connect(master);

    const g = { ctx, master, reverb, dry };
    buildWind(g);
    void loadSamples(ctx);
    return g;
  }

  // --- Wind ---------------------------------------------------------------
  function buildWind({ ctx, dry, reverb }: Graph) {
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 6);
    noise.loop = true;

    // Low body of the wind.
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 380;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.35;

    // Two resonant bands = the howl / whistle. Slightly detuned so they beat.
    const howls = [0, 1].map(() => {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 18;
      f.frequency.value = 500;
      const g = ctx.createGain();
      g.gain.value = 0;
      noise.connect(f).connect(g);
      g.connect(dry);
      g.connect(reverb);
      return { f, g, n: smoothNoise() };
    });

    noise.connect(body).connect(bodyGain).connect(dry);
    noise.start();

    const gust = smoothNoise();
    let t = 0;
    gustTimer = setInterval(() => {
      t += 0.25;
      const now = ctx.currentTime;
      const g = Math.pow(gust(t * 0.12), 1.6); // 0..1, mostly calm with swells
      bodyGain.gain.setTargetAtTime(0.18 + g * 0.5, now, 0.6);
      body.frequency.setTargetAtTime(250 + g * 500, now, 0.6);
      howls.forEach((h, i) => {
        const pitch = 330 + h.n(t * 0.2) * 420 + g * 260 + i * 37;
        h.f.frequency.setTargetAtTime(pitch, now, 0.4);
        h.g.gain.setTargetAtTime(Math.max(0, g - 0.25) * 1.6, now, 0.5);
      });
    }, 250);
  }

  // --- Events -------------------------------------------------------------
  async function loadSamples(ctx: AudioContext) {
    for (const [cat, urls] of Object.entries(sampleUrls)) {
      const decoded = await Promise.all(urls.map(async (u) => {
        try { return await ctx.decodeAudioData(await (await fetch(u)).arrayBuffer()); }
        catch (e) { console.warn('[ambience] could not decode', u, e); return null; }
      }));
      buffers[cat] = decoded.filter((b): b is AudioBuffer => b !== null);
    }
  }

  /** A positioned "voice": stereo pan + distance (quieter, duller, more reverb). */
  function voice({ ctx, dry, reverb }: Graph, { pan = rand(-0.8, 0.8), distance = rand(0.3, 1) } = {}) {
    const input = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6000 - distance * 4500;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    const out = ctx.createGain();
    out.gain.value = 1 - distance * 0.6;
    const send = ctx.createGain();
    send.gain.value = 0.4 + distance * 0.8;
    input.connect(lp).connect(panner).connect(out);
    out.connect(dry);
    out.connect(send).connect(reverb);
    return input;
  }

  function playSample(g: Graph, cat: SoundCategory) {
    const list = buffers[cat];
    if (!list?.length) return false;
    const src = g.ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = rand(0.94, 1.06);
    src.connect(voice(g));
    src.start();
    return true;
  }

  /** Synth stand-in: owl "hoo ... hoo-hoo-hoo". */
  function synthOwl(g: Graph) {
    const { ctx } = g;
    const out = voice(g);
    const base = rand(330, 420);
    const pattern = [0, 0.75, 1.05, 1.35];
    pattern.forEach((t0, i) => {
      const start = ctx.currentTime + t0;
      const len = i === 0 ? 0.55 : 0.22;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base * (i === 0 ? 1.04 : 1), start);
      osc.frequency.exponentialRampToValueAtTime(base * 0.9, start + len);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.35, start + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, start + len);
      osc.connect(gain).connect(out);
      osc.start(start);
      osc.stop(start + len + 0.05);
    });
  }

  /** Synth stand-in: a few wolves howling in staggered, rising-then-falling glides. */
  function synthWolves(g: Graph) {
    const { ctx } = g;
    const voices = Math.floor(rand(1, 4));
    const pan = rand(-0.7, 0.7);
    for (let v = 0; v < voices; v++) {
      const out = voice(g, { pan: pan + rand(-0.2, 0.2), distance: rand(0.6, 1) });
      const start = ctx.currentTime + v * rand(0.8, 1.8);
      const base = rand(300, 380) * (v ? rand(1.05, 1.3) : 1);
      const dur = rand(3, 4.5);

      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const f = osc.frequency;
      f.setValueAtTime(base * 0.8, start);
      f.exponentialRampToValueAtTime(base * 1.6, start + 0.9);
      f.setValueAtTime(base * 1.6, start + dur * 0.55);
      f.exponentialRampToValueAtTime(base * 1.15, start + dur);

      const vib = ctx.createOscillator();
      vib.frequency.value = 5.2;
      const vibAmt = ctx.createGain();
      vibAmt.gain.value = 6;
      vib.connect(vibAmt).connect(f);

      // Vowel-ish formant: turns a buzzy saw into an "oooo".
      const formant = ctx.createBiquadFilter();
      formant.type = 'lowpass';
      formant.frequency.value = 900;
      formant.Q.value = 6;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.7);
      gain.gain.setValueAtTime(0.12, start + dur - 1.2);
      gain.gain.linearRampToValueAtTime(0, start + dur);

      osc.connect(formant).connect(gain).connect(out);
      osc.start(start); vib.start(start);
      osc.stop(start + dur + 0.1); vib.stop(start + dur + 0.1);
    }
  }

  /** Plays `cat` every min..max seconds: a recording if there is one, else the synth. */
  function schedule(cat: SoundCategory, [min, max]: [number, number], synth: (g: Graph) => void, first?: number) {
    const id = setTimeout(() => {
      if (graph && enabled && graph.ctx.state === 'running') {
        if (!playSample(graph, cat)) synth(graph);
      }
      schedule(cat, [min, max], synth);
    }, (first ?? rand(min, max)) * 1000);
    timers.push(id);
  }

  // --- Public -------------------------------------------------------------
  function setEnabled(on: boolean) {
    enabled = on;
    if (on && !graph) {
      graph = init();
      schedule('owl', [20, 45], synthOwl, 6);
      schedule('wolf', [45, 100], synthWolves, 18);
    }
    if (!graph) return;
    const { ctx, master } = graph;
    if (on) void ctx.resume();
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(on ? volume : 0, now, on ? 0.8 : 0.25);
  }

  const onVisibility = () => {
    if (!graph) return;
    if (document.hidden) void graph.ctx.suspend();
    else if (enabled) void graph.ctx.resume();
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    get enabled() { return enabled; },
    setEnabled,
    toggle() { setEnabled(!enabled); return enabled; },
    owl() { if (graph && !playSample(graph, 'owl')) synthOwl(graph); },
    wolves() { if (graph && !playSample(graph, 'wolf')) synthWolves(graph); },
    dispose() {
      timers.forEach(clearTimeout);
      clearInterval(gustTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      void graph?.ctx.close();
    },
  };
}

function noiseBuffer(ctx: AudioContext, seconds: number) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function impulseResponse(ctx: AudioContext, seconds: number, decay: number) {
  const len = ctx.sampleRate * seconds;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}
